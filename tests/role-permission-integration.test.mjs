import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { getPool, closeDatabase } from '../server/database.js';

const testDatabaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing role permission tests outside vyavastha_test.');
}
process.env.ERP_TEST_MODE = '1';
process.env.ERP_TEST_DATABASE_URL = testDatabaseUrl;
assert.equal((await getPool().query('SELECT current_database() AS name')).rows[0]?.name, 'vyavastha_test',
  'role permission test writes are restricted to vyavastha_test');

const port = await new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const { port: availablePort } = listener.address();
    listener.close((error) => error ? reject(error) : resolve(availablePort));
  });
});
const base = `http://127.0.0.1:${port}`;
const serverEnv = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: testDatabaseUrl, PORT: String(port), QC_PULL_ENABLED: '0' };
delete serverEnv.DATABASE_URL;
const startServer = () => spawn(process.execPath, ['server.js'], { env: serverEnv, stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (path, { token, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const json = (value) => JSON.stringify(value);
const waitForServer = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok && (await response.json().catch(() => ({}))).ready === true) return true;
    } catch { /* server starting */ }
    await sleep(250);
  }
  return false;
};

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const department = { id: `permission-dept-${suffix}`, name: `Permission Test ${suffix}`, active: true };
const role = {
  id: `permission-role-${suffix}`, departmentId: department.id, department: department.name,
  name: `Permission Operator ${suffix}`, roleKey: `permission_operator_${suffix.replace(/[^a-z0-9]+/gi, '_')}`, active: true
};
const employee = {
  id: `permission-employee-${suffix}`, employeeId: `PERM-${suffix}`.toUpperCase(),
  name: `Permission Employee ${suffix}`, email: `permission-${suffix}@example.invalid`,
  password: `Permission-${suffix}!2`, active: true, department: department.name, role: role.name,
  roleKey: role.roleKey,
  departmentAssignments: [{ department: department.name, departmentId: department.id, role: role.name, roleKey: role.roleKey, roleId: role.id }]
};
const tokens = [];
let server;
let adminToken = '';
let employeeCreated = false;
const failures = [];

try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured');
  server = startServer();
  assert.ok(await waitForServer(), 'test Express server starts');
  const adminLogin = await request('/api/auth/login', {
    method: 'POST', body: json({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
  });
  assert.equal(adminLogin.status, 200, `Admin login works (${adminLogin.data.error || ''})`);
  adminToken = adminLogin.data.token;

  const anonList = await request('/api/organization-catalogs/departments');
  assert.equal(anonList.status, 401, 'catalog APIs require authentication');
  assert.equal((await request('/api/organization-catalogs/departments', { token: adminToken })).status, 200);

  const departmentToken = `permission-department-${suffix}`;
  const roleToken = `permission-role-create-${suffix}`;
  tokens.push(departmentToken, roleToken);
  const createdDepartment = await request('/api/organization-catalogs/departments', {
    method: 'POST', token: adminToken, body: json({ data: department, idempotencyToken: departmentToken })
  });
  assert.equal(createdDepartment.status, 201, `dedicated department API creates a scoped department (${createdDepartment.data.error || ''})`);
  const createdRole = await request('/api/organization-catalogs/roles', {
    method: 'POST', token: adminToken, body: json({ data: role, idempotencyToken: roleToken })
  });
  assert.equal(createdRole.status, 201, `dedicated role API creates a department-scoped role (${createdRole.data.error || ''})`);
  assert.equal((await request('/api/organization-catalogs/roles', { token: adminToken })).data.records.some((item) => item.id === role.id), true);

  const employeeCreateToken = `permission-employee-create-${suffix}`;
  tokens.push(employeeCreateToken);
  assert.equal((await request('/api/state/roleCatalog', {
    method: 'PUT', token: adminToken, body: json({ data: [role] })
  })).status, 409, 'generic synchronization rejects catalog whole-key writes');
  assert.equal((await request('/api/state', {
    method: 'PUT', token: adminToken, body: json({ records: { departmentCatalog: [department] } })
  })).status, 400, 'bulk generic synchronization rejects catalog keys');
  const createdEmployee = await request('/api/employees', {
    method: 'POST', token: adminToken, body: json({ data: employee, createToken: employeeCreateToken })
  });
  assert.equal(createdEmployee.status, 201, `employee API preserves scoped assignments (${createdEmployee.data.error || ''})`);
  employeeCreated = true;

  const permissionA = ['inventory.view'];
  const permissionB = ['job_card.view'];
  const permissionPath = `/api/organization-catalogs/role-permissions/${department.id}/${role.id}`;
  const initialPermissions = await request(permissionPath, { token: adminToken });
  assert.equal(initialPermissions.status, 200);
  assert.equal(initialPermissions.data.version, 0);
  const permissionToken = `permission-save-${suffix}`;
  tokens.push(permissionToken);
  const savedPermissions = await request(permissionPath, {
    method: 'PUT', token: adminToken,
    body: json({ permissions: permissionA, version: initialPermissions.data.version, idempotencyToken: permissionToken })
  });
  assert.equal(savedPermissions.status, 200, `Admin saves permissions (${savedPermissions.data.error || ''})`);
  assert.deepEqual(savedPermissions.data.permissions, permissionA);
  assert.equal((await getPool().query(
    'SELECT permissions FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2', [department.id, role.id]
  )).rows[0]?.permissions instanceof Array, true, 'permissions persist in the normalized PostgreSQL table');

  const staleWrite = await request(permissionPath, {
    method: 'PUT', token: adminToken,
    body: json({ permissions: permissionB, version: 0, idempotencyToken: `permission-stale-${suffix}` })
  });
  assert.equal(staleWrite.status, 409, 'stale permission versions are rejected');
  const employeeLoginA = await request('/api/auth/login', {
    method: 'POST', body: json({ email: employee.email, password: employee.password, portal: 'employee' })
  });
  assert.equal(employeeLoginA.status, 200, `employee login still works (${employeeLoginA.data.error || ''})`);
  const employeeToken = employeeLoginA.data.token;
  const unauthorizedWrite = await request(permissionPath, {
    method: 'PUT', token: employeeToken,
    body: json({ permissions: permissionB, version: savedPermissions.data.version, idempotencyToken: `permission-employee-${suffix}` })
  });
  assert.equal(unauthorizedWrite.status, 403, 'employee cannot invoke Admin-only permission mutation');
  const legacyPermissionWrite = await request(`/api/state/rolePermissions/${department.id}/${role.id}`, {
    method: 'PUT', token: adminToken,
    body: json({ permissions: permissionB })
  });
  assert.equal(legacyPermissionWrite.status, 409, 'legacy scoped permission writes are disabled in favor of versioned catalog APIs');
  assert.equal((await request('/api/organization-catalogs/departments', { token: employeeToken })).status, 403,
    'catalog listing preserves Admin-only authorization');

  const authMe = await request('/api/auth/me', { token: employeeToken, headers: { 'x-erp-department': department.name } });
  const assignment = authMe.data.user.assignments.find((item) => item.departmentId === department.id);
  assert.deepEqual(assignment.permissions, permissionA, 'authentication refresh resolves the saved PostgreSQL permissions');
  assert.equal(assignment.roleId, role.id, 'employee role assignment identity remains stable');
  assert.equal(assignment.departmentId, department.id, 'employee department assignment identity remains stable');

  const snapshot = await getPool().query(
    "SELECT data FROM erp_state WHERE storage_key='roleCatalog'"
  );
  assert.equal((snapshot.rows[0]?.data || []).some((record) => record.id === role.id), false,
    'dedicated catalog writes do not replace or append to the preserved legacy snapshot');

  const history = await request('/api/organization-catalogs/history?module=rolePermissions', { token: adminToken });
  assert.equal(history.status, 200);
  assert.ok(history.data.entries.some((entry) => entry.record_id === `${department.id}:${role.id}` && entry.action === 'UPDATE'),
    'permission changes are audit logged');
  assert.equal((await getPool().query(
    'SELECT count(*)::int AS count FROM erp_audit_log WHERE module=$1 AND record_id=$2',
    ['rolePermissions', `${department.id}:${role.id}`]
  )).rows[0].count > 0, true);

  console.log('Department-scoped permission integration passed: authenticated catalog APIs, Admin authorization, generic-sync rejection, version conflicts, PostgreSQL persistence, assignment identity preservation, permission refresh and audit history.');
} catch (error) {
  failures.push(error);
} finally {
  try {
    if (server) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)).catch(() => {}); }
    if (employeeCreated) {
      await getPool().query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [employee.email]);
      await getPool().query('DELETE FROM employees WHERE id=$1', [employee.id]);
    }
    await getPool().query('DELETE FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2', [department.id, role.id]);
    await getPool().query('DELETE FROM role_catalog WHERE id=$1', [role.id]);
    await getPool().query('DELETE FROM department_catalog WHERE id=$1', [department.id]);
    if (tokens.length) await getPool().query('DELETE FROM master_idempotency WHERE token=ANY($1::text[])', [tokens]);
  } catch (cleanupError) {
    failures.push(cleanupError);
  }
  await closeDatabase().catch(() => {});
}

if (failures.length) {
  for (const error of failures) console.error(error);
  process.exitCode = 1;
}
