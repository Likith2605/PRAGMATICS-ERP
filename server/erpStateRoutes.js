import express from 'express';
import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { findChangedContactValidationError } from '../shared/fieldValidation.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { canAccessStateKey } from '../shared/stateAccess.js';
import { hasPermissionForRole, validateEmployeeAssignments, normalizeEmployeeAssignments, DEPARTMENT_ROLE_OPTIONS, normalizeDepartment, ALLOWED_PERMISSION_KEYS } from './departmentAccess.js';
import { stableDepartmentId, stableRoleId, permissionAssignmentKey } from '../shared/roleIdentity.js';

const router = express.Router();
const MAX_RECORD_BYTES = Number(process.env.MAX_ERP_STATE_BYTES || 25 * 1024 * 1024);
// Modules that have moved to per-record storage (/api/records -> module_records)
// are rejected here so exactly ONE authority exists per module.
const moduleOwnedKeys = new Set(['inventoryItems', 'stockTransactions', 'productionDispatchRequests']);
const excludedKeys = new Set(['erp_auth', 'rolePermissions', 'currentQuotation', 'currentVendorEnquiry', 'currentVendorQuotation', ...moduleOwnedKeys]);
const RETIRED_INDENT_SOURCE = 'storeDirect';

const withStableCatalogIds = (key, value) => {
    if (!['departmentCatalog', 'roleCatalog'].includes(key) || !Array.isArray(value)) return value;
    const prefix = key === 'roleCatalog' ? 'role' : 'department';
    const used = new Set();
    return value.map((item, index) => {
        const currentId = String(item?.id ?? '').trim();
        if (currentId && !['undefined', 'null'].includes(currentId.toLowerCase()) && !used.has(currentId)) {
            used.add(currentId);
            return item;
        }
        const identity = key === 'roleCatalog'
            ? `${item?.department || ''}\u0000${item?.roleKey || ''}\u0000${item?.name || ''}`
            : String(item?.name || '');
        const root = `${prefix}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
        let id = root;
        let suffix = 2;
        while (used.has(id)) id = `${root}-${suffix++}`;
        used.add(id);
        return { ...item, id };
    });
};
const catalogIdsChanged = (before, after) => JSON.stringify(before) !== JSON.stringify(after);

const isSyncableKey = (key) => {
    const value = String(key || '');
    return value && !excludedKeys.has(value) && !value.startsWith('erpDailySnapshots') && !value.startsWith('erpBackupAuditLogs');
};

const recordIdentity = (value) => {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (value.departmentId != null && value.roleId != null) return `departmentId:roleId:${String(value.departmentId)}:${String(value.roleId)}`;
    for (const field of ['id','reference','number','quotationNumber','enquiryNumber','indentNumber','poNumber','soNumber','invoiceNumber','employeeId','machineId','itemCode','vendorId','seq','name']) {
        if (value[field] !== undefined && value[field] !== null && String(value[field]) !== '') return `${field}:${String(value[field])}`;
    }
    return JSON.stringify(value);
};
const removedEntries = (before, after) => {
    if (!Array.isArray(before) || !Array.isArray(after)) return [];
    const remaining = new Set(after.map(recordIdentity));
    return before.filter((record) => !remaining.has(recordIdentity(record)));
};
const statusTransitions = (before, after, path = '') => {
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
    if (Array.isArray(before) && Array.isArray(after)) {
        const current = new Map(after.map((item) => [recordIdentity(item), item]));
        return before.flatMap((item) => statusTransitions(item, current.get(recordIdentity(item)), path));
    }
    if (Array.isArray(before) || Array.isArray(after)) return [];
    const changes = [];
    for (const [key, value] of Object.entries(after)) {
        const prior = before[key];
        const field = key.toLowerCase();
        const statusAction = field === 'status' && String(prior ?? '') !== String(value ?? '') && /cancel|reverse|deactivat|inactive|void/i.test(String(value));
        const deactivation = ['active','isactive','enabled'].includes(field) && prior === true && value === false;
        const sensitiveTimestamp = ['cancelledat','canceledat','reversedat','deactivatedat','voidedat'].includes(field) && !prior && Boolean(value);
        if (statusAction || deactivation || sensitiveTimestamp) changes.push({ path: `${path}.${key}`, before: prior, after: value });
        else if (value && prior && typeof value === 'object' && typeof prior === 'object') changes.push(...statusTransitions(prior, value, `${path}.${key}`));
    }
    return changes;
};
const enforceSensitiveTransitions = async (req, key, previous, next, reasons = {}) => {
    const changes = statusTransitions(previous, next);
    if (!changes.length) return;
    if (req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') {
        const error = new Error('Administrator access is required for cancellation, reversal, or deactivation.'); error.status = 403; throw error;
    }
    const reason = String(reasons[key] || reasons.default || '').trim();
    if (!reason) { const error = new Error(`A reason is required for controlled status changes in '${key}'.`); error.status = 400; throw error; }
    return reason;
};
const enforceAndAuditRemovals = async (req, key, previous, next, reasons = {}) => {
    const removed = removedEntries(previous, next);
    if (!removed.length) return;
    if (req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') {
        const error = new Error('Administrator access is required to permanently delete ERP records.'); error.status = 403; throw error;
    }
    if (['employees','machines'].includes(key)) {
        const error = new Error(`${key} records must be deactivated; permanent deletion is not permitted.`); error.status = 409; throw error;
    }
    if (['vendorMaster','customerDirectory','customerMaster'].includes(key)) {
        const pool = getPool();
        const [state, moduleRecords] = await Promise.all([
            pool.query('SELECT storage_key,data FROM erp_state WHERE storage_key<>$1', [key]),
            pool.query('SELECT storage_key,data FROM module_records')
        ]);
        const relatedValues = [
            ...state.rows.filter((row) => !/settings|master|catalog|sequence|employees|notifications/i.test(row.storage_key)),
            ...moduleRecords.rows
        ].map((row) => row.data);
        for (const record of removed) {
            const values = [record.id, record.seq, record.name, record.companyName, record.customerName, record.customerCode, record.vendorCode].filter(Boolean).map((value) => String(value).toLowerCase());
            const isVendor = key === 'vendorMaster';
            const fields = isVendor ? /vendor|supplier/ : /customer|buyer|party|client|company/;
            const inUse = (value, field = '') => {
                if (Array.isArray(value)) return value.some((item) => inUse(item, field));
                if (!value || typeof value !== 'object') return fields.test(field) && values.includes(String(value).toLowerCase());
                return Object.entries(value).some(([childKey, child]) => inUse(child, childKey));
            };
            if (relatedValues.some((value) => inUse(value))) {
                const error = new Error('This master record is referenced by business history and cannot be deleted. Deactivate it instead.'); error.status = 409; throw error;
            }
        }
    }
    const entries = removed.map((record) => {
        const recordId = recordIdentity(record).replace(/^[^:]+:/, '');
        const reason = String(reasons[recordId] || reasons[key] || '').trim();
        return { record, recordId, reason };
    });
    const missing = entries.find((entry) => !entry.reason);
    if (missing) { const error = new Error(`A deletion reason is required for ${key} record '${missing.recordId}'.`); error.status = 400; throw error; }
    return entries;
};

const validateRecords = (records) => {
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
        const error = new Error('records must be an object');
        error.status = 400;
        throw error;
    }
    const filtered = {};
    for (const [key, value] of Object.entries(records)) {
        if (!isSyncableKey(key)) continue;
        const serialized = JSON.stringify(value);
        if (serialized.length > MAX_RECORD_BYTES) {
            const error = new Error(`ERP record '${key}' exceeds the configured size limit`);
            error.status = 413;
            throw error;
        }
        filtered[key] = value;
    }
    return filtered;
};
const withoutEmployeePasswords = (records) => {
    const safe = { ...(records || {}) };
    if (Array.isArray(safe.employees)) safe.employees = safe.employees.map(({ password, ...employee }) => employee);
    return safe;
};
const stateKeyAllowed = (req, key, mode) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator' || canAccessStateKey(key, (permission) => hasPermissionForRole(req.user?.roleKey, permission, req.user?.rolePermissions), mode);
const validateEmployeeList = (employees) => {
    if (!Array.isArray(employees)) return 'Employee records must be a list.';
    const ids = new Set();
    const emails = new Set();
    for (const employee of employees) {
        const assignmentError = validateEmployeeAssignments(employee);
        if (assignmentError) return `${employee?.employeeId || employee?.name || 'Employee'}: ${assignmentError}`;
        const id = String(employee?.employeeId || '').trim().toLowerCase();
        const email = String(employee?.email || '').trim().toLowerCase();
        if (id && ids.has(id)) return `Employee ID '${employee.employeeId}' is assigned to more than one account.`;
        if (email && emails.has(email)) return `Login ID '${email}' is assigned to more than one account.`;
        if (id) ids.add(id);
        if (email) emails.add(email);
    }
    return null;
};
const validateEmployeeAssignmentReferences = async (employees, executor = getPool()) => {
    const result = await executor.query("SELECT storage_key,data FROM erp_state WHERE storage_key IN ('departmentCatalog','roleCatalog')");
    const catalogs = Object.fromEntries(result.rows.map((row) => [row.storage_key, row.data]));
    const departments = Array.isArray(catalogs.departmentCatalog) ? catalogs.departmentCatalog : [];
    const roles = Array.isArray(catalogs.roleCatalog) ? catalogs.roleCatalog : [];
    for (const employee of employees) {
        for (const assignment of normalizeEmployeeAssignments(employee)) {
            const departmentId = stableDepartmentId(assignment.department, departments);
            const roleId = stableRoleId(assignment.department, assignment.roleKey, roles, departments);
            const source = (employee.departmentAssignments || []).find((entry) => normalizeDepartment(entry.department) === assignment.department);
            if (source?.departmentId && String(source.departmentId) !== departmentId) return `${employee.employeeId || employee.name}: department assignment does not match the saved department ID.`;
            if (source?.roleId && String(source.roleId) !== roleId) return `${employee.employeeId || employee.name}: role assignment does not match the saved role ID for '${assignment.department}'.`;
        }
    }
    return null;
};
const validateMasterCatalog = (key, value) => {
    if (!['departmentCatalog','roleCatalog'].includes(key)) return null;
    if (!Array.isArray(value)) return `${key} must be a list.`;
    const names = new Set(); const codes = new Set(); const roleKeys = new Set(); const ids = new Set();
    for (const item of value) {
        const name = String(item?.name || '').trim(); const code = String(item?.code || '').trim().toLowerCase();
        const id = String(item?.id || '').trim();
        if (!name) return 'Name is required.';
        if (!id || ['undefined', 'null'].includes(id.toLowerCase())) return 'A stable catalog ID is required.';
        if (ids.has(id)) return `Duplicate catalog ID '${id}'.`;
        ids.add(id);
        if (key === 'departmentCatalog' && new Set(['Admin', ...Object.keys(DEPARTMENT_ROLE_OPTIONS)]).has(normalizeDepartment(name))) return `Built-in department '${name}' cannot be stored or deleted as a custom department.`;
        const scope = key === 'roleCatalog' ? String(item.department || '').toLowerCase() : '';
        const nameKey = `${scope}:${name.toLowerCase()}`; const codeKey = `${scope}:${code}`;
        if (names.has(nameKey)) return `Duplicate ${key === 'roleCatalog' ? 'role' : 'department'} name '${name}'.`;
        if (code && codes.has(codeKey)) return `Duplicate code '${item.code}'.`;
        names.add(nameKey); if (code) codes.add(codeKey);
        if (key === 'roleCatalog' && (!scope || !String(item.roleKey || '').trim())) return 'Role department and role key are required.';
        const roleKey = String(item.roleKey || '').trim().toLowerCase(); const roleIdentity = `${scope}:${roleKey}`;
        if (key === 'roleCatalog' && roleKeys.has(roleIdentity)) return `Duplicate role key '${item.roleKey}' in department '${item.department}'.`;
        if (key === 'roleCatalog') roleKeys.add(roleIdentity);
        if (key === 'roleCatalog' && (DEPARTMENT_ROLE_OPTIONS[item.department] || []).some((builtin) => builtin.roleKey === item.roleKey || builtin.role.toLowerCase() === name.toLowerCase())) return `Built-in role '${name}' cannot be stored or deleted as a custom role.`;
    }
    return null;
};

router.get('/state/rolePermissions/:departmentId/:roleId', requireAdmin, async (req, res) => {
    const key = permissionAssignmentKey(req.params.departmentId, req.params.roleId);
    const result = await getPool().query("SELECT data FROM erp_state WHERE storage_key='rolePermissions'");
    const entries = Array.isArray(result.rows[0]?.data) ? result.rows[0].data : [];
    const entry = entries.find((item) => permissionAssignmentKey(item.departmentId, item.roleId) === key);
    return res.json({ departmentId: req.params.departmentId, roleId: req.params.roleId, permissions: entry?.permissions || null });
});

router.put('/state/rolePermissions/:departmentId/:roleId', requireAdmin, async (req, res) => {
    const departmentId = String(req.params.departmentId || '').trim();
    const roleId = String(req.params.roleId || '').trim();
    const permissions = req.body?.permissions;
    if (!departmentId || !roleId || !Array.isArray(permissions)) return res.status(400).json({ error: 'Department ID, role ID, and a permission list are required.' });
    if (permissions.some((permission) => typeof permission !== 'string' || !ALLOWED_PERMISSION_KEYS.includes(permission))) return res.status(400).json({ error: 'The permission list contains an unknown permission.' });
    const uniquePermissions = [...new Set(permissions)];
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`role-permissions:${departmentId}:${roleId}`]);
        const result = await client.query("SELECT storage_key,data FROM erp_state WHERE storage_key IN ('departmentCatalog','roleCatalog','rolePermissions') ORDER BY storage_key FOR UPDATE");
        const state = Object.fromEntries(result.rows.map((row) => [row.storage_key, row.data]));
        const departments = Array.isArray(state.departmentCatalog) ? state.departmentCatalog : [];
        const roles = Array.isArray(state.roleCatalog) ? state.roleCatalog : [];
        const department = departments.find((item) => String(item.id) === departmentId) ||
            Object.keys(DEPARTMENT_ROLE_OPTIONS).find((name) => stableDepartmentId(name, departments) === departmentId);
        if (!department) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Department was not found.' }); }
        const departmentName = typeof department === 'string' ? department : department.name;
        const role = roles.find((item) => String(item.id) === roleId &&
            (item.departmentId ? String(item.departmentId) === departmentId : normalizeDepartment(item.department) === normalizeDepartment(departmentName)));
        const builtIn = (DEPARTMENT_ROLE_OPTIONS[departmentName] || []).find((item) => stableRoleId(departmentName, item.roleKey, roles, departments) === roleId);
        if (!role && !builtIn) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Role was not found in the selected department.' }); }
        const roleKey = role?.roleKey || builtIn.roleKey;
        const key = permissionAssignmentKey(departmentId, roleId);
        const before = Array.isArray(state.rolePermissions) ? state.rolePermissions : [];
        const nextEntry = { departmentId, roleId, department: departmentName, roleKey, permissions: uniquePermissions };
        const next = [...before.filter((entry) => permissionAssignmentKey(entry.departmentId, entry.roleId) !== key), nextEntry];
        await auditStateChanges(client, req, 'rolePermissions', before, next);
        const saved = await client.query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES ('rolePermissions',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now() RETURNING updated_at", [JSON.stringify(next)]);
        await client.query('COMMIT');
        return res.json({ success: true, departmentId, roleId, permissions: uniquePermissions, updatedAt: saved.rows[0].updated_at?.toISOString() });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});
const validateReferencedMasterRemovals = async (key, previous, next, executor = getPool(), { allowPermissionCleanup = false } = {}) => {
    if (!['departmentCatalog','roleCatalog'].includes(key) || !Array.isArray(previous) || !Array.isArray(next)) return null;
    const nextById = new Map(next.map((item) => [String(item.id || ''), item]));
    const removed = previous.filter((item) => {
        const replacement = nextById.get(String(item.id || ''));
        return !replacement || replacement.name !== item.name || (key === 'roleCatalog' && (replacement.department !== item.department || replacement.roleKey !== item.roleKey));
    });
    if (!removed.length) return null;
    const result = await executor.query("SELECT storage_key,data FROM erp_state WHERE storage_key IN ('employees','roleCatalog','rolePermissions')");
    const recordsByKey = new Map(result.rows.map((row) => [row.storage_key, row.data]));
    const employees = Array.isArray(recordsByKey.get('employees')) ? recordsByKey.get('employees') : [];
    const roles = Array.isArray(recordsByKey.get('roleCatalog')) ? recordsByKey.get('roleCatalog') : [];
    const rolePermissions = Array.isArray(recordsByKey.get('rolePermissions')) ? recordsByKey.get('rolePermissions') : [];
    const departmentRecords = key === 'departmentCatalog'
        ? await executor.query("SELECT storage_key,data FROM erp_state WHERE storage_key NOT IN ('employees','roleCatalog','departmentCatalog','rolePermissions')")
        : { rows: [] };
    const hasDepartmentReference = (value, target) => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some((item) => hasDepartmentReference(item, target));
        return Object.entries(value).some(([field, item]) => {
            const normalizedField = field.toLowerCase().replace(/[^a-z]/g, '');
            const isDepartmentField = ['department','departmentname','dept','deptname','receivedbydept'].includes(normalizedField);
            return (isDepartmentField && typeof item === 'string' && normalizeDepartment(item) === target) || hasDepartmentReference(item, target);
        });
    };
    for (const master of removed) {
        if (key === 'departmentCatalog' && new Set(['Admin', ...Object.keys(DEPARTMENT_ROLE_OPTIONS)]).has(normalizeDepartment(master.name))) return `Built-in department '${master.name}' cannot be deleted.`;
        if (key === 'roleCatalog' && (DEPARTMENT_ROLE_OPTIONS[master.department] || []).some((builtin) => builtin.roleKey === master.roleKey || builtin.role.toLowerCase() === String(master.name).toLowerCase())) return `Built-in role '${master.name}' cannot be deleted.`;
        const users = employees.filter((employee) => normalizeEmployeeAssignments(employee).some((assignment) =>
            key === 'departmentCatalog'
                ? assignment.department === master.name
                : assignment.department === master.department && (assignment.roleKey === master.roleKey || assignment.role === master.name)
        ));
        if (users.length) return key === 'departmentCatalog'
            ? `Cannot delete department '${master.name}': it is currently assigned to ${users.map((employee) => employee.name || employee.employeeId || 'an employee').join(', ')}.`
            : `Cannot delete role '${master.name}': it is currently in use by ${users.map((employee) => employee.name || employee.employeeId || 'an employee').join(', ')}.`;
        if (key === 'departmentCatalog') {
            const permissionReferences = rolePermissions.filter((entry) => String(entry.departmentId) === String(master.id));
            if (permissionReferences.length && !allowPermissionCleanup) return `Cannot delete department '${master.name}' while role permission records exist.`;
            const scopedRoles = roles.filter((role) => normalizeDepartment(role.department) === normalizeDepartment(master.name));
            if (scopedRoles.length) return `Cannot delete department '${master.name}' while custom roles exist in it: ${scopedRoles.map((role) => role.name).join(', ')}.`;
            const references = departmentRecords.rows.filter((row) => hasDepartmentReference(row.data, normalizeDepartment(master.name))).map((row) => row.storage_key);
            if (references.length) return `Cannot delete department '${master.name}': it is referenced by existing ERP records (${references.join(', ')}).`;
        }
        if (key === 'roleCatalog') {
            const permissionReferences = rolePermissions.filter((entry) => String(entry.roleId) === String(master.id));
            if (permissionReferences.length && !allowPermissionCleanup) return `Cannot delete role '${master.name}' while its permission record exists.`;
        }
    }
    return null;
};
const auditStateChanges = async (client, req, key, before, after, reason = '') => {
    const changes = [];
    if (Array.isArray(before) && Array.isArray(after)) {
        const oldById = new Map(before.map((record) => [recordIdentity(record), record]));
        const newById = new Map(after.map((record) => [recordIdentity(record), record]));
        for (const [identity, record] of newById) {
            const prior = oldById.get(identity);
            if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(record)) changes.push({ id: identity.replace(/^[^:]+:/, ''), label: record?.name || record?.itemName || record?.number || identity, action: prior === undefined ? 'CREATE' : 'UPDATE', before: prior, after: record });
        }
    } else if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
        changes.push({ id: key, label: key, action: before == null ? 'CREATE' : 'UPDATE', before, after });
    }
    for (const change of changes) await client.query(
        `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
        [req.user.id, req.user.email, req.user.role, key, change.id, String(change.label), statusTransitions(change.before, change.after).length ? 'CONTROLLED_STATUS_CHANGE' : change.action, reason,
            change.before == null ? null : JSON.stringify(safeAuditValues(change.before)),
            change.after == null ? null : JSON.stringify(safeAuditValues(change.after))]
    );
};
const auditRemovedRecords = async (client, req, key, entries) => {
    for (const entry of entries || []) await client.query(
        `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values)
         VALUES ($1,$2,$3,$4,$5,$6,'DELETE',$7,$8::jsonb)`,
        [req.user.id, req.user.email, req.user.role, key, entry.recordId,
            entry.record?.name || entry.record?.itemName || entry.record?.number || entry.recordId,
            entry.reason, JSON.stringify(safeAuditValues(entry.record))]
    );
};
const revokeDeactivatedEmployeeSessions = async (client, key, before, after) => {
    if (key !== 'employees' || !Array.isArray(before) || !Array.isArray(after)) return;
    const current = new Map(after.map((employee) => [recordIdentity(employee), employee]));
    for (const oldEmployee of before) {
        const next = current.get(recordIdentity(oldEmployee));
        if (oldEmployee?.active !== false && next?.active === false && next.email) {
            await client.query('UPDATE erp_sessions SET revoked_at=now() WHERE lower(email)=lower($1) AND revoked_at IS NULL', [next.email]);
        }
    }
};

// Keep the old Store Direct rows as immutable history while rejecting any new
// row that tries to use their retired source marker. This applies equally to
// whole-state sync and the per-key API.
const preserveRetiredIndentHistory = (value, previousValue) => {
    if (!Array.isArray(value)) return { error: 'Purchase Indents must be saved as a list.' };
    const historical = (Array.isArray(previousValue) ? previousValue : [])
        .filter((entry) => entry?.sourceType === RETIRED_INDENT_SOURCE);
    const byNumber = new Map(historical.map((entry) => [String(entry.indentNumber || ''), entry]));
    const newRetired = value.find((entry) =>
        entry?.sourceType === RETIRED_INDENT_SOURCE && !byNumber.has(String(entry.indentNumber || ''))
    );
    if (newRetired) {
        return { error: 'This Purchase Indent source has been retired; new records cannot use it.' };
    }
    const current = value.filter((entry) => !byNumber.has(String(entry?.indentNumber || '')));
    return { value: [...current, ...historical] };
};

router.get('/state', async(req, res) => {
    const result = await getPool().query('SELECT storage_key, data, updated_at FROM erp_state ORDER BY storage_key');
    const records = Object.fromEntries(result.rows.filter((row) => stateKeyAllowed(req, row.storage_key, 'read')).map((row) => [row.storage_key, row.data]));
    res.json({ records: withoutEmployeePasswords(records), updatedAt: result.rows.at(-1)?.updated_at?.toISOString() || null });
});

const upsertState = async(req, res) => {
    const records = validateRecords(req.body?.records);
    const keys = Object.keys(records);
    for (const key of keys) records[key] = withStableCatalogIds(key, records[key]);
    const forbidden = keys.find((key) => !stateKeyAllowed(req, key, 'write'));
    if (forbidden) return res.status(403).json({ error: `Your selected department role cannot access '${forbidden}'.` });
    const previousResult = keys.length
        ? await getPool().query('SELECT storage_key, data FROM erp_state WHERE storage_key = ANY($1::text[])', [keys])
        : { rows: [] };
    const previousByKey = new Map(previousResult.rows.map((row) => [row.storage_key, row.data]));
    const removalsByKey = new Map();
    const statusReasonsByKey = new Map();
    for (const [key, value] of Object.entries(records)) {
        const masterError = validateMasterCatalog(key, value);
        if (masterError) return res.status(400).json({ error: masterError });
        const removalError = await validateReferencedMasterRemovals(key, previousByKey.get(key), value);
        if (removalError) return res.status(409).json({ error: removalError });
        if (key === 'employees' && JSON.stringify(previousByKey.get(key) ?? null) !== JSON.stringify(value) && req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') return res.status(403).json({ error: 'Only an Administrator can manage Employee records.' });
        if (key === 'employees') {
            const employeeError = validateEmployeeList(value);
            if (employeeError) return res.status(400).json({ error: employeeError });
        }
        statusReasonsByKey.set(key, await enforceSensitiveTransitions(req, key, previousByKey.get(key), value, req.body?.reasons || {}));
        removalsByKey.set(key, await enforceAndAuditRemovals(req, key, previousByKey.get(key), value, req.body?.reasons || {}));
    }
    if (Object.hasOwn(records, 'purchaseIndents')) {
        const preserved = preserveRetiredIndentHistory(records.purchaseIndents, previousByKey.get('purchaseIndents'));
        if (preserved.error) return res.status(400).json({ error: preserved.error });
        records.purchaseIndents = preserved.value;
    }
    for (const [key, value] of Object.entries(records)) {
        // Customer master values are free-form imported data: repeated or
        // non-standard phone/GST/email values must not block synchronisation.
        if (key === 'customerDirectory') continue;
        const validationError = findChangedContactValidationError(value, previousByKey.get(key));
        if (validationError) return res.status(400).json({ error: validationError });
    }
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(records)) {
            await auditRemovedRecords(client, req, key, removalsByKey.get(key));
            await auditStateChanges(client, req, key, previousByKey.get(key), value, statusReasonsByKey.get(key));
            await revokeDeactivatedEmployeeSessions(client, key, previousByKey.get(key), value);
            await client.query(
                `INSERT INTO erp_state (storage_key, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (storage_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [key, JSON.stringify(value)]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true, savedKeys: Object.keys(records).length });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

router.put('/state', upsertState);
router.post('/state', upsertState);

router.get('/state/:key', async(req, res) => {
    const { key } = req.params;
    if (!isSyncableKey(key)) return res.status(400).json({ error: 'Invalid or excluded ERP state key' });
    if (!stateKeyAllowed(req, key, 'read')) return res.status(403).json({ error: 'Your selected department role cannot access this ERP data.' });
    let result = await getPool().query('SELECT storage_key, data, updated_at FROM erp_state WHERE storage_key = $1', [key]);
    if (!result.rowCount) return res.status(404).json({ error: `Record '${key}' not found` });
    let data = result.rows[0].data;
    if (['departmentCatalog', 'roleCatalog'].includes(key)) {
        const normalized = withStableCatalogIds(key, data);
        if (catalogIdsChanged(data, normalized)) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                const locked = await client.query('SELECT data FROM erp_state WHERE storage_key=$1 FOR UPDATE', [key]);
                data = withStableCatalogIds(key, locked.rows[0]?.data || []);
                await client.query('UPDATE erp_state SET data=$2::jsonb,updated_at=now() WHERE storage_key=$1', [key, JSON.stringify(data)]);
                await client.query('COMMIT');
                result = { ...result, rows: [{ ...result.rows[0], data, updated_at: new Date() }] };
            } catch (error) { await client.query('ROLLBACK'); throw error; }
            finally { client.release(); }
        }
    }
    res.json({ key: result.rows[0].storage_key, data: key === 'employees' && Array.isArray(data) ? data.map(({ password, ...employee }) => employee) : data, updatedAt: result.rows[0].updated_at?.toISOString() });
});

router.put('/state/:key', async(req, res) => {
    const { key } = req.params;
    if (!isSyncableKey(key)) return res.status(400).json({ error: 'Invalid or excluded ERP state key' });
    if (!stateKeyAllowed(req, key, 'write')) return res.status(403).json({ error: 'Your selected department role cannot modify this ERP data.' });
    let value = req.body?.data !== undefined ? req.body.data : req.body;
    value = withStableCatalogIds(key, value);
    const previousResult = await getPool().query('SELECT data FROM erp_state WHERE storage_key = $1', [key]);
    const removalError = await validateReferencedMasterRemovals(key, previousResult.rows[0]?.data, value);
    if (removalError) return res.status(409).json({ error: removalError });
    if (key === 'employees' && JSON.stringify(previousResult.rows[0]?.data ?? null) !== JSON.stringify(value) && req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') return res.status(403).json({ error: 'Only an Administrator can manage Employee records.' });
    if (key === 'employees') {
        const employeeError = validateEmployeeList(value);
        if (employeeError) return res.status(400).json({ error: employeeError });
        const assignmentReferenceError = await validateEmployeeAssignmentReferences(value);
        if (assignmentReferenceError) return res.status(400).json({ error: assignmentReferenceError });
    }
    const masterError = validateMasterCatalog(key, value);
    if (masterError) return res.status(400).json({ error: masterError });
    const statusReason = await enforceSensitiveTransitions(req, key, previousResult.rows[0]?.data, value, req.body?.reasons || {});
    const removals = await enforceAndAuditRemovals(req, key, previousResult.rows[0]?.data, value, req.body?.reasons || {});
    if (key === 'purchaseIndents') {
        const preserved = preserveRetiredIndentHistory(value, previousResult.rows[0]?.data);
        if (preserved.error) return res.status(400).json({ error: preserved.error });
        value = preserved.value;
    }
    const validationError = key === 'customerDirectory'
        ? null
        : findChangedContactValidationError(value, previousResult.rows[0]?.data);
    if (validationError) return res.status(400).json({ error: validationError });
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_RECORD_BYTES) {
        return res.status(413).json({ error: `ERP record '${key}' exceeds the configured size limit` });
    }
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        await auditRemovedRecords(client, req, key, removals);
        await auditStateChanges(client, req, key, previousResult.rows[0]?.data, value, statusReason);
        await revokeDeactivatedEmployeeSessions(client, key, previousResult.rows[0]?.data, value);
        const result = await client.query(
            `INSERT INTO erp_state (storage_key, data, updated_at)
             VALUES ($1, $2::jsonb, now())
             ON CONFLICT (storage_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
             RETURNING storage_key, updated_at`, [key, serialized]
        );
        await client.query('COMMIT');
        res.json({ success: true, key: result.rows[0].storage_key, updatedAt: result.rows[0].updated_at?.toISOString() });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
});

router.delete('/state/employees/:employeeId', requireAdmin, async(req, res) => {
    const employeeId = String(req.params.employeeId || '').trim();
    if (!employeeId || ['undefined', 'null'].includes(employeeId.toLowerCase())) return res.status(400).json({ error: 'A valid Employee ID is required.' });
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query("SELECT data FROM erp_state WHERE storage_key='employees' FOR UPDATE");
        const employees = Array.isArray(locked.rows[0]?.data) ? locked.rows[0].data : [];
        // Employee ID is the human-facing master identifier (for example TEST-123).
        // `id` may instead contain an authentication account key such as auth-multi-123.
        const employee = employees.find((item) => String(item.employeeId || '').trim().toLowerCase() === employeeId.toLowerCase());
        if (!employee) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found.' }); }
        if (['admin', 'administrator'].includes(String(employee.roleKey || '').toLowerCase()) || String(employee.role || '').toLowerCase() === 'administrator' || String(employee.id) === 'admin' || employee.serverManaged === true) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'The built-in Administrator account is server managed and cannot be deleted.' });
        }
        const employeeIdentity = new Set([employee.id, employee.employeeId, employee.email].filter(Boolean).map((value) => String(value).trim().toLowerCase()));
        const adminIdentity = [req.user?.id, req.user?.employeeId, req.user?.email].filter(Boolean).map((value) => String(value).trim().toLowerCase());
        if (adminIdentity.some((identity) => employeeIdentity.has(identity))) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'The currently authenticated Admin account cannot be deleted.' });
        }

        // Audit rows, module records, quality inspections, approvals, and workflow
        // documents are immutable snapshots. They have no employee foreign key and
        // are deliberately left untouched by this operation.
        const identities = [...employeeIdentity];
        await client.query(
            `UPDATE erp_sessions SET revoked_at=COALESCE(revoked_at,now())
             WHERE revoked_at IS NULL AND (lower(user_id)=ANY($1::text[]) OR lower(email)=ANY($1::text[]) OR lower(employee_id)=ANY($1::text[]))`,
            [identities]
        );
        const next = employees.filter((item) => String(item.employeeId || '').trim().toLowerCase() !== employeeId.toLowerCase());
        await client.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='employees'", [JSON.stringify(next)]);
        await client.query(
            `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
             VALUES ($1,$2,$3,'employees',$4,$5,'DELETE','',$6::jsonb,$7::jsonb)`,
            [req.user.id, req.user.email, req.user.role, employeeId, employee.name || employee.employeeId || '', JSON.stringify(safeAuditValues(employee)), JSON.stringify({ deleted: true })]
        );
        await client.query('COMMIT');
        res.json({ success: true, deleted: { id: employee.id, employeeId: employee.employeeId, name: employee.name } });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
});

router.delete('/state/customerDirectory/:customerId', requireAdmin, async(req, res) => {
    const id = String(req.params.customerId || '').trim();
    if (!id || ['undefined', 'null'].includes(id.toLowerCase())) return res.status(400).json({ error: 'A valid customer ID is required.' });
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query("SELECT data FROM erp_state WHERE storage_key='customerDirectory' FOR UPDATE");
        const before = Array.isArray(locked.rows[0]?.data) ? locked.rows[0].data : [];
        const customer = before.find((record) => String(record?.id || '') === id);
        if (!customer) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer not found.' }); }
        const after = before.filter((record) => String(record?.id || '') !== id);
        const reason = 'Administrator confirmed deletion from the Customers page.';
        const removals = await enforceAndAuditRemovals(req, 'customerDirectory', before, after, { [id]: reason });
        await auditRemovedRecords(client, req, 'customerDirectory', removals);
        await client.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='customerDirectory'", [JSON.stringify(after)]);
        await client.query('COMMIT');
        return res.json({ success: true, deleted: { id, companyName: customer.companyName || customer.customerName || '' } });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.status) return res.status(error.status).json({ error: error.message });
        throw error;
    } finally { client.release(); }
});

router.delete('/state/departmentCatalog/:id', requireAdmin, async(req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id || ['undefined', 'null'].includes(id.toLowerCase())) return res.status(400).json({ error: 'A valid department ID is required.' });
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query("SELECT storage_key,data FROM erp_state WHERE storage_key IN ('departmentCatalog','employees','roleCatalog','rolePermissions') ORDER BY storage_key FOR UPDATE");
        const before = locked.rows.find((row) => row.storage_key === 'departmentCatalog')?.data || [];
        const department = before.find((item) => String(item.id) === id);
        if (!department) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Custom department not found.' }); }
        const builtInDepartments = new Set(['Admin', ...Object.keys(DEPARTMENT_ROLE_OPTIONS)]);
        if (builtInDepartments.has(normalizeDepartment(department.name))) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Built-in department '${department.name}' cannot be deleted.` });
        }
        const next = before.filter((item) => String(item.id) !== id);
        const inUseError = await validateReferencedMasterRemovals('departmentCatalog', before, next, client, { allowPermissionCleanup: true });
        if (inUseError) { await client.query('ROLLBACK'); return res.status(409).json({ error: inUseError }); }
        const permissionsBefore = Array.isArray(locked.rows.find((row) => row.storage_key === 'rolePermissions')?.data) ? locked.rows.find((row) => row.storage_key === 'rolePermissions').data : [];
        const permissionsAfter = permissionsBefore.filter((entry) => String(entry.departmentId) !== id);
        if (permissionsAfter.length !== permissionsBefore.length) {
            await auditStateChanges(client, req, 'rolePermissions', permissionsBefore, permissionsAfter, 'Scoped role permission entries removed with their deleted test/custom department.');
            await client.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='rolePermissions'", [JSON.stringify(permissionsAfter)]);
        }
        await auditRemovedRecords(client, req, 'departmentCatalog', [{ recordId: id, record: department, reason: '' }]);
        await auditStateChanges(client, req, 'departmentCatalog', before, next);
        const saved = await client.query("INSERT INTO erp_state (storage_key,data,updated_at) VALUES ('departmentCatalog',$1::jsonb,now()) ON CONFLICT (storage_key) DO UPDATE SET data=EXCLUDED.data, updated_at=now() RETURNING updated_at", [JSON.stringify(next)]);
        await client.query('COMMIT');
        return res.json({ success: true, updatedAt: saved.rows[0]?.updated_at?.toISOString() });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.post('/state/departmentCatalog/:id/deactivate', requireAdmin, async(req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id || ['undefined', 'null'].includes(id.toLowerCase())) return res.status(400).json({ error: 'A valid department ID is required.' });
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await client.query("SELECT data FROM erp_state WHERE storage_key='departmentCatalog' FOR UPDATE");
        const before = Array.isArray(result.rows[0]?.data) ? result.rows[0].data : [];
        const current = before.find((item) => String(item.id) === id);
        if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Custom department not found.' }); }
        const builtInDepartments = new Set(['Admin', ...Object.keys(DEPARTMENT_ROLE_OPTIONS)]);
        if (builtInDepartments.has(normalizeDepartment(current.name))) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Built-in department '${current.name}' cannot be deactivated.` });
        }
        const next = before.map((item) => String(item.id) === id ? { ...item, active: false } : item);
        await auditStateChanges(client, req, 'departmentCatalog', before, next, 'Department deactivated; assignments and historical records retained.');
        const saved = await client.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='departmentCatalog' RETURNING updated_at", [JSON.stringify(next)]);
        await client.query('COMMIT');
        return res.json({ success: true, active: false, updatedAt: saved.rows[0]?.updated_at?.toISOString() });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.delete('/state/roleCatalog/:id', requireAdmin, async(req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id || ['undefined', 'null'].includes(id.toLowerCase())) return res.status(400).json({ error: 'A valid role ID is required.' });
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query("SELECT storage_key, data FROM erp_state WHERE storage_key IN ('roleCatalog','employees','rolePermissions') ORDER BY storage_key FOR UPDATE");
        const before = locked.rows.find((row) => row.storage_key === 'roleCatalog')?.data || [];
        const role = before.find((item) => String(item.id) === id);
        if (!role) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Custom role not found.' }); }
        if ((DEPARTMENT_ROLE_OPTIONS[role.department] || []).some((builtin) => builtin.roleKey === role.roleKey || builtin.role.toLowerCase() === String(role.name).toLowerCase())) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Built-in role '${role.name}' cannot be deleted.` });
        }
        const next = before.filter((item) => String(item.id) !== id);
        const inUseError = await validateReferencedMasterRemovals('roleCatalog', before, next, client, { allowPermissionCleanup: true });
        if (inUseError) { await client.query('ROLLBACK'); return res.status(409).json({ error: inUseError }); }
        const permissionsBefore = Array.isArray(locked.rows.find((row) => row.storage_key === 'rolePermissions')?.data) ? locked.rows.find((row) => row.storage_key === 'rolePermissions').data : [];
        const permissionsAfter = permissionsBefore.filter((entry) => String(entry.roleId) !== id);
        if (permissionsAfter.length !== permissionsBefore.length) {
            await auditStateChanges(client, req, 'rolePermissions', permissionsBefore, permissionsAfter, 'Scoped role permission entry removed with its deleted custom role.');
            await client.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='rolePermissions'", [JSON.stringify(permissionsAfter)]);
        }
        await auditRemovedRecords(client, req, 'roleCatalog', [{ recordId: id, record: role, reason: '' }]);
        await auditStateChanges(client, req, 'roleCatalog', before, next);
        const saved = await client.query("INSERT INTO erp_state (storage_key,data,updated_at) VALUES ('roleCatalog',$1::jsonb,now()) ON CONFLICT (storage_key) DO UPDATE SET data=EXCLUDED.data, updated_at=now() RETURNING updated_at", [JSON.stringify(next)]);
        await client.query('COMMIT');
        return res.json({ success: true, updatedAt: saved.rows[0]?.updated_at?.toISOString() });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.delete('/state/:key', requireAdmin, async(req, res) => {
    const { key } = req.params;
    if (!isSyncableKey(key)) return res.status(400).json({ error: 'Invalid or excluded ERP state key' });
    return res.status(409).json({ error: 'ERP module state cannot be removed as a whole. Use the record-specific controlled action so dependencies and audit history are preserved.' });
});

export default router;
export { router };
