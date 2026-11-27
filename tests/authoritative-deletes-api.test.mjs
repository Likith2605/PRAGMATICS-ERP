/** Isolated PostgreSQL API integration test for authoritative soft deletes. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing delete tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_DELETE_TEST_PORT || 3394);
const base = `http://127.0.0.1:${port}`;
let child;
let token = '';
let assertions = 0;
const assert = (ok, label) => { if (!ok) throw new Error(label); assertions += 1; console.log(`PASS ${label}`); };
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let n = 0; n < 100; n += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((m) => m.version === '042_authoritative_deletes')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated delete server did not become ready with migration 042.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const login = async () => (await api('/api/auth/login', json('POST', {
  email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin'
}), '')).body.token;

const suffix = randomUUID().slice(0, 8);
const itemCode = `DEL-${suffix}`;
const mrNumber = `MR-DEL-${Date.now()}-${suffix}`;
const closedMr = `MR-CLOSED-${Date.now()}-${suffix}`;
const entryDate = new Date().toISOString().slice(0, 10);

try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');

  const created = await api('/api/inventory/items', json('POST', { data: { itemCode, materialName: `Delete fixture ${suffix}`, unit: 'Nos' } }));
  assert(created.status === 201 && Number(created.body.record.version) === 1, 'Inventory fixture is created authoritatively');

  const unauth = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', { version: 1, reason: 'No auth' }), '');
  assert(unauth.status === 401, 'Unauthenticated inventory deletion is rejected');
  const badReason = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', { version: 1 }));
  assert(badReason.status === 400, 'Inventory deletion requires a reason');
  const stale = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', { version: 7, reason: 'Stale' }));
  assert(stale.status === 409, 'Inventory deletion with stale version is rejected');

  const opening = await api('/api/inventory/opening-stock', json('POST', {
    idempotencyKey: `delete-opening-${suffix}`, itemCode, quantity: 4, entryDate, reason: 'Delete guard fixture'
  }));
  assert(opening.status === 201, 'Opening stock fixture is posted');
  const withStock = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', { version: 1, reason: 'Has stock' }));
  assert(withStock.status === 409, 'Inventory item with non-zero stock cannot be deleted');
  const adjustment = await api('/api/inventory/adjustments', json('POST', {
    itemCode, quantity: -4, entryDate, reason: 'Return fixture stock to zero'
  }));
  assert(adjustment.status === 201 && Number(adjustment.body.balanceAfter) === 0, 'Stock is returned to zero through the ledger');
  const fresh = await pool.query('SELECT version FROM inventory_items WHERE item_code=$1', [itemCode]);
  const deletedItem = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    version: Number(fresh.rows[0].version), reason: 'Isolated authoritative delete'
  }));
  assert(deletedItem.status === 200 && Boolean(deletedItem.body.record.deleted_at), 'Zero-stock item is soft-deleted, not physically removed');
  assert(deletedItem.body.record.delete_reason === 'Isolated authoritative delete' && Boolean(deletedItem.body.record.deleted_by), 'Deletion actor and reason are persisted');
  assert(Number(deletedItem.body.record.version) === Number(fresh.rows[0].version) + 1, 'Inventory deletion advances the version');
  const afterDelete = await pool.query('SELECT deleted_at,deleted_by,delete_reason,version FROM inventory_items WHERE item_code=$1', [itemCode]);
  assert(afterDelete.rowCount === 1 && Boolean(afterDelete.rows[0].deleted_at), 'PostgreSQL retains the tombstoned inventory row');
  const itemAudit = await pool.query("SELECT 1 FROM erp_audit_log WHERE module='inventoryItems' AND record_id=$1 AND action='MASTER_DELETE'", [itemCode]);
  assert(itemAudit.rowCount === 1, 'Inventory deletion writes a durable audit row');
  const itemList = await api('/api/inventory/items?search=' + encodeURIComponent(itemCode));
  assert(!(itemList.body.records || []).some((row) => row.item_code === itemCode), 'Deleted item is absent from the authoritative list');

  const request = await api('/api/store/requests', json('POST', { data: {
    mrNumber, date: entryDate, department: 'Production', requestedBy: 'Delete tester', status: 'Draft',
    items: [{ materialId: itemCode, materialName: 'Fixture', requiredQty: 1, unit: 'Nos' }]
  } }));
  assert(request.status === 201 && Number(request.body.record.recordVersion) === 1, 'Material Request fixture is created authoritatively');
  const mrUnauth = await api(`/api/store/requests/${encodeURIComponent(mrNumber)}`, json('DELETE', { version: 1, reason: 'No auth' }), '');
  assert(mrUnauth.status === 401, 'Unauthenticated Material Request deletion is rejected');
  const mrStale = await api(`/api/store/requests/${encodeURIComponent(mrNumber)}`, json('DELETE', { version: 9, reason: 'Stale' }));
  assert(mrStale.status === 409, 'Material Request deletion with stale version is rejected');
  const mrDeleted = await api(`/api/store/requests/${encodeURIComponent(mrNumber)}`, json('DELETE', { version: 1, reason: 'Isolated authoritative delete' }));
  assert(mrDeleted.status === 200 && Boolean(mrDeleted.body.record.deleted_at), 'Material Request is soft-deleted through the API');
  const mrRow = await pool.query('SELECT deleted_by,delete_reason,version FROM material_requests WHERE mr_number=$1', [mrNumber]);
  assert(mrRow.rowCount === 1 && mrRow.rows[0].delete_reason === 'Isolated authoritative delete' && Boolean(mrRow.rows[0].deleted_by), 'Material Request tombstone retains actor and reason');
  assert(Number(mrRow.rows[0].version) === 2, 'Material Request deletion advances the version');
  const mrAudit = await pool.query("SELECT 1 FROM material_issue_audit WHERE issue_number=$1 AND action='MATERIAL_REQUEST_DELETED'", [mrNumber]);
  assert(mrAudit.rowCount === 1, 'Material Request deletion writes a durable audit row');
  const mrList = await api('/api/store/requests');
  assert(!(mrList.body.records || []).some((row) => row.mrNumber === mrNumber), 'Deleted Material Request is absent from the authoritative list');

  const closed = await api('/api/store/requests', json('POST', { data: {
    mrNumber: closedMr, date: entryDate, department: 'Production', requestedBy: 'Delete tester', status: 'Draft',
    items: [{ materialId: itemCode, materialName: 'Fixture', requiredQty: 1, unit: 'Nos' }]
  } }));
  assert(closed.status === 201, 'Closed-status fixture is created');
  const setClosed = await api(`/api/store/requests/${encodeURIComponent(closedMr)}`, json('PUT', { data: { status: 'Closed' }, version: 1 }));
  assert(setClosed.status === 200, 'Material Request status can be transitioned through the versioned API');
  const closedDelete = await api(`/api/store/requests/${encodeURIComponent(closedMr)}`, json('DELETE', { version: 2, reason: 'Should fail' }));
  assert(closedDelete.status === 409, 'Closed Material Request cannot be deleted');

  console.log(`Authoritative deletes PostgreSQL integration: ${assertions} passed, 0 failed.`);
} finally {
  await pool.query("DELETE FROM erp_audit_log WHERE module='inventoryItems' AND record_id=$1", [itemCode]);
  await pool.query('DELETE FROM material_issue_audit WHERE issue_number IN ($1,$2)', [mrNumber, closedMr]);
  await pool.query('DELETE FROM material_requests WHERE mr_number IN ($1,$2)', [mrNumber, closedMr]);
  await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [itemCode]);
  await stop();
  await pool.end();
}
