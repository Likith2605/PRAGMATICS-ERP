import { authHeaders, isAdmin } from '../utils/auth.js';
import { hasPermission } from '../utils/permissions.js';
import { canAccessStateKey } from '../../shared/stateAccess.js';
import { stableDepartmentId, stableRoleId, permissionAssignmentKey } from '../../shared/roleIdentity.js';

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
const MODULE_OWNED_KEYS = new Set(['inventoryItems', 'stockTransactions', 'productionDispatchRequests']);

const isSyncableKey = (key) => {
    const value = String(key || '');
    return value && !LOCAL_ONLY_KEYS.has(value) && !MODULE_OWNED_KEYS.has(value);
};
const canSyncWriteKey = (key) => isAdmin() || canAccessStateKey(key, hasPermission, 'write');

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

/** True when this browser holds a newer, not-yet-confirmed copy of a key.
 *  Used so a late PostgreSQL hydration can never overwrite freshly entered
 *  company settings (including an uploaded logo) with an older server copy. */
const hasUnsyncedLocalValue = (key) => {
    if (pendingKeys.has(key)) return true;
    if (!lastSnapshot) return false;
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return false;
        const baseline = JSON.parse(lastSnapshot);
        return JSON.stringify(JSON.parse(raw)) !== JSON.stringify(baseline[key]);
    } catch {
        return false;
    }
};

const localRecords = () => {
    const records = {};
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!isSyncableKey(key) || !canSyncWriteKey(key)) continue;
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
            headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || `ERP sync failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
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
let permissionBlocked = false;

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
    permissionBlocked = false;
    setStatus({ connected: true, permissionDenied: false, lastSyncAt: new Date().toISOString(), lastError: null });
};

const markUnsynced = (error) => {
    const denied = error?.status === 401 || error?.status === 403;
    permissionBlocked = denied;
    setStatus({ connected: denied ? true : false, permissionDenied: denied, lastError: error?.message || 'Unknown sync error' });
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
            // Never let a late hydration replace the newer company record this
            // browser just saved (the logo is part of that single record).
            if (key === 'companySettings' && hasUnsyncedLocalValue(key)) return;
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
const REASON_KEY = 'erp_state_action_reasons';
const actionReasons = () => { try { return JSON.parse(localStorage.getItem(REASON_KEY) || '{}'); } catch { return {}; } };
const recordKey = (item) => {
    if (!item || typeof item !== 'object') return JSON.stringify(item);
    for (const field of ['id','reference','number','quotationNumber','enquiryNumber','indentNumber','poNumber','soNumber','invoiceNumber','employeeId','machineId','itemCode','seq','name']) if (item[field] != null) return `${field}:${item[field]}`;
    return JSON.stringify(item);
};
const stateMutationReasons = (snapshot, current) => {
    let before = {};
    try { before = JSON.parse(snapshot || '{}'); } catch { /* no baseline */ }
    const savedReasons = actionReasons();
    const reasons = {};
    for (const [key, next] of Object.entries(current)) {
        // Master catalog deletes use dedicated Admin APIs and retain their own audit entries.
        if (key === 'roleCatalog' || key === 'departmentCatalog') continue;
        const prior = before[key];
        if (!Array.isArray(prior) || !Array.isArray(next)) continue;
        const nextById = new Map(next.map((item) => [recordKey(item), item]));
        const deleted = prior.filter((item) => !nextById.has(recordKey(item)));
        const controlled = prior.some((item) => {
            const updated = nextById.get(recordKey(item));
            return updated && String(item?.status || '') !== String(updated?.status || '') && /cancel|reverse|deactivat|inactive|void/i.test(String(updated?.status || ''));
        });
        if (!deleted.length && !controlled) continue;
        if (savedReasons[key]) { reasons[key] = savedReasons[key]; continue; }
        const suppliedReason = prior.map((item) => nextById.get(recordKey(item))).filter(Boolean)
            .find((item) => /cancel|reverse|deactivat|inactive|void/i.test(String(item?.status || '')) && (item.cancelReason || item.cancellationReason || item.reversalReason || item.deactivationReason || item.actionReason));
        if (suppliedReason) {
            reasons[key] = String(suppliedReason.cancelReason || suppliedReason.cancellationReason || suppliedReason.reversalReason || suppliedReason.deactivationReason || suppliedReason.actionReason).trim();
            savedReasons[key] = reasons[key];
            continue;
        }
        if (!isAdmin()) continue;
        const reason = window.prompt(`Reason for the Admin deletion or controlled status change in ${key}:`)?.trim();
        if (reason) { reasons[key] = reason; savedReasons[key] = reason; }
    }
    localStorage.setItem(REASON_KEY, JSON.stringify(savedReasons));
    return reasons;
};
const clearStateReasons = (reasons) => {
    const all = actionReasons();
    for (const key of Object.keys(reasons)) delete all[key];
    localStorage.setItem(REASON_KEY, JSON.stringify(all));
};

export const syncERPState = async({ force = false } = {}) => {
    if (inFlight || (permissionBlocked && !force)) return false;
    inFlight = true;
    try {
        const remote = await request('/state');
        const remoteRecords = remote.records || {};
        const local = localRecords();
        const reasons = stateMutationReasons(lastSnapshot, local);

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
                await request('/state', { method: 'PUT', body: JSON.stringify({ records: missingInRemote, reasons }) });
            }
            markSynced(Object.keys(missingInRemote));
        } else if (Object.keys(local).length) {
            await request('/state', { method: 'PUT', body: JSON.stringify({ records: local, reasons }) });
            markSynced(Object.keys(local));
        } else {
            markSynced([]);
        }
        lastSnapshot = JSON.stringify(localRecords());
        clearStateReasons(reasons);
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
    if (permissionBlocked) return false;
    const records = localRecords();
    const snapshot = JSON.stringify(records);
    if (snapshot === lastSnapshot || inFlight) return false;
    const sentKeys = Object.keys(records);
    const reasons = stateMutationReasons(lastSnapshot, records);
    try {
        inFlight = true;
        await request('/state', { method: 'PUT', body: JSON.stringify({ records, reasons }) });
        lastSnapshot = snapshot;
        clearStateReasons(reasons);
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
            body: JSON.stringify({ data: value, reasons: stateMutationReasons(lastSnapshot, { [key]: value }) })
        });
        pendingKeys.delete(key);
        clearStateReasons({ [key]: true });
        setStatus({ connected: true, lastSyncAt: new Date().toISOString(), lastError: null });
        return true;
    } catch (error) {
        markUnsynced(error);
        warnThrottled(`Direct save for '${key}' failed, will retry via mirror: ${error.message}`);
        return false;
    }
};

export const deleteCustomRole = async(id) => {
    if (!id || !String(id).trim() || ['undefined', 'null'].includes(String(id).trim().toLowerCase())) return { success: false, error: 'Cannot delete role: a valid role ID is missing.' };
    if (!id || ['undefined', 'null'].includes(String(id).trim().toLowerCase())) return { success: false, error: 'Cannot delete role: a valid role ID is missing.' };
    try {
        const result = await request(`/state/roleCatalog/${encodeURIComponent(id)}`, { method: 'DELETE' });
        try {
            const catalog = JSON.parse(window.localStorage.getItem('roleCatalog') || '[]');
            if (Array.isArray(catalog)) window.localStorage.setItem('roleCatalog', JSON.stringify(catalog.filter((item) => String(item.id) !== String(id))));
        } catch { /* The server deletion is authoritative even if the local cache is malformed. */ }
        pendingKeys.delete('roleCatalog');
        setStatus({ connected: true, lastSyncAt: new Date().toISOString(), lastError: null });
        return { success: true, ...result };
    } catch (error) {
        markUnsynced(error);
        return { success: false, error: error.message };
    }
};

export const deleteCustomDepartment = async(id) => {
    if (!id || !String(id).trim() || ['undefined', 'null'].includes(String(id).trim().toLowerCase())) return { success: false, error: 'Cannot delete department: a valid department ID is missing.' };
    if (!id || ['undefined', 'null'].includes(String(id).trim().toLowerCase())) return { success: false, error: 'Cannot delete department: a valid department ID is missing.' };
    try {
        const result = await request(`/state/departmentCatalog/${encodeURIComponent(id)}`, { method: 'DELETE' });
        try {
            const catalog = JSON.parse(window.localStorage.getItem('departmentCatalog') || '[]');
            if (Array.isArray(catalog)) window.localStorage.setItem('departmentCatalog', JSON.stringify(catalog.filter((item) => String(item.id) !== String(id))));
        } catch { /* The server deletion is authoritative even if the local cache is malformed. */ }
        pendingKeys.delete('departmentCatalog');
        setStatus({ connected: true, lastSyncAt: new Date().toISOString(), lastError: null });
        return { success: true, ...result };
    } catch (error) {
        markUnsynced(error);
        return { success: false, error: error.message };
    }
};

export const deactivateCustomDepartment = async(id) => {
    if (!id || !String(id).trim() || ['undefined', 'null'].includes(String(id).trim().toLowerCase())) return { success: false, error: 'Cannot deactivate department: a valid department ID is missing.' };
    try {
        const result = await request(`/state/departmentCatalog/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
        try {
            const catalog = JSON.parse(window.localStorage.getItem('departmentCatalog') || '[]');
            if (Array.isArray(catalog)) window.localStorage.setItem('departmentCatalog', JSON.stringify(catalog.map((item) => String(item.id) === String(id) ? { ...item, active: false } : item)));
        } catch { /* The server state is authoritative if the local cache is malformed. */ }
        pendingKeys.delete('departmentCatalog');
        setStatus({ connected: true, lastSyncAt: new Date().toISOString(), lastError: null });
        return { success: true, ...result };
    } catch (error) {
        markUnsynced(error);
        return { success: false, error: error.message };
    }
};

/** Fetch the current shared value for a module from PostgreSQL. */
export const getERPRecord = async(key) => {
    const payload = await request(`/state/${encodeURIComponent(key)}`);
    return payload.data;
};

/** Admin-only, department-scoped permission update; resolves only after PostgreSQL confirms it. */
export const saveRolePermissions = async({ department, roleKey, permissions }) => {
    if (!isAdmin()) return { success: false, error: 'Administrator access is required.' };
    try {
        const [departments, roles] = await Promise.all([
            getERPRecord('departmentCatalog').catch(() => []),
            getERPRecord('roleCatalog').catch(() => [])
        ]);
        const departmentId = stableDepartmentId(department, departments);
        const roleId = stableRoleId(department, roleKey, roles, departments);
        const response = await request(`/state/rolePermissions/${encodeURIComponent(departmentId)}/${encodeURIComponent(roleId)}`, {
            method: 'PUT', body: JSON.stringify({ permissions })
        });
        const auth = JSON.parse(localStorage.getItem('erp_auth') || 'null');
        if (auth && Array.isArray(auth.assignments)) {
            auth.assignments = auth.assignments.map((assignment) =>
                permissionAssignmentKey(assignment.departmentId, assignment.roleId) === permissionAssignmentKey(departmentId, roleId)
                    ? { ...assignment, permissions: response.permissions }
                    : assignment
            );
            localStorage.setItem('erp_auth', JSON.stringify(auth));
            window.dispatchEvent(new CustomEvent('erp-auth-permissions-updated'));
        }
        setStatus({ connected: true, permissionDenied: false, lastSyncAt: new Date().toISOString(), lastError: null });
        return { success: true, ...response };
    } catch (error) {
        return { success: false, error: error.message, status: error.status };
    }
};

export const getRolePermissions = async(departmentId, roleId) => request(`/state/rolePermissions/${encodeURIComponent(departmentId)}/${encodeURIComponent(roleId)}`);

/** Permanently remove an eligible employee by Employee ID from PostgreSQL. */
export const deleteEmployee = async(employeeId) => {
    const id = String(employeeId || '').trim();
    if (!id || ['undefined', 'null'].includes(id.toLowerCase())) return { success: false, error: 'A valid Employee ID is required.' };
    try {
        const result = await request(`/state/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const serverEmployees = await getERPRecord('employees');
        const localEmployees = (() => { try { return JSON.parse(localStorage.getItem('employees') || '[]'); } catch { return []; } })();
        const cachedByEmployeeId = new Map(localEmployees.map((employee) => [String(employee.employeeId || '').toLowerCase(), employee]));
        const withCredentials = (Array.isArray(serverEmployees) ? serverEmployees : []).map((employee) => ({
            ...employee,
            password: employee.password || cachedByEmployeeId.get(String(employee.employeeId || '').toLowerCase())?.password || ''
        }));
        localStorage.setItem('employees', JSON.stringify(withCredentials));
        markSynced(['employees']);
        window.dispatchEvent(new CustomEvent('erp-state-hydrated'));
        return { success: true, ...result };
    } catch (error) {
        // A protected-history conflict or validation error is a business response,
        // not a connection failure. Leave the ERP sync indicator untouched.
        return { success: false, error: error.message, status: error.status };
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
        if (permissionBlocked) return;
        const records = localRecords();
        const snapshot = JSON.stringify(records);
        if (snapshot === lastSnapshot || inFlight) return;
        const sentKeys = Object.keys(records);
        const reasons = stateMutationReasons(lastSnapshot, records);
        try {
            inFlight = true;
            await request('/state', { method: 'PUT', body: JSON.stringify({ records, reasons }) });
            lastSnapshot = snapshot;
            clearStateReasons(reasons);
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
            const reasons = stateMutationReasons(lastSnapshot, records);
            const body = JSON.stringify({ records, reasons });
            if (navigator?.sendBeacon) {
                fetch(`${API_BASE}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body, keepalive: true }).catch(() => {});
            } else {
                fetch(`${API_BASE}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body, keepalive: true }).catch(() => {});
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
export const resetERPStateSyncBaseline = () => {
    permissionBlocked = false;
    lastSnapshot = JSON.stringify(localRecords());
};
