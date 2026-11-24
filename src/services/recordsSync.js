import { authHeaders } from '../utils/auth.js';
import { hasPermission, isAdmin } from '../utils/permissions.js';

/**
 * Per-record sync engine (Phase 2: true multi-user safety).
 *
 * Owns the module lists that graduated from the generic erp_state mirror to
 * the versioned `module_records` table via /api/records:
 *
 *   localStorage stays the fast working copy the pages read/write as before,
 *   but here only CHANGED records are pushed (diff sync) together with the
 *   version each device last saw. The server accepts a write only when that
 *   version is still current — otherwise it returns the server copy as a
 *   conflict, which is adopted locally and announced via events so the UI can
 *   tell the user instead of silently losing work.
 *
 * Events dispatched:
 *   erp-records-synced   { key, saved, deleted, conflicts }
 *   erp-records-status   { key, pending, lastSyncAt, lastError, connected }
 *   erp-records-conflict { key, conflicts:[{id, data, ...}] }
 */

const getApiBase = () => {
    if (typeof window !== 'undefined' && window.location) {
        if (window.location.port === '5173') {
            return `http://${window.location.hostname || 'localhost'}:3001/api`;
        }
        return '/api';
    }
    return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const API_BASE = String(getApiBase()).replace(/\/$/, '');

// Must match RECORD_KEYS in server/moduleRecordsRoutes.js
const MODULE_KEYS = ['inventoryItems', 'stockTransactions', 'productionDispatchRequests'];
const VERSIONS_STORAGE_KEY = 'erp_record_versions';
const RETRY_INTERVAL_MS = 2000;
const SAVE_DEBOUNCE_MS = 250;
const REQUEST_TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ */
/* Local state                                                         */
/* ------------------------------------------------------------------ */

// lastSynced[key] = Map(recordId -> JSON string as last confirmed by server)
const lastSynced = new Map();
// versions[key] = { recordId: version }  (persisted to survive reloads)
let versions = {};
// keys with a save waiting (offline or in-flight debounce)
const pendingSaves = new Set();
const inFlight = new Set();
const statusBy = {};
const failedPulls = new Set();
let pullInFlight = false;

const loadVersions = () => {
    try {
        versions = JSON.parse(localStorage.getItem(VERSIONS_STORAGE_KEY) || '{}') || {};
    } catch {
        versions = {};
    }
};

const persistVersions = () => {
    try {
        localStorage.setItem(VERSIONS_STORAGE_KEY, JSON.stringify(versions));
    } catch {
        /* quota — versions rebuild from server on next pull */
    }
};

const versionsFor = (key) => {
    if (!versions[key]) versions[key] = {};
    return versions[key];
};

const readLocalArray = (key) => {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const writeLocalArray = (key, array) => {
    localStorage.setItem(key, JSON.stringify(array));
};

const getUpdatedBy = () => {
    try {
        const auth = JSON.parse(localStorage.getItem('erp_auth') || 'null');
        return String(auth?.user?.name || auth?.user?.username || auth?.username || 'unknown').slice(0, 120);
    } catch {
        return 'unknown';
    }
};

const emit = (name, detail) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
};

const setStatus = (key, patch) => {
    statusBy[key] = { ...(statusBy[key] || {}), pending: 0, ...patch };
    emit('erp-records-status', { key, ...statusBy[key] });
};

// Leave records untouched when the selected department cannot access them.
// A later department switch can resume synchronization without data loss.
const canReadModule = (key) => isAdmin() || (key === 'productionDispatchRequests'
    ? hasPermission('job_card.view') || hasPermission('delivery.view')
    : key === 'stockTransactions'
        ? hasPermission('inventory.transaction.view') || hasPermission('material_issue.view')
        : hasPermission('inventory.view'));
const canWriteModule = (key) => isAdmin() || (key === 'productionDispatchRequests'
    ? hasPermission('job_card.dispatch_request') || hasPermission('delivery.create')
    : key === 'stockTransactions'
        ? ['inventory.adjust','material_issue.create','material_return.create','receipt.create','production.entry.create'].some(hasPermission)
        : hasPermission('inventory.adjust'));
const isPermissionError = (error) => error?.status === 401 || error?.status === 403;

const request = async(path, options = {}) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || `Records request failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
        return payload;
    } finally {
        window.clearTimeout(timer);
    }
};

/* ------------------------------------------------------------------ */
/* Pull: server -> localStorage (startup + periodic refresh)           */
/* ------------------------------------------------------------------ */

/**
 * Merges the server's records into the local working copy.
 * Rules:
 *   - server record wins for ids it holds (other devices' newer saves),
 *   - local-only ids are KEPT (unsynced work — pushed on next save),
 *   - an id we had synced (version known) that vanished server-side was
 *     deleted elsewhere -> removed locally.
 * An empty server list never wipes local work.
 */
const mergeServerRecords = (key, serverRecords) => {
    const versionMap = versionsFor(key);
    const local = readLocalArray(key);
    const localById = new Map(local.map((record) => [String(record?.id ?? ''), record]));
    const serverIds = new Set();

    const merged = serverRecords.map((record) => {
        const id = String(record.id);
        serverIds.add(id);
        versionMap[id] = record.version;
        return record.data;
    });

    // Records deleted on another device (we knew a version, server dropped it)
    for (const [id, record] of localById) {
        if (id && !serverIds.has(id) && versionMap[id] !== undefined) continue; // dropped
        if (id && !serverIds.has(id)) merged.push(record); // never synced — keep
    }

    const serverJsonById = new Map(serverRecords.map((record) => [String(record.id), JSON.stringify(record.data)]));
    lastSynced.set(key, serverJsonById);

    if (merged.length || readLocalArray(key).length) writeLocalArray(key, merged);
    persistVersions();
    return merged.length;
};

/** Pulls every module key from the server. Safe while offline (keeps local). */
export const pullRecordsFromServer = async() => {
    if (pullInFlight) return;
    pullInFlight = true;
    if (!versions || Object.keys(versions).length === 0) loadVersions();
    try {
        for (const key of MODULE_KEYS) {
            if (!canReadModule(key)) {
                failedPulls.delete(key);
                setStatus(key, { permissionDenied: true, connected: null, lastError: 'Not synchronized for the selected department role.', pending: 0 });
                continue;
            }
            try {
                const payload = await request(`/records/${encodeURIComponent(key)}`);
                mergeServerRecords(key, Array.isArray(payload.records) ? payload.records : []);
                failedPulls.delete(key);
                setStatus(key, { connected: true, permissionDenied: false, lastSyncAt: new Date().toISOString(), lastError: null, pending: 0 });
                // Local records the server has never seen (first run after the
                // migration, or work done while offline) are pushed right away.
                const versionMap = versionsFor(key);
                const hasUnsynced = readLocalArray(key).some((record) => {
                    const id = String(record?.id ?? '');
                    return id && versionMap[id] === undefined;
                });
                if (hasUnsynced) scheduleSave(key);
            } catch (error) {
                const denied = isPermissionError(error);
                if (denied) failedPulls.delete(key); else failedPulls.add(key);
                setStatus(key, { permissionDenied: denied, connected: denied ? true : false, lastError: error.message, pending: pendingSaves.has(key) ? 1 : 0 });
            }
        }
    } finally {
        pullInFlight = false;
    }
};

/* ------------------------------------------------------------------ */
/* Save: diff local -> server (per record, with versions)              */
/* ------------------------------------------------------------------ */

const computeDiff = (key, local) => {
    const synced = lastSynced.get(key) || new Map();
    const versionMap = versionsFor(key);
    const records = [];
    const deletes = [];
    const seen = new Set();

    for (const record of local) {
        const id = String(record?.id ?? '');
        if (!id) continue;
        seen.add(id);
        const json = JSON.stringify(record);
        if (synced.get(id) !== json) {
            records.push({ id, data: record, version: Number(versionMap[id] || 0) });
        }
    }
    for (const [id, json] of synced) {
        if (!seen.has(id)) deletes.push({ id, version: Number(versionMap[id] || 0) });
    }
    return { records, deletes };
};

const deletionReasonsFor = (key) => {
    try {
        return JSON.parse(localStorage.getItem('erp_record_delete_reasons') || '{}')?.[key] || {};
    } catch { return {}; }
};
const clearDeletionReasons = (key, ids) => {
    try {
        const all = JSON.parse(localStorage.getItem('erp_record_delete_reasons') || '{}');
        const reasons = all?.[key] || {};
        for (const id of ids) delete reasons[id];
        all[key] = reasons;
        localStorage.setItem('erp_record_delete_reasons', JSON.stringify(all));
    } catch { /* leave recovery metadata untouched */ }
};

/** Applies the server response: versions up, conflicts adopted locally. */
const applySaveResult = (key, local, payload, sentRecords, sentDeletes) => {
    const versionMap = versionsFor(key);
    const synced = lastSynced.get(key) || new Map();
    let array = [...local];

    for (const saved of payload.saved || []) {
        versionMap[saved.id] = saved.version;
    }
    const deletedIds = new Set(payload.deleted || []);
    for (const id of deletedIds) {
        delete versionMap[id];
        synced.delete(id);
    }
    clearDeletionReasons(key, [...deletedIds]);
    array = array.filter((record) => !deletedIds.has(String(record?.id ?? '')));

    const conflicts = payload.conflicts || [];
    if (conflicts.length) {
        const conflictById = new Map(conflicts.map((conflict) => [String(conflict.id), conflict]));
        array = array.map((record) => {
            const conflict = conflictById.get(String(record?.id ?? ''));
            return conflict ? conflict.data : record;
        });
        for (const conflict of conflicts) {
            const id = String(conflict.id);
            versionMap[id] = conflict.version;
            synced.set(id, JSON.stringify(conflict.data));
        }
    }

    // Confirmed records become the new sync baseline
    for (const sent of sentRecords) {
        if (!conflicts.some((conflict) => String(conflict.id) === sent.id)) {
            synced.set(sent.id, JSON.stringify(sent.data));
        }
    }
    lastSynced.set(key, synced);
    persistVersions();
    writeLocalArray(key, array);
    return conflicts;
};

export const saveRecordsToServer = async(key) => {
    if (!MODULE_KEYS.includes(key) || inFlight.has(key)) return false;
    if (!canWriteModule(key)) {
        setStatus(key, { permissionDenied: true, connected: null, lastError: 'Changes are retained until an authorized department is selected.', pending: 0 });
        return false;
    }
    const local = readLocalArray(key);
    const { records, deletes } = computeDiff(key, local);
    if (records.length === 0 && deletes.length === 0) {
        pendingSaves.delete(key);
        setStatus(key, { pending: 0 });
        return true;
    }
    inFlight.add(key);
    setStatus(key, { pending: records.length + deletes.length });
    try {
        const payload = await request(`/records/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: JSON.stringify({ records, deletes, reasons: deletionReasonsFor(key), updatedBy: getUpdatedBy() })
        });
        pendingSaves.delete(key);
        const conflicts = applySaveResult(key, local, payload, records, deletes);
        setStatus(key, { connected: true, permissionDenied: false, lastSyncAt: new Date().toISOString(), lastError: null, pending: 0 });
        emit('erp-records-synced', { key, saved: (payload.saved || []).length, deleted: (payload.deleted || []).length, conflicts: conflicts.length });
        if (conflicts.length) {
            console.warn(`[${key}] ${conflicts.length} record(s) were changed by another user — the server copy was applied.`);
            emit('erp-records-conflict', { key, conflicts });
        }
        // A conflict adopt re-wrote localStorage: check whether more changes remain
        const followUp = computeDiff(key, readLocalArray(key));
        if (followUp.records.length || followUp.deletes.length) scheduleSave(key);
        return true;
    } catch (error) {
        const denied = isPermissionError(error);
        if (denied) pendingSaves.delete(key);
        else pendingSaves.add(key); // only transient failures are auto-retried
        setStatus(key, { permissionDenied: denied, connected: denied ? true : false, lastError: error.message, pending: denied ? 0 : records.length + deletes.length });
        return false;
    } finally {
        inFlight.delete(key);
    }
};

/** Atomically create a module record. A duplicate id is returned as a conflict. */
export const createRecordOnServer = async(key, record) => {
    if (!MODULE_KEYS.includes(key)) throw new Error(`Unsupported shared record key '${key}'.`);
    const id = String(record?.id || '');
    if (!id) throw new Error('A shared record needs an id.');
    const payload = await request(`/records/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ records: [{ id, data: record, version: 0 }], deletes: [], updatedBy: getUpdatedBy() })
    });
    if (!(payload.saved || []).some((saved) => String(saved.id) === id)) {
        await pullRecordsFromServer();
        throw new Error(`A record with id '${id}' already exists.`);
    }
    await pullRecordsFromServer();
    return record;
};

/** Update a record using the server version as a compare-and-swap guard. */
export const updateRecordOnServer = async(key, id, update) => {
    if (!MODULE_KEYS.includes(key)) throw new Error(`Unsupported shared record key '${key}'.`);
    const recordId = String(id || '');
    const remote = await request(`/records/${encodeURIComponent(key)}`);
    const current = (remote.records || []).find((record) => String(record.id) === recordId);
    if (!current) throw new Error(`Shared record '${recordId}' was not found.`);
    const next = typeof update === 'function' ? update(current.data) : update;
    const payload = await request(`/records/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ records: [{ id: recordId, data: next, version: current.version }], deletes: [], updatedBy: getUpdatedBy() })
    });
    if (!(payload.saved || []).some((saved) => String(saved.id) === recordId)) {
        await pullRecordsFromServer();
        throw new Error(`Shared record '${recordId}' changed in another session. Refresh and retry.`);
    }
    await pullRecordsFromServer();
    return next;
};

/** Flushes every queued key (used by the banner's "Retry now" + on unload). */
export const flushRecords = async() => {
    const keys = new Set([...pendingSaves, ...MODULE_KEYS].filter(canWriteModule));
    let ok = true;
    for (const key of keys) {
        const result = await saveRecordsToServer(key);
        ok = ok && result;
    }
    return ok;
};

export const getRecordsStatus = (key) => ({ ...(statusBy[key] || { pending: 0 }) });
export const getModuleRecordKeys = () => [...MODULE_KEYS];

/* ------------------------------------------------------------------ */
/* Wiring: watch for local changes to module keys                      */
/* ------------------------------------------------------------------ */

const debounceTimers = {};

const scheduleSave = (key) => {
    if (debounceTimers[key]) window.clearTimeout(debounceTimers[key]);
    debounceTimers[key] = window.setTimeout(() => {
        delete debounceTimers[key];
        saveRecordsToServer(key);
    }, SAVE_DEBOUNCE_MS);
};

let started = false;

export const startRecordsSync = () => {
    if (started || typeof window === 'undefined') return;
    started = true;
    loadVersions();

    window.addEventListener('erp-department-changed', () => {
        // Reconcile retained local edits before pulling server snapshots, so a
        // department switch cannot replace an unsent local change.
        Promise.all(MODULE_KEYS.filter(canWriteModule).map((key) => saveRecordsToServer(key)))
            .finally(() => pullRecordsFromServer());
    });

    window.addEventListener('erp-auth-permissions-updated', () => {
        Promise.all(MODULE_KEYS.filter(canWriteModule).map((key) => saveRecordsToServer(key)))
            .finally(() => pullRecordsFromServer());
    });

    // Any local write to a module key (pages, console scripts, other tabs'
    // storage events are not captured) triggers a debounced diff save.
    window.addEventListener('erp-state-change', (event) => {
        const key = event.detail?.key;
        if (key && MODULE_KEYS.includes(key)) scheduleSave(key);
    });

    // Periodic retry for keys queued by an outage
    window.setInterval(() => {
        if (failedPulls.size) pullRecordsFromServer();
        for (const key of pendingSaves) {
            if (!inFlight.has(key)) saveRecordsToServer(key);
        }
    }, RETRY_INTERVAL_MS);

    // Last-chance flush when the tab is hidden or closed
    const flushOnHide = () => {
        if (pendingSaves.size === 0) return;
        for (const key of pendingSaves) {
            const local = readLocalArray(key);
            const { records, deletes } = computeDiff(key, local);
            if (records.length === 0 && deletes.length === 0) continue;
            const body = JSON.stringify({ records, deletes, reasons: deletionReasonsFor(key), updatedBy: getUpdatedBy() });
            try {
                if (navigator?.sendBeacon) {
                    fetch(`${API_BASE}/records/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body, keepalive: true }).catch(() => {});
                } else {
                    fetch(`${API_BASE}/records/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body, keepalive: true }).catch(() => {});
                }
            } catch {
                /* ignore unload failure */
            }
        }
    };
    window.addEventListener('beforeunload', flushOnHide);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide();
    });
};

export { MODULE_KEYS as RECORD_MODULE_KEYS };
