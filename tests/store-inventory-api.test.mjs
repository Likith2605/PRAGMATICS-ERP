/** Isolated PostgreSQL API integration test for Store, Inventory and Stock Ledger. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') throw new Error('Refusing Store tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required.');
const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') { await pool.end(); throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.'); }

const port = Number(process.env.ERP_STORE_TEST_PORT || 3388);
const base = `http://127.0.0.1:${port}`;
let child; let token = ''; let assertions = 0;
const assert = (ok, label) => { if (!ok) throw new Error(label); assertions += 1; console.log(`PASS ${label}`); };
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) }; delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let n = 0; n < 100; n += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((m) => m.version === '033_store_management')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Store server did not become ready.');
};
const stop = async () => { if (!child) return; child.kill(); await new Promise((resolve) => child.once('exit', resolve)); child = null; };
const login = async () => (await api('/api/auth/login', json('POST', { email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }), '')).body.token;

const suffix = randomUUID().slice(0, 8);
const itemCode = `STI-${suffix}`;
const expiryItemCode = `STX-${suffix}`;
const expiryBatchNo = `EXPIRED-${suffix}`;
const mrNumber = `MR-${Date.now()}-${suffix}`;
const issueNumber = `SI-${Date.now()}-${suffix}`;
const returnNumber = `SR-${Date.now()}-${suffix}`;
const jobCardNumber = `JC-ST-${suffix}`;
const legacyNumber = `MR-LEGACY-${randomUUID()}`;
const openingKey = `opening-${randomUUID()}`;
const transferCreateKey = `transfer-create-${randomUUID()}`;
const transferApproveKey = `transfer-approve-${randomUUID()}`;
const transferRejectCreateKey = `transfer-reject-create-${randomUUID()}`;
const transferRejectKey = `transfer-reject-${randomUUID()}`;
const verificationCreateKey = `verification-create-${randomUUID()}`;
const verificationApproveKey = `verification-approve-${randomUUID()}`;
const staleVerificationKey = `verification-stale-${randomUUID()}`;
const batchOpeningKey = `batch-opening-${randomUUID()}`;
const batchTransferCreateKey = `batch-transfer-${randomUUID()}`;
const batchTransferApproveKey = `batch-transfer-approve-${randomUUID()}`;
const batchVerificationCreateKey = `batch-verification-${randomUUID()}`;
const batchVerificationApproveKey = `batch-verification-approve-${randomUUID()}`;
const concurrencyItemCode = `STC-${suffix}`;
const concurrencyOpeningKey = `opening-concurrent-${randomUUID()}`;
const competingTransferKeys = [`competing-a-${randomUUID()}`, `competing-b-${randomUUID()}`];
const competingApprovalKeys = [`competing-approve-a-${randomUUID()}`, `competing-approve-b-${randomUUID()}`];
let transferNumber = '';
let rejectedTransferNumber = '';
let batchTransferNumber = '';
let competingTransferNumbers = [];
let verificationNumber = '';
let staleVerificationNumber = '';
let batchVerificationNumber = '';
let rejectedVerificationNumber = '';
try {
  await start(); token = await login();
  assert(Boolean(token), 'Admin session authenticates');
  assert((await api('/api/store/requests', {}, '')).status === 401, 'Unauthenticated Store reads are rejected');

  const createdItem = await api('/api/inventory/items', json('POST', { data: { itemCode, materialName: `Isolated material ${suffix}`, category: 'Raw Material', unit: 'Nos', reorderLevel: 2, unitPrice: 10 } }));
  assert(createdItem.status === 201 && Number(createdItem.body.record.version) === 1, 'Inventory item is created authoritatively in PostgreSQL');
  const staleItem = await api('/api/inventory/items', json('POST', { data: { itemCode, materialName: 'Stale' }, version: 0 }));
  assert(staleItem.status === 409, 'Inventory update with stale version is rejected');

  const opening = await api('/api/inventory/opening-stock', json('POST', { idempotencyKey: openingKey, itemCode, quantity: 20, entryDate: new Date().toISOString().slice(0, 10), reason: 'Isolated test opening' }));
  assert(opening.status === 201 && Number(opening.body.balanceAfter) === 20, 'Opening stock posts to the central ledger');
  const openingRetry = await api('/api/inventory/opening-stock', json('POST', { idempotencyKey: openingKey, itemCode, quantity: 20, entryDate: new Date().toISOString().slice(0, 10), reason: 'Isolated test opening' }));
  assert(openingRetry.status === 200 && openingRetry.body.duplicate, 'Opening stock retry is idempotent');
  const openingLedger = await pool.query('SELECT id FROM stock_ledger_entries WHERE id=$1', [openingKey]);
  const qtyAfterOpening = await pool.query('SELECT current_qty FROM inventory_items WHERE item_code=$1', [itemCode]);
  assert(openingLedger.rowCount === 1 && Number(qtyAfterOpening.rows[0].current_qty) === 20, 'No duplicate stock movement is recorded on retry');

  const expiryItem = await api('/api/inventory/items', json('POST', { data: { itemCode: expiryItemCode, materialName: `Expired material ${suffix}`, unit: 'Nos' } }));
  assert(expiryItem.status === 201, 'Inventory item for batch-write-off test is created');
  const expiryOpeningKey = `opening-${randomUUID()}`;
  const expiryOpening = await api('/api/inventory/opening-stock', json('POST', {
    idempotencyKey: expiryOpeningKey,
    itemCode: expiryItemCode,
    quantity: 5,
    batchNo: expiryBatchNo,
    lotNumber: `LOT-${suffix}`,
    expiryDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    mfgDate: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
    reason: 'Isolated expired batch'
  }));
  const createdLot = await api(`/api/inventory/lots?itemCode=${encodeURIComponent(expiryItemCode)}`);
  assert(expiryOpening.status === 201 && createdLot.status === 200
    && createdLot.body.records.length === 1
    && Number(createdLot.body.records[0].available_qty) === 5
    && Number(createdLot.body.records[0].initial_qty) === 5,
  'Inbound ledger movement creates an authoritative PostgreSQL batch');
  const writeOffKey = `expiry-writeoff-${randomUUID()}`;
  const writeOff = await api('/api/inventory/adjustments', json('POST', {
    idempotencyKey: writeOffKey,
    itemCode: expiryItemCode,
    quantity: -2,
    batchNo: expiryBatchNo,
    lotNumber: `LOT-${suffix}`,
    reason: 'Expired stock write-off',
    entryDate: new Date().toISOString().slice(0, 10)
  }));
  const writeOffRetry = await api('/api/inventory/adjustments', json('POST', {
    idempotencyKey: writeOffKey,
    itemCode: expiryItemCode,
    quantity: -2,
    batchNo: expiryBatchNo,
    lotNumber: `LOT-${suffix}`,
    reason: 'Expired stock write-off',
    entryDate: new Date().toISOString().slice(0, 10)
  }));
  const afterWriteOff = await pool.query(
    `SELECT i.current_qty,b.available_qty
       FROM inventory_items i JOIN inventory_batches b ON b.item_code=i.item_code
      WHERE i.item_code=$1 AND b.batch_number=$2`,
    [expiryItemCode, expiryBatchNo]
  );
  assert(writeOff.status === 201 && writeOffRetry.status === 200 && writeOffRetry.body.duplicate
    && afterWriteOff.rowCount === 1
    && Number(afterWriteOff.rows[0].current_qty) === 3
    && Number(afterWriteOff.rows[0].available_qty) === 3,
  'Expired batch write-off updates item and batch balances once through the PostgreSQL ledger');
  const nonExpiredWriteOff = await api('/api/inventory/adjustments', json('POST', {
    idempotencyKey: `invalid-writeoff-${randomUUID()}`,
    itemCode,
    quantity: -1,
    reason: 'Expired stock write-off',
    entryDate: new Date().toISOString().slice(0, 10)
  }));
  assert(nonExpiredWriteOff.status === 400, 'Expired stock write-off cannot be recorded without an expired batch');

  await pool.query(
    `INSERT INTO job_cards(job_card_number,job_card_date,project_id,customer_name,part_name,order_quantity,status,payload,created_by,updated_by)
     VALUES($1,CURRENT_DATE,'ST-PROJECT','Isolated Customer','Isolated Job Part',10,'In Production','{}'::jsonb,'store-test','store-test')`
  , [jobCardNumber]);
  const request = await api('/api/store/requests', json('POST', { data: { mrNumber, date: new Date().toISOString().slice(0, 10), department: 'Production', requestedBy: 'Isolated Tester', status: 'Submitted', jobCardNumber, items: [{ materialId: itemCode, materialName: `Isolated material ${suffix}`, requiredQty: 10, unit: 'Nos' }] } }));
  assert(request.status === 201 && request.body.record.mrNumber === mrNumber && request.body.record.items.length === 1, 'Material Request is persisted with normalized lines');
  const staleRequest = await api(`/api/store/requests/${encodeURIComponent(mrNumber)}`, json('PUT', { data: { remarks: 'stale' }, version: 0 }));
  assert(staleRequest.status >= 400, 'Material Request stale version is rejected');

  const issuePayload = {
    issueNumber,
    createToken: randomUUID(),
    mrNumber,
    issueDate: new Date().toISOString().slice(0, 10),
    receiver: { name: 'Isolated Store Employee', employeeId: `EMP-${suffix}`, acknowledged: true },
    issueQtyById: { [itemCode]: 5 },
    batchInfo: {},
    issueRefs: { jobCardNumber, poNumber: `PO-${suffix}`, customer: 'Isolated Customer' },
    remarks: 'Isolated issue test'
  };
  const issue = await api('/api/store/issue', json('POST', issuePayload));
  assert(issue.status === 201 && issue.body.issueNumber === issueNumber, 'Store Issue posts through the authenticated API');
  const issueRetry = await api('/api/store/issue', json('POST', issuePayload));
  assert(issueRetry.status === 200 && issueRetry.body.duplicate, 'Store Issue retry is idempotent and does not issue twice');
  const stockAfterIssue = await pool.query('SELECT current_qty FROM inventory_items WHERE item_code=$1', [itemCode]);
  const issueLedger = await pool.query("SELECT id FROM stock_ledger_entries WHERE source_doc_ref=$1 AND movement_type='OUT'", [issueNumber]);
  assert(Number(stockAfterIssue.rows[0].current_qty) === 15 && issueLedger.rowCount === 1, 'Issue deducts stock exactly once in the central ledger');
  const mrAfterIssue = await api(`/api/store/requests?search=${encodeURIComponent(mrNumber)}`);
  const mrRecord = (mrAfterIssue.body.records || []).find((row) => row.mrNumber === mrNumber);
  assert(mrRecord?.status === 'Partially Issued' && Number(mrRecord.items[0].issuedQty) === 5, 'Material Request balance is updated from the committed issue');
  const jobCardRow = await pool.query(
    "SELECT payload,version FROM job_cards WHERE job_card_number=$1",
    [jobCardNumber]
  );
  assert(jobCardRow.rowCount === 1 && jobCardRow.rows[0].payload?.materialStatus === 'Partially Issued',
    'Store Issue updates the linked PostgreSQL Job Card material status in the same transaction');

  const overReturn = await api('/api/store/returns', json('POST', { returnNumber: `SR-OVER-${suffix}`, issueNumber, receiver: { name: 'Isolated Store Employee', employeeId: `EMP-${suffix}`, acknowledged: true }, returnItems: [{ materialId: itemCode, quantity: 99 }] }));
  assert(overReturn.status === 400, 'Return beyond issued quantity is rejected');

  const returnPayload = {
    returnNumber, createToken: randomUUID(), issueNumber,
    returnDate: new Date().toISOString().slice(0, 10),
    receiver: { name: 'Isolated Store Employee', employeeId: `EMP-${suffix}`, acknowledged: true },
    returnItems: [{ materialId: itemCode, quantity: 2, unit: 'Nos' }],
    reason: 'Isolated return test'
  };
  const returned = await api('/api/store/returns', json('POST', returnPayload));
  assert(returned.status === 201 && returned.body.returnNumber === returnNumber, 'Material Return posts through the authenticated API');
  const stockAfterReturn = await pool.query('SELECT current_qty FROM inventory_items WHERE item_code=$1', [itemCode]);
  const returnLedger = await pool.query("SELECT id FROM stock_ledger_entries WHERE source_doc_ref=$1 AND movement_type='RETURN'", [returnNumber]);
  assert(Number(stockAfterReturn.rows[0].current_qty) === 17 && returnLedger.rowCount === 1, 'Return restores stock exactly once in the central ledger');
  const audit = await api(`/api/store/audit?issueNumber=${encodeURIComponent(issueNumber)}`);
  assert(audit.status === 200 && (audit.body.records || []).some((row) => row.action === 'MATERIAL_ISSUE'), 'Store audit history is durable');

  const ledger = await api(`/api/inventory/ledger?itemCode=${encodeURIComponent(itemCode)}`);
  const firstLedgerPage = await api(`/api/inventory/ledger?itemCode=${encodeURIComponent(itemCode)}&limit=1&offset=0`);
  const secondLedgerPage = await api(`/api/inventory/ledger?itemCode=${encodeURIComponent(itemCode)}&limit=1&offset=1`);
  const valuation = await api('/api/inventory/valuation');
  assert(ledger.status === 200 && ledger.body.records.length >= 3, 'Authoritative stock ledger is queryable by item');
  assert(firstLedgerPage.status === 200 && secondLedgerPage.status === 200
    && firstLedgerPage.body.records.length === 1 && secondLedgerPage.body.records.length === 1
    && firstLedgerPage.body.records[0].id !== secondLedgerPage.body.records[0].id
    && firstLedgerPage.body.total === ledger.body.records.length,
  'Paginated stock-ledger report reads expose every matching PostgreSQL movement');
  const valuationRow = (valuation.body.records || []).find((row) => row.item_code === itemCode);
  assert(valuation.status === 200 && valuationRow
    && Number(valuationRow.current_qty) === Number(stockAfterReturn.rows[0].current_qty)
    && Number(valuationRow.valuation) === Number(valuationRow.current_qty) * Number(valuationRow.unit_price),
  'Inventory valuation quantity and value match authoritative PostgreSQL item fields');

  const unauthenticatedTransferList = await api('/api/inventory/transfer-documents', {}, '');
  const unauthenticatedVerificationList = await api('/api/inventory/verifications', {}, '');
  const unauthenticatedAudit = await api('/api/store/audit', {}, '');
  const unauthenticatedAuditWrite = await api('/api/store/audit', json('POST', { action: 'unauthenticated test' }), '');
  assert(unauthenticatedTransferList.status === 401 && unauthenticatedVerificationList.status === 401
    && unauthenticatedAudit.status === 401 && unauthenticatedAuditWrite.status === 401,
  'Transfer, verification, and audit APIs require authentication');
  const transferData = {
    fromLocation: 'Unassigned',
    toLocation: `Warehouse-${suffix}`,
    requestedBy: 'Isolated Tester',
    remarks: 'Transfer lifecycle test',
    items: [{ itemCode, quantity: 4, unit: 'Nos' }]
  };
  const transfer = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: transferCreateKey, data: transferData
  }));
  transferNumber = transfer.body.record?.transferNumber || '';
  assert(transfer.status === 201 && transfer.body.record?.status === 'Pending'
    && transfer.body.record.items.length === 1,
  'Stock Transfer document is created with normalized item lines');
  const transferRetry = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: transferCreateKey, data: transferData
  }));
  assert(transferRetry.status === 200 && transferRetry.body.duplicate
    && transferRetry.body.record.transferNumber === transferNumber,
  'Stock Transfer create retry returns the existing document');
  const transferConflict = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: transferCreateKey, data: { ...transferData, toLocation: 'Different location' }
  }));
  const sameLocationTransfer = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: `same-location-${randomUUID()}`,
    data: { ...transferData, fromLocation: 'Unassigned', toLocation: 'Unassigned' }
  }));
  const insufficientTransfer = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: `insufficient-${randomUUID()}`,
    data: { ...transferData, items: [{ itemCode, quantity: 999, unit: 'Nos' }] }
  }));
  assert(transferConflict.status === 409 && sameLocationTransfer.status === 400
    && insufficientTransfer.status === 400,
  'Transfer idempotency, same-location and insufficient-stock validations are enforced');
  const transferApproval = await api(
    `/api/inventory/transfer-documents/${encodeURIComponent(transferNumber)}/approve`,
    json('POST', { version: transfer.body.record.recordVersion, idempotencyKey: transferApproveKey })
  );
  const transferApprovalRetry = await api(
    `/api/inventory/transfer-documents/${encodeURIComponent(transferNumber)}/approve`,
    json('POST', { version: transfer.body.record.recordVersion, idempotencyKey: transferApproveKey })
  );
  const transferLocations = await pool.query(
    'SELECT location,quantity FROM inventory_location_balances WHERE item_code=$1 AND location=ANY($2::text[]) ORDER BY location',
    [itemCode, ['Unassigned', transferData.toLocation]]
  );
  const transferLedger = await pool.query(
    "SELECT movement_type,payload->>'location' AS location FROM stock_ledger_entries WHERE source_doc_ref=$1 ORDER BY movement_type",
    [transferNumber]
  );
  assert(transferApproval.status === 200 && transferApproval.body.record.status === 'Completed'
    && transferApprovalRetry.status === 200 && transferApprovalRetry.body.duplicate
    && transferLocations.rowCount === 2
    && Number(transferLocations.rows.find((row) => row.location === 'Unassigned')?.quantity) === 13
    && Number(transferLocations.rows.find((row) => row.location === transferData.toLocation)?.quantity) === 4
    && transferLedger.rowCount === 2,
  'Transfer approval atomically moves location stock and posts exactly two ledger legs');
  const locationBalanceApi = await api(`/api/inventory/location-balances?itemCode=${encodeURIComponent(itemCode)}`);
  assert(locationBalanceApi.status === 200
    && locationBalanceApi.body.records.some((row) => row.location === 'Unassigned' && Number(row.quantity) === 13)
    && locationBalanceApi.body.records.some((row) => row.location === transferData.toLocation && Number(row.quantity) === 4),
  'Location-balance API exposes the committed transfer quantities');
  const locationBatchBalanceApi = await api(`/api/inventory/location-batch-balances?itemCode=${encodeURIComponent(expiryItemCode)}`);
  assert(locationBatchBalanceApi.status === 200
    && locationBatchBalanceApi.body.records.some((row) => row.item_code === expiryItemCode && row.batch_number === expiryBatchNo && row.location === 'Unassigned'),
  'Location batch-balance API exposes authoritative batch quantities for Store workflow forms');
  const rejectedTransfer = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: transferRejectCreateKey,
    data: { ...transferData, toLocation: `Reject-${suffix}`, items: [{ itemCode, quantity: 1, unit: 'Nos' }] }
  }));
  rejectedTransferNumber = rejectedTransfer.body.record?.transferNumber || '';
  const rejectedTransferResult = await api(
    `/api/inventory/transfer-documents/${encodeURIComponent(rejectedTransferNumber)}/reject`,
    json('POST', { version: rejectedTransfer.body.record.recordVersion, idempotencyKey: transferRejectKey, reason: 'Rejected in isolated test' })
  );
  const rejectedTransferLedger = await pool.query('SELECT 1 FROM stock_ledger_entries WHERE source_doc_ref=$1', [rejectedTransferNumber]);
  assert(rejectedTransferResult.status === 200 && rejectedTransferResult.body.record.status === 'Rejected'
    && rejectedTransferLedger.rowCount === 0,
  'Rejected transfers retain document history without moving stock');

  const concurrencyItem = await api('/api/inventory/items', json('POST', {
    data: { itemCode: concurrencyItemCode, materialName: `Concurrent transfer ${suffix}`, unit: 'Nos' }
  }));
  const concurrencyOpening = await api('/api/inventory/opening-stock', json('POST', {
    idempotencyKey: concurrencyOpeningKey, itemCode: concurrencyItemCode, quantity: 10,
    reason: 'Concurrent transfer fixture'
  }));
  const competingTransfers = await Promise.all(competingTransferKeys.map((idempotencyKey, index) =>
    api('/api/inventory/transfer-documents', json('POST', {
      idempotencyKey,
      data: {
        fromLocation: 'Unassigned',
        toLocation: `Concurrent-Destination-${index}-${suffix}`,
        items: [{ itemCode: concurrencyItemCode, quantity: 7, unit: 'Nos' }]
      }
    }))
  ));
  competingTransferNumbers = competingTransfers.map((result) => result.body.record?.transferNumber).filter(Boolean);
  const competingApprovals = await Promise.all(competingTransfers.map((result, index) =>
    api(`/api/inventory/transfer-documents/${encodeURIComponent(result.body.record.transferNumber)}/approve`,
      json('POST', { version: result.body.record.recordVersion, idempotencyKey: competingApprovalKeys[index] }))
  ));
  const competingLedger = await pool.query(
    "SELECT source_doc_ref FROM stock_ledger_entries WHERE source_doc_ref=ANY($1::text[])",
    [competingTransferNumbers]
  );
  const concurrentBalance = await pool.query(
    'SELECT quantity FROM inventory_location_balances WHERE item_code=$1 AND location=$2',
    [concurrencyItemCode, 'Unassigned']
  );
  assert(concurrencyItem.status === 201 && concurrencyOpening.status === 201
    && competingTransfers.every((result) => result.status === 201)
    && competingApprovals.filter((result) => result.status === 200).length === 1
    && competingApprovals.filter((result) => result.status === 400).length === 1
    && competingLedger.rowCount === 2
    && Number(concurrentBalance.rows[0]?.quantity) === 3,
  'Concurrent transfers cannot deduct the same stock twice or create an overdrawn location');

  const batchOpening = await api('/api/inventory/opening-stock', json('POST', {
    idempotencyKey: batchOpeningKey, itemCode, quantity: 2, batchNo: `TRANSFER-BATCH-${suffix}`,
    lotNumber: `TRANSFER-LOT-${suffix}`, location: 'Unassigned', reason: 'Transfer batch fixture'
  }));
  const batchLots = await api(`/api/inventory/lots?itemCode=${encodeURIComponent(itemCode)}`);
  const transferBatch = (batchLots.body.records || []).find((batch) => batch.batch_number === `TRANSFER-BATCH-${suffix}`);
  const batchTransfer = await api('/api/inventory/transfer-documents', json('POST', {
    idempotencyKey: batchTransferCreateKey,
    data: {
      fromLocation: 'Unassigned', toLocation: `Batch-Destination-${suffix}`,
      items: [{ itemCode, batchId: transferBatch?.id, batchNumber: transferBatch?.batch_number, lotNumber: transferBatch?.lot_number, quantity: 1, unit: 'Nos' }]
    }
  }));
  batchTransferNumber = batchTransfer.body.record?.transferNumber || '';
  const batchTransferApproval = await api(
    `/api/inventory/transfer-documents/${encodeURIComponent(batchTransferNumber)}/approve`,
    json('POST', { version: batchTransfer.body.record.recordVersion, idempotencyKey: batchTransferApproveKey })
  );
  const batchBalances = await pool.query(
    `SELECT location,quantity FROM inventory_location_batch_balances
      WHERE batch_id=$1 AND location=ANY($2::text[]) ORDER BY location`,
    [transferBatch?.id, ['Unassigned', `Batch-Destination-${suffix}`]]
  );
  assert(batchOpening.status === 201 && transferBatch?.id && batchTransferApproval.status === 200
    && batchBalances.rowCount === 2
    && Number(batchBalances.rows.find((row) => row.location === 'Unassigned')?.quantity) === 1
    && Number(batchBalances.rows.find((row) => row.location === `Batch-Destination-${suffix}`)?.quantity) === 1,
  'Batch transfer moves the registered batch balance between locations without changing its total');

  const verificationData = {
    location: 'Unassigned',
    remarks: 'Physical count test',
    items: [{ itemCode, physicalQty: 12, unit: 'Nos', remarks: 'Counted in test' }]
  };
  const verification = await api('/api/inventory/verifications', json('POST', {
    idempotencyKey: verificationCreateKey, data: verificationData
  }));
  verificationNumber = verification.body.record?.verificationNumber || '';
  const verificationRetry = await api('/api/inventory/verifications', json('POST', {
    idempotencyKey: verificationCreateKey, data: verificationData
  }));
  assert(verification.status === 201 && verification.body.record.status === 'Pending Approval'
    && Number(verification.body.record.items[0].systemQty) === 14
    && Number(verification.body.record.items[0].difference) === -2
    && verificationRetry.status === 200 && verificationRetry.body.duplicate,
  'Stock Verification records authoritative system quantity and an idempotent variance');
  const verificationApproval = await api(
    `/api/inventory/verifications/${encodeURIComponent(verificationNumber)}/approve`,
    json('POST', { version: verification.body.record.recordVersion, idempotencyKey: verificationApproveKey })
  );
  const verificationApprovalRetry = await api(
    `/api/inventory/verifications/${encodeURIComponent(verificationNumber)}/approve`,
    json('POST', { version: verification.body.record.recordVersion, idempotencyKey: verificationApproveKey })
  );
  const verificationLedger = await pool.query(
    "SELECT id,movement_type,quantity FROM stock_ledger_entries WHERE source_doc_ref=$1",
    [verificationNumber]
  );
  const verificationItem = await pool.query('SELECT current_qty FROM inventory_items WHERE item_code=$1', [itemCode]);
  assert(verificationApproval.status === 200 && verificationApproval.body.record.status === 'Approved'
    && verificationApprovalRetry.status === 200 && verificationApprovalRetry.body.duplicate
    && verificationLedger.rowCount === 1 && verificationLedger.rows[0].movement_type === 'ADJUSTMENT_OUT'
    && Number(verificationItem.rows[0].current_qty) === 17,
  'Verification approval posts one auditable ledger adjustment and is idempotent');

  const staleVerification = await api('/api/inventory/verifications', json('POST', {
    idempotencyKey: staleVerificationKey,
    data: { location: 'Unassigned', items: [{ itemCode, physicalQty: 16, unit: 'Nos' }] }
  }));
  staleVerificationNumber = staleVerification.body.record?.verificationNumber || '';
  const interveningAdjustment = await api('/api/inventory/adjustments', json('POST', {
    idempotencyKey: `intervening-${randomUUID()}`, itemCode, quantity: 1,
    location: 'Unassigned', reason: 'Concurrent verification fixture'
  }));
  const staleVerificationApproval = await api(
    `/api/inventory/verifications/${encodeURIComponent(staleVerificationNumber)}/approve`,
    json('POST', { version: staleVerification.body.record.recordVersion, idempotencyKey: `stale-approve-${randomUUID()}` })
  );
  assert(staleVerification.status === 201 && interveningAdjustment.status === 201
    && staleVerificationApproval.status === 409,
  'Verification approval rejects a stale physical count after intervening stock movement');
  const batchVerification = await api('/api/inventory/verifications', json('POST', {
    idempotencyKey: batchVerificationCreateKey,
    data: {
      location: `Batch-Destination-${suffix}`,
      items: [{
        itemCode,
        batchId: transferBatch.id,
        batchNumber: transferBatch.batch_number,
        lotNumber: transferBatch.lot_number,
        physicalQty: 0,
        unit: 'Nos'
      }]
    }
  }));
  batchVerificationNumber = batchVerification.body.record?.verificationNumber || '';
  const batchVerificationApproval = await api(
    `/api/inventory/verifications/${encodeURIComponent(batchVerificationNumber)}/approve`,
    json('POST', { version: batchVerification.body.record.recordVersion, idempotencyKey: batchVerificationApproveKey })
  );
  const batchVerificationRetry = await api(
    `/api/inventory/verifications/${encodeURIComponent(batchVerificationNumber)}/approve`,
    json('POST', { version: batchVerification.body.record.recordVersion, idempotencyKey: batchVerificationApproveKey })
  );
  const batchVerificationLedger = await pool.query(
    'SELECT id,movement_type FROM stock_ledger_entries WHERE source_doc_ref=$1',
    [batchVerificationNumber]
  );
  const batchDestinationAfterCount = await pool.query(
    'SELECT quantity FROM inventory_location_batch_balances WHERE batch_id=$1 AND location=$2',
    [transferBatch.id, `Batch-Destination-${suffix}`]
  );
  assert(batchVerification.status === 201
    && Number(batchVerification.body.record.items[0].systemQty) === 1
    && batchVerificationApproval.status === 200 && batchVerificationRetry.status === 200
    && batchVerificationRetry.body.duplicate && batchVerificationLedger.rowCount === 1
    && batchVerificationLedger.rows[0].movement_type === 'ADJUSTMENT_OUT'
    && Number(batchDestinationAfterCount.rows[0].quantity) === 0,
  'Batch-level verification applies its discrepancy once through the stock ledger');
  const rejectedVerification = await api('/api/inventory/verifications', json('POST', {
    idempotencyKey: `reject-verification-create-${randomUUID()}`,
    data: { location: transferData.toLocation, items: [{ itemCode, physicalQty: 4, unit: 'Nos' }] }
  }));
  rejectedVerificationNumber = rejectedVerification.body.record?.verificationNumber || '';
  const rejectedVerificationResult = await api(
    `/api/inventory/verifications/${encodeURIComponent(rejectedVerificationNumber)}/reject`,
    json('POST', { version: rejectedVerification.body.record.recordVersion, idempotencyKey: `reject-verification-${randomUUID()}`, reason: 'Rejected in isolated test' })
  );
  assert(rejectedVerificationResult.status === 200 && rejectedVerificationResult.body.record.status === 'Rejected',
    'Stock Verification can be rejected without posting an adjustment');

  const storeAudit = await api('/api/store/audit');
  const auditRows = storeAudit.body.records || [];
  assert(storeAudit.status === 200
    && auditRows.some((row) => row.reference === transferNumber && row.action === 'STOCK_TRANSFER_APPROVED')
    && auditRows.some((row) => row.reference === verificationNumber && row.action === 'STOCK_VERIFICATION_APPROVED')
    && auditRows.some((row) => row.reference === batchVerificationNumber && row.action === 'STOCK_VERIFICATION_APPROVED'),
  'Unified Store audit exposes transfer and verification decisions from PostgreSQL');
  const auditWrite = await api('/api/store/audit', json('POST', {
    action: 'MATERIAL REQUEST CLIENT EVENT', reference: mrNumber, details: 'Store audit API test'
  }));
  const auditMutation = await api('/api/store/audit', { method: 'DELETE' });
  assert(auditWrite.status === 201 && auditWrite.body.record?.email === process.env.ERP_ADMIN_EMAIL
    && auditMutation.status === 404,
  'Store audit accepts authenticated append-only events and has no delete operation');

  await pool.query("INSERT INTO erp_state(storage_key,data) VALUES('materialRequests',$1::jsonb) ON CONFLICT(storage_key) DO UPDATE SET data=erp_state.data||EXCLUDED.data", [JSON.stringify([{ mrNumber: legacyNumber, date: new Date().toISOString().slice(0, 10), status: 'Draft', items: [] }])]);
  const preview = await api('/api/store/migration-preview');
  assert(preview.status === 200 && (preview.body.eligible || []).some((row) => row.mrNumber === legacyNumber), 'Admin migration preview identifies eligible legacy requests');
  const imported = await api('/api/store/migration-preview/import-missing', json('POST', { records: (preview.body.eligible || []).filter((row) => row.mrNumber === legacyNumber) }));
  assert(imported.status === 200 && (imported.body.imported || []).includes(legacyNumber), 'Admin explicitly imports only selected legacy requests');
  const genericWrite = await api('/api/erp-state', json('POST', { storageKey: 'materialRequests', data: [] }));
  assert(genericWrite.status >= 400, 'Generic erp-state API rejects Store authority keys');

  console.log(`Store / Inventory PostgreSQL integration: ${assertions} passed, 0 failed.`);
} finally {
  await pool.query('DELETE FROM stock_verifications WHERE verification_number=ANY($1::text[])', [[verificationNumber, staleVerificationNumber, batchVerificationNumber, rejectedVerificationNumber].filter(Boolean)]);
  await pool.query('DELETE FROM stock_transfers WHERE transfer_number=ANY($1::text[])', [[transferNumber, rejectedTransferNumber, batchTransferNumber].filter(Boolean)]);
  await pool.query('DELETE FROM stock_transfers WHERE transfer_number=ANY($1::text[])', [competingTransferNumbers]);
  await pool.query(
    `DELETE FROM erp_audit_log
      WHERE (module IN ('stockTransfers','stockVerifications') AND record_id=ANY($1::text[]))
         OR (module='inventoryItems' AND record_id=ANY($2::text[]))
         OR (module='storeClientEvents' AND record_id=$3)`,
    [
      [transferNumber, rejectedTransferNumber, batchTransferNumber, ...competingTransferNumbers,
        verificationNumber, staleVerificationNumber, batchVerificationNumber, rejectedVerificationNumber].filter(Boolean),
      [itemCode, expiryItemCode, concurrencyItemCode],
      mrNumber
    ]
  );
  await pool.query('DELETE FROM material_issue_audit WHERE issue_number=$1', [issueNumber]);
  await pool.query('DELETE FROM job_card_audit WHERE job_card_number=$1', [jobCardNumber]);
  await pool.query('DELETE FROM job_card_items WHERE job_card_number=$1', [jobCardNumber]);
  await pool.query('DELETE FROM job_card_operations WHERE job_card_number=$1', [jobCardNumber]);
  await pool.query('DELETE FROM job_cards WHERE job_card_number=$1', [jobCardNumber]);
  await pool.query('DELETE FROM store_returns WHERE return_number=$1', [returnNumber]);
  await pool.query('DELETE FROM store_issues WHERE issue_number=$1', [issueNumber]);
  await pool.query('DELETE FROM material_requests WHERE mr_number IN ($1,$2)', [mrNumber, legacyNumber]);
  await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [itemCode]);
  await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [expiryItemCode]);
  await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [concurrencyItemCode]);
  await pool.query("UPDATE erp_state SET data=(SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(data) item WHERE item->>'mrNumber'<> $1) WHERE storage_key='materialRequests'", [legacyNumber]);
  await stop(); await pool.end();
}
