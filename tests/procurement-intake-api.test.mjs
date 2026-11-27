import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') throw new Error('Refusing Procurement Intake tests outside vyavastha_test.');
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') { await pool.end(); throw new Error('Refusing database writes: current_database() is not exactly vyavastha_test.'); }

const port = Number(process.env.ERP_TEST_PORT || 3341);
const base = `http://127.0.0.1:${port}`;
let server;
let token = '';
let migrationFixtureId = '';
let migrationFixtureKeyExisted = false;
let receiptMigrationFixtureId = '';
let receiptMigrationPOId = '';
let receiptInvalidFixtureId = '';
let receiptLegacyStateKeys = { materialReceipts: false, supplierPOHistory: false };
let stockQCNumber = '';
let stockFixtureMaterialCode = '';
let stockFixtureItemRecordId = '';
let primaryReceiptNumber = '';
let primarySupplierInvoiceId = '';
let phase4POIds = [];
let phase4ReceiptIds = [];
let phase4InvoiceIds = [];
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks += 1; console.log(`PASS ${message}`); };
const legacyPONumberOf = (row) => String(row?.reference || row?.payload?.poDetails?.poNumber || '').trim();
const call = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const foreign = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (foreign) throw new Error(`Port ${port} is already serving an ERP server; refusing to verify against a foreign process.`);
  const childEnv = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete childEnv.DATABASE_URL;
  server = spawn(process.execPath, ['server.js'], { env: childEnv, stdio: 'ignore' });
  let ready = false;
  for (let n = 0; n < 100; n += 1) {
    try {
      const response = await fetch(`${base}/api/health`); const health = await response.json();
      if (health.ready && health.database?.migrations?.some((migration) => migration.version === '031_receipt_stock_postings')) { ready = true; break; }
    } catch { /* isolated test server is starting */ }
    await wait(200);
  }
  check(ready, 'isolated server applied Material Receipt migrations 028–031 and became ready');
  const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(login.status, 200, 'Admin test login'); token = login.body.token;

  const indentNo = `IND-T${Date.now()}`;
  stockFixtureMaterialCode = `AB-T${Date.now()}`;
  const enquiryNo = `VE-T${Date.now()}`;
  const quotationNo = `VQ-T${Date.now()}`;
  const tokenIndent = `indent:${Date.now()}:token`;
  const indent = { indentNumber: indentNo, indentDate: '2026-11-25', status: 'Under Purchase Review', projectId: 'T-PROJECT', soNumber: 'T-SO', customer: 'Test Buyer', items: [{ materialName: 'Alloy Bar', materialCode: stockFixtureMaterialCode, unit: 'kg', purchaseQty: 5 }], history: [] };
  const createdIndent = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: indent, createToken: tokenIndent }) });
  check(createdIndent.status === 201 && createdIndent.body.record?.indentNumber === indentNo && createdIndent.body.record.version === 1, 'creates and returns the confirmed PostgreSQL Purchase Indent');
  for (const status of ['Draft', 'Pending', 'Rejected']) {
    const unapprovedNo = `IND-${status.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const unapproved = { ...indent, indentNumber: unapprovedNo, status };
    const savedUnapproved = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: unapproved, createToken: `indent-${status}:${Date.now()}:token` }) });
    const deniedEnquiry = await call('/api/procurement/vendorEnquiry', { method: 'POST', body: JSON.stringify({ data: { enquiryNumber: `VE-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, indentNumber: unapprovedNo, prNumber: '', status: 'Draft', items: [{ materialName: 'Alloy Bar', requiredQty: 5, shortageQty: 5 }], vendors: [{ name: 'Test Supplier' }] }, createToken: `enquiry-${status}:${Date.now()}:token` }) });
    check(savedUnapproved.status === 201 && deniedEnquiry.status === 409 && /Admin-approved/.test(deniedEnquiry.body.error || ''), `${status} Purchase Indent cannot create a Vendor Enquiry`);
  }
  const materialRequestNo = `MR-T${Date.now()}`;
  const materialIndent = { ...indent, indentNumber: `IND-MR-${Date.now()}`, status: 'Draft', sourceType: 'materialRequest', requirementNumber: materialRequestNo };
  const materialIndentCreate = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: materialIndent, createToken: `mr-indent:${Date.now()}:token` }) });
  const duplicateMaterialIndent = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: { ...materialIndent, indentNumber: `${materialIndent.indentNumber}-DUP` }, createToken: `mr-indent-duplicate:${Date.now()}:token` }) });
  check(materialIndentCreate.status === 201 && duplicateMaterialIndent.status === 409, 'database source guard prevents duplicate Purchase Indents for one Material Request');
  const repurchaseToken = `repurchase-indent:${Date.now()}`;
  const repurchase = { ...indent, indentNumber: `IND-RP-${Date.now()}`, status: 'Submitted', repurchaseFor: `RRN-T${Date.now()}` };
  const repurchaseCreate = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: repurchase, createToken: repurchaseToken }) });
  const repurchaseRetry = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: { ...repurchase, indentNumber: `${repurchase.indentNumber}-RETRY` }, createToken: repurchaseToken }) });
  check(repurchaseCreate.status === 201 && repurchaseRetry.status === 200 && repurchaseRetry.body.duplicate && repurchaseRetry.body.record.indentNumber === repurchase.indentNumber, 'repurchase Indent retries return the original PostgreSQL record without duplication');
  const retryIndent = await call('/api/procurement/purchaseIndent', { method: 'POST', body: JSON.stringify({ data: indent, createToken: tokenIndent }) });
  check(retryIndent.status === 200 && retryIndent.body.duplicate, 'idempotent retry does not create a duplicate Purchase Indent');
  const approveIndent = await call(`/api/procurement/purchaseIndent/${indentNo}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { adminApprovedAt: new Date().toISOString(), adminApprovedBy: 'Test Admin', adminApprovedRemarks: 'Approval regression test' } }) });
  check(approveIndent.status === 200 && approveIndent.body.record.adminApprovedBy === 'Test Admin' && approveIndent.body.record.version === 2, 'persists authorized Admin approval on the Purchase Indent in PostgreSQL');
  const approvalAudit = await pool.query("SELECT after_values->>'adminApprovedBy' AS approved_by FROM procurement_record_audit WHERE entity_type='purchaseIndent' AND record_id=$1 AND action='UPDATE' ORDER BY created_at DESC LIMIT 1", [indentNo]);
  check(approvalAudit.rows[0]?.approved_by === 'Test Admin', 'records the Purchase Indent approval in PostgreSQL audit history');
  const refreshedIndent = await call(`/api/procurement/purchaseIndent/${indentNo}`);
  check(refreshedIndent.status === 200 && refreshedIndent.body.record.adminApprovedAt && refreshedIndent.body.record.adminApprovedBy === 'Test Admin', 'Purchase Indent approval remains visible after a fresh PostgreSQL read');
  const editIndent = await call(`/api/procurement/purchaseIndent/${indentNo}`, { method: 'PUT', body: JSON.stringify({ version: 2, data: { purchaseRemarks: 'Updated on test' } }) });
  check(editIndent.status === 200 && editIndent.body.record.version === 3, 'updates a Purchase Indent and increments its database version');
  const staleIndent = await call(`/api/procurement/purchaseIndent/${indentNo}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { purchaseRemarks: 'stale' } }) });
  check(staleIndent.status === 409, 'rejects a stale concurrent Purchase Indent update');
  const qcHandoff = await call(`/api/procurement/purchaseIndent/${indentNo}`, { method: 'PUT', body: JSON.stringify({ version: 3, data: { qcStatus: 'Sent to Quality Check', sentToQCAt: new Date().toISOString(), sentToQCBy: 'Ravi Admin', history: [...indent.history, { action: 'Sent to Quality Check' }] } }) });
  check(qcHandoff.status === 200 && qcHandoff.body.record.version === 4 && qcHandoff.body.record.qcStatus === 'Sent to Quality Check', 'persists the Indent Quality Check handoff with a versioned PostgreSQL update');
  const indentList = await call('/api/procurement/purchaseIndent');
  check(indentList.status === 200 && indentList.body.records.some((record) => record.indentNumber === indentNo && record.version === 4 && record.adminApprovedAt), 'lists the authoritative approved Purchase Indent after refresh');

  const enquiry = { enquiryNumber: enquiryNo, indentNumber: indentNo, prNumber: '', soNumber: 'T-SO', projectId: 'T-PROJECT', sourceType: 'Purchase Indent', status: 'Draft', vendors: [{ vendorId: 'V-01', name: 'Test Supplier', status: 'Invited' }], items: [{ materialName: 'Alloy Bar', requiredQty: 5, shortageQty: 5, unit: 'kg' }], quotationNumbers: [] };
  const createdEnquiry = await call('/api/procurement/vendorEnquiry', { method: 'POST', body: JSON.stringify({ data: enquiry, createToken: `enquiry:${Date.now()}:token` }) });
  check(createdEnquiry.status === 201 && createdEnquiry.body.record.enquiryNumber === enquiryNo, 'creates a Vendor Enquiry linked to a database-approved indent');
  const enquiryLink = await pool.query('SELECT indent_number,pr_number FROM vendor_enquiries WHERE enquiry_number=$1', [enquiryNo]);
  check(enquiryLink.rows[0]?.indent_number === indentNo && enquiryLink.rows[0]?.pr_number === '', 'persists the original Purchase Indent reference without misclassifying it as a Purchase Request');
  const duplicateEnquiry = await call('/api/procurement/vendorEnquiry', { method: 'POST', body: JSON.stringify({ data: { ...enquiry, enquiryNumber: `${enquiryNo}-DUP` }, createToken: `enquiry-duplicate:${Date.now()}:token` }) });
  check(duplicateEnquiry.status === 409, 'prevents a second active Vendor Enquiry for the same Purchase Indent');
  const quotation = { quotationNumber: quotationNo, enquiryNumber: enquiryNo, indentNumber: indentNo, vendorId: 'V-01', vendorName: 'Test Supplier', status: 'Received', items: [{ materialCode: stockFixtureMaterialCode, materialName: 'Alloy Bar', quotedQty: 5, unitPrice: 42, taxPct: 18, taxAmount: 37.8, totalPrice: 210 }], totalAmount: 210, taxAmount: 37.8, totalWithTax: 247.8 };
  const createdQuotation = await call('/api/procurement/vendorQuotation', { method: 'POST', body: JSON.stringify({ data: quotation, createToken: `quote:${Date.now()}:token` }) });
  check(createdQuotation.status === 201 && createdQuotation.body.record.quotationNumber === quotationNo, 'creates a Vendor Quotation and atomically advances its enquiry');
  const retrievedQuotation = await call(`/api/procurement/vendorQuotation/${encodeURIComponent(quotationNo)}`);
  const quotationList = await call('/api/procurement/vendorQuotation');
  const missingQuotation = await call(`/api/procurement/vendorQuotation/${encodeURIComponent(`${quotationNo}-MISSING`)}`);
  check(retrievedQuotation.status === 200 && retrievedQuotation.body.record?.quotationNumber === quotationNo && retrievedQuotation.body.record?.enquiryNumber === enquiryNo && retrievedQuotation.body.record?.items?.[0]?.materialCode === stockFixtureMaterialCode, 'retrieves the exact PostgreSQL Vendor Quotation by its stable business number');
  check(quotationList.status === 200 && quotationList.body.records.some((record) => record.quotationNumber === quotationNo), 'Vendor Quotation list and direct lookup return the same persisted record');
  check(missingQuotation.status === 404, 'missing Vendor Quotation returns a clear not-found response');
  const acceptQuote = await call(`/api/procurement/vendorQuotation/${quotationNo}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { status: 'Accepted', acceptedBy: 'Ravi Admin', acceptedDate: '2026-11-25' } }) });
  check(acceptQuote.status === 200 && acceptQuote.body.record.status === 'Accepted', 'Admin accepts the Vendor Quotation in PostgreSQL before PO conversion');
  const poNumber = `PO-T${Date.now()}`;
  const purchaseOrder = {
    date: '2026-11-25', reference: poNumber, vendor: 'Test Supplier', projectRef: 'T-PROJECT', soRef: 'T-SO',
    indentRef: indentNo, enquiryRef: enquiryNo, quotationRef: quotationNo, quotationNumber: quotationNo,
    dueDate: '2026-12-10', total: '₹ 247.80', status: 'Submitted',
    payload: {
      poDetails: { poNumber, poDate: '2026-11-25', deliveryDueDate: '2026-12-10', projectRef: 'T-PROJECT', salesOrderRef: 'T-SO', indentRef: indentNo, enquiryRef: enquiryNo, quotationRef: quotationNo, poStatus: 'Submitted' },
      vendorDetails: { vendorName: 'Test Supplier', companyName: 'Test Supplier' },
      items: [{ itemCode: stockFixtureMaterialCode, itemName: 'Alloy Bar', quantity: 5, unitPrice: 42, gst: 18 }],
      totals: { grandTotal: 247.8 }
    }
  };
  const invalidPO = structuredClone(purchaseOrder);
  invalidPO.payload.items[0].quantity = 99;
  const failedConversion = await call('/api/procurement/purchase-orders/from-quotation', { method: 'POST', body: JSON.stringify({ data: invalidPO, createToken: 'po-failed:tx-token' }) });
  const rollbackState = await pool.query('SELECT q.status AS quotation_status,i.status AS indent_status,(SELECT count(*)::int FROM purchase_orders WHERE po_number=$3) AS po_count FROM vendor_quotations q JOIN purchase_indents i ON i.indent_number=$2 WHERE q.quotation_number=$1', [quotationNo, indentNo, poNumber]);
  check(failedConversion.status === 400 && rollbackState.rows[0]?.quotation_status === 'Accepted' && rollbackState.rows[0]?.indent_status === 'Under Purchase Review' && rollbackState.rows[0]?.po_count === 0, 'failed PO conversion rolls back without changing quotation or Indent state');
  const firstPOToken = `po-concurrent:first:${Date.now()}`;
  const secondPOToken = `po-concurrent:second:${Date.now()}`;
  const conversionAttempts = await Promise.all([
    call('/api/procurement/purchase-orders/from-quotation', { method: 'POST', body: JSON.stringify({ data: purchaseOrder, createToken: firstPOToken }) }),
    call('/api/procurement/purchase-orders/from-quotation', { method: 'POST', body: JSON.stringify({ data: purchaseOrder, createToken: secondPOToken }) })
  ]);
  check(conversionAttempts.every((attempt) => [201, 200].includes(attempt.status)) && conversionAttempts.filter((attempt) => attempt.body.record?.reference === poNumber).length === 2 && conversionAttempts.some((attempt) => attempt.body.duplicate), `concurrent PO conversion requests resolve to the same idempotent database record (${JSON.stringify(conversionAttempts.map((attempt) => ({ status: attempt.status, error: attempt.body.error || '', duplicate: attempt.body.duplicate })))})`);
  const retryPO = await call('/api/procurement/purchase-orders/from-quotation', { method: 'POST', body: JSON.stringify({ data: purchaseOrder, createToken: firstPOToken }) });
  check(retryPO.status === 200 && retryPO.body.duplicate && retryPO.body.record.reference === poNumber, 'retry returns the confirmed Purchase Order without duplicating it');
  const poEdit = await call(`/api/procurement/purchase-orders/${poNumber}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { payload: { ...purchaseOrder.payload, poDetails: { ...purchaseOrder.payload.poDetails, notes: 'confirmed edit' } } } }) });
  check(poEdit.status === 200 && poEdit.body.record.version === 2 && poEdit.body.record.payload.poDetails.notes === 'confirmed edit', 'edits a Purchase Order with a database version increment');
  const stalePO = await call(`/api/procurement/purchase-orders/${poNumber}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { payload: purchaseOrder.payload } }) });
  check(stalePO.status === 409, 'rejects stale Purchase Order edits');
  const readPO = await call(`/api/procurement/purchase-orders/${poNumber}`);
  const listPO = await call('/api/procurement/purchase-orders');
  check(readPO.status === 200 && readPO.body.record.version === 2 && listPO.status === 200 && listPO.body.records.some((item) => item.reference === poNumber && item.version === 2), 'retrieves and lists the authoritative Purchase Order after refresh');
  const receiptNumber = (await call('/api/material-receipts/sequences/next')).body.number;
  primaryReceiptNumber = receiptNumber;
  const receiptInvoiceNo = `TAX-T${Date.now()}`;
  const materialReceipt = { receiptNumber, poNumber, invoiceNumber: receiptInvoiceNo, invoiceDate: '2026-11-25', vendor: 'Test Supplier', status: 'Received / Awaiting Quality Check', items: [{ materialCode: stockFixtureMaterialCode, materialName: 'Alloy Bar', unit: 'kg', orderedQty: 5, receivedQty: 5, batchNumber: 'LOT-T-01' }], history: [] };
  const receiptToken = `receipt:${Date.now()}:token`;
  const receiptCreates = await Promise.all([1, 2].map(() => call('/api/material-receipts', { method: 'POST', body: JSON.stringify({ data: materialReceipt, createToken: receiptToken }) })));
  const receiptLineDb = await pool.query('SELECT material_code,received_qty FROM material_receipt_items WHERE receipt_number=$1 ORDER BY line_number', [receiptNumber]);
  check(/^REC-\d+$/.test(receiptNumber) && receiptCreates.some((result) => result.status === 201 && result.body.record.version === 1), 'reserves the existing REC numbering format and creates the confirmed PostgreSQL Material Receipt');
  check(receiptCreates.length === 2 && receiptCreates.every((result) => [200, 201].includes(result.status)) && receiptCreates.filter((result) => result.status === 200 && result.body.duplicate).length === 1, 'concurrent Material Receipt retries create one PostgreSQL record and return the same record idempotently');
  check(receiptLineDb.rowCount === 1 && receiptLineDb.rows[0].material_code === stockFixtureMaterialCode && Number(receiptLineDb.rows[0].received_qty) === 5, 'stores receipt material lines as normalized PostgreSQL rows');
  const excessReceipt = await call('/api/material-receipts', { method: 'POST', body: JSON.stringify({ data: { ...materialReceipt, receiptNumber: `REC-EXCESS-${Date.now()}`, invoiceNumber: `TAX-EXCESS-${Date.now()}`, items: [{ ...materialReceipt.items[0], receivedQty: 1 }] }, createToken: `receipt-excess:${Date.now()}` }) });
  check(excessReceipt.status === 409, 'rejects receipt quantities that exceed the Purchase Order quantity');
  const editReceipt = await call(`/api/material-receipts/${receiptNumber}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { ...materialReceipt, remarks: 'Edited in PostgreSQL' } }) });
  const staleReceipt = await call(`/api/material-receipts/${receiptNumber}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: materialReceipt }) });
  const readReceipt = await call(`/api/material-receipts/${receiptNumber}`);
  check(editReceipt.status === 200 && editReceipt.body.record.version === 2 && staleReceipt.status === 409 && readReceipt.status === 200 && readReceipt.body.record.remarks === 'Edited in PostgreSQL', 'versions Material Receipt updates and rejects stale edits');
  const receiptList = await call('/api/material-receipts');
  check(receiptList.status === 200 && receiptList.body.records.some((item) => item.receiptNumber === receiptNumber && item.version === 2), 'lists the authoritative PostgreSQL Material Receipts');
  const existingStockCode = await pool.query("SELECT record_id FROM module_records WHERE storage_key='inventoryItems' AND lower(data->>'itemCode')=lower($1)", [stockFixtureMaterialCode]);
  if (existingStockCode.rowCount) throw new Error('Refusing to mutate a pre-existing inventory code fixture.');
  stockQCNumber = `QC-RECEIPT-T${Date.now()}`;
  const qcRecord = { qcNumber: stockQCNumber, source: 'Material Receipt', inspectionType: 'Material Receipt Inspection', receiptNumber, poNumber, vendor: 'Test Supplier', status: 'Partially Approved', inspectionDate: '2026-11-25', inspector: 'Test Quality', items: [{ materialCode: stockFixtureMaterialCode, materialName: 'Alloy Bar', unit: 'kg', receivedQty: 5, acceptedQty: 3, rejectedQty: 2, reworkQty: 0, batchNumber: 'LOT-T-01', result: 'Partially Accepted' }], history: [] };
  const invalidQC = await call(`/api/material-receipts/${receiptNumber}/quality-check`, { method: 'PUT', body: JSON.stringify({ version: 0, data: { ...qcRecord, items: [{ ...qcRecord.items[0], receivedQty: 6, acceptedQty: 4, rejectedQty: 2 }] } }) });
  check(invalidQC.status === 409, 'rejects inspection quantity greater than the normalized received receipt line');
  const saveReceiptQC = await call(`/api/material-receipts/${receiptNumber}/quality-check`, { method: 'PUT', body: JSON.stringify({ version: 0, data: qcRecord }) });
  const receiptQCItems = await pool.query('SELECT material_code,received_qty,accepted_qty,rejected_qty FROM material_receipt_inspection_items WHERE qc_number=$1', [stockQCNumber]);
  const receiptAfterQC = await pool.query('SELECT payload->>\'qcNumber\' AS qc,payload->>\'qcStatus\' AS status,version FROM material_receipts WHERE receipt_number=$1', [receiptNumber]);
  check(saveReceiptQC.status === 201 && saveReceiptQC.body.record.version === 1 && receiptQCItems.rowCount === 1 && Number(receiptQCItems.rows[0].accepted_qty) === 3 && Number(receiptQCItems.rows[0].rejected_qty) === 2 && receiptAfterQC.rows[0]?.qc === stockQCNumber && receiptAfterQC.rows[0]?.status === 'Partially Approved', 'persists receipt inspection and accepted/rejected quantities transactionally');
  const retryReceiptQC = await call(`/api/material-receipts/${receiptNumber}/quality-check`, { method: 'PUT', body: JSON.stringify({ version: 0, data: qcRecord }) });
  const staleReceiptQC = await call(`/api/material-receipts/${receiptNumber}/quality-check`, { method: 'PUT', body: JSON.stringify({ version: 0, data: { ...qcRecord, remarks: 'stale update' } }) });
  const receiptQCList = await call('/api/material-receipt-quality-checks');
  if (!(retryReceiptQC.status === 200 && retryReceiptQC.body.duplicate && staleReceiptQC.status === 409 && receiptQCList.status === 200 && receiptQCList.body.records.some((row) => row.qcNumber === stockQCNumber && row.version === 1))) console.log('Receipt QC diagnostic:', JSON.stringify({ retryReceiptQC, staleReceiptQC, receiptQCList }));
  check(retryReceiptQC.status === 200 && retryReceiptQC.body.duplicate && staleReceiptQC.status === 409 && receiptQCList.status === 200 && receiptQCList.body.records.some((row) => row.qcNumber === stockQCNumber && row.version === 1), 'makes initial receipt inspection retry idempotent, rejects stale edit, and lists PostgreSQL inspections');
  const stockBefore = await pool.query("SELECT data->>'currentQty' AS qty FROM module_records WHERE storage_key='inventoryItems' AND lower(data->>'itemCode')=lower($1)", [stockFixtureMaterialCode]);
  const stockPosts = await Promise.all([1, 2].map(() => call(`/api/material-receipt-quality-checks/${stockQCNumber}/post-stock`, { method: 'POST', body: '{}' })));
  const stockMovementRows = await pool.query('SELECT receipt_number,qc_number,quantity,balance_before,balance_after FROM receipt_stock_movements WHERE qc_number=$1', [stockQCNumber]);
  const stockAfter = await pool.query("SELECT data->>'currentQty' AS qty FROM module_records WHERE storage_key='inventoryItems' AND lower(data->>'itemCode')=lower($1)", [stockFixtureMaterialCode]);
  const stockAudit = await pool.query("SELECT count(*)::int AS n FROM receipt_stock_movement_audit a JOIN receipt_stock_movements m ON m.id=a.movement_id WHERE m.qc_number=$1", [stockQCNumber]);
  const stockPostOk = stockPosts.every((result) => [200, 201].includes(result.status)) && stockPosts.filter((result) => result.body.duplicate).length === 1 && stockMovementRows.rowCount === 1 && Number(stockMovementRows.rows[0].quantity) === 3 && Number(stockAfter.rows[0]?.qty) - Number(stockBefore.rows[0]?.qty || 0) === 3 && stockAudit.rows[0].n === 1;
  if (!stockPostOk) console.log('Receipt stock diagnostic:', JSON.stringify({ stockPosts, stockMovementRows: stockMovementRows.rows, stockBefore: stockBefore.rows, stockAfter: stockAfter.rows, stockAudit: stockAudit.rows }));
  check(stockPostOk, 'posts only accepted quantity once under concurrent retries with a linked ledger and audit');
  const receiptPreview = await call('/api/material-receipts/migration-preview');
  check(receiptPreview.status === 200 && receiptPreview.body.counts && Array.isArray(receiptPreview.body.eligible), 'Admin receipt migration preview classifies preserved legacy records without importing them');
  receiptMigrationFixtureId = `REC-LEGACY-TEST-${Date.now()}`;
  receiptMigrationPOId = `PO-LEGACY-TEST-${Date.now()}`;
  const legacyPOKey = await pool.query("SELECT data FROM erp_state WHERE storage_key='supplierPOHistory'");
  const legacyReceiptKey = await pool.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts'");
  receiptLegacyStateKeys = { materialReceipts: legacyReceiptKey.rowCount > 0, supplierPOHistory: legacyPOKey.rowCount > 0 };
  if ((legacyPOKey.rowCount && !Array.isArray(legacyPOKey.rows[0]?.data)) || (legacyReceiptKey.rowCount && !Array.isArray(legacyReceiptKey.rows[0]?.data))) throw new Error('Refusing to modify non-array preserved legacy receipt fixtures.');
  const legacyPO = { reference: receiptMigrationPOId, vendor: 'Legacy Test Supplier', status: 'Submitted', payload: { poDetails: { poNumber: receiptMigrationPOId, poStatus: 'Submitted' }, items: [{ itemCode: 'LEG-01', itemName: 'Legacy Material', quantity: 4, unit: 'kg' }] } };
  const legacyReceipt = { receiptNumber: receiptMigrationFixtureId, poNumber: receiptMigrationPOId, invoiceNumber: `LEG-TAX-${Date.now()}`, invoiceDate: '2026-11-25', vendor: 'Legacy Test Supplier', status: 'Received / Awaiting Quality Check', items: [{ materialCode: 'LEG-01', materialName: 'Legacy Material', unit: 'kg', orderedQty: 4, receivedQty: 2, batchNumber: 'LEG-BATCH-1' }], history: [] };
  const previousPOs = Array.isArray(legacyPOKey.rows[0]?.data) ? legacyPOKey.rows[0].data : [];
  const previousReceipts = Array.isArray(legacyReceiptKey.rows[0]?.data) ? legacyReceiptKey.rows[0].data : [];
  await pool.query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES('supplierPOHistory',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [JSON.stringify([...previousPOs, legacyPO])]);
  await pool.query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES('materialReceipts',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [JSON.stringify([...previousReceipts, legacyReceipt])]);
  receiptInvalidFixtureId = `REC-INVALID-${Date.now()}`;
  const invalidReceipt = { receiptNumber: receiptInvalidFixtureId, poNumber: receiptMigrationPOId, invoiceNumber: 'INVALID', invoiceDate: '2026-11-25', items: [] };
  await pool.query("UPDATE erp_state SET data=data || $1::jsonb,updated_at=now() WHERE storage_key='materialReceipts'", [JSON.stringify([invalidReceipt])]);
  const previewWithFixture = await call('/api/material-receipts/migration-preview');
  check(previewWithFixture.status === 200 && previewWithFixture.body.eligible.some((record) => record.receiptNumber === receiptMigrationFixtureId) && previewWithFixture.body.invalid.some((entry) => entry.record?.receiptNumber === invalidReceipt.receiptNumber), 'classifies a new legacy receipt as eligible and rejects an invalid empty-line record in preview');
  const rollbackImport = await call('/api/material-receipts/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationFixtureId, invalidReceipt.receiptNumber] }) });
  const rolledBackReceipt = await pool.query('SELECT 1 FROM material_receipts WHERE receipt_number=$1', [receiptMigrationFixtureId]);
  check(rollbackImport.status === 400 && rolledBackReceipt.rowCount === 0, 'rolls back all receipt imports when a selected invalid record fails validation');
  const importedLegacyReceipt = await call('/api/material-receipts/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationFixtureId] }) });
  const importedReceiptDb = await pool.query('SELECT receipt_number FROM material_receipts WHERE receipt_number=$1', [receiptMigrationFixtureId]);
  const importedReceiptLines = await pool.query('SELECT material_code,received_qty FROM material_receipt_items WHERE receipt_number=$1', [receiptMigrationFixtureId]);
  const importedReceiptAudit = await pool.query("SELECT count(*)::int AS n FROM material_receipt_audit WHERE receipt_number=$1 AND action='LEGACY_IMPORT'", [receiptMigrationFixtureId]);
  check(importedLegacyReceipt.status === 200 && importedLegacyReceipt.body.imported.length === 1 && importedReceiptDb.rowCount === 1 && importedReceiptLines.rowCount === 1 && importedReceiptLines.rows[0].material_code === 'LEG-01' && Number(importedReceiptLines.rows[0].received_qty) === 2 && importedReceiptAudit.rows[0].n === 1, 'imports only the selected eligible legacy receipt, normalized lines, and audit record');
  const repeatReceiptImport = await call('/api/material-receipts/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationFixtureId] }) });
  check(repeatReceiptImport.status === 200 && repeatReceiptImport.body.skipped.some((row) => row.receiptNumber === receiptMigrationFixtureId), 'repeated receipt import detects the existing identical record without duplicating it');
  const changedLegacyReceipt = { ...legacyReceipt, remarks: 'Changed legacy copy must not overwrite PostgreSQL' };
  const currentLegacyReceipts = await pool.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts'");
  const changedRows = currentLegacyReceipts.rows[0].data.map((row) => row.receiptNumber === receiptMigrationFixtureId ? changedLegacyReceipt : row);
  await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='materialReceipts'", [JSON.stringify(changedRows)]);
  const changedPreview = await call('/api/material-receipts/migration-preview');
  const changedImport = await call('/api/material-receipts/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationFixtureId] }) });
  const preservedReceipt = await pool.query('SELECT payload->>\'remarks\' AS remarks FROM material_receipts WHERE receipt_number=$1', [receiptMigrationFixtureId]);
  check(changedPreview.body.conflicts.some((entry) => entry.record.receiptNumber === receiptMigrationFixtureId) && changedImport.body.conflicts.some((entry) => entry.receiptNumber === receiptMigrationFixtureId) && preservedReceipt.rows[0]?.remarks !== changedLegacyReceipt.remarks, 'reports and preserves changed legacy conflicts without overwriting the PostgreSQL receipt');
  const supplierBillNo = `SINV-T${Date.now()}`;
  primarySupplierInvoiceId = supplierBillNo;
  const supplierInvoice = { date: '2026-11-25', reference: supplierBillNo, poRef: poNumber, receiptNumber, vendor: 'Test Supplier', dueDate: '2026-12-25', total: '₹ 247.80', status: 'Pending', balanceDue: '₹ 247.80', payload: { invoiceDetails: { supplierInvoiceNumber: supplierBillNo, supplierInvoiceDate: '2026-11-25', paymentDueDate: '2026-12-25', poReference: poNumber, paymentStatus: 'Pending', amountPaid: '0' }, vendorDetails: { companyName: 'Test Supplier' }, items: [{ itemCode: stockFixtureMaterialCode, itemName: 'Alloy Bar', quantity: 5, unitPrice: 42 }], totals: { grandTotal: 247.8 } } };
  const supplierInvoiceToken = `supplier-invoice:${Date.now()}:token`;
  const poVersionBeforeBill = Number((await pool.query('SELECT version FROM purchase_orders WHERE po_number=$1', [poNumber])).rows[0]?.version || 0);
  const saveInvoice = await call('/api/procurement/supplier-invoices', { method: 'POST', body: JSON.stringify({ data: supplierInvoice, createToken: supplierInvoiceToken }) });
  const linkedPOAfterBill = await pool.query('SELECT payload->>\'billedInvoiceRef\' AS bill,payload->>\'billingStatus\' AS status,payload->\'progress\' AS progress,version FROM purchase_orders WHERE po_number=$1', [poNumber]);
  const receiptAfterBill = await pool.query('SELECT payload->>\'supplierInvoiceNumber\' AS invoice,version FROM material_receipts WHERE receipt_number=$1', [receiptNumber]);
  const reconciledProgress = linkedPOAfterBill.rows[0]?.progress || {};
  check(saveInvoice.status === 201
    && saveInvoice.body.record.reference === supplierBillNo
    && saveInvoice.body.record.version === 1
    && saveInvoice.body.purchaseOrder?.version === poVersionBeforeBill + 2
    && Number(linkedPOAfterBill.rows[0]?.version) === poVersionBeforeBill + 2
    && linkedPOAfterBill.rows[0]?.bill === supplierBillNo
    && linkedPOAfterBill.rows[0]?.status === 'Billed'
    && Number(reconciledProgress.ordered) === 5
    && Number(reconciledProgress.received) === 5
    && Number(reconciledProgress.accepted) === 3
    && Number(reconciledProgress.rejected) === 2
    && Number(reconciledProgress.invoiced) === 5
    && receiptAfterBill.rows[0]?.invoice === supplierBillNo
    && Number(receiptAfterBill.rows[0]?.version) === 5,
  'creates the Supplier Invoice and transactionally reconciles ordered/received/accepted/rejected/invoiced PO progress');
  const invoiceRetry = await call('/api/procurement/supplier-invoices', { method: 'POST', body: JSON.stringify({ data: supplierInvoice, createToken: supplierInvoiceToken }) });
  check(invoiceRetry.status === 200 && invoiceRetry.body.duplicate && invoiceRetry.body.record.reference === supplierBillNo, 'idempotent retry returns the original Supplier Invoice without duplication');
  const retryInvoice = await call('/api/procurement/supplier-invoices', { method: 'POST', body: JSON.stringify({ data: supplierInvoice, createToken: `supplier-invoice-retry:${Date.now()}:token` }) });
  check(retryInvoice.status === 409, 'rejects duplicate Supplier Invoice number with a different idempotency token');
  const paymentPayload = structuredClone(supplierInvoice.payload); paymentPayload.invoiceDetails.amountPaid = '100'; paymentPayload.invoiceDetails.paymentStatus = 'Partial';
  const editInvoice = await call(`/api/procurement/supplier-invoices/${supplierBillNo}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { ...supplierInvoice, status: 'Partial', payload: paymentPayload } }) });
  check(editInvoice.status === 200 && editInvoice.body.record.version === 2 && editInvoice.body.record.payload.invoiceDetails.amountPaid === '100', 'updates Supplier Invoice payment status with database versioning');
  const staleInvoice = await call(`/api/procurement/supplier-invoices/${supplierBillNo}`, { method: 'PUT', body: JSON.stringify({ version: 1, data: { ...supplierInvoice } }) });
  check(staleInvoice.status === 409, 'rejects stale Supplier Invoice edits');
  const invoiceList = await call('/api/procurement/supplier-invoices');
  const invoiceAudit = await pool.query('SELECT count(*)::int AS n FROM supplier_invoice_audit WHERE invoice_number=$1', [supplierBillNo]);
  check(invoiceList.status === 200 && invoiceList.body.records.some((item) => item.reference === supplierBillNo && item.version === 2) && invoiceAudit.rows[0].n === 2, 'reads Supplier Invoice and audit history from PostgreSQL');
  const deleteInvoice = await call(`/api/procurement/supplier-invoices/${supplierBillNo}`, { method: 'DELETE', body: JSON.stringify({ version: 2, reason: 'isolated integration test' }) });
  const deletedInvoice = await pool.query('SELECT deleted_at,version FROM supplier_invoices WHERE invoice_number=$1', [supplierBillNo]);
  check(deleteInvoice.status === 200 && Boolean(deletedInvoice.rows[0]?.deleted_at) && Number(deletedInvoice.rows[0]?.version) === 3, 'Admin deletion soft-deletes the Supplier Invoice and retains its database record');
  const receiptAfterVoid = await pool.query('SELECT payload->>\'supplierInvoiceNumber\' AS invoice,version FROM material_receipts WHERE receipt_number=$1', [receiptNumber]);
  check(deleteInvoice.status === 200 && receiptAfterVoid.rows[0]?.invoice === '' && Number(receiptAfterVoid.rows[0]?.version) === 6, 'Supplier Invoice void clears the linked receipt reference in the same transaction');
  const deleteReceipt = await call(`/api/material-receipts/${receiptNumber}`, { method: 'DELETE', body: JSON.stringify({ version: 6, reason: 'isolated integration test' }) });
  check(deleteReceipt.status === 409, 'Store deletion remains blocked after accepted quantity is posted into inventory');
  const invoicePreview = await call('/api/procurement/supplier-invoices/migration-preview');
  check(invoicePreview.status === 200 && invoicePreview.body.counts && Array.isArray(invoicePreview.body.eligible) && Array.isArray(invoicePreview.body.conflicts), 'Supplier Invoice legacy migration preview is read-only and classifies records');
  migrationFixtureId = `SINV-LEGACY-TEST-${Date.now()}`;
  const legacyKey = await pool.query("SELECT data FROM erp_state WHERE storage_key='supplierInvoiceHistory'");
  migrationFixtureKeyExisted = legacyKey.rowCount > 0;
  const oldLegacyInvoices = legacyKey.rows[0]?.data;
  if (legacyKey.rowCount && !Array.isArray(oldLegacyInvoices)) throw new Error('Refusing to replace a non-array supplierInvoiceHistory test database value.');
  const legacyInvoiceFixture = { date: '2026-11-25', reference: migrationFixtureId, poRef: '-', vendor: 'Legacy Test Supplier', dueDate: '2026-12-25', total: '₹ 19.00', status: 'Pending', balanceDue: '₹ 19.00', payload: { invoiceDetails: { supplierInvoiceNumber: migrationFixtureId, supplierInvoiceDate: '2026-11-25', paymentDueDate: '2026-12-25', poReference: '', paymentStatus: 'Pending', amountPaid: '0' }, vendorDetails: { companyName: 'Legacy Test Supplier' }, items: [{ itemCode: 'LT-01', itemName: 'Legacy Item', quantity: 1, unitPrice: 19 }], totals: { grandTotal: 19 } } };
  const legacyInvoiceRows = [...(Array.isArray(oldLegacyInvoices) ? oldLegacyInvoices : []), legacyInvoiceFixture];
  await pool.query("INSERT INTO erp_state(storage_key,data,updated_at) VALUES('supplierInvoiceHistory',$1::jsonb,now()) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()", [JSON.stringify(legacyInvoiceRows)]);
  const previewLegacyInvoice = await call('/api/procurement/supplier-invoices/migration-preview');
  check(previewLegacyInvoice.status === 200 && previewLegacyInvoice.body.eligible.some((row) => row.reference === migrationFixtureId), 'legacy preview marks a never-imported Supplier Invoice eligible');
  const importLegacyInvoice = await call('/api/procurement/supplier-invoices/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [migrationFixtureId] }) });
  const importedInvoiceDb = await pool.query('SELECT invoice_number,payload FROM supplier_invoices WHERE invoice_number=$1', [migrationFixtureId]);
  const importedInvoiceAudit = await pool.query("SELECT count(*)::int AS n FROM supplier_invoice_audit WHERE invoice_number=$1 AND action='LEGACY_IMPORT'", [migrationFixtureId]);
  check(importLegacyInvoice.status === 200 && importLegacyInvoice.body.imported?.length === 1 && importedInvoiceDb.rowCount === 1 && importedInvoiceAudit.rows[0].n === 1, 'explicit Admin import persists the selected legacy Supplier Invoice and audit in PostgreSQL');
  const retryLegacyImport = await call('/api/procurement/supplier-invoices/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [migrationFixtureId] }) });
  check(retryLegacyImport.status === 200 && retryLegacyImport.body.skipped.some((row) => row.reference === migrationFixtureId && row.reason.includes('identically')), 'legacy import retry detects the identical PostgreSQL record without duplication');
  const alteredLegacyRows = legacyInvoiceRows.map((row) => row.reference === migrationFixtureId ? { ...row, status: 'Paid' } : row);
  await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='supplierInvoiceHistory'", [JSON.stringify(alteredLegacyRows)]);
  const conflictedLegacyPreview = await call('/api/procurement/supplier-invoices/migration-preview');
  const unchangedImported = await pool.query('SELECT status FROM supplier_invoices WHERE invoice_number=$1', [migrationFixtureId]);
  check(conflictedLegacyPreview.status === 200 && conflictedLegacyPreview.body.conflicts.some((row) => row.record.reference === migrationFixtureId) && unchangedImported.rows[0]?.status === 'Pending', 'legacy conflict is reported without overwriting the PostgreSQL Supplier Invoice');
  const indentQC = { qcNumber: `QC-T${Date.now()}`, indentNumber: indentNo, poNumber, source: 'Purchase Indent', status: 'Approved', items: [{ materialCode: stockFixtureMaterialCode, materialName: 'Alloy Bar', receivedQty: 5, acceptedQty: 5, rejectedQty: 0 }] };
  const saveQC = await call('/api/procurement/purchase-indent-quality-checks', { method: 'POST', body: JSON.stringify({ data: indentQC, indentVersion: 5, qcVersion: 0 }) });
  check(saveQC.status === 201 && saveQC.body.record.version === 1 && saveQC.body.indent.version === 6, 'saves Indent Quality Check and updates its Indent atomically');
  const staleQC = await call('/api/procurement/purchase-indent-quality-checks', { method: 'POST', body: JSON.stringify({ data: { ...indentQC, status: 'Rejected' }, indentVersion: 5, qcVersion: 1 }) });
  check(staleQC.status === 409, 'rejects stale Indent Quality Check edits');
  const qcList = await call('/api/procurement/purchase-indent-quality-checks');
  check(qcList.status === 200 && qcList.body.records.some((item) => item.qcNumber === indentQC.qcNumber && item.version === 1), 'serves Indent Quality Checks from PostgreSQL after refresh');
  const currentPOVersion = Number((await pool.query('SELECT version FROM purchase_orders WHERE po_number=$1', [poNumber])).rows[0]?.version || 0);
  const protectedDelete = await call(`/api/procurement/purchase-orders/${poNumber}`, { method: 'DELETE', body: JSON.stringify({ version: currentPOVersion, reason: 'test dependency protection' }) });
  check(protectedDelete.status === 409 && /converted Purchase Indent history/i.test(protectedDelete.body.error || ''), 'prevents deleting a Purchase Order linked to a converted Indent');
  const dbRows = await pool.query("SELECT (SELECT count(*) FROM purchase_indents WHERE indent_number=$1) AS indents,(SELECT count(*) FROM vendor_enquiries WHERE enquiry_number=$2) AS enquiries,(SELECT count(*) FROM vendor_quotations WHERE quotation_number=$3) AS quotations,(SELECT status FROM vendor_enquiries WHERE enquiry_number=$2) AS enquiry_status,(SELECT payload->>'poNumber' FROM vendor_enquiries WHERE enquiry_number=$2) AS enquiry_po", [indentNo, enquiryNo, quotationNo]);
  const conversionRows = await pool.query('SELECT p.po_number,p.version,p.payload->>\'reference\' AS ref,q.status AS quote_status,q.payload->>\'poNumber\' AS quote_po,i.status AS indent_status,i.payload->>\'poNumber\' AS indent_po,i.payload->>\'qcNumber\' AS qc_number,(SELECT count(*)::int FROM purchase_indent_quality_checks WHERE indent_number=i.indent_number) AS qc_count FROM purchase_orders p JOIN vendor_quotations q ON q.quotation_number=p.quotation_number JOIN purchase_indents i ON i.indent_number=p.indent_number WHERE p.po_number=$1', [poNumber]);
  check(dbRows.rows[0].indents === '1' && dbRows.rows[0].enquiries === '1' && dbRows.rows[0].quotations === '1' && dbRows.rows[0].enquiry_status === 'Closed' && dbRows.rows[0].enquiry_po === poNumber && conversionRows.rowCount === 1 && conversionRows.rows[0].quote_status === 'PO Created' && conversionRows.rows[0].quote_po === poNumber && conversionRows.rows[0].indent_status === 'Converted to PO' && conversionRows.rows[0].indent_po === poNumber && conversionRows.rows[0].qc_number === indentQC.qcNumber && conversionRows.rows[0].qc_count === 1, 'verifies PostgreSQL Enquiry → Quotation → PO → Indent → Quality Check relationships');
  const audit = await pool.query('SELECT count(*)::int AS n FROM procurement_record_audit WHERE record_id=ANY($1::text[])', [[indentNo, enquiryNo, quotationNo]]);
  const poAudit = await pool.query('SELECT count(*)::int AS n FROM purchase_order_audit WHERE po_number=$1', [poNumber]);
  const qcAudit = await pool.query('SELECT count(*)::int AS n FROM purchase_indent_quality_audit WHERE qc_number=$1', [indentQC.qcNumber]);
  check(audit.rows[0].n >= 7 && poAudit.rows[0].n >= 2 && qcAudit.rows[0].n >= 1, 'writes Indent, quotation, PO and Quality Check audit history');
  const denied = await call(`/api/procurement/vendorEnquiry/${enquiryNo}`, { method: 'DELETE', body: JSON.stringify({ version: 1, reason: 'test' }), headers: { Authorization: `Bearer ${token}` } });
  check(denied.status === 409, 'preserves dependency protection for an enquiry with quotation history');
  const preview = await call('/api/procurement/vendorEnquiry/migration-preview');
  check(preview.status === 200 && preview.body.counts && !preview.body.eligible?.some((row) => row.enquiryNumber === enquiryNo), 'legacy preview classifies existing PostgreSQL record without auto-importing it');
  const gone = await call('/api/procurement/vendorQuotation/DOES-NOT-EXIST');
  check(gone.status === 404, 'record lookup returns PostgreSQL not-found rather than local fallback');

  /* ------------------------------- Phase 4 ------------------------------- *
   * Purchase Order reconciliation, duplicate billing guards, and the explicit
   * Admin migration of preserved legacy Purchase Orders.
   * ---------------------------------------------------------------------- */
  const anonymousPOPreview = await fetch(`${base}/api/procurement/purchase-orders/migration-preview`);
  check(anonymousPOPreview.status === 401 || anonymousPOPreview.status === 403, 'Purchase Order migration preview requires an authenticated Administrator');
  const poPreviewBeforeImport = await call('/api/procurement/purchase-orders/migration-preview');
  const legacyPOStillOnlyLocal = await pool.query('SELECT count(*)::int AS n FROM purchase_orders WHERE po_number=$1', [receiptMigrationPOId]);
  check(poPreviewBeforeImport.status === 200 && poPreviewBeforeImport.body.eligible.some((row) => legacyPONumberOf(row) === receiptMigrationPOId) && legacyPOStillOnlyLocal.rows[0].n === 0, 'legacy Purchase Order preview classifies it eligible without writing any PostgreSQL row');
  const importLegacyPO = await call('/api/procurement/purchase-orders/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationPOId] }) });
  const legacyPORow = await pool.query('SELECT po_number,quotation_number,vendor_name,payload,version FROM purchase_orders WHERE po_number=$1', [receiptMigrationPOId]);
  const legacyPOProgress = legacyPORow.rows[0]?.payload?.progress || {};
  phase4POIds.push(receiptMigrationPOId);
  check(importLegacyPO.status === 200 && importLegacyPO.body.imported.length === 1 && legacyPORow.rowCount === 1 && legacyPORow.rows[0].quotation_number === null && Number(legacyPOProgress.ordered) === 4 && Number(legacyPOProgress.received) === 2 && legacyPOProgress.status === 'Partially Received', 'explicit Admin import persists the legacy Purchase Order with NULL quotation and reconciled progress from its imported receipt');
  const repeatPOImport = await call('/api/procurement/purchase-orders/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationPOId] }) });
  check(repeatPOImport.status === 200 && repeatPOImport.body.skipped.some((row) => row.id === receiptMigrationPOId && row.reason.includes('identically')), 'repeated legacy Purchase Order import detects the identical PostgreSQL record without duplication');
  const legacyPOSnapshot = (await pool.query("SELECT data FROM erp_state WHERE storage_key='supplierPOHistory'")).rows[0]?.data;
  const changedPOSnapshot = (Array.isArray(legacyPOSnapshot) ? legacyPOSnapshot : []).map((row) => legacyPONumberOf(row) === receiptMigrationPOId ? { ...row, vendor: 'Changed Legacy Vendor' } : row);
  await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='supplierPOHistory'", [JSON.stringify(changedPOSnapshot)]);
  const conflictedPOPreview = await call('/api/procurement/purchase-orders/migration-preview');
  const conflictedPOImport = await call('/api/procurement/purchase-orders/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records: [receiptMigrationPOId] }) });
  const preservedPOVendor = (await pool.query('SELECT vendor_name FROM purchase_orders WHERE po_number=$1', [receiptMigrationPOId])).rows[0]?.vendor_name;
  check(conflictedPOPreview.body.conflicts.some((entry) => legacyPONumberOf(entry.record) === receiptMigrationPOId) && conflictedPOImport.body.conflicts.some((entry) => entry.id === receiptMigrationPOId) && preservedPOVendor === 'Legacy Test Supplier', 'changed legacy Purchase Order content is reported as a conflict and never overwrites PostgreSQL');
  const secondReceiptNumber = (await call('/api/material-receipts/sequences/next')).body.number;
  const secondReceipt = { receiptNumber: secondReceiptNumber, poNumber: receiptMigrationPOId, invoiceNumber: `LEG-TAX2-${Date.now()}`, invoiceDate: '2026-11-25', vendor: 'Legacy Test Supplier', status: 'Received / Awaiting Quality Check', items: [{ materialCode: 'LEG-01', materialName: 'Legacy Material', unit: 'kg', orderedQty: 4, receivedQty: 2, batchNumber: 'LEG-BATCH-2' }], history: [] };
  const createSecondReceipt = await call('/api/material-receipts', { method: 'POST', body: JSON.stringify({ data: secondReceipt, createToken: `receipt-phase4:${Date.now()}` }) });
  phase4ReceiptIds.push(secondReceiptNumber);
  const progressAfterSecondReceipt = (await pool.query('SELECT payload->\'progress\' AS progress,status FROM purchase_orders WHERE po_number=$1', [receiptMigrationPOId])).rows[0];
  check(createSecondReceipt.status === 201 && Number(progressAfterSecondReceipt.progress?.received) === 4 && Number(progressAfterSecondReceipt.progress?.pending) === 0 && progressAfterSecondReceipt.status === 'Received / Awaiting QC', 'a second Material Receipt on the same Purchase Order reconciles received and pending quantity in PostgreSQL');
  const excessSecondReceipt = await call('/api/material-receipts', { method: 'POST', body: JSON.stringify({ data: { ...secondReceipt, receiptNumber: `REC-P4-EXCESS-${Date.now()}`, invoiceNumber: `TAX-P4-EXCESS-${Date.now()}`, items: [{ ...secondReceipt.items[0], receivedQty: 1 }] }, createToken: `receipt-phase4-excess:${Date.now()}` }) });
  check(excessSecondReceipt.status === 409, 'receipts beyond the ordered quantity are still rejected after reconciliation');
  const phase4InvoiceNumber = `SINV-P4-${Date.now()}`;
  const phase4Invoice = { date: '2026-11-25', reference: phase4InvoiceNumber, poRef: receiptMigrationPOId, receiptNumber: secondReceiptNumber, vendor: 'Legacy Test Supplier', dueDate: '2026-12-25', total: '₹ 84.00', status: 'Pending', balanceDue: '₹ 84.00', payload: { invoiceDetails: { supplierInvoiceNumber: phase4InvoiceNumber, supplierInvoiceDate: '2026-11-25', paymentDueDate: '2026-12-25', poReference: receiptMigrationPOId, paymentStatus: 'Pending', amountPaid: '0' }, vendorDetails: { companyName: 'Legacy Test Supplier' }, items: [{ itemCode: 'LEG-01', itemName: 'Legacy Material', quantity: 2, unitPrice: 42 }], totals: { grandTotal: 84 } } };
  phase4InvoiceIds.push(phase4InvoiceNumber);
  const savePhase4Invoice = await call('/api/procurement/supplier-invoices', { method: 'POST', body: JSON.stringify({ data: phase4Invoice, createToken: `phase4-invoice:${Date.now()}` }) });
  const progressAfterPhase4Invoice = (await pool.query('SELECT payload->\'progress\' AS progress FROM purchase_orders WHERE po_number=$1', [receiptMigrationPOId])).rows[0];
  const duplicateBillNumber = await call('/api/procurement/supplier-invoices', { method: 'POST', body: JSON.stringify({ data: { ...phase4Invoice, reference: `SINV-P4-DUP-${Date.now()}`, receiptNumber: '', payload: { ...phase4Invoice.payload, invoiceDetails: { ...phase4Invoice.payload.invoiceDetails, supplierInvoiceNumber: phase4InvoiceNumber } } }, createToken: `phase4-dup-bill:${Date.now()}` }) });
  const duplicateReceiptBilling = await call('/api/procurement/supplier-invoices', { method: 'POST', body: JSON.stringify({ data: { ...phase4Invoice, reference: `SINV-P4-RECEIPT-${Date.now()}`, payload: { ...phase4Invoice.payload, invoiceDetails: { ...phase4Invoice.payload.invoiceDetails, supplierInvoiceNumber: `SINV-P4-RECEIPT-BILL-${Date.now()}` } } }, createToken: `phase4-dup-receipt:${Date.now()}` }) });
  check(savePhase4Invoice.status === 201 && Number(progressAfterPhase4Invoice.progress?.invoiced) === 2 && duplicateBillNumber.status === 409 && /already recorded/i.test(duplicateBillNumber.body.error || '') && duplicateReceiptBilling.status === 409 && /already (billed by|has Supplier Invoice)/i.test(duplicateReceiptBilling.body.error || ''), 'reconciles invoiced quantity and rejects duplicate Supplier Bill numbers and duplicate receipt billing');
  const excelPOId = `PO-EXCEL-${Date.now()}`;
  const excelPO = { date: '2026-11-25', reference: excelPOId, vendor: 'Excel Vendor', status: 'Draft', payload: { poDetails: { poNumber: excelPOId, poDate: '2026-11-25', poStatus: 'Draft' }, vendorDetails: { companyName: 'Excel Vendor' }, items: [{ itemCode: 'EXL-01', itemName: 'Excel Material', quantity: 3, unit: 'Nos', unitPrice: 10, amount: 30 }], totals: { grandTotal: 30 } } };
  phase4POIds.push(excelPOId);
  const excelImport = await call('/api/procurement/purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [excelPO] }) });
  const excelRow = await pool.query('SELECT quotation_number,payload FROM purchase_orders WHERE po_number=$1', [excelPOId]);
  const excelRepeat = await call('/api/procurement/purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [excelPO] }) });
  const excelConflict = await call('/api/procurement/purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [{ ...excelPO, payload: { ...excelPO.payload, items: [{ ...excelPO.payload.items[0], quantity: 5 }] } }] }) });
  const excelAfterConflict = await pool.query('SELECT payload->\'progress\'->>\'ordered\' AS ordered FROM purchase_orders WHERE po_number=$1', [excelPOId]);
  check(excelImport.status === 200 && excelImport.body.imported.length === 1 && excelRow.rowCount === 1 && excelRow.rows[0].quotation_number === null && Number(excelRow.rows[0].payload?.progress?.ordered) === 3 && excelRepeat.body.skipped.some((row) => row.id === excelPOId) && excelConflict.body.conflicts.some((row) => row.id === excelPOId) && Number(excelAfterConflict.rows[0]?.ordered) === 3, 'spreadsheet Purchase Order import writes PostgreSQL rows, is idempotent and preserves existing content');

  /* Purchase Manager short-close is now a transactional PostgreSQL operation:
   * the browser cache cannot close a PG-owned order or change ordered quantity. */
  const shortClosePOId = `PO-SC-${Date.now()}`;
  const shortClosePO = { date: '2026-11-25', reference: shortClosePOId, vendor: 'Short Close Vendor', status: 'Submitted',
    dueDate: '2025-12-01', payload: { poDetails: { poNumber: shortClosePOId, poDate: '2026-11-25', deliveryDueDate: '2025-12-01', poStatus: 'Submitted' },
      vendorDetails: { companyName: 'Short Close Vendor' }, items: [{ itemCode: 'SC-01', itemName: 'Short Close Material', quantity: 3, unit: 'Nos', unitPrice: 10 }], totals: { grandTotal: 30 } } };
  phase4POIds.push(shortClosePOId);
  const importShortClosePO = await call('/api/procurement/purchase-orders/import', { method: 'POST', body: JSON.stringify({ records: [shortClosePO] }) });
  const beforeShortClose = (await pool.query('SELECT version,payload->\'progress\' AS progress FROM purchase_orders WHERE po_number=$1', [shortClosePOId])).rows[0];
  const shortClose = await call(`/api/procurement/purchase-orders/${shortClosePOId}/short-close`, { method: 'POST', body: JSON.stringify({ version: Number(beforeShortClose.version), reason: 'Vendor unable to supply', remarks: 'Isolated short-close verification' }) });
  const afterShortClose = (await pool.query('SELECT version,status,payload->\'shortClose\' AS closure,payload->\'progress\' AS progress,payload->\'payload\'->\'poDetails\'->>\'poStatus\' AS detail_status FROM purchase_orders WHERE po_number=$1', [shortClosePOId])).rows[0];
  const shortCloseAudit = await pool.query("SELECT count(*)::int AS n FROM purchase_order_audit WHERE po_number=$1 AND action='SHORT_CLOSED'", [shortClosePOId]);
  const repeatShortClose = await call(`/api/procurement/purchase-orders/${shortClosePOId}/short-close`, { method: 'POST', body: JSON.stringify({ version: Number(afterShortClose.version), reason: 'Vendor unable to supply', remarks: 'Duplicate short close' }) });
  check(importShortClosePO.status === 200 && Number(beforeShortClose.progress?.pending) === 3 && shortClose.status === 200 && afterShortClose.status === 'Closed' && afterShortClose.detail_status === 'Closed' && Number(afterShortClose.progress?.ordered) === 3 && Number(afterShortClose.progress?.pending) === 3 && Number(afterShortClose.closure?.shortClosedQty) === 3 && afterShortClose.closure?.lines?.length === 1 && shortCloseAudit.rows[0].n === 1 && repeatShortClose.status === 409, 'short-closes unreceived balance transactionally, preserves ordered/receipt quantities, audits the approval and rejects an already closed order');
  console.log(`\n${checks} checks passed; 0 failed. Database verified before writes: vyavastha_test.`);
} finally {
  if (server) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)); }
  if (primaryReceiptNumber && stockQCNumber && stockFixtureMaterialCode) {
    /* Remove only the uniquely prefixed rows created by this isolated run. */
    await pool.query('DELETE FROM receipt_stock_movement_audit WHERE movement_id IN (SELECT id FROM receipt_stock_movements WHERE qc_number=$1)', [stockQCNumber]);
    await pool.query('DELETE FROM receipt_stock_movements WHERE qc_number=$1', [stockQCNumber]);
    await pool.query('DELETE FROM stock_ledger_entries WHERE id LIKE $1', [`receipt-stock-${stockQCNumber}-%`]);
    await pool.query("DELETE FROM erp_audit_log WHERE module='inventoryItems' AND record_id=$1", [stockFixtureMaterialCode]);
    await pool.query("DELETE FROM module_records WHERE storage_key='stockTransactions' AND record_id LIKE $1", [`receipt-stock-${stockQCNumber}-%`]);
    await pool.query("DELETE FROM module_records WHERE storage_key='inventoryItems' AND data->>'itemCode'=$1", [stockFixtureMaterialCode]);
    await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [stockFixtureMaterialCode]);
    if (primarySupplierInvoiceId) {
      await pool.query('DELETE FROM supplier_invoice_audit WHERE invoice_number=$1', [primarySupplierInvoiceId]);
      await pool.query('DELETE FROM supplier_invoices WHERE invoice_number=$1', [primarySupplierInvoiceId]);
    }
    await pool.query('DELETE FROM material_receipt_inspection_audit WHERE qc_number=$1', [stockQCNumber]);
    await pool.query('DELETE FROM material_receipt_inspection_items WHERE qc_number=$1', [stockQCNumber]);
    await pool.query('DELETE FROM material_receipt_inspections WHERE qc_number=$1', [stockQCNumber]);
    await pool.query('DELETE FROM material_receipt_audit WHERE receipt_number=$1', [primaryReceiptNumber]);
    await pool.query('DELETE FROM material_receipt_items WHERE receipt_number=$1', [primaryReceiptNumber]);
    await pool.query('DELETE FROM material_receipts WHERE receipt_number=$1', [primaryReceiptNumber]);
  }
  if (receiptMigrationFixtureId) {
    const legacyReceipts = await pool.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts'");
    if (Array.isArray(legacyReceipts.rows[0]?.data)) {
      const kept = legacyReceipts.rows[0].data.filter((row) => ![receiptMigrationFixtureId, receiptInvalidFixtureId].includes(String(row?.receiptNumber || '')));
      if (!kept.length && !receiptLegacyStateKeys.materialReceipts) await pool.query("DELETE FROM erp_state WHERE storage_key='materialReceipts' AND data='[]'::jsonb");
      else await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='materialReceipts'", [JSON.stringify(kept)]);
    }
    const legacyPOs = await pool.query("SELECT data FROM erp_state WHERE storage_key='supplierPOHistory'");
    if (Array.isArray(legacyPOs.rows[0]?.data)) {
      const kept = legacyPOs.rows[0].data.filter((row) => String(row?.reference || row?.payload?.poDetails?.poNumber || '') !== receiptMigrationPOId);
      if (!kept.length && !receiptLegacyStateKeys.supplierPOHistory) await pool.query("DELETE FROM erp_state WHERE storage_key='supplierPOHistory' AND data='[]'::jsonb");
      else await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='supplierPOHistory'", [JSON.stringify(kept)]);
    }
    await pool.query('DELETE FROM material_receipt_audit WHERE receipt_number=$1', [receiptMigrationFixtureId]);
    await pool.query('DELETE FROM material_receipt_items WHERE receipt_number=$1', [receiptMigrationFixtureId]);
    await pool.query('DELETE FROM material_receipts WHERE receipt_number=$1', [receiptMigrationFixtureId]);
  }
  if (migrationFixtureId) {
    const currentLegacy = await pool.query("SELECT data FROM erp_state WHERE storage_key='supplierInvoiceHistory'");
    if (Array.isArray(currentLegacy.rows[0]?.data)) {
      const kept = currentLegacy.rows[0].data.filter((row) => String(row?.reference || '') !== migrationFixtureId);
      if (kept.length || migrationFixtureKeyExisted) await pool.query("UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key='supplierInvoiceHistory'", [JSON.stringify(kept)]);
      else await pool.query("DELETE FROM erp_state WHERE storage_key='supplierInvoiceHistory' AND data=$1::jsonb", [JSON.stringify(currentLegacy.rows[0].data)]);
    }
    await pool.query('DELETE FROM supplier_invoice_audit WHERE invoice_number=$1', [migrationFixtureId]);
    await pool.query('DELETE FROM supplier_invoices WHERE invoice_number=$1', [migrationFixtureId]);
  }
  if (phase4InvoiceIds.length) {
    await pool.query('DELETE FROM supplier_invoice_audit WHERE invoice_number = ANY($1::text[])', [phase4InvoiceIds]);
    await pool.query('DELETE FROM supplier_invoices WHERE invoice_number = ANY($1::text[])', [phase4InvoiceIds]);
  }
  if (phase4ReceiptIds.length) {
    await pool.query('DELETE FROM material_receipt_audit WHERE receipt_number = ANY($1::text[])', [phase4ReceiptIds]);
    await pool.query('DELETE FROM material_receipt_items WHERE receipt_number = ANY($1::text[])', [phase4ReceiptIds]);
    await pool.query('DELETE FROM material_receipts WHERE receipt_number = ANY($1::text[])', [phase4ReceiptIds]);
  }
  if (phase4POIds.length) {
    await pool.query('DELETE FROM purchase_order_audit WHERE po_number = ANY($1::text[])', [phase4POIds]);
    await pool.query('DELETE FROM purchase_orders WHERE po_number = ANY($1::text[])', [phase4POIds]);
  }
  await pool.end();
}
