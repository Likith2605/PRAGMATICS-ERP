/** Guarded PostgreSQL integration test for authoritative Purchase Requests. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing Purchase Request tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_PURCHASE_REQUEST_TEST_PORT || 3396);
const base = `http://127.0.0.1:${port}`;
let child;
let serverErrors = '';
let token = '';
let employeeToken = '';
let employeeDepartment = '';
let employeeFixtureCreated = false;
let employeeCreateToken = '';
let originalLegacy = null;
let legacyFixtureWritten = false;
let fixtureMrNumber = '';
const createdPrNumbers = new Set();
let assertions = 0;
const assert = (ok, label) => { if (!ok) throw new Error(label); assertions += 1; console.log(`PASS ${label}`); };
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
const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { serverErrors = `${serverErrors}${chunk}`.slice(-4000); });
  for (let n = 0; n < 100; n += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((m) => m.version === '048_employee_master')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Purchase Request server did not become ready with migration 044.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const login = async (email, password, portal) => (await api('/api/auth/login', json('POST', { email, password, portal }), '')).body;
const employeeEmail = `pr-test-${randomUUID().slice(0, 8)}@example.test`;
const employeePassword = `Pr-${randomUUID().slice(0, 8)}-Pass!`;
const employeeId = `pr-test-${randomUUID().slice(0, 8)}`;
const legacyPrNumber = `PR-LEGACY-${randomUUID().slice(0, 8)}`;
const idempotencyToken = `purchase-request-test:${randomUUID()}`;
const enquiryNumber = `VE-PR-${randomUUID().slice(0, 8)}`;
const quotationNumber = `VQ-PR-${randomUUID().slice(0, 8)}`;
const purchaseOrderNumber = `PO-PR-${randomUUID().slice(0, 8)}`;
const sourcePayload = {
  prNumber: legacyPrNumber,
  prDate: new Date().toISOString().slice(0, 10),
  mrNumber: '',
  projectId: 'PR-TEST',
  projectName: 'Test Project',
  requestedBy: 'Migration Fixture',
  status: 'Approved',
  items: [{ materialId: 'PR-TEST-MAT', materialName: 'Migration Fixture Material', unit: 'Nos', requiredQty: 3, shortageQty: 3 }]
};
const restoreLegacyKey = async () => {
  if (!legacyFixtureWritten) return;
  if (originalLegacy) {
    await pool.query('UPDATE erp_state SET data=$2::jsonb,updated_at=$3 WHERE storage_key=$1', [
      'storePurchaseRequests', JSON.stringify(originalLegacy.data), originalLegacy.updated_at
    ]);
  } else {
    await pool.query("DELETE FROM erp_state WHERE storage_key='storePurchaseRequests'");
  }
};

try {
  await start();
  const admin = await login(process.env.ERP_ADMIN_EMAIL, process.env.ERP_ADMIN_PASSWORD, 'admin');
  token = admin.token;
  assert(Boolean(token), 'Admin session authenticates');

  const unauthenticated = await api('/api/purchase-requests', {}, '');
  assert(unauthenticated.status === 401, 'Purchase Request list requires authentication');
  const legacySync = await api('/api/state/storePurchaseRequests', json('PUT', { data: [] }));
  assert(legacySync.status === 400, 'Generic erp_state synchronization rejects the migrated Purchase Request key');
  const employeePreview = await api('/api/purchase-requests/migration-preview', {}, '');
  assert(employeePreview.status === 401, 'Migration preview requires authentication');

  const employeeFixture = {
    id: employeeId, employeeId, name: 'Purchase Request Test Employee', email: employeeEmail,
    password: employeePassword, role: 'Sales Employee', roleKey: 'sales_employee',
    department: 'Sales Department', active: true,
    departmentAssignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  };
  employeeCreateToken = `purchase-request-employee:${randomUUID()}`;
  const createdEmployee = await api('/api/employees', json('POST', { data: employeeFixture, createToken: employeeCreateToken }));
  assert(createdEmployee.status === 201, `Dedicated Employee API creates authorization fixture (${createdEmployee.body.error || ''})`);
  employeeFixtureCreated = true;
  const employee = await login(employeeEmail, employeePassword, 'employee');
  employeeToken = employee.token;
  employeeDepartment = employee.user?.activeDepartment || employee.user?.department || '';
  assert(Boolean(employeeToken), 'Non-Admin test account authenticates');

  fixtureMrNumber = `MR-PR-TEST-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO material_requests(mr_number,mr_date,department,requested_by,status,remarks,created_by,updated_by,version,payload)
     VALUES($1,CURRENT_DATE,'Store Department','Test Requester','Approved','test fixture','test','test',1,'{}'::jsonb)`,
    [fixtureMrNumber]
  );
  const request = {
    prDate: new Date().toISOString().slice(0, 10),
    mrNumber: fixtureMrNumber,
    projectId: 'PR-API-TEST',
    requestedBy: 'Test Requester',
    items: [{ materialId: 'PR-API-MAT', materialName: 'API Fixture Material', unit: 'Nos', requiredQty: 8, shortageQty: 3 }]
  };
  const created = await api('/api/purchase-requests', json('POST', { data: request, createToken: idempotencyToken }));
  assert(created.status === 201 && created.body.record.status === 'Pending Approval', 'Purchase Request is created in PostgreSQL pending approval');
  const createdPr = created.body.record;
  createdPrNumbers.add(createdPr.prNumber);
  assert(createdPr.prNumber.startsWith('PR-') && createdPr.recordVersion === 1, 'Database sequence and initial optimistic version are returned');
  const lines = await pool.query('SELECT material_id,required_qty,shortage_qty FROM purchase_request_items WHERE pr_number=$1', [createdPr.prNumber]);
  assert(lines.rowCount === 1 && Number(lines.rows[0].required_qty) === 8 && Number(lines.rows[0].shortage_qty) === 3, 'Purchase Request item quantities are stored in normalized PostgreSQL rows');

  const retry = await api('/api/purchase-requests', json('POST', { data: request, createToken: idempotencyToken }));
  assert(retry.status === 200 && retry.body.duplicate === true && retry.body.record.prNumber === createdPr.prNumber, 'Create retry is idempotent');
  const tokenConflict = await api('/api/purchase-requests', json('POST', {
    data: { ...request, remarks: 'different intent' }, createToken: idempotencyToken
  }));
  assert(tokenConflict.status === 409, 'Idempotency token cannot be reused for different data');

  const deniedApproval = await api(`/api/purchase-requests/${encodeURIComponent(createdPr.prNumber)}/approve`,
    json('POST', { version: 1 }), employeeToken, employeeDepartment);
  assert(deniedApproval.status === 403, 'Non-Admin without Purchase approval permission cannot approve');
  const approved = await api(`/api/purchase-requests/${encodeURIComponent(createdPr.prNumber)}/approve`,
    json('POST', { version: 1, reason: 'Reviewed fixture' }));
  assert(approved.status === 200 && approved.body.record.status === 'Approved' && approved.body.record.version === 2, 'Authorized approval advances the optimistic version');
  const staleDecision = await api(`/api/purchase-requests/${encodeURIComponent(createdPr.prNumber)}/reject`,
    json('POST', { version: 1, reason: 'stale version' }));
  assert(staleDecision.status === 409, 'Stale Purchase Request transition is rejected');
  const audit = await pool.query('SELECT action FROM purchase_request_audit WHERE pr_number=$1 ORDER BY id', [createdPr.prNumber]);
  assert(audit.rows.map((row) => row.action).join(',') === 'CREATE,APPROVE', 'Create and approval history is durably audited');

  const enquiryData = {
    enquiryNumber, prNumber: createdPr.prNumber, sourceType: 'Purchase Request',
    projectId: request.projectId, status: 'Draft',
    vendors: [{ vendorId: 'PR-TEST-VENDOR', name: 'Purchase Request Test Vendor', status: 'Invited' }],
    items: [{ materialId: 'PR-API-MAT', materialName: 'API Fixture Material', requiredQty: 3, shortageQty: 3, unit: 'Nos' }],
    quotationNumbers: []
  };
  const enquiry = await api('/api/procurement/vendorEnquiry', json('POST', {
    data: enquiryData, createToken: `pr-enquiry:${randomUUID()}`
  }));
  assert(enquiry.status === 201 && enquiry.body.record.prNumber === createdPr.prNumber, `Vendor Enquiry preserves the approved Purchase Request link (${enquiry.status}: ${enquiry.body.error || ''}; ${serverErrors})`);
  const vendorEnquiry = await pool.query('SELECT pr_number FROM vendor_enquiries WHERE enquiry_number=$1', [enquiryNumber]);
  assert(vendorEnquiry.rows[0]?.pr_number === createdPr.prNumber, 'Vendor Enquiry source reference is normalized in PostgreSQL');

  const quotationData = {
    quotationNumber, enquiryNumber, vendorId: 'PR-TEST-VENDOR', vendorName: 'Purchase Request Test Vendor',
    status: 'Received',
    items: [{ materialCode: 'PR-API-MAT', materialName: 'API Fixture Material', quotedQty: 3, unitPrice: 10, taxPct: 0, taxAmount: 0, totalPrice: 30 }],
    totalAmount: 30, taxAmount: 0, totalWithTax: 30
  };
  const quotation = await api('/api/procurement/vendorQuotation', json('POST', {
    data: quotationData, createToken: `pr-quotation:${randomUUID()}`
  }));
  assert(quotation.status === 201, 'Vendor Quotation can be raised from the PostgreSQL-backed Purchase Request enquiry');
  const accepted = await api(`/api/procurement/vendorQuotation/${encodeURIComponent(quotationNumber)}`,
    { method: 'PUT', body: JSON.stringify({ version: 1, data: { status: 'Accepted', acceptedBy: 'Admin' } }) });
  assert(accepted.status === 200 && accepted.body.record.status === 'Accepted', 'Purchase Request Vendor Quotation is accepted in PostgreSQL');
  const orderData = {
    date: new Date().toISOString().slice(0, 10), reference: purchaseOrderNumber,
    vendor: 'Purchase Request Test Vendor', projectRef: request.projectId,
    prRef: createdPr.prNumber, enquiryRef: enquiryNumber, quotationRef: quotationNumber,
    quotationNumber, dueDate: '', total: '₹ 30.00', status: 'Submitted',
    payload: {
      poDetails: {
        poNumber: purchaseOrderNumber, poDate: new Date().toISOString().slice(0, 10),
        projectRef: request.projectId, salesOrderRef: '', prRef: createdPr.prNumber,
        indentRef: '', enquiryRef: enquiryNumber, quotationRef: quotationNumber, poStatus: 'Submitted'
      },
      vendorDetails: { vendorName: 'Purchase Request Test Vendor', companyName: 'Purchase Request Test Vendor' },
      items: [{ itemCode: 'PR-API-MAT', itemName: 'API Fixture Material', quantity: 3, unitPrice: 10, gst: 0 }],
      totals: { grandTotal: 30 }
    }
  };
  const converted = await api('/api/procurement/purchase-orders/from-quotation', json('POST', {
    data: orderData, createToken: `pr-order:${randomUUID()}`
  }));
  assert(converted.status === 201 && converted.body.purchaseRequest?.status === 'Converted to PO', 'Purchase Order conversion advances the linked Purchase Request');
  const linkedOrder = await pool.query('SELECT pr_number FROM purchase_orders WHERE po_number=$1', [purchaseOrderNumber]);
  assert(linkedOrder.rows[0]?.pr_number === createdPr.prNumber, 'Purchase Order stores the Purchase Request relationship in PostgreSQL');
  const blockedDelete = await api(`/api/purchase-requests/${encodeURIComponent(createdPr.prNumber)}`,
    json('DELETE', { version: 3, reason: 'Must retain procurement history' }));
  assert(blockedDelete.status === 409, 'Converted Purchase Request cannot be deleted while procurement documents reference it');

  const rejectedData = { ...request, mrNumber: '', projectId: 'PR-REJECT-TEST', prNumber: `PR-REJECT-${randomUUID().slice(0, 8)}` };
  const rejectedCreate = await api('/api/purchase-requests', json('POST', { data: rejectedData, createToken: `purchase-request-test:${randomUUID()}` }));
  assert(rejectedCreate.status === 201, 'Second Purchase Request fixture is created');
  const rejectedPr = rejectedCreate.body.record;
  createdPrNumbers.add(rejectedPr.prNumber);
  const missingReason = await api(`/api/purchase-requests/${encodeURIComponent(rejectedPr.prNumber)}/reject`, json('POST', { version: 1 }));
  assert(missingReason.status === 400, 'Rejection requires a reason');
  const rejected = await api(`/api/purchase-requests/${encodeURIComponent(rejectedPr.prNumber)}/reject`, json('POST', { version: 1, reason: 'Test rejection' }));
  assert(rejected.status === 200 && rejected.body.record.status === 'Rejected', 'Authorized rejection persists its reason');
  const deleted = await api(`/api/purchase-requests/${encodeURIComponent(rejectedPr.prNumber)}`, json('DELETE', { version: 2, reason: 'Recycle Bin test' }));
  assert(deleted.status === 200 && deleted.body.record.deletedAt, 'Admin soft delete retains the Purchase Request tombstone');
  const bin = await api(`/api/recycle-bin?module=purchase&search=${encodeURIComponent(rejectedPr.prNumber)}`);
  assert((bin.body.entries || []).some((entry) => entry.entity === 'purchase_requests' && entry.recordId === rejectedPr.prNumber), 'Purchase Request tombstone appears in the central Recycle Bin');
  const restored = await api(`/api/recycle-bin/purchase_requests/${encodeURIComponent(rejectedPr.prNumber)}/restore`, json('POST', { reason: 'Test restore' }));
  assert(restored.status === 200 && !restored.body.record.deleted_at, 'Admin can restore a Purchase Request through the central Recycle Bin');
  const deletedAgain = await api(`/api/purchase-requests/${encodeURIComponent(rejectedPr.prNumber)}`,
    json('DELETE', { version: restored.body.record.version, reason: 'Prepare permanent-delete test' }));
  assert(deletedAgain.status === 200, 'Restored Purchase Request can be soft-deleted again with its latest version');
  const recycleDetail = await api(`/api/recycle-bin/purchase_requests/${encodeURIComponent(rejectedPr.prNumber)}`);
  assert((recycleDetail.body.audit || []).some((event) => event.action === 'RECYCLE_BIN_RESTORE'), 'Recycle Bin detail combines module and restore audit history');
  const purged = await api(`/api/recycle-bin/purchase_requests/${encodeURIComponent(rejectedPr.prNumber)}`,
    json('DELETE', { reason: 'Explicit test purge', confirm: rejectedPr.prNumber }));
  assert(purged.status === 200 && purged.body.purged, 'Admin can permanently purge a confirmed Purchase Request tombstone');
  const purgeAudit = await pool.query(
    "SELECT 1 FROM erp_audit_log WHERE module='purchase_requests' AND record_id=$1 AND action='RECYCLE_BIN_PURGE'",
    [rejectedPr.prNumber]
  );
  assert(purgeAudit.rowCount === 1, 'Permanent Purchase Request deletion is durably audited');

  const legacyRow = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='storePurchaseRequests'");
  originalLegacy = legacyRow.rowCount ? legacyRow.rows[0] : null;
  const oldLegacyData = Array.isArray(originalLegacy?.data) ? originalLegacy.data : [];
  await pool.query(
    `INSERT INTO erp_state(storage_key,data,updated_at) VALUES('storePurchaseRequests',$1::jsonb,now())
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([...oldLegacyData, sourcePayload])]
  );
  legacyFixtureWritten = true;
  const preview = await api('/api/purchase-requests/migration-preview');
  assert(preview.status === 200 && preview.body.eligible.some((record) => record.prNumber === legacyPrNumber), 'Admin preview identifies eligible preserved legacy records');
  const imported = await api('/api/purchase-requests/migration-preview/import-selected', json('POST', { records: [legacyPrNumber] }));
  assert(imported.status === 200 && imported.body.imported.some((record) => record.prNumber === legacyPrNumber), 'Admin selected import creates the PostgreSQL record');
  createdPrNumbers.add(legacyPrNumber);
  const previewAgain = await api('/api/purchase-requests/migration-preview');
  assert(previewAgain.body.existing.some((record) => record.id === legacyPrNumber), 'Reconciliation recognizes the imported record without overwriting legacy data');

  console.log(`PURCHASE REQUEST API CHECKS PASSED (${assertions} assertions)`);
} finally {
  await restoreLegacyKey().catch(() => {});
  if (employeeFixtureCreated) {
    await pool.query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [employeeEmail]).catch(() => {});
    await pool.query('DELETE FROM employees WHERE id=$1', [employeeId]).catch(() => {});
  }
  if (employeeCreateToken) await pool.query('DELETE FROM master_idempotency WHERE token=$1', [employeeCreateToken]).catch(() => {});
  if (createdPrNumbers.size) {
    await pool.query('DELETE FROM purchase_order_audit WHERE po_number=$1', [purchaseOrderNumber]).catch(() => {});
    await pool.query('DELETE FROM purchase_orders WHERE po_number=$1', [purchaseOrderNumber]).catch(() => {});
    await pool.query("DELETE FROM procurement_record_audit WHERE (entity_type='vendorEnquiry' AND record_id=$1) OR (entity_type='vendorQuotation' AND record_id=$2)", [enquiryNumber, quotationNumber]).catch(() => {});
    await pool.query('DELETE FROM vendor_quotations WHERE quotation_number=$1', [quotationNumber]).catch(() => {});
    await pool.query('DELETE FROM vendor_enquiries WHERE enquiry_number=$1', [enquiryNumber]).catch(() => {});
    await pool.query('DELETE FROM purchase_request_audit WHERE pr_number=ANY($1::text[])', [[...createdPrNumbers]]).catch(() => {});
    await pool.query('DELETE FROM purchase_request_items WHERE pr_number=ANY($1::text[])', [[...createdPrNumbers]]).catch(() => {});
    await pool.query('DELETE FROM purchase_requests WHERE pr_number=ANY($1::text[])', [[...createdPrNumbers]]).catch(() => {});
  }
  if (fixtureMrNumber) {
    await pool.query('DELETE FROM material_request_items WHERE mr_number=$1', [fixtureMrNumber]).catch(() => {});
    await pool.query('DELETE FROM material_requests WHERE mr_number=$1', [fixtureMrNumber]).catch(() => {});
  }
  await stop();
  await pool.end();
}
