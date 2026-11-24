import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { getPool, closeDatabase } from '../server/database.js';

const port = 3337;
const base = `http://127.0.0.1:${port}`;
const startServer = () => spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), QC_PULL_ENABLED: '0' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async (path, { token, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const employeePage = await readFile(new URL('../src/pages/EmployeeMasterPage.jsx', import.meta.url), 'utf8');
const employeeStyles = await readFile(new URL('../src/styles/erp-theme.css', import.meta.url), 'utf8');
const syncService = await readFile(new URL('../src/services/erpStateSync.js', import.meta.url), 'utf8');
const stateRoutes = await readFile(new URL('../server/erpStateRoutes.js', import.meta.url), 'utf8');
assert.doesNotMatch(employeePage, /Delete Assignment/, 'assignment delete text is absent');
assert.match(employeePage, /push\(\{ id: item\.id, name: item\.name, roleKey: item\.roleKey \}\)/, 'role identifiers survive dropdown grouping');
assert.match(employeePage, /Confirm Role Deletion/, 'role deletion uses its named confirmation dialog');
assert.match(employeePage, /Are you sure you want to delete this role\?/, 'role confirmation has the expected prompt');
assert.match(employeePage, /Confirm Department Deletion/, 'department deletion uses its named confirmation dialog');
assert.match(employeePage, /Are you sure you want to delete this department\?/, 'department confirmation has the expected prompt');
assert.match(employeePage, /employee-delete-confirmation-actions[\s\S]*?Cancel[\s\S]*?Delete/, 'confirmation dialog exposes Cancel and Delete actions');
assert.match(employeePage, /All existing audit history and business records will be retained\./, 'employee deletion confirmation explains retention');
assert.match(employeePage, /onClick=\{closeDeleteConfirmation\}[^>]*>Cancel/, 'Cancel only closes the confirmation dialog');
assert.match(employeePage, /onClick=\{confirmCatalogDeletion\} disabled=\{deleteSaving \|\| deleteBlocked\}>\{deleteSaving \? 'Deleting…' : deleteConfirmation\.kind === 'employee' \? 'Delete Employee' : 'Delete'\}/, 'a blocked deletion cannot be resubmitted and employee deletion has its explicit label');
assert.match(syncService, /key === 'roleCatalog' \|\| key === 'departmentCatalog'\) continue/, 'catalog deletions do not trigger reason prompts');
assert.match(syncService, /Reason for the Admin deletion or controlled status change in \$\{key\}/, 'reason prompts remain enabled for other controlled ERP changes');
const employeeDeleteRoute = stateRoutes.slice(stateRoutes.indexOf("router.delete('/state/employees/:employeeId'"), stateRoutes.indexOf("router.delete('/state/departmentCatalog/:id'"));
assert.match(employeeDeleteRoute, /requireAdmin/, 'employee deletion route requires Admin authorization');
assert.match(employeeDeleteRoute, /UPDATE erp_sessions SET revoked_at/, 'employee deletion revokes existing sessions transactionally');
assert.match(employeeDeleteRoute, /before_values/, 'employee deletion stores the identity snapshot in its audit record');
assert.doesNotMatch(employeeDeleteRoute, /DELETE\s+FROM\s+erp_audit_log/i, 'employee deletion never deletes audit history');
assert.match(employeePage, /employee-delete-department[^>]*title="Delete Department"/, 'department X has a delete tooltip');
assert.match(employeeStyles, /\.employee-delete-department\s*\{\s*grid-column:\s*3/, 'department X occupies the final desktop grid column');
assert.match(employeeStyles, /@media \(max-width: 680px\)[\s\S]*\.employee-delete-department\s*\{\s*grid-column:\s*2/, 'department X remains at the right edge on small screens');

let server;
let roleCatalogBefore;
let employeesBefore;
let departmentCatalogBefore;
let dependencyRecordKey;
try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured');
  server = startServer();
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* server startup */ }
    await sleep(250);
  }
  assert.ok(ready, 'test server starts');
  const adminLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;
  const state = await getPool().query("SELECT storage_key,data FROM erp_state WHERE storage_key IN ('employees','roleCatalog','departmentCatalog')");
  assert.match((await getPool().query('SELECT current_database() AS name')).rows[0].name, /test/i, 'refuse to mutate a non-test database');
  employeesBefore = state.rows.find((row) => row.storage_key === 'employees')?.data || [];
  roleCatalogBefore = state.rows.find((row) => row.storage_key === 'roleCatalog')?.data || [];
  departmentCatalogBefore = state.rows.find((row) => row.storage_key === 'departmentCatalog')?.data || [];

  const roleId = `delete-test-${Date.now()}`;
  const role = { id: roleId, department: 'Sales Department', name: 'Temporary Delete Test Role', roleKey: `custom_test_${Date.now()}` };
  const first = { id: `${roleId}-one`, employeeId: `${roleId}-one`, name: 'Delete Test One', active: true, department: 'Sales Department', role: role.name, roleKey: role.roleKey, departmentAssignments: [
    { department: 'Sales Department', role: role.name, roleKey: role.roleKey },
    { department: 'Purchase Department', role: 'Purchase Employee', roleKey: 'purchase_employee' }
  ] };
  const second = { id: `${roleId}-two`, employeeId: `${roleId}-two`, name: 'Delete Test Two', active: true, department: 'Sales Department', role: role.name, roleKey: role.roleKey, departmentAssignments: [
    { department: 'Sales Department', role: role.name, roleKey: role.roleKey },
    { department: 'Store Department', role: 'Store Employee', roleKey: 'store_employee' }
  ] };
  const seedRoles = [...roleCatalogBefore, role];
  const seedEmployees = [...employeesBefore, first, second];
  assert.equal((await request(`/api/state/roleCatalog/${roleId}`, { method: 'DELETE' })).status, 401, 'anonymous role deletion is denied');
  assert.equal((await request(`/api/state/roleCatalog/${roleId}`, { method: 'DELETE', token: adminToken })).status, 404, 'role must exist before attempting deletion');
  assert.equal((await request('/api/state/roleCatalog/undefined', { method: 'DELETE', token: adminToken })).status, 400, 'missing role IDs are rejected clearly');
  assert.equal((await request('/api/state/roleCatalog', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: seedRoles }) })).status, 200);
  assert.equal((await request('/api/state/employees', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: seedEmployees }) })).status, 200);

  const employeeCredential = employeesBefore.find((employee) => employee?.active !== false && employee.email && employee.password && String(employee.roleKey).toLowerCase() !== 'administrator');
  assert.ok(employeeCredential, 'test database has an employee login');
  const employeeLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: employeeCredential.email, password: employeeCredential.password, portal: 'employee' }) });
  assert.equal(employeeLogin.status, 200, 'employee login works for API authorization check');
  assert.equal((await request(`/api/state/roleCatalog/${roleId}`, { method: 'DELETE', token: employeeLogin.data.token })).status, 403, 'non-admin role deletion is denied by API');
  assert.equal((await request('/api/state/departmentCatalog/not-a-department', { method: 'DELETE', token: employeeLogin.data.token })).status, 403, 'non-admin department deletion is denied by API');

  const blockedBoth = await request(`/api/state/roleCatalog/${roleId}`, { method: 'DELETE', token: adminToken });
  assert.equal(blockedBoth.status, 409);
  assert.match(blockedBoth.data.error, /currently in use/i);
  assert.match(blockedBoth.data.error, /Delete Test One/);
  assert.match(blockedBoth.data.error, /Delete Test Two/);

  const oneWithoutRole = { ...first, departmentAssignments: first.departmentAssignments.filter((item) => item.department !== 'Sales Department') };
  const employeesAfterFirstRemoval = employeesBefore.concat([oneWithoutRole, second]);
  assert.equal((await request('/api/state/employees', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: employeesAfterFirstRemoval }) })).status, 200, 'department assignment removal saves');
  const persistedOne = (await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'")).rows[0].data.find((employee) => employee.id === first.id);
  assert.deepEqual(persistedOne.departmentAssignments, [first.departmentAssignments[1]], 'removing one assignment preserves the employee’s other assignment');
  assert.deepEqual((await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'")).rows[0].data.find((employee) => employee.id === second.id).departmentAssignments, second.departmentAssignments, 'another employee assignment remains intact');

  const blockedSecond = await request(`/api/state/roleCatalog/${roleId}`, { method: 'DELETE', token: adminToken });
  assert.equal(blockedSecond.status, 409);
  assert.match(blockedSecond.data.error, /Delete Test Two/);
  assert.doesNotMatch(blockedSecond.data.error, /Delete Test One/);

  const employeesAfterBothRemoval = employeesBefore.concat([
    oneWithoutRole,
    { ...second, departmentAssignments: second.departmentAssignments.filter((item) => item.department !== 'Sales Department') }
  ]);
  assert.equal((await request('/api/state/employees', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: employeesAfterBothRemoval }) })).status, 200);
  assert.equal((await request(`/api/state/roleCatalog/${roleId}`, { method: 'DELETE', token: adminToken })).status, 200, 'unassigned custom role can be deleted');
  assert.ok((await getPool().query("SELECT id FROM erp_audit_log WHERE module='roleCatalog' AND record_id=$1 AND action='DELETE'", [roleId])).rowCount > 0, 'role deletion remains in audit history');
  let savedCatalog = (await getPool().query("SELECT data FROM erp_state WHERE storage_key='roleCatalog'")).rows[0].data;
  assert.ok(!savedCatalog.some((item) => item.id === roleId), 'role deletion is committed to PostgreSQL');
  assert.equal(savedCatalog.length, roleCatalogBefore.length, 'deleting the temporary role preserves catalog entries');
  for (const existingRole of roleCatalogBefore) assert.ok(savedCatalog.some((item) => item.name === existingRole.name && item.department === existingRole.department), `existing role ${existingRole.name} remains unchanged`);

  const legacyRole = { department: 'Sales Department', name: 'Temporary Legacy ID Role', roleKey: `custom_legacy_${Date.now()}` };
  assert.equal((await request('/api/state/roleCatalog', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: [...savedCatalog, legacyRole] }) })).status, 200);
  const roleCatalogWithBackfill = (await request('/api/state/roleCatalog', { token: adminToken })).data.data;
  const migratedRole = roleCatalogWithBackfill.find((item) => item.name === legacyRole.name);
  assert.ok(migratedRole?.id, 'legacy roles receive a persisted stable ID');
  assert.equal((await request('/api/state/roleCatalog', { token: adminToken })).data.data.find((item) => item.name === legacyRole.name).id, migratedRole.id, 'legacy role ID stays stable after refresh');
  assert.equal((await request(`/api/state/roleCatalog/${migratedRole.id}`, { method: 'DELETE', token: adminToken })).status, 200, 'backfilled custom role ID reaches the delete API');
  savedCatalog = (await getPool().query("SELECT data FROM erp_state WHERE storage_key='roleCatalog'")).rows[0].data;

  const builtIn = { id: `${roleId}-builtin`, department: 'Sales Department', name: 'Sales Executive', roleKey: 'sales_executive' };
  assert.equal((await request('/api/state/roleCatalog', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: [...savedCatalog, builtIn] }) })).status, 400, 'built-in roles cannot be inserted into the custom role catalog');

  const departmentName = `Temporary Department ${Date.now()}`;
  const customDepartment = { name: departmentName };
  assert.equal((await request('/api/state/departmentCatalog', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: [...departmentCatalogBefore, customDepartment] }) })).status, 200);
  const persistedDepartment = (await request('/api/state/departmentCatalog', { token: adminToken })).data.data.find((item) => item.name === departmentName);
  const departmentId = persistedDepartment?.id;
  assert.ok(departmentId, 'legacy department receives a persisted stable ID');
  assert.equal((await request(`/api/state/departmentCatalog/${departmentId}`, { method: 'DELETE' })).status, 401, 'anonymous department deletion is denied');
  const departmentRole = { id: `${departmentId}-role`, department: departmentName, name: 'Temporary Department Role', roleKey: `custom_department_${Date.now()}` };
  assert.equal((await request('/api/state/roleCatalog', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: [...savedCatalog, departmentRole] }) })).status, 200);
  const departmentEmployee = { id: `${departmentId}-employee`, employeeId: `${departmentId}-employee`, name: 'Department Delete Test', active: true, department: departmentName, role: departmentRole.name, roleKey: departmentRole.roleKey, departmentAssignments: [{ department: departmentName, role: departmentRole.name, roleKey: departmentRole.roleKey }] };
  const employeesWithDepartmentUser = employeesAfterBothRemoval.concat(departmentEmployee);
  assert.equal((await request('/api/state/employees', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: employeesWithDepartmentUser }) })).status, 200);
  const blockedDepartmentUser = await request(`/api/state/departmentCatalog/${departmentId}`, { method: 'DELETE', token: adminToken });
  assert.equal(blockedDepartmentUser.status, 409);
  assert.match(blockedDepartmentUser.data.error, /Department Delete Test/);
  assert.equal((await request(`/api/state/departmentCatalog/${departmentId}/deactivate`, { method: 'POST', token: employeeLogin.data.token })).status, 403, 'non-admin department deactivation is denied by API');
  assert.equal((await request(`/api/state/departmentCatalog/${departmentId}/deactivate`, { method: 'POST', token: adminToken })).status, 200, 'Admin can safely deactivate an in-use department');
  const deactivatedDepartments = (await request('/api/state/departmentCatalog', { token: adminToken })).data.data;
  assert.equal(deactivatedDepartments.find((item) => item.id === departmentId).active, false, 'deactivation persists in the catalog');
  const assignedEmployeeAfterDeactivation = (await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'")).rows[0].data.find((employee) => employee.id === departmentEmployee.id);
  assert.deepEqual(assignedEmployeeAfterDeactivation.departmentAssignments, departmentEmployee.departmentAssignments, 'deactivation preserves existing employee assignments');
  assert.ok((await getPool().query("SELECT data FROM erp_state WHERE storage_key='roleCatalog'")).rows[0].data.some((item) => item.id === departmentRole.id), 'deactivation preserves scoped role records');
  const employeeWithoutCustomDepartment = { ...departmentEmployee, department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee', departmentAssignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }] };
  assert.equal((await request('/api/state/employees', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: employeesAfterBothRemoval.concat(employeeWithoutCustomDepartment) }) })).status, 200, 'test employee can be reassigned away from custom department');
  const blockedDepartmentRole = await request(`/api/state/departmentCatalog/${departmentId}`, { method: 'DELETE', token: adminToken });
  assert.equal(blockedDepartmentRole.status, 409);
  assert.match(blockedDepartmentRole.data.error, /custom roles exist/i);
  assert.equal((await request(`/api/state/roleCatalog/${departmentRole.id}`, { method: 'DELETE', token: adminToken })).status, 200);
  dependencyRecordKey = `${departmentId}-record`;
  await getPool().query('INSERT INTO erp_state(storage_key,data,updated_at) VALUES ($1,$2::jsonb,now())', [dependencyRecordKey, JSON.stringify([{ id: 'machine-test', department: departmentName }])]);
  const blockedDepartmentRecord = await request(`/api/state/departmentCatalog/${departmentId}`, { method: 'DELETE', token: adminToken });
  assert.equal(blockedDepartmentRecord.status, 409);
  assert.match(blockedDepartmentRecord.data.error, new RegExp(dependencyRecordKey));
  await getPool().query('DELETE FROM erp_state WHERE storage_key=$1', [dependencyRecordKey]);
  dependencyRecordKey = null;
  assert.equal((await request(`/api/state/departmentCatalog/${departmentId}`, { method: 'DELETE', token: adminToken })).status, 200, 'unused custom department master can be deleted');
  assert.ok((await getPool().query("SELECT id FROM erp_audit_log WHERE module='departmentCatalog' AND record_id=$1 AND action='DELETE'", [departmentId])).rowCount > 0, 'department deletion remains in audit history');
  const builtInDepartment = { id: `${departmentId}-builtin`, name: 'Sales Department' };
  assert.equal((await request('/api/state/departmentCatalog', { method: 'PUT', token: adminToken, body: JSON.stringify({ data: [...departmentCatalogBefore, builtInDepartment] }) })).status, 400, 'built-in departments cannot be stored as custom departments');

  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  server = startServer();
  ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* restarted server startup */ }
    await sleep(250);
  }
  assert.ok(ready, 'server restarts');
  savedCatalog = (await getPool().query("SELECT data FROM erp_state WHERE storage_key='roleCatalog'")).rows[0].data;
  assert.ok(!savedCatalog.some((item) => item.id === roleId), 'role deletion persists through server restart');
  const savedDepartments = (await getPool().query("SELECT data FROM erp_state WHERE storage_key='departmentCatalog'")).rows[0].data;
  assert.ok(!savedDepartments.some((item) => item.id === departmentId), 'department deletion persists through server restart');
  console.log('Employee assignment, custom role, and department deletion checks passed, including dependency protection, Admin authorization, unrelated assignment preservation, PostgreSQL persistence, and restart persistence.');
} finally {
  if (server) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)).catch(() => {}); }
  if (employeesBefore) await getPool().query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES ('employees',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [JSON.stringify(employeesBefore)]).catch(() => {});
  if (roleCatalogBefore) await getPool().query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES ('roleCatalog',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [JSON.stringify(roleCatalogBefore)]).catch(() => {});
  if (departmentCatalogBefore) await getPool().query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES ('departmentCatalog',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [JSON.stringify(departmentCatalogBefore)]).catch(() => {});
  if (dependencyRecordKey) await getPool().query('DELETE FROM erp_state WHERE storage_key=$1', [dependencyRecordKey]).catch(() => {});
  await closeDatabase().catch(() => {});
}
