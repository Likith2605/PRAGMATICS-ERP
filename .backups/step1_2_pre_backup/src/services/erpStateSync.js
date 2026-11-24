const API_BASE = String(
    import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const SYNC_INTERVAL_MS = 1500;
const LOCAL_ONLY_KEYS = new Set([
    'erp_auth',
    'currentQuotation',
    'currentVendorEnquiry',
    'currentVendorQuotation',
    'erpDailySnapshots',
    'erpBackupAuditLogs',
    'erp_record_versions' // per-record sync bookkeeping (recordsSync.js)
]);

// Modules that graduated to per-record storage (/api/records): the generic
// mirror must not touch them (one authority per module), but their local
// changes still dispatch events so recordsSync.js can push them.
const MODULE_OWNED_KEYS = new Set(['inventoryItems', 'stockTransactions']);

const isSyncableKey = (key) => {
    const value = String(key || '');
    return value && !LOCAL_ONLY_KEYS.has(value) && !MODULE_OWNED_KEYS.has(value);
};

/** Keys whose local changes should trigger *some* sync (mirror or records). */
const isTrackedKey = (key) => {
    const value = String(key || '');
    return value && !LOCAL_ONLY_KEYS.has(value);
};

const serializableValue = (_key, value) => value;

/** true for [] and {} — values that carry no information. */
const isEmptyValue = (value) =>
    Array.isArray(value) ?
        value.length === 0 :
        Boolean(value) && typeof value === 'object' && Object.keys(value).length === 0;

const localRecords = () => {
    const records = {};
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!isSyncableKey(key)) continue;
        try {
            const raw = localStorage.getItem(key);
            if (raw !== null) records[key] = serializableValue(key, JSON.parse(raw));
        } catch {
            /* Ignore non-JSON browser values. */
        }
    }
    return records;
};

const request = async(path, options = {}) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `ERP sync failed (${response.status})`);
        return payload;
    } finally {
        window.clearTimeout(timer);
    }
};

/* ------------------------------------------------------------------ */
/* Sync status — drives the on-screen connection banner                */
/*                                                                     */
/*   connected : null = not attempted yet, true/false after each try    */
/*   pending   : local keys changed since PostgreSQL last confirmed     */
/*   lastSyncAt: ISO timestamp of the last successful server write      */
/* ------------------------------------------------------------------ */

const pendingKeys = new Set();
const status = {
    connected: null,
    lastSyncAt: null,
    lastError: null
};
let lastWarnAt = 0;

const emitStatus = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('erp-sync-status', {
        detail: { ...status, pending: pendingKeys.size }
    }));
};

export const getSyncStatus = () => ({ ...status, pending: pendingKeys.size });

const setStatus = (patch) => {
    Object.assign(status, patch);
    emitStatus();
};

const warnThrottled = (message) => {
    const now = Date.now();
    if (now - lastWarnAt > 10000) {
        lastWarnAt = now;
        console.warn(message);
    }
};

const markSynced = (sentKeys) => {
    for (const key of sentKeys) pendingKeys.delete(key);
    setStatus({ connected: true, lastSyncAt: new Date().toISOString(), lastError: null });
};

const markUnsynced = (error) => {
    setStatus({ connected: false, lastError: error?.message || 'Unknown sync error' });
};

let isHydrating = false;

const hydrate = (records) => {
    isHydrating = true;
    try {
        const localEmployees = (() => {
            try { return JSON.parse(localStorage.getItem('employees') || '[]'); } catch { return []; }
        })();
        Object.entries(records || {}).forEach(([key, value]) => {
            if (!isSyncableKey(key)) return;
            // Fail-safe: an empty server copy ([] / {}) must never wipe local
            // work — e.g. a fresh browser that seeded empty defaults, or a
            // device that never held this module's data. The local copy is
            // kept and re-uploaded by syncERPState below.
            if (isEmptyValue(value)) {
                try {
                    const localRaw = localStorage.getItem(key);
                    if (localRaw !== null && !isEmptyValue(JSON.parse(localRaw))) return;
                } catch {
                    /* local unparsable — adopt the server value */
                }
            }
            if (key === 'employees' && Array.isArray(value)) {
                const byId = new Map(localEmployees.map((employee) => [employee.id || employee.employeeId, employee]));
                value = value.map((employee) => ({
                    ...employee,
                    password: employee.password || byId.get(employee.id || employee.employeeId)?.password || ''
                }));
            }
            localStorage.setItem(key, JSON.stringify(value));
        });
        window.dispatchEvent(new CustomEvent('erp-state-hydrated'));
    } finally {
        isHydrating = false;
    }
};

let inFlight = false;
let lastSnapshot = '';

export const syncERPState = async() => {
    if (inFlight) return false;
    inFlight = true;
    try {
        const remote = await request('/state');
        const remoteRecords = remote.records || {};
        const local = localRecords();

        if (Object.keys(remoteRecords).length) {
            hydrate(remoteRecords);
            // Push keys the server has never seen, plus keys where the server
            // only holds an empty placeholder ([] / {}) but the browser has
            // real records — so local work always converges back to PostgreSQL.
            const missingInRemote = {};
            for (const [k, v] of Object.entries(local)) {
                if (!isSyncableKey(k)) continue;
                const remoteHoldsRealData = k in remoteRecords && !isEmptyValue(remoteRecords[k]);
                if (!remoteHoldsRealData && !isEmptyValue(v)) {
                    missingInRemote[k] = v;
                } else if (!(k in remoteRecords)) {
                    missingInRemote[k] = v;
                }
            }
            if (Object.keys(missingInRemote).length > 0) {
                await request('/state', { method: 'PUT', body: JSON.stringify({ records: missingInRemote }) });
            }
            markSynced(Object.keys(missingInRemote));
        } else if (Object.keys(local).length) {
            await request('/state', { method: 'PUT', body: JSON.stringify({ records: local }) });
            markSynced(Object.keys(local));
        } else {
            markSynced([]);
        }
        lastSnapshot = JSON.stringify(localRecords());
        return true;
    } catch (error) {
        // Server unreachable: everything local is unconfirmed — count it as pending.
        const local = localRecords();
        for (const key of Object.keys(local)) pendingKeys.add(key);
        markUnsynced(error);
        if (error.name !== 'AbortError') warnThrottled(`ERP PostgreSQL sync unavailable; changes are queued locally. (${error.message})`);
        return false;
    } finally {
        inFlight = false;
    }
};

export const flushERPState = async() => {
    const records = localRecords();
    const snapshot = JSON.stringify(records);
    if (snapshot === lastSnapshot || inFlight) return false;
    const sentKeys = Object.keys(records);
    try {
        inFlight = true;
        await request('/state', { method: 'PUT', body: JSON.stringify({ records }) });
        lastSnapshot = snapshot;
        markSynced(sentKeys);
        return true;
    } catch (error) {
        markUnsynced(error);
        if (error.name !== 'AbortError') warnThrottled(`ERP PostgreSQL flush failed: ${error.message}`);
        return false;
    } finally {
        inFlight = false;
    }
};

export const saveERPRecord = async(key, value) => {
    if (!isSyncableKey(key)) return false;
    pendingKeys.add(key);
    emitStatus();
    try {
        await request(`/state/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: JSON.stringify({ data: value })
        });
        pendingKeys.delete(key);
        setStatus({ connected: true, lastSyncAt: new Date().toISOString(), lastError: null });
        return true;
    } catch (error) {
        markUnsynced(error);
        warnThrottled(`Direct save for '${key}' failed, will retry via mirror: ${error.message}`);
        return false;
    }
};

export const deleteERPRecord = async(key) => {
    if (!isSyncableKey(key)) return false;
    try {
        await request(`/state/${encodeURIComponent(key)}`, { method: 'DELETE' });
        pendingKeys.delete(key);
        emitStatus();
        return true;
    } catch (error) {
        markUnsynced(error);
        warnThrottled(`Direct delete for '${key}' failed: ${error.message}`);
        return false;
    }
};

let storageHookInstalled = false;

export const installStorageHook = () => {
    if (storageHookInstalled || typeof window === 'undefined' || !window.localStorage) return;
    storageHookInstalled = true;

    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);

    localStorage.setItem = (key, value) => {
        originalSetItem(key, value);
        if (!isHydrating && isTrackedKey(key)) {
            if (isSyncableKey(key)) {
                pendingKeys.add(key);
                emitStatus();
            }
            window.dispatchEvent(new CustomEvent('erp-state-change', { detail: { key } }));
        }
    };

    localStorage.removeItem = (key) => {
        originalRemoveItem(key);
        if (!isHydrating && isTrackedKey(key)) {
            if (isSyncableKey(key)) {
                pendingKeys.add(key);
                emitStatus();
                deleteERPRecord(key).catch(() => {});
            }
            window.dispatchEvent(new CustomEvent('erp-state-change', { detail: { key, removed: true } }));
        }
    };
};

export const startERPStateMirror = () => {
    installStorageHook();
    let debounceTimer = null;
    const triggerSync = async() => {
        const records = localRecords();
        const snapshot = JSON.stringify(records);
        if (snapshot === lastSnapshot || inFlight) return;
        const sentKeys = Object.keys(records);
        try {
            inFlight = true;
            await request('/state', { method: 'PUT', body: JSON.stringify({ records }) });
            lastSnapshot = snapshot;
            markSynced(sentKeys);
        } catch (error) {
            markUnsynced(error);
            if (error.name !== 'AbortError') warnThrottled(`ERP PostgreSQL write unavailable; ${pendingKeys.size} change(s) remain queued. ${error.message}`);
        } finally {
            inFlight = false;
        }
    };

    const intervalTimer = window.setInterval(triggerSync, SYNC_INTERVAL_MS);

    const onStateChanged = () => {
        if (debounceTimer) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(triggerSync, 150);
    };

    const onUnloadOrHide = () => {
        const records = localRecords();
        const snapshot = JSON.stringify(records);
        if (snapshot === lastSnapshot) return;
        try {
            const body = JSON.stringify({ records });
            if (navigator?.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                navigator.sendBeacon(`${API_BASE}/state`, blob);
            } else {
                fetch(`${API_BASE}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
            }
            lastSnapshot = snapshot;
            markSynced(Object.keys(records));
        } catch {
            /* ignore unload failure */
        }
    };

    window.addEventListener('erp-state-change', onStateChanged);
    window.addEventListener('beforeunload', onUnloadOrHide);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onUnloadOrHide();
    });

    return () => {
        window.clearInterval(intervalTimer);
        if (debounceTimer) window.clearTimeout(debounceTimer);
        window.removeEventListener('erp-state-change', onStateChanged);
        window.removeEventListener('beforeunload', onUnloadOrHide);
    };
};

export const getERPStateApiBase = () => API_BASE;
