import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { getPool, closeDatabase } from '../server/database.js';
import { hasPermissionForRole, normalizeEmployeeAssignments, permissionsForRole } from '../server/departmentAccess.js';
import { homePathFor } from '../src/utils/roleNavigation.js';
import { ROLE_PERMISSIONS } from '../src/utils/permissions.js';

const testDatabaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing authentication tests outside vyavastha_test.');
}
process.env.ERP_TEST_MODE = '1';
process.env.ERP_TEST_DATABASE_URL = testDatabaseUrl;
const databaseIdentity = await getPool().query('SELECT current_database() AS name');
assert.equal(databaseIdentity.rows[0]?.name, 'vyavastha_test', 'authentication test writes are restricted to vyavastha_test');

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
const processRef = spawn(process.execPath, ['server.js'], {
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
processRef.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
processRef.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const createdEmployees = [];
const employeeEmails = [];
const idempotencyTokens = [];
let adminLoginTokenForCleanup = '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (path, { token, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured in the server environment');
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok && (await response.json().catch(() => ({}))).ready === true) { ready = true; break; }
    } catch { /* server is starting */ }
    await sleep(250);
  }
  assert.ok(ready, 'isolated authentication test server starts on localhost');

  const admin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(admin.status, 200, `existing Admin Portal credentials are accepted\n${serverOutput}`);
  assert.equal(admin.data.user?.roleKey, 'admin');
  assert.ok(admin.data.token);
  const adminMe = await request('/api/auth/me', { token: admin.data.token });
  assert.equal(adminMe.status, 200);
  assert.equal(adminMe.data.user?.roleKey, 'admin', 'Admin identity is retained for dashboard selection');
  assert.equal((await request('/api/auth/employee-count', { token: admin.data.token })).status, 200, 'Admin can load the employee-count dashboard aggregate');
  assert.equal((await request('/api/auth/audit', { token: admin.data.token })).status, 200);

  const employee = {
    id: `auth-regression-${Date.now()}`, employeeId: `AUTH-${Date.now()}`,
    name: 'Authentication Regression Employee', email: `auth-regression-${Date.now()}@example.com`,
    password: 'Auth@Test123!', active: true, department: 'Sales Department',
    role: 'Sales Executive', roleKey: 'sales_executive',
    departmentAssignments: [{ department: 'Sales Department', role: 'Sales Executive', roleKey: 'sales_executive' }]
  };
  employee.email = `${employee.id}@example.com`;
  const employeeCreateToken = `auth-regression-create-${Date.now()}`;
  idempotencyTokens.push(employeeCreateToken);
  const createdEmployee = await request('/api/employees', {
    method: 'POST', token: admin.data.token,
    body: JSON.stringify({ data: employee, createToken: employeeCreateToken })
  });
  assert.equal(createdEmployee.status, 201, `dedicated API creates authentication regression employee (${createdEmployee.data.error || ''})`);
  createdEmployees.push({ id: employee.id, employeeId: employee.employeeId });
  employeeEmails.push(employee.email);
  const employeeLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: employee.email, password: employee.password, portal: 'employee' }) });
  assert.equal(employeeLogin.status, 200, 'existing Employee Portal credentials are accepted');
  assert.notEqual(employeeLogin.data.user?.roleKey, 'admin');
  const employeeMe = await request('/api/auth/me', { token: employeeLogin.data.token });
  assert.equal(employeeMe.status, 200);
  assert.equal(employeeMe.data.user?.email, employee.email.toLowerCase());
  assert.equal((await request('/api/auth/audit', { token: employeeLogin.data.token })).status, 403, 'employee cannot access Admin audit history');
  const employeeDepartment = employeeLogin.data.user.activeDepartment;
  const employeeMeForDepartment = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${employeeLogin.data.token}`, 'x-erp-department': employeeDepartment } });
  assert.equal(employeeMeForDepartment.status, 200, 'an assigned department is accepted by the server');
  const unassignedDepartment = ['Sales Department','Purchase Department','Production Department','Store Department'].find((department) => !employeeLogin.data.user.assignments.some((assignment) => assignment.department === department));
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${employeeLogin.data.token}`, 'x-erp-department': unassignedDepartment } })).status, 403, 'an unassigned department is rejected by the server');
  assert.equal((await request('/api/state/employees', { token: employeeLogin.data.token })).status, 400, 'generic employee reads are rejected after migration');
  assert.equal((await request('/api/state/departmentCatalog', { token: employeeLogin.data.token })).status, 403, 'non-admin users cannot read the department catalog');
  assert.equal((await request('/api/state/departmentCatalog', { method: 'PUT', token: employeeLogin.data.token, body: JSON.stringify({ data: [{ name: 'Unauthorized Department' }] }) })).status, 403, 'non-admin users cannot create departments through direct API requests');
  assert.equal((await request('/api/state/roleCatalog', { method: 'PUT', token: employeeLogin.data.token, body: JSON.stringify({ data: [{ department: 'Sales Department', name: 'Unauthorized Role', roleKey: 'custom_unauthorized' }] }) })).status, 403, 'non-admin users cannot create roles through direct API requests');
  const restrictedKey = { 'Sales Department': 'salesOrders', 'Purchase Department': 'purchaseOrders', 'Production Department': 'productionJobCards', 'Store Department': 'storeIssueHistory' }[unassignedDepartment];
  assert.ok(restrictedKey, `an unassigned department exists for API denial checks (${employeeLogin.data.user.department})`);
  assert.equal((await request(`/api/state/${restrictedKey}`, { token: employeeLogin.data.token })).status, 403, 'unassigned department data is denied through direct API access');
  assert.equal((await request(`/api/state/${restrictedKey}`, { method: 'PUT', token: employeeLogin.data.token, body: JSON.stringify({ data: [] }) })).status, 403, 'unassigned department data cannot be modified through direct API access');
  assert.equal((await request('/api/ballooning/projects', { token: employeeLogin.data.token })).status, employeeLogin.data.user.roleKey.startsWith('production_') ? 200 : 403, 'department API access follows the active role');
  assert.equal(homePathFor({ department: 'Sales Department' }), '/sales-dashboard');
  assert.equal(homePathFor({ department: 'Purchase Department' }), '/workflow');

  const multi = { departmentAssignments: [
    { department: 'Sales Department', role: 'Sales Executive', roleKey: 'sales_executive' },
    { department: 'Purchase Department', role: 'Purchase Manager', roleKey: 'purchase_manager' },
    { department: 'Store Department', role: 'Store In-charge', roleKey: 'store_incharge' }
  ] };
  for (const roleKey of Object.keys(ROLE_PERMISSIONS).filter((key) => key !== 'administrator')) {
    assert.deepEqual([...new Set(permissionsForRole(roleKey))].sort(), [...new Set(ROLE_PERMISSIONS[roleKey])].sort(), `backend permissions match the frontend matrix for ${roleKey}`);
  }
  const normalizedAssignments = normalizeEmployeeAssignments(multi);
  assert.equal(normalizedAssignments.length, 3, 'three department roles coexist on one employee');
  assert.equal(normalizedAssignments[0].department, 'Sales Department', 'login starts from the first assignment without a primary department preference');
  assert.ok(hasPermissionForRole(normalizedAssignments[0].roleKey, 'sales.quotation'));
  assert.ok(!hasPermissionForRole(normalizedAssignments[0].roleKey, 'purchase.order'));
  assert.ok(hasPermissionForRole(normalizedAssignments[1].roleKey, 'purchase.order'));
  assert.ok(!hasPermissionForRole(normalizedAssignments[1].roleKey, 'inventory.adjust'));
  assert.ok(hasPermissionForRole(normalizedAssignments[2].roleKey, 'inventory.adjust'));
  assert.ok(!hasPermissionForRole(normalizedAssignments[2].roleKey, 'sales.quotation'));

  const multiEmployee = {
    id: `auth-multi-${Date.now()}`, employeeId: `TEST-${Date.now()}`, name: 'Department Access Test',
    email: `auth-multi-${Date.now()}@example.com`, password: 'Multi@Test123!', active: true,
    department: 'Sales Department', role: 'Sales Executive', roleKey: 'sales_executive',
    departmentAssignments: multi.departmentAssignments
  };
  multiEmployee.email = `${multiEmployee.id}@example.com`;
  const multiCreateToken = `auth-multi-create-${Date.now()}`;
  idempotencyTokens.push(multiCreateToken);
  const addMulti = await request('/api/employees', { method: 'POST', token: admin.data.token, body: JSON.stringify({ data: multiEmployee, createToken: multiCreateToken }) });
  assert.equal(addMulti.status, 201, `Admin can persist a multi-department employee through the dedicated API (${addMulti.data.error || ''})`);
  createdEmployees.push({ id: multiEmployee.id, employeeId: multiEmployee.employeeId });
  employeeEmails.push(multiEmployee.email);
  {
    const multiLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: multiEmployee.email, password: multiEmployee.password, portal: 'employee' }) });
    assert.equal(multiLogin.status, 200);
    assert.equal(multiLogin.data.user.assignments.length, 3);
    assert.equal(multiLogin.data.user.activeDepartment, 'Sales Department', 'first assigned department is selected after login');
    const token = multiLogin.data.token;
    for (const [department, roleKey] of [['Sales Department','sales_executive'],['Purchase Department','purchase_manager'],['Store Department','store_incharge']]) {
      const switched = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}`, 'x-erp-department': department } });
      const switchedPayload = await switched.json();
      assert.equal(switched.status, 200);
      assert.equal(switchedPayload.user.roleKey, roleKey, `same session switches into ${department} with its assigned role`);
    }
    const deniedDept = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}`, 'x-erp-department': 'Production Department' } });
    assert.equal(deniedDept.status, 403, 'unassigned department cannot be selected');
    const updateToken = `auth-multi-update-${Date.now()}`;
    idempotencyTokens.push(updateToken);
    const removeSales = await request(`/api/employees/${encodeURIComponent(multiEmployee.id)}`, {
      method: 'PUT',
      token: admin.data.token,
      body: JSON.stringify({
        data: { departmentAssignments: multi.departmentAssignments.filter((item) => item.department !== 'Sales Department') },
        version: addMulti.data.record.version,
        idempotencyToken: updateToken
      })
    });
    assert.equal(removeSales.status, 200, `department assignment removal uses optimistic versioning (${removeSales.data.error || ''})`);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}`, 'x-erp-department': 'Sales Department' } })).status, 403, 'removed assignment takes effect on the existing session');
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}`, 'x-erp-department': 'Purchase Department' } })).status, 200, 'remaining assignments keep working on the same session');
    await request('/api/auth/logout', { method: 'POST', token });
    console.log('Multi-department API checks passed: initial department, role switching, restricted department, assignment revocation, and single-session behavior.');
  }

  assert.equal((await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: 'invalid-password', portal: 'admin' }) })).status, 401, 'invalid Admin password is rejected');
  assert.equal((await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'unknown-user@gmail.com', password: 'invalid-password', portal: 'employee' }) })).status, 401, 'unknown employee is rejected');
  assert.equal((await request('/api/state')).status, 401, 'anonymous data access is rejected');

  assert.equal((await request('/api/auth/logout', { method: 'POST', token: employeeLogin.data.token })).status, 200);
  assert.equal((await request('/api/auth/me', { token: employeeLogin.data.token })).status, 401, 'logout revokes the session');
  assert.equal((await request('/api/auth/logout', { method: 'POST', token: admin.data.token })).status, 200);
  assert.equal((await request('/api/auth/me', { token: admin.data.token })).status, 401, 'Admin logout revokes the session');

  console.log('Authentication API checks passed: Admin, Employee, invalid credentials, role authorization, localhost startup, and logout revocation.');
} finally {
  if (processRef.exitCode === null && processRef.signalCode === null) {
    processRef.kill();
    await new Promise((resolve) => processRef.once('exit', resolve)).catch(() => {});
  }
  if (employeeEmails.length) await getPool().query('DELETE FROM erp_sessions WHERE lower(email)=ANY($1::text[])', [employeeEmails.map((email) => email.toLowerCase())]).catch(() => {});
  if (createdEmployees.length) {
    await getPool().query("DELETE FROM erp_audit_log WHERE module='employees' AND record_id=ANY($1::text[])", [createdEmployees.map((employee) => employee.employeeId)]).catch(() => {});
    await getPool().query('DELETE FROM employees WHERE id=ANY($1::text[])', [createdEmployees.map((employee) => employee.id)]).catch(() => {});
  }
  if (idempotencyTokens.length) await getPool().query('DELETE FROM master_idempotency WHERE token=ANY($1::text[])', [idempotencyTokens]).catch(() => {});
  await closeDatabase().catch(() => {});
}
