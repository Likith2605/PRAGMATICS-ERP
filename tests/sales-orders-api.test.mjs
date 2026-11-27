/** Guarded PostgreSQL integration test for Sales Orders and linked conversion. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing to use DATABASE_URL.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') throw new Error('Refusing Sales Order tests outside vyavastha_test.');
const safetyPool = new pg.Pool({ connectionString: databaseUrl });
const identity = await safetyPool.query('SELECT current_database() AS name');
await safetyPool.end();
if (identity.rows[0]?.name !== 'vyavastha_test') throw new Error('Refusing database writes: current_database() is not exactly vyavastha_test.');
const pool = new pg.Pool({ connectionString: databaseUrl });
const port = Number(process.env.ERP_SALES_ORDER_TEST_PORT || 3382);
const base = `http://127.0.0.1:${port}`;
let child;
let token = '';
let secondToken = '';
let assertions = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); assertions += 1; console.log(`PASS ${message}`); };
let normalizedOnlySoNumber = '';
let missingLinesSoNumber = '';
const request = async (path, options = {}, authToken = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((row) => row.version === '018_sales_orders')) return;
    } catch { /* waiting for isolated server */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Sales Order server did not become ready.');
};
const stop = async () => { if (child) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); child = null; } };
const login = async () => {
  const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) }, '');
  return result.body.token;
};

try {
  await start();
  token = await login();
  secondToken = await login();
  assert(token && secondToken && token !== secondToken, 'two independent authenticated client sessions are available');
  const quoteNo = (await request('/api/quotations/next-number', { method: 'POST', body: '{}' })).body.quotationNumber;
  const quotePayload = {
    companyDetails: { companyName: 'Isolated Sales Test' },
    customerDetails: { customerName: 'Sales Test Customer', companyName: 'Isolated Sales Test' },
    quotationDetails: { quotationNumber: quoteNo, quotationDate: new Date().toISOString().slice(0, 10), currency: 'INR', projectId: 'SOTEST' },
    items: [{ itemName: 'Linked test part', quantity: 1, unitPrice: 50, amount: 50 }], totals: { grandTotal: 50 }
  };
  const quoteCreated = await request('/api/quotations', { method: 'POST', body: JSON.stringify({ data: quotePayload, createToken: randomUUID() }) });
  assert(quoteCreated.status === 201, 'source Quotation is committed to isolated PostgreSQL');

  const poNo = (await request('/api/customer-purchase-orders/next-number', { method: 'POST', body: '{}' })).body.poNumber;
  const poPayload = {
    poDetails: { customerPoNumber: poNo, customerPoDate: new Date().toISOString().slice(0, 10), quotationRef: quoteNo, poStatus: 'Received' },
    customerDetails: { customerName: 'Sales Test Customer', companyName: 'Isolated Sales Test' },
    companyDetails: {}, items: [{ itemName: 'Linked test part', quantity: 1, deliveredQty: 0, balanceQty: 1, unitPrice: 50, amount: 50, gst: '18', unit: 'Nos' }],
    totals: { grandTotal: 59 }, currency: 'INR', amountInWords: 'fifty nine'
  };
  const poCreated = await request('/api/customer-purchase-orders', { method: 'POST', body: JSON.stringify({ createToken: randomUUID(), record: { reference: poNo, date: poPayload.poDetails.customerPoDate, company: 'Isolated Sales Test', payload: poPayload } }) });
  assert(poCreated.status === 201, 'source Customer PO is committed to isolated PostgreSQL');

  const soNumber = `SO-${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const soPayload = {
    soDetails: { soNumber, soDate: new Date().toISOString().slice(0, 10), quotationRef: quoteNo, customerPoNumber: poNo, orderStatus: 'Confirmed', currency: 'INR', exchangeRate: 1, projectId: 'SOTEST' },
    customerDetails: quotePayload.customerDetails, companyDetails: quotePayload.companyDetails,
    items: [{ itemName: 'Linked test part', quantity: 1, unitPrice: 50, amount: 50, gstAmount: 9, unit: 'Nos' }],
    totals: { grandTotal: 59 }, amountInWords: 'fifty nine', amountINR: 59, currency: 'INR'
  };
  const createToken = randomUUID();
  const created = await request('/api/sales-orders', { method: 'POST', body: JSON.stringify({ data: soPayload, createToken }) });
  assert(created.status === 201 && created.body.record.version === 1, 'Sales Order create returns PostgreSQL-confirmed record and version');
  const retry = await request('/api/sales-orders', { method: 'POST', body: JSON.stringify({ data: soPayload, createToken }) });
  assert(retry.status === 200 && retry.body.duplicate, 'idempotency retry returns the same Sales Order');
  const persisted = await pool.query('SELECT version,quotation_ref,customer_po_number FROM sales_orders WHERE so_number=$1', [soNumber]);
  assert(persisted.rowCount === 1 && persisted.rows[0].quotation_ref === quoteNo && persisted.rows[0].customer_po_number === poNo, 'actual PostgreSQL row preserves linked document references');
  const quoteStatus = await pool.query('SELECT balance_status,version FROM quotations WHERE quotation_number=$1', [quoteNo]);
  const poStatus = await pool.query('SELECT status,version FROM customer_purchase_orders WHERE po_number=$1', [poNo]);
  assert(quoteStatus.rows[0].balance_status === `Converted (${soNumber})` && poStatus.rows[0].status === `Converted (${soNumber})`, 'source document statuses update in the same PostgreSQL conversion transaction');
  const secondRead = await request(`/api/sales-orders/${encodeURIComponent(soNumber)}`, {}, secondToken);
  assert(secondRead.status === 200 && secondRead.body.record.payload.items[0].itemName === 'Linked test part', 'second client reads persisted Sales Order and line items');
  assert((await request('/api/state/salesOrderHistory', { method: 'PUT', body: JSON.stringify({ data: [] }) })).status === 400, 'generic ERP state API rejects the converted Sales Order history key');

  normalizedOnlySoNumber = `SO-NORM-${randomUUID().slice(0, 8).toUpperCase()}`;
  missingLinesSoNumber = `SO-NOLINES-${randomUUID().slice(0, 8).toUpperCase()}`;
  await pool.query(
    `INSERT INTO sales_orders
      (so_number,so_date,customer_name,project_id,status,currency,grand_total,amount_inr,payload,created_by,updated_by)
     VALUES($1,$2,$3,$4,'Confirmed','INR',132,132,$5::jsonb,$6,$6)
     ON CONFLICT(so_number) DO NOTHING`,
    [normalizedOnlySoNumber, new Date().toISOString().slice(0, 10), 'Normalized Lines Customer', 'SOTEST-NORM',
      JSON.stringify({
        soDetails: { soNumber: normalizedOnlySoNumber, soDate: new Date().toISOString().slice(0, 10), projectId: 'SOTEST-NORM', deliveryDate: new Date().toISOString().slice(0, 10) },
        customerDetails: { customerName: 'Normalized Lines Customer', companyName: 'Normalized Lines Customer' },
        totals: { grandTotal: 132 }
      }), process.env.ERP_ADMIN_EMAIL]
  );
  await pool.query(
    `INSERT INTO sales_order_items
      (so_number,line_number,item_name,quantity,unit_price,line_amount,payload)
     VALUES
      ($1,1,'Plate',2,25,50,$2::jsonb),
      ($1,2,'Bracket',4,20.5,82,$3::jsonb)`,
    [normalizedOnlySoNumber,
      JSON.stringify({ itemCode: 'RAW-NORM-1', itemName: 'Plate', drawingNo: 'DWG-NORM-1', quantity: 2, unit: 'Nos' }),
      JSON.stringify({ itemCode: 'RAW-NORM-2', itemName: 'Bracket', drawingNo: 'DWG-NORM-2', quantity: 4, unit: 'Nos' })]
  );
  const normalizedRead = await request(`/api/sales-orders/${encodeURIComponent(normalizedOnlySoNumber)}`);
  assert(normalizedRead.status === 200
    && normalizedRead.body.record.payload.items.length === 2
    && normalizedRead.body.record.payload.items[0].drawingNo === 'DWG-NORM-1'
    && normalizedRead.body.record.payload.items[1].quantity === 4,
  'normalized-only PostgreSQL Sales Order rows are reconstructed into API item lines');
  assert(normalizedRead.body.record.payload.customerDetails.companyName === 'Normalized Lines Customer',
    'normalized Sales Order customer remains available for Item Requirements');
  const normalizedList = await request('/api/sales-orders');
  assert(normalizedList.body.records.some((record) => record.reference === normalizedOnlySoNumber
    && record.payload.items.length === 2),
  'Sales Order list refresh exposes normalized item lines');

  await pool.query(
    `INSERT INTO sales_orders
      (so_number,so_date,customer_name,status,currency,grand_total,amount_inr,payload,created_by,updated_by)
     VALUES($1,$2,$3,'Confirmed','INR',0,0,$4::jsonb,$5,$5)
     ON CONFLICT(so_number) DO NOTHING`,
    [missingLinesSoNumber, new Date().toISOString().slice(0, 10), 'Missing Lines Customer',
      JSON.stringify({
        soDetails: { soNumber: missingLinesSoNumber, soDate: new Date().toISOString().slice(0, 10) },
        customerDetails: { customerName: 'Missing Lines Customer', companyName: 'Missing Lines Customer' },
        totals: { grandTotal: 0 }
      }), process.env.ERP_ADMIN_EMAIL]
  );
  const missingRead = await request(`/api/sales-orders/${encodeURIComponent(missingLinesSoNumber)}`);
  assert(missingRead.status === 200
    && Array.isArray(missingRead.body.record.payload.items)
    && missingRead.body.record.payload.items.length === 0,
  'genuinely missing Sales Order lines return an explicit empty item array');
  assert((await request(`/api/sales-orders/${encodeURIComponent(`SO-NOTFOUND-${randomUUID().slice(0, 8)}`)}`)).status === 404,
    'invalid Sales Order number is rejected');

  const update1 = { ...soPayload, soDetails: { ...soPayload.soDetails, notes: 'Concurrent edit one' } };
  const update2 = { ...soPayload, soDetails: { ...soPayload.soDetails, notes: 'Concurrent edit two' } };
  const concurrent = await Promise.all([
    request(`/api/sales-orders/${encodeURIComponent(soNumber)}`, { method: 'PUT', body: JSON.stringify({ data: update1, version: 1 }) }),
    request(`/api/sales-orders/${encodeURIComponent(soNumber)}`, { method: 'PUT', body: JSON.stringify({ data: update2, version: 1 }) })
  ]);
  assert(concurrent.filter((item) => item.status === 200).length === 1 && concurrent.filter((item) => item.status === 409).length === 1, 'concurrent edits reject the stale Sales Order version');
  const rowAfterEdit = await pool.query('SELECT version,deleted_at FROM sales_orders WHERE so_number=$1', [soNumber]);
  assert(Number(rowAfterEdit.rows[0].version) === 2, 'PostgreSQL records exactly one winning update');
  const deleted = await request(`/api/sales-orders/${encodeURIComponent(soNumber)}`, { method: 'DELETE', body: JSON.stringify({ version: 2, reason: 'isolated API test' }) });
  assert(deleted.status === 200, 'Admin soft-delete returns database confirmation');
  const deletedRow = await pool.query('SELECT deleted_at,deleted_by,delete_reason FROM sales_orders WHERE so_number=$1', [soNumber]);
  assert(deletedRow.rows[0].deleted_at && deletedRow.rows[0].deleted_by && deletedRow.rows[0].delete_reason, 'deletion metadata is preserved in PostgreSQL');
  assert((await request(`/api/sales-orders/${encodeURIComponent(soNumber)}`)).status === 404, 'deleted Sales Order is excluded from active reads');
  const audits = await pool.query("SELECT action FROM erp_audit_log WHERE module='salesOrders' AND record_id=$1 ORDER BY id", [soNumber]);
  assert(audits.rows.some((row) => row.action === 'CREATE') && audits.rows.some((row) => row.action === 'UPDATE') && audits.rows.some((row) => row.action === 'SOFT_DELETE'), 'create, edit and delete audit history persists');

  await stop();
  await start();
  assert((await request(`/api/sales-orders/${encodeURIComponent(soNumber)}`)).status === 404, 'deleted Sales Order remains absent after Express restart');
  console.log(`Sales Order PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`Sales Order integration failed after ${assertions} assertions: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await stop();
  if (normalizedOnlySoNumber) {
    await pool.query('DELETE FROM sales_order_items WHERE so_number=$1', [normalizedOnlySoNumber]);
    await pool.query('DELETE FROM erp_audit_log WHERE module=$1 AND record_id=$2', ['salesOrders', normalizedOnlySoNumber]);
    await pool.query('DELETE FROM sales_orders WHERE so_number=$1', [normalizedOnlySoNumber]);
  }
  if (missingLinesSoNumber) {
    await pool.query('DELETE FROM sales_order_items WHERE so_number=$1', [missingLinesSoNumber]);
    await pool.query('DELETE FROM erp_audit_log WHERE module=$1 AND record_id=$2', ['salesOrders', missingLinesSoNumber]);
    await pool.query('DELETE FROM sales_orders WHERE so_number=$1', [missingLinesSoNumber]);
  }
  await pool.end();
}
