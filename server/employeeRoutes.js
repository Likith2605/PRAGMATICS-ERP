import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole, normalizeDepartment, validateEmployeeAssignments, DEPARTMENT_ROLE_OPTIONS } from './departmentAccess.js';
import { getLegacyEmployeeRecords, employeeDirectoryReferences, employeeRecordFromRow, publicEmployee } from './employeeStore.js';
import { hashEmployeePassword, hashLegacyEmployeePassword } from './employeeCredentials.js';
import { validateEmployeeCatalogAssignments } from './departmentRoleCatalogStore.js';

const router = express.Router();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const employeePasswordError = (password) => {
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter (A-Z).';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter (a-z).';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one numeric digit (0-9).';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) return 'Password must contain at least one special character.';
  return '';
};
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const requestHash = (body) => createHash('sha256').update(stableStringify(body)).digest('hex');
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const requireEmployeeView = (req, res, next) => {
  if (isAdmin(req) || hasPermissionForRole(req.user?.roleKey, 'employee.view', req.user?.rolePermissions)) return next();
  return res.status(403).json({ error: 'Your selected department role does not allow employee directory access.' });
};
const requireEmployeePicker = (req, res, next) => {
  const permissions = ['employee.view', 'production.view', 'job_card.create', 'job_card.update_progress', 'production.qc.manage',
    'store.module', 'material_issue.create', 'material_issue.confirm', 'material_return.create', 'material_return.view'];
  if (isAdmin(req) || hasPermissionForRole(req.user?.roleKey, permissions, req.user?.rolePermissions)) return next();
  return res.status(403).json({ error: 'Your selected department role does not allow employee selection.' });
};
const tokenFrom = (req) => text(req.body?.idempotencyToken || req.body?.createToken || req.get('idempotency-key'), 120);
const requireToken = (req) => {
  const token = tokenFrom(req);
  if (!TOKEN_PATTERN.test(token)) throw Object.assign(new Error('A valid idempotency token is required.'), { status: 400 });
  return token;
};
const audit = async (client, req, employee, action, reason, before, after) => client.query(
  `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES ($1,$2,$3,'employees',$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
  [req.user.id, req.user.email, req.user.role, employee.employeeId, employee.name, action, text(reason, 1000),
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const claimToken = async (client, token, action, recordId, hash) => {
  const inserted = await client.query(
    `INSERT INTO master_idempotency(token,kind,record_id,action,request_hash,response)
     VALUES($1,'employees',$2,$3,$4,'{}'::jsonb) ON CONFLICT(token) DO NOTHING RETURNING token`,
    [token, String(recordId), action, hash]
  );
  if (inserted.rowCount) return { replay: false };
  const prior = await client.query('SELECT request_hash,response FROM master_idempotency WHERE token=$1', [token]);
  if (prior.rows[0]?.request_hash !== hash) throw Object.assign(new Error('This idempotency token was used for a different request.'), { status: 409 });
  return { replay: true, response: prior.rows[0].response };
};
const completeToken = (client, token, response) => client.query(
  'UPDATE master_idempotency SET response=$2::jsonb WHERE token=$1',
  [token, JSON.stringify(safeAuditValues(response))]
);

const assignmentError = (employee) => {
  return validateEmployeeAssignments(employee);
};

const validateAssignmentCatalogs = async (employee, executor, existingEmployee = null) => {
  const validationError = assignmentError(employee);
  if (validationError) return validationError;
  return validateEmployeeCatalogAssignments(employee, executor, existingEmployee);
};

const isManagedEmployee = (employee, req) => {
  if (employee.payload?.serverManaged === true || ['admin', 'administrator'].includes(String(employee.roleKey || '').toLowerCase()) ||
      String(employee.role || '').toLowerCase() === 'administrator' || String(employee.id) === 'admin') return true;
  const identities = [employee.id, employee.employeeId, employee.email].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  const actor = [req.user?.id, req.user?.employeeId, req.user?.email].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  return actor.some((identity) => identities.includes(identity));
};

const normalizeEmployee = (input, existing = {}) => {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = text(data.id || existing.id || `emp-${randomUUID()}`, 120);
  const employeeId = text(data.employeeId ?? existing.employeeId, 120).toUpperCase();
  const name = text(data.name ?? existing.name, 240);
  const email = text(data.email ?? existing.email, 320).toLowerCase();
  if (!ID_PATTERN.test(id)) throw Object.assign(new Error('Invalid employee record ID.'), { status: 400 });
  if (!ID_PATTERN.test(employeeId)) throw Object.assign(new Error('A valid Employee ID is required.'), { status: 400 });
  if (!name) throw Object.assign(new Error('Employee name is required.'), { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Enter a valid email address or leave it blank.'), { status: 400 });
  const assignments = Array.isArray(data.departmentAssignments)
    ? data.departmentAssignments.map((assignment) => ({
      department: normalizeDepartment(assignment?.department),
      role: text(assignment?.role, 120),
      roleKey: text(assignment?.roleKey, 100).toLowerCase(),
      ...(assignment?.departmentId ? { departmentId: text(assignment.departmentId, 120) } : {}),
      ...(assignment?.roleId ? { roleId: text(assignment.roleId, 120) } : {})
    }))
    : existing.departmentAssignments || [];
  const firstAssignment = assignments[0] || {};
  const protectedKeys = /password|token|secret|credential/i;
  const payload = Object.fromEntries(Object.entries({ ...(existing.payload || {}), ...data }).filter(([key]) =>
    !protectedKeys.test(key) && !['id', 'employeeId', 'name', 'email', 'active', 'department', 'role', 'roleKey', 'mobile', 'designation', 'joinedDate', 'departmentAssignments', 'version', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'deleteReason', 'hasLoginPassword', 'reason', 'deactivationReason', 'deactivatedAt'].includes(key)
  ));
  return {
    id,
    employeeId,
    name,
    email,
    active: data.active === undefined ? existing.active !== false : Boolean(data.active),
    department: firstAssignment.department || normalizeDepartment(data.department ?? existing.department),
    role: firstAssignment.role || text(data.role ?? existing.role, 120),
    roleKey: firstAssignment.roleKey || text(data.roleKey ?? existing.roleKey, 100).toLowerCase(),
    mobile: text(data.mobile ?? existing.mobile, 80),
    designation: text(data.designation ?? existing.designation, 160),
    joinedDate: text(data.joinedDate ?? existing.joinedDate, 20),
    departmentAssignments: assignments,
    payload
  };
};

const auditView = (employee) => publicEmployee(employee);
const databaseRecord = (row) => employeeRecordFromRow(row);
const legacyIdentity = (employee) => text(employee?.id || employee?.employeeId, 120);

router.get('/', requireEmployeeView, async (req, res) => {
  const includeDeleted = isAdmin(req) && req.query.includeDeleted === '1';
  const result = await getPool().query(
    `SELECT * FROM employees ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY lower(name), lower(employee_id)`
  );
  res.json({ records: result.rows.map(databaseRecord) });
});

router.get('/directory', requireEmployeePicker, async (_req, res) => {
  const employees = await employeeDirectoryReferences();
  res.json({
    employees: employees.map(({ id, employeeId, name, department, designation, mobile }) => ({
      id, employeeId, name, department, designation, mobile
    }))
  });
});

router.get('/legacy/preview', requireAdmin, async (_req, res) => {
  const [legacy, current] = await Promise.all([
    getLegacyEmployeeRecords(),
    getPool().query('SELECT id,employee_id,email FROM employees')
  ]);
  const existing = new Set(current.rows.flatMap((row) => [row.id, row.employee_id, row.email].filter(Boolean).map((value) => String(value).toLowerCase())));
  const entries = legacy.map((employee) => {
    const identity = legacyIdentity(employee);
    const duplicated = [identity, employee?.employeeId, employee?.email].filter(Boolean).some((value) => existing.has(String(value).toLowerCase()));
    return {
      key: identity,
      employee: auditView(employee),
      status: duplicated ? 'already-imported' : 'eligible'
    };
  });
  res.json({ entries });
});

router.post('/legacy/import', requireAdmin, async (req, res) => {
  const selected = Array.isArray(req.body?.selected) ? [...new Set(req.body.selected.map((value) => text(value, 120)).filter(Boolean))] : [];
  if (!selected.length || selected.some((id) => !ID_PATTERN.test(id))) return res.status(400).json({ error: 'Select one or more valid legacy employee IDs.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const token = requireToken(req);
    const claimed = await claimToken(client, token, 'IMPORT', selected.join(','), requestHash({ selected }));
    if (claimed.replay) {
      await client.query('COMMIT');
      return res.json(claimed.response);
    }
    const legacy = await getLegacyEmployeeRecords(client);
    const imported = [];
    for (const key of selected) {
      const source = legacy.find((employee) => legacyIdentity(employee) === key);
      if (!source) throw Object.assign(new Error(`Legacy employee '${key}' was not found.`), { status: 404 });
      const employee = normalizeEmployee(source);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-assignment-catalog'))");
      const validationError = await validateAssignmentCatalogs(employee, client);
      if (validationError) throw Object.assign(new Error(`${employee.employeeId}: ${validationError}`), { status: 400 });
      if (isManagedEmployee(employee, req)) throw Object.assign(new Error('The server-managed Administrator account cannot be imported.'), { status: 409 });
      if (employee.email && !source.password) throw Object.assign(new Error(`${employee.employeeId}: a login password is required before importing this account.`), { status: 400 });
      const passwordHash = source.password ? await hashLegacyEmployeePassword(source.password) : '';
      const row = await client.query(
        `INSERT INTO employees(id,employee_id,name,email,password_hash,active,department,role,role_key,mobile,designation,joined_date,department_assignments,payload,version,source_key,legacy_id,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,1,'erp_state/employees',$15,$16,$16)
         RETURNING *`,
        [employee.id || `emp-${randomUUID()}`, employee.employeeId, employee.name, employee.email, passwordHash, employee.active, employee.department, employee.role, employee.roleKey,
          employee.mobile, employee.designation, employee.joinedDate, JSON.stringify(employee.departmentAssignments), JSON.stringify(employee.payload), key, req.user.id]
      );
      const record = databaseRecord(row.rows[0]);
      await audit(client, req, record, 'IMPORT', 'Administrator selected legacy employee import.', null, auditView(record));
      imported.push(auditView(record));
    }
    const response = { imported };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.status(201).json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Employee ID or login email conflicts with an existing employee.' });
    throw error;
  } finally {
    client.release();
  }
});

router.get('/:employeeId/history', requireAdmin, async (req, res) => {
  const identity = text(req.params.employeeId, 120);
  const employee = await getPool().query('SELECT employee_id FROM employees WHERE id=$1 OR lower(employee_id)=lower($1) LIMIT 1', [identity]);
  const employeeId = employee.rows[0]?.employee_id || identity;
  const result = await getPool().query(
    `SELECT id,user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values,created_at
     FROM erp_audit_log WHERE module='employees' AND record_id=$1 ORDER BY created_at DESC LIMIT 200`,
    [employeeId]
  );
  res.json({ entries: result.rows });
});

router.get('/:employeeId', requireEmployeeView, async (req, res) => {
  const deletedFilter = isAdmin(req) ? '' : ' AND deleted_at IS NULL';
  const result = await getPool().query(
    `SELECT * FROM employees WHERE (id=$1 OR lower(employee_id)=lower($1))${deletedFilter} LIMIT 1`,
    [text(req.params.employeeId, 120)]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  return res.json({ record: databaseRecord(result.rows[0]) });
});

router.post('/', requireAdmin, async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const employee = normalizeEmployee(req.body?.data || req.body);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-assignment-catalog'))");
    const validationError = await validateAssignmentCatalogs(employee, client);
    if (validationError) { await client.query('ROLLBACK'); return res.status(400).json({ error: validationError }); }
    if (isManagedEmployee(employee, req)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The server-managed Administrator account cannot be created in Employee Master.' }); }
    const password = String(req.body?.data?.password ?? req.body?.password ?? '');
    if (password.length > 256) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Password cannot exceed 256 characters.' }); }
    if (employee.email && !password) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Login Password is required when a Login ID (email) is provided.' }); }
    if (password) {
      const passwordError = employeePasswordError(password);
      if (passwordError) { await client.query('ROLLBACK'); return res.status(400).json({ error: passwordError }); }
    }
    const token = requireToken(req);
    const hash = requestHash({ ...req.body, data: { ...(req.body?.data || req.body), password: password ? '[provided]' : '' } });
    const claimed = await claimToken(client, token, 'CREATE', employee.id, hash);
    if (claimed.replay) {
      await client.query('COMMIT');
      return res.json(claimed.response);
    }
    const passwordHash = password ? await hashEmployeePassword(password) : '';
    const row = await client.query(
      `INSERT INTO employees(id,employee_id,name,email,password_hash,active,department,role,role_key,mobile,designation,joined_date,department_assignments,payload,create_token,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$16) RETURNING *`,
      [employee.id, employee.employeeId, employee.name, employee.email, passwordHash, employee.active, employee.department, employee.role, employee.roleKey, employee.mobile, employee.designation, employee.joinedDate,
        JSON.stringify(employee.departmentAssignments), JSON.stringify(employee.payload), token, req.user.id]
    );
    const record = databaseRecord(row.rows[0]);
    await audit(client, req, record, 'CREATE', '', null, auditView(record));
    const response = { record: auditView(record) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.status(201).json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Employee ID or login email conflicts with an existing employee.' });
    throw error;
  } finally {
    client.release();
  }
});

router.put('/:employeeId', requireAdmin, async (req, res) => {
  const id = text(req.params.employeeId, 120);
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'The PostgreSQL employee version last read is required.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM employees WHERE id=$1 OR lower(employee_id)=lower($1) FOR UPDATE', [id]);
    if (!locked.rowCount || locked.rows[0].deleted_at) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active employee not found.' }); }
    const before = databaseRecord(locked.rows[0]);
    if (Number(before.version) !== version) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Employee was updated by another user. Refresh and retry.', current: auditView(before) }); }
    if (before.payload?.serverManaged === true || ['admin', 'administrator'].includes(String(before.roleKey).toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The server-managed Administrator account cannot be changed in Employee Master.' });
    }
    const employee = normalizeEmployee(req.body?.data || req.body, before);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-assignment-catalog'))");
    const validationError = await validateAssignmentCatalogs(employee, client, before);
    if (validationError) { await client.query('ROLLBACK'); return res.status(400).json({ error: validationError }); }
    if (isManagedEmployee(before, req)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The server-managed Administrator account cannot be changed in Employee Master.' }); }
    const password = String(req.body?.data?.password ?? req.body?.password ?? '');
    if (password.length > 256) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Password cannot exceed 256 characters.' }); }
    if (employee.email && !password && !before.hasLoginPassword) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Login Password is required when a Login ID (email) is provided.' }); }
    if (password) {
      const passwordError = employeePasswordError(password);
      if (passwordError) { await client.query('ROLLBACK'); return res.status(400).json({ error: passwordError }); }
    }
    const changeReason = text(req.body?.data?.reason || req.body?.reason, 1000);
    if (before.active !== false && !employee.active && !changeReason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A reason is required to deactivate an employee.' });
    }
    const token = requireToken(req);
    const hash = requestHash({ ...req.body, data: { ...(req.body?.data || req.body), password: password ? '[provided]' : '' } });
    const claimed = await claimToken(client, token, 'UPDATE', before.id, hash);
    if (claimed.replay) {
      await client.query('COMMIT');
      return res.json(claimed.response);
    }
    const passwordHash = password ? await hashEmployeePassword(password) : locked.rows[0].password_hash;
    const updated = await client.query(
      `UPDATE employees SET employee_id=$2,name=$3,email=$4,password_hash=$5,active=$6,department=$7,role=$8,role_key=$9,mobile=$10,designation=$11,joined_date=$12,department_assignments=$13::jsonb,payload=$14::jsonb,version=version+1,updated_by=$15,updated_at=now()
       WHERE id=$1 AND version=$16 AND deleted_at IS NULL RETURNING *`,
      [before.id, employee.employeeId, employee.name, employee.email, passwordHash, employee.active, employee.department, employee.role, employee.roleKey, employee.mobile, employee.designation, employee.joinedDate,
        JSON.stringify(employee.departmentAssignments), JSON.stringify(employee.payload), req.user.id, version]
    );
    if (!updated.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Employee was updated by another user. Refresh and retry.' }); }
    const record = databaseRecord(updated.rows[0]);
    await audit(client, req, record, before.active !== false && !employee.active ? 'CONTROLLED_STATUS_CHANGE' : 'UPDATE', changeReason, auditView(before), auditView(record));
    if (before.active !== false && !employee.active) {
      await client.query('UPDATE erp_sessions SET revoked_at=now() WHERE lower(email)=lower($1) AND revoked_at IS NULL', [before.email]);
    }
    const response = { record: auditView(record) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Employee ID or login email conflicts with an existing employee.' });
    throw error;
  } finally {
    client.release();
  }
});

router.delete('/:employeeId', requireAdmin, async (req, res) => {
  const id = text(req.params.employeeId, 120);
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason, 1000);
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'The PostgreSQL employee version last read is required.' });
  if (!reason) return res.status(400).json({ error: 'A deletion reason is required.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM employees WHERE id=$1 OR lower(employee_id)=lower($1) FOR UPDATE', [id]);
    if (!locked.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found.' }); }
    const before = databaseRecord(locked.rows[0]);
    if (before.deletedAt) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Employee is already deleted.' }); }
    if (before.version !== version) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Employee was updated by another user. Refresh and retry.', current: auditView(before) }); }
    if (isManagedEmployee(before, req)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The server-managed Administrator account cannot be deleted.' }); }
    const token = requireToken(req);
    const claimed = await claimToken(client, token, 'SOFT_DELETE', before.id, requestHash(req.body));
    if (claimed.replay) { await client.query('COMMIT'); return res.json(claimed.response); }
    const updated = await client.query(
      `UPDATE employees SET active=false,deleted_at=now(),deleted_by=$2,delete_reason=$3,deleted_was_active=active,version=version+1,updated_by=$2,updated_at=now()
       WHERE id=$1 AND version=$4 RETURNING *`,
      [before.id, req.user.id, reason, version]
    );
    const record = databaseRecord(updated.rows[0]);
    await client.query('UPDATE erp_sessions SET revoked_at=now() WHERE lower(email)=lower($1) AND revoked_at IS NULL', [before.email]);
    await audit(client, req, record, 'SOFT_DELETE', reason, auditView(before), auditView(record));
    const response = { record: auditView(record) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  } finally {
    client.release();
  }
});

router.post('/:employeeId/restore', requireAdmin, async (req, res) => {
  const id = text(req.params.employeeId, 120);
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason, 1000);
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'The PostgreSQL employee version last read is required.' });
  if (!reason) return res.status(400).json({ error: 'A restoration reason is required.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM employees WHERE id=$1 OR lower(employee_id)=lower($1) FOR UPDATE', [id]);
    if (!locked.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Employee not found.' }); }
    const before = databaseRecord(locked.rows[0]);
    if (!before.deletedAt) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Employee is not deleted.' }); }
    if (before.version !== version) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Employee was updated by another user. Refresh and retry.', current: auditView(before) }); }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-assignment-catalog'))");
    const validationError = await validateAssignmentCatalogs(before, client);
    if (validationError) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Employee dependencies are no longer valid: ${validationError}` }); }
    if (isManagedEmployee(before, req)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The server-managed Administrator account cannot be restored.' }); }
    const token = requireToken(req);
    const claimed = await claimToken(client, token, 'RESTORE', before.id, requestHash(req.body));
    if (claimed.replay) { await client.query('COMMIT'); return res.json(claimed.response); }
    const updated = await client.query(
      `UPDATE employees SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,active=COALESCE(deleted_was_active,true),deleted_was_active=NULL,version=version+1,updated_by=$2,updated_at=now()
       WHERE id=$1 AND version=$3 RETURNING *`,
      [before.id, req.user.id, version]
    );
    const record = databaseRecord(updated.rows[0]);
    await audit(client, req, record, 'RESTORE', reason, auditView(before), auditView(record));
    const response = { record: auditView(record) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Employee ID or login email conflicts with an existing employee.' });
    throw error;
  } finally {
    client.release();
  }
});

export default router;
