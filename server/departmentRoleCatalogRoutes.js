import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { DEPARTMENT_ROLE_OPTIONS, normalizeDepartment, normalizeEmployeeAssignments, ALLOWED_PERMISSION_KEYS } from './departmentAccess.js';
import { getEmployeeRecordsForAssignmentChecks } from './employeeStore.js';
import {
  departmentRoleLegacyId,
  readDepartmentRoleCatalogs,
  readLegacyDepartmentRoleSnapshots,
  resolveRolePermission
} from './departmentRoleCatalogStore.js';
import { permissionAssignmentKey, stableDepartmentId, stableRoleId } from '../shared/roleIdentity.js';

const router = express.Router();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const text = (value, limit = 500) => String(value ?? '').trim().slice(0, limit);
const isBuiltInDepartment = (name) => Object.hasOwn(DEPARTMENT_ROLE_OPTIONS, normalizeDepartment(name));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const requestHash = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const idempotencyToken = (req) => text(req.body?.idempotencyToken || req.body?.createToken || req.get('idempotency-key'), 120);
const requireToken = (req) => {
  const token = idempotencyToken(req);
  if (!TOKEN_PATTERN.test(token)) throw fail('A valid idempotency token is required.', 400);
  return token;
};
const route = (handler) => async (req, res, next) => {
  try {
    if (req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') return res.status(403).json({ error: 'Administrator access is required.' });
    await handler(req, res);
  } catch (error) {
    if (res.headersSent) return next(error);
    if (error.code === '23505') return res.status(409).json({ error: 'A department, role, or idempotency identifier already exists.' });
    return res.status(error.status || 500).json({ error: error.message || 'Department and role catalog operation failed.' });
  }
};

const withTransaction = async (operation) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const claimIdempotency = async (client, req, { kind, recordId, action, body }) => {
  const token = requireToken(req);
  const hash = requestHash(body);
  const inserted = await client.query(
    `INSERT INTO master_idempotency(token,kind,record_id,action,request_hash,response)
     VALUES($1,$2,$3,$4,$5,'{}'::jsonb) ON CONFLICT(token) DO NOTHING RETURNING token`,
    [token, `department-role:${kind}`, String(recordId), action, hash]
  );
  if (inserted.rowCount) return { token, replay: false };
  const previous = await client.query('SELECT request_hash,response FROM master_idempotency WHERE token=$1', [token]);
  if (previous.rows[0]?.request_hash !== hash) throw fail('This idempotency token was used for a different request.', 409);
  return { token, replay: true, response: previous.rows[0]?.response || {} };
};
const completeIdempotency = (client, token, body) => client.query(
  'UPDATE master_idempotency SET response=$2::jsonb WHERE token=$1',
  [token, JSON.stringify(safeAuditValues(body))]
);

const audit = (client, req, { module, id, label, action, reason = '', before = null, after = null }) => client.query(
  `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
  [req.user.id, req.user.email, req.user.role, module, String(id), text(label, 240), action, text(reason, 1000),
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);

const mapDepartment = (row) => ({
  id: row.id, name: row.name, active: row.active, version: Number(row.version),
  createdAt: row.created_at?.toISOString?.() || row.created_at,
  updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  deletedAt: row.deleted_at?.toISOString?.() || row.deleted_at || null,
  deletedBy: row.deleted_by || null, deleteReason: row.delete_reason || '', legacy: false
});
const mapRole = (row) => ({
  id: row.id, departmentId: row.department_id, department: row.department,
  name: row.name, roleKey: row.role_key, active: row.active, version: Number(row.version),
  createdAt: row.created_at?.toISOString?.() || row.created_at,
  updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  deletedAt: row.deleted_at?.toISOString?.() || row.deleted_at || null,
  deletedBy: row.deleted_by || null, deleteReason: row.delete_reason || '', legacy: false
});
const catalogListing = (records, includeDeleted) => records.filter((record) =>
  includeDeleted || (record.active !== false && !record.deletedAt)
);
const versionNumber = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const assertVersion = (expected, actual, label) => {
  if (expected === null || expected !== Number(actual)) throw fail(`${label} changed since it was loaded. Refresh and retry.`, 409);
};
const assertValidId = (id, label) => {
  const value = text(id, 120);
  if (!ID_PATTERN.test(value) || ['undefined', 'null'].includes(value.toLowerCase())) throw fail(`A valid ${label} ID is required.`);
  return value;
};
const departmentById = async (executor, id) => {
  const result = await executor.query('SELECT * FROM department_catalog WHERE id=$1', [id]);
  return result.rows[0] || null;
};
const roleById = async (executor, id) => {
  const result = await executor.query('SELECT * FROM role_catalog WHERE id=$1', [id]);
  return result.rows[0] || null;
};
const assignmentUsers = async (executor, { department, roleKey }) => {
  const employees = await getEmployeeRecordsForAssignmentChecks(executor);
  return employees.filter((employee) => normalizeEmployeeAssignments(employee).some((assignment) =>
    (!department || assignment.department === department) &&
    (!roleKey || assignment.roleKey === roleKey)
  ));
};
const ensureNoAssignments = async (executor, record, kind) => {
  const employees = await getEmployeeRecordsForAssignmentChecks(executor);
  const assignments = employees.filter((employee) => normalizeEmployeeAssignments(employee).some((assignment) =>
    kind === 'department'
      ? assignment.department === normalizeDepartment(record.name)
      : assignment.department === normalizeDepartment(record.department) && (
        assignment.roleKey === record.role_key || assignment.role === record.name
      )
  ));
  if (assignments.length) {
    const names = assignments.map((employee) => employee.name || employee.employeeId || 'an employee').join(', ');
    throw fail(`Cannot delete ${kind} '${record.name}': it is assigned to ${names}.`, 409);
  }
};
const ensureDepartmentReference = async (executor, departmentId, departmentName) => {
  if (isBuiltInDepartment(departmentName) && stableDepartmentId(departmentName) === departmentId) return;
  const row = await executor.query(
    'SELECT id,active,deleted_at FROM department_catalog WHERE id=$1',
    [departmentId]
  );
  if (!row.rowCount || row.rows[0].deleted_at || !row.rows[0].active) throw fail('The selected department is missing or inactive. Import or restore it before managing roles.', 409);
};
const validateRolePair = async (executor, departmentId, roleId) => {
  const catalogs = await readDepartmentRoleCatalogs(executor);
  const department = catalogs.departments.find((entry) => entry.id === departmentId && !entry.deletedAt && entry.active !== false) ||
    Object.keys(DEPARTMENT_ROLE_OPTIONS).find((name) => stableDepartmentId(name) === departmentId);
  if (!department) throw fail('Department was not found or is inactive.', 404);
  const departmentName = typeof department === 'string' ? department : department.name;
  const role = catalogs.roles.find((entry) => entry.id === roleId && entry.departmentId === departmentId && !entry.deletedAt && entry.active !== false);
  const builtIn = (DEPARTMENT_ROLE_OPTIONS[departmentName] || []).find((entry) => stableRoleId(departmentName, entry.roleKey) === roleId);
  if (!role && !builtIn) throw fail('Role was not found or is inactive in the selected department.', 404);
  return { catalogs, departmentName, role, builtIn, roleKey: role?.roleKey || builtIn.roleKey };
};

router.get('/history', route(async (req, res) => {
  const modules = ['departmentCatalog', 'roleCatalog', 'rolePermissions'];
  const module = modules.includes(String(req.query.module || '')) ? String(req.query.module) : null;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
  const result = await getPool().query(
    `SELECT id,user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values,created_at
     FROM erp_audit_log
     WHERE module=ANY($1::text[]) AND ($2::text IS NULL OR module=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [modules, module, limit]
  );
  res.json({ entries: result.rows });
}));

router.get('/departments', route(async (req, res) => {
  const catalogs = await readDepartmentRoleCatalogs();
  res.json({ records: catalogListing(catalogs.departments, req.query.includeDeleted === '1') });
}));
router.get('/roles', route(async (req, res) => {
  const catalogs = await readDepartmentRoleCatalogs();
  res.json({ records: catalogListing(catalogs.roles, req.query.includeDeleted === '1') });
}));
router.get('/departments/:id', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'department');
  const catalogs = await readDepartmentRoleCatalogs();
  const record = catalogs.departments.find((item) => item.id === id);
  if (!record) throw fail('Department not found.', 404);
  res.json({ record });
}));
router.get('/roles/:id', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'role');
  const catalogs = await readDepartmentRoleCatalogs();
  const record = catalogs.roles.find((item) => item.id === id);
  if (!record) throw fail('Role not found.', 404);
  res.json({ record });
}));

router.post('/departments', route(async (req, res) => {
  const data = req.body?.data || {};
  const name = text(data.name, 120);
  if (!name) throw fail('Department name is required.');
  if (isBuiltInDepartment(name) || normalizeDepartment(name) === 'Admin') throw fail(`Built-in department '${name}' cannot be created as a custom department.`, 409);
  const id = assertValidId(data.id || `dept-${randomUUID()}`, 'department');
  const payload = { id, name, active: data.active !== false };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'departments', recordId: id, action: 'CREATE', body: payload });
    if (claim.replay) return { replay: true, body: claim.response };
    const duplicate = await client.query('SELECT 1 FROM department_catalog WHERE id=$1 OR lower(name)=lower($2) AND deleted_at IS NULL', [id, name]);
    const catalogs = await readDepartmentRoleCatalogs(client);
    const legacyDuplicate = catalogs.departments.some((record) => record.legacy && normalizeDepartment(record.name).toLowerCase() === normalizeDepartment(name).toLowerCase());
    if (duplicate.rowCount || legacyDuplicate) throw fail('A department with this ID or name already exists, including in the preserved legacy catalog.', 409);
    const saved = await client.query(
      `INSERT INTO department_catalog(id,name,active,created_by,updated_by)
       VALUES($1,$2,$3,$4,$4) RETURNING *`,
      [id, name, payload.active, String(req.user.id)]
    );
    const record = mapDepartment(saved.rows[0]);
    await audit(client, req, { module: 'departmentCatalog', id, label: name, action: 'CREATE', after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.status(result.replay ? 200 : 201).json(result.body);
}));

router.post('/roles', route(async (req, res) => {
  const data = req.body?.data || {};
  const name = text(data.name, 120);
  const department = normalizeDepartment(text(data.department, 120));
  const departmentId = assertValidId(data.departmentId, 'department');
  const roleKey = text(data.roleKey, 100).toLowerCase();
  if (!name || !department || !roleKey) throw fail('Department, role name, and role key are required.');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(roleKey)) throw fail('Role key must contain only lowercase letters, digits, underscores, or hyphens.');
  if (isBuiltInDepartment(department) && (DEPARTMENT_ROLE_OPTIONS[department] || []).some((item) => item.roleKey === roleKey || item.role.toLowerCase() === name.toLowerCase())) {
    throw fail(`Built-in role '${name}' cannot be created as a custom role.`, 409);
  }
  const id = assertValidId(data.id || `role-${randomUUID()}`, 'role');
  const payload = { id, departmentId, department, name, roleKey, active: data.active !== false };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'roles', recordId: id, action: 'CREATE', body: payload });
    if (claim.replay) return { replay: true, body: claim.response };
    await ensureDepartmentReference(client, departmentId, department);
    const catalogs = await readDepartmentRoleCatalogs(client);
    const expectedDepartmentId = stableDepartmentId(department, catalogs.departments);
    if (expectedDepartmentId !== departmentId) throw fail('Department ID does not match the selected department.', 409);
    const duplicate = await client.query(
      `SELECT 1 FROM role_catalog WHERE id=$1 OR (department_id=$2 AND (lower(name)=lower($3) OR lower(role_key)=lower($4)) AND deleted_at IS NULL)`,
      [id, departmentId, name, roleKey]
    );
    const legacyDuplicate = catalogs.roles.some((record) =>
      record.legacy && record.departmentId === departmentId &&
      (record.name.toLowerCase() === name.toLowerCase() || record.roleKey.toLowerCase() === roleKey.toLowerCase())
    );
    if (duplicate.rowCount || legacyDuplicate) throw fail('A role with this ID, name, or role key already exists in the department, including in the preserved legacy catalog.', 409);
    const saved = await client.query(
      `INSERT INTO role_catalog(id,department_id,department,name,role_key,active,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [id, departmentId, department, name, roleKey, payload.active, String(req.user.id)]
    );
    const record = mapRole(saved.rows[0]);
    await audit(client, req, { module: 'roleCatalog', id, label: `${department} · ${name}`, action: 'CREATE', after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.status(result.replay ? 200 : 201).json(result.body);
}));

router.put('/departments/:id', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'department');
  const expectedVersion = versionNumber(req.body?.version);
  if (expectedVersion === null) throw fail('A valid department version is required.');
  const data = req.body?.data || {};
  const name = text(data.name, 120);
  if (!name) throw fail('Department name is required.');
  if (isBuiltInDepartment(name) || normalizeDepartment(name) === 'Admin') throw fail(`Built-in department '${name}' cannot be used as a custom department.`, 409);
  const bodyInput = { id, version: expectedVersion, data: { name, active: data.active } };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'departments', recordId: id, action: 'UPDATE', body: bodyInput });
    if (claim.replay) return { replay: true, body: claim.response };
    const beforeRow = await departmentById(client, id);
    if (!beforeRow || beforeRow.deleted_at) throw fail('Department not found.', 404);
    assertVersion(expectedVersion, beforeRow.version, 'Department');
    const before = mapDepartment(beforeRow);
    if (name.toLowerCase() !== before.name.toLowerCase()) {
      const users = await assignmentUsers(client, { department: normalizeDepartment(before.name) });
      const roles = await client.query('SELECT 1 FROM role_catalog WHERE department_id=$1 AND deleted_at IS NULL LIMIT 1', [id]);
      if (users.length || roles.rowCount) throw fail('A department assigned to employees or containing roles cannot be renamed.', 409);
    }
    const legacyNameConflict = (await readDepartmentRoleCatalogs(client)).departments.some((record) =>
      record.legacy && normalizeDepartment(record.name).toLowerCase() === normalizeDepartment(name).toLowerCase()
    );
    if (legacyNameConflict) throw fail('A preserved legacy department already uses this name; import or reconcile it first.', 409);
    const active = data.active === undefined ? before.active : Boolean(data.active);
    const reason = text(req.body?.reason, 1000);
    if (active !== before.active && !reason) throw fail('A reason is required to change department status.');
    const saved = await client.query(
      `UPDATE department_catalog SET name=$2,active=$3,version=version+1,updated_by=$4,updated_at=now()
       WHERE id=$1 AND version=$5 RETURNING *`,
      [id, name, active, String(req.user.id), expectedVersion]
    );
    if (!saved.rowCount) throw fail('Department changed concurrently. Refresh and retry.', 409);
    const record = mapDepartment(saved.rows[0]);
    await audit(client, req, { module: 'departmentCatalog', id, label: name, action: active !== before.active ? 'STATUS_CHANGE' : 'UPDATE', reason, before, after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.status(result.replay ? 200 : 200).json(result.body);
}));

router.put('/roles/:id', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'role');
  const expectedVersion = versionNumber(req.body?.version);
  if (expectedVersion === null) throw fail('A valid role version is required.');
  const data = req.body?.data || {};
  const name = text(data.name, 120);
  const roleKey = text(data.roleKey, 100).toLowerCase();
  if (!name || !roleKey) throw fail('Role name and role key are required.');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(roleKey)) throw fail('Role key must contain only lowercase letters, digits, underscores, or hyphens.');
  const input = { id, version: expectedVersion, data: { name, roleKey, active: data.active } };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'roles', recordId: id, action: 'UPDATE', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    const beforeRow = await roleById(client, id);
    if (!beforeRow || beforeRow.deleted_at) throw fail('Role not found.', 404);
    assertVersion(expectedVersion, beforeRow.version, 'Role');
    const before = mapRole(beforeRow);
    const active = data.active === undefined ? before.active : Boolean(data.active);
    if (name !== before.name || roleKey !== before.roleKey) {
      const users = await assignmentUsers(client, { roleKey: before.role_key, department: before.department });
      if (users.length) throw fail('A role assigned to employees cannot have its name or identifier changed.', 409);
    }
    if ((DEPARTMENT_ROLE_OPTIONS[before.department] || []).some((item) => item.roleKey === roleKey || item.role.toLowerCase() === name.toLowerCase())) {
      throw fail(`Built-in role '${name}' cannot be used as a custom role.`, 409);
    }
    const legacyNameConflict = (await readDepartmentRoleCatalogs(client)).roles.some((record) =>
      record.legacy && record.departmentId === before.department_id &&
      (record.name.toLowerCase() === name.toLowerCase() || record.roleKey.toLowerCase() === roleKey.toLowerCase())
    );
    if (legacyNameConflict) throw fail('A preserved legacy role already uses this name or identifier; import or reconcile it first.', 409);
    if (active !== before.active && !text(req.body?.reason, 1000)) throw fail('A reason is required to change role status.');
    const saved = await client.query(
      `UPDATE role_catalog SET name=$2,role_key=$3,active=$4,version=version+1,updated_by=$5,updated_at=now()
       WHERE id=$1 AND version=$6 RETURNING *`,
      [id, name, roleKey, active, String(req.user.id), expectedVersion]
    );
    if (!saved.rowCount) throw fail('Role changed concurrently. Refresh and retry.', 409);
    const record = mapRole(saved.rows[0]);
    if (record.roleKey !== before.roleKey) {
      await client.query(
        `UPDATE role_permission_catalog SET role_key=$3,updated_by=$4,updated_at=now()
         WHERE department_id=$1 AND role_id=$2`,
        [record.departmentId, record.id, record.roleKey, String(req.user.id)]
      );
    }
    await audit(client, req, { module: 'roleCatalog', id, label: `${record.department} · ${name}`, action: active !== before.active ? 'STATUS_CHANGE' : 'UPDATE', reason: text(req.body?.reason, 1000), before, after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.json(result.body);
}));

router.delete('/departments/:id', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'department');
  const version = versionNumber(req.body?.version);
  const reason = text(req.body?.reason, 1000);
  if (version === null) throw fail('A valid department version is required.');
  if (!reason) throw fail('A deletion reason is required.');
  const input = { id, version, reason };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'departments', recordId: id, action: 'SOFT_DELETE', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    const beforeRow = await departmentById(client, id);
    if (!beforeRow || beforeRow.deleted_at) throw fail('Department not found.', 404);
    assertVersion(version, beforeRow.version, 'Department');
    const before = mapDepartment(beforeRow);
    const roles = await client.query('SELECT 1 FROM role_catalog WHERE department_id=$1 AND deleted_at IS NULL LIMIT 1', [id]);
    if (roles.rowCount) throw fail('Delete or deactivate the department roles before deleting this department.', 409);
    await ensureNoAssignments(client, beforeRow, 'department');
    const saved = await client.query(
      `UPDATE department_catalog SET active=false,deleted_at=now(),deleted_by=$2,delete_reason=$3,
       version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 AND version=$4 RETURNING *`,
      [id, String(req.user.id), reason, version]
    );
    if (!saved.rowCount) throw fail('Department changed concurrently. Refresh and retry.', 409);
    const record = mapDepartment(saved.rows[0]);
    await audit(client, req, { module: 'departmentCatalog', id, label: before.name, action: 'SOFT_DELETE', reason, before, after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.status(result.replay ? 200 : 200).json(result.body);
}));

router.delete('/roles/:id', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'role');
  const version = versionNumber(req.body?.version);
  const reason = text(req.body?.reason, 1000);
  if (version === null) throw fail('A valid role version is required.');
  if (!reason) throw fail('A deletion reason is required.');
  const input = { id, version, reason };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'roles', recordId: id, action: 'SOFT_DELETE', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    const beforeRow = await roleById(client, id);
    if (!beforeRow || beforeRow.deleted_at) throw fail('Role not found.', 404);
    assertVersion(version, beforeRow.version, 'Role');
    if ((DEPARTMENT_ROLE_OPTIONS[beforeRow.department] || []).some((item) => item.roleKey === beforeRow.role_key || item.role.toLowerCase() === beforeRow.name.toLowerCase())) {
      throw fail(`Built-in role '${beforeRow.name}' cannot be deleted.`, 409);
    }
    const before = mapRole(beforeRow);
    await ensureNoAssignments(client, beforeRow, 'role');
    const saved = await client.query(
      `UPDATE role_catalog SET active=false,deleted_at=now(),deleted_by=$2,delete_reason=$3,
       version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 AND version=$4 RETURNING *`,
      [id, String(req.user.id), reason, version]
    );
    if (!saved.rowCount) throw fail('Role changed concurrently. Refresh and retry.', 409);
    const record = mapRole(saved.rows[0]);
    await audit(client, req, { module: 'roleCatalog', id, label: `${before.department} · ${before.name}`, action: 'SOFT_DELETE', reason, before, after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.json(result.body);
}));

router.post('/departments/:id/restore', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'department');
  const version = versionNumber(req.body?.version);
  const reason = text(req.body?.reason, 1000);
  if (version === null || !reason) throw fail('A valid version and restoration reason are required.');
  const input = { id, version, reason };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'departments', recordId: id, action: 'RESTORE', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    const beforeRow = await departmentById(client, id);
    if (!beforeRow || !beforeRow.deleted_at) throw fail('Deleted department not found.', 404);
    assertVersion(version, beforeRow.version, 'Department');
    const duplicate = await client.query('SELECT 1 FROM department_catalog WHERE lower(name)=lower($1) AND deleted_at IS NULL', [beforeRow.name]);
    const legacyConflict = (await readDepartmentRoleCatalogs(client)).departments.some((record) =>
      record.legacy && normalizeDepartment(record.name).toLowerCase() === normalizeDepartment(beforeRow.name).toLowerCase()
    );
    if (duplicate.rowCount || legacyConflict) throw fail('A department with this name already exists; resolve the conflict before restoring.', 409);
    const saved = await client.query(
      `UPDATE department_catalog SET active=true,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,
       version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *`,
      [id, String(req.user.id), version]
    );
    const record = mapDepartment(saved.rows[0]);
    await audit(client, req, { module: 'departmentCatalog', id, label: record.name, action: 'RESTORE', reason, before: mapDepartment(beforeRow), after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.json(result.body);
}));

router.post('/roles/:id/restore', route(async (req, res) => {
  const id = assertValidId(req.params.id, 'role');
  const version = versionNumber(req.body?.version);
  const reason = text(req.body?.reason, 1000);
  if (version === null || !reason) throw fail('A valid version and restoration reason are required.');
  const input = { id, version, reason };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'roles', recordId: id, action: 'RESTORE', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    const beforeRow = await roleById(client, id);
    if (!beforeRow || !beforeRow.deleted_at) throw fail('Deleted role not found.', 404);
    assertVersion(version, beforeRow.version, 'Role');
    await ensureDepartmentReference(client, beforeRow.department_id, beforeRow.department);
    const duplicate = await client.query(
      `SELECT 1 FROM role_catalog WHERE department_id=$1 AND (lower(name)=lower($2) OR lower(role_key)=lower($3))
       AND deleted_at IS NULL`,
      [beforeRow.department_id, beforeRow.name, beforeRow.role_key]
    );
    const legacyConflict = (await readDepartmentRoleCatalogs(client)).roles.some((record) =>
      record.legacy && record.departmentId === beforeRow.department_id &&
      (record.name.toLowerCase() === beforeRow.name.toLowerCase() || record.roleKey.toLowerCase() === beforeRow.role_key.toLowerCase())
    );
    if (duplicate.rowCount || legacyConflict) throw fail('A role with this name or identifier already exists; resolve the conflict before restoring.', 409);
    const saved = await client.query(
      `UPDATE role_catalog SET active=true,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,
       version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 AND version=$3 RETURNING *`,
      [id, String(req.user.id), version]
    );
    const record = mapRole(saved.rows[0]);
    await audit(client, req, { module: 'roleCatalog', id, label: `${record.department} · ${record.name}`, action: 'RESTORE', reason, before: mapRole(beforeRow), after: record });
    const body = { record };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.json(result.body);
}));

router.get('/role-permissions/:departmentId/:roleId', route(async (req, res) => {
  const departmentId = assertValidId(req.params.departmentId, 'department');
  const roleId = assertValidId(req.params.roleId, 'role');
  const { catalogs, departmentName, roleKey } = await validateRolePair(getPool(), departmentId, roleId);
  const permission = resolveRolePermission(catalogs, departmentId, roleId);
  const dedicated = await getPool().query(
    'SELECT version FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2',
    [departmentId, roleId]
  );
  res.json({
    departmentId, roleId, department: departmentName, roleKey,
    permissions: permission?.permissions || null,
    version: Number(dedicated.rows[0]?.version || 0),
    legacy: Boolean(permission?.legacy)
  });
}));

router.put('/role-permissions/:departmentId/:roleId', route(async (req, res) => {
  const departmentId = assertValidId(req.params.departmentId, 'department');
  const roleId = assertValidId(req.params.roleId, 'role');
  const expectedVersion = versionNumber(req.body?.version);
  const permissions = req.body?.permissions;
  if (expectedVersion === null || !Array.isArray(permissions)) throw fail('A valid version and permission list are required.');
  if (permissions.some((permission) => typeof permission !== 'string' || !ALLOWED_PERMISSION_KEYS.includes(permission))) {
    throw fail('The permission list contains an unknown permission.');
  }
  const uniquePermissions = [...new Set(permissions)];
  const input = { departmentId, roleId, version: expectedVersion, permissions: uniquePermissions };
  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'role-permissions', recordId: `${departmentId}:${roleId}`, action: 'UPDATE', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`role-permissions:${departmentId}:${roleId}`]);
    const { catalogs, departmentName, roleKey } = await validateRolePair(client, departmentId, roleId);
    const before = resolveRolePermission(catalogs, departmentId, roleId);
    const current = await client.query(
      'SELECT * FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2 FOR UPDATE',
      [departmentId, roleId]
    );
    const actualVersion = Number(current.rows[0]?.version || 0);
    assertVersion(expectedVersion, actualVersion, 'Role permissions');
    const after = {
      departmentId, roleId, department: departmentName, roleKey, permissions: uniquePermissions,
      version: actualVersion + 1, legacy: false
    };
    await client.query(
      `INSERT INTO role_permission_catalog(department_id,role_id,department,role_key,permissions,version,updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,1,$6)
       ON CONFLICT(department_id,role_id) DO UPDATE SET department=EXCLUDED.department,role_key=EXCLUDED.role_key,
       permissions=EXCLUDED.permissions,version=role_permission_catalog.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [departmentId, roleId, departmentName, roleKey, JSON.stringify(uniquePermissions), String(req.user.id)]
    );
    await audit(client, req, { module: 'rolePermissions', id: `${departmentId}:${roleId}`, label: `${departmentName} · ${roleKey}`, action: 'UPDATE', before, after });
    const body = { success: true, departmentId, roleId, permissions: uniquePermissions, version: after.version };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.json(result.body);
}));

const permissionIdentityForLegacy = (record, departments, roles) => {
  const departmentId = String(record.departmentId || stableDepartmentId(record.department, departments));
  const roleId = String(record.roleId || stableRoleId(record.department, record.roleKey, roles, departments));
  return permissionAssignmentKey(departmentId, roleId);
};

router.get('/legacy/preview', route(async (_req, res) => {
  const legacy = await readLegacyDepartmentRoleSnapshots();
  const catalogs = await readDepartmentRoleCatalogs();
  const entries = [];
  for (const record of Array.isArray(legacy.departmentCatalog) ? legacy.departmentCatalog : []) {
    const id = departmentRoleLegacyId('department', record);
    const imported = await getPool().query("SELECT id FROM department_catalog WHERE source_key='departmentCatalog' AND legacy_id=$1", [id]);
    const conflict = catalogs.departments.some((item) => item.id === id && !item.legacy) ||
      catalogs.departments.some((item) => !item.legacy && item.name.toLowerCase() === String(record?.name || '').toLowerCase());
    entries.push({ kind: 'department', key: id, record: { ...record, id }, status: imported.rowCount ? 'already-imported' : conflict ? 'conflict' : 'eligible' });
  }
  for (const record of Array.isArray(legacy.roleCatalog) ? legacy.roleCatalog : []) {
    const id = departmentRoleLegacyId('role', record);
    const imported = await getPool().query("SELECT id FROM role_catalog WHERE source_key='roleCatalog' AND legacy_id=$1", [id]);
    const conflict = catalogs.roles.some((item) => item.id === id && !item.legacy) ||
      catalogs.roles.some((item) => !item.legacy && item.department === normalizeDepartment(record?.department) &&
        (item.name.toLowerCase() === String(record?.name || '').toLowerCase() || item.roleKey.toLowerCase() === String(record?.roleKey || '').toLowerCase()));
    entries.push({ kind: 'role', key: id, record: { ...record, id }, status: imported.rowCount ? 'already-imported' : conflict ? 'conflict' : 'eligible' });
  }
  for (const record of Array.isArray(legacy.rolePermissions) ? legacy.rolePermissions : []) {
    const key = permissionIdentityForLegacy(record, catalogs.departments, catalogs.roles);
    const imported = await getPool().query("SELECT 1 FROM role_permission_catalog WHERE source_key='rolePermissions' AND legacy_id=$1", [key]);
    const exists = catalogs.permissions.some((item) => permissionAssignmentKey(item.departmentId, item.roleId) === key && !item.legacy);
    entries.push({ kind: 'permission', key, record, status: imported.rowCount ? 'already-imported' : exists ? 'conflict' : 'eligible' });
  }
  res.json({ entries });
}));

router.post('/legacy/import', route(async (req, res) => {
  const selected = Array.isArray(req.body?.selected) ? req.body.selected : [];
  if (!selected.length) throw fail('Select at least one legacy catalog record to import.');
  const normalizedSelection = [...new Map(selected.filter((item) => item && ['department', 'role', 'permission'].includes(item.kind) && item.key)
    .map((item) => [`${item.kind}:${item.key}`, { kind: item.kind, key: String(item.key) }])).values()];
  if (!normalizedSelection.length) throw fail('Selected legacy catalog records are invalid.');
  const input = { selected: normalizedSelection };
  const imported = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, req, { kind: 'legacy-import', recordId: 'department-role-catalog', action: 'IMPORT', body: input });
    if (claim.replay) return { replay: true, body: claim.response };
    const snapshots = await readLegacyDepartmentRoleSnapshots(client);
    const recordsByKind = {
      department: (Array.isArray(snapshots.departmentCatalog) ? snapshots.departmentCatalog : []).map((record) => ({ ...record, id: departmentRoleLegacyId('department', record) })),
      role: (Array.isArray(snapshots.roleCatalog) ? snapshots.roleCatalog : []).map((record) => ({ ...record, id: departmentRoleLegacyId('role', record) })),
      permission: Array.isArray(snapshots.rolePermissions) ? snapshots.rolePermissions : []
    };
    const bySelection = new Map();
    for (const [kind, records] of Object.entries(recordsByKind)) {
      for (const record of records) {
        const key = kind === 'permission'
          ? permissionIdentityForLegacy(record, (await readDepartmentRoleCatalogs(client)).departments, (await readDepartmentRoleCatalogs(client)).roles)
          : record.id;
        bySelection.set(`${kind}:${key}`, record);
      }
    }
    const toImport = normalizedSelection.map((item) => {
      const record = bySelection.get(`${item.kind}:${item.key}`);
      if (!record) throw fail(`Legacy ${item.kind} record '${item.key}' no longer exists in the preserved snapshot.`, 409);
      return { ...item, record };
    });
    const importedRecords = [];
    for (const item of toImport.filter((entry) => entry.kind === 'department')) {
      const record = item.record;
      const id = assertValidId(record.id, 'department');
      const legacyId = id;
      const existing = await client.query("SELECT id FROM department_catalog WHERE source_key='departmentCatalog' AND legacy_id=$1", [legacyId]);
      if (existing.rowCount) continue;
      const name = text(record.name, 120);
      if (!name || isBuiltInDepartment(name) || normalizeDepartment(name) === 'Admin') throw fail(`Legacy department '${name || id}' is invalid or conflicts with a built-in department.`, 409);
      const duplicate = await client.query('SELECT 1 FROM department_catalog WHERE id=$1 OR lower(name)=lower($2) AND deleted_at IS NULL', [id, name]);
      if (duplicate.rowCount) throw fail(`Legacy department '${name}' conflicts with a PostgreSQL record.`, 409);
      const saved = await client.query(
        `INSERT INTO department_catalog(id,name,active,source_key,legacy_id,created_by,updated_by)
         VALUES($1,$2,$3,'departmentCatalog',$4,$5,$5) RETURNING *`,
        [id, name, record.active !== false, legacyId, String(req.user.id)]
      );
      const output = mapDepartment(saved.rows[0]);
      await audit(client, req, { module: 'departmentCatalog', id, label: name, action: 'LEGACY_IMPORT', reason: 'Admin-selected legacy import.', after: output });
      importedRecords.push({ kind: item.kind, record: output });
    }
    for (const item of toImport.filter((entry) => entry.kind === 'role')) {
      const record = item.record;
      const id = assertValidId(record.id, 'role');
      const legacyId = id;
      const existing = await client.query("SELECT id FROM role_catalog WHERE source_key='roleCatalog' AND legacy_id=$1", [legacyId]);
      if (existing.rowCount) continue;
      const department = normalizeDepartment(record.department);
      const name = text(record.name, 120);
      const roleKey = text(record.roleKey, 100).toLowerCase();
      const catalogs = await readDepartmentRoleCatalogs(client);
      const departmentId = record.departmentId || stableDepartmentId(department, catalogs.departments);
      if (!name || !roleKey || !department) throw fail(`Legacy role '${id}' is missing its department, name, or role key.`, 409);
      await ensureDepartmentReference(client, departmentId, department);
      if ((DEPARTMENT_ROLE_OPTIONS[department] || []).some((role) => role.roleKey === roleKey || role.role.toLowerCase() === name.toLowerCase())) {
        throw fail(`Legacy role '${name}' conflicts with a built-in role.`, 409);
      }
      const duplicate = await client.query(
        `SELECT 1 FROM role_catalog WHERE id=$1 OR (department_id=$2 AND (lower(name)=lower($3) OR lower(role_key)=lower($4)) AND deleted_at IS NULL)`,
        [id, departmentId, name, roleKey]
      );
      if (duplicate.rowCount) throw fail(`Legacy role '${name}' conflicts with a PostgreSQL role.`, 409);
      const saved = await client.query(
        `INSERT INTO role_catalog(id,department_id,department,name,role_key,active,source_key,legacy_id,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,'roleCatalog',$7,$8,$8) RETURNING *`,
        [id, departmentId, department, name, roleKey, record.active !== false, legacyId, String(req.user.id)]
      );
      const output = mapRole(saved.rows[0]);
      await audit(client, req, { module: 'roleCatalog', id, label: `${department} · ${name}`, action: 'LEGACY_IMPORT', reason: 'Admin-selected legacy import.', after: output });
      importedRecords.push({ kind: item.kind, record: output });
    }
    for (const item of toImport.filter((entry) => entry.kind === 'permission')) {
      const record = item.record;
      const catalogs = await readDepartmentRoleCatalogs(client);
      const key = permissionIdentityForLegacy(record, catalogs.departments, catalogs.roles);
      const [departmentId, roleId] = key.split('::');
      const legacyId = key;
      const existing = await client.query("SELECT 1 FROM role_permission_catalog WHERE source_key='rolePermissions' AND legacy_id=$1", [legacyId]);
      if (existing.rowCount) continue;
      const valid = await validateRolePair(client, departmentId, roleId);
      if (!Array.isArray(record.permissions) || record.permissions.some((permission) => !ALLOWED_PERMISSION_KEYS.includes(permission))) {
        throw fail(`Legacy permissions '${key}' contain invalid permission identifiers.`, 409);
      }
      if (resolveRolePermission(valid.catalogs, departmentId, roleId) && !resolveRolePermission(valid.catalogs, departmentId, roleId).legacy) {
        throw fail(`Legacy permissions '${key}' conflict with a PostgreSQL permission record.`, 409);
      }
      const permissions = [...new Set(record.permissions)];
      const saved = await client.query(
        `INSERT INTO role_permission_catalog(department_id,role_id,department,role_key,permissions,version,source_key,legacy_id,updated_by)
         VALUES($1,$2,$3,$4,$5::jsonb,1,'rolePermissions',$6,$7)
         ON CONFLICT(department_id,role_id) DO NOTHING RETURNING *`,
        [departmentId, roleId, valid.departmentName, valid.roleKey, JSON.stringify(permissions), legacyId, String(req.user.id)]
      );
      if (!saved.rowCount) throw fail(`Legacy permissions '${key}' conflict with a PostgreSQL permission record.`, 409);
      const output = {
        departmentId, roleId, department: valid.departmentName, roleKey: valid.roleKey,
        permissions, version: 1
      };
      await audit(client, req, { module: 'rolePermissions', id: key, label: `${valid.departmentName} · ${valid.roleKey}`, action: 'LEGACY_IMPORT', reason: 'Admin-selected legacy import.', after: output });
      importedRecords.push({ kind: item.kind, record: output });
    }
    if (!importedRecords.length) throw fail('The selected catalog records were already imported.', 409);
    const body = { imported: importedRecords, legacySnapshotPreserved: true };
    await completeIdempotency(client, claim.token, body);
    return { replay: false, body };
  });
  res.status(imported.replay ? 200 : 201).json(imported.body);
}));

export default router;
