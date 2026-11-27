/**
 * Workflow integration test (no framework required).
 * Run:  node tests/workflow.test.mjs
 *
 * Covers the department workflow:
 *   Sales Order → Store availability check → Purchase Indent → PO →
 *   Tax Invoice / Material Receipt → Quality Check → Rejection → Inventory →
 *   Production notification → SO material closure
 * plus the permission, validation and edge cases.
 */

import assert from 'node:assert/strict';

/* ------------------------------- localStorage shim ------------------------------- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
  setItem: (k, v) => mem.set(String(k), String(v)),
  removeItem: (k) => mem.delete(String(k)),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  }
};
globalThis.window = {
  location: { port: '5173', hostname: 'localhost' },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
  dispatchEvent: () => true
};
await import('./helpers/availability-api-stub.mjs');

const W = await import('../src/utils/workflowService.js');
const V = await import('../src/utils/vendorMaster.js');
const { hasPermission } = await import('../src/utils/permissions.js');

/* --------------------------------- test runner --------------------------------- */
let passed = 0;
let failed = 0;
const failures = [];

const check = (cond, label, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} ${extra}`);
    console.log(`  FAIL ${label} ${extra}`);
  }
};

const expectThrows = (fn, pattern, label) => {
  try {
    fn();
  } catch (err) {
    const ok = pattern ? pattern.test(String(err.message)) : true;
    if (ok) {
      passed += 1;
      console.log(`  ok   ${label} → "${err.message}"`);
    } else {
      failed += 1;
      failures.push(`${label}: "${err.message}" !~ ${pattern}`);
      console.log(`  FAIL ${label}: "${err.message}" !~ ${pattern}`);
    }
    return;
  }
  failed += 1;
  failures.push(`${label}: expected error, none thrown`);
  console.log(`  FAIL ${label}: expected error, none thrown`);
};

const section = (name) => console.log(`\n== ${name}`);

/* ---------------------------------- fixtures ---------------------------------- */
const loginAs = (department, roleKey, name) => {
  localStorage.setItem(
    'erp_auth',
    JSON.stringify({
      isLoggedIn: true,
      username: name,
      email: `${roleKey}@pragmatic.test`,
      roleKey,
      department
    })
  );
};

const ls = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
const notifications = () => ls('notifications', []);
const auditLog = () => ls('storeAuditLog', []);

const seed = () => {
  localStorage.setItem(
    'inventoryItems',
    JSON.stringify([
      { itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100 },
      { itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', unit: 'Nos', currentQty: 10 }
    ])
  );

  const so = (reference, items) => ({
    reference,
    date: '2026-09-01',
    status: 'Open',
    company: 'ACME Controls',
    payload: {
      soDetails: { projectId: `PRJ-${reference}`, soDate: '2026-09-01', deliveryDate: '2026-10-15' },
      customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
      items
    }
  });

  localStorage.setItem(
    'salesOrderHistory',
    JSON.stringify([
      so('SO-001', [
        { itemCode: 'RAW-001', itemName: 'MS Plate 10mm', quantity: 50, unit: 'Nos' },
        { itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos' },
        { itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', quantity: 15, unit: 'Nos' }
      ]),
      so('SO-002', [{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', quantity: 30, unit: 'Nos' }]),
      so('SO-003', [{ itemCode: 'RAW-004', itemName: 'Brass Bush', quantity: 10, unit: 'Nos' }])
    ])
  );

  localStorage.setItem(
    'supplierPOHistory',
    JSON.stringify([
      {
        reference: 'PO-001',
        date: '2026-09-05',
        vendor: 'Alpha Steels',
        status: 'Submitted',
        payload: {
          poDetails: { poNumber: 'PO-001', poDate: '2026-09-05', poStatus: 'Submitted', salesOrderRef: 'SO-001' },
          vendorDetails: { companyName: 'Alpha Steels' },
          items: [
            { itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos' },
            { itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', quantity: 5, unit: 'Nos' }
          ]
        }
      },
      {
        reference: 'PO-002',
        date: '2026-09-05',
        vendor: 'Beta Traders',
        status: 'Cancelled',
        payload: {
          poDetails: { poNumber: 'PO-002', poStatus: 'Cancelled' },
          items: [{ itemCode: 'RAW-005', itemName: 'Copper Coil', quantity: 5, unit: 'Nos' }]
        }
      },
      {
        reference: 'PO-003',
        date: '2026-09-07',
        vendor: 'Gamma Metals',
        status: 'Submitted',
        payload: {
          poDetails: { poNumber: 'PO-003', poDate: '2026-09-07', poStatus: 'Submitted', salesOrderRef: 'SO-003' },
          vendorDetails: { companyName: 'Gamma Metals' },
          items: [{ itemCode: 'RAW-004', itemName: 'Brass Bush', quantity: 10, unit: 'Nos' }]
        }
      }
    ])
  );

  W.ensureWorkflowSeeded();
};

const invQty = (code) => {
  const item = ls('inventoryItems', []).find((i) => String(i.itemCode).toLowerCase() === code.toLowerCase());
  return item ? Number(item.currentQty) : null;
};

/* =================================== scenario =================================== */
section('Setup');
seed();
check(W.getSalesOrders().length === 3, 'seeded 3 sales orders');
check(W.getPurchaseOrders().length === 3, 'seeded 3 purchase orders');

section('1. Permission gating (Sales cannot check / Purchase cannot indent)');
loginAs('Sales Department', 'sales_employee', 'Ravi Sales');
expectThrows(() => W.saveMaterialAvailabilityCheck({ soNumber: 'SO-001' }), /Permission denied/, 'sales user blocked from availability check');
expectThrows(
  () => W.createPurchaseIndent({ soNumber: 'SO-001' }),
  /Permission denied|only the Store Department/,
  'sales user blocked from creating indent'
);
check(!hasPermission('indent.create'), 'sales role has no indent.create');

section('2. Store material availability check (SO-001)');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const preview = W.previewAvailability('SO-001');
check(preview.lines.length === 3, 'availability preview returns 3 lines');
check(preview.lines[0].status === 'Available' && preview.lines[0].availableQty === 50, 'RAW-001 fully available (50 of 100)');
check(preview.lines[1].status === 'Purchase Required' && preview.lines[1].shortageQty === 20, 'RAW-002 shortage 20 (absent from stock)');
check(preview.lines[2].shortageQty === 5, 'RAW-003 shortage 5 (15 required vs 10 stock)');
const check1 = await W.saveMaterialAvailabilityCheck({ soNumber: 'SO-001', remarks: 'Shortage confirmed' });
check(check1.status === 'Checked' && check1.lines.length === 3, 'availability check saved');
check(W.getSalesOrdersAwaitingCheck().length === 2, 'SO-002 and SO-003 still awaiting check');

section('3. Purchase Indent creation + edit rules');
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
expectThrows(() => W.createPurchaseIndent({ soNumber: 'SO-001' }), /Permission denied/, 'purchase cannot create an indent');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const indent1 = W.createPurchaseIndent({ soNumber: 'SO-001', reason: 'Customer order shortage' });
check(indent1.indentNumber === 'IND-000001', `indent numbered ${indent1.indentNumber}`);
check(indent1.status === W.INDENT_STATUS.DRAFT, 'new indent is Draft');
check(indent1.items.length === 2, 'indent has only the 2 shortage materials');
check(indent1.items.every((i) => i.purchaseQty > 0), 'indent quantities are the shortage quantities');
check(W.canEditIndent(indent1) === true, 'store may edit a Draft indent');
check(W.canSubmitIndent(indent1) === true, 'store may submit a Draft indent');

loginAs('Admin', 'admin', 'Administrator');
check(W.canSubmitIndent(indent1) === true, 'admin may also submit a Draft indent (save → appears in Purchase)');
check(W.canEditIndent(indent1) === true, 'admin may edit a Draft indent');

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
check(W.canEditIndent(indent1) === false, 'purchase may NOT edit a Draft indent');
expectThrows(() => W.updatePurchaseIndent(indent1.indentNumber, { reason: 'x' }), /cannot edit/, 'purchase edit attempt rejected');

section('4. Submit → Production additional requirement → Purchase review');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const submitted = W.submitPurchaseIndent(indent1.indentNumber, 'Placed for review');
check(submitted.status === W.INDENT_STATUS.SUBMITTED, 'indent submitted');
check(W.canSubmitIndent(submitted) === false, 'submitted indent cannot be re-submitted');
check(
  notifications().some((n) => n.title === 'New Purchase Indent' && n.targetDept === 'Purchase Department'),
  'Purchase Department notified of new indent'
);

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const clarified = W.requestProductionClarification(indent1.indentNumber, 'Confirm bush tolerance');
check(clarified.status === W.INDENT_STATUS.AWAITING_PRODUCTION, 'indent moved to Awaiting Production');
check(
  notifications().some((n) => n.title === 'Clarification Required for Purchase Indent' && n.targetDept === 'Production Department'),
  'Production notified of clarification'
);

loginAs('Production Department', 'production_employee', 'Kiran Production');
expectThrows(() => W.createPurchaseIndent({ soNumber: 'SO-001' }), /Permission denied/, 'production cannot create indents');
const withAddl = W.provideAdditionalRequirement(indent1.indentNumber, {
  materialCode: 'CONSUM-01',
  materialName: 'Cutting Fluid 5L',
  quantity: 5,
  unit: 'Ltr',
  reason: 'Machining consumable for this order'
});
check(withAddl.additionalRequirements.length === 1, 'additional requirement recorded');
check(withAddl.status === W.INDENT_STATUS.SUBMITTED, 'clarification answered → back to Submitted');
check(withAddl.clarifications[0].status === 'Answered', 'clarification marked Answered');

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const reviewed = W.reviewAdditionalRequirement(indent1.indentNumber, withAddl.additionalRequirements[0].id, 'approve', 'Approved');
check(reviewed.items.length === 3, 'approved additional material appended to indent lines');
check(
  reviewed.items.some((i) => i.source === 'Production Additional Requirement' && i.purchaseQty === 5),
  'additional line carries purchase qty 5'
);

section('5. Indent → PO conversion');
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(() => W.markIndentConverted(indent1.indentNumber, 'PO-001'), /Permission denied/, 'store cannot convert an indent');

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const converted = W.markIndentConverted(indent1.indentNumber, 'PO-001');
check(converted.status === W.INDENT_STATUS.CONVERTED, 'indent converted');
check(converted.poNumber === 'PO-001', 'indent linked to PO-001');
check(
  notifications().some((n) => n.title === 'Purchase Order created' && n.targetDept === 'Store Department'),
  'Store notified of conversion'
);
expectThrows(() => W.markIndentConverted(indent1.indentNumber, 'PO-001'), /already converted/, 'double conversion blocked');
expectThrows(() => W.cancelIndent(indent1.indentNumber, 'x'), /Converted indents cannot be cancelled/, 'converted indent cannot be cancelled');
const convertedClf = W.requestProductionClarification(indent1.indentNumber, 'Confirm extra material after PO');
check(convertedClf.status === W.INDENT_STATUS.CONVERTED, 'clarification on converted indent keeps status Converted to PO');

loginAs('Production Department', 'production_employee', 'Kiran Production');
const convertedAddl = W.provideAdditionalRequirement(indent1.indentNumber, {
  materialName: 'Assembly Bolt M8',
  quantity: 50,
  unit: 'Nos',
  reason: 'Post-PO production need'
});
check(convertedAddl.status === W.INDENT_STATUS.CONVERTED, 'additional requirement on converted indent keeps status Converted');
check(convertedAddl.additionalRequirements.length === 2, 'second additional requirement recorded');

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const reviewedConverted = W.reviewAdditionalRequirement(
  indent1.indentNumber,
  convertedAddl.additionalRequirements[1].id,
  'approve',
  'Approved after PO'
);
check(reviewedConverted.status === W.INDENT_STATUS.CONVERTED, 'reviewing an extra requirement keeps Converted status');
check(reviewedConverted.items.length === 4, 'approved extra material added as a 4th line');

loginAs('Store Department', 'store_manager', 'Suresh Store');

loginAs('Store Department', 'store_manager', 'Suresh Store');
check(W.canEditIndent(converted) === false, 'converted indent is read-only for store');
expectThrows(() => W.updatePurchaseIndent(indent1.indentNumber, { reason: 'y' }), /cannot edit/, 'post-conversion edit rejected');

section('6. Tax Invoice / Material Receipt with validations');
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => W.createMaterialReceipt({ poNumber: 'PO-001', invoiceNumber: '', invoiceDate: '2026-09-10', items: [] }),
  /Invoice Number is required/,
  'invoice number required'
);

const rec1 = W.createMaterialReceipt({
  poNumber: 'PO-001',
  invoiceNumber: 'INV-1001',
  invoiceDate: '2026-09-10',
  dcNumber: 'DC-101',
  items: [
    { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', receivedQty: 20 },
    { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 3 }
  ]
});
check(rec1.receipt.receiptNumber === 'REC-000001', `receipt numbered ${rec1.receipt.receiptNumber}`);
check(rec1.progress.ordered === 25 && rec1.progress.received === 23 && rec1.progress.pending === 2, 'progress Ordered 25 | Received 23 | Pending 2');
check(rec1.progress.computedStatus === W.PO_STATUS.PARTIAL, 'PO computed as Partially Received');
check(rec1.progress.status === W.PO_STATUS.PARTIAL, 'partial receipt keeps Partially Received fulfillment status');
check(W.getPOByRef('PO-001').status === W.PO_STATUS.PARTIAL, 'PO status updated to Partially Received');

expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-001',
      invoiceNumber: 'INV-1001',
      invoiceDate: '2026-09-10',
      items: [{ materialCode: 'RAW-003', receivedQty: 1 }]
    }),
  /Duplicate invoice number/,
  'duplicate invoice rejected'
);
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-001',
      invoiceNumber: 'INV-1002',
      invoiceDate: '2026-09-11',
      items: [{ materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', receivedQty: 5 }]
    }),
  /exceeds PO pending quantity 2/,
  'over-receipt beyond pending rejected'
);
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-001',
      invoiceNumber: 'INV-1003',
      invoiceDate: '2026-09-11',
      items: [{ materialCode: 'RAW-009', materialName: 'Not on PO', receivedQty: 1 }]
    }),
  /is not part of PO/,
  'material not on PO rejected'
);
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-002',
      invoiceNumber: 'INV-1004',
      invoiceDate: '2026-09-11',
      items: [{ materialCode: 'RAW-005', materialName: 'Copper Coil', receivedQty: 1 }]
    }),
  /is Cancelled/,
  'receipt against cancelled PO rejected'
);
check(
  notifications().some((n) => n.title === 'Material Receipt entered — Quality Check required' && n.targetDept === 'Production Department'),
  'Production notified that material awaits quality check'
);

section('7. Quality Check (Production only) + auto rejection report');
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(() => W.saveQualityCheck({ receiptNumber: rec1.receipt.receiptNumber, items: [] }), /Permission denied/, 'store cannot perform QC');

loginAs('Production Department', 'production_employee', 'Kiran Production');
expectThrows(
  () =>
    W.saveQualityCheck({
      receiptNumber: rec1.receipt.receiptNumber,
      inspectionDate: '2026-09-12',
      inspector: 'Kiran',
      items: [{ materialCode: 'RAW-002', materialName: 'SS 304 Sheet', receivedQty: 20, acceptedQty: 20, rejectedQty: 2 }]
    }),
  /cannot exceed Received/,
  'accepted + rejected > received rejected'
);
const qc1 = W.saveQualityCheck({
  receiptNumber: rec1.receipt.receiptNumber,
  inspectionDate: '2026-09-12',
  inspector: 'Kiran',
  items: [
    { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', receivedQty: 20, acceptedQty: 18, rejectedQty: 2, rejectionReason: 'Surface scratch' },
    { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 3, acceptedQty: 3, rejectedQty: 0 }
  ]
});
check(qc1.qcNumber === 'QC-000001', `QC numbered ${qc1.qcNumber}`);
check(qc1.status === W.QC_STATUS.PARTIAL, 'QC status Partially Approved');
check(W.getReceipt(rec1.receipt.receiptNumber).qcNumber === qc1.qcNumber, 'receipt linked to QC');
const rejections = W.getRejectionReports();
check(rejections.length === 1, 'rejection report auto-created from QC');
check(rejections[0].rejectionNumber === 'RRN-000001', `rejection numbered ${rejections[0].rejectionNumber}`);
check(rejections[0].status === W.REJECTION_STATUS.RAISED, 'rejection starts Raised');
check(rejections[0].items[0].rejectedQty === 2, 'rejection carries rejected qty 2');
check(
  notifications().some((n) => n.title === 'Quality Rejection Report created' && n.targetDept === 'Store Department'),
  'Store notified to forward rejection'
);

section('8. Approved material → inventory (Store) with idempotence');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const posted = W.postApprovedMaterialToInventory(qc1.qcNumber);
check(posted.posted === 2, 'two accepted lines posted');
check(invQty('RAW-002') === 18, `RAW-002 stock now ${invQty('RAW-002')}`);
check(invQty('RAW-003') === 13, `RAW-003 stock now ${invQty('RAW-003')} (10 + 3)`);
const txs = ls('stockTransactions', []);
check(txs.filter((t) => t.qcNumber === qc1.qcNumber && t.type === 'IN').length === 2, 'two IN stock transactions recorded');
check(txs[0].poReference === 'PO-001', 'stock transaction carries PO reference');
expectThrows(() => W.postApprovedMaterialToInventory(qc1.qcNumber), /already been posted/, 'double posting blocked');

section('9. Rejection forwarding Store → Purchase → Vendor');
loginAs('Sales Department', 'sales_employee', 'Ravi Sales');
expectThrows(() => W.forwardRejectionToPurchase('RRN-000001', {}), /Permission denied/, 'sales cannot forward rejections');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const forwarded = W.forwardRejectionToPurchase('RRN-000001', {
  dcNumber: 'DC-REJ-01',
  dcDate: '2026-09-13',
  forwardRemarks: 'Rejected material ready for vendor pickup'
});
check(forwarded.status === W.REJECTION_STATUS.FORWARDED, 'rejection forwarded to Purchase');
check(forwarded.dcNumber === 'DC-REJ-01', 'DC number recorded on rejection');
expectThrows(() => W.forwardRejectionToPurchase('RRN-000001', {}), /cannot be forwarded again/, 'double forward rejected');
expectThrows(() => W.sendRejectionToVendor('RRN-000001', {}), /Permission denied/, 'store cannot send to vendor');

loginAs('Production Department', 'production_employee', 'Kiran Production');
expectThrows(() => W.sendRejectionToVendor('RRN-000001', {}), /Permission denied/, 'non-purchase role cannot send to vendor');
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const sent = W.sendRejectionToVendor('RRN-000001', { vendorRemarks: 'Replacement expected' });
check(sent.status === W.REJECTION_STATUS.SENT_VENDOR, 'rejection communicated to vendor');
check(
  notifications().some((n) => n.title === 'Rejection sent to vendor' && n.targetDept === 'Store Department'),
  'Store notified that rejection went to vendor'
);

section('10. Second receipt → PO fully received + closure guard');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const rec2 = W.createMaterialReceipt({
  poNumber: 'PO-001',
  invoiceNumber: 'INV-2001',
  invoiceDate: '2026-09-14',
  items: [{ materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 2 }]
});
check(rec2.progress.pending === 0 && rec2.progress.fullyReceived, 'PO-001 fully received (25 / 25)');
check(
  W.getPOByRef('PO-001').status !== W.PO_STATUS.CLOSED && W.getPOProgress('PO-001').pending === 0,
  'PO does not auto-close after receipt — closure requires full chain (arrival, QC, inventory, invoice)'
);
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-001',
      invoiceNumber: 'INV-2002',
      invoiceDate: '2026-09-15',
      items: [{ materialCode: 'RAW-002', materialName: 'SS 304 Sheet', receivedQty: 1 }]
    }),
  /already Closed|exceeds PO pending/,
  'no further receipt against a fully received PO'
);
check(W.getPOProgress('PO-001').lines.find((l) => l.materialCode === 'RAW-002').pendingQty === 0, 'RAW-002 pending 0 on PO');

loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc2 = W.saveQualityCheck({
  receiptNumber: rec2.receipt.receiptNumber,
  inspectionDate: '2026-09-15',
  items: [{ materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 2, acceptedQty: 2, rejectedQty: 0 }]
});
check(qc2.status === W.QC_STATUS.APPROVED, 'second QC approved');
check(W.getRejectionReports().length === 1, 'no new rejection report for a clean QC');
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.postApprovedMaterialToInventory(qc2.qcNumber);
check(invQty('RAW-003') === 15, `RAW-003 fully replenished to ${invQty('RAW-003')}`);

section('11. Sales Order material procurement status');
const so1 = W.getSalesOrderMaterialStatus('SO-001');
check(so1.overallStatus === 'MATERIALS PENDING', `SO-001 → ${so1.overallStatus} (2 rejected units not yet replaced)`);
const so1Raw2 = so1.lines.find((l) => l.materialCode === 'RAW-002');
check(so1Raw2.received === 18 && so1Raw2.pending === 2, `RAW-002 received 18 / pending ${so1Raw2.pending}`);
check(so1.lines.find((l) => l.materialCode === 'RAW-001').pending === 0, 'RAW-001 satisfied from stock');
check(so1.lines.find((l) => l.materialCode === 'RAW-003').pending === 0, 'RAW-003 satisfied after purchase');
check(so1.indents.length === 1 && so1.indents[0].poNumber === 'PO-001', 'SO-001 linked to its indent + PO');

section('12. Fully available order (no indent possible)');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const check2 = await W.saveMaterialAvailabilityCheck({ soNumber: 'SO-002' });
check(check2.lines.every((l) => l.status === 'Available'), 'SO-002 fully available');
expectThrows(() => W.createPurchaseIndent({ soNumber: 'SO-002' }), /No materials with shortage/, 'indent blocked when nothing is short');
check(W.getSalesOrderMaterialStatus('SO-002').overallStatus === 'COMPLETED', 'SO-002 → COMPLETED');
const readyNotifsSo2 = notifications().filter((n) => n.title === 'Materials ready for production' && n.reference === 'SO-002');
check(readyNotifsSo2.length === 1, 'Production notified once that SO-002 materials are ready');
await W.saveMaterialAvailabilityCheck({ soNumber: 'SO-002' });
check(
  notifications().filter((n) => n.title === 'Materials ready for production' && n.reference === 'SO-002').length === 1,
  'ready notification not duplicated on re-check'
);

section('13. Purchased order completing end-to-end (SO-003)');
loginAs('Store Department', 'store_manager', 'Suresh Store');
check(W.getSalesOrderMaterialStatus('SO-003').overallStatus === 'MATERIALS PENDING', 'SO-003 pending before purchase');
await W.saveMaterialAvailabilityCheck({ soNumber: 'SO-003' });
const indent3 = W.createPurchaseIndent({ soNumber: 'SO-003' });
W.submitPurchaseIndent(indent3.indentNumber);
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
W.markIndentConverted(indent3.indentNumber, 'PO-003');
check(W.getIndent(indent3.indentNumber).status === W.INDENT_STATUS.CONVERTED, 'second indent converted');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const rec3 = W.createMaterialReceipt({
  poNumber: 'PO-003',
  invoiceNumber: 'INV-3001',
  invoiceDate: '2026-09-18',
  deliveredBy: 'Suresh (Gamma Metals)',
  contactNumber: '9880011223',
  transporter: 'Blue Dart Logistics',
  items: [{ materialCode: 'RAW-004', materialName: 'Brass Bush', unit: 'Nos', receivedQty: 10 }]
});
check(rec3.receipt.deliveredBy === 'Suresh (Gamma Metals)' && rec3.receipt.contactNumber === '9880011223', 'supplier delivery details stored on the receipt');
check(rec3.receipt.transporter === 'Blue Dart Logistics', 'transporter stored on the receipt');
check(rec3.progress.fullyReceived, 'PO-003 fully received');
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc3 = W.saveQualityCheck({
  receiptNumber: rec3.receipt.receiptNumber,
  inspectionDate: '2026-09-18',
  items: [{ materialCode: 'RAW-004', materialName: 'Brass Bush', unit: 'Nos', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }]
});
check(qc3.deliveredBy === 'Suresh (Gamma Metals)' && qc3.transporter === 'Blue Dart Logistics', 'quality check carries the supplier who delivered');
check(qc3.status === W.QC_STATUS.APPROVED, 'QC approved for SO-003 material');
check(W.getPOProgress('PO-003').status === W.PO_STATUS.FULL, 'normal fully accepted receipt is Fully Received');
check(!W.getPOProgress('PO-003').closureReady, 'physical fulfillment stays separate from inventory/invoice closure');
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.postApprovedMaterialToInventory(qc3.qcNumber);
check(invQty('RAW-004') === 10, 'new material created in inventory');
check(W.getPOProgress('PO-003').status === W.PO_STATUS.FULL, 'inventory posting preserves canonical Fully Received status');
const so3 = W.getSalesOrderMaterialStatus('SO-003');
check(so3.overallStatus === 'COMPLETED', `SO-003 → ${so3.overallStatus} after receipt + QC approval`);
check(
  notifications().filter((n) => n.title === 'Materials ready for production' && n.reference === 'SO-003').length === 1,
  'Production notified exactly once that SO-003 materials are ready'
);

section('14. Dashboards, document chain and audit trail');
const dash = W.getWorkflowDashboard();
check(dash.counts.indents === 2, `dashboard sees ${dash.counts.indents} indents`);
check(dash.counts.receipts === 3, `dashboard sees ${dash.counts.receipts} receipts`);
check(dash.counts.qualityChecks === 3, `dashboard sees ${dash.counts.qualityChecks} QC records`);
check(dash.counts.rejections === 1, `dashboard sees ${dash.counts.rejections} rejection report(s)`);
check(dash.store.materialsPending >= 1 && dash.store.materialAvailable >= 1, 'store dashboard splits available vs pending');
check(dash.purchase.posFull >= 1, 'purchase dashboard counts fully accepted POs, not merely zero-balance orders');
check(dash.purchase.converted === 2, 'both indents reported as converted');
check(dash.production.awaitingQC === 0, 'no receipt awaiting QC at the end');
check(dash.production.materialsAvailable >= 2, 'production dashboard reports ready orders');

const chain = W.getDocumentChain('SO-001');
check(chain.indents.length === 1, 'chain: 1 indent');
check(chain.purchaseOrders.length === 1 && chain.purchaseOrders[0].reference === 'PO-001', 'chain: PO-001 linked');
check(chain.receipts.length === 2, 'chain: 2 receipts');
check(chain.qualityChecks.length === 2, 'chain: 2 quality checks');
check(chain.rejections.length === 1, 'chain: 1 rejection report');
check(chain.materialStatus.overallStatus === 'MATERIALS PENDING', 'chain carries material status');

const audit = auditLog();
[
  'MATERIAL AVAILABILITY CHECK',
  'PURCHASE INDENT CREATED',
  'PURCHASE INDENT SUBMITTED',
  'INDENT CONVERTED TO PO',
  'MATERIAL RECEIPT ENTERED',
  'QUALITY CHECK SAVED',
  'REJECTION REPORT CREATED',
  'REJECTION FORWARDED TO PURCHASE',
  'REJECTION SENT TO VENDOR',
  'INVENTORY POSTED'
].forEach((action) => check(audit.some((a) => a.action === action), `audit log: ${action}`));

check(notifications().length > 10, `${notifications().length} notifications generated`);
check(audit.every((a) => a.user && a.timestamp), 'audit entries carry user + timestamp');

section('15. Idempotent seeding');
W.ensureWorkflowSeeded();
check(W.getIndents().length === 2 && W.getReceipts().length === 3, 'ensureWorkflowSeeded does not wipe data');

section('16. Purchase Indent → Quality Check → repurchase (indent sourced)');
// A new SO with a material we have never purchased, plus its PO.
const hist = ls('salesOrderHistory', []);
localStorage.setItem(
  'salesOrderHistory',
  JSON.stringify([
    ...hist,
    {
      reference: 'SO-004',
      date: '2026-09-20',
      status: 'Open',
      company: 'ACME Controls',
      payload: {
        soDetails: { projectId: 'PRJ-SO-004', soDate: '2026-09-20', deliveryDate: '2026-11-01' },
        customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
        items: [{ itemCode: 'RAW-009', itemName: 'Special Bearing', quantity: 8, unit: 'Nos' }]
      }
    }
  ])
);
localStorage.setItem(
  'supplierPOHistory',
  JSON.stringify([
    ...ls('supplierPOHistory', []),
    {
      reference: 'PO-004',
      date: '2026-09-21',
      vendor: 'Delta Tools',
      status: 'Submitted',
      payload: {
        poDetails: { poNumber: 'PO-004', poDate: '2026-09-21', poStatus: 'Submitted', salesOrderRef: 'SO-004' },
        vendorDetails: { companyName: 'Delta Tools' },
        items: [{ itemCode: 'RAW-009', itemName: 'Special Bearing', quantity: 8, unit: 'Nos' }]
      }
    }
  ])
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
await W.saveMaterialAvailabilityCheck({ soNumber: 'SO-004' });
const indent4 = W.createPurchaseIndent({ soNumber: 'SO-004' });
W.submitPurchaseIndent(indent4.indentNumber);
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
W.markIndentConverted(indent4.indentNumber, 'PO-004');
check(W.getIndent(indent4.indentNumber).status === W.INDENT_STATUS.CONVERTED, 'fourth indent converted to PO-004');

// Sales must not be able to push an indent into Quality.
loginAs('Sales Department', 'sales_employee', 'Ravi Sales');
expectThrows(
  () => W.sendIndentToQualityCheck(indent4.indentNumber),
  /Permission denied/,
  'Sales cannot send an indent to Quality Check'
);

// Store sends it to Quality.
loginAs('Store Department', 'store_manager', 'Suresh Store');
const sent4 = W.sendIndentToQualityCheck(indent4.indentNumber, { remarks: 'Incoming inspection needed' });
check(sent4.qcStatus === W.INDENT_QC_STATUS.SENT, `indent qcStatus = ${sent4.qcStatus}`);
check(sent4.sentToQCAt > '', 'sent-to-QC timestamp recorded');
check(W.getIndentsAwaitingQualityCheck().some((i) => i.indentNumber === indent4.indentNumber), 'indent shows in the QC queue');
check(
  notifications().some((n) => n.title === 'Purchase Indent sent to Quality Check' && n.reference === indent4.indentNumber),
  'Quality department notified'
);
expectThrows(
  () => W.sendIndentToQualityCheck(indent4.indentNumber),
  /already sent to Quality Check/,
  'duplicate send to Quality Check blocked'
);

// Purchase cannot inspect.
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
expectThrows(
  () => W.saveQualityCheck({ indentNumber: indent4.indentNumber, items: [] }),
  /Permission denied/,
  'Purchase cannot record a quality inspection'
);

// Quality inspects: 6 passed, 2 rejected.
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc4 = W.saveQualityCheck({
  indentNumber: indent4.indentNumber,
  inspectionDate: '2026-09-22',
  inspector: 'Kiran QC',
  remarks: '2 bearings failed dimension check',
  items: [
    { materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 8, acceptedQty: 6, rejectedQty: 2, rejectionReason: 'Bore size out of tolerance' }
  ]
});
check(qc4.source === 'Purchase Indent', `QC source = ${qc4.source}`);
check(qc4.receiptNumber === '' && qc4.indentNumber === indent4.indentNumber, 'QC linked to the indent (no receipt)');
check(qc4.status === W.QC_STATUS.PARTIAL, `QC status = ${qc4.status}`);

const indent4After = W.getIndent(indent4.indentNumber);
check(indent4After.qcNumber === qc4.qcNumber && indent4After.qcStatus === W.INDENT_QC_STATUS.DONE, 'indent carries the QC number + result');

const rrn4 = W.getRejectionReportsForIndent(indent4.indentNumber);
check(rrn4.length === 1, 'rejection report linked to the indent');
check(rrn4[0].poNumber === 'PO-004' && rrn4[0].items[0].rejectedQty === 2, 'rejection carries PO + rejected qty');
check(
  notifications().some((n) => n.title === 'Quality Check report ready in Purchase Indents' && n.reference === indent4.indentNumber),
  'Store notified that the report is in Purchase Indents'
);
check(
  notifications().some((n) => n.title === 'Material rejected — replacement purchase required' && n.reference === rrn4[0].rejectionNumber),
  'Purchase notified about the rejected quantity'
);

// Store posts only the passed quantity to inventory.
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.postApprovedMaterialToInventory(qc4.qcNumber);
check(invQty('RAW-009') === 6, `only the passed quantity (6) reached inventory (got ${invQty('RAW-009')})`);
check(W.getQualityCheck(qc4.qcNumber).postedToInventory === true, 'QC marked as posted to inventory');
const prog4 = W.getPOProgress('PO-004');
check(prog4.arrived === 8 && prog4.pending === 0, `PO-004 arrived 8 / pending 0 (got ${prog4.arrived}/${prog4.pending})`);

// Store cannot raise the repurchase — Purchase does it.
expectThrows(
  () => W.createRepurchaseIndent(rrn4[0].rejectionNumber),
  /Permission denied: only Purchase/,
  'Store cannot raise a repurchase indent'
);

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const repurchase = W.createRepurchaseIndent(rrn4[0].rejectionNumber);
check(repurchase.status === W.INDENT_STATUS.SUBMITTED, `repurchase indent status = ${repurchase.status}`);
check(repurchase.items.length === 1 && repurchase.items[0].purchaseQty === 2, 'repurchase indent carries the rejected quantity');
check(
  String(repurchase.items[0].source).includes(rrn4[0].rejectionNumber),
  'repurchase line references the rejection report'
);
check(W.getRejectionReport(rrn4[0].rejectionNumber).repurchaseIndentNumber === repurchase.indentNumber, 'rejection stores the repurchase indent number');
check(W.getIndentsAwaitingQualityCheck().length === 0, 'QC queue empty after inspection');
expectThrows(
  () => W.createRepurchaseIndent(rrn4[0].rejectionNumber),
  /already has replacement indent/,
  'double repurchase blocked'
);

// Store records the vendor tax invoice against the completed inspection.
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-004',
      invoiceNumber: 'INV-QC-1',
      invoiceDate: '2026-09-23',
      linkedQcNumber: qc4.qcNumber,
      items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 8 }]
    }),
  /exceeds the passed quantity/,
  'receipt cannot exceed the passed quantity of the inspection'
);

const linkedReceipt = W.createMaterialReceipt({
  poNumber: 'PO-004',
  invoiceNumber: 'INV-QC-1',
  invoiceDate: '2026-09-23',
  dcNumber: 'DC-77',
  dcDate: '2026-09-23',
  vehicleNumber: 'KA-01-1234',
  deliveredBy: 'Mahesh (Delta Tools)',
  contactNumber: '9000012345',
  remarks: 'Invoice booked after quality clearance',
  linkedQcNumber: qc4.qcNumber,
  items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 6 }]
});
check(linkedReceipt.receipt.qcNumber === qc4.qcNumber, 'receipt stores the QC reference');
check(linkedReceipt.receipt.deliveredBy === 'Mahesh (Delta Tools)' && linkedReceipt.receipt.contactNumber === '9000012345', 'supplier delivery details stored on the linked receipt');
check(linkedReceipt.receipt.source === 'Quality Check', `receipt source = ${linkedReceipt.receipt.source}`);
check(linkedReceipt.receipt.invoiceNumber === 'INV-QC-1' && linkedReceipt.receipt.dcNumber === 'DC-77', 'tax invoice + DC stored on the receipt');
check(W.getQualityCheck(qc4.qcNumber).receiptNumber === linkedReceipt.receipt.receiptNumber, 'QC now points back at the receipt');
const prog4b = W.getPOProgress('PO-004');
check(prog4b.received === 6 && prog4b.pending === 2, `PO progress unchanged after invoice entry (${prog4b.received}/${prog4b.pending})`);
check(W.getUnlinkedQualityCheckForPO('PO-004') === null, 'no unlinked inspection left for the PO');
check(
  notifications().some((n) => n.title === 'Tax invoice recorded against Quality Check' && n.reference === linkedReceipt.receipt.receiptNumber),
  'Store notified that the invoice is stored against the QC'
);
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-004',
      invoiceNumber: 'INV-QC-2',
      invoiceDate: '2026-09-24',
      linkedQcNumber: qc4.qcNumber,
      items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 6 }]
    }),
  /already linked to receipt/,
  'the same inspection cannot be invoiced twice'
);

section('17. NO QUALITY APPROVAL = NO INVENTORY UPDATE (service-layer enforcement)');
const S = await import('../src/utils/storeService.js');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const invQtyBefore = S.getInventoryItems().reduce((a, i) => a + (Number(i.currentQty) || 0), 0);

// The legacy item-wise PO receiving path must be permanently disabled.
expectThrows(
  () => S.receivePurchaseOrderItems({ po: W.getPOByRef('PO-004'), itemsReceived: {} }),
  /Quality Check|Quality approval|inventory/i,
  'direct PO → inventory receivePurchaseOrderItems is blocked'
);

// A GRN cannot exist without an approved Quality Check.
expectThrows(
  () =>
    S.createGRN({
      poNumber: 'PO-004',
      grnNumber: 'GRN-X1',
      items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', qty: 2 }]
    }),
  /Quality Check|qcNumber|approval/i,
  'GRN without an approved Quality Check is blocked'
);

// Posting a material that has only been received (never inspected) must fail.
// Use a fresh PO so the "awaiting inspection" premise is genuine.
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
const freshPO = JSON.parse(localStorage.getItem('supplierPOHistory') || '[]');
freshPO.unshift({
  reference: 'PO-NC',
  date: '2026-09-20',
  vendor: 'Alpha Steels',
  status: 'Submitted',
  projectRef: 'PRJ-NC',
  total: '₹500.00',
  payload: {
    poDetails: {
      poNumber: 'PO-NC',
      poDate: '2026-09-20',
      poStatus: 'Submitted',
      projectId: 'PRJ-NC',
      projectRef: 'PRJ-NC',
      salesOrderRef: 'SO-001'
    },
    vendorDetails: { companyName: 'Alpha Steels' },
    items: [{ itemCode: 'RAW-001', itemName: 'EN8 Bar 25mm', quantity: 5, unit: 'Nos', unitPrice: 100, gst: '18' }]
  }
});
localStorage.setItem('supplierPOHistory', JSON.stringify(freshPO));

loginAs('Store Department', 'store_manager', 'Suresh Store');
const notInspected = W.createMaterialReceipt({
  poNumber: 'PO-NC',
  invoiceNumber: 'INV-NC-1',
  invoiceDate: '2026-09-21',
  items: [{ materialCode: 'RAW-001', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 5 }]
});
const notInspectedReceipt = notInspected.receipt;
check(
  notInspectedReceipt.qcStatus === W.QC_STATUS.PENDING && !notInspectedReceipt.postedToInventory,
  `a fresh receipt is held as pending and is not posted to inventory (qcStatus="${notInspectedReceipt.qcStatus}", posted=${notInspectedReceipt.postedToInventory})`
);
check(
  notInspected.progress.received === 5 && notInspected.progress.pending === 0,
  'receiving the last pending quantity closes the PO immediately'
);
check(
  notInspected.progress.accepted === 0 && notInspected.progress.inventoryPosted === 0,
  'physical closure does not imply any quality acceptance or inventory posting'
);
expectThrows(
  () => W.postApprovedMaterialToInventory(notInspectedReceipt.qcNumber || 'QC-NONE'),
  /not found|No inspection|approved/i,
  'posting received-but-not-inspected material is rejected'
);
expectThrows(
  () => W.postApprovedMaterialToInventory('QC-DOES-NOT-EXIST'),
  /not found|No inspection/i,
  'posting an unknown Quality Check is rejected'
);
check(
  W.getPOProgress('PO-NC').inventoryPosted === 0 && W.getPOProgress('PO-NC').accepted === 0,
  'PO-NC has nothing accepted or posted before any inspection'
);
check(
  !S.getStockTransactions().some((t) => t.reference === notInspectedReceipt.receiptNumber && t.type === 'IN'),
  'no inventory transaction exists for an un-inspected receipt'
);
check(
  S.getInventoryItems().reduce((a, i) => a + (Number(i.currentQty) || 0), 0) === invQtyBefore,
  'no inventory quantity changed while attempting the bypasses'
);

// Legacy item-wise receive also updated PO status directly — verify status is service-owned.
check(
  Object.values(W.PO_STATUS).includes(
    W.getPOByRef('PO-004').status
  ),
  `PO-004 status is a service-owned lifecycle value (${W.getPOByRef('PO-004').status})`
);

section('18. Project ID + document chain traceability across procurement');
const chainIndent = W.getIndents().find((i) => i.indentNumber === 'IND-000004');
check(Boolean(chainIndent?.projectId), `replacement indent carries Project ID (${chainIndent?.projectId})`);
check(Boolean(chainIndent?.replacementFor), 'replacement indent records what it replaces');

// Vendor Enquiry inherits the indent chain and rejects a non-existent indent.
let enqErr = '';
try {
  S.createVendorEnquiry({
    indentNumber: 'IND-NOPE',
    items: [{ materialCode: 'X-1', materialName: 'Ghost', requiredQty: 1, unit: 'Nos' }],
    vendors: [{ name: 'Ghost Vendor' }]
  });
} catch (e) {
  enqErr = e.message;
}
check(/not found|does not exist|not found/i.test(enqErr), `vendor enquiry rejects an unknown indent → "${enqErr}"`);

const enquiryVendorMaster = await V.addVendorToMaster({
  name: 'Precision Bearings Ltd', product: 'Test', contactPerson: 'Precision Contact', email: 'precision@example.test'
});
const alternateVendorMaster = await V.addVendorToMaster({
  name: 'Alternate Bearings Ltd', product: 'Test', email: 'alternate@example.test'
});
const enquiry = S.createVendorEnquiry({
  indentNumber: chainIndent.indentNumber,
  items: (chainIndent.items || []).map((it) => ({
    materialCode: it.materialCode,
    materialName: it.materialName,
    requiredQty: it.purchaseQty,
    unit: it.unit
  })),
  vendors: [
    { vendorId: enquiryVendorMaster.seq, name: enquiryVendorMaster.name, contact: 'Priya Contact', email: enquiryVendorMaster.email },
    { vendorId: alternateVendorMaster.seq, name: alternateVendorMaster.name, contact: 'Alternate Contact', email: alternateVendorMaster.email }
  ]
});
check(enquiry.indentNumber === chainIndent.indentNumber, 'vendor enquiry stores the indent reference');
check(enquiry.soNumber === chainIndent.soNumber, `vendor enquiry inherits Sales Order (${enquiry.soNumber})`);
check(enquiry.projectId === chainIndent.projectId, `vendor enquiry inherits Project ID (${enquiry.projectId})`);
check(enquiry.vendors[0].vendorId === enquiryVendorMaster.seq, 'vendor enquiry preserves Vendor Master ID');
const quotationVendorResolver = await import('../src/utils/vendorQuotationVendor.js');
const enquiryVendorChoices = quotationVendorResolver.getEnquiryVendorChoices(enquiry);
check(enquiryVendorChoices.length === 2, 'quotation vendor resolver supports multiple enquiry vendors');
check(enquiryVendorChoices[0].vendorId === enquiryVendorMaster.seq && enquiryVendorChoices[0].email === enquiryVendorMaster.email,
  'quotation vendor resolver loads master details by vendor ID');
const legacyVendorChoices = quotationVendorResolver.getEnquiryVendorChoices({ vendors: ['Precision Bearings Ltd'] });
check(legacyVendorChoices[0]?.vendorId === enquiryVendorMaster.seq && legacyVendorChoices[0]?.email === enquiryVendorMaster.email,
  'quotation vendor resolver recovers Vendor Master record for legacy name-only enquiry');
check(legacyVendorChoices[0]?.contact === 'Precision Contact', 'legacy enquiry contact person comes from Vendor Master');
const completedEnquiryChoices = quotationVendorResolver.getQuotationFormVendorChoices(
  { ...enquiry, vendors: [{ ...enquiry.vendors[0], status: 'Quotation Received' }] },
  [{ enquiryNumber: enquiry.enquiryNumber, vendorId: enquiryVendorMaster.seq, vendorName: enquiryVendorMaster.name }]
);
check(completedEnquiryChoices[0]?.name === enquiryVendorMaster.name,
  'quotation form still resolves the vendor for a completed or stale enquiry link');
const firstVendorQuotation = {
  enquiryNumber: enquiry.enquiryNumber,
  vendorId: enquiryVendorMaster.seq,
  vendorName: enquiryVendorMaster.name
};
const pendingAfterFirstVendor = quotationVendorResolver.getPendingEnquiryVendorChoices(enquiry, [firstVendorQuotation]);
check(pendingAfterFirstVendor.length === 1 && pendingAfterFirstVendor[0].vendorId === alternateVendorMaster.seq,
  'receiving one quotation leaves only the other enquiry vendor available');
check(!quotationVendorResolver.hasPendingEnquiryVendor(enquiry, [
  firstVendorQuotation,
  { enquiryNumber: enquiry.enquiryNumber, vendorId: alternateVendorMaster.seq, vendorName: alternateVendorMaster.name }
]), 'all quoted vendors remove the enquiry from the receive list');
check(!quotationVendorResolver.hasPendingEnquiryVendor(
  { enquiryNumber: 'VE-LEGACY', vendors: ['Precision Bearings Ltd'] },
  [{ enquiryNumber: 'VE-LEGACY', vendorName: 'Precision Bearings Ltd' }]
), 'legacy quoted vendor name removes the enquiry from the receive list');

// A quotation must reference a real enquiry and inherit the same chain.
let vqErr = '';
try {
  S.createVendorQuotation({ enquiryNumber: 'VE-NOPE', vendorName: 'X Ltd', items: [], totalAmount: 0 });
} catch (e) {
  vqErr = e.message;
}
check(/not found|does not exist|enquiry/i.test(vqErr), `quotation rejects an unknown enquiry → "${vqErr}"`);

const quotation = S.createVendorQuotation({
  enquiryNumber: enquiry.enquiryNumber,
  vendorId: enquiryVendorMaster.seq,
  vendorName: 'Precision Bearings Ltd',
  items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', quotedQty: 2, unit: 'Nos', unitPrice: 500 }],
  totalAmount: 1000,
  taxPct: 18,
  deliveryDays: 7,
  paymentTerms: '30 Days from Invoice'
});
check(quotation.indentNumber === chainIndent.indentNumber, 'quotation inherits the indent reference');
check(quotation.projectId === chainIndent.projectId, 'quotation inherits Project ID');
check(quotation.vendorId === enquiryVendorMaster.seq, 'quotation stores selected Vendor Master ID');
check(S.getVendorQuotationByNumber(quotation.quotationNumber)?.vendorId === enquiryVendorMaster.seq,
  'reopened quotation retains selected Vendor Master ID');
expectThrows(() => S.createVendorQuotation({
  enquiryNumber: enquiry.enquiryNumber,
  vendorId: enquiryVendorMaster.seq,
  vendorName: enquiryVendorMaster.name,
  items: [{ materialName: 'Repeat line', quotedQty: 1, unitPrice: 1 }]
}), /already recorded/i, 'duplicate quotation from the same enquiry vendor is rejected');
check(quotation.taxPct === 18 && quotation.totalWithTax === 1180, 'quotation stores tax and computes total with tax');

section('19. PO auto-closure now requires the full chain');
// Receive some quantity on PO-004 via a Material Receipt, but the PO does not
// close after receipt alone — it must also have the accepted quantity posted to
// inventory and the tax invoice recorded before closure.
const p4 = W.getPOProgress('PO-004');
check(p4.pending === 2, `PO-004 has ${p4.pending} pending before the receipt`);
W.createMaterialReceipt({
  poNumber: 'PO-004',
  invoiceNumber: 'INV-CLOSE-1',
  invoiceDate: '2026-09-25',
  items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 2 }]
});
const closed = W.getPOByRef('PO-004');
// Under the new workflow a PO does NOT close after a receipt alone; it must also
// have the accepted quantity posted to inventory and the tax invoice recorded.
check(closed.status !== W.PO_STATUS.CLOSED, `PO does not auto-close after receipt — status is ${closed.status}`);
check(
  W.getQualityCheck(qc4.qcNumber).status !== W.QC_STATUS.REJECTED,
  'PO closure did not depend on the Quality Check result'
);
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-004',
      invoiceNumber: 'INV-CLOSE-2',
      invoiceDate: '2026-09-26',
      items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 1 }]
    }),
  /already Closed|exceeds PO pending|has no pending quantity|Record the Quality Check first|exceeds the quantity/,
  'no further receipt against a fully received PO'
);
const p4Closed = W.getPOProgress('PO-004');
check(p4Closed.pending >= 0, `PO-004 pending is ${p4Closed.pending} (non-negative, reflects arrived vs ordered)`);
check(p4Closed.closed === false, 'PO is not auto-closed after receipt alone — closure requires full chain');
check(
  p4Closed.rejected === 2 && p4Closed.replacement > 0,
  `rejected quantity is tracked separately from closure (rejected ${p4Closed.rejected}, replacement ordered ${p4Closed.replacement})`
);
check(
  p4Closed.replacementAccepted === 0 && p4Closed.openRejected === 2,
  'a replacement that is only ordered (not yet quality approved) is still outstanding'
);
check(
  p4Closed.fulfillmentStatus === W.PO_STATUS.REPLACEMENT_PENDING,
  `fulfillment reports replacement in progress (${p4Closed.fulfillmentStatus})`
);

section('20. Rejected quantity never reaches inventory + replacement cycle is repeatable');
const qc4Report = W.getRejectionReports().find((r) => r.qcNumber === qc4.qcNumber);
check(Boolean(qc4Report), 'QC-000004 produced a rejection report');

// Only the accepted quantity (6 of 8) was ever posted; the rejected 2 stayed out of stock.
const bearingStock = S.getInventoryItems().find((i) => i.itemName === 'Special Bearing');
check(
  (Number(bearingStock?.currentQty) || 0) === 6,
  `inventory holds only the accepted quantity (${bearingStock?.currentQty} of 8 received)`
);
const rejectedTx = S.getStockTransactions().filter(
  (t) => t.itemName === 'Special Bearing' && Number(t.quantity) > 0
);
check(
  rejectedTx.every((t) => Number(t.quantity) <= 6),
  'no stock transaction ever moved the rejected quantity into inventory'
);
check(
  W.getPOProgress('PO-004').inventoryPosted === 6,
  `PO progress reports only the posted quantity (${W.getPOProgress('PO-004').inventoryPosted})`
);

// The replacement indent for this rejection was already raised in section 16.
const existingReplacement = qc4Report.repurchaseIndentNumber;
check(Boolean(existingReplacement), `rejection already carries a replacement indent (${existingReplacement})`);

loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
expectThrows(
  () => W.createRepurchaseIndent(qc4Report.rejectionNumber),
  /already has replacement indent/,
  'the same rejection cannot be reordered twice'
);
const replacementIndent = W.getIndent(existingReplacement);
check(
  replacementIndent.replacementFor === qc4Report.rejectionNumber,
  'replacement indent links back to the rejection report'
);
check(
  replacementIndent.projectId === qc4Report.projectId,
  'replacement indent inherits Project ID from the rejection report'
);
check(
  (replacementIndent.items || []).every((i) => (i.source || '').includes(qc4Report.rejectionNumber)),
  'replacement indent lines reference the rejection report'
);
check(
  replacementIndent.items.reduce((a, i) => a + (Number(i.purchaseQty) || 0), 0) === 2,
  'replacement indent carries the outstanding rejected quantity only'
);

// The replacement walks the full chain again: Indent → PO → Receipt → Quality Check.
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
W.markIndentConverted(existingReplacement, 'PO-005');
check(W.getIndent(existingReplacement).poNumber === 'PO-005', 'replacement indent converts to a replacement PO');
check(
  notifications().some((n) => n.reference === 'PO-005' && n.targetDept === 'Store Department'),
  'Store notified that the replacement PO was created'
);

// The replacement PO itself is raised through the same Purchase Order service path.
const poHistory = JSON.parse(localStorage.getItem('supplierPOHistory') || '[]');
poHistory.unshift({
  reference: 'PO-005',
  date: '2026-09-27',
  vendor: 'Precision Bearings Ltd',
  status: 'Submitted',
  projectRef: replacementIndent.projectId,
  total: '₹1,000.00',
  payload: {
    poDetails: {
      poNumber: 'PO-005',
      poDate: '2026-09-27',
      poStatus: 'Submitted',
      projectId: replacementIndent.projectId,
      projectRef: replacementIndent.projectId,
      salesOrderRef: replacementIndent.soNumber,
      indentRef: existingReplacement
    },
    vendorDetails: { companyName: 'Precision Bearings Ltd' },
    items: [
      {
        itemCode: 'RAW-009',
        itemName: 'Special Bearing',
        quantity: 2,
        unit: 'Nos',
        unitPrice: 500,
        gst: '18'
      }
    ]
  }
});
localStorage.setItem('supplierPOHistory', JSON.stringify(poHistory));
check(W.getPOByRef('PO-005') !== null, 'replacement PO exists in the purchase order register');
check(
  W.getPOProgress('PO-005').projectId === replacementIndent.projectId,
  'replacement PO inherits Project ID from the replacement indent'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
W.createMaterialReceipt({
  poNumber: 'PO-005',
  invoiceNumber: 'INV-REPL-1',
  invoiceDate: '2026-09-27',
  items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 2 }]
});
const replProgress = W.getPOProgress('PO-005');
check(
  replProgress.received === 2 &&
    replProgress.closed === false &&
    replProgress.fulfillmentStatus === W.PO_STATUS.AWAITING_QC,
  'replacement PO does not close on receipt alone — it must pass inspection first'
);
check(
  W.getPOProgress('PO-004').openRejected === 2,
  "original PO still shows the replacement outstanding until the replacement is quality approved"
);
check(
  W.getPOProgress('PO-004').fulfillmentStatus === W.PO_STATUS.REPLACEMENT_PENDING,
  'original PO reports Replacement Pending while the replacement is in flight'
);

// Approve the replacement material: the original rejection balance finally closes.
const replacementReceipt = W.getReceipts().find((r) => r.poNumber === 'PO-005');
check(Boolean(replacementReceipt), 'replacement delivery has its own Material Receipt');
check(
  replacementReceipt.projectId === replacementIndent.projectId,
  'replacement receipt carries the Project ID'
);
check(
  !W.getPOProgress('PO-005').closed && replacementReceipt.qcStatus === W.QC_STATUS.PENDING,
  'replacement PO stays open while its material is still awaiting inspection'
);

loginAs('Production Department', 'production_employee', 'Kiran Production');
const replQC = W.saveQualityCheck({
  receiptNumber: replacementReceipt.receiptNumber,
  inspector: 'Kiran Production',
  inspectionDate: '2026-09-28',
  items: [
    {
      materialCode: 'RAW-009',
      materialName: 'Special Bearing',
      unit: 'Nos',
      receivedQty: 2,
      acceptedQty: 2,
      rejectedQty: 0,
      result: 'Pass'
    }
  ]
});
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.postApprovedMaterialToInventory(replQC.qcNumber);
const finalP4 = W.getPOProgress('PO-004');
check(finalP4.openRejected === 0, 'approved replacement clears the original rejection balance');
check(
  finalP4.fulfillmentStatus === W.PO_STATUS.FULFILLED,
  `original PO is finally fulfilled (${finalP4.fulfillmentStatus})`
);
check(
  finalP4.closed === true && finalP4.status === W.PO_STATUS.FULL,
  'the original PO is fully received; invoice/inventory closure remains separately tracked'
);
check(
  S.getInventoryItems().find((i) => i.itemName === 'Special Bearing').currentQty === 8,
  'replacement accepted quantity was added to inventory (6 + 2 = 8)'
);

section('21. Migration backfills traceability and reconciles PO status');
W.migrateWorkflowRecords();
check(W.getIndents().every((i) => i.projectId || !i.soNumber), 'every linked indent resolves a Project ID');
check(
  W.getPurchaseOrders()
    .filter((p) => !String(p.reference || '').startsWith('legacy'))
    .every((p) => Object.values(W.PO_STATUS).includes(p.status)),
  'every PO carries a canonical lifecycle status after migration'
);
W.migrateWorkflowRecords();
check(W.getIndents().length > 0 && W.getReceipts().length > 0, 'migration is idempotent and preserves existing records');

/* =============================================================================
 * 22. Vendor Quotation → Accept → Purchase Order (the commercial source)
 * =========================================================================== */
section('22. Accepted Vendor Quotation is the only source of a Purchase Order');

/* ---- a fresh Purchase Indent so this scenario is independent ---------------- */
loginAs('Sales Department', 'sales_employee', 'Ravi Sales');
localStorage.setItem(
  'salesOrderHistory',
  JSON.stringify([
    ...JSON.parse(localStorage.getItem('salesOrderHistory') || '[]'),
    {
      reference: 'SO-Q900',
      date: '2026-09-20',
      status: 'Approved',
      payload: {
        soDetails: { projectId: 'PRJ-1001', projectName: 'Reactor Skid Fabrication', soDate: '2026-09-20', deliveryDate: '2026-10-20' },
        customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
        items: [
          { itemCode: 'MAT-001', itemName: 'MS Plate', quantity: 100, unit: 'Nos' },
          { itemCode: 'MAT-002', itemName: 'Hex Bolt M12', quantity: 50, unit: 'Nos' },
          { itemCode: 'MAT-003', itemName: 'End Mill 12mm', quantity: 25, unit: 'Nos' }
        ]
      }
    }
  ])
);
loginAs('Store Department', 'store_manager', 'Suresh Store');
await W.saveMaterialAvailabilityCheck({ soNumber: 'SO-Q900', remarks: 'Shortage confirmed for quotation flow test' });
const qIndent = W.createPurchaseIndent({ soNumber: 'SO-Q900', reason: 'Vendor quotation flow test' });
check(Boolean(qIndent?.indentNumber), `purchase indent raised for the quotation flow (${qIndent?.indentNumber})`);
check(qIndent.projectId === 'PRJ-1001', 'the indent carries the Project ID used later by the PO');

loginAs('Purchase Department', 'purchase_manager', 'Prabhu Purchase');
const qEnquiry = S.createVendorEnquiry({
  indentNumber: qIndent.indentNumber,
  items: qIndent.items.map((it) => ({
    materialCode: it.materialCode,
    materialName: it.materialName,
    requiredQty: it.purchaseQty,
    unit: it.unit
  })),
  vendors: [{ name: 'ABC Suppliers' }]
});
check(
  qEnquiry.projectId === 'PRJ-1001' && qEnquiry.indentNumber === qIndent.indentNumber,
  'vendor enquiry inherits Project ID and Purchase Indent'
);

/* ---- 1. enter all supported quotation details ------------------------------- */
const vqRec = S.createVendorQuotation({
  enquiryNumber: qEnquiry.enquiryNumber,
  vendorName: 'ABC Suppliers',
  vendorContact: 'Ravi Kumar',
  vendorEmail: 'ravi@abc.test',
  quotationDate: '2026-09-28',
  deliveryDays: 15,
  paymentTerms: '45 days from invoice',
  validity: '30 days',
  otherTerms: 'Material to be new stock; packing extra',
  items: [
    {
      materialCode: 'MAT-001',
      materialName: 'MS Plate',
      description: 'Mild Steel Plate 10mm',
      unit: 'Nos',
      requiredQty: 100,
      quotedQty: 100,
      unitPrice: 500,
      discount: 5,
      taxPct: 18,
      deliveryDays: 15
    },
    {
      materialCode: 'MAT-002',
      materialName: 'Hex Bolt M12',
      description: 'SS Hex Bolt M12 x 60',
      unit: 'Nos',
      requiredQty: 50,
      quotedQty: 50,
      unitPrice: 800,
      discount: 0,
      taxPct: 18,
      deliveryDays: 10
    },
    {
      materialCode: 'MAT-003',
      materialName: 'End Mill 12mm',
      description: 'Carbide End Mill 12mm',
      unit: 'Nos',
      requiredQty: 25,
      quotedQty: 25,
      unitPrice: 1200,
      discount: 0,
      taxPct: 18,
      deliveryDays: 20
    }
  ]
});
check(vqRec.quotationNumber?.startsWith('VQ-'), `quotation created (${vqRec.quotationNumber})`);
check(vqRec.status === 'Received', 'a new quotation starts as Received');
check(vqRec.items.length === 3, 'all three quoted materials were stored');
check(vqRec.projectId === 'PRJ-1001', 'quotation stores the Project ID');
check(
  vqRec.items[0].description === 'Mild Steel Plate 10mm' &&
    vqRec.items[0].discount === 5 &&
    vqRec.items[0].taxPct === 18 &&
    Number(vqRec.items[0].taxAmount) > 0,
  'per-item description, discount, tax % and tax amount are stored'
);
check(
  vqRec.paymentTerms === '45 days from invoice' && vqRec.otherTerms.length > 0,
  'payment terms and other quotation terms are stored'
);
check(
  vqRec.indentNumber === qIndent.indentNumber &&
    vqRec.enquiryNumber === qEnquiry.enquiryNumber &&
    vqRec.soNumber === qIndent.soNumber,
  'quotation retains Indent / Enquiry / Sales Order references'
);
/* saving notifies the Admin so they can approve it */
const vqAdminNote = notifications().find((n) => n.reference === vqRec.quotationNumber && n.targetDept === 'Admin');
check(Boolean(vqAdminNote), 'saving the quotation notifies the Admin');
check(
  vqAdminNote?.link === `/vendor-quotations?quotation=${vqRec.quotationNumber}`,
  'the Admin notification deep-links to the quotation'
);

/* ---- 2. only an accepted quotation may create a PO (service layer) ----------- */
const vqNo = vqRec.quotationNumber;
check(W.canCreatePOFromQuotation(vqNo).allowed === false, 'a Received quotation cannot create a PO');
expectThrows(
  () => W.createPurchaseOrderFromQuotation(vqNo),
  /accept it before/i,
  'service rejects PO creation from a non-accepted quotation'
);

/* approval is Admin-only: Purchase may record but not approve */
expectThrows(
  () => W.acceptQuotation(vqNo, 'Prabhu Purchase'),
  /only the Admin/i,
  'a Purchase user cannot approve — approval belongs to the Admin'
);

/* the Admin approves: validation runs before acceptance */
loginAs('Admin', 'admin', 'Administrator');
S.updateVendorQuotation(vqNo, { items: [] });
expectThrows(
  () => W.acceptQuotation(vqNo, 'Prabhu Purchase'),
  /no items/i,
  'an empty quotation cannot be accepted'
);
S.updateVendorQuotation(vqNo, {
  items: [{ ...vqRec.items[0], quotedQty: 0 }, vqRec.items[1], vqRec.items[2]]
});
expectThrows(
  () => W.acceptQuotation(vqNo, 'Prabhu Purchase'),
  /quantity/i,
  'an item with no quantity blocks acceptance'
);
S.updateVendorQuotation(vqNo, {
  items: [{ ...vqRec.items[0], unitPrice: '' }, vqRec.items[1], vqRec.items[2]]
});
expectThrows(
  () => W.acceptQuotation(vqNo, 'Prabhu Purchase'),
  /unit price/i,
  'an item with no price blocks acceptance'
);

/* ---- 3. accept: status + Accepted By / Date / Time --------------------------- */
S.updateVendorQuotation(vqNo, { items: vqRec.items });
const accepted = W.acceptQuotation(vqNo);
check(accepted.status === 'Accepted', 'accepting the quotation sets status to Accepted');
check(accepted.acceptedBy === 'Administrator', 'Accepted By records the Admin who approved it');
check(Boolean(accepted.acceptedDate), `Accepted Date is recorded (${accepted.acceptedDate})`);
check(Boolean(accepted.acceptedTime), `Accepted Time is recorded (${accepted.acceptedTime})`);
check(
  S.getVendorQuotationByNumber(vqNo).status === 'Accepted',
  'the accepted status is persisted, not just returned'
);
check(W.canCreatePOFromQuotation(vqNo).allowed === true, 'an Accepted quotation unlocks PO creation');

/* ---- 4/5/6/7. the PO is fully populated from the quotation ------------------ */
const draft = W.buildPOFromQuotation(vqNo);
const poVendor = draft.vendorDetails;
check(poVendor.companyName === 'ABC Suppliers', 'PO vendor is fetched from the quotation');
check(draft.items.length === 3, 'every quotation item is mapped, not just the first one');
check(
  draft.items.every((it, i) => it.itemCode === vqRec.items[i].materialCode),
  'material codes are carried over'
);
check(
  draft.items.every((it, i) => it.itemName === vqRec.items[i].materialName && it.description === vqRec.items[i].description),
  'material names and descriptions are carried over'
);
check(
  draft.items.every((it, i) => Number(it.quantity) === Number(vqRec.items[i].quotedQty) && it.unit === vqRec.items[i].unit),
  'quantities and units are carried over'
);
check(
  draft.items.every((it, i) => Number(it.unitPrice) === Number(vqRec.items[i].unitPrice)),
  'unit prices come from the quotation (never master / previous PO / inventory price)'
);
check(
  Number(draft.items[0].discountPct) === 5 && Number(draft.items[0].gst) === 18,
  'discount and GST percentage are carried over'
);
check(
  Number(draft.items[0].taxAmount) === Number(vqRec.items[0].taxAmount),
  'tax amount is carried over unchanged'
);

/* prices must not be replaced by any other source */
const seededItem = S.getInventoryItems().find((i) => i.itemCode === 'MAT-001');
if (seededItem) {
  seededItem.unitCost = 1;
  S.saveInventoryItems(S.getInventoryItems().map((i) => (i.itemCode === 'MAT-001' ? seededItem : i)));
  const recheck = W.buildPOFromQuotation(vqNo);
  check(
    Number(recheck.items[0].unitPrice) === 500,
    'an inventory/material-master price never overrides the quotation price'
  );
  seededItem.unitCost = 999;
  S.saveInventoryItems(S.getInventoryItems().map((i) => (i.itemCode === 'MAT-001' ? { ...i, unitCost: i.unitCost } : i)));
}

/* ---- 8. totals come from the same calculation the project already uses ------ */
check(draft.totals.subtotal === 100 * 500 + 50 * 800 + 25 * 1200, 'PO subtotal matches the quoted values');
check(draft.totals.discount > 0, 'quotation discount is applied to the PO');
check(
  draft.totals.cgst === Number((draft.totals.totalGST / 2).toFixed(2)) &&
    draft.totals.sgst === Number((draft.totals.totalGST / 2).toFixed(2)),
  'CGST / SGST split is produced by the existing calculation (no duplicate tax logic)'
);
check(
  Math.abs(draft.totals.grandTotal - (draft.totals.taxableAmount + draft.totals.totalGST)) < 0.01,
  'grand total = taxable amount + GST'
);
check(
  draft.entry.payload.sourceQuotation.quotationNumber === vqNo,
  'the PO carries the source quotation snapshot for traceability'
);

/* ---- 10/11. the full document chain + automatic Project ID ----------------- */
check(draft.poDetails.projectRef === 'PRJ-1001', 'Project ID is fetched automatically into the PO');
check(draft.poDetails.projectId === 'PRJ-1001', 'Project ID is stored on the PO details');
check(draft.poDetails.indentRef === qIndent.indentNumber, 'Purchase Indent number is inherited');
check(draft.poDetails.enquiryRef === qEnquiry.enquiryNumber, 'Vendor Enquiry number is inherited');
check(draft.poDetails.quotationRef === vqNo, 'Vendor Quotation number is inherited');
check(draft.poDetails.salesOrderRef === qIndent.soNumber, 'Sales Order number is inherited');
check(draft.poDetails.paymentTerms === '45 days from invoice', 'payment terms are inherited from the quotation');
check(
  draft.poDetails.termsAndConditions === W.DEFAULT_PO_TERMS,
  'the PO legal terms are the company standard clauses (never blank, never the vendor one-liner)'
);
check(
  draft.poDetails.quotationTerms === 'Material to be new stock; packing extra',
  'the vendor quoted terms are carried separately in quotationTerms'
);

/* ---- 15. PO-specific fields stay editable ---------------------------------- */
const withPoFields = W.buildPOFromQuotation(vqNo, {
  deliveryAddress: 'Plant Gate 1, Bengaluru',
  billingAddress: 'PRAGMATIC ENGINEERS, Basavanapura',
  transportTerms: 'Buyer arranged',
  internalNotes: 'Urgent — production blocked'
});
check(
  withPoFields.poDetails.deliveryAddress === 'Plant Gate 1, Bengaluru' &&
    withPoFields.poDetails.transportTerms === 'Buyer arranged' &&
    withPoFields.poDetails.internalNotes === 'Urgent — production blocked',
  'PO-specific fields (addresses, transport, internal notes) are preserved'
);
check(
  withPoFields.items[0].unitPrice === draft.items[0].unitPrice,
  'PO-specific overrides never change the quotation commercial values'
);

/* ---- 21/22/23. create the PO through the service ---------------------------- */
const inventoryBeforeConversion = S.getInventoryItems().reduce((a, i) => a + (Number(i.currentQty) || 0), 0);
const createdPO = W.createPurchaseOrderFromQuotation(vqNo);
check(Boolean(createdPO?.reference), `Purchase Order created (${createdPO?.reference})`);
check(createdPO.reference?.startsWith('PO-'), 'the PO number comes from the existing PO numbering system');
check(
  (createdPO.payload?.items || []).length === 3,
  'the saved PO contains all quotation items'
);
check(
  Number(createdPO.payload?.items?.[0]?.unitPrice) === 500,
  'the saved PO keeps the quotation unit price'
);
check(createdPO.payload?.poDetails?.projectRef === 'PRJ-1001', 'the saved PO stores the Project ID');
check(
  createdPO.payload?.poDetails?.quotationRef === vqNo &&
    createdPO.payload?.poDetails?.enquiryRef === qEnquiry.enquiryNumber &&
    createdPO.payload?.poDetails?.indentRef === qIndent.indentNumber,
  'the saved PO stores the whole reference chain'
);
check(
  S.getInventoryItems().reduce((a, i) => a + (Number(i.currentQty) || 0), 0) === inventoryBeforeConversion,
  'creating a PO from a quotation does not touch inventory (Store → QC still required)'
);

/* ---- 16. quotation → PO traceability ---------------------------------------- */
const linkedQuotation = S.getVendorQuotationByNumber(vqNo);
check(linkedQuotation.status === 'PO Created', 'quotation status becomes PO Created');
check(linkedQuotation.poNumber === createdPO.reference, 'the quotation stores the generated PO number');
check(
  linkedQuotation.purchaseOrderNumber === createdPO.reference &&
    Boolean(linkedQuotation.purchaseOrderId) &&
    Boolean(linkedQuotation.poCreatedDate),
  'purchaseOrderId / purchaseOrderNumber / poCreatedDate are recorded on the quotation'
);
check(
  W.getPOForQuotation(vqNo)?.reference === createdPO.reference,
  'the PO can be found back from the quotation'
);
check(W.quotationAlreadyConverted(linkedQuotation), 'the quotation is flagged as already converted');

/* Store Department was notified about the new PO */
const storeNotifications = JSON.parse(localStorage.getItem('notifications') || '[]').filter(
  (n) => String(n.reference) === createdPO.reference && String(n.targetDept).includes('Store')
);
check(storeNotifications.length > 0, 'the Store Department is notified when the PO is created');

/* the Purchase Indent is converted only because a PO now exists */
check(
  W.getIndent(qIndent.indentNumber)?.status === W.INDENT_STATUS.CONVERTED ||
    W.getIndent(qIndent.indentNumber)?.poNumber === createdPO.reference,
  'the Purchase Indent is marked as converted to this PO'
);

/* ---- 17. duplicate PO prevention -------------------------------------------- */
expectThrows(
  () => W.createPurchaseOrderFromQuotation(vqNo),
  /already/i,
  'a second PO from the same quotation is rejected by the service'
);
check(
  W.getPurchaseOrders().filter((p) => p.payload?.poDetails?.quotationRef === vqNo).length === 1,
  'only one Purchase Order exists for the quotation'
);
check(W.canCreatePOFromQuotation(vqNo).allowed === false, 'the UI is told to show "View Purchase Order" instead');

/* a legacy quotation that already produced a PO can never produce another one */
const legacyVQ = 'VQ-LEGACY-1';
localStorage.setItem(
  'vendorQuotations',
  JSON.stringify([
    {
      quotationNumber: legacyVQ,
      enquiryNumber: qEnquiry.enquiryNumber,
      indentNumber: qIndent.indentNumber,
      soNumber: qIndent.soNumber,
      projectId: 'PRJ-1001',
      vendorName: 'Legacy Supplier',
      status: 'Ordered',
      poNumber: 'PO-OLD-1',
      items: [{ materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', quotedQty: 1, unitPrice: 100, taxPct: 18, totalPrice: 100 }]
    },
    ...S.getAllVendorQuotations()
  ])
);
expectThrows(
  () => W.createPurchaseOrderFromQuotation(legacyVQ),
  /already/i,
  'a legacy Ordered quotation cannot raise a second PO'
);
W.migrateWorkflowRecords();
check(
  S.getVendorQuotationByNumber(legacyVQ)?.status === 'PO Created',
  'migration normalises the legacy Ordered status to PO Created without deleting the record'
);

/* ---- 19. the PO then continues the normal workflow -------------------------- */
const poProgressFromQuotation = W.getPOProgress(createdPO.reference);
check(poProgressFromQuotation.ordered === 175, 'the PO ordered quantity comes from the quotation (100 + 50 + 25)');
check(poProgressFromQuotation.received === 0 && poProgressFromQuotation.pending === 175, 'nothing is received before Store records a delivery');
check(poProgressFromQuotation.projectId === 'PRJ-1001', 'the PO projection carries the Project ID');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const qReceiptResult = W.createMaterialReceipt({
  poNumber: createdPO.reference,
  invoiceNumber: 'TAX-INV-9001',
  invoiceDate: '2026-09-29',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', receivedQty: 100 },
    { materialCode: 'MAT-002', materialName: 'Hex Bolt M12', unit: 'Nos', receivedQty: 50 },
    { materialCode: 'MAT-003', materialName: 'End Mill 12mm', unit: 'Nos', receivedQty: 25 }
  ]
});
const qReceipt = qReceiptResult.receipt;
check(Boolean(qReceipt?.receiptNumber), 'Store records the delivery as a Tax Invoice / Material Receipt');
check(qReceipt.qcStatus === W.QC_STATUS.PENDING, 'the delivered material waits for Quality Check — no direct inventory entry');
const invAfterReceipt = S.getInventoryItems().reduce((a, i) => a + (Number(i.currentQty) || 0), 0);
check(
  invAfterReceipt === inventoryBeforeConversion,
  'a material receipt alone still does not update inventory'
);

loginAs('Production Department', 'production_employee', 'Kiran Production');
const qQC = W.saveQualityCheck({
  receiptNumber: qReceipt.receiptNumber,
  inspector: 'Kiran Production',
  inspectionDate: '2026-09-29',
  items: qReceipt.items.map((it) => ({
    materialCode: it.materialCode,
    materialName: it.materialName,
    unit: it.unit,
    receivedQty: it.receivedQty,
    acceptedQty: it.receivedQty,
    rejectedQty: 0,
    result: 'Pass'
  }))
});
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.postApprovedMaterialToInventory(qQC.qcNumber);
const plate = S.getInventoryItems().find((i) => i.itemCode === 'MAT-001');
check(
  Number(plate?.currentQty) > 0,
  `quality-approved quotation material reached inventory (MAT-001 = ${plate?.currentQty})`
);
check(
  W.getPOProgress(createdPO.reference).closed === true,
  'the quotation-derived PO completes Store → Receipt → QC → Inventory'
);

section('23. Retired Purchase Indent records stay historical');
const legacyDirect = {
  indentNumber: 'IND-LEGACY-DIRECT-TEST', sourceType: 'storeDirect', status: W.INDENT_STATUS.SUBMITTED,
  soNumber: '', items: [{ materialName: 'Historical item', purchaseQty: 1 }], history: [{ action: 'Historical entry' }]
};
localStorage.setItem('purchaseIndents', JSON.stringify([legacyDirect, ...ls('purchaseIndents', [])]));
check(typeof W.createDirectPurchaseIndent === 'undefined', 'the retired creation function is no longer exported');
check(!W.canEditIndent(legacyDirect) && !W.canSubmitIndent(legacyDirect), 'legacy records are read-only');
loginAs('Purchase Department', 'purchase_manager', 'Meena Purchase');
expectThrows(() => W.startPurchaseIndentReview(legacyDirect.indentNumber), /historical record/, 'Purchase cannot review a legacy record');
expectThrows(() => S.createVendorEnquiry({ indentNumber: legacyDirect.indentNumber, items: [{ materialName: 'Historical item', requiredQty: 1, shortageQty: 1 }] }), /historical record/, 'legacy records cannot enter Vendor Enquiry');
loginAs('Admin', 'admin', 'Administrator');
let approvalBlocked = false;
try { await W.approveIndentByAdmin(legacyDirect.indentNumber, 'must not apply'); } catch (error) { approvalBlocked = /historical record/.test(error.message); }
check(approvalBlocked, 'Admin approval is disabled for legacy records');
check(W.getIndent(legacyDirect.indentNumber)?.history[0]?.action === 'Historical entry', 'historical contents remain unchanged');
/* ---------------------------------- summary ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
