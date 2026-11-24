import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getPool, closeDatabase } from '../server/database.js';

const port = 3348;
const base = `http://127.0.0.1:${port}`;
const startServer = () => spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), QC_PULL_ENABLED: '0' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (path, { token, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const json = (value) => JSON.stringify(value);
const snapshot = async (keys) => {
  const result = await getPool().query('SELECT storage_key,data FROM erp_state WHERE storage_key=ANY($1::text[])', [keys]);
  return Object.fromEntries(result.rows.map((row) => [row.storage_key, row.data]));
};
const waitForServer = async () => {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* server starting */ }
    await sleep(250);
  }
  return false;
};

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const departmentOne = { id: `sync-test-dept-a-${suffix}`, name: `Sync Test A ${suffix}`, active: true };
const departmentTwo = { id: `sync-test-dept-b-${suffix}`, name: `Sync Test B ${suffix}`, active: true };
const sharedRoleKey = `custom_sync_test_${suffix.replace(/[^a-z0-9]+/gi, '_')}`;
const roleOne = { id: `sync-test-role-a-${suffix}`, departmentId: departmentOne.id, department: departmentOne.name, name: `Sync Test Role A ${suffix}`, roleKey: sharedRoleKey };
const roleTwo = { id: `sync-test-role-b-${suffix}`, departmentId: departmentTwo.id, department: departmentTwo.name, name: `Sync Test Role B ${suffix}`, roleKey: sharedRoleKey };
const employee = {
  id: `sync-test-employee-${suffix}`,
  employeeId: `SYNC-${suffix}`.toUpperCase(),
  name: `Sync Test Employee ${suffix}`,
  email: `sync-test-${suffix}@example.invalid`,
  password: `Sync-Test-${suffix}!2`,
  active: true,
  department: departmentOne.name,
  role: roleOne.name,
  roleKey: roleOne.roleKey,
  departmentAssignments: [
    { department: departmentOne.name, departmentId: departmentOne.id, role: roleOne.name, roleKey: roleOne.roleKey, roleId: roleOne.id },
    { department: departmentTwo.name, departmentId: departmentTwo.id, role: roleTwo.name, roleKey: roleTwo.roleKey, roleId: roleTwo.id }
  ]
};

let server;
let adminToken = '';
let createdDepartmentIds = new Set();
let createdRoleIds = new Set();
let employeeCreated = false;
let baseline = null;
let testAuditCountBefore = 0;
const permissionA = ['inventory.view'];
const permissionB = ['job_card.view'];
const errors = [];

try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured');
  const dbName = (await getPool().query('SELECT current_database() AS name')).rows[0].name;
  assert.match(dbName, /test/i, `refusing to mutate non-test PostgreSQL database '${dbName}'`);
  baseline = await snapshot(['employees', 'departmentCatalog', 'roleCatalog', 'rolePermissions']);
  testAuditCountBefore = Number((await getPool().query("SELECT count(*) AS count FROM erp_audit_log WHERE record_id LIKE $1", [`%${suffix}%`])).rows[0].count);

  server = startServer();
  assert.ok(await waitForServer(), 'test Express server starts');
  const adminLogin = await request('/api/auth/login', { method: 'POST', body: json({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(adminLogin.status, 200, 'Admin login works');
  adminToken = adminLogin.data.token;

  const departments = (await request('/api/state/departmentCatalog', { token: adminToken })).data.data || [];
  const roles = (await request('/api/state/roleCatalog', { token: adminToken })).data.data || [];
  assert.equal((await request('/api/state/departmentCatalog', { method: 'PUT', token: adminToken, body: json({ data: [...departments, departmentOne, departmentTwo] }) })).status, 200, 'two temporary departments persist');
  createdDepartmentIds.add(departmentOne.id); createdDepartmentIds.add(departmentTwo.id);
  assert.equal((await request('/api/state/roleCatalog', { method: 'PUT', token: adminToken, body: json({ data: [...roles, roleOne, roleTwo] }) })).status, 200, 'same role key can be scoped independently by department');
  createdRoleIds.add(roleOne.id); createdRoleIds.add(roleTwo.id);

  // Employee GET intentionally redacts credentials; append from PostgreSQL's
  // exact snapshot so the test never rewrites existing accounts without them.
  const employeeSnapshot = await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'");
  const employees = Array.isArray(employeeSnapshot.rows[0]?.data) ? employeeSnapshot.rows[0].data : [];
  assert.equal((await request('/api/state/employees', { method: 'PUT', token: adminToken, body: json({ data: [...employees, employee] }) })).status, 200, 'temporary employee gets both scoped assignments');
  employeeCreated = true;

  const putOne = await request(`/api/state/rolePermissions/${departmentOne.id}/${roleOne.id}`, { method: 'PUT', token: adminToken, body: json({ permissions: permissionA }) });
  assert.equal(putOne.status, 200, 'Admin saves Department A permissions');
  const putTwo = await request(`/api/state/rolePermissions/${departmentTwo.id}/${roleTwo.id}`, { method: 'PUT', token: adminToken, body: json({ permissions: permissionB }) });
  assert.equal(putTwo.status, 200, 'Admin saves Department B permissions');

  for (const [department, role, expected] of [[departmentOne, roleOne, permissionA], [departmentTwo, roleTwo, permissionB]]) {
    const read = await request(`/api/state/rolePermissions/${department.id}/${role.id}`, { token: adminToken });
    assert.equal(read.status, 200);
    assert.deepEqual(read.data.permissions, expected, 'permission API GET returns the exact saved list');
    const row = await getPool().query("SELECT data FROM erp_state WHERE storage_key='rolePermissions'");
    const persisted = (row.rows[0]?.data || []).find((entry) => entry.departmentId === department.id && entry.roleId === role.id);
    assert.deepEqual(persisted?.permissions, expected, 'exact permissions are present in PostgreSQL JSONB');
  }

  const employeeLoginA = await request('/api/auth/login', { method: 'POST', body: json({ email: employee.email, password: employee.password, portal: 'employee' }) });
  assert.equal(employeeLoginA.status, 200, 'test employee login works');
  const employeeTokenComputerTwo = employeeLoginA.data.token;
  const employeeLoginComputerOne = await request('/api/auth/login', { method: 'POST', body: json({ email: employee.email, password: employee.password, portal: 'employee' }) });
  assert.equal(employeeLoginComputerOne.status, 200, 'independent employee session works');
  const employeeTokenComputerOne = employeeLoginComputerOne.data.token;

  const allowedA = await request('/api/records/inventoryItems', { token: employeeTokenComputerTwo, headers: { 'x-erp-department': departmentOne.name } });
  const deniedA = await request('/api/records/productionDispatchRequests', { token: employeeTokenComputerTwo, headers: { 'x-erp-department': departmentOne.name } });
  assert.equal(allowedA.status, 200, 'Department A permission allows Inventory API');
  assert.equal(deniedA.status, 403, 'Department A permission blocks Production API');
  const allowedB = await request('/api/records/productionDispatchRequests', { token: employeeTokenComputerTwo, headers: { 'x-erp-department': departmentTwo.name } });
  const deniedB = await request('/api/records/inventoryItems', { token: employeeTokenComputerTwo, headers: { 'x-erp-department': departmentTwo.name } });
  assert.equal(allowedB.status, 200, 'Department B permission allows Production API');
  assert.equal(deniedB.status, 403, 'Department A permission does not leak into Department B');

  const unauthorizedWrite = await request(`/api/state/rolePermissions/${departmentOne.id}/${roleOne.id}`, { method: 'PUT', token: employeeTokenComputerTwo, body: json({ permissions: ['inventory.view'] }) });
  assert.equal(unauthorizedWrite.status, 403, 'employee cannot invoke Admin-only permission mutation');

  const { hasPermission } = await import('../src/utils/permissions.js');
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const setClientAuth = (activeDepartment, permissionSet) => localStorage.setItem('erp_auth', json({ isLoggedIn: true, roleKey: sharedRoleKey, role: roleOne.name, activeDepartment, department: activeDepartment, assignments: [
    { department: departmentOne.name, role: roleOne.name, roleKey: sharedRoleKey, departmentId: departmentOne.id, roleId: roleOne.id, permissions: permissionSet[0] },
    { department: departmentTwo.name, role: roleTwo.name, roleKey: sharedRoleKey, departmentId: departmentTwo.id, roleId: roleTwo.id, permissions: permissionSet[1] }
  ] }));
  setClientAuth(departmentOne.name, [permissionA, permissionB]);
  assert.equal(hasPermission('inventory.view'), true, 'frontend exposes the allowed Department A module');
  assert.equal(hasPermission('job_card.view'), false, 'frontend hides the unauthorized Department A module');
  setClientAuth(departmentTwo.name, [permissionA, permissionB]);
  assert.equal(hasPermission('job_card.view'), true, 'frontend exposes the allowed Department B module');
  assert.equal(hasPermission('inventory.view'), false, 'frontend does not reuse Department A permissions in Department B');

  const updatedPermissions = ['sales.quotation'];
  assert.equal((await request(`/api/state/rolePermissions/${departmentOne.id}/${roleOne.id}`, { method: 'PUT', token: adminToken, body: json({ permissions: updatedPermissions }) })).status, 200, 'Computer 1 equivalent updates role permissions');
  const computerTwoMe = await request('/api/auth/me', { token: employeeTokenComputerTwo, headers: { 'x-erp-department': departmentOne.name } });
  const assignmentA = computerTwoMe.data.user.assignments.find((item) => item.departmentId === departmentOne.id);
  assert.deepEqual(assignmentA.permissions, updatedPermissions, 'independent Computer 2 session receives refreshed permission set');
  setClientAuth(departmentOne.name, [updatedPermissions, permissionB]);
  assert.equal(hasPermission('sales.quotation'), true, 'frontend adopts refreshed permissions during the active session');
  assert.equal(hasPermission('inventory.view'), false, 'frontend drops stale permissions after session refresh');
  assert.equal((await request('/api/records/inventoryItems', { token: employeeTokenComputerTwo, headers: { 'x-erp-department': departmentOne.name } })).status, 403, 'old module access is revoked on the active session');
  assert.equal((await request('/api/records/inventoryItems', { token: employeeTokenComputerOne, headers: { 'x-erp-department': departmentOne.name } })).status, 403, 'second active session also observes latest permissions');
  const relogin = await request('/api/auth/login', { method: 'POST', body: json({ email: employee.email, password: employee.password, portal: 'employee' }) });
  assert.deepEqual(relogin.data.user.assignments.find((item) => item.departmentId === departmentOne.id).permissions, updatedPermissions, 'new login does not retain stale permissions');

  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  server = startServer();
  assert.ok(await waitForServer(), 'Express restarts without recreating PostgreSQL');
  const adminAfterRestart = await request('/api/auth/login', { method: 'POST', body: json({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(adminAfterRestart.status, 200);
  adminToken = adminAfterRestart.data.token;
  assert.deepEqual((await request(`/api/state/rolePermissions/${departmentOne.id}/${roleOne.id}`, { token: adminToken })).data.permissions, updatedPermissions, 'permission API retains saved data after restart');
  const postRestartState = await snapshot(['employees', 'departmentCatalog', 'roleCatalog', 'rolePermissions']);
  assert.ok(postRestartState.departmentCatalog.some((item) => item.id === departmentOne.id));
  assert.ok(postRestartState.roleCatalog.some((item) => item.id === roleOne.id));
  assert.ok(postRestartState.employees.some((item) => item.employeeId === employee.employeeId && item.departmentAssignments.length === 2));
  assert.ok(postRestartState.rolePermissions.some((item) => item.departmentId === departmentOne.id && item.roleId === roleOne.id));

  console.log('Integration checks passed: PostgreSQL persistence, department-scoped API authorization, frontend permission lookup, active-session refresh, relogin, and Express restart persistence. Two independent sessions simulated two computers; separate physical LAN computers were not available.');
} catch (error) {
  errors.push(error);
} finally {
  try {
    if (!server || server.exitCode !== null) {
      server = startServer();
      if (!(await waitForServer())) throw new Error('Could not start cleanup server.');
    }
    if (!adminToken) {
      const adminLogin = await request('/api/auth/login', { method: 'POST', body: json({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
      if (adminLogin.status === 200) adminToken = adminLogin.data.token;
    }
    if (adminToken) {
      if (employeeCreated) {
        const removed = await request(`/api/state/employees/${encodeURIComponent(employee.employeeId)}`, { method: 'DELETE', token: adminToken });
        if (![200, 404].includes(removed.status)) throw new Error(`Temporary employee cleanup failed: ${removed.status} ${removed.data.error || ''}`);
      }
      for (const id of createdRoleIds) {
        const removed = await request(`/api/state/roleCatalog/${encodeURIComponent(id)}`, { method: 'DELETE', token: adminToken });
        if (![200, 404].includes(removed.status)) throw new Error(`Temporary role cleanup failed: ${removed.status} ${removed.data.error || ''}`);
      }
      for (const id of createdDepartmentIds) {
        const removed = await request(`/api/state/departmentCatalog/${encodeURIComponent(id)}`, { method: 'DELETE', token: adminToken });
        if (![200, 404].includes(removed.status)) throw new Error(`Temporary department cleanup failed: ${removed.status} ${removed.data.error || ''}`);
      }
      if (baseline) {
        const after = await snapshot(['employees', 'departmentCatalog', 'roleCatalog', 'rolePermissions']);
        for (const key of ['employees', 'departmentCatalog', 'roleCatalog']) assert.deepEqual(after[key] || [], baseline[key] || [], `cleanup restores original ${key} contents`);
        const baselinePermissions = baseline.rolePermissions || [];
        const afterPermissions = after.rolePermissions || [];
        assert.deepEqual(afterPermissions, baselinePermissions, 'cleanup restores the original permission catalog contents');
        const count = Number((await getPool().query("SELECT count(*) AS count FROM erp_audit_log WHERE record_id LIKE $1", [`%${suffix}%`])).rows[0].count);
        assert.ok(count > testAuditCountBefore, 'test audit rows remain after cleanup; cleanup never deletes audit history');
      }
    }
  } catch (cleanupError) {
    errors.push(cleanupError);
  }
  if (server) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)).catch(() => {}); }
  await closeDatabase().catch(() => {});
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
}
