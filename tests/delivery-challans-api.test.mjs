/** Isolated PostgreSQL API integration test for Delivery Challans. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') throw new Error('Refusing Delivery Challan tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required.');
const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') { await pool.end(); throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.'); }

const port = Number(process.env.ERP_DELIVERY_CHALLAN_TEST_PORT || 3383);
const base = `http://127.0.0.1:${port}`; let child; let token = ''; let secondToken = ''; let assertions = 0;
const assert = (ok, label, detail = '') => { if (!ok) throw new Error(detail ? `${label}: ${detail}` : label); assertions += 1; console.log(`PASS ${label}`); };
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) }; delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let n = 0; n < 100; n += 1) {
    try { const health = await (await fetch(`${base}/api/health`)).json(); if (health.ready && health.database?.migrations?.some((m) => m.version === '019_delivery_challans')) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Delivery Challan server did not become ready.');
};
const stop = async () => { if (!child) return; child.kill(); await new Promise((resolve) => child.once('exit', resolve)); child = null; };
const login = async () => (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) }, '')).body.token;

let number = '';
let inventoryId = '';
let requestId = '';
let requestNumber = '';
let itemCode = '';
let itemName = '';
try {
  await start(); token = await login(); secondToken = await login();
  assert(token && secondToken, 'Admin sessions authenticate');
  number = `DCT-${Date.now()}`;
  inventoryId = `DCTINV-${randomUUID()}`;
  /* Unique item identity prevents a previous isolated run's fixture from being
   * selected by the Delivery Challan stock lookup. */
  itemCode = `DCT-${randomUUID().slice(0, 8)}`;
  itemName = `Test component ${itemCode}`;
  await pool.query("INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES('inventoryItems',$1,$2::jsonb,1,now(),'integration-test')", [inventoryId, JSON.stringify({ id: inventoryId, itemCode, itemName, currentQty: 8, reservedQty: 0 })]);
  /* Stock is authoritative in inventory_items; the module_records row above is
   * only the legacy compatibility copy that must be updated in the same transaction. */
  await pool.query("INSERT INTO inventory_items(item_code,material_name,category,unit,current_qty,unit_price,payload) VALUES($1,$2,'Raw Material','Nos',8,15,$3::jsonb)", [itemCode, itemName, JSON.stringify({ integrationFixture: true })]);
  const payload = { dcDetails: { dcNumber: number, dcDate: new Date().toISOString().slice(0, 10), dispatchDate: new Date().toISOString().slice(0, 10), salesOrderRef: 'SO-TEST', challanStatus: 'Dispatched', currency: 'INR' }, customerDetails: { customerName: 'Isolated Test Customer' }, companyDetails: {}, items: [{ itemCode, itemName, quantity: 2, unit: 'Nos', unitPrice: 15 }], totals: { grandTotal: 30 }, currency: 'INR', amountINR: 30 };
  const createToken = randomUUID();
  const created = await api('/api/delivery-challans', { method: 'POST', body: JSON.stringify({ data: payload, createToken }) });
  assert(created.status === 201 && created.body.record.version === 1, 'Create returns PostgreSQL-confirmed Delivery Challan version 1', JSON.stringify(created));
  const retry = await api('/api/delivery-challans', { method: 'POST', body: JSON.stringify({ data: payload, createToken }) });
  assert(retry.status === 200 && retry.body.duplicate, 'Create retry is idempotent');
  const stockAfterRetry = await pool.query("SELECT data FROM module_records WHERE storage_key='inventoryItems' AND record_id=$1", [inventoryId]);
  const stockLedger = await pool.query("SELECT record_id FROM module_records WHERE storage_key='stockTransactions' AND record_id LIKE $1", [`delivery-${number}-%`]);
  assert(Number(stockAfterRetry.rows[0].data.currentQty) === 6 && stockLedger.rowCount === 1, 'Challan and stock ledger commit atomically, with no duplicate deduction on retry');
  const list = await api('/api/delivery-challans');
  assert(list.body.records.some((r) => r.reference === number), 'Refresh/list reads persisted records');
  const secondRead = await api(`/api/delivery-challans/${number}`, {}, secondToken);
  assert(secondRead.status === 200 && secondRead.body.record.payload.items[0].itemName === itemName, 'Second authenticated client reads the same PostgreSQL record');
  const edits = await Promise.all(['A', 'B'].map((v) => api(`/api/delivery-challans/${number}`, { method: 'PUT', body: JSON.stringify({ data: { ...payload, dcDetails: { ...payload.dcDetails, notes: v } }, version: 1 }) })));
  assert(edits.filter((r) => r.status === 200).length === 1 && edits.filter((r) => r.status === 409).length === 1, 'Concurrent edits reject the stale version');
  const row = await pool.query('SELECT version,payload FROM delivery_challans WHERE dc_number=$1', [number]);
  assert(row.rowCount === 1 && Number(row.rows[0].version) === 2, 'PostgreSQL contains exactly one winning update');
  assert((await api('/api/state/deliveryChallanHistory', { method: 'PUT', body: JSON.stringify({ data: [] }) })).status === 400, 'Generic erp_state API rejects Delivery Challan history writes');
  const deleted = await api(`/api/delivery-challans/${number}`, { method: 'DELETE', body: JSON.stringify({ version: 2, reason: 'isolated test' }) });
  assert(deleted.status === 200, 'Admin soft-delete is confirmed');
  const deletedRow = await pool.query('SELECT deleted_at,deleted_by,delete_reason FROM delivery_challans WHERE dc_number=$1', [number]);
  assert(deletedRow.rows[0].deleted_at && deletedRow.rows[0].deleted_by && deletedRow.rows[0].delete_reason, 'Deletion metadata remains in PostgreSQL');
  assert((await api('/api/delivery-challans', { method: 'POST', body: JSON.stringify({ data: payload, createToken: randomUUID() }) })).status === 409, 'Deleted Delivery Challan ID cannot be recreated');
  const audits = await pool.query('SELECT action FROM delivery_challan_audit WHERE dc_number=$1', [number]);
  assert(audits.rows.some((r) => r.action === 'CREATE') && audits.rows.some((r) => r.action === 'UPDATE') && audits.rows.some((r) => r.action === 'SOFT_DELETE'), 'Create, edit and delete audit records are retained');
  requestId = `DCTREQ-${randomUUID()}`; requestNumber = `DCT-R-${Date.now()}`;
  await pool.query("INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES('productionDispatchRequests',$1,$2::jsonb,1,now(),'integration-test')", [requestId, JSON.stringify({ id: requestId, status: 'Pending', eligibleQuantity: 5, salesOrderNo: 'SO-TEST', projectId: 'DCT-PROJ', customerName: 'Isolated Test Customer', partName: payload.items[0].itemName, audit: [] })]);
  const requestPayload = { ...payload, dcDetails: { ...payload.dcDetails, dcNumber: requestNumber, projectId: 'DCT-PROJ', challanStatus: 'Challan Created', dispatchRequestId: requestId }, dispatchRequestId: requestId };
  const linked = await api('/api/delivery-challans', { method: 'POST', body: JSON.stringify({ data: requestPayload, createToken: randomUUID() }) });
  assert(linked.status === 201, 'Dispatch-request challan reserves request in the create transaction');
  const requestRow = await pool.query("SELECT data FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1", [requestId]);
  assert(requestRow.rows[0].data.status === 'Challan Created' && requestRow.rows[0].data.challanNumber === requestNumber, 'PostgreSQL dispatch request reflects the reserved challan');
  const confirmed = await api(`/api/delivery-challans/${requestNumber}/confirm-dispatch`, { method: 'POST', body: JSON.stringify({ version: 1 }) });
  assert(confirmed.status === 200 && confirmed.body.record.status === 'Dispatched', 'Dispatch confirmation commits through the backend');
  const finalRequest = await pool.query("SELECT data FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1", [requestId]);
  const finalStock = await pool.query("SELECT data FROM module_records WHERE storage_key='inventoryItems' AND record_id=$1", [inventoryId]);
  assert(finalRequest.rows[0].data.status === 'Dispatched' && Number(finalStock.rows[0].data.currentQty) === 4, 'Dispatch status and inventory deduction commit together exactly once');
  await stop(); await start();
  assert((await api(`/api/delivery-challans/${number}`)).status === 404, 'Deleted record remains absent after Express restart');
  console.log(`Delivery Challan PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) { console.error(`Delivery Challan integration failed after ${assertions}: ${error.stack || error.message}`); process.exitCode = 1; }
finally {
  /* Remove only fixtures created by this isolated run; legacy data is never
   * deleted automatically. */
  if (inventoryId) await pool.query("DELETE FROM module_records WHERE (storage_key='inventoryItems' AND record_id=$1) OR (storage_key='stockTransactions' AND record_id LIKE $2)", [inventoryId, `%${number}-%`]);
  if (itemCode) {
    await pool.query("DELETE FROM stock_ledger_entries WHERE id LIKE $1", [`delivery-${number}-%`]);
    await pool.query("DELETE FROM erp_audit_log WHERE module='inventoryItems' AND record_id=$1 AND action='STOCK_OUT'", [itemCode]);
    await pool.query("DELETE FROM inventory_items WHERE item_code=$1", [itemCode]);
  }
  for (const dcNumber of [number, requestNumber]) {
    if (!dcNumber) continue;
    await pool.query("DELETE FROM delivery_challan_items WHERE dc_number=$1", [dcNumber]);
    await pool.query("DELETE FROM delivery_challan_audit WHERE dc_number=$1", [dcNumber]);
    await pool.query("DELETE FROM delivery_challans WHERE dc_number=$1", [dcNumber]);
  }
  if (requestId) await pool.query("DELETE FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1", [requestId]);
  await stop(); await pool.end();
}
