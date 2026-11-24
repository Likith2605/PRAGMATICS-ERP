/**
 * Per-record module API test (/api/records -> module_records table)
 *
 * Verifies the Phase-2 multi-user safety path:
 *   create -> read back -> update with correct version -> conflict on stale
 *   version -> delete with correct version -> delete-race keeps changed
 *   record -> whitelist rejection -> generic /api/state no longer accepts
 *   the graduated keys (one authority per module).
 *
 * Usage: node tests/records-api.test.mjs   (DATABASE_URL required)
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  console.log('SKIP: DATABASE_URL is not configured.');
  process.exit(0);
}

const PORT = 3325;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];
let adminToken = '';
let employeeToken = '';

const ok = (label) => { passed++; console.log(`  ✓  ${label}`); };
const fail = (label, detail = '') => {
  failed++;
  failures.push(`${label}${detail ? ': ' + detail : ''}`);
  console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, label, detail = '') => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n── ${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

let serverProcess = null;
const startServer = () =>
  new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', () => {});
    serverProcess.stderr.on('data', () => {});
    serverProcess.on('error', reject);
    setTimeout(resolve, 800);
  });

const stopServer = () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
};

const KEY = 'inventoryItems';
const STAMP = Date.now();
const ID_A = `REC-A-${STAMP}`;
const ID_B = `REC-B-${STAMP}`;
const ID_C = `REC-C-${STAMP}`;

const cleanup = async () => {
  await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({
      deletes: [ID_A, ID_B, ID_C].map((id) => ({ id, version: 99 })),
      reason: 'Automated test cleanup', updatedBy: 'records-api.test'
    })
  });
};

try {
  section('1. Start server & health');
  await startServer();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const h = await request('/api/health');
      if (h.ok && h.data?.database?.connected) { ready = true; break; }
    } catch { /* waiting */ }
    await sleep(200);
  }
  check(ready, 'Server up and PostgreSQL connected');

  section('1a. Server-issued identity and Admin authorization');
  const adminLogin = await request('/api/auth/login', { method: 'POST', headers: {}, body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  check(adminLogin.ok && adminLogin.data?.token, 'Admin credentials issue a server token');
  adminToken = adminLogin.data?.token || '';
  const anonymous = await fetch(`${BASE_URL}/api/state`);
  check(anonymous.status === 401, 'Unauthenticated API access is rejected');
  const { getPool } = await import('../server/database.js');
  const employeeState = await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'");
  const employee = (employeeState.rows[0]?.data || []).find((entry) => entry?.active !== false && entry?.email && entry?.password && !['admin','administrator'].includes(String(entry.roleKey || '').toLowerCase()));
  const employeeLogin = employee && await request('/api/auth/login', { method: 'POST', headers: {}, body: JSON.stringify({ email: employee.email, password: employee.password, portal: 'employee' }) });
  check(employeeLogin?.ok && employeeLogin.data?.token, 'Employee credentials issue a non-Admin server token');
  employeeToken = employeeLogin?.data?.token || '';
  const stateKey = `adminAuthTest${STAMP}`;
  const stateCreated = await request(`/api/state/${stateKey}`, { method: 'PUT', body: JSON.stringify({ data: [{ id: stateKey, name: 'Sensitive transition test', status: 'Draft' }] }) });
  check(stateCreated.ok, 'Authenticated Admin can create a test ERP state record');
  const stateEmployeeCancel = await request(`/api/state/${stateKey}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${employeeToken}` },
    body: JSON.stringify({ data: [{ id: stateKey, name: 'Sensitive transition test', status: 'Cancelled' }], reasons: { [stateKey]: 'test reason' } })
  });
  check(stateEmployeeCancel.status === 403, 'Employee cannot cancel via generic ERP state API');
  const stateAdminCancel = await request(`/api/state/${stateKey}`, {
    method: 'PUT', body: JSON.stringify({ data: [{ id: stateKey, name: 'Sensitive transition test', status: 'Cancelled' }], reasons: { [stateKey]: 'Test cancellation' } })
  });
  check(stateAdminCancel.ok, 'Admin can perform a reasoned cancellation via ERP state API');
  const employeeStateDelete = await request(`/api/state/${stateKey}`, { method: 'DELETE', headers: { Authorization: `Bearer ${employeeToken}` }, body: JSON.stringify({ reason: 'test' }) });
  check(employeeStateDelete.status === 403, 'Employee cannot delete through generic ERP state API');
  const stateDelete = await request(`/api/state/${stateKey}`, { method: 'DELETE', body: JSON.stringify({ reason: 'Remove temporary state test record' }) });
  check(stateDelete.status === 409, 'Whole-module state deletion is blocked even for Admins');
  const stateClear = await request(`/api/state/${stateKey}`, { method: 'PUT', body: JSON.stringify({ data: [], reasons: { [stateKey]: 'Clear temporary state test record' } }) });
  check(stateClear.ok, 'Admin can clear temporary test records through audited record-level update');

  section('2. module_records table exists');
  const list0 = await request(`/api/records/${KEY}`);
  check(list0.ok && Array.isArray(list0.data.records), 'GET /api/records/:key returns record list (table reachable)');

  section('3. Create records (two users, different records)');
  await cleanup();
  const putA = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({
      records: [
        { id: ID_A, data: { id: ID_A, itemName: 'MS Plate 10mm', currentQty: 500 }, version: 0 },
        { id: ID_B, data: { id: ID_B, itemName: 'SS Pipe 2inch', currentQty: 120 }, version: 0 }
      ],
      updatedBy: 'user-A'
    })
  });
  check(putA.ok && (putA.data.saved || []).length === 2, 'Two records created in one save');
  check(putA.data.saved?.every((s) => s.version === 1), 'New records start at version 1', JSON.stringify(putA.data.saved));
  check((putA.data.conflicts || []).length === 0, 'No conflicts on first save');

  const readBack = await request(`/api/records/${KEY}`);
  const rowA = (readBack.data.records || []).find((r) => r.id === ID_A);
  check(rowA?.data?.itemName === 'MS Plate 10mm', 'Record A read back correctly');
  check(rowA?.updatedBy === process.env.ERP_ADMIN_EMAIL, 'updated_by comes from authenticated server identity', `got ${rowA?.updatedBy}`);

  section('4. Concurrent edits on DIFFERENT records — no interference');
  const editB = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: ID_B, data: { id: ID_B, itemName: 'SS Pipe 2inch', currentQty: 115 }, version: 1 }], updatedBy: 'user-B' })
  });
  const editA = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: ID_A, data: { id: ID_A, itemName: 'MS Plate 10mm', currentQty: 480 }, version: 1 }], updatedBy: 'user-A' })
  });
  check(editB.ok && editA.ok && (editB.data.conflicts || []).length === 0 && (editA.data.conflicts || []).length === 0,
    'Both edits accepted without conflict (different records)');
  const readBoth = await request(`/api/records/${KEY}`);
  const freshA = readBoth.data.records.find((r) => r.id === ID_A);
  const freshB = readBoth.data.records.find((r) => r.id === ID_B);
  check(freshA.data.currentQty === 480 && freshB.data.currentQty === 115,
    'Both changes preserved — neither user overwrote the other',
    `A=${freshA.data.currentQty} B=${freshB.data.currentQty}`);
  check(Number(freshA.version) === 2 && Number(freshB.version) === 2, 'Versions incremented to 2');

  section('5. Stale-version conflict (same record, older version)');
  const stale = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: ID_A, data: { id: ID_A, itemName: 'OLD DATA', currentQty: 999 }, version: 1 }], updatedBy: 'user-C' })
  });
  check(stale.ok && (stale.data.saved || []).length === 0, 'Stale write NOT applied');
  check((stale.data.conflicts || []).length === 1, 'Conflict reported to the client');
  check(stale.data.conflicts?.[0]?.data?.currentQty === 480, 'Conflict carries the latest server copy', JSON.stringify(stale.data.conflicts?.[0]?.data));
  check(stale.data.conflicts?.[0]?.updatedBy === process.env.ERP_ADMIN_EMAIL, 'Conflict includes authenticated server identity');

  section('6. Delete-race: delete based on stale version is refused');
  const delRace = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ deletes: [{ id: ID_A, version: 1, reason: 'Stale delete race test' }], updatedBy: 'user-C' })
  });
  check((delRace.data.deleted || []).length === 0, 'Stale delete NOT applied');
  check((delRace.data.conflicts || []).length === 1, 'Delete conflict reported (record changed since seen)');
  const stillThere = await request(`/api/records/${KEY}`);
  check(!!stillThere.data.records.find((r) => r.id === ID_A), 'Record survives the stale delete');
  const protectedStockDelete = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ deletes: [{ id: ID_B, version: 2, reason: 'Protected stock test' }] })
  });
  check(protectedStockDelete.status === 409, 'Admin cannot delete an item with remaining stock');

  const deniedDelete = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${employeeToken}` },
    body: JSON.stringify({ deletes: [{ id: ID_A, version: 2, reason: 'test reason' }] })
  });
  check(deniedDelete.status === 403, 'Employee cannot delete through the direct records API', JSON.stringify(deniedDelete.data));
  const auditDenied = await request('/api/auth/audit', { headers: { Authorization: `Bearer ${employeeToken}` } });
  check(auditDenied.status === 403, 'Employee cannot read sensitive audit history');

  section('7. Correct delete works');
  await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: ID_C, data: { id: ID_C, itemName: 'Temp' }, version: 0 }], updatedBy: 'user-A' })
  });
  const employeeCancel = await request(`/api/records/${KEY}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${employeeToken}` },
    body: JSON.stringify({ records: [{ id: ID_C, data: { id: ID_C, itemName: 'Temp', status: 'Cancelled' }, version: 1 }], reason: 'test cancellation' })
  });
  check(employeeCancel.status === 403, 'Employee cannot cancel through direct record update');
  const adminCancel = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: ID_C, data: { id: ID_C, itemName: 'Temp', status: 'Cancelled' }, version: 1 }], reason: 'Test controlled cancellation' })
  });
  check(adminCancel.ok && adminCancel.data.saved?.length === 1, 'Admin can perform a reasoned controlled status action');
  const delOk = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ deletes: [{ id: ID_C, version: 2, reason: 'Delete temporary test record' }], updatedBy: 'user-A' })
  });
  check((delOk.data.deleted || []).includes(ID_C), 'Delete with current version succeeds');
  const audit = await request('/api/auth/audit?limit=100');
  check(audit.ok && audit.data.entries.some((entry) => entry.record_id === ID_C && entry.action === 'DELETE') && audit.data.entries.some((entry) => entry.record_id === ID_C && entry.action === 'CONTROLLED_STATUS_CHANGE'), 'Admin audit history persists deletion and cancellation');
  const delMissing = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ deletes: [{ id: ID_C, version: 1, reason: 'Delete temporary test record' }], updatedBy: 'user-A' })
  });
  check((delMissing.data.deleted || []).includes(ID_C), 'Deleting an already-deleted record is idempotent');

  section('8. Whitelist & validation');
  const unknown = await request('/api/records/notARealKey', { method: 'PUT', body: JSON.stringify({ records: [] }) });
  check(unknown.status === 400, 'Unknown key rejected with 400', `got ${unknown.status}`);
  const badId = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: 'bad id!!', data: {}, version: 0 }] })
  });
  check(badId.status === 400, 'Invalid record id rejected with 400', `got ${badId.status}`);
  const noData = await request(`/api/records/${KEY}`, {
    method: 'PUT',
    body: JSON.stringify({ records: [{ id: `NODATA-${STAMP}`, version: 0 }] })
  });
  check(noData.status === 400, 'Record without data rejected with 400', `got ${noData.status}`);
  const emptySave = await request(`/api/records/${KEY}`, { method: 'PUT', body: JSON.stringify({}) });
  check(emptySave.ok && (emptySave.data.saved || []).length === 0, 'Empty save is a harmless no-op');

  section('9. One authority: generic /api/state rejects graduated keys');
  const mirrorWrite = await request('/api/state/inventoryItems', {
    method: 'PUT',
    body: JSON.stringify({ data: [{ id: 'SHOULD-NOT-EXIST' }] })
  });
  check(mirrorWrite.status === 400, '/api/state refuses inventoryItems (now module-owned)', `got ${mirrorWrite.status}`);
  const mirrorWrite2 = await request('/api/state/stockTransactions', {
    method: 'PUT',
    body: JSON.stringify({ data: [{ id: 'SHOULD-NOT-EXIST' }] })
  });
  check(mirrorWrite2.status === 400, '/api/state refuses stockTransactions (now module-owned)', `got ${mirrorWrite2.status}`);
  const stateList = await request('/api/state');
  check(stateList.ok && !('inventoryItems' in (stateList.data.records || {})),
    'GET /api/state no longer returns the graduated keys');

} catch (err) {
  fail('Fatal test exception', err.message);
  console.error(err);
} finally {
  await cleanup();
  stopServer();
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Records API Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`));
}
process.exit(failed === 0 ? 0 : 1);
