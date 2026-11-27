/**
 * Guarded PostgreSQL integration test for the Phase 8 master-data API.
 *
 * The test harness mounts server/masterRoutes.js at /api/masters without
 * editing server.js. It runs only against vyavastha_test and removes only rows
 * created by this test (legacy erp_state values are restored exactly).
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import pg from 'pg';
import { runMigrations } from '../server/database.js';

const testDatabaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing to use DATABASE_URL.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) {
  throw new Error('ERP_ADMIN_EMAIL / ERP_ADMIN_PASSWORD are required for the isolated master API test.');
}
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//, ''));
if (databaseName !== 'vyavastha_test') throw new Error('Refusing master API test unless ERP_TEST_DATABASE_URL names exactly vyavastha_test.');

const pool = new pg.Pool({ connectionString: testDatabaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing master API test writes: current_database() is not exactly vyavastha_test.');
}

const previousTestMode = process.env.ERP_TEST_MODE;
process.env.ERP_TEST_MODE = '1';
await runMigrations(pool);
if (previousTestMode === undefined) delete process.env.ERP_TEST_MODE;
else process.env.ERP_TEST_MODE = previousTestMode;

const prefix = `MASTAPI-${Date.now()}-${randomUUID().slice(0, 8)}`.toUpperCase();
const legacyKey = 'customerDirectory';
const priorLegacy = await pool.query('SELECT data,updated_at FROM erp_state WHERE storage_key=$1', [legacyKey]);
const priorVendorLegacy = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='vendorMaster'");
const priorMachineLegacy = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='machines'");
const priorCompanyLegacy = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='companySettings'");
const priorCompanySettings = await pool.query("SELECT * FROM company_settings WHERE id='primary'");
const priorCompanyAudit = await pool.query("SELECT id FROM erp_audit_log WHERE module='Master Data: Company Settings' AND record_id='primary'");
let child = null;
let token = '';
let nonAdminHash = '';
let crossUserHash = '';
let assertions = 0;
let childLog = '';

const check = (condition, label) => {
  assert.ok(condition, label);
  assertions += 1;
  console.log(`PASS ${label}`);
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const harness = `
import 'dotenv/config';
import express from 'express';
import { runMigrations } from './server/database.js';
import { authRouter, authenticateRequest } from './server/auth.js';
import masterRouter from './server/masterRoutes.js';

await runMigrations();
const app = express();
app.use(express.json({ limit: '120mb' }));
app.use('/api/auth', authRouter);
app.get('/api/health', (_req, res) => res.json({
  ready: true,
  database: { migrations: [{ version: '041_master_gaps' }] }
}));
app.use('/api', authenticateRequest);
app.use('/api/masters', masterRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));
const server = app.listen(Number(process.env.PORT), '127.0.0.1');
server.on('error', (error) => { console.error(error); process.exit(1); });
`;

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const api = async (path, options = {}, withToken = true) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(withToken && token ? { Authorization: `Bearer ${token}`, 'X-ERP-Department': 'Admin' } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: testDatabaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { childLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childLog += chunk.toString(); });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const health = await api('/api/health', {}, false);
      if (health.status === 200 && health.body.ready && health.body.database?.migrations?.some((m) => m.version === '041_master_gaps')) return;
    } catch { /* server not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Isolated master API server did not become ready. ${childLog.slice(-2000)}`);
};

const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  child = null;
};

const gstin = '29ABCDE1234F1Z5';
const legacyCustomer = (suffix, companyName, contact, phone) => ({
  id: `${prefix}-${suffix}`,
  companyName,
  customerName: contact,
  customerCode: `${prefix}-CODE-${suffix}`,
  gstin,
  phone,
  email: `${suffix.toLowerCase()}@example.com`,
  address: `${suffix} Street`,
  state: 'KA',
  pincode: '560001',
  status: 'Active'
});

try {
  await start();
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
  }, false);
  token = login.body.token || '';
  check(login.status === 200 && Boolean(token), 'Administrator authentication succeeds');

  const denied = await api('/api/masters/customers', {}, false);
  check(denied.status === 401, 'Unauthenticated master reads are rejected');

  // A real session whose role is not Administrator must not be able to preview
  // or import legacy master records, even though it is authenticated.
  const nonAdminToken = `${prefix}-NONADMIN`;
  nonAdminHash = createHash('sha256').update(nonAdminToken).digest('hex');
  await pool.query(
    `INSERT INTO erp_sessions (token_hash,user_id,email,display_name,role,role_key,department,employee_id,expires_at)
     VALUES ($1,'admin',$2,'Non Admin Test','Employee','employee','Admin','-',now() + interval '1 hour')`,
    [nonAdminHash, process.env.ERP_ADMIN_EMAIL]
  );
  const nonAdminHeaders = { Authorization: `Bearer ${nonAdminToken}` };
  const crossUserToken = `${prefix}-CROSS-USER`;
  crossUserHash = createHash('sha256').update(crossUserToken).digest('hex');
  const crossUserId = `${prefix}-PURCHASE-USER`;
  const crossUserEmail = `${prefix.toLowerCase()}@example.com`;
  const employeeAssignments = [{ department: 'Purchase Department', role: 'Purchase Employee', roleKey: 'purchase_employee' }];
  await pool.query(
    `INSERT INTO employees(id,employee_id,name,email,password_hash,active,department,role,role_key,department_assignments,payload,created_by,updated_by)
     VALUES($1,$1,'Cross User Purchase Test',$2,'',true,'Purchase Department','Purchase Employee','purchase_employee',$3::jsonb,'{}'::jsonb,'master-api-test','master-api-test')`,
    [crossUserId, crossUserEmail, JSON.stringify(employeeAssignments)]
  );
  await pool.query(
    `INSERT INTO erp_sessions (token_hash,user_id,email,display_name,role,role_key,department,employee_id,expires_at)
     VALUES ($1,$2,$3,'Cross User Purchase Test','Purchase Employee','purchase_employee','Purchase Department',$2,now() + interval '1 hour')`,
    [crossUserHash, crossUserId, crossUserEmail]
  );
  const deniedPreview = await api('/api/masters/customers/legacy/preview', { headers: nonAdminHeaders }, false);
  check(deniedPreview.status === 403, 'Legacy preview is administrator-only');
  const deniedImport = await api('/api/masters/customers/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: ['unknown'], idempotencyToken: `${prefix}-NONADMIN-IMPORT` }),
    headers: nonAdminHeaders
  }, false);
  check(deniedImport.status === 403, 'Selected legacy import is administrator-only');

  const mainId = `${prefix}-MAIN`;
  const mainPayload = {
    id: mainId,
    companyName: `${prefix} Primary Co`,
    customerName: 'Primary Contact',
    customerCode: `${prefix}-CODE-MAIN`,
    gstin,
    phone: '9880012345',
    email: 'primary@example.com',
    address: '12 Main Road',
    state: 'KA',
    pincode: '560001'
  };
  const createToken = `${prefix}-CREATE-MAIN`;
  const created = await api('/api/masters/customers', { method: 'POST', body: JSON.stringify({ data: mainPayload, createToken }) });
  check(created.status === 201 && created.body.record.version === 1, 'Create returns a PostgreSQL-confirmed master record');
  check(created.body.record.customerCode === mainPayload.customerCode, 'Customer codes are preserved through the API');

  const replay = await api('/api/masters/customers', { method: 'POST', body: JSON.stringify({ data: mainPayload, createToken }) });
  check(replay.status === 200 && replay.body.idempotentReplay === true, 'Replaying a create token is idempotent');

  const list = await api('/api/masters/customers');
  check(list.status === 200 && list.body.records.filter((record) => record.id === mainId).length === 1, 'List reads from PostgreSQL and never duplicates a replayed create');

  const updateA = { ...mainPayload, address: 'Version A' };
  const updateB = { ...mainPayload, address: 'Version B' };
  const edits = await Promise.all([
    api(`/api/masters/customers/${mainId}`, { method: 'PUT', body: JSON.stringify({ data: updateA, version: 1, idempotencyToken: `${prefix}-EDIT-A` }) }),
    api(`/api/masters/customers/${mainId}`, { method: 'PUT', body: JSON.stringify({ data: updateB, version: 1, idempotencyToken: `${prefix}-EDIT-B` }) })
  ]);
  check(edits.filter((result) => result.status === 200).length === 1 && edits.filter((result) => result.status === 409).length === 1, 'Concurrent edits reject the stale PostgreSQL version');
  const versionRow = await pool.query('SELECT version FROM customers WHERE id=$1', [mainId]);
  check(Number(versionRow.rows[0]?.version) === 2, 'PostgreSQL records exactly one winning version update');

  const uomId = `${prefix}-UNIT`;
  const uomPayload = { id: uomId, code: `UOM-${prefix}`, name: 'Test Unit', symbol: 'TU' };
  const uomCreated = await api('/api/masters/uoms', { method: 'POST', body: JSON.stringify({ data: uomPayload, createToken: `${prefix}-UOM-1` }) });
  check(uomCreated.status === 201, 'UOM master create succeeds');
  const duplicateUom = await api('/api/masters/uoms', {
    method: 'POST',
    body: JSON.stringify({ data: { id: `${prefix}-UNIT-DUP`, code: uomPayload.code, name: 'Duplicate Unit' }, createToken: `${prefix}-UOM-2` })
  });
  check(duplicateUom.status === 409, 'Duplicate UOM codes are rejected before insert');
  const deletedUom = await api(`/api/masters/uoms/${uomId}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: 1, reason: 'isolated master API test', idempotencyToken: `${prefix}-UOM-DEL` })
  });
  check(deletedUom.status === 200, 'UOM soft-delete is confirmed');
  const reuseUom = await api('/api/masters/uoms', {
    method: 'POST',
    body: JSON.stringify({ data: { id: `${prefix}-UNIT-REUSE`, code: uomPayload.code, name: 'Reused Unit' }, createToken: `${prefix}-UOM-3` })
  });
  check(reuseUom.status === 409, 'A deleted UOM code cannot be reused or resurrected');

  const removed = await api(`/api/masters/customers/${mainId}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: 2, reason: 'isolated master API test', idempotencyToken: `${prefix}-DELETE-MAIN` })
  });
  check(removed.status === 200, 'Admin soft-delete is confirmed');
  const deletion = await pool.query('SELECT deleted_at,deleted_by,delete_reason FROM customers WHERE id=$1', [mainId]);
  check(Boolean(deletion.rows[0]?.deleted_at) && deletion.rows[0].deleted_by === process.env.ERP_ADMIN_EMAIL && deletion.rows[0].delete_reason === 'isolated master API test', 'Soft-delete metadata is durable in PostgreSQL');
  check((await api(`/api/masters/customers/${mainId}`)).status === 404, 'Deleted records are excluded from active reads');
  check((await api('/api/masters/customers?includeDeleted=1')).body.records.some((record) => record.id === mainId), 'Administrators can review tombstones explicitly');
  const resurrect = await api('/api/masters/customers', {
    method: 'POST',
    body: JSON.stringify({ data: mainPayload, createToken: `${prefix}-RESURRECT` })
  });
  check(resurrect.status === 409, 'Retrying a deleted master ID cannot restore it');

  const history = await api(`/api/masters/customers/${mainId}/history`);
  const actions = (history.body.entries || []).map((entry) => entry.action);
  check(['CREATE', 'UPDATE', 'SOFT_DELETE'].every((action) => actions.includes(action)), 'Create, edit and deletion audit history is retained');

  const ident = legacyCustomer('IDENT', 'Identical Legacy Co', 'Identical Contact', '9876543210');
  const conflict = legacyCustomer('CONFLICT', 'Conflict Legacy Co', 'Conflict Contact', '9876543211');
  const eligible = legacyCustomer('ELIG', 'Eligible Legacy Co', 'Eligible Contact', '9876543212');
  const invalid = legacyCustomer('INVALID', '', '', '9876543213');
  const tombstoned = legacyCustomer('DEAD', 'Deleted Legacy Co', 'Deleted Contact', '9876543214');
  for (const payload of [ident, { ...conflict, phone: '9999999999' }, tombstoned]) {
    const result = await api('/api/masters/customers', {
      method: 'POST',
      body: JSON.stringify({ data: payload, createToken: `${prefix}-SEED-${payload.id.split('-').pop()}` })
    });
    check(result.status === 201, `Seeded active master ${payload.id.split('-').pop()} for reconciliation`);
  }
  const tombstone = await api(`/api/masters/customers/${tombstoned.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: 1, reason: 'legacy tombstone fixture', idempotencyToken: `${prefix}-SEED-DEAD-DEL` })
  });
  check(tombstone.status === 200, 'Legacy tombstone fixture is soft-deleted');

  await pool.query(
    'INSERT INTO erp_state(storage_key,data) VALUES($1,$2::jsonb) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()',
    [legacyKey, JSON.stringify([ident, conflict, eligible, invalid, tombstoned])]
  );

  const preview = await api(`/api/masters/customers/legacy/preview`);
  check(preview.status === 200 && preview.body.sources?.some((source) => source.storageKey === legacyKey), 'Admin legacy preview reports its source');
  const byId = new Map((preview.body.entries || []).map((entry) => [entry.proposedId, entry]));
  check(byId.get(ident.id)?.status === 'identical', 'Legacy preview classifies unchanged records as identical');
  check(byId.get(conflict.id)?.status === 'conflicting', 'Legacy preview classifies value mismatches as conflicting');
  check(byId.get(eligible.id)?.status === 'eligible', 'Legacy preview classifies new records as eligible');
  check(byId.get(invalid.id)?.status === 'invalid' && byId.get(tombstoned.id)?.status === 'invalid', 'Legacy preview rejects invalid records and tombstones');

  const beforeImport = await api('/api/masters/customers');
  check(!beforeImport.body.records.some((record) => record.id === eligible.id), 'Preview never auto-imports a legacy record');

  const rejectedImport = await api('/api/masters/customers/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [byId.get(eligible.id).key, byId.get(invalid.id).key], idempotencyToken: `${prefix}-IMPORT-BAD` })
  });
  check(rejectedImport.status === 409 && (rejectedImport.body.rejected || []).length === 1, 'Selected import rejects non-eligible records');
  check((await pool.query('SELECT 1 FROM customers WHERE id=$1', [eligible.id])).rowCount === 0, 'A rejected batch rolls back completely');

  const importToken = `${prefix}-IMPORT-GOOD`;
  const imported = await api('/api/masters/customers/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [byId.get(eligible.id).key], idempotencyToken: importToken })
  });
  check(imported.status === 201 && imported.body.imported === 1, 'Administrator-selected import inserts only the chosen eligible record');
  const importedRow = await pool.query('SELECT source_key,legacy_id,company_name FROM customers WHERE id=$1', [eligible.id]);
  check(importedRow.rows[0]?.source_key === `erp_state/${legacyKey}` && importedRow.rows[0]?.legacy_id === byId.get(eligible.id).legacyId, 'Imported records retain their legacy identity for duplicate prevention');
  const importHistory = await api(`/api/masters/customers/${eligible.id}/history`);
  check((importHistory.body.entries || []).some((entry) => entry.action === 'LEGACY_IMPORT'), 'Selected imports are audited');

  const importReplay = await api('/api/masters/customers/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [byId.get(eligible.id).key], idempotencyToken: importToken })
  });
  check(importReplay.status === 200 && importReplay.body.idempotentReplay === true, 'Selected import tokens are idempotent');
  check((await pool.query('SELECT 1 FROM customers WHERE id=$1', [eligible.id])).rowCount === 1, 'Import replay never creates a second legacy record');

  const afterImport = await api('/api/masters/customers/legacy/preview');
  check(new Map((afterImport.body.entries || []).map((entry) => [entry.proposedId, entry])).get(eligible.id)?.status === 'identical', 'Imported legacy records become identical, not eligible again');

  const vendorId = `${prefix}-VENDOR`;
  const vendorData = {
    id: vendorId, vendorCode: `${prefix}-VC`, name: `${prefix} Vendor`,
    email: 'vendor@example.com', phone: '9876543210', address: 'Vendor Test Road'
  };
  const vendorCreateToken = `${prefix}-VENDOR-CREATE`;
  const vendorCreated = await api('/api/masters/vendors', {
    method: 'POST',
    body: JSON.stringify({ data: vendorData, createToken: vendorCreateToken })
  });
  check(vendorCreated.status === 201 && vendorCreated.body.record.version === 1, 'Vendor create persists a versioned PostgreSQL record');
  const vendorReplay = await api('/api/masters/vendors', {
    method: 'POST',
    body: JSON.stringify({ data: vendorData, createToken: vendorCreateToken })
  });
  check(vendorReplay.status === 200 && vendorReplay.body.idempotentReplay === true, 'Vendor create retries are idempotent');
  const vendorDuplicate = await api('/api/masters/vendors', {
    method: 'POST',
    body: JSON.stringify({ data: { ...vendorData, id: `${vendorId}-DUP` }, createToken: `${prefix}-VENDOR-DUPLICATE` })
  });
  check(vendorDuplicate.status === 409, 'Vendor identity duplicates are rejected');
  const vendorList = await api('/api/masters/vendors');
  check(vendorList.status === 200 && vendorList.body.records.some((record) => record.id === vendorId), 'Vendor list is shared from PostgreSQL');
  const crossUserVendorList = await api('/api/masters/vendors', {
    headers: { Authorization: `Bearer ${crossUserToken}`, 'X-ERP-Department': 'Purchase Department' }
  }, false);
  check(crossUserVendorList.status === 200 && crossUserVendorList.body.records.some((record) => record.id === vendorId), 'A separate authorized user sees the shared PostgreSQL vendor');
  const vendorUpdate = await api(`/api/masters/vendors/${vendorId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { ...vendorData, address: 'Updated Vendor Road' }, version: 1, idempotencyToken: `${prefix}-VENDOR-EDIT` })
  });
  check(vendorUpdate.status === 200 && vendorUpdate.body.record.version === 2, 'Vendor update increments its PostgreSQL version');
  const vendorStaleUpdate = await api(`/api/masters/vendors/${vendorId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: vendorData, version: 1, idempotencyToken: `${prefix}-VENDOR-STALE` })
  });
  check(vendorStaleUpdate.status === 409, 'Vendor stale edits are rejected');
  const deniedVendorWrite = await api('/api/masters/vendors', {
    method: 'POST',
    body: JSON.stringify({ data: { ...vendorData, id: `${vendorId}-DENIED` }, createToken: `${prefix}-VENDOR-DENIED` }),
    headers: nonAdminHeaders
  }, false);
  check(deniedVendorWrite.status === 403, 'Vendor writes enforce purchase permissions');
  const vendorDelete = await api(`/api/masters/vendors/${vendorId}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: 2, reason: 'isolated master API test', idempotencyToken: `${prefix}-VENDOR-DELETE` })
  });
  check(vendorDelete.status === 200, 'Vendor deletion uses the existing soft-delete API');

  const legacyVendor = {
    id: `${prefix}-LEGACY-VENDOR`, vendorCode: `${prefix}-LVC`,
    name: `${prefix} Legacy Vendor`, email: 'legacy-vendor@example.com', phone: '9876543211'
  };
  await pool.query(
    `INSERT INTO erp_state(storage_key,data) VALUES('vendorMaster',$1::jsonb)
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([legacyVendor])]
  );
  const vendorPreview = await api('/api/masters/vendors/legacy/preview');
  const vendorCandidate = (vendorPreview.body.entries || []).find((entry) => entry.proposedId === legacyVendor.id);
  check(vendorPreview.status === 200 && vendorCandidate?.status === 'eligible', 'Vendor legacy preview identifies eligible records without importing them');
  const vendorImport = await api('/api/masters/vendors/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [vendorCandidate.key], idempotencyToken: `${prefix}-VENDOR-IMPORT` })
  });
  check(vendorImport.status === 201 && vendorImport.body.imported === 1, 'Vendor legacy import requires an explicit selected Admin action');

  const machineId = `${prefix}-MACHINE`;
  const machineData = { id: machineId, machineId, name: `${prefix} Machine`, type: 'CNC', workCenter: 'Test Cell' };
  const deniedMachineWrite = await api('/api/masters/machines', {
    method: 'POST',
    body: JSON.stringify({ data: machineData, createToken: `${prefix}-MACHINE-DENIED` }),
    headers: nonAdminHeaders
  }, false);
  check(deniedMachineWrite.status === 403, 'Machine writes remain administrator-only');
  const machineCreated = await api('/api/masters/machines', {
    method: 'POST',
    body: JSON.stringify({ data: machineData, createToken: `${prefix}-MACHINE-CREATE` })
  });
  check(machineCreated.status === 201 && machineCreated.body.record.version === 1, 'Machine create persists a versioned PostgreSQL record');
  const machineReplay = await api('/api/masters/machines', {
    method: 'POST',
    body: JSON.stringify({ data: machineData, createToken: `${prefix}-MACHINE-CREATE` })
  });
  check(machineReplay.status === 200 && machineReplay.body.idempotentReplay === true, 'Machine create retries are idempotent');
  const machineList = await api('/api/masters/machines');
  check(machineList.status === 200 && machineList.body.records.some((record) => record.machineId === machineId), 'Machine list reads the shared PostgreSQL master');
  const machineUpdate = await api(`/api/masters/machines/${machineId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { ...machineData, location: 'Updated Cell' }, version: 1, idempotencyToken: `${prefix}-MACHINE-EDIT` })
  });
  check(machineUpdate.status === 200 && machineUpdate.body.record.version === 2, 'Machine update increments its PostgreSQL version');
  const machineStaleUpdate = await api(`/api/masters/machines/${machineId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: machineData, version: 1, idempotencyToken: `${prefix}-MACHINE-STALE` })
  });
  check(machineStaleUpdate.status === 409, 'Machine stale edits are rejected');
  const machineDelete = await api(`/api/masters/machines/${machineId}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: 2, reason: 'isolated master API test', idempotencyToken: `${prefix}-MACHINE-DELETE` })
  });
  check(machineDelete.status === 200, 'Machine deletion uses the existing soft-delete API');
  const legacyMachine = {
    id: `${prefix}-LEGACY-MACHINE`, machineId: `${prefix}-LEGACY-MACHINE`,
    name: `${prefix} Legacy Machine`, type: 'CNC', workCenter: 'Legacy Cell'
  };
  await pool.query(
    `INSERT INTO erp_state(storage_key,data) VALUES('machines',$1::jsonb)
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([legacyMachine])]
  );
  const machinePreview = await api('/api/masters/machines/legacy/preview');
  const machineCandidate = (machinePreview.body.entries || []).find((entry) => entry.proposedId === legacyMachine.machineId);
  check(machinePreview.status === 200 && machineCandidate?.status === 'eligible', 'Machine legacy preview preserves unselected records');
  const machineImport = await api('/api/masters/machines/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [machineCandidate.key], idempotencyToken: `${prefix}-MACHINE-IMPORT` })
  });
  check(machineImport.status === 201 && machineImport.body.imported === 1, 'Machine legacy import inserts only the selected record');

  const legacyCompanySettings = {
    id: 'primary',
    companyName: `${prefix} Legacy Company`,
    address: 'Legacy Company Road',
    email: 'legacy-company@example.com'
  };
  await pool.query("DELETE FROM company_settings WHERE id='primary'");
  await pool.query(
    `INSERT INTO erp_state(storage_key,data) VALUES('companySettings',$1::jsonb)
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify(legacyCompanySettings)]
  );
  const companyPreview = await api('/api/masters/company-settings/legacy/preview');
  const companyCandidate = (companyPreview.body.entries || []).find((entry) => entry.proposedId === 'primary');
  check(companyPreview.status === 200 && companyCandidate?.status === 'eligible', 'Company Settings legacy preview identifies an eligible preserved source');
  const companyImport = await api('/api/masters/company-settings/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [companyCandidate.key], idempotencyToken: `${prefix}-COMPANY-IMPORT` })
  });
  check(companyImport.status === 201 && companyImport.body.imported === 1, 'Company Settings import requires explicit Admin selection');
  const companyImportReplay = await api('/api/masters/company-settings/legacy/import', {
    method: 'POST',
    body: JSON.stringify({ selected: [companyCandidate.key], idempotencyToken: `${prefix}-COMPANY-IMPORT` })
  });
  check(companyImportReplay.status === 200 && companyImportReplay.body.idempotentReplay === true, 'Company Settings import retries are idempotent');

  const companyRead = await api('/api/masters/company-settings');
  const companyVersion = Number(companyRead.body.record?.version || 0);
  const companySettings = {
    ...(companyRead.body.record || {}),
    id: 'primary',
    companyName: `${prefix} Company`,
    email: 'company@example.com'
  };
  const companyWrite = await api('/api/masters/company-settings/primary', {
    method: 'PUT',
    body: JSON.stringify({ data: companySettings, version: companyVersion, idempotencyToken: `${prefix}-COMPANY-EDIT` })
  });
  check([200, 201].includes(companyWrite.status) && companyWrite.body.record.version === companyVersion + 1, 'Company Settings create/update uses PostgreSQL version checks');
  const companyStaleWrite = await api('/api/masters/company-settings/primary', {
    method: 'PUT',
    body: JSON.stringify({ data: companySettings, version: companyVersion, idempotencyToken: `${prefix}-COMPANY-STALE` })
  });
  check(companyStaleWrite.status === 409, 'Company Settings rejects stale versions');
  const deniedCompanyWrite = await api('/api/masters/company-settings/primary', {
    method: 'PUT',
    body: JSON.stringify({ data: companySettings, version: companyVersion + 1, idempotencyToken: `${prefix}-COMPANY-DENIED` }),
    headers: nonAdminHeaders
  }, false);
  check(deniedCompanyWrite.status === 403, 'Company Settings writes remain administrator-only');

  await api('/api/auth/logout', { method: 'POST' });
  console.log(`Master API PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`Master API integration failed after ${assertions} assertions: ${error.stack || error.message}`);
  if (childLog) console.error(`Child server log (tail): ${childLog.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  await stop();
  try {
    for (const [storageKey, previous] of [
      [legacyKey, priorLegacy],
      ['vendorMaster', priorVendorLegacy],
      ['machines', priorMachineLegacy],
      ['companySettings', priorCompanyLegacy]
    ]) {
      try {
        if (previous.rowCount) {
          await pool.query('UPDATE erp_state SET data=$2::jsonb,updated_at=$3 WHERE storage_key=$1', [storageKey, JSON.stringify(previous.rows[0].data), previous.rows[0].updated_at]);
        } else {
          await pool.query('DELETE FROM erp_state WHERE storage_key=$1', [storageKey]);
        }
      } catch (error) {
        throw new Error(`Failed restoring generic state '${storageKey}': ${error.message}`);
      }
    }
    if (priorCompanySettings.rowCount) {
      const previous = priorCompanySettings.rows[0];
      const fields = Object.entries(previous).filter(([column]) => column !== 'id');
      const assignments = fields.map(([column], index) => `"${column}"=$${index + 1}`);
      await pool.query(
        `UPDATE company_settings SET ${assignments.join(',')} WHERE id=$${fields.length + 1}`,
        [...fields.map(([, value]) => value), previous.id]
      );
    } else {
      await pool.query("DELETE FROM company_settings WHERE id='primary'");
    }
    await pool.query(
      "DELETE FROM erp_audit_log WHERE module='Master Data: Company Settings' AND record_id='primary' AND id::text <> ALL($1::text[])",
      [priorCompanyAudit.rows.map((row) => String(row.id))]
    );
    await pool.query('DELETE FROM customers WHERE id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM vendors WHERE id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM machines WHERE machine_id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM uom_master WHERE id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM erp_audit_log WHERE record_id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM master_idempotency WHERE token LIKE $1', [`${prefix}-%`]);
    if (nonAdminHash) await pool.query('DELETE FROM erp_sessions WHERE token_hash=$1', [nonAdminHash]);
    if (crossUserHash) await pool.query('DELETE FROM erp_sessions WHERE token_hash=$1', [crossUserHash]);
    await pool.query('DELETE FROM employees WHERE id=$1', [`${prefix}-PURCHASE-USER`]);
  } catch (cleanupError) {
    console.error(`Master API test cleanup failed: ${cleanupError.message}`);
    process.exitCode = 1;
  }
  await pool.end();
}
