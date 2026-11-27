import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing Employee Master tests outside vyavastha_test.');
}
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const databaseIdentity = await pool.query('SELECT current_database() AS name');
if (databaseIdentity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing Employee Master test writes: current_database() is not exactly vyavastha_test.');
}

const port = 3447;
const base = `http://127.0.0.1:${port}`;
const childEnv = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port), QC_PULL_ENABLED: '0' };
delete childEnv.DATABASE_URL;
const server = spawn(process.execPath, ['server.js'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (path, { token, department, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(department ? { 'x-erp-department': department } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
const employeeId = `EMP-T-${suffix}`;
const employeeRecordId = `employee-test-${suffix}`;
const employeeEmail = `employee-${suffix}@example.test`;
const initialPassword = `Emp-${suffix}-One!`;
const updatedPassword = `Emp-${suffix}-Two!`;
const secondEmployeeId = `EMP-V-${suffix}`;
const secondRecordId = `employee-view-${suffix}`;
const secondEmail = `view-${suffix}@example.test`;
const secondPassword = `View-${suffix}-Pass!`;
const legacyEmployeeId = `EMP-L-${suffix}`;
const legacyRecordId = `employee-legacy-${suffix}`;
const legacyEmail = `legacy-${suffix}@example.test`;
const legacyPassword = `Legacy-${suffix}-Pass!`;
const createdIds = [];
const tokens = [];
let originalLegacy = null;
let legacyFixtureWritten = false;
let serverSpawned = true;
let adminToken = '';

const employeeData = ({ id, employeeId: number, name, email = '', password = '', assignments, active = true }) => ({
  id,
  employeeId: number,
  name,
  email,
  password,
  mobile: '5550100',
  designation: 'Test Employee',
  active,
  department: assignments[0].department,
  role: assignments[0].role,
  roleKey: assignments[0].roleKey,
  departmentAssignments: assignments
});
const salesAndStoreAssignments = [
  { department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' },
  { department: 'Store Department', role: 'Store Employee', roleKey: 'store_employee' }
];
const storeAssignments = [{ department: 'Store Department', role: 'Store Employee', roleKey: 'store_employee' }];
const noSecrets = (value) => {
  assert.equal(Object.hasOwn(value || {}, 'password'), false);
  assert.equal(Object.hasOwn(value || {}, 'passwordHash'), false);
  assert.equal(Object.hasOwn(value || {}, 'password_hash'), false);
};
const create = async (data, createToken = `employee-create-${randomUUID()}`, token = adminToken) => {
  tokens.push(createToken);
  return request('/api/employees', { token, ...json('POST', { data, createToken }) });
};
const login = async (email, password) => {
  const result = await request('/api/auth/login', json('POST', { email, password, portal: 'employee' }));
  return result;
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await fetch(`${base}/api/health`);
      const body = await health.json();
      if (body.ready && body.database?.migrations?.some((migration) => migration.version === '048_employee_master')) {
        ready = true;
        break;
      }
    } catch { /* wait for isolated server startup */ }
    await sleep(250);
  }
  assert.ok(ready, 'isolated PostgreSQL server starts with migration 048 applied');

  const adminLogin = await request('/api/auth/login', json('POST', {
    email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin'
  }));
  assert.equal(adminLogin.status, 200, 'server-configured Admin login remains functional');
  adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  const original = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='employees'");
  originalLegacy = original.rowCount ? original.rows[0] : null;
  const previousLegacy = Array.isArray(originalLegacy?.data) ? originalLegacy.data : [];
  assert.ok(Array.isArray(previousLegacy), 'legacy employee source is preserved as a list');
  const legacyFixture = employeeData({
    id: legacyRecordId,
    employeeId: legacyEmployeeId,
    name: 'Selected Legacy Employee',
    email: legacyEmail,
    password: legacyPassword,
    assignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  });
  await pool.query(
    `INSERT INTO erp_state(storage_key,data,updated_at) VALUES('employees',$1::jsonb,now())
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([...previousLegacy, legacyFixture])]
  );
  legacyFixtureWritten = true;

  assert.equal((await request('/api/employees')).status, 401, 'employee list requires authentication');
  assert.equal((await request('/api/employees/legacy/preview', { token: 'invalid' })).status, 401, 'legacy preview requires an authenticated Admin');
  assert.equal((await request('/api/state/employees', { token: adminToken })).status, 400, 'generic employee reads are rejected');
  assert.equal((await request('/api/state/employees', { token: adminToken, ...json('PUT', { data: [] }) })).status, 400, 'generic employee writes are rejected');
  assert.equal((await request('/api/state', { token: adminToken, ...json('PUT', { records: { employees: [] } }) })).status, 400, 'whole-state sync rejects the employee key');

  const createdData = employeeData({
    id: employeeRecordId,
    employeeId,
    name: 'PostgreSQL Employee Test',
    email: employeeEmail,
    password: initialPassword,
    assignments: salesAndStoreAssignments
  });
  const createToken = `employee-create-${suffix}`;
  tokens.push(createToken);
  const created = await request('/api/employees', { token: adminToken, ...json('POST', { data: createdData, createToken }) });
  assert.equal(created.status, 201, `${created.body.error || 'employee create succeeds'}\n${serverOutput}`);
  createdIds.push(employeeRecordId);
  assert.equal(created.body.record.version, 1);
  assert.deepEqual(created.body.record.departmentAssignments.map((item) => item.department), ['Sales Department', 'Store Department']);
  noSecrets(created.body.record);
  assert.equal(JSON.stringify(created.body).includes(initialPassword), false, 'create response never includes the submitted password');
  const retry = await request('/api/employees', { token: adminToken, ...json('POST', { data: createdData, createToken }) });
  assert.equal(retry.status, 200, 'duplicate create request replays its idempotent response');
  assert.equal(retry.body.record.id, employeeRecordId);
  assert.equal((await pool.query('SELECT password_hash FROM employees WHERE id=$1', [employeeRecordId])).rows[0].password_hash.startsWith('scrypt$'), true, 'new passwords are persisted as scrypt hashes');

  const legacyPreview = await request('/api/employees/legacy/preview', { token: adminToken });
  assert.equal(legacyPreview.status, 200);
  const previewEntry = legacyPreview.body.entries.find((entry) => entry.key === legacyRecordId);
  assert.equal(previewEntry?.status, 'eligible');
  noSecrets(previewEntry?.employee);
  assert.equal(JSON.stringify(previewEntry).includes(legacyPassword), false, 'legacy preview never returns passwords');
  const selectedImport = await request('/api/employees/legacy/import', { token: adminToken, ...json('POST', {
    selected: [legacyRecordId],
    idempotencyToken: `employee-import-${suffix}`
  }) });
  tokens.push(`employee-import-${suffix}`);
  assert.equal(selectedImport.status, 201, selectedImport.body.error || 'selected legacy import succeeds');
  createdIds.push(legacyRecordId);
  noSecrets(selectedImport.body.imported[0]);
  const legacyLogin = await login(legacyEmail, legacyPassword);
  assert.equal(legacyLogin.status, 200, 'imported legacy employee can still log in');
  assert.ok((await pool.query('SELECT password_hash FROM employees WHERE id=$1', [legacyRecordId])).rows[0].password_hash.startsWith('scrypt$'));
  const afterImport = await pool.query("SELECT data FROM erp_state WHERE storage_key='employees'");
  assert.ok(afterImport.rows[0].data.some((employee) => employee.id === legacyRecordId), 'selected import leaves the legacy snapshot intact');

  const primaryLogin = await login(employeeEmail, initialPassword);
  assert.equal(primaryLogin.status, 200, 'new Employee Master credentials authenticate');
  const primaryToken = primaryLogin.body.token;
  assert.equal((await request('/api/employees', { token: primaryToken })).status, 403, 'Sales Employee role cannot read the employee directory');
  assert.equal((await request('/api/employees/directory', { token: primaryToken })).status, 403, 'employee picker access is denied without an applicable workflow permission');
  const switched = await request('/api/employees', { token: primaryToken, department: 'Store Department' });
  assert.equal(switched.status, 200, 'assigned Store role can read the employee directory');
  const picker = await request('/api/employees/directory', { token: primaryToken, department: 'Store Department' });
  assert.equal(picker.status, 200, 'Store employee picker access is permitted for its workflow role');
  assert.ok(picker.body.employees.some((record) => record.id === employeeRecordId), `picker includes the active PostgreSQL employee: ${JSON.stringify(picker.body.employees)}`);
  assert.equal(JSON.stringify(picker.body.employees).includes(employeeEmail), false, 'picker response contains no login email or password');
  const listedPrimary = switched.body.records.find((record) => record.id === employeeRecordId);
  assert.ok(listedPrimary, 'another department sees the shared PostgreSQL employee record');
  noSecrets(listedPrimary);
  const references = await request('/api/masters/references', { token: primaryToken, department: 'Store Department' });
  assert.equal(references.status, 200);
  assert.ok(references.body.employees.some((record) => record.id === employeeRecordId), 'employee selectors use PostgreSQL-backed master references');
  assert.equal(JSON.stringify(references.body.employees).includes(initialPassword), false);
  assert.equal((await request('/api/employees', { token: legacyLogin.body.token })).status, 403, 'non-directory roles cannot read employees');
  assert.equal((await request('/api/employees', { method: 'POST', token: primaryToken, ...json('POST', { data: createdData, createToken: `non-admin-${suffix}` }) })).status, 403, 'employee CRUD writes remain Admin-only');
  assert.equal((await request('/api/employees/legacy/preview', { token: primaryToken })).status, 403, 'legacy reconciliation is Admin-only');

  const duplicateId = employeeData({
    id: `duplicate-${suffix}`,
    employeeId,
    name: 'Duplicate Employee ID',
    assignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  });
  const duplicate = await create(duplicateId);
  assert.equal(duplicate.status, 409, 'duplicate employee IDs are rejected');
  const duplicateEmail = employeeData({
    id: `duplicate-email-${suffix}`,
    employeeId: `EMP-D-${suffix}`,
    name: 'Duplicate Login Email',
    email: employeeEmail,
    password: initialPassword,
    assignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  });
  assert.equal((await create(duplicateEmail)).status, 409, 'duplicate employee login emails are rejected');

  const secondData = employeeData({
    id: secondRecordId,
    employeeId: secondEmployeeId,
    name: 'Directory Viewer Test',
    email: secondEmail,
    password: secondPassword,
    assignments: storeAssignments
  });
  const secondCreated = await create(secondData);
  assert.equal(secondCreated.status, 201, secondCreated.body.error || 'second employee create succeeds');
  createdIds.push(secondRecordId);
  const secondLogin = await login(secondEmail, secondPassword);
  assert.equal(secondLogin.status, 200);
  const crossUserList = await request('/api/employees', { token: secondLogin.body.token });
  assert.equal(crossUserList.status, 200);
  assert.ok(crossUserList.body.records.some((record) => record.id === employeeRecordId), 'a separate authorized account sees the same shared employee data');

  const version = secondCreated.body.record.version;
  const competingUpdates = await Promise.all([
    request(`/api/employees/${encodeURIComponent(secondRecordId)}`, { token: adminToken, ...json('PUT', { data: { name: 'Concurrent Winner A' }, version, idempotencyToken: `employee-edit-a-${suffix}` }) }),
    request(`/api/employees/${encodeURIComponent(secondRecordId)}`, { token: adminToken, ...json('PUT', { data: { name: 'Concurrent Winner B' }, version, idempotencyToken: `employee-edit-b-${suffix}` }) })
  ]);
  tokens.push(`employee-edit-a-${suffix}`, `employee-edit-b-${suffix}`);
  assert.deepEqual(competingUpdates.map((result) => result.status).sort(), [200, 409], 'concurrent edits permit one versioned update and reject the stale writer');
  const updatedSecond = competingUpdates.find((result) => result.status === 200).body.record;
  const staleUpdate = await request(`/api/employees/${encodeURIComponent(secondRecordId)}`, { token: adminToken, ...json('PUT', { data: { name: 'Stale Update' }, version, idempotencyToken: `employee-stale-${suffix}` }) });
  assert.equal(staleUpdate.status, 409, 'stale version is rejected');
  tokens.push(`employee-stale-${suffix}`);
  noSecrets(updatedSecond);

  const changed = await request(`/api/employees/${encodeURIComponent(employeeRecordId)}`, { token: adminToken, ...json('PUT', {
    data: { password: updatedPassword },
    version: created.body.record.version,
    idempotencyToken: `employee-password-${suffix}`
  }) });
  tokens.push(`employee-password-${suffix}`);
  assert.equal(changed.status, 200, changed.body.error || 'employee password update succeeds without exposing the previous hash');
  noSecrets(changed.body.record);
  assert.equal((await login(employeeEmail, initialPassword)).status, 401, 'old password stops authenticating after password update');
  const updatedLogin = await login(employeeEmail, updatedPassword);
  assert.equal(updatedLogin.status, 200, 'updated password authenticates');

  const pageSource = await readFile(new URL('../src/pages/EmployeeMasterPage.jsx', import.meta.url), 'utf8');
  const selectorSource = await readFile(new URL('../src/components/EmployeeSearchSelect.jsx', import.meta.url), 'utf8');
  const syncSource = await readFile(new URL('../src/services/erpStateSync.js', import.meta.url), 'utf8');
  const permissionSource = await readFile(new URL('../src/utils/permissions.js', import.meta.url), 'utf8');
  assert.match(pageSource, /listEmployees/);
  assert.match(pageSource, /importLegacyEmployees/);
  assert.doesNotMatch(pageSource, /localStorage\.getItem\(['"]employees['"]\)|saveERPRecord\(['"]employees['"]/);
  assert.match(selectorSource, /getEmployeeDirectory/);
  assert.doesNotMatch(selectorSource, /getEmployees|localStorage/);
  assert.match(syncSource, /'employees'/);
  assert.doesNotMatch(permissionSource, /localStorage\.getItem\(['"]employees['"]\)/);

  const deleteCurrent = await request(`/api/employees/${encodeURIComponent(employeeRecordId)}`, { token: adminToken, ...json('DELETE', {
    version: changed.body.record.version,
    reason: 'Employee Master integration test cleanup.',
    idempotencyToken: `employee-delete-${suffix}`
  }) });
  tokens.push(`employee-delete-${suffix}`);
  assert.equal(deleteCurrent.status, 200, deleteCurrent.body.error || 'authorized soft-delete succeeds');
  const deletedVersion = deleteCurrent.body.record.version;
  assert.ok(deleteCurrent.body.record.deletedAt);
  assert.equal((await request('/api/auth/me', { token: updatedLogin.body.token })).status, 401, 'employee sessions are revoked when employee is soft-deleted');
  const nonAdminDeletedList = await request('/api/employees?includeDeleted=1', { token: secondLogin.body.token });
  assert.equal(nonAdminDeletedList.status, 200);
  assert.equal(nonAdminDeletedList.body.records.some((record) => record.id === employeeRecordId), false, 'non-Admin directory cannot opt into deleted employee records');
  assert.equal((await request(`/api/employees/${encodeURIComponent(employeeRecordId)}`, { token: secondLogin.body.token })).status, 404, 'deleted employee details are hidden from non-Admin directory users');
  assert.ok((await request('/api/employees?includeDeleted=1', { token: adminToken })).body.records.some((record) => record.id === employeeRecordId), 'Admin can explicitly include deleted employees');

  const conflictData = employeeData({
    id: `employee-conflict-${suffix}`,
    employeeId: `EMP-C-${suffix}`,
    name: 'Restore Conflict Test',
    email: employeeEmail,
    password: `Conflict-${suffix}-Pass!`,
    assignments: salesAndStoreAssignments
  });
  const conflictCreate = await create(conflictData);
  assert.equal(conflictCreate.status, 201, 'deleted employee email may be reused by an active account');
  createdIds.push(conflictData.id);
  const restoreConflict = await request(`/api/employees/${encodeURIComponent(employeeRecordId)}/restore`, { token: adminToken, ...json('POST', {
    version: deletedVersion,
    reason: 'Testing uniqueness validation on restore.',
    idempotencyToken: `employee-restore-conflict-${suffix}`
  }) });
  tokens.push(`employee-restore-conflict-${suffix}`);
  assert.equal(restoreConflict.status, 409, 'restore rejects a conflicting login email');
  const conflictDelete = await request(`/api/employees/${encodeURIComponent(conflictData.id)}`, { token: adminToken, ...json('DELETE', {
    version: conflictCreate.body.record.version,
    reason: 'Clear restore conflict.',
    idempotencyToken: `employee-delete-conflict-${suffix}`
  }) });
  tokens.push(`employee-delete-conflict-${suffix}`);
  assert.equal(conflictDelete.status, 200);
  const restored = await request(`/api/employees/${encodeURIComponent(employeeRecordId)}/restore`, { token: adminToken, ...json('POST', {
    version: deletedVersion,
    reason: 'Restore after uniqueness conflict was removed.',
    idempotencyToken: `employee-restore-${suffix}`
  }) });
  tokens.push(`employee-restore-${suffix}`);
  assert.equal(restored.status, 200, restored.body.error || 'Admin can restore a non-conflicting employee');
  assert.equal(restored.body.record.active, true, 'restore preserves pre-delete active status');
  assert.ok((await request(`/api/employees/${encodeURIComponent(employeeRecordId)}/history`, { token: adminToken })).body.entries.some((entry) => entry.action === 'RESTORE'));

  console.log('Employee Master guarded integration: CRUD, role preservation, auth, hashed passwords, authorization, retries, version conflicts, cross-user visibility, legacy import, generic-sync rejection, deletion, restore, and audit checks passed; database verified as vyavastha_test.');
} finally {
  if (serverSpawned && server.exitCode === null && server.signalCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve)).catch(() => {});
  }
  try {
    if (originalLegacy) {
      await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=$2 WHERE storage_key='employees'", [JSON.stringify(originalLegacy.data), originalLegacy.updated_at]);
    } else if (legacyFixtureWritten) {
      await pool.query("DELETE FROM erp_state WHERE storage_key='employees'");
    }
    if (createdIds.length) {
      await pool.query('DELETE FROM erp_sessions WHERE lower(user_id)=ANY($1::text[])', [createdIds.map((id) => id.toLowerCase())]);
      await pool.query("DELETE FROM erp_audit_log WHERE module='employees' AND record_id=ANY($1::text[])", [
        [employeeId, secondEmployeeId, legacyEmployeeId, `EMP-C-${suffix}`]
      ]);
      await pool.query('DELETE FROM employees WHERE id=ANY($1::text[])', [createdIds]);
    }
    if (tokens.length) await pool.query('DELETE FROM master_idempotency WHERE token=ANY($1::text[])', [tokens]);
  } finally {
    await pool.end();
  }
}
