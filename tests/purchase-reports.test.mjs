import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

const workflow = await import('../src/utils/workflowService.js');
const reports = await import('../src/utils/purchaseReportData.js');
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const read = (key) => JSON.parse(localStorage.getItem(key) || '[]');
const loginAs = (department, roleKey, username) => save('erp_auth', {
  isLoggedIn: true, username, email: `${roleKey}@example.test`, department, roleKey
});

const po = {
  reference: 'PO-TEST-01', date: '2026-09-01', vendor: 'North Metals', status: 'Partially Received',
  payload: {
    poDetails: { poNumber: 'PO-TEST-01', poDate: '2026-09-01', deliveryDueDate: '2026-09-05', poStatus: 'Partially Received' },
    vendorDetails: { companyName: 'North Metals' },
    items: [{ itemCode: 'RM-1', itemName: 'Steel bar', category: 'Raw Material', quantity: 10, unit: 'kg', unitPrice: 25 }]
  }
};
save('supplierPOHistory', [po]);
save('materialArrivals', [{ arrivalNumber: 'ARR-1', poNumber: po.reference, items: [
  { materialCode: 'RM-1', arrivalQty: 2 }, { materialCode: 'RM-1', arrivalQty: 3 }
]}]);
save('qualityChecks', [{ qcNumber: 'QC-1', poNumber: po.reference, postedToInventory: true, items: [
  { materialCode: 'RM-1', receivedQty: 2, acceptedQty: 2, rejectedQty: 0 },
  { materialCode: 'RM-1', receivedQty: 3, acceptedQty: 3, rejectedQty: 0 }
]}]);
save('materialReceipts', [{ receiptNumber: 'REC-1', poNumber: po.reference, items: [
  { materialCode: 'RM-1', receivedQty: 2 }, { materialCode: 'RM-1', receivedQty: 3 }
]}]);

assert.equal(workflow.getPOProgress(po.reference).lines[0].receivedQty, 5, 'all same-item batch lines in one document are included');
assert.equal(workflow.getPOProgress(po.reference).pending, 5, 'original ordered quantity less received quantity');
const stale = reports.getStalePurchaseOrderRows('2026-09-10');
assert.equal(stale.length, 1);
assert.equal(stale[0].pendingQty, 5);
assert.equal(stale[0].daysOverdue, 5);
const supplierRows = reports.getSupplierWiseItemRows();
assert.equal(supplierRows[0].purchaseValue, 250, 'ordered quantity times PO rate');
assert.equal(supplierRows[0].receivedQty, 5, 'received total comes from PO progress, not an additive GRN join');

// Regression: same-PO replacement receipt/QC can be linked by receipt even if
// the older QC row omitted its denormalized poNumber. Stored Partial status and
// invoice/stock closure must not override complete physical fulfillment.
const replacementPO = {
  reference: 'PO-REPLACEMENT-COMPLETE', vendor: 'National Bearing Suppliers', status: 'Partially Received',
  payload: { poDetails: { poNumber: 'PO-REPLACEMENT-COMPLETE', poStatus: 'Partially Received' },
    vendorDetails: { companyName: 'National Bearing Suppliers' },
    items: [{ itemCode: 'BRG-1', itemName: 'Bearing', quantity: 216, unit: 'Nos' }] }
};
save('supplierPOHistory', [po, replacementPO]);
save('materialReceipts', [
  ...read('materialReceipts'),
  { receiptNumber: 'REC-ORIGINAL', poNumber: replacementPO.reference, items: [{ materialCode: 'BRG-1', receivedQty: 216 }] },
  { receiptNumber: 'RR-REPLACEMENT', poNumber: replacementPO.reference, isReplacement: true, rejectionNumber: 'RRN-ORIGINAL', items: [{ materialCode: 'BRG-1', receivedQty: 20 }] }
]);
save('qualityChecks', [
  ...read('qualityChecks'),
  { qcNumber: 'QC-ORIGINAL', poNumber: replacementPO.reference, receiptNumber: 'REC-ORIGINAL', postedToInventory: true,
    items: [{ materialCode: 'BRG-1', receivedQty: 216, acceptedQty: 196, rejectedQty: 20 }] },
  { qcNumber: 'QC-REPLACEMENT', receiptNumber: 'RR-REPLACEMENT', postedToInventory: false,
    items: [{ materialCode: 'BRG-1', receivedQty: 20, acceptedQty: 20, rejectedQty: 0 }] }
]);
save('rejectionReports', [{ rejectionNumber: 'RRN-ORIGINAL', poNumber: replacementPO.reference, qcNumber: 'QC-ORIGINAL',
  items: [{ materialCode: 'BRG-1', rejectedQty: 20, replacementQty: 20, pendingReplacementQty: 0 }] }]);
const replacementProgress = workflow.getPOProgress(replacementPO.reference);
assert.equal(replacementProgress.originalAccepted, 196);
assert.equal(replacementProgress.replacementAccepted, 20);
assert.equal(replacementProgress.finalAccepted, 216);
assert.equal(replacementProgress.qcPending, 0);
assert.equal(replacementProgress.openRejected, 0);
assert.equal(replacementProgress.pendingReplacement, 0);
assert.equal(replacementProgress.pending, 0);
assert.equal(replacementProgress.closureReady, false, 'physical status stays separate while accepted replacement awaits inventory posting');
assert.equal(replacementProgress.status, workflow.PO_STATUS.FULL);
assert.equal(replacementProgress.fulfillmentStatus, workflow.PO_STATUS.FULL);
assert.equal(reports.getPurchaseReportOrders().find((row) => row.poNumber === replacementPO.reference).status, workflow.PO_STATUS.FULL);

const underAcceptedPO = {
  reference: 'PO-UNDER-ACCEPTED', status: 'Partially Received',
  payload: { poDetails: { poNumber: 'PO-UNDER-ACCEPTED' },
    items: [{ itemCode: 'BRG-2', itemName: 'Bearing 2', quantity: 216 }] }
};
save('supplierPOHistory', [po, replacementPO, underAcceptedPO]);
save('materialReceipts', [
  ...read('materialReceipts'),
  { receiptNumber: 'REC-UNDER', poNumber: underAcceptedPO.reference, items: [{ materialCode: 'BRG-2', receivedQty: 196 }] },
  { receiptNumber: 'RR-UNDER', poNumber: underAcceptedPO.reference, isReplacement: true, rejectionNumber: 'RRN-UNDER',
    items: [{ materialCode: 'BRG-2', receivedQty: 20 }] }
]);
save('qualityChecks', [
  ...read('qualityChecks'),
  { qcNumber: 'QC-UNDER', poNumber: underAcceptedPO.reference, receiptNumber: 'REC-UNDER', postedToInventory: true,
    items: [{ materialCode: 'BRG-2', receivedQty: 196, acceptedQty: 176, rejectedQty: 20 }] },
  { qcNumber: 'QC-UNDER-REPLACEMENT', poNumber: underAcceptedPO.reference, receiptNumber: 'RR-UNDER', postedToInventory: true,
    items: [{ materialCode: 'BRG-2', receivedQty: 20, acceptedQty: 20, rejectedQty: 0 }] }
]);
save('rejectionReports', [...read('rejectionReports'), { rejectionNumber: 'RRN-UNDER', poNumber: underAcceptedPO.reference,
  qcNumber: 'QC-UNDER', items: [{ materialCode: 'BRG-2', rejectedQty: 20, replacementQty: 20, pendingReplacementQty: 0 }] }]);
const underAcceptedProgress = workflow.getPOProgress(underAcceptedPO.reference);
assert.equal(underAcceptedProgress.pending, 20, 'replacement receipt does not reduce original ordered delivery balance');
assert.equal(underAcceptedProgress.finalAccepted, 196, 'rejected original units are not accepted a second time');
assert.equal(underAcceptedProgress.openRejected, 0);
assert.equal(underAcceptedProgress.receiptComplete, false, 'zero balance does not complete fulfillment when accepted quantity is short');
assert.equal(underAcceptedProgress.status, workflow.PO_STATUS.PARTIAL);
assert.equal(underAcceptedProgress.totalAccepted, 196);
assert.equal(underAcceptedProgress.physicalReceiptBalance, 20);
assert.equal(underAcceptedProgress.acceptedQuantityShortage, 20);
assert.equal(underAcceptedProgress.lines[0].physicalReceiptBalance, 20);
assert.equal(underAcceptedProgress.lines[0].acceptedQuantityShortage, 20);
assert.equal(underAcceptedProgress.lines[0].totalAcceptedQty, 196);

// Material-line regression matching the saved PO-000004 ledger: both rejected
// lines receive one accepted replacement, but replacement quantity never
// converts rejected original units into accepted quantity.
const lineAuditPO = {
  reference: 'PO-LINE-AUDIT', status: 'Partially Received',
  payload: { poDetails: { poNumber: 'PO-LINE-AUDIT' }, items: [
    { itemName: 'Welding Electrode E7018 4mm', quantity: 20 },
    { itemName: 'MS Angle 40x40x5', quantity: 10 },
    { itemName: 'Shaft Collar 1/2in SS', quantity: 86 },
    { itemName: 'Proximity Sensor M18 PNP', quantity: 100 }
  ] }
};
save('supplierPOHistory', [po, replacementPO, underAcceptedPO, lineAuditPO]);
save('materialReceipts', [...read('materialReceipts'),
  { receiptNumber: 'REC-LINE-AUDIT', poNumber: lineAuditPO.reference, items: [
    { materialName: 'Welding Electrode E7018 4mm', receivedQty: 20 },
    { materialName: 'MS Angle 40x40x5', receivedQty: 10 },
    { materialName: 'Shaft Collar 1/2in SS', receivedQty: 76 },
    { materialName: 'Proximity Sensor M18 PNP', receivedQty: 90 }
  ] },
  { receiptNumber: 'RR-LINE-AUDIT', poNumber: lineAuditPO.reference, isReplacement: true, rejectionNumber: 'RRN-LINE-AUDIT', items: [
    { materialName: 'Shaft Collar 1/2in SS', receivedQty: 10 },
    { materialName: 'Proximity Sensor M18 PNP', receivedQty: 10 }
  ] }
]);
save('qualityChecks', [...read('qualityChecks'),
  { qcNumber: 'QC-LINE-AUDIT', poNumber: lineAuditPO.reference, receiptNumber: 'REC-LINE-AUDIT', items: [
    { materialName: 'Welding Electrode E7018 4mm', receivedQty: 20, acceptedQty: 20, rejectedQty: 0 },
    { materialName: 'MS Angle 40x40x5', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 },
    { materialName: 'Shaft Collar 1/2in SS', receivedQty: 76, acceptedQty: 66, rejectedQty: 10 },
    { materialName: 'Proximity Sensor M18 PNP', receivedQty: 90, acceptedQty: 80, rejectedQty: 10 }
  ] },
  { qcNumber: 'QC-LINE-AUDIT-REPL', poNumber: lineAuditPO.reference, receiptNumber: 'RR-LINE-AUDIT', items: [
    { materialName: 'Shaft Collar 1/2in SS', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 },
    { materialName: 'Proximity Sensor M18 PNP', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }
  ] }
]);
save('rejectionReports', [...read('rejectionReports'), { rejectionNumber: 'RRN-LINE-AUDIT', poNumber: lineAuditPO.reference,
  qcNumber: 'QC-LINE-AUDIT', items: [
    { materialName: 'Shaft Collar 1/2in SS', rejectedQty: 10, replacementQty: 10 },
    { materialName: 'Proximity Sensor M18 PNP', rejectedQty: 10, replacementQty: 10 }
  ] }]);
const lineAudit = workflow.getPOProgress(lineAuditPO.reference);
assert.equal(lineAudit.ordered, 216);
assert.equal(lineAudit.originalArrived, 196);
assert.equal(lineAudit.originalAccepted, 176);
assert.equal(lineAudit.rejected, 20);
assert.equal(lineAudit.replacementArrived, 20);
assert.equal(lineAudit.replacementAccepted, 20);
assert.equal(lineAudit.totalAccepted, 196);
assert.equal(lineAudit.physicalReceiptBalance, 20);
assert.equal(lineAudit.acceptedQuantityShortage, 20);
assert.equal(lineAudit.qcPending, 0);
assert.deepEqual(lineAudit.lines.map((line) => [line.materialName, line.acceptedQuantityShortage]), [
  ['Welding Electrode E7018 4mm', 0], ['MS Angle 40x40x5', 0],
  ['Shaft Collar 1/2in SS', 10], ['Proximity Sensor M18 PNP', 10]
]);
assert.equal(lineAudit.status, workflow.PO_STATUS.PARTIAL);
const lineAuditReport = reports.getPurchaseReportOrders().find((row) => row.poNumber === lineAuditPO.reference);
assert.equal(lineAuditReport.status, workflow.PO_STATUS.PARTIAL);
assert.equal(lineAuditReport.physicalReceiptBalance, 20);
assert.equal(lineAuditReport.acceptedQuantityShortage, 20);
assert.equal(lineAuditReport.totalAccepted, 196);

loginAs('Purchase Department', 'purchase_employee', 'Buyer');
assert.throws(() => workflow.shortClosePurchaseOrder(po.reference, { reason: 'Vendor unable to supply', remarks: 'Capacity issue' }), /Permission denied/);
loginAs('Purchase Department', 'purchase_manager', 'Purchase Manager');
const closed = workflow.shortClosePurchaseOrder(po.reference, { reason: 'Vendor unable to supply', remarks: 'Vendor confirmed the balance cannot be supplied.' });
assert.equal(closed.payload.items[0].quantity, 10, 'short close preserves ordered quantity');
assert.equal(workflow.getPOProgress(po.reference).received, 5, 'short close preserves received quantity');
assert.equal(read('materialReceipts')[0].items.length, 2, 'receipt records remain unchanged');
assert.equal(closed.shortClose.shortClosedQty, 5);
assert.equal(closed.shortClose.approvedBy, 'Purchase Manager');
assert.equal(read('storeAuditLog').some((entry) => entry.action === 'PO SHORT-CLOSED' && entry.reference === po.reference), true);
const preClosed = reports.getPreClosedPurchaseOrderRows();
assert.equal(preClosed.length, 1);
assert.equal(preClosed[0].shortClosedQty, 5);
assert.equal(preClosed[0].closureReason, 'Vendor unable to supply');
assert.throws(() => workflow.shortClosePurchaseOrder(po.reference, { reason: 'Vendor unable to supply', remarks: 'Duplicate' }), /already been short-closed/);

console.log('Purchase report and short-close checks passed.');
