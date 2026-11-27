import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { getPool, closeDatabase } from '../server/database.js';

const testDatabaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing employee assignment tests outside vyavastha_test.');
}
process.env.ERP_TEST_MODE = '1';
process.env.ERP_TEST_DATABASE_URL = testDatabaseUrl;
assert.equal((await getPool().query('SELECT current_database() AS name')).rows[0]?.name, 'vyavastha_test',
  'employee assignment test writes are restricted to vyavastha_test');

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
const departmentA = { id: `assignment-dept-a-${suffix}`, name: `Assignment A ${suffix}`, active: true };
const departmentB = { id: `assignment-dept-b-${suffix}`, name: `Assignment B ${suffix}`, active: true };
const roleA = {
  id: `assignment-role-a-${suffix}`, departmentId: departmentA.id, department: departmentA.name,
  name: `Assignment Role A ${suffix}`, roleKey: `assign_a_${suffix.replace(/[^a-z0-9]+/gi, '_')}`, active: true
};
const roleB = {
  id: `assignment-role-b-${suffix}`, departmentId: departmentB.id, department: departmentB.name,
  name: `Assignment Role B ${suffix}`, roleKey: `assign_b_${suffix.replace(/[^a-z0-9]+/gi, '_')}`, active: true
};
const assignmentA = { department: departmentA.name, departmentId: departmentA.id, role: roleA.name, roleKey: roleA.roleKey, roleId: roleA.id };
const assignmentB = { department: departmentB.name, departmentId: departmentB.id, role: roleB.name, roleKey: roleB.roleKey, roleId: roleB.id };
const employee = {
  id: `assignment-employee-${suffix}`, employeeId: `ASSIGN-${suffix}`.toUpperCase(),
  name: `Assignment Employee ${suffix}`, email: `assignment-${suffix}@example.invalid`,
  password: `Assignment-${suffix}!2`, active: true, department: departmentA.name, role: roleA.name,
  roleKey: roleA.roleKey, departmentAssignments: [assignmentA, assignmentB]
};
const idempotencyTokens = [];
const failures = [];
let server;
let adminToken = '';
let employeeCreated = false;

const createCatalogRecord = async (path, data, prefix) => {
  const idempotencyToken = `${prefix}-${suffix}`;
  idempotencyTokens.push(idempotencyToken);
  return request(path, { method: 'POST', token: adminToken, body: json({ data, idempotencyToken }) });
};

try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured');
  server = startServer();
  assert.ok(await waitForServer(), 'test Express server starts');
  const adminLogin = await request('/api/auth/login', {
    method: 'POST', body: json({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
  });
  assert.equal(adminLogin.status, 200, `Admin login works (${adminLogin.data.error || ''})`);
  adminToken = adminLogin.data.token;

  for (const [department, index] of [[departmentA, 'a'], [departmentB, 'b']]) {
    const result = await createCatalogRecord('/api/organization-catalogs/departments', department, `assignment-department-${index}`);
    assert.equal(result.status, 201, `department ${index} is created (${result.data.error || ''})`);
  }
  for (const [role, index] of [[roleA, 'a'], [roleB, 'b']]) {
    const result = await createCatalogRecord('/api/organization-catalogs/roles', role, `assignment-role-create-${index}`);
    assert.equal(result.status, 201, `role ${index} is created (${result.data.error || ''})`);
  }

  const createToken = `assignment-employee-create-${suffix}`;
  idempotencyTokens.push(createToken);
  const created = await request('/api/employees', {
    method: 'POST', token: adminToken, body: json({ data: employee, createToken })
  });
  assert.equal(created.status, 201, `employee with multi-department assignments is created (${created.data.error || ''})`);
  employeeCreated = true;
  assert.equal(created.data.record.departmentAssignments.length, 2, 'both department/role references are persisted');
  assert.equal((await request('/api/state/departmentCatalog', {
    method: 'PUT', token: adminToken, body: json({ data: [departmentA, departmentB] })
  })).status, 409, 'legacy whole-key catalog writes are rejected');

  const roleDeleteToken = `assignment-role-delete-${suffix}`;
  idempotencyTokens.push(roleDeleteToken);
  const assignedRoleDelete = await request(`/api/organization-catalogs/roles/${roleB.id}`, {
    method: 'DELETE', token: adminToken,
    body: json({ version: 1, reason: 'Must not remove an assigned role', idempotencyToken: roleDeleteToken })
  });
  assert.equal(assignedRoleDelete.status, 409, 'a role assigned to an employee cannot be deleted');
  const deactivateRoleToken = `assignment-role-deactivate-${suffix}`;
  idempotencyTokens.push(deactivateRoleToken);
  const assignedRoleDeactivate = await request(`/api/organization-catalogs/roles/${roleB.id}`, {
    method: 'PUT', token: adminToken,
    body: json({ data: { name: roleB.name, roleKey: roleB.roleKey, active: false }, version: 1, reason: 'Must preserve assigned role access', idempotencyToken: deactivateRoleToken })
  });
  assert.equal(assignedRoleDeactivate.status, 200, 'an assigned role can be deactivated without deleting its assignment');
  const deactivateDepartmentToken = `assignment-dept-deactivate-${suffix}`;
  idempotencyTokens.push(deactivateDepartmentToken);
  const assignedDepartmentDeactivate = await request(`/api/organization-catalogs/departments/${departmentB.id}`, {
    method: 'PUT', token: adminToken,
    body: json({ data: { name: departmentB.name, active: false }, version: 1, reason: 'Preserve existing assignments', idempotencyToken: deactivateDepartmentToken })
  });
  assert.equal(assignedDepartmentDeactivate.status, 200, 'an assigned department can be deactivated without deleting employee references');

  const currentEmployee = await request(`/api/employees/${encodeURIComponent(employee.id)}`, { token: adminToken });
  assert.equal(currentEmployee.status, 200);
  const preservedEmployee = await request(`/api/employees/${encodeURIComponent(employee.id)}`, {
    method: 'PUT', token: adminToken,
    body: json({
      version: currentEmployee.data.record.version,
      data: { designation: 'Preserved assignment test', departmentAssignments: currentEmployee.data.record.departmentAssignments },
      idempotencyToken: `assignment-preserve-${suffix}`
    })
  });
  idempotencyTokens.push(`assignment-preserve-${suffix}`);
  assert.equal(preservedEmployee.status, 200, 'unrelated employee updates retain existing inactive catalog assignments');
  assert.equal(preservedEmployee.data.record.departmentAssignments.length, 2);
  const updatedAssignments = preservedEmployee.data.record.departmentAssignments.filter((item) => item.departmentId !== departmentB.id);
  const employeeUpdateToken = `assignment-employee-update-${suffix}`;
  idempotencyTokens.push(employeeUpdateToken);
  const updatedEmployee = await request(`/api/employees/${encodeURIComponent(employee.id)}`, {
    method: 'PUT', token: adminToken,
    body: json({ version: preservedEmployee.data.record.version, data: { departmentAssignments: updatedAssignments }, idempotencyToken: employeeUpdateToken })
  });
  assert.equal(updatedEmployee.status, 200, `employee assignment update succeeds (${updatedEmployee.data.error || ''})`);
  assert.deepEqual(updatedEmployee.data.record.departmentAssignments.map((item) => item.departmentId), [departmentA.id],
    'updating one assignment preserves the unrelated department assignment');

  const reactivateDepartmentToken = `assignment-dept-reactivate-${suffix}`;
  idempotencyTokens.push(reactivateDepartmentToken);
  const reactivatedDepartment = await request(`/api/organization-catalogs/departments/${departmentB.id}`, {
    method: 'PUT', token: adminToken,
    body: json({
      data: { name: departmentB.name, active: true },
      version: assignedDepartmentDeactivate.data.record.version,
      reason: 'Enable department for restored catalog test',
      idempotencyToken: reactivateDepartmentToken
    })
  });
  assert.equal(reactivatedDepartment.status, 200, 'department can be reactivated after assignment removal');
  const inactiveRoleAssignmentToken = `assignment-inactive-role-${suffix}`;
  idempotencyTokens.push(inactiveRoleAssignmentToken);
  const reassignInactiveRole = await request(`/api/employees/${encodeURIComponent(employee.id)}`, {
    method: 'PUT', token: adminToken,
    body: json({
      version: updatedEmployee.data.record.version,
      data: { departmentAssignments: [...updatedEmployee.data.record.departmentAssignments, assignmentB] },
      idempotencyToken: inactiveRoleAssignmentToken
    })
  });
  assert.equal(reassignInactiveRole.status, 400, 'inactive roles cannot be newly assigned');

  const reactivateRoleToken = `assignment-role-reactivate-${suffix}`;
  idempotencyTokens.push(reactivateRoleToken);
  const reactivatedRole = await request(`/api/organization-catalogs/roles/${roleB.id}`, {
    method: 'PUT', token: adminToken,
    body: json({
      data: { name: roleB.name, roleKey: roleB.roleKey, active: true },
      version: assignedRoleDeactivate.data.record.version,
      reason: 'Enable role for catalog lifecycle test',
      idempotencyToken: reactivateRoleToken
    })
  });
  assert.equal(reactivatedRole.status, 200, 'role can be reactivated after deactivation');

  const successfulRoleDeleteToken = `assignment-role-delete-ok-${suffix}`;
  idempotencyTokens.push(successfulRoleDeleteToken);
  const deletedRole = await request(`/api/organization-catalogs/roles/${roleB.id}`, {
    method: 'DELETE', token: adminToken,
    body: json({ version: reactivatedRole.data.record.version, reason: 'Unassigned test role', idempotencyToken: successfulRoleDeleteToken })
  });
  assert.equal(deletedRole.status, 200, `unassigned role is soft-deleted (${deletedRole.data.error || ''})`);
  assert.ok(deletedRole.data.record.deletedAt);
  assert.equal(deletedRole.data.record.active, false);

  const deletedRoleAssignment = { ...assignmentB };
  const invalidAssignmentToken = `assignment-invalid-${suffix}`;
  idempotencyTokens.push(invalidAssignmentToken);
  const reassignDeletedRole = await request(`/api/employees/${encodeURIComponent(employee.id)}`, {
    method: 'PUT', token: adminToken,
    body: json({
      version: updatedEmployee.data.record.version,
      data: { departmentAssignments: [...updatedEmployee.data.record.departmentAssignments, deletedRoleAssignment] },
      idempotencyToken: invalidAssignmentToken
    })
  });
  assert.equal(reassignDeletedRole.status, 400, 'deleted roles cannot be assigned to employees');

  const restoreToken = `assignment-role-restore-${suffix}`;
  idempotencyTokens.push(restoreToken);
  const restoredRole = await request(`/api/organization-catalogs/roles/${roleB.id}/restore`, {
    method: 'POST', token: adminToken,
    body: json({ version: deletedRole.data.record.version, reason: 'Restore for assignment integrity test', idempotencyToken: restoreToken })
  });
  assert.equal(restoredRole.status, 200, `role restore succeeds (${restoredRole.data.error || ''})`);
  assert.equal(restoredRole.data.record.id, roleB.id, 'restoration preserves the stable role identifier');
  assert.equal(restoredRole.data.record.active, true);

  const history = await request('/api/organization-catalogs/history?module=roleCatalog', { token: adminToken });
  assert.ok(history.data.entries.some((item) => item.record_id === roleB.id && item.action === 'SOFT_DELETE'));
  assert.ok(history.data.entries.some((item) => item.record_id === roleB.id && item.action === 'RESTORE'));
  const currentDepartment = await request(`/api/organization-catalogs/departments/${departmentA.id}`, { token: adminToken });
  assert.equal(currentDepartment.data.record.id, departmentA.id, 'department identity remains stable after related role changes');

  console.log('Employee assignment integrity passed: multi-department references persist, assigned role deletion is blocked, unrelated assignments survive edits, deleted roles cannot be reassigned, and authorized soft-delete/restore is audited.');
} catch (error) {
  failures.push(error);
} finally {
  try {
    if (server) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)).catch(() => {}); }
    if (employeeCreated) {
      await getPool().query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [employee.email]);
      await getPool().query('DELETE FROM employees WHERE id=$1', [employee.id]);
    }
    await getPool().query('DELETE FROM role_permission_catalog WHERE department_id=ANY($1::text[])', [[departmentA.id, departmentB.id]]);
    await getPool().query('DELETE FROM role_catalog WHERE id=ANY($1::text[])', [[roleA.id, roleB.id]]);
    await getPool().query('DELETE FROM department_catalog WHERE id=ANY($1::text[])', [[departmentA.id, departmentB.id]]);
    if (idempotencyTokens.length) await getPool().query('DELETE FROM master_idempotency WHERE token=ANY($1::text[])', [idempotencyTokens]);
  } catch (cleanupError) {
    failures.push(cleanupError);
  }
  await closeDatabase().catch(() => {});
}

if (failures.length) {
  for (const error of failures) console.error(error);
  process.exitCode = 1;
}
