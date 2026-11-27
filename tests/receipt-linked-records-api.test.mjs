/** Guarded test: receipt QC links use module_records, never the legacy erp_state array. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing receipt-link tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_RECEIPT_LINK_TEST_PORT || 3395);
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
      if (health.ready && health.database?.migrations?.some((m) => m.version === '030_receipt_quality_inspections')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated receipt-link server did not become ready.');
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
const qcNumber = `QC-LINK-${suffix}`;
const poNumber = `PO-LINK-${suffix}`;
const quotationNumber = `QT-LINK-${suffix}`;
const enquiryNumber = `ENQ-LINK-${suffix}`;
const indentNumber = `IND-LINK-${suffix}`;
const receiptNumber = `REC-LINK-${suffix}`;
const invoiceNumber = `TAX-LINK-${suffix}`;
const itemCode = `LINK-ITEM-${suffix}`;
const entryDate = new Date().toISOString().slice(0, 10);
let previousQcState;
let hadQcState = false;

try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');

  const existing = await pool.query("SELECT data FROM erp_state WHERE storage_key='qualityChecks'");
  hadQcState = existing.rowCount > 0;
  previousQcState = existing.rows[0]?.data ?? null;
  await pool.query("INSERT INTO erp_state(storage_key,data) VALUES('qualityChecks',$1::jsonb) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data", [JSON.stringify([
    { qcNumber, source: 'PRESERVED LEGACY SENTINEL', receiptNumber: '', status: 'Approved', items: [] }
  ])]);

  await pool.query('INSERT INTO purchase_indents(indent_number,so_number,project_id,status,payload,version,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,1,$6,$6)',
    [indentNumber, '', '', 'Approved', JSON.stringify({ indentNumber }), 'Isolated Tester']);
  await pool.query('INSERT INTO vendor_enquiries(enquiry_number,indent_number,pr_number,status,payload,version,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,1,$6,$6)',
    [enquiryNumber, indentNumber, '', 'Draft', JSON.stringify({ enquiryNumber }), 'Isolated Tester']);
  await pool.query('INSERT INTO vendor_quotations(quotation_number,enquiry_number,vendor_id,vendor_name,status,payload,version,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$7)',
    [quotationNumber, enquiryNumber, '', 'Link vendor', 'Accepted', JSON.stringify({ quotationNumber }), 'Isolated Tester']);
  await pool.query('INSERT INTO purchase_orders(po_number,quotation_number,indent_number,vendor_name,status,payload,version,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8,$8)',
    [poNumber, quotationNumber, null, 'Link vendor', 'Submitted',
      JSON.stringify({ poDetails: { poNumber, poStatus: 'Submitted' }, items: [{ itemCode, itemName: 'Link material', quantity: 2, unitPrice: 10, gst: 0 }], totals: { grandTotal: 20 } }),
      `link-po-${suffix}`, 'Isolated Tester']);

  await pool.query('INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES($1,$2,$3::jsonb,1,now(),$4)',
    ['qualityChecks', qcNumber, JSON.stringify({
      qcNumber, source: 'PostgreSQL', status: 'Approved', receiptNumber: '',
      items: [{ materialCode: itemCode, materialName: 'Link material', receivedQty: 2, acceptedQty: 2, rejectedQty: 0 }], history: []
    }), 'Isolated Tester']);

  const receipt = await api('/api/material-receipts', json('POST', {
    createToken: `link-receipt-${suffix}`,
    data: {
      receiptNumber, poNumber, invoiceNumber, invoiceDate: entryDate, vendor: 'Link vendor',
      status: 'Received', qcNumber,
      items: [{ materialCode: itemCode, materialName: 'Link material', unit: 'Nos', orderedQty: 2, receivedQty: 2, acceptedQty: 2, rejectedQty: 0 }], history: []
    }
  }));
  assert(receipt.status === 201, 'Receipt is created through the authenticated PostgreSQL API');

  const linked = await pool.query("SELECT version,data->>'receiptNumber' AS receipt FROM module_records WHERE storage_key='qualityChecks' AND record_id=$1", [qcNumber]);
  assert(linked.rowCount === 1 && Number(linked.rows[0].version) === 2 && linked.rows[0].receipt === receiptNumber, 'Receipt creation version-checks and links the authoritative per-record Quality Check');
  const untouched = await pool.query("SELECT data FROM erp_state WHERE storage_key='qualityChecks'");
  const sentinel = Array.isArray(untouched.rows[0]?.data) ? untouched.rows[0].data.find((row) => row.qcNumber === qcNumber) : null;
  assert(sentinel?.source === 'PRESERVED LEGACY SENTINEL' && sentinel.receiptNumber === '', 'Preserved legacy erp_state Quality Check is never mutated by the receipt write');
  const linkAudit = await pool.query("SELECT 1 FROM material_receipt_inspection_audit WHERE qc_number=$1 AND receipt_number=$2 AND action='RECEIPT_LINKED'", [qcNumber, receiptNumber]);
  assert(linkAudit.rowCount === 1, 'Quality Check link is audited in the same transaction');

  const deleted = await api(`/api/material-receipts/${encodeURIComponent(receiptNumber)}`, json('DELETE', { version: 1, reason: 'Isolated receipt link test' }));
  assert(deleted.status === 200, 'Receipt is soft-deleted through the authenticated API');
  const unlinked = await pool.query("SELECT version,data->>'receiptNumber' AS receipt FROM module_records WHERE storage_key='qualityChecks' AND record_id=$1", [qcNumber]);
  assert(Number(unlinked.rows[0].version) === 3 && unlinked.rows[0].receipt === '', 'Receipt deletion version-checks and unlinks the authoritative Quality Check');
  const stillUntouched = await pool.query("SELECT data FROM erp_state WHERE storage_key='qualityChecks'");
  const stillSentinel = Array.isArray(stillUntouched.rows[0]?.data) ? stillUntouched.rows[0].data.find((row) => row.qcNumber === qcNumber) : null;
  assert(stillSentinel?.source === 'PRESERVED LEGACY SENTINEL', 'Preserved legacy erp_state Quality Check is never mutated by the receipt deletion');
  const unlinkAudit = await pool.query("SELECT 1 FROM material_receipt_inspection_audit WHERE qc_number=$1 AND receipt_number=$2 AND action='RECEIPT_UNLINKED'", [qcNumber, receiptNumber]);
  assert(unlinkAudit.rowCount === 1, 'Quality Check unlink is audited in the same transaction');

  console.log(`Receipt linked-record PostgreSQL integration: ${assertions} passed, 0 failed.`);
} finally {
  await pool.query('DELETE FROM material_receipt_inspection_audit WHERE qc_number=$1', [qcNumber]);
  await pool.query('DELETE FROM material_receipt_items WHERE receipt_number=$1', [receiptNumber]);
  await pool.query('DELETE FROM material_receipt_audit WHERE receipt_number=$1', [receiptNumber]);
  await pool.query('DELETE FROM material_receipts WHERE receipt_number=$1', [receiptNumber]);
  await pool.query("DELETE FROM module_records WHERE storage_key='qualityChecks' AND record_id=$1", [qcNumber]);
  if (hadQcState) await pool.query("UPDATE erp_state SET data=$1::jsonb WHERE storage_key='qualityChecks'", [JSON.stringify(previousQcState)]);
  else await pool.query("DELETE FROM erp_state WHERE storage_key='qualityChecks'");
  await pool.query('DELETE FROM purchase_order_audit WHERE po_number=$1', [poNumber]);
  await pool.query('DELETE FROM purchase_orders WHERE po_number=$1', [poNumber]);
  await pool.query('DELETE FROM vendor_quotations WHERE quotation_number=$1', [quotationNumber]);
  await pool.query('DELETE FROM vendor_enquiries WHERE enquiry_number=$1', [enquiryNumber]);
  await pool.query('DELETE FROM purchase_indents WHERE indent_number=$1', [indentNumber]);
  await stop();
  await pool.end();
}
