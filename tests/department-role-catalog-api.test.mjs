import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { getPool, closeDatabase } from '../server/database.js';

const testDatabaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing department/role catalog tests outside vyavastha_test.');
}
process.env.ERP_TEST_MODE = '1';
process.env.ERP_TEST_DATABASE_URL = testDatabaseUrl;
const pool = getPool();
assert.equal((await pool.query('SELECT current_database() AS name')).rows[0]?.name, 'vyavastha_test',
  'department/role catalog test writes are restricted to vyavastha_test');

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
const legacyDepartment = { id: `legacy-dept-${suffix}`, name: `Legacy Dept ${suffix}`, active: true };
const unselectedLegacyDepartment = {
  id: `legacy-dept-unselected-${suffix}`, name: `Unselected Legacy Dept ${suffix}`, active: true
};
const legacyRole = {
  id: `legacy-role-${suffix}`, departmentId: legacyDepartment.id, department: legacyDepartment.name,
  name: `Legacy Role ${suffix}`, roleKey: `legacy_${suffix.replace(/[^a-z0-9]+/gi, '_')}`, active: true
};
const legacyPermission = {
  departmentId: legacyDepartment.id, roleId: legacyRole.id, department: legacyDepartment.name,
  roleKey: legacyRole.roleKey, permissions: ['inventory.view']
};
const crudDepartment = { id: `crud-dept-${suffix}`, name: `CRUD Dept ${suffix}`, active: true };
const conflictRole = {
  id: `legacy-role-conflict-${suffix}`, departmentId: legacyDepartment.id, department: legacyDepartment.name,
  name: `Legacy Role ${suffix} Updated`, roleKey: `legacy_${suffix.replace(/[^a-z0-9]+/gi, '_')}_updated`, active: true
};
const testEmployee = {
  id: `catalog-employee-${suffix}`, employeeId: `CATALOG-${suffix}`.toUpperCase(),
  name: `Catalog Test Employee ${suffix}`, email: `catalog-${suffix}@example.invalid`,
  password: `Catalog-${suffix}!2`, active: true, department: 'Sales', role: 'Sales Employee', roleKey: 'sales_employee',
  departmentAssignments: [{ department: 'Sales', role: 'Sales Employee', roleKey: 'sales_employee' }]
};
const legacyKeys = ['departmentCatalog', 'roleCatalog', 'rolePermissions'];
let legacySnapshotBefore = null;
let server;
let adminToken = '';
let employeeCreated = false;
const tokens = [];
const failures = [];

try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured');
  const before = await pool.query(
    'SELECT storage_key,data,updated_at FROM erp_state WHERE storage_key=ANY($1::text[])',
    [legacyKeys]
  );
  legacySnapshotBefore = new Map(before.rows.map((row) => [row.storage_key, { data: row.data, updatedAt: row.updated_at }]));
  const fixture = {
    departmentCatalog: [legacyDepartment, unselectedLegacyDepartment],
    roleCatalog: [legacyRole],
    rolePermissions: [legacyPermission]
  };
  for (const [key, data] of Object.entries(fixture)) {
    await pool.query(
      `INSERT INTO erp_state(storage_key,data,updated_at) VALUES($1,$2::jsonb,now())
       ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
      [key, JSON.stringify(data)]
    );
  }

  server = startServer();
  assert.ok(await waitForServer(), 'test Express server starts');
  const adminLogin = await request('/api/auth/login', {
    method: 'POST', body: json({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
  });
  assert.equal(adminLogin.status, 200, `Admin login works (${adminLogin.data.error || ''})`);
  adminToken = adminLogin.data.token;

  assert.equal((await request('/api/organization-catalogs/legacy/preview')).status, 401,
    'legacy preview requires authentication');
  assert.equal((await request('/api/organization-catalogs/legacy/preview', { token: adminToken })).status, 200);
  const preview = (await request('/api/organization-catalogs/legacy/preview', { token: adminToken })).data.entries;
  for (const expected of [
    { kind: 'department', key: legacyDepartment.id },
    { kind: 'department', key: unselectedLegacyDepartment.id },
    { kind: 'role', key: legacyRole.id },
    { kind: 'permission', key: `${legacyDepartment.id}::${legacyRole.id}` }
  ]) {
    assert.equal(preview.find((entry) => entry.kind === expected.kind && entry.key === expected.key)?.status, 'eligible',
      `${expected.kind} legacy record is previewed as eligible`);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM department_catalog WHERE id=ANY($1::text[])', [
    [legacyDepartment.id, unselectedLegacyDepartment.id]
  ])).rows[0].count, 0, 'legacy preview does not automatically import records');

  const importToken = `catalog-import-${suffix}`;
  tokens.push(importToken);
  const selected = [
    { kind: 'department', key: legacyDepartment.id },
    { kind: 'role', key: legacyRole.id },
    { kind: 'permission', key: `${legacyDepartment.id}::${legacyRole.id}` }
  ];
  const imported = await request('/api/organization-catalogs/legacy/import', {
    method: 'POST', token: adminToken, body: json({ selected, idempotencyToken: importToken })
  });
  assert.equal(imported.status, 201, `Admin-selected import succeeds (${imported.data.error || ''})`);
  assert.equal(imported.data.imported.length, 3, 'only the three explicitly selected legacy records are imported');
  assert.equal(imported.data.legacySnapshotPreserved, true);
  const retry = await request('/api/organization-catalogs/legacy/import', {
    method: 'POST', token: adminToken, body: json({ selected, idempotencyToken: importToken })
  });
  assert.equal(retry.status, 200, 'identical import retry is idempotent');
  assert.deepEqual(retry.data, imported.data);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM department_catalog WHERE id=$1', [legacyDepartment.id])).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM department_catalog WHERE id=$1', [unselectedLegacyDepartment.id])).rows[0].count, 0,
    'legacy records not selected for import remain only in the preserved snapshot');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM role_catalog WHERE id=$1', [legacyRole.id])).rows[0].count, 1);
  assert.deepEqual((await pool.query(
    'SELECT permissions FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2', [legacyDepartment.id, legacyRole.id]
  )).rows[0].permissions, ['inventory.view']);

  const legacyCollision = await request('/api/organization-catalogs/departments', {
    method: 'POST', token: adminToken,
    body: json({ data: legacyDepartment, idempotencyToken: `catalog-duplicate-${suffix}` })
  });
  assert.equal(legacyCollision.status, 409, 'new catalog records cannot duplicate preserved legacy identifiers or names');

  const createToken = `catalog-department-${suffix}`;
  tokens.push(createToken);
  const create = await request('/api/organization-catalogs/departments', {
    method: 'POST', token: adminToken, body: json({ data: crudDepartment, idempotencyToken: createToken })
  });
  assert.equal(create.status, 201, `department CRUD create succeeds (${create.data.error || ''})`);
  const createRetry = await request('/api/organization-catalogs/departments', {
    method: 'POST', token: adminToken, body: json({ data: crudDepartment, idempotencyToken: createToken })
  });
  assert.equal(createRetry.status, 200, 'identical department create retry returns the prior response');
  assert.deepEqual(createRetry.data, create.data);
  const employeeToken = `catalog-employee-create-${suffix}`;
  tokens.push(employeeToken);
  const employeeCreate = await request('/api/employees', {
    method: 'POST', token: adminToken, body: json({ data: testEmployee, createToken: employeeToken })
  });
  assert.equal(employeeCreate.status, 201, `test employee is created (${employeeCreate.data.error || ''})`);
  employeeCreated = true;
  const employeeLogin = await request('/api/auth/login', {
    method: 'POST', body: json({ email: testEmployee.email, password: testEmployee.password, portal: 'employee' })
  });
  assert.equal(employeeLogin.status, 200, 'existing employee login behavior remains available');
  assert.equal((await request('/api/organization-catalogs/legacy/preview', { token: employeeLogin.data.token })).status, 403,
    'legacy preview is Admin-only');
  const unauthorizedCreate = await request('/api/organization-catalogs/departments', {
    method: 'POST', token: employeeLogin.data.token,
    body: json({ data: { id: `unauthorized-${suffix}`, name: `Unauthorized ${suffix}` }, idempotencyToken: `unauthorized-create-${suffix}` })
  });
  assert.equal(unauthorizedCreate.status, 403, 'employee cannot create catalog records');

  const updateToken = `catalog-dept-update-${suffix}`;
  tokens.push(updateToken);
  const updatedName = `${crudDepartment.name} Updated`;
  const update = await request(`/api/organization-catalogs/departments/${crudDepartment.id}`, {
    method: 'PUT', token: adminToken,
    body: json({ data: { name: updatedName }, version: 1, idempotencyToken: updateToken })
  });
  assert.equal(update.status, 200, `department update succeeds (${update.data.error || ''})`);
  assert.equal(update.data.record.version, 2);
  const staleUpdate = await request(`/api/organization-catalogs/departments/${crudDepartment.id}`, {
    method: 'PUT', token: adminToken,
    body: json({ data: { name: 'Stale Rename' }, version: 1, idempotencyToken: `catalog-dept-stale-${suffix}` })
  });
  assert.equal(staleUpdate.status, 409, 'stale catalog versions are rejected');

  const deleteToken = `catalog-dept-delete-${suffix}`;
  tokens.push(deleteToken);
  const removed = await request(`/api/organization-catalogs/departments/${crudDepartment.id}`, {
    method: 'DELETE', token: adminToken,
    body: json({ version: update.data.record.version, reason: 'Automated catalog lifecycle test', idempotencyToken: deleteToken })
  });
  assert.equal(removed.status, 200, `department soft-delete succeeds (${removed.data.error || ''})`);
  assert.ok(removed.data.record.deletedAt);
  const restoreToken = `catalog-dept-restore-${suffix}`;
  tokens.push(restoreToken);
  const restored = await request(`/api/organization-catalogs/departments/${crudDepartment.id}/restore`, {
    method: 'POST', token: adminToken,
    body: json({ version: removed.data.record.version, reason: 'Restore after lifecycle test', idempotencyToken: restoreToken })
  });
  assert.equal(restored.status, 200, `department restore succeeds (${restored.data.error || ''})`);
  assert.equal(restored.data.record.id, crudDepartment.id, 'restoration preserves stable department ID');
  assert.equal(restored.data.record.active, true);

  const roleUpdateToken = `catalog-role-update-${suffix}`;
  tokens.push(roleUpdateToken);
  const updatedRole = await request(`/api/organization-catalogs/roles/${legacyRole.id}`, {
    method: 'PUT', token: adminToken,
    body: json({
      data: { name: `${legacyRole.name} Updated`, roleKey: `${legacyRole.roleKey}_updated` },
      version: 1, idempotencyToken: roleUpdateToken
    })
  });
  assert.equal(updatedRole.status, 200, `role update succeeds (${updatedRole.data.error || ''})`);
  assert.equal(updatedRole.data.record.version, 2);
  assert.equal((await pool.query(
    'SELECT role_key FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2', [legacyDepartment.id, legacyRole.id]
  )).rows[0].role_key, updatedRole.data.record.roleKey, 'permission metadata follows a role identifier update');
  const staleRoleUpdate = await request(`/api/organization-catalogs/roles/${legacyRole.id}`, {
    method: 'PUT', token: adminToken,
    body: json({ data: { name: 'Stale Role Rename', roleKey: 'stale_role' }, version: 1, idempotencyToken: `catalog-role-stale-${suffix}` })
  });
  assert.equal(staleRoleUpdate.status, 409, 'stale role catalog versions are rejected');
  const deletedRole = await request(`/api/organization-catalogs/roles/${legacyRole.id}`, {
    method: 'DELETE', token: adminToken,
    body: json({ version: updatedRole.data.record.version, reason: 'Prepare restore conflict test', idempotencyToken: `catalog-role-delete-${suffix}` })
  });
  tokens.push(`catalog-role-delete-${suffix}`);
  assert.equal(deletedRole.status, 200);
  const conflictRoleToken = `catalog-role-conflict-${suffix}`;
  tokens.push(conflictRoleToken);
  const createdConflictRole = await request('/api/organization-catalogs/roles', {
    method: 'POST', token: adminToken,
    body: json({ data: conflictRole, idempotencyToken: conflictRoleToken })
  });
  assert.equal(createdConflictRole.status, 201, 'a replacement role can claim an identifier after the old role is deleted');
  const blockedRestore = await request(`/api/organization-catalogs/roles/${legacyRole.id}/restore`, {
    method: 'POST', token: adminToken,
    body: json({ version: deletedRole.data.record.version, reason: 'Expected uniqueness conflict', idempotencyToken: `catalog-role-blocked-restore-${suffix}` })
  });
  tokens.push(`catalog-role-blocked-restore-${suffix}`);
  assert.equal(blockedRestore.status, 409, 'restore rejects a conflicting active role');
  const deleteConflictToken = `catalog-role-delete-conflict-${suffix}`;
  tokens.push(deleteConflictToken);
  const deletedConflictRole = await request(`/api/organization-catalogs/roles/${conflictRole.id}`, {
    method: 'DELETE', token: adminToken,
    body: json({ version: createdConflictRole.data.record.version, reason: 'Remove conflict after assertion', idempotencyToken: deleteConflictToken })
  });
  assert.equal(deletedConflictRole.status, 200);
  const restoredRole = await request(`/api/organization-catalogs/roles/${legacyRole.id}/restore`, {
    method: 'POST', token: adminToken,
    body: json({ version: deletedRole.data.record.version, reason: 'Restore after uniqueness conflict was removed', idempotencyToken: `catalog-role-restore-${suffix}` })
  });
  tokens.push(`catalog-role-restore-${suffix}`);
  assert.equal(restoredRole.status, 200, `role restores after conflict removal (${restoredRole.data.error || ''})`);

  const legacyRows = await pool.query(
    'SELECT storage_key,data FROM erp_state WHERE storage_key=ANY($1::text[])',
    [legacyKeys]
  );
  const afterSnapshots = new Map(legacyRows.rows.map((row) => [row.storage_key, row.data]));
  for (const [key, data] of Object.entries(fixture)) {
    assert.deepEqual(afterSnapshots.get(key), data, `${key} remains unchanged after preview and selected import`);
  }
  const importAudit = await pool.query(
    "SELECT count(*)::int AS count FROM erp_audit_log WHERE action='LEGACY_IMPORT' AND record_id=ANY($1::text[])",
    [[legacyDepartment.id, legacyRole.id, `${legacyDepartment.id}::${legacyRole.id}`]]
  );
  assert.ok(importAudit.rows[0].count >= 3, 'selected import creates audit history for each catalog item');

  console.log('Department and role catalog integration passed: Admin-only preview/import, explicit selected reconciliation, retry idempotency, duplicate protection, version checks, soft-delete/restore, audit history, login compatibility and preserved legacy snapshots.');
} catch (error) {
  failures.push(error);
} finally {
  try {
    if (server) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)).catch(() => {}); }
    if (employeeCreated) {
      await pool.query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [testEmployee.email]);
      await pool.query('DELETE FROM employees WHERE id=$1', [testEmployee.id]);
    }
    await pool.query('DELETE FROM role_permission_catalog WHERE department_id=$1 AND role_id=$2', [legacyDepartment.id, legacyRole.id]);
    await pool.query('DELETE FROM role_catalog WHERE id=ANY($1::text[])', [[legacyRole.id, conflictRole.id]]);
    await pool.query('DELETE FROM department_catalog WHERE id=ANY($1::text[])', [[legacyDepartment.id, crudDepartment.id]]);
    if (tokens.length) await pool.query('DELETE FROM master_idempotency WHERE token=ANY($1::text[])', [tokens]);
    if (legacySnapshotBefore) {
      for (const key of legacyKeys) {
        const existing = legacySnapshotBefore.get(key);
        if (existing) {
          await pool.query(
            `INSERT INTO erp_state(storage_key,data,updated_at) VALUES($1,$2::jsonb,$3)
             ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at`,
            [key, JSON.stringify(existing.data), existing.updatedAt]
          );
        } else {
          await pool.query('DELETE FROM erp_state WHERE storage_key=$1', [key]);
        }
      }
    }
  } catch (cleanupError) {
    failures.push(cleanupError);
  }
  await closeDatabase().catch(() => {});
}

if (failures.length) {
  for (const error of failures) console.error(error);
  process.exitCode = 1;
}
