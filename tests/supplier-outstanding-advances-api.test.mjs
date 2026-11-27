import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  buildSupplierOutstandingPartySummary,
  buildSupplierOutstandingRows,
  buildSupplierOutstandingSummary
} from '../src/utils/supplierOutstandingData.js';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') {
  throw new Error('Refusing Supplier Outstanding tests outside vyavastha_test.');
}
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) {
  throw new Error('ERP Admin test credentials are required.');
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_SUPPLIER_OUTSTANDING_TEST_PORT || 3409);
const base = `http://127.0.0.1:${port}`;
const suffix = randomUUID().slice(0, 10);
const supplierName = `Outstanding Supplier ${suffix}`;
const supplierId = `outstanding-supplier-${suffix}`;
const invoiceNumbers = [
  'NO-ADVANCE', 'PARTIAL', 'FULL', 'PAYMENT-ADVANCE', 'SPLIT-A', 'SPLIT-B',
  'MULTI-ADVANCE', 'REVERSED', 'USD', 'OVER-INVOICE', 'RACE-A', 'RACE-B', 'DELETED'
].map((label) => `SI-OUT-${suffix}-${label}`);
const advances = new Set();
const invoiceVersions = new Map();
const debitNoteNumber = `DN-OUT-${suffix}`;
let child;
let token = '';
let assertions = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
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
      if (health.ready && health.database?.migrations?.some((migration) => migration.version === '046_financial_advances')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Supplier Outstanding server did not become ready with migration 046.');
};
const login = async () => {
  const result = await api('/api/auth/login', json('POST', {
    email: process.env.ERP_ADMIN_EMAIL,
    password: process.env.ERP_ADMIN_PASSWORD,
    portal: 'admin'
  }), '');
  return result.body;
};
const createInvoice = async (label, total, paid = 0, currency = 'INR') => {
  const invoiceNumber = invoiceNumbers.find((number) => number.endsWith(`-${label}`));
  const record = {
    reference: invoiceNumber,
    vendor: supplierName,
    date: '2026-11-25',
    dueDate: '2026-12-25',
    status: 'Pending',
    payload: {
      vendorDetails: { companyName: supplierName },
      invoiceDetails: {
        supplierInvoiceNumber: invoiceNumber,
        supplierInvoiceDate: '2026-11-25',
        paymentDueDate: '2026-12-25',
        currency,
        amountPaid: paid
      },
      totals: { grandTotal: total },
      currency,
      amountINR: currency === 'INR' ? total : total * 83,
      receivedINR: currency === 'INR' ? paid : paid * 83
    }
  };
  await pool.query(
    `INSERT INTO supplier_invoices(invoice_number,vendor_name,status,payload,version,create_token,created_by,updated_by)
     VALUES($1,$2,'Pending',$3::jsonb,1,$4,'supplier-outstanding-test','supplier-outstanding-test')`,
    [invoiceNumber, supplierName, JSON.stringify(record), `supplier-outstanding:${randomUUID()}`]
  );
  invoiceVersions.set(invoiceNumber, 1);
  return invoiceNumber;
};
const createAdvance = async (amount, currency = 'INR') => {
  const result = await api('/api/advances/supplier', json('POST', {
    data: {
      party: supplierName,
      date: '2026-11-25',
      amount,
      currency,
      exchangeRateToINR: currency === 'INR' ? 1 : 83,
      mode: 'Bank Transfer',
      reference: `UTR-${randomUUID()}`,
      againstRef: '',
      remarks: 'Supplier Outstanding integration fixture'
    },
    createToken: `outstanding-advance:${randomUUID()}`
  }));
  assert.equal(result.status, 201, result.body.error);
  advances.add(result.body.record.advanceNumber);
  return result.body.record;
};
const allocate = async (advance, invoiceNumber, amount, idempotencyToken = `outstanding-adjust:${randomUUID()}`) => {
  const invoiceVersion = invoiceVersions.get(invoiceNumber) || 1;
  const result = await api(`/api/advances/supplier/${encodeURIComponent(advance.advanceNumber)}/adjustments`, json('POST', {
    invoiceNumber,
    amount,
    version: advance.version,
    invoiceVersion,
    idempotencyToken
  }));
  if (result.status === 201) invoiceVersions.set(invoiceNumber, invoiceVersion + 1);
  return result;
};
const reportData = async () => {
  const [invoiceResponse, advanceResponse] = await Promise.all([
    api('/api/procurement/supplier-invoices'),
    api('/api/advances/supplier')
  ]);
  assert.equal(invoiceResponse.status, 200, invoiceResponse.body.error);
  assert.equal(advanceResponse.status, 200, advanceResponse.body.error);
  return buildSupplierOutstandingRows(invoiceResponse.body.records, advanceResponse.body.records);
};
const cleanup = async () => {
  await pool.query('DELETE FROM debit_note_audit WHERE debit_note_number=$1', [debitNoteNumber]);
  await pool.query('DELETE FROM debit_note_items WHERE debit_note_number=$1', [debitNoteNumber]);
  await pool.query('DELETE FROM debit_notes WHERE debit_note_number=$1', [debitNoteNumber]);
  const advanceNumbers = [...advances];
  if (advanceNumbers.length) {
    await pool.query('DELETE FROM supplier_advance_adjustments WHERE advance_number=ANY($1::text[])', [advanceNumbers]);
    await pool.query('DELETE FROM supplier_advance_audit WHERE advance_number=ANY($1::text[])', [advanceNumbers]);
    await pool.query('DELETE FROM supplier_advances WHERE advance_number=ANY($1::text[])', [advanceNumbers]);
  }
  await pool.query('DELETE FROM supplier_invoice_audit WHERE invoice_number=ANY($1::text[])', [invoiceNumbers]);
  await pool.query('DELETE FROM supplier_invoices WHERE invoice_number=ANY($1::text[])', [invoiceNumbers]);
  await pool.query('DELETE FROM vendors WHERE id=$1', [supplierId]);
};

try {
  await start();
  token = (await login()).token || '';
  check(Boolean(token), 'Admin authenticates against the isolated PostgreSQL server');
  const anonymousInvoices = await api('/api/procurement/supplier-invoices', {}, '');
  const anonymousAdvances = await api('/api/advances/supplier', {}, '');
  check(anonymousInvoices.status === 401 && anonymousAdvances.status === 401, 'both report sources require authenticated access');

  await pool.query('INSERT INTO vendors(id,name) VALUES($1,$2)', [supplierId, supplierName]);
  const [noAdvance, partial, full, paidAndAdvance, splitA, splitB, multi, reversed, usd, overInvoice, raceA, raceB, deletedInvoice] = await Promise.all([
    createInvoice('NO-ADVANCE', 100, 20),
    createInvoice('PARTIAL', 100, 10),
    createInvoice('FULL', 80),
    createInvoice('PAYMENT-ADVANCE', 200, 50),
    createInvoice('SPLIT-A', 50),
    createInvoice('SPLIT-B', 70),
    createInvoice('MULTI-ADVANCE', 100),
    createInvoice('REVERSED', 50),
    createInvoice('USD', 100, 10, 'USD'),
    createInvoice('OVER-INVOICE', 20),
    createInvoice('RACE-A', 100),
    createInvoice('RACE-B', 100),
    createInvoice('DELETED', 25)
  ]);

  const partialAdvance = await createAdvance(50);
  const partialRetryToken = `outstanding-retry:${randomUUID()}`;
  const partialResult = await allocate(partialAdvance, partial, 30, partialRetryToken);
  check(partialResult.status === 201, 'partial advance allocation posts against the supplier invoice');
  const retryResult = await api(`/api/advances/supplier/${encodeURIComponent(partialAdvance.advanceNumber)}/adjustments`,
    json('POST', {
      invoiceNumber: partial,
      amount: 30,
      version: partialAdvance.version,
      invoiceVersion: 1,
      idempotencyToken: partialRetryToken
    }));
  check(retryResult.status === 200 && retryResult.body.duplicate, 'retrying an allocation token does not apply the advance twice');

  const fullAdvance = await createAdvance(80);
  const fullResult = await allocate(fullAdvance, full, 80);
  check(fullResult.status === 201 && fullResult.body.invoice.due === 0, 'full advance allocation settles an invoice to zero');

  const mixedAdvance = await createAdvance(25);
  const mixedResult = await allocate(mixedAdvance, paidAndAdvance, 25);
  check(mixedResult.status === 201 && mixedResult.body.invoice.due === 125, 'payments and advances both reduce the same invoice balance exactly once');

  const splitAdvance = await createAdvance(120);
  const splitFirst = await allocate(splitAdvance, splitA, 50);
  const splitSecond = await allocate(splitFirst.body.advance, splitB, 70);
  check(splitFirst.status === 201 && splitSecond.status === 201, 'one advance can be allocated across multiple invoices');

  const secondAdvance = await createAdvance(15);
  const secondAllocation = await allocate(secondAdvance, multi, 15);
  check(secondAllocation.status === 201, 'multiple advances can be allocated to invoices for one supplier');

  const unallocatedAdvance = await createAdvance(18);
  const deleteUnallocated = await api(`/api/advances/supplier/${encodeURIComponent(unallocatedAdvance.advanceNumber)}`,
    json('DELETE', { version: unallocatedAdvance.version, reason: 'Remove unallocated test advance' }));
  check(deleteUnallocated.status === 200, 'unallocated advance can be soft-deleted and is excluded from active reporting');

  const reverseAdvance = await createAdvance(20);
  const reverseAllocation = await allocate(reverseAdvance, reversed, 20);
  const reversal = await api(`/api/advances/supplier/${encodeURIComponent(reverseAdvance.advanceNumber)}/adjustments/${encodeURIComponent(reverseAllocation.body.adjustment.id)}`,
    json('DELETE', { version: reverseAllocation.body.advance.version, reason: 'Reverse test allocation' }));
  check(reverseAllocation.status === 201 && reversal.status === 200 && reversal.body.invoice.due === 50,
    'voided allocation is removed from the invoice and advance applied totals');

  const editedAdvance = await createAdvance(40);
  const editedAllocation = await allocate(editedAdvance, multi, 15);
  const edited = await api(`/api/advances/supplier/${encodeURIComponent(editedAdvance.advanceNumber)}`, json('PUT', {
    version: editedAllocation.body.advance.version,
    data: {
      party: supplierName, date: '2026-11-25', amount: 50, currency: 'INR',
      exchangeRateToINR: 1, mode: 'Bank Transfer', reference: 'EDITED', againstRef: '', remarks: 'Updated after allocation'
    }
  }));
  check(edited.status === 200 && edited.body.record.appliedAmount === 15 && edited.body.record.balanceAmount === 35,
    'editing an advance preserves existing allocation totals and updates only its remaining balance');

  const usdAdvance = await createAdvance(40, 'USD');
  const mismatch = await allocate(usdAdvance, noAdvance, 5);
  check(mismatch.status === 409, 'currency mismatch is rejected by the allocation API');
  const usdAllocation = await allocate(usdAdvance, usd, 30);
  check(usdAllocation.status === 201, 'same-currency USD advance allocation is accepted');

  const invoiceOverflowAdvance = await createAdvance(100);
  const invoiceOverflow = await allocate(invoiceOverflowAdvance, overInvoice, 21);
  check(invoiceOverflow.status === 409 && /invoice outstanding/i.test(invoiceOverflow.body.error),
    'allocation exceeding the eligible invoice balance is rejected');

  const advanceOverflow = await allocate(partialResult.body.advance, noAdvance, 21);
  check(advanceOverflow.status === 409 && /unallocated advance balance/i.test(advanceOverflow.body.error),
    'allocation exceeding the remaining advance balance is rejected');

  const raceAdvance = await createAdvance(20);
  const raceResults = await Promise.all([
    allocate(raceAdvance, raceA, 15, `race-adjust:${randomUUID()}`),
    allocate(raceAdvance, raceB, 15, `race-adjust:${randomUUID()}`)
  ]);
  check(raceResults.filter((result) => result.status === 201).length === 1 &&
    raceResults.filter((result) => result.status === 409).length === 1,
  'concurrent allocation requests enforce version conflicts and cannot overdraw an advance');

  const deletedRecord = await api(`/api/procurement/supplier-invoices/${encodeURIComponent(deletedInvoice)}`,
    json('DELETE', { version: 1, reason: 'Remove deleted invoice fixture' }));
  check(deletedRecord.status === 200, 'soft-deleted supplier invoices are removed from the report source');

  await pool.query(
    `INSERT INTO debit_notes(debit_note_number,debit_note_date,invoice_number,vendor_name,grand_total,status,created_by,updated_by,payload)
     VALUES($1,CURRENT_DATE,$2,$3,20,'Issued','supplier-outstanding-test','supplier-outstanding-test','{}'::jsonb)`,
    [debitNoteNumber, noAdvance, supplierName]
  );

  const rows = await reportData();
  const rowFor = (number) => rows.find((row) => row.invoiceNumber === number);
  check(rowFor(noAdvance)?.outstandingAmount === 80,
    'invoice without advance reports its outstanding payment balance');
  check(rowFor(noAdvance)?.outstandingAmount === 80,
    'Debit Note documents do not reduce invoice balances until the existing workflow posts a settlement credit');
  check(rowFor(partial)?.amountPaid === 10 && rowFor(partial)?.advanceAllocated === 30 &&
    rowFor(partial)?.outstandingAmount === 60 && rowFor(partial)?.supplierId === supplierId,
  'partial allocation is displayed separately from payments and deducted once');
  check(!rowFor(full), 'zero-balance invoice is not included in the outstanding register');
  check(rowFor(paidAndAdvance)?.outstandingAmount === 125, 'payment and advance are both reflected in report balance');
  check(!rowFor(splitA) && !rowFor(splitB), 'fully allocated split invoices are excluded from outstanding rows');
  check(rowFor(multi)?.advanceAllocated === 30 && rowFor(multi)?.outstandingAmount === 70,
    'report aggregates allocations from multiple advances on one invoice');
  check(rowFor(reversed)?.advanceAllocated === 0 && rowFor(reversed)?.outstandingAmount === 50,
    'reversed allocations no longer reduce outstanding');
  check(rowFor(usd)?.currency === 'USD' && rowFor(usd)?.outstandingAmount === 60,
    'foreign-currency balances remain in their invoice currency');
  check(!rowFor(deletedInvoice), 'deleted invoices are absent from active report data');

  const summaries = buildSupplierOutstandingSummary(rows);
  check(summaries.some((summary) => summary.currency === 'INR') && summaries.some((summary) => summary.currency === 'USD'),
    'grand totals are kept separate by currency');
  const supplierRows = rows.filter((row) => row.supplierName === supplierName);
  const partySummary = buildSupplierOutstandingPartySummary(supplierRows);
  check(partySummary.every((summary) => summary.supplierName === supplierName) &&
    partySummary.reduce((sum, summary) => sum + summary.outstandingAmount, 0) ===
    supplierRows.reduce((sum, row) => sum + row.outstandingAmount, 0),
  'supplier-level totals equal the sum of that supplier eligible invoice balances');

  const invoiceResponse = await api('/api/procurement/supplier-invoices');
  const advanceResponse = await api('/api/advances/supplier');
  const inconsistentAdvances = advanceResponse.body.records.map((record) => ({ ...record }));
  const activePartial = inconsistentAdvances.find((record) => record.advanceNumber === partialAdvance.advanceNumber);
  if (activePartial) activePartial.appliedAmount += 1;
  assert.throws(
    () => buildSupplierOutstandingRows(invoiceResponse.body.records, inconsistentAdvances),
    /do not reconcile/,
    'incomplete advance data must fail closed instead of showing partial report totals'
  );
  assertions += 1;
  console.log('PASS API allocation totals reconcile with invoice-settlement amounts');

  console.log(`Supplier Outstanding guarded integration: ${assertions} assertions passed; database verified as vyavastha_test.`);
} finally {
  if (child) child.kill();
  try { await cleanup(); } finally { await pool.end(); }
}
