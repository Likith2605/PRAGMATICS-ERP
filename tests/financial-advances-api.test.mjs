/** Guarded PostgreSQL integration test for Customer and Supplier Advances. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing financial-advance tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_ADVANCE_TEST_PORT || 3398);
const base = `http://127.0.0.1:${port}`;
const suffix = randomUUID().slice(0, 10);
const customerName = `Advance Customer ${suffix}`;
const supplierName = `Advance Supplier ${suffix}`;
const customerId = `advance-customer-${suffix}`;
const supplierId = `advance-supplier-${suffix}`;
const employeeEmail = `advance-test-${suffix}@example.test`;
const employeePassword = `Ad-${suffix}-Pass!`;
const employeeId = `advance-employee-${suffix}`;
const customerInvoices = [`CI-ADV-${suffix}-1`, `CI-ADV-${suffix}-2`, `CI-ADV-${suffix}-USD`];
const supplierInvoice = `SI-ADV-${suffix}`;
const created = { customer: [], supplier: [] };
let child;
let token = '';
let employeeToken = '';
let employeeFixtureCreated = false;
let employeeCreateToken = '';
let originalCustomerLegacy = null;
let originalSupplierLegacy = null;
let customerLegacyWritten = false;
let supplierLegacyWritten = false;
let assertions = 0;
const assert = (ok, label) => {
  if (!ok) throw new Error(label);
  assertions += 1;
  console.log(`PASS ${label}`);
};
const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });
const api = async (path, options = {}, auth = token, department = 'Admin') => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(department ? { 'X-ERP-Department': department } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((migration) => migration.version === '048_employee_master')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated financial-advance server did not become ready with migration 046.');
};
const login = async (email, password, portal) => {
  const response = await api('/api/auth/login', json('POST', { email, password, portal }), '');
  return response.body;
};
const restoreStateKey = async (key, original, changed) => {
  if (!changed) return;
  if (original) {
    await pool.query('UPDATE erp_state SET data=$2::jsonb,updated_at=$3 WHERE storage_key=$1', [
      key, JSON.stringify(original.data), original.updated_at
    ]);
  } else {
    await pool.query('DELETE FROM erp_state WHERE storage_key=$1', [key]);
  }
};
const insertCustomerInvoice = async (invoiceNumber, currency, total, received) => {
  const payload = {
    customerDetails: { companyName: customerName },
    invoiceDetails: { currency, amountReceived: received, paymentStatus: 'Pending' },
    totals: { grandTotal: total },
    amountINR: total,
    receivedINR: received
  };
  await pool.query(
    `INSERT INTO customer_invoices(invoice_number,invoice_date,customer_name,payment_status,currency,grand_total,
       amount_received,balance_due,amount_inr,received_inr,balance_inr,payload,version,created_by,updated_by)
     VALUES($1,CURRENT_DATE,$2,'Pending',$3,$4,$5,$6,$7,$5,$8,$9::jsonb,1,'advance-test','advance-test')`,
    [invoiceNumber, customerName, currency, total, received, Math.max(0, total - received), total, Math.max(0, total - received), JSON.stringify(payload)]
  );
};
const createAdvance = async (kind, data, createToken) => {
  const response = await api(`/api/advances/${kind}`, json('POST', { data, createToken }));
  if (response.status === 201) created[kind].push(response.body.record.advanceNumber);
  return response;
};

try {
  await start();
  const admin = await login(process.env.ERP_ADMIN_EMAIL, process.env.ERP_ADMIN_PASSWORD, 'admin');
  token = admin.token;
  assert(Boolean(token), 'Admin session authenticates');

  const unauthenticated = await api('/api/advances/customer', {}, '');
  assert(unauthenticated.status === 401, 'Advance list requires authentication');

  const employeeFixture = {
    id: employeeId, employeeId, name: 'Advance Test Employee', email: employeeEmail,
    password: employeePassword, role: 'Sales Employee', roleKey: 'sales_employee',
    department: 'Sales Department', active: true,
    departmentAssignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  };
  employeeCreateToken = `advance-employee-create:${randomUUID()}`;
  const createdEmployee = await api('/api/employees', json('POST', { data: employeeFixture, createToken: employeeCreateToken }));
  assert(createdEmployee.status === 201, `Dedicated Employee API creates authorization fixture (${createdEmployee.body.error || ''})`);
  employeeFixtureCreated = true;
  employeeToken = (await login(employeeEmail, employeePassword, 'employee')).token || '';
  assert(Boolean(employeeToken), 'Non-Admin test account authenticates');
  const deniedSupplierList = await api('/api/advances/supplier', {}, employeeToken, 'Sales Department');
  assert(deniedSupplierList.status === 403, 'Supplier Advances preserve purchase-invoice role authorization');

  await pool.query('INSERT INTO customers(id,company_name) VALUES($1,$2)', [customerId, customerName]);
  await pool.query('INSERT INTO vendors(id,name) VALUES($1,$2)', [supplierId, supplierName]);
  await insertCustomerInvoice(customerInvoices[0], 'INR', 100, 20);
  await insertCustomerInvoice(customerInvoices[1], 'INR', 100, 0);
  await insertCustomerInvoice(customerInvoices[2], 'USD', 100, 0);

  const customerData = {
    party: customerName, date: new Date().toISOString().slice(0, 10), amount: 80, currency: 'INR',
    exchangeRateToINR: 1, mode: 'Bank Transfer', reference: `UTR-${suffix}`, againstRef: '', remarks: 'Test customer advance'
  };
  const customerToken = `advance-create:${randomUUID()}`;
  const customerAdvance = await createAdvance('customer', customerData, customerToken);
  assert(customerAdvance.status === 201 && customerAdvance.body.record.partyId === customerId, 'Customer advance links to the PostgreSQL customer master');
  const firstRetry = await createAdvance('customer', customerData, customerToken);
  assert(firstRetry.status === 200 && firstRetry.body.duplicate, 'Advance create is idempotent for a repeated matching request');
  const tokenConflict = await createAdvance('customer', { ...customerData, remarks: 'Different request' }, customerToken);
  assert(tokenConflict.status === 409, 'Idempotency token cannot create a different advance');

  const customerRecord = customerAdvance.body.record;
  const firstAdjustment = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}/adjustments`,
    json('POST', {
      invoiceNumber: customerInvoices[0], amount: 30, version: customerRecord.version, invoiceVersion: 1,
      idempotencyToken: `advance-adjust:${randomUUID()}`
    }));
  assert(firstAdjustment.status === 201 && firstAdjustment.body.invoice?.due === 50, 'Customer invoice balance includes partial advance allocation');
  const secondAdjustment = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}/adjustments`,
    json('POST', {
      invoiceNumber: customerInvoices[1], amount: 50, version: firstAdjustment.body.advance.version, invoiceVersion: 1,
      idempotencyToken: `advance-adjust:${randomUUID()}`
    }));
  assert(secondAdjustment.status === 201 && secondAdjustment.body.advance.balanceAmount === 0, 'One customer advance can be split across multiple matching-currency invoices');
  const currencyConflict = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}/adjustments`,
    json('POST', {
      invoiceNumber: customerInvoices[2], amount: 1, version: secondAdjustment.body.advance.version, invoiceVersion: 1,
      idempotencyToken: `advance-adjust:${randomUUID()}`
    }));
  assert(currencyConflict.status === 409, 'Advance cannot be applied to an invoice in a different currency');
  const blockedDelete = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}`,
    json('DELETE', { version: secondAdjustment.body.advance.version, reason: 'Must reverse first' }));
  assert(blockedDelete.status === 409, 'Advance with active invoice adjustments cannot be deleted');

  const reversal = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}/adjustments/${encodeURIComponent(firstAdjustment.body.adjustment.id)}`,
    json('DELETE', { version: secondAdjustment.body.advance.version, reason: 'Reverse test allocation' }));
  assert(reversal.status === 200 && reversal.body.invoice.due === 80, 'Adjustment reversal restores customer invoice outstanding balance');
  const reverseSecond = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}/adjustments/${encodeURIComponent(secondAdjustment.body.adjustment.id)}`,
    json('DELETE', { version: reversal.body.advance.version, reason: 'Reverse second allocation' }));
  assert(reverseSecond.status === 200 && reverseSecond.body.advance.balanceAmount === 80, 'All advance balance is restored after reversal');
  const invoiceRows = await api('/api/customer-invoices');
  const firstInvoiceView = invoiceRows.body.records?.find((row) => row.reference === customerInvoices[0]);
  assert(Number(firstInvoiceView?.balanceINR) === 80, 'Customer Invoice API reflects authoritative restored advance balance');

  const supplierPayload = {
    payload: {
      vendorDetails: { vendorName: supplierName, companyName: supplierName },
      invoiceDetails: { currency: 'INR', amountPaid: 50 },
      totals: { grandTotal: 200 },
      amountINR: 200,
      receivedINR: 50
    }
  };
  await pool.query(
    `INSERT INTO supplier_invoices(invoice_number,vendor_name,status,payload,version,create_token,created_by,updated_by)
     VALUES($1,$2,'Pending',$3::jsonb,1,$4,'advance-test','advance-test')`,
    [supplierInvoice, supplierName, JSON.stringify(supplierPayload), `supplier-invoice:${randomUUID()}`]
  );
  const supplierData = {
    party: supplierName, date: customerData.date, amount: 100, currency: 'INR',
    exchangeRateToINR: 1, mode: 'Bank Transfer', reference: '', againstRef: '', remarks: 'Test supplier advance'
  };
  const supplierAdvance = await createAdvance('supplier', supplierData, `advance-create:${randomUUID()}`);
  assert(supplierAdvance.status === 201 && supplierAdvance.body.record.partyId === supplierId, 'Supplier advance links to the PostgreSQL vendor master');
  const supplierAdjustment = await api(`/api/advances/supplier/${encodeURIComponent(supplierAdvance.body.record.advanceNumber)}/adjustments`,
    json('POST', {
      invoiceNumber: supplierInvoice, amount: 40, version: supplierAdvance.body.record.version, invoiceVersion: 1,
      idempotencyToken: `advance-adjust:${randomUUID()}`
    }));
  assert(supplierAdjustment.status === 201 && supplierAdjustment.body.invoice.due === 110, 'Supplier invoice outstanding balance includes advance adjustment');

  const concurrent = await createAdvance('customer', {
    ...customerData, amount: 10, remarks: 'Concurrent test'
  }, `advance-create:${randomUUID()}`);
  assert(concurrent.status === 201, 'Concurrency fixture advance is created');
  const concurrentNumber = concurrent.body.record.advanceNumber;
  const updateBody = (remarks) => json('PUT', {
    version: 1, data: { ...customerData, amount: 10, remarks }
  });
  const concurrentResults = await Promise.all([
    api(`/api/advances/customer/${encodeURIComponent(concurrentNumber)}`, updateBody('Concurrent update A')),
    api(`/api/advances/customer/${encodeURIComponent(concurrentNumber)}`, updateBody('Concurrent update B'))
  ]);
  assert(concurrentResults.filter((result) => result.status === 200).length === 1 &&
    concurrentResults.filter((result) => result.status === 409).length === 1,
  'Optimistic concurrency allows only one update for the same advance version');

  const customerLegacyRow = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='customerAdvanceHistory'");
  originalCustomerLegacy = customerLegacyRow.rowCount ? customerLegacyRow.rows[0] : null;
  const supplierLegacyRow = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='supplierAdvanceHistory'");
  originalSupplierLegacy = supplierLegacyRow.rowCount ? supplierLegacyRow.rows[0] : null;
  const legacyCustomerNumber = `CAR-LEG-${suffix}`;
  const legacySupplierNumber = `SAP-LEG-${suffix}`;
  const legacyCustomer = {
    advanceNumber: legacyCustomerNumber, date: customerData.date, party: customerName, amount: 12, currency: 'INR',
    exchangeRateToINR: 1, mode: 'Cheque', reference: '', againstRef: 'Informational only', remarks: 'Legacy fixture'
  };
  const legacySupplier = {
    advanceNumber: legacySupplierNumber, date: supplierData.date, party: supplierName, amount: 14, currency: 'INR',
    exchangeRateToINR: 1, mode: 'Cheque', reference: '', againstRef: 'Informational only', remarks: 'Legacy fixture'
  };
  await pool.query(
    `INSERT INTO erp_state(storage_key,data,updated_at) VALUES('customerAdvanceHistory',$1::jsonb,now())
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([legacyCustomer])]
  );
  customerLegacyWritten = true;
  await pool.query(
    `INSERT INTO erp_state(storage_key,data,updated_at) VALUES('supplierAdvanceHistory',$1::jsonb,now())
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([legacySupplier])]
  );
  supplierLegacyWritten = true;
  const customerPreview = await api('/api/advances/customer/migration-preview');
  const supplierPreview = await api('/api/advances/supplier/migration-preview');
  assert(customerPreview.body.eligible?.some((item) => item.number === legacyCustomerNumber), 'Customer Advance legacy preview identifies eligible records');
  assert(supplierPreview.body.eligible?.some((item) => item.number === legacySupplierNumber), 'Supplier Advance legacy preview identifies eligible records');
  const customerImport = await api('/api/advances/customer/migration-preview/import', json('POST', { numbers: [legacyCustomerNumber] }));
  const supplierImport = await api('/api/advances/supplier/migration-preview/import', json('POST', { numbers: [legacySupplierNumber] }));
  assert(customerImport.status === 200 && customerImport.body.imported.includes(legacyCustomerNumber), 'Selected Customer Advance legacy import persists');
  assert(supplierImport.status === 200 && supplierImport.body.imported.includes(legacySupplierNumber), 'Selected Supplier Advance legacy import persists');
  if (customerImport.status === 200 && customerImport.body.imported.includes(legacyCustomerNumber)) created.customer.push(legacyCustomerNumber);
  if (supplierImport.status === 200 && supplierImport.body.imported.includes(legacySupplierNumber)) created.supplier.push(legacySupplierNumber);

  const audit = await pool.query('SELECT action FROM customer_advance_audit WHERE advance_number=$1 ORDER BY id', [customerRecord.advanceNumber]);
  assert(audit.rows.some((row) => row.action === 'ADJUST') && audit.rows.some((row) => row.action === 'ADJUSTMENT_REVERSED'), 'Advance allocation and reversal are durably audited');
  const auditApi = await api(`/api/advances/customer/${encodeURIComponent(customerRecord.advanceNumber)}/audit`);
  assert(auditApi.status === 200 && auditApi.body.events.length >= 5, 'Authorized audit history API returns versioned advance events');

  console.log(`Financial-advance PostgreSQL integration test passed (${assertions} assertions).`);
} finally {
  await restoreStateKey('customerAdvanceHistory', originalCustomerLegacy, customerLegacyWritten).catch(() => {});
  await restoreStateKey('supplierAdvanceHistory', originalSupplierLegacy, supplierLegacyWritten).catch(() => {});
  if (employeeFixtureCreated) {
    await pool.query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [employeeEmail]).catch(() => {});
    await pool.query('DELETE FROM employees WHERE id=$1', [employeeId]).catch(() => {});
  }
  if (employeeCreateToken) await pool.query('DELETE FROM master_idempotency WHERE token=$1', [employeeCreateToken]).catch(() => {});
  for (const kind of ['customer', 'supplier']) {
    const advances = created[kind];
    if (!advances.length) continue;
    await pool.query(`DELETE FROM ${kind}_advance_adjustments WHERE advance_number=ANY($1::text[])`, [advances]).catch(() => {});
    await pool.query(`DELETE FROM ${kind}_advance_audit WHERE advance_number=ANY($1::text[])`, [advances]).catch(() => {});
    await pool.query(`DELETE FROM ${kind}_advances WHERE advance_number=ANY($1::text[])`, [advances]).catch(() => {});
  }
  await pool.query('DELETE FROM customer_invoice_audit WHERE invoice_number=ANY($1::text[])', [customerInvoices]).catch(() => {});
  await pool.query('DELETE FROM supplier_invoice_audit WHERE invoice_number=$1', [supplierInvoice]).catch(() => {});
  await pool.query('DELETE FROM customer_invoices WHERE invoice_number=ANY($1::text[])', [customerInvoices]).catch(() => {});
  await pool.query('DELETE FROM supplier_invoices WHERE invoice_number=$1', [supplierInvoice]).catch(() => {});
  await pool.query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
  await pool.query('DELETE FROM vendors WHERE id=$1', [supplierId]).catch(() => {});
  if (child) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await pool.end();
}
