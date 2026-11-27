/** Isolated PostgreSQL API integration test for Production, BOM snapshots and HT Outsource. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing Production tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_PRODUCTION_TEST_PORT || 3391);
const base = `http://127.0.0.1:${port}`;
let child;
let token = '';
let assertions = 0;
const assert = (ok, label, detail = '') => {
  if (!ok) throw new Error(detail ? `${label}: ${detail}` : label);
  assertions += 1;
  console.log(`PASS ${label}`);
};
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
  for (let n = 0; n < 100; n += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((m) => m.version === '040_production_gaps')) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Production server did not become ready.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const login = async () => (await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.ERP_ADMIN_EMAIL,
    password: process.env.ERP_ADMIN_PASSWORD,
    portal: 'admin'
  })
}, '')).body.token;

let requirementNumber = '';
let linkedRequirementNumber = '';
let linkedIndentNumber = '';
let jobCardNumber = '';
let htCardNumber = '';
let htrNumber = '';
let bomNumber = '';
let revisedBomNumber = '';
let inventoryId = '';
let itemCode = '';
let itemName = '';
let sequenceBefore = new Map();
const today = new Date().toISOString().slice(0, 10);

const captureSequences = async () => {
  const result = await pool.query(
    "SELECT sequence_key,last_number FROM production_sequences WHERE sequence_key IN ('productionRequirement','htOutsource')"
  );
  sequenceBefore = new Map(result.rows.map((row) => [row.sequence_key, Number(row.last_number)]));
};
const restoreSequences = async () => {
  for (const key of ['productionRequirement', 'htOutsource']) {
    if (!sequenceBefore.has(key)) await pool.query('DELETE FROM production_sequences WHERE sequence_key=$1', [key]);
    else await pool.query('UPDATE production_sequences SET last_number=$1,updated_at=now() WHERE sequence_key=$2',
      [sequenceBefore.get(key), key]);
  }
};
const getCard = async (number) => (await api(`/api/production/job-cards/${number}`)).body.record;
const getHtr = async (number) => (await api(`/api/production/ht-outsource/${number}`)).body.record;

try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');

  await captureSequences();
  inventoryId = `HTINV-${randomUUID()}`;
  itemCode = `HTTEST-${randomUUID().slice(0, 8)}`;
  itemName = `Isolated HT component ${itemCode}`;
  await pool.query(
    "INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES('inventoryItems',$1,$2::jsonb,1,now(),'integration-test')",
    [inventoryId, JSON.stringify({ id: inventoryId, itemCode, itemName, currentQty: 20, reservedQty: 0 })]
  );
  await pool.query(
    "INSERT INTO inventory_items(item_code,material_name,category,unit,current_qty,unit_price,payload) VALUES($1,$2,'Raw Material','Nos',20,10,$3::jsonb)",
    [itemCode, itemName, JSON.stringify({ integrationFixture: true })]
  );

  /* ---------------- Production requirements ---------------- */
  const requirementData = {
    requirementDate: today,
    projectId: 'PROD-TEST-PROJ',
    soNumber: 'SO-PROD-TEST',
    customer: 'Isolated Test Customer',
    partName: itemCode,
    drawingNo: itemCode,
    qty: 20,
    items: [{ itemCode, itemName, quantity: 5, unit: 'Nos' }]
  };
  const requirementToken = randomUUID();
  const requirementCreate = await api('/api/production/requirements', {
    method: 'POST', body: JSON.stringify({ data: requirementData, createToken: requirementToken })
  });
  assert(requirementCreate.status === 201 && Number(requirementCreate.body.record.version) === 1,
    'Create returns PostgreSQL-confirmed requirement version 1', JSON.stringify(requirementCreate));
  requirementNumber = requirementCreate.body.record.requirementNumber;
  assert(/^PR-\d{6}$/.test(requirementNumber), 'Requirement number preserves PR-NNNNNN format', requirementNumber);
  const requirementRetry = await api('/api/production/requirements', {
    method: 'POST', body: JSON.stringify({ data: requirementData, createToken: requirementToken })
  });
  assert(requirementRetry.status === 200 && requirementRetry.body.duplicate,
    'Create retry is idempotent and returns the same record');
  const requirementRows = await pool.query('SELECT 1 FROM production_requirements WHERE requirement_number=$1', [requirementNumber]);
  assert(requirementRows.rowCount === 1, 'Idempotency retry does not create a second row');

  const submitted = await api(`/api/production/requirements/${requirementNumber}/submit`, {
    method: 'POST', body: JSON.stringify({ version: 1 })
  });
  assert(submitted.status === 200 && submitted.body.record.status === 'Pending Review',
    'Submit transitions the requirement to Pending Review');
  const cancelled = await api(`/api/production/requirements/${requirementNumber}/cancel`, {
    method: 'POST', body: JSON.stringify({ version: 2, reason: 'isolated production test' })
  });
  assert(cancelled.status === 200 && cancelled.body.record.status === 'Cancelled',
    'Admin cancel records the reason and transitions to Cancelled');
  const deletedRequirement = await api(`/api/production/requirements/${requirementNumber}`, {
    method: 'DELETE', body: JSON.stringify({ version: 3, reason: 'isolated production test cleanup' })
  });
  assert(deletedRequirement.status === 200, 'Admin soft-deletes the cancelled requirement', JSON.stringify(deletedRequirement));
  const requirementList = await api('/api/production/requirements');
  assert(!requirementList.body.records.some((r) => r.requirementNumber === requirementNumber),
    'Deleted requirement is absent from the authoritative list');
  const restoredRequirement = await api(`/api/production/requirements/${requirementNumber}/restore`, {
    method: 'POST', body: JSON.stringify({ reason: 'isolated production restore verification' })
  });
  assert(restoredRequirement.status === 200 &&
    restoredRequirement.body.record.status === 'Cancelled',
  'Admin restore restores the requirement without recreating a deleted relationship', JSON.stringify(restoredRequirement));

  const linkedRequirementCreate = await api('/api/production/requirements', {
    method: 'POST',
    body: JSON.stringify({
      data: { ...requirementData, projectId: 'PROD-INDENT-TEST', items: [{ itemCode, itemName, quantity: 5, unit: 'Nos' }] },
      createToken: randomUUID()
    })
  });
  assert(linkedRequirementCreate.status === 201, 'Create isolated requirement for transactional Purchase Indent link');
  linkedRequirementNumber = linkedRequirementCreate.body.record.requirementNumber;
  const linkedLineId = linkedRequirementCreate.body.record.items[0].lineId;
  const linkedSubmitted = await api(`/api/production/requirements/${linkedRequirementNumber}/submit`, {
    method: 'POST', body: JSON.stringify({ version: 1 })
  });
  const linkedReviewed = await api(`/api/production/requirements/${linkedRequirementNumber}/review`, {
    method: 'POST',
    body: JSON.stringify({
      version: linkedSubmitted.body.record.version,
      status: 'Shortage Identified',
      storeReview: { lines: { [linkedLineId]: { availableQty: 0, shortageQty: 5, status: 'Shortage' } } }
    })
  });
  assert(linkedReviewed.status === 200, 'Store shortage review is persisted before Purchase Indent creation');
  linkedIndentNumber = `IND-REQ-${randomUUID().slice(0, 8)}`;
  const linkedIndentPayload = {
    indentNumber: linkedIndentNumber,
    indentDate: today,
    projectId: 'PROD-INDENT-TEST',
    status: 'Draft',
    sourceType: 'productionRequirement',
    requirementNumber: linkedRequirementNumber,
    items: [{ lineId: linkedLineId, materialCode: itemCode, materialName: itemName, unit: 'Nos', purchaseQty: 5 }]
  };
  const linkedIndent = await api('/api/procurement/purchaseIndent', {
    method: 'POST', body: JSON.stringify({ data: linkedIndentPayload, createToken: randomUUID() })
  });
  assert(linkedIndent.status === 201, 'Create shortage Purchase Indent with source line identity', JSON.stringify(linkedIndent));
  const linkedRequirementRead = await api(`/api/production/requirements/${linkedRequirementNumber}`);
  assert(linkedRequirementRead.body.record.status === 'Purchase Required'
    && linkedRequirementRead.body.record.indentNumbers.includes(linkedIndentNumber)
    && Number(linkedRequirementRead.body.record.version) === Number(linkedReviewed.body.record.version) + 1,
  'Purchase Indent and requirement status/link are persisted together');
  const indentAudit = await pool.query(
    `SELECT 1 FROM erp_audit_log
     WHERE module='production_requirements' AND record_id=$1 AND action='PURCHASE_INDENT_CREATED'`,
    [linkedRequirementNumber]
  );
  assert(indentAudit.rowCount === 1, 'Requirement/Indent relationship records a PostgreSQL audit event');
  const overIndent = await api('/api/procurement/purchaseIndent', {
    method: 'POST',
    body: JSON.stringify({
      data: { ...linkedIndentPayload, indentNumber: `${linkedIndentNumber}-DUP`, items: [{ ...linkedIndentPayload.items[0], purchaseQty: 1 }] },
      createToken: randomUUID()
    })
  });
  const rejectedIndentRow = await pool.query('SELECT 1 FROM purchase_indents WHERE indent_number=$1', [`${linkedIndentNumber}-DUP`]);
  const unchangedRequirement = await api(`/api/production/requirements/${linkedRequirementNumber}`);
  assert(overIndent.status === 409 && rejectedIndentRow.rowCount === 0
    && Number(unchangedRequirement.body.record.version) === Number(linkedRequirementRead.body.record.version),
  'Over-indenting is rejected without partial indent or requirement writes');

  /* ---------------- BOM snapshot on Job Card issue ---------------- */
  const bomCreate = await api('/api/bom', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        version: 1,
        partCode: itemCode,
        partName: itemName,
        drawingNumber: itemCode,
        projectId: 'PROD-TEST-PROJ',
        customerName: 'Isolated Test Customer',
        effectiveDate: today,
        items: [{ materialId: itemCode, materialName: itemName, requiredQty: 2, unit: 'Nos' }]
      },
      createToken: randomUUID()
    })
  });
  assert(bomCreate.status === 201 && Number(bomCreate.body.record.version) === 1,
    'BOM fixture created for Job Card issue', JSON.stringify(bomCreate));
  bomNumber = bomCreate.body.record.bomNumber;

  const cardData = {
    jobCardDate: today,
    projectId: 'prod-test-proj',
    soNumber: 'SO-PROD-TEST',
    customerName: 'Isolated Test Customer',
    partCode: itemCode,
    partName: itemName,
    drawingNumber: itemCode,
    orderQuantity: 20,
    operations: {
      turning: { status: 'Completed' },
      setupApproval: { approved: true },
      machineProcess: { status: 'Completed' }
    },
    qualityControl: { finalQC: { disposition: 'Pass', acceptedQty: 15, reworkQty: 0, scrapQty: 0 } },
    processes: [{ process: 'Turning', status: 'Completed', machineId: 'M-TEST', machineName: 'CNC-TEST', operatorId: 'E-TEST', operatorName: 'Test Operator', plannedQty: 20, outputQty: 20, required: true }]
  };
  const cardToken = randomUUID();
  const cardCreate = await api('/api/production/job-cards', {
    method: 'POST', body: JSON.stringify({ data: cardData, createToken: cardToken })
  });
  assert(cardCreate.status === 201 && /^JC-\d{6}-\d{3}$/.test(cardCreate.body.record.jobCardNumber),
    'Job Card number preserves JC-YYMMDD-NNN format', JSON.stringify(cardCreate));
  jobCardNumber = cardCreate.body.record.jobCardNumber;
  const cardRetry = await api('/api/production/job-cards', {
    method: 'POST', body: JSON.stringify({ data: cardData, createToken: cardToken })
  });
  assert(cardRetry.status === 200 && cardRetry.body.duplicate, 'Job Card create retry is idempotent');

  const issue = await api(`/api/production/job-cards/${jobCardNumber}/issue`, {
    method: 'POST', body: JSON.stringify({ version: 1, bomNumber, bomVersion: 1 })
  });
  assert(issue.status === 200 && issue.body.record.bomVersion === 1,
    'Issuing snapshots the selected BOM version onto the Job Card', JSON.stringify(issue));
  const snapshotItems = await api(`/api/production/job-cards/${jobCardNumber}/items`);
  assert(snapshotItems.body.items.length === 1 && Number(snapshotItems.body.items[0].required_qty) === 2 &&
    snapshotItems.body.items[0].bom_number === bomNumber,
  'Job Card material requirements are copied into PostgreSQL snapshot rows');

  const revised = await api(`/api/bom/${bomNumber}`, {
    method: 'PUT',
    body: JSON.stringify({
      version: 1,
      data: {
        ...bomCreate.body.record,
        version: 2,
        effectiveDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        items: [{ materialId: itemCode, materialName: itemName, requiredQty: 99, unit: 'Nos' }]
      }
    })
  });
  assert(revised.status === 200 && Number(revised.body.record.version) === 2 && revised.body.supersedes === bomNumber,
    'BOM edit creates a new number and supersedes the previous version', JSON.stringify(revised));
  revisedBomNumber = revised.body.record.bomNumber;
  const oldBom = await pool.query('SELECT status,version FROM bom_headers WHERE bom_number=$1', [bomNumber]);
  assert(oldBom.rows[0].status === 'Superseded' && Number(oldBom.rows[0].version) === 2,
    'The original BOM remains as a Superseded, version-advanced row');
  const afterEditItems = await api(`/api/production/job-cards/${jobCardNumber}/items`);
  assert(Number(afterEditItems.body.items[0].required_qty) === 2 &&
    afterEditItems.body.items[0].bom_number === bomNumber,
  'Later BOM edits do not change already-issued Job Card requirements');

  const staleCard = await api(`/api/production/job-cards/${jobCardNumber}`, {
    method: 'PUT', body: JSON.stringify({ version: 1, data: { ...cardData, remarks: 'stale' } })
  });
  assert(staleCard.status === 409, 'Stale Job Card version is rejected');

  const currentCard = await getCard(jobCardNumber);
  const ineligibleDispatch = await api(`/api/production/job-cards/${jobCardNumber}/dispatch-request`, {
    method: 'POST', body: JSON.stringify({ version: Number(currentCard.version) })
  });
  assert(ineligibleDispatch.status === 400, 'Dispatch is blocked while the Job Card is not completed');
  const complete = await api(`/api/production/job-cards/${jobCardNumber}/complete`, {
    method: 'POST', body: JSON.stringify({ version: Number(currentCard.version) })
  });
  assert(complete.status === 200 && complete.body.record.status === 'Completed',
    'Completion succeeds after all required operations and final QC pass', JSON.stringify(complete));

  const completedCard = await getCard(jobCardNumber);
  const dispatch = await api(`/api/production/job-cards/${jobCardNumber}/dispatch-request`, {
    method: 'POST', body: JSON.stringify({ version: Number(completedCard.version) })
  });
  assert(dispatch.status === 201 && Number(dispatch.body.request.eligibleQuantity) === 15,
    'Dispatch request uses the lesser of order and QC-accepted quantity', JSON.stringify(dispatch));
  const retryCard = await getCard(jobCardNumber);
  const dispatchRetry = await api(`/api/production/job-cards/${jobCardNumber}/dispatch-request`, {
    method: 'POST', body: JSON.stringify({ version: Number(retryCard.version) })
  });
  assert(dispatchRetry.status === 200 && dispatchRetry.body.duplicate, 'Dispatch request retry is idempotent');
  const deletedJobCard = await api(`/api/production/job-cards/${jobCardNumber}`, {
    method: 'DELETE', body: JSON.stringify({ version: Number(retryCard.version), reason: 'isolated Job Card restore verification' })
  });
  assert(deletedJobCard.status === 200, 'Admin soft-deletes the completed Job Card');
  const restoredJobCard = await api(`/api/production/job-cards/${jobCardNumber}/restore`, {
    method: 'POST', body: JSON.stringify({ reason: 'isolated Job Card restore verification' })
  });
  assert(restoredJobCard.status === 200 && restoredJobCard.body.record.status === 'Cancelled',
    'Admin restores the soft-deleted Job Card with restore audit');

  /* ---------------- HT outsource lifecycle ---------------- */
  const htCardCreate = await api('/api/production/job-cards', {
    method: 'POST',
    body: JSON.stringify({
      createToken: randomUUID(),
      data: {
        jobCardDate: today,
        projectId: 'PROD-TEST-PROJ',
        partCode: itemCode,
        partName: itemName,
        orderQuantity: 20,
        operations: { heatTreatment: { required: true, processType: 'Heat Treatment', qtySent: 10 } }
      }
    })
  });
  assert(htCardCreate.status === 201, 'HT-linked Job Card created');
  htCardNumber = htCardCreate.body.record.jobCardNumber;

  const htToken = randomUUID();
  const htCreate = await api('/api/production/ht-outsource', {
    method: 'POST',
    body: JSON.stringify({
      createToken: htToken,
      data: { jobCardNumber: htCardNumber, projectId: 'PROD-TEST-PROJ', partCode: itemCode, partName: itemName, qtyRequested: 10 }
    })
  });
  assert(htCreate.status === 201 && /^HTR-\d{6}$/.test(htCreate.body.record.htrNumber) &&
    htCreate.body.record.status === 'Raised',
  'HTR number preserves HTR-NNNNNN format and starts as Raised', JSON.stringify(htCreate));
  htrNumber = htCreate.body.record.htrNumber;
  const htRetry = await api('/api/production/ht-outsource', {
    method: 'POST',
    body: JSON.stringify({ createToken: htToken, data: { jobCardNumber: htCardNumber, qtyRequested: 10 } })
  });
  assert(htRetry.status === 200 && htRetry.body.duplicate, 'HTR create retry is idempotent');

  let htr = await getHtr(htrNumber);
  const vendor = await api(`/api/production/ht-outsource/${htrNumber}/assign-vendor`, {
    method: 'POST', body: JSON.stringify({ version: htr.version, vendorName: 'Isolated HT Vendor', poRef: 'PO-HT-TEST', rateInfo: '120/kg' })
  });
  assert(vendor.status === 200 && vendor.body.record.status === 'Vendor Assigned', 'Purchase assigns a vendor');
  htr = await getHtr(htrNumber);
  const issueHt = await api(`/api/production/ht-outsource/${htrNumber}/issue`, {
    method: 'POST', body: JSON.stringify({ version: htr.version, qty: 6, outwardChallan: 'DC-HT-TEST' })
  });
  assert(issueHt.status === 200 && issueHt.body.record.status === 'Issued to Vendor' &&
    Number(issueHt.body.record.issuedQty) === 6,
  'Store issues only the requested quantity', JSON.stringify(issueHt));
  assert(Number(issueHt.body.record.qtyRequested) === 10, 'Issuing does not overwrite the requested quantity');

  htr = await getHtr(htrNumber);
  const blockedCancel = await api(`/api/production/ht-outsource/${htrNumber}/cancel`, {
    method: 'POST', body: JSON.stringify({ version: htr.version, reason: 'should be blocked' })
  });
  assert(blockedCancel.status === 409, 'HTR cannot be cancelled after material is issued to the vendor');
  const overReceive = await api(`/api/production/ht-outsource/${htrNumber}/receive`, {
    method: 'POST', body: JSON.stringify({ version: htr.version, qty: 7 })
  });
  assert(overReceive.status === 400, 'Receiving more than the issued quantity is rejected');
  const receive = await api(`/api/production/ht-outsource/${htrNumber}/receive`, {
    method: 'POST', body: JSON.stringify({ version: htr.version, qty: 5, inwardChallan: 'IN-HT-TEST' })
  });
  assert(receive.status === 200 && receive.body.record.status === 'Received at Store' &&
    Number(receive.body.record.receivedQty) === 5 && Number(receive.body.record.rejectedQty) === 1,
  'Receiving derives rejected quantity from issued minus received');

  htr = await getHtr(htrNumber);
  const hardness = await api(`/api/production/ht-outsource/${htrNumber}/complete`, {
    method: 'POST', body: JSON.stringify({ version: htr.version, actualHardness: '42 HRC', disposition: 'Pass' })
  });
  assert(hardness.status === 200 && hardness.body.record.status === 'Completed',
    'Hardness Pass completes the HTR', JSON.stringify(hardness));
  const htAudit = await api(`/api/production/ht-outsource/${htrNumber}/audit`);
  const htActions = htAudit.body.entries.map((entry) => entry.action);
  assert(['CREATE', 'VENDOR_ASSIGNED', 'ISSUED_TO_VENDOR', 'RECEIVED_FROM_VENDOR']
    .every((action) => htActions.includes(action)), 'HT status transitions are retained in the audit table');

  const stockRows = await pool.query(
    'SELECT id,movement_type,quantity FROM stock_ledger_entries WHERE id=$1 OR id=$2 ORDER BY id',
    [`htr-out-${htrNumber}`, `htr-in-${htrNumber}`]
  );
  assert(stockRows.rowCount === 2 && stockRows.rows.some((r) => r.movement_type === 'OUT' && Number(r.quantity) === 6) &&
    stockRows.rows.some((r) => r.movement_type === 'IN' && Number(r.quantity) === 5),
  'HT issue and receipt post exactly one OUT and one IN stock movement');
  const finalInventory = await pool.query('SELECT current_qty FROM inventory_items WHERE item_code=$1', [itemCode]);
  assert(Number(finalInventory.rows[0].current_qty) === 19, 'Tracked inventory balance reflects the net HT movement');
  const genericWrite = await api('/api/state/productionDispatchRequests', {
    method: 'PUT', body: JSON.stringify({ data: [] })
  });
  assert(genericWrite.status === 400, 'Generic erp_state API rejects production dispatch request writes');
  for (const key of ['boms', 'bomMasterList', 'productionRequirements', 'productionRequirementSequence', 'productionRequirementsSequence', 'productionJobCards', 'jobCards', 'debitNotes', 'debitNoteSequence']) {
    const result = await api(`/api/state/${key}`, { method: 'PUT', body: JSON.stringify({ data: [] }) });
    assert(result.status === 400, `Generic erp_state API rejects migrated ${key} writes`);
  }
  console.log(`Production PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`Production integration failed after ${assertions}: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  const numbers = [requirementNumber, linkedRequirementNumber, jobCardNumber, htCardNumber, htrNumber, bomNumber, revisedBomNumber].filter(Boolean);
  try {
    await restoreSequences();
    if (linkedIndentNumber) {
      await pool.query("DELETE FROM procurement_record_audit WHERE entity_type='purchaseIndent' AND record_id=$1", [linkedIndentNumber]);
      await pool.query('DELETE FROM purchase_indents WHERE indent_number=$1', [linkedIndentNumber]);
    }
    if (numbers.length) {
      await pool.query('DELETE FROM job_card_items WHERE job_card_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM production_operation_entries WHERE job_card_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM production_entries WHERE job_card_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM job_card_operations WHERE job_card_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM bom_items WHERE bom_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM production_requirement_items WHERE requirement_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM job_card_audit WHERE job_card_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM bom_audit WHERE bom_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM ht_outsource_audit WHERE htr_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM production_requirements WHERE requirement_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM job_cards WHERE job_card_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM bom_headers WHERE bom_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM ht_outsource_requests WHERE htr_number = ANY($1)', [numbers]);
      await pool.query(`DELETE FROM erp_audit_log WHERE record_id = ANY($1)
        AND module IN ('production_requirements','job_cards','bom','ht_outsource')`, [numbers]);
    }
    if (htrNumber) {
      await pool.query('DELETE FROM stock_ledger_entries WHERE id=$1 OR id=$2',
        [`htr-out-${htrNumber}`, `htr-in-${htrNumber}`]);
      await pool.query("DELETE FROM module_records WHERE storage_key='stockTransactions' AND (record_id=$1 OR record_id=$2)",
        [`htr-out-${htrNumber}`, `htr-in-${htrNumber}`]);
      await pool.query("DELETE FROM erp_audit_log WHERE module='inventoryItems' AND action IN ('STOCK_OUT','STOCK_IN') AND record_id=$1",
        [itemCode]);
    }
    if (itemCode) await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [itemCode]);
    if (inventoryId) await pool.query("DELETE FROM module_records WHERE storage_key='inventoryItems' AND record_id=$1", [inventoryId]);
  } catch (cleanupError) {
    console.error(`Production fixture cleanup warning: ${cleanupError.message}`);
    process.exitCode = 1;
  }
  await stop();
  await pool.end();
}
