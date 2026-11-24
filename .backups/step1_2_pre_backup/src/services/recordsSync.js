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

const API_BASE = String(
    import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');

// Must match RECORD_KEYS in server/moduleRecordsRoutes.js
const MODULE_KEYS = ['inventoryItems', 'stockTransactions'];
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

const request = async(path, options = {}) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Records request failed (${response.status})`);
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
    if (!versions || Object.keys(versions).length === 0) loadVersions();
    for (const key of MODULE_KEYS) {
        try {
            const payload = await request(`/records/${encodeURIComponent(key)}`);
            mergeServerRecords(key, payload.records || []);
            setStatus(key, { connected: true, lastSyncAt: new Date().toISOString(), lastError: null, pending: 0 });
            // Local records the server has never seen (first run after the
            // migration, or work done while offline) are pushed right away.
            const versionMap = versionsFor(key);
            const hasUnsynced = readLocalArray(key).some((record) => {
                const id = String(record?.id ?? '');
                return id && versionMap[id] === undefined;
            });
            if (hasUnsynced) scheduleSave(key);
        } catch (error) {
            setStatus(key, { connected: false, lastError: error.message, pending: pendingSaves.has(key) ? 1 : 0 });
        }
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
            body: JSON.stringify({ records, deletes, updatedBy: getUpdatedBy() })
        });
        pendingSaves.delete(key);
        const conflicts = applySaveResult(key, local, payload, records, deletes);
        setStatus(key, { connected: true, lastSyncAt: new Date().toISOString(), lastError: null, pending: 0 });
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
        pendingSaves.add(key); // queued — retried by the interval / next change
        setStatus(key, { connected: false, lastError: error.message, pending: records.length + deletes.length });
        return false;
    } finally {
        inFlight.delete(key);
    }
};

/** Flushes every queued key (used by the banner's "Retry now" + on unload). */
export const flushRecords = async() => {
    const keys = new Set([...pendingSaves, ...MODULE_KEYS]);
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

    // Any local write to a module key (pages, console scripts, other tabs'
    // storage events are not captured) triggers a debounced diff save.
    window.addEventListener('erp-state-change', (event) => {
        const key = event.detail?.key;
        if (key && MODULE_KEYS.includes(key)) scheduleSave(key);
    });

    // Periodic retry for keys queued by an outage
    window.setInterval(() => {
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
            const body = JSON.stringify({ records, deletes, updatedBy: getUpdatedBy() });
            try {
                if (navigator?.sendBeacon) {
                    navigator.sendBeacon(`${API_BASE}/records/${encodeURIComponent(key)}`, new Blob([body], { type: 'application/json' }));
                } else {
                    fetch(`${API_BASE}/records/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
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
