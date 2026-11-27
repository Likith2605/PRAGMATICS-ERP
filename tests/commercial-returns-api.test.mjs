import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') {
  throw new Error('Refusing Commercial Returns tests outside vyavastha_test.');
}
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_COMMERCIAL_RETURNS_TEST_PORT || 3391);
const base = `http://127.0.0.1:${port}`;
const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
const customerInvoiceNumber = `INV-RET-${suffix}`;
const supplierInvoiceNumber = `SUP-RET-${suffix}`;
const customerCreateToken = `ret-invoice-${randomUUID()}`;
const supplierCreateToken = `ret-supplier-${randomUUID()}`;
const salesCreateToken = `sales-return-${randomUUID()}`;
const purchaseCreateToken = `purchase-return-${randomUUID()}`;
const purchaseRejectCreateToken = `purchase-return-reject-${randomUUID()}`;
const salesReturnNumbers = [];
const purchaseReturnNumbers = [];
const today = new Date().toISOString().slice(0, 10);
let child;
let token = '';
let assertions = 0;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((migration) => migration.version === '052_commercial_returns')) return;
    } catch { /* Wait for the isolated server to finish startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Commercial Returns server did not become ready.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const login = async () => (await api(
  '/api/auth/login',
  json('POST', { email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }),
  ''
)).body.token;

try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');
  assert((await api('/api/commercial-returns/sales', {}, '')).status === 401, 'Unauthenticated return reads are rejected');

  const customerInvoice = await api('/api/customer-invoices', json('POST', {
    data: {
      invoiceDetails: { invoiceNumber: customerInvoiceNumber, invoiceDate: today, amountReceived: 0 },
      customerDetails: { customerName: `Customer ${suffix}`, companyName: `Customer ${suffix}` },
      items: [{ itemCode: `CI-${suffix}`, itemName: 'Test customer item', quantity: 5, unit: 'Nos', unitPrice: 12, amount: 60 }],
      totals: { grandTotal: 60 }
    },
    createToken: customerCreateToken
  }));
  assert(customerInvoice.status === 201, 'Isolated Customer Invoice source is persisted through its API');

  const supplierInvoice = await api('/api/procurement/supplier-invoices', json('POST', {
    data: {
      reference: supplierInvoiceNumber,
      vendor: `Supplier ${suffix}`,
      payload: {
        invoiceDetails: { supplierInvoiceNumber: `BILL-${suffix}`, supplierInvoiceDate: today, amountPaid: 0 },
        vendorDetails: { vendorName: `Supplier ${suffix}`, companyName: `Supplier ${suffix}` },
        items: [{ itemCode: `SI-${suffix}`, itemName: 'Test supplier item', quantity: 4, unit: 'Nos', unitPrice: 7, amount: 28 }],
        totals: { grandTotal: 28 }
      }
    },
    createToken: supplierCreateToken
  }));
  assert(supplierInvoice.status === 201, 'Isolated Supplier Invoice source is persisted through its API');

  const sales = await api('/api/commercial-returns/sales', json('POST', {
    data: {
      date: today, invRef: customerInvoiceNumber, returnedBy: `Returner ${suffix}`, remarks: 'Isolated sales return',
      items: [{ sourceLineNumber: 1, returnQty: 2, reason: 'Damaged' }]
    },
    createToken: salesCreateToken
  }));
  assert(sales.status === 201 && sales.body.record?.returnNumber?.startsWith('SRTN-'), 'Sales return is created with a PostgreSQL-generated number');
  salesReturnNumbers.push(sales.body.record.returnNumber);
  assert(sales.body.record.customer === `Customer ${suffix}` && sales.body.record.totalValue === 24, 'Sales return uses authoritative invoice party and unit price');

  const salesUpdated = await api(`/api/commercial-returns/sales/${sales.body.record.returnNumber}`, json('PUT', {
    data: {
      date: today, invRef: customerInvoiceNumber, returnedBy: `Returner ${suffix}`, remarks: 'Updated isolated sales return',
      items: [{ sourceLineNumber: 1, returnQty: 1, reason: 'Damaged' }]
    },
    version: 1
  }));
  assert(salesUpdated.status === 200 && salesUpdated.body.record.status === 'Draft'
    && salesUpdated.body.record.totalValue === 12,
  `Sales return Draft can be updated and recalculated from PostgreSQL: ${JSON.stringify(salesUpdated)}`);

  const salesRetry = await api('/api/commercial-returns/sales', json('POST', {
    data: {
      date: today, invRef: customerInvoiceNumber, returnedBy: `Returner ${suffix}`, remarks: 'Isolated sales return',
      items: [{ sourceLineNumber: 1, returnQty: 2, reason: 'Damaged' }]
    },
    createToken: salesCreateToken
  }));
  assert(salesRetry.status === 200 && salesRetry.body.duplicate, 'Sales return retry is idempotent');

  const excessSales = await api('/api/commercial-returns/sales', json('POST', {
    data: { date: today, invRef: customerInvoiceNumber, returnedBy: `Returner ${suffix}`, items: [{ sourceLineNumber: 1, returnQty: 5 }] },
    createToken: `sales-excess-${randomUUID()}`
  }));
  assert(excessSales.status === 409, 'Sales return quantities cannot exceed the remaining invoice quantity');

  const purchase = await api('/api/commercial-returns/purchase', json('POST', {
    data: {
      date: today, billRef: supplierInvoiceNumber, returnedTo: `Supplier ${suffix}`, remarks: 'Isolated purchase return',
      items: [{ sourceLineNumber: 1, returnQty: 3, reason: 'Wrong specification' }]
    },
    createToken: purchaseCreateToken
  }));
  assert(purchase.status === 201 && purchase.body.record?.returnNumber?.startsWith('PRTN-'), 'Purchase return is created with a PostgreSQL-generated number');
  purchaseReturnNumbers.push(purchase.body.record.returnNumber);
  assert(purchase.body.record.supplier === `Supplier ${suffix}` && purchase.body.record.totalValue === 21, 'Purchase return uses authoritative supplier invoice values');

  await pool.query(
    "INSERT INTO inventory_items(item_code,material_name,category,unit,current_qty,unit_price,payload) VALUES($1,$2,'Raw Material','Nos',10,7,$3::jsonb)",
    [`SI-${suffix}`, 'Test supplier item', JSON.stringify({ integrationFixture: true })]
  );

  const salesSubmit = await api(`/api/commercial-returns/sales/${sales.body.record.returnNumber}/submit`, json('POST', { version: 2 }));
  assert(salesSubmit.status === 200 && salesSubmit.body.record.status === 'Submitted', 'Sales return can be submitted');
  const salesApprove = await api(`/api/commercial-returns/sales/${sales.body.record.returnNumber}/approve`, json('POST', { version: 3, reason: 'Approved isolated sales return' }));
  assert(salesApprove.status === 200 && salesApprove.body.record.status === 'Approved'
    && salesApprove.body.record.accountingEntryType === 'CREDIT_NOTE'
    && Boolean(salesApprove.body.record.stockPostedAt), 'Sales return approval posts stock IN and a credit accounting reference');

  const purchaseSubmit = await api(`/api/commercial-returns/purchase/${purchase.body.record.returnNumber}/submit`, json('POST', { version: 1 }));
  assert(purchaseSubmit.status === 200 && purchaseSubmit.body.record.status === 'Submitted', 'Purchase return can be submitted');
  const purchaseApprove = await api(`/api/commercial-returns/purchase/${purchase.body.record.returnNumber}/approve`, json('POST', { version: 2, reason: 'Approved isolated purchase return' }));
  assert(purchaseApprove.status === 200 && purchaseApprove.body.record.status === 'Approved'
    && purchaseApprove.body.record.accountingEntryType === 'DEBIT_NOTE'
    && Boolean(purchaseApprove.body.record.stockPostedAt), 'Purchase return approval posts stock OUT and a debit note');

  const salesLedger = await pool.query(
    "SELECT movement_type,quantity FROM stock_ledger_entries WHERE source_doc_ref=$1",
    [sales.body.record.returnNumber]
  );
  const purchaseLedger = await pool.query(
    "SELECT movement_type,quantity FROM stock_ledger_entries WHERE source_doc_ref=$1",
    [purchase.body.record.returnNumber]
  );
  const debitNote = await pool.query(
    "SELECT debit_note_number,status FROM debit_notes WHERE payload->>'commercialReturnNumber'=$1",
    [purchase.body.record.returnNumber]
  );
  assert(salesLedger.rowCount === 1 && salesLedger.rows[0].movement_type === 'RETURN'
    && purchaseLedger.rowCount === 1 && purchaseLedger.rows[0].movement_type === 'RETURN_OUT'
    && debitNote.rowCount === 1 && debitNote.rows[0].status === 'Approved',
  'Approved returns create exactly one stock movement and approved purchase debit note');

  const rejectedPurchase = await api('/api/commercial-returns/purchase', json('POST', {
    data: {
      date: today, billRef: supplierInvoiceNumber, returnedTo: `Supplier ${suffix}`,
      remarks: 'Rejected isolated purchase return',
      items: [{ sourceLineNumber: 1, returnQty: 1, reason: 'Rejected test' }]
    },
    createToken: purchaseRejectCreateToken
  }));
  purchaseReturnNumbers.push(rejectedPurchase.body.record?.returnNumber);
  const rejectedSubmit = await api(`/api/commercial-returns/purchase/${rejectedPurchase.body.record.returnNumber}/submit`, json('POST', { version: 1 }));
  const rejected = await api(`/api/commercial-returns/purchase/${rejectedPurchase.body.record.returnNumber}/reject`, json('POST', {
    version: 2,
    reason: 'Isolated rejection verification'
  }));
  assert(rejectedSubmit.status === 200 && rejected.status === 200 && rejected.body.record.status === 'Rejected',
    'Purchase return submit/reject lifecycle persists without stock or accounting posting');
  const rejectedDelete = await api(`/api/commercial-returns/purchase/${rejectedPurchase.body.record.returnNumber}`, json('DELETE', {
    version: 3,
    reason: 'Isolated soft-delete verification'
  }));
  assert(rejectedDelete.status === 200 && rejectedDelete.body.deleted === rejectedPurchase.body.record.returnNumber,
    'Rejected purchase return can be soft-deleted while preserving audit');

  const listedSales = await api('/api/commercial-returns/sales');
  const listedPurchase = await api('/api/commercial-returns/purchase');
  assert(listedSales.status === 200 && listedSales.body.records.some((record) => record.returnNumber === sales.body.record.returnNumber), 'Sales return reloads from PostgreSQL');
  assert(listedPurchase.status === 200 && listedPurchase.body.records.some((record) => record.returnNumber === purchase.body.record.returnNumber), 'Purchase return reloads from PostgreSQL');

  const stored = await pool.query(
    `SELECT return_type,return_number,total_value FROM commercial_returns
      WHERE return_number=ANY($1::text[]) ORDER BY return_type`,
    [[...salesReturnNumbers, ...purchaseReturnNumbers]]
  );
  const audited = await pool.query(
    `SELECT count(*)::int AS count FROM erp_audit_log
      WHERE module IN ('salesReturns','purchaseReturns') AND record_id=ANY($1::text[]) AND action='CREATE'`,
    [[...salesReturnNumbers, ...purchaseReturnNumbers]]
  );
  assert(stored.rowCount === 3 && audited.rows[0].count === 3, 'Return documents and CREATE audit events are committed to PostgreSQL');
  console.log(`RESULT: ${assertions} passed, 0 failed; writes restricted to vyavastha_test.`);
} finally {
  try {
    const returnNumbers = [...salesReturnNumbers, ...purchaseReturnNumbers];
    if (returnNumbers.length) {
      await pool.query(
        'DELETE FROM erp_audit_log WHERE record_id=ANY($1::text[]) AND module=ANY($2::text[])',
        [returnNumbers, ['salesReturns', 'purchaseReturns']]
      );
      await pool.query('DELETE FROM commercial_return_items WHERE return_number=ANY($1::text[])', [returnNumbers]);
      await pool.query('DELETE FROM commercial_returns WHERE return_number=ANY($1::text[])', [returnNumbers]);
        await pool.query(
          'DELETE FROM stock_ledger_entries WHERE source_doc_ref=ANY($1::text[])',
          [returnNumbers]
        );
        await pool.query(
          `DELETE FROM debit_note_items WHERE debit_note_number=ANY($1::text[])`,
          [returnNumbers.map((number) => `DN-${number}`)]
        );
        await pool.query(
          `DELETE FROM debit_notes WHERE payload->>'commercialReturnNumber'=ANY($1::text[])`,
          [returnNumbers]
        );
    }
    await pool.query('DELETE FROM customer_invoice_audit WHERE invoice_number=$1', [customerInvoiceNumber]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_number=$1', [customerInvoiceNumber]);
    await pool.query('DELETE FROM customer_invoices WHERE invoice_number=$1', [customerInvoiceNumber]);
    await pool.query('DELETE FROM supplier_invoice_audit WHERE invoice_number=$1', [supplierInvoiceNumber]);
    await pool.query('DELETE FROM supplier_invoices WHERE invoice_number=$1', [supplierInvoiceNumber]);
    await pool.query("DELETE FROM inventory_location_balances WHERE item_code=$1", [`SI-${suffix}`]);
    await pool.query("DELETE FROM inventory_items WHERE item_code=$1", [`SI-${suffix}`]);
    if (token) {
      await pool.query('UPDATE erp_sessions SET revoked_at=now() WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')]);
    }
  } finally {
    await stop();
    await pool.end();
  }
}
