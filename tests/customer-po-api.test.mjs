import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getPool, closeDatabase } from '../server/database.js';

if (!process.env.DATABASE_URL) {
  console.log('SKIP: DATABASE_URL is not configured.');
  process.exit(0);
}
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) {
  console.log('SKIP: ERP_ADMIN_EMAIL / ERP_ADMIN_PASSWORD are not configured.');
  process.exit(0);
}
const testDatabaseName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (testDatabaseName !== 'pragmatics1_test_db') {
  throw new Error(`Refusing Customer PO integration test against non-test database '${testDatabaseName}'.`);
}

const port = 3347;
const vitePort = 5174;
const base = `http://127.0.0.1:${port}`;
const viteBase = `http://127.0.0.1:${vitePort}`;
const prefix = `TEST-CPO-${Date.now()}-`;
let server;
let vite;
let adminToken = '';
let secondClientToken = '';
let passed = 0;
const check = (condition, message) => { assert.ok(condition, message); passed += 1; console.log(`PASS: ${message}`); };
const request = async (path, { token = adminToken, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const proxyRequest = async (path, { token = adminToken, ...options } = {}) => {
  const response = await fetch(`${viteBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const login = async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
  });
  return response.json();
};
const item = (description, quantity, deliveredQuantity, unitPrice, amount, serialNumber) => ({
  serialNumber, description, quantity, deliveredQuantity, balanceQuantity: quantity - deliveredQuantity,
  unitPrice, amount, poBalanceQuantityPrice: amount / 2
});
const historical = (number, items, values = {}) => ({
  poNumber: `${prefix}${number}`, poDate: values.poDate ?? '2022-08-15',
  customerName: values.customerName ?? 'Fixture Customer', poBalanceValue: 123.5, items
});
const cleanup = async () => {
  await getPool().query('DELETE FROM customer_purchase_orders WHERE po_number LIKE $1', [`${prefix}%`]);
  await getPool().query("DELETE FROM erp_audit_log WHERE module='Customer Purchase Orders' AND record_id LIKE $1", [`${prefix}%`]);
};

try {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      const health = await response.json();
      if (health.database?.connected) { healthy = true; break; }
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check(healthy, 'PostgreSQL API server starts with migrations available');

  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  vite.stdout.on('data', () => {});
  vite.stderr.on('data', () => {});
  let proxyReady = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${viteBase}/`);
      if (response.ok) { proxyReady = true; break; }
    } catch { /* Vite is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check(proxyReady, 'Vite starts with proxy targeting the isolated Express API');

  const anonymous = await request('/api/customer-purchase-orders', { token: '' });
  check(anonymous.status === 401, 'Customer PO API requires authentication');
  adminToken = (await login()).token;
  secondClientToken = (await login()).token;
  check(Boolean(adminToken && secondClientToken && adminToken !== secondClientToken), 'two independent client sessions can authenticate');

  const one = historical('SINGLE', [item('Single item', 3, 1, 50, 150, '01')]);
  const multiple = historical('MULTI', [item('Part A', 2, 1, 10, 20, '001'), item('Part B', 5, 2, 12.5, 62.5, '002')]);
  const secondPO = historical('SECOND', [item('Second PO item', 1, 0, 44, 44, '1')], { poDate: '2024-04-01' });
  const imported = await proxyRequest('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [one, multiple, secondPO] }) });
  check(imported.status === 200 && imported.body.imported === 3, 'one item, multiple items, and multiple PO headers import successfully');
  check(imported.body.outcomes.every((outcome) => outcome.status === 'imported'), 'each imported PO returns a successful transaction outcome');

  const appended = historical('SINGLE', [item('Single item', 3, 1, 50, 150, '01'), item('MS Sheet', 4, 1, 20, 80, '02')]);
  const appendResult = await proxyRequest('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [appended] }) });
  check(appendResult.body.newHeaders === 0 && appendResult.body.existingHeaders === 1 && appendResult.body.newItems === 1 && appendResult.body.skippedItems === 1, `an existing PO adds a different description and skips an identical item line: ${JSON.stringify(appendResult.body)}`);
  check(appendResult.body.outcomes[0].status === 'existing_updated', 'matching existing header is retained while new item is appended');

  const identicalResult = await proxyRequest('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [historical('SINGLE', [item('MS Sheet', 4, 1, 20, 80, '98')])] }) });
  check(identicalResult.body.newItems === 0 && identicalResult.body.skippedItems === 1 && identicalResult.body.outcomes[0].status === 'existing_unchanged', 'an identical item line is skipped on repeated import');

  const multiNewResult = await proxyRequest('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [historical('SINGLE', [item('Copper Sheet', 2, 0, 30, 60, '03'), item('Aluminium Sheet', 5, 1, 40, 200, '04')])] }) });
  check(multiNewResult.body.existingHeaders === 1 && multiNewResult.body.newItems === 2 && multiNewResult.body.skippedItems === 0, 'multiple new descriptions append under one existing header');

  const customerConflict = await proxyRequest('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [historical('SINGLE', [item('Must not save', 1, 0, 1, 1, '05')], { customerName: 'Different Customer' })] }) });
  check(customerConflict.body.conflicts === 1 && customerConflict.body.outcomes[0].status === 'review' && customerConflict.body.outcomes[0].errors[0].includes('Customer Name'), 'conflicting customer name is flagged for review without overwrite');
  const dateConflict = await proxyRequest('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [historical('SINGLE', [item('Must not save either', 1, 0, 1, 1, '06')], { poDate: '2022-08-16' })] }) });
  check(dateConflict.body.conflicts === 1 && dateConflict.body.outcomes[0].errors[0].includes('PO Date'), 'conflicting PO date is flagged for review without overwrite');
  const singleDetail = await request(`/api/customer-purchase-orders/${encodeURIComponent(`${prefix}SINGLE`)}`);
  check(singleDetail.body.record.payload.items.length === 4, 'conflicted records are not saved and the existing PO has one header with four distinct item rows');

  const listFromOtherClient = await proxyRequest('/api/customer-purchase-orders', { token: secondClientToken });
  const testRecords = listFromOtherClient.body.records.filter((record) => record.reference.startsWith(prefix));
  check(testRecords.length === 3, 'a second client retrieves the imported POs from PostgreSQL');
  check(testRecords.every((record) => record.recordType === 'Historical' && record.status === 'Archived (Pre-ERP)' && record.dataSource === 'Excel Import'), 'historical classification and data source are persisted');
  check(testRecords.find((record) => record.reference.endsWith('MULTI')).payload.items.length === 2, 'list response preserves both item rows on a grouped PO');
  check(testRecords.find((record) => record.reference.endsWith('SINGLE')).fyLabel === 'FY 2022-23', 'financial year follows the PO date using April-to-March rules');

  const multiDetail = await request(`/api/customer-purchase-orders/${encodeURIComponent(`${prefix}MULTI`)}`, { token: secondClientToken });
  check(multiDetail.status === 200 && multiDetail.body.record.payload.items[1].itemName === 'Part B', 'individual detail endpoint returns associated item data for View / Print');
  check(multiDetail.body.record.payload.items[0].serialNumber === '001', 'serial text including leading zeros is retained');
  check(multiDetail.body.record.payload.items[0].balanceQty === 1 && multiDetail.body.record.payload.poDetails.poBalanceValue === 123.5, 'balance quantities and PO balance value are retained');
  check(multiDetail.body.record.payload.items[0].gst === null && multiDetail.body.record.payload.totals.totalGST === null, 'unprovided GST remains unprovided');

  const livePayload = {
    poDetails: { customerPoNumber: `${prefix}LIVE`, customerPoDate: '2024-06-01', poStatus: 'Received' },
    customerDetails: { customerName: 'Live Fixture Customer', companyName: 'Live Fixture Customer' },
    items: [{ itemName: 'Live created item', quantity: 2, deliveredQty: 0, unitPrice: 8, amount: 16, gst: '18', unit: 'Nos' }],
    totals: { subtotal: 16, grandTotal: 18.88, totalGST: 2.88 }, amountInWords: 'fixture', currency: 'INR'
  };
  const createdLive = await request('/api/customer-purchase-orders', { method: 'POST', body: JSON.stringify({ record: { reference: `${prefix}LIVE`, date: '2024-06-01', company: 'Live Fixture Customer', payload: livePayload } }) });
  check(createdLive.status === 201 && createdLive.body.record.recordType === 'Live', 'normal Customer PO creation also writes to PostgreSQL');

  const repeated = await request('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [one, multiple, secondPO] }) });
  check(repeated.body.imported === 0 && repeated.body.duplicates === 0 && repeated.body.skippedItems === 4, 'repeated upload skips all four identical item lines without creating duplicate headers');

  const invalidRecords = [
    historical('BAD-DATE', [item('Bad date', 1, 0, 2, 2, '1')], { poDate: '2024-02-30' }),
    historical('BAD-QTY', [item('Bad quantity', 0, 0, 2, 0, '1')]),
    historical('BAD-PRICE', [item('Bad price', 1, 0, -2, 2, '1')]),
    historical('MISSING-CUSTOMER', [item('Missing customer', 1, 0, 2, 2, '1')], { customerName: '' })
  ];
  const invalidResult = await request('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: invalidRecords }) });
  check(invalidResult.body.failed === 4 && invalidResult.body.outcomes.every((outcome) => outcome.status === 'invalid'), 'invalid dates, quantities, prices, and required fields are rejected');

  const rollbackRecord = historical('ROLLBACK', [item('Valid leading item', 1, 0, 1, 1, '1'), item('Database overflow item', 1, 0, 1e20, 1e20, '2')]);
  const rollbackResult = await request('/api/customer-purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [rollbackRecord] }) });
  check(rollbackResult.body.failed === 1 && rollbackResult.body.outcomes[0].status === 'failed', 'a database item-save failure is reported');
  const rollbackRows = await getPool().query('SELECT count(*)::int AS headers FROM customer_purchase_orders WHERE lower(po_number)=lower($1)', [rollbackRecord.poNumber]);
  check(rollbackRows.rows[0].headers === 0, 'header and earlier item rows roll back together when a later item cannot save');

  const finalRead = await proxyRequest('/api/customer-purchase-orders');
  check(finalRead.body.records.some((record) => record.reference === `${prefix}SINGLE`), 'dashboard refresh query returns committed records');
  const audit = await getPool().query("SELECT count(*)::int AS count FROM erp_audit_log WHERE module='Customer Purchase Orders' AND record_id LIKE $1 AND action IN ('CUSTOMER PURCHASE ORDER HISTORICAL EXCEL IMPORTED','CUSTOMER PURCHASE ORDER ITEMS ADDED BY HISTORICAL EXCEL IMPORT')", [`${prefix}%`]);
  check(audit.rows[0].count === 5, 'new PO headers and appended items have audit entries while skipped/conflicted rows do not');

  console.log(`PASS: ${passed} Customer PO PostgreSQL API checks.`);
} finally {
  if (server) server.kill();
  if (vite) vite.kill();
  try { await cleanup(); } finally { await closeDatabase(); }
}
