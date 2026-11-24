/**
 * Purchase → Store → QC → Rejection → Debit Note approval → Replacement →
 * Closure, end to end.
 * Run:  node tests/replacement-flow.test.mjs
 *
 * Rules asserted here:
 *   1. A Material Receipt never changes inventory.
 *   2. Only Quality-approved quantity is posted to inventory, exactly once.
 *   3. Accepted + Rejected must equal Received.
 *   4. Debit Note: Store request → Purchase review → Purchase authorise → Admin
 *      approval → issue → vendor → close, with the rejected quantity reserved
 *      from the request onwards.
 *   5. Replacement is received against the SAME PO, never raises the ordered
 *      quantity, and is capped by the outstanding rejected balance.
 *   6. The PO closes only after the replacement has passed inspection.
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

const W = await import('../src/utils/workflowService.js');
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
const invQty = (code) => {
  const item = ls('inventoryItems', []).find((i) => String(i.itemCode).toLowerCase() === code.toLowerCase());
  return item ? Number(item.currentQty) : null;
};
const stockInFor = (code, poNumber) =>
  ls('stockTransactions', []).filter(
    (t) => String(t.itemCode).toLowerCase() === code.toLowerCase() && t.poReference === poNumber
  );

const seed = () => {
  localStorage.setItem(
    'inventoryItems',
    JSON.stringify([{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 0 }])
  );
  localStorage.setItem(
    'supplierPOHistory',
    JSON.stringify([
      {
        reference: 'PO-900',
        date: '2026-10-01',
        vendor: 'Alpha Steels',
        status: 'Submitted',
        payload: {
          poDetails: { poNumber: 'PO-900', poDate: '2026-10-01', poStatus: 'Submitted' },
          vendorDetails: { companyName: 'Alpha Steels', gstNumber: '29AAAAA0000A1Z5', address: 'Bengaluru' },
          items: [
            {
              itemCode: 'RAW-001',
              itemName: 'MS Plate 10mm',
              quantity: 100,
              unit: 'Nos',
              unitPrice: 100,
              gst: 18,
              hsnSac: '7208'
            },
            {
              itemCode: 'RAW-002',
              itemName: 'SS 304 Sheet',
              quantity: 50,
              unit: 'Nos',
              unitPrice: 250,
              gst: 18,
              hsnSac: '7209'
            }
          ]
        }
      }
    ])
  );
  W.ensureWorkflowSeeded();
};

/* =================================== scenario =================================== */
section('0. Seeding + RBAC tokens');
seed();
check(W.getPurchaseOrders().length === 1, 'seeded 1 purchase order');

loginAs('Store Department', 'store_manager', 'Suresh Store');
check(hasPermission('receipt.create') && hasPermission('arrival.create'), 'Store holds receipt.create + arrival.create');
check(hasPermission('debitnote.create'), 'Store can raise a Debit Note');
check(!hasPermission('debitnote.record'), 'Store cannot review/approve a Debit Note');

loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
check(hasPermission('debitnote.record'), 'Purchase holds debitnote.record');
check(!hasPermission('receipt.create'), 'Purchase cannot book a Material Receipt');

loginAs('Production Department', 'production_employee', 'Kiran Production');
check(hasPermission('production.qc.manage'), 'Production can inspect');

/* ------------------------------ 1. Material Receipt ------------------------------ */
section('1. Material Receipt never touches inventory');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const rec1 = W.createMaterialReceipt({
  poNumber: 'PO-900',
  invoiceNumber: 'TAX-INV-9001',
  invoiceDate: '2026-10-02',
  dcNumber: 'DC-901',
  items: [
    { materialCode: 'RAW-001', materialName: 'MS Plate 10mm', unit: 'Nos', orderedQty: 100, receivedQty: 100 },
    { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', orderedQty: 50, receivedQty: 50 }
  ]
}).receipt;
check(rec1.receiptNumber.startsWith('REC-'), `receipt numbered ${rec1.receiptNumber}`);
check(rec1.qcStatus === W.QC_STATUS.PENDING, 'receipt awaits Quality Check');
check(invQty('RAW-001') === 0, 'inventory unchanged by the receipt (RAW-001 = 0)');
check(invQty('RAW-002') === null, 'unknown material RAW-002 not created by the receipt');
check(W.getPOProgress('PO-900').pending === 0, 'PO fully received');
check(W.getPOProgress('PO-900').status === W.PO_STATUS.AWAITING_QC, 'full physical receipt remains Awaiting QC until inspected');

expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-900',
      invoiceNumber: 'TAX-INV-9001',
      invoiceDate: '2026-10-03',
      items: [{ materialCode: 'RAW-001', receivedQty: 1 }]
    }),
  /Duplicate invoice number/,
  'duplicate vendor invoice rejected'
);
check(ls('materialReceipts', []).length === 1, 'no duplicate receipt persisted');

// The vendor invoice the Store records is shared with Quality and Purchase.
check(Boolean(rec1.invoiceSharedAt), 'receipt carries when the invoice was shared');
check(
  (rec1.invoiceSharedWith || []).join('|') === 'Quality Department|Purchase Department',
  'invoice shared with Quality and Purchase'
);
check(
  (rec1.history || []).some((h) => h.action === 'Tax invoice shared with Quality and Purchase'),
  'sharing recorded in the receipt history'
);
const shareNotifs = ls('notifications', []);
check(
  shareNotifs.some(
    (n) =>
      n.targetDept === 'Production Department' &&
      /tax invoice shared for quality/i.test(String(n.title)) &&
      String(n.message).includes('TAX-INV-9001')
  ),
  'Quality notified of the shared vendor invoice'
);
check(
  shareNotifs.some(
    (n) =>
      n.targetDept === 'Purchase Department' &&
      /record as Supplier Invoice/i.test(String(n.title)) &&
      String(n.message).includes('TAX-INV-9001') &&
      String(n.message).includes('PO-900')
  ),
  'Purchase notified to record the invoice as the Supplier Invoice'
);

/* ------------------------------ 2. Quality Check ------------------------------ */
section('2. Quality Check: accepted only reaches inventory');
loginAs('Production Department', 'production_employee', 'Kiran Production');
expectThrows(
  () =>
    W.saveQualityCheck({
      receiptNumber: rec1.receiptNumber,
      inspectionDate: '2026-10-03',
      inspector: 'Kiran',
      items: [{ materialCode: 'RAW-001', materialName: 'MS Plate 10mm', receivedQty: 100, acceptedQty: 95, rejectedQty: 0 }]
    }),
  /must equal Received/,
  'Accepted + Rejected < Received is refused'
);

const qc1 = W.saveQualityCheck({
  receiptNumber: rec1.receiptNumber,
  inspectionDate: '2026-10-03',
  inspector: 'Kiran',
  items: [
    {
      materialCode: 'RAW-001',
      materialName: 'MS Plate 10mm',
      unit: 'Nos',
      receivedQty: 100,
      acceptedQty: 90,
      rejectedQty: 10,
      rejectionReason: 'Surface scratch'
    },
    {
      materialCode: 'RAW-002',
      materialName: 'SS 304 Sheet',
      unit: 'Nos',
      receivedQty: 50,
      acceptedQty: 50,
      rejectedQty: 0
    }
  ]
});
check(qc1.status === W.QC_STATUS.PARTIAL, `QC status ${qc1.status}`);

const rejections = W.getRejectionReports();
check(rejections.length === 1, 'rejection report auto-created');
const rejectionNumber = rejections[0].rejectionNumber;
check(rejections[0].items[0].rejectedQty === 10, 'rejection carries the 10 rejected units');
check(rejections[0].receiptNumber === rec1.receiptNumber, 'rejection linked to the receipt');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const posted = W.postApprovedMaterialToInventory(qc1.qcNumber);
check(posted.posted === 2, `two accepted lines posted (${posted.posted})`);
check(invQty('RAW-001') === 90, 'inventory holds 90 accepted MS Plate (100 − 10 rejected)');
check(invQty('RAW-002') === 50, 'inventory holds 50 accepted SS 304 Sheet');
check(stockInFor('RAW-001', 'PO-900').length === 1, 'one IN transaction for the accepted line');
expectThrows(
  () => W.postApprovedMaterialToInventory(qc1.qcNumber),
  /already been posted/,
  'duplicate inventory posting blocked'
);
check(invQty('RAW-001') === 90, 'inventory unchanged after the blocked second posting');

const prog1 = W.getPOProgress('PO-900');
check(prog1.rejected === 10, `rejected 10 tracked on the PO (${prog1.rejected})`);
check(prog1.openRejected === 10, 'the rejection is still open');
check(!prog1.closureReady, 'PO cannot close while the rejection is open');

/* --------------------------- 3. Debit Note approval chain --------------------------- */
section('3. Debit Note: Store request → Admin approval → Purchase issues → vendor with reasons');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const dn1 = W.createDebitNote({
  rejectionNumber,
  debitNoteDate: '2026-10-04',
  items: [{ materialCode: 'RAW-001', materialName: 'MS Plate 10mm', debitQty: 10 }]
});
check(dn1.status === W.DEBIT_NOTE_STATUS.DRAFT, 'a new Debit Note starts as Draft');
check(dn1.items[0].unitPrice === 100 && dn1.items[0].gstPercent === 18, 'price and GST taken from the PO');
check(dn1.receiptNumber === rec1.receiptNumber, 'receipt resolved automatically');
check(dn1.qcNumber === qc1.qcNumber, 'quality check resolved automatically');

loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
expectThrows(() => W.reviewDebitNote(dn1.debitNoteNumber), /Requested/, 'Purchase cannot review a Draft');
expectThrows(
  () => W.issueDebitNote(dn1.debitNoteNumber),
  /submit it for Admin approval/,
  'Purchase cannot issue a Draft — the Draft → Issue shortcut is closed'
);
expectThrows(
  () => W.approveDebitNoteByAdmin(dn1.debitNoteNumber),
  /Permission denied/,
  'Purchase cannot approve as the Admin'
);
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(() => W.approveDebitNote(dn1.debitNoteNumber), /Permission denied/, 'Store cannot approve');
expectThrows(
  () => W.approveDebitNoteByAdmin(dn1.debitNoteNumber),
  /Permission denied/,
  'Store cannot approve as the Admin'
);

/* Store submits → it goes to the ADMIN, and Store keeps visibility of it. */
const requested = W.submitDebitNoteRequest(dn1.debitNoteNumber);
check(requested.status === W.DEBIT_NOTE_STATUS.ADMIN_REVIEW, `status → ${requested.status}`);
check(requested.requestedBy === 'Suresh Store', 'requester recorded');
check(
  ls('notifications', []).some((n) => n.targetDept === 'Admin' && /awaits your approval/i.test(String(n.title))),
  'the Admin is notified that the Debit Note awaits approval'
);
check(
  ls('notifications', []).some(
    (n) => n.targetDept === 'Store Department' && n.reference === dn1.debitNoteNumber
  ),
  'Store is notified and keeps visibility of its own request'
);
expectThrows(
  () => W.issueDebitNote(dn1.debitNoteNumber),
  /awaiting Admin approval/,
  'a submitted Debit Note cannot be issued before the Admin approves it'
);

// The rejected quantity is reserved from the request onwards.
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
const dnCtx = W.getDebitNoteContext(rejectionNumber);
check(dnCtx.lines[0].remainingQty === 0, 'the rejected quantity is reserved by the open request');
expectThrows(
  () =>
    W.createDebitNote({
      rejectionNumber,
      items: [{ materialCode: 'RAW-001', materialName: 'MS Plate 10mm', debitQty: 5 }]
    }),
  /only 0 Nos of the 10 rejected is still unclaimed/,
  'a second Debit Note cannot claim the reserved quantity'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => W.issueDebitNote(dn1.debitNoteNumber),
  /awaiting Admin approval/,
  'Store cannot issue before the Admin approves either'
);
expectThrows(() => W.reviewDebitNote(dn1.debitNoteNumber), /Permission denied/, 'Store cannot move it into Purchase review');

/* The Admin approval is the gate — Purchase does NOT review first. */
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
expectThrows(
  () => W.reviewDebitNote(dn1.debitNoteNumber),
  /Admin Approval/,
  'Purchase review is not the gate — the note is with the Admin'
);

loginAs('Admin', 'admin', 'Ravi Admin');
const adminApproved = W.approveDebitNoteByAdmin(dn1.debitNoteNumber);
check(adminApproved.status === W.DEBIT_NOTE_STATUS.APPROVED, `status → ${adminApproved.status}`);
check(adminApproved.adminApprovedBy === 'Ravi Admin', 'Admin approval recorded');
check(
  adminApproved.approvedBy === 'Ravi Admin' && Boolean(adminApproved.approvedAt),
  'approved by / at back-reference filled by the Admin'
);
check(
  ls('notifications', []).some(
    (n) => n.targetDept === 'Purchase Department' && /approved by Admin/.test(String(n.title))
  ),
  'Purchase notified of the Admin approval'
);
check(
  ls('notifications', []).some(
    (n) => n.targetDept === 'Purchase Department' && /Rejection reasons:/i.test(String(n.message))
  ),
  'Purchase is handed the rejection reasons with the approved Debit Note'
);
check(
  ls('notifications', []).some(
    (n) => n.targetDept === 'Store Department' && n.reference === dn1.debitNoteNumber && /approved/i.test(String(n.title))
  ),
  'Store notified of the Admin approval'
);

loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
const issued = W.issueDebitNote(dn1.debitNoteNumber);
check(issued.status === W.DEBIT_NOTE_STATUS.ISSUED, `status → ${issued.status}`);
check(issued.issuedBy === 'Priya Purchase', 'issuer recorded');
expectThrows(() => W.issueDebitNote(dn1.debitNoteNumber), /already issued/, 'an issued Debit Note cannot be re-issued');

const sentVendor = W.sendDebitNoteToVendor(dn1.debitNoteNumber);
check(sentVendor.status === W.DEBIT_NOTE_STATUS.SENT_VENDOR, `status → ${sentVendor.status}`);
check(Boolean(sentVendor.vendorNotice) && sentVendor.vendorNotice.lines.length === 1, 'a rejection notice travels with the Debit Note to the vendor');
check(
  sentVendor.vendorNotice.lines[0].reason === 'Surface scratch',
  `the notice states why the material was rejected ("${sentVendor.vendorNotice.lines[0].reason}")`
);
check(
  (sentVendor.history || []).some((h) => /sent to vendor with rejection reasons/i.test(String(h.action))),
  'history records that the reasons were forwarded'
);
check(
  ls('notifications', []).some(
    (n) => n.targetDept === 'Store Department' && /Reason\(s\) for rejection/i.test(String(n.message))
  ),
  'Store sees the rejection reasons that went to the vendor'
);

/* The loop is not finished: the Debit Note stays open until the replacement
   material has been received and passed Quality Check. */
expectThrows(
  () => W.closeDebitNote(dn1.debitNoteNumber),
  /have not passed Quality Check as replacement material/,
  'the Debit Note cannot be closed before the replacement passes Quality Check'
);
expectThrows(
  () => W.closeDebitNote(dn1.debitNoteNumber, { force: true }),
  /have not passed Quality Check as replacement material/,
  'the force flag does not bypass the replacement Quality Check requirement'
);

/* ------------------------------ 4. Replacement receipt ------------------------------ */
section('4. Replacement is booked against the SAME PO, ordered qty unchanged');
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-900',
      invoiceNumber: 'TAX-INV-REP-1',
      invoiceDate: '2026-10-05',
      replacementForRejection: rejectionNumber,
      items: [{ materialCode: 'RAW-001', receivedQty: 10 }]
    }),
  /Permission denied/,
  'Purchase cannot book a Material Receipt'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-900',
      invoiceNumber: 'TAX-INV-REP-BAD',
      invoiceDate: '2026-10-05',
      replacementForRejection: rejectionNumber,
      items: [{ materialCode: 'RAW-001', receivedQty: 11 }]
    }),
  /exceeds the 10/,
  'replacement above the rejected balance is refused'
);

const rr = W.createMaterialReceipt({
  poNumber: 'PO-900',
  invoiceNumber: 'TAX-INV-REP-1',
  invoiceDate: '2026-10-05',
  dcNumber: 'DC-REP-1',
  replacementForRejection: rejectionNumber,
  debitNoteNumber: dn1.debitNoteNumber,
  items: [{ materialCode: 'RAW-001', materialName: 'MS Plate 10mm', unit: 'Nos', receivedQty: 10 }]
}).receipt;
check(rr.receiptNumber.startsWith('RR-'), `replacement receipt numbered ${rr.receiptNumber}`);
check(rr.isReplacement === true, 'receipt flagged as a replacement');
check(rr.rejectionNumber === rejectionNumber, 'linked back to the rejection report');
check(rr.originalReceiptNumber === rec1.receiptNumber, 'linked back to the original receipt');
check(rr.originalQcNumber === qc1.qcNumber, 'linked back to the original inspection');
check(rr.debitNoteNumber === dn1.debitNoteNumber, 'linked back to the Debit Note');
check(invQty('RAW-001') === 90, 'replacement receipt does not touch inventory');

const prog2 = W.getPOProgress('PO-900');
check(prog2.ordered === 150, `ordered quantity unchanged (${prog2.ordered})`);
check(prog2.received === 160, `received quantity includes the replacement (${prog2.received})`);
check(prog2.replacementArrived === 10, `replacement received tracked (${prog2.replacementArrived})`);
check(prog2.pendingReplacement === 0, 'the rejected balance is now physically replaced');
check(prog2.openRejected === 10, '…but the rejection stays open until Quality approves the replacement');
check(!prog2.closureReady, 'PO still cannot close before replacement inspection');
check(prog2.status === W.PO_STATUS.REPLACEMENT_PENDING, 'PO status reports Replacement Pending while rejection remains open');
check(W.getPOProgress('PO-900').fulfillmentStatus === W.PO_STATUS.REPLACEMENT_PENDING, 'fulfillment reports Replacement Pending');

/* --------------------------- 5. Replacement inspection --------------------------- */
section('5. Replacement inspection → inventory → PO closure');
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc2 = W.saveQualityCheck({
  receiptNumber: rr.receiptNumber,
  inspectionDate: '2026-10-06',
  inspector: 'Kiran',
  items: [
    {
      materialCode: 'RAW-001',
      materialName: 'MS Plate 10mm',
      unit: 'Nos',
      receivedQty: 10,
      acceptedQty: 10,
      rejectedQty: 0
    }
  ]
});
check(qc2.arrivalType === W.ARRIVAL_TYPE.REPLACEMENT, 'replacement inspection labelled as such');
const acceptedAwaitingInventory = W.getPOProgress('PO-900');
check(acceptedAwaitingInventory.receiptComplete, 'accepted replacement completes physical fulfillment');
check(!acceptedAwaitingInventory.closureReady, 'physical fulfillment does not require inventory or invoice closure');
check(acceptedAwaitingInventory.status === W.PO_STATUS.FULL, 'PO is Fully Received before inventory/invoice closure');

loginAs('Store Department', 'store_manager', 'Suresh Store');
W.postApprovedMaterialToInventory(qc2.qcNumber);
check(invQty('RAW-001') === 100, 'inventory = 90 + 10 replacement = 100 accepted units');

const finalProgress = W.getPOProgress('PO-900');
check(finalProgress.openRejected === 0, 'the rejection balance is cleared');
check(finalProgress.pendingReplacement === 0, 'nothing outstanding for replacement');
check(finalProgress.accepted === 150, `accepted across both inspections (${finalProgress.accepted})`);
check(finalProgress.originalAccepted === 140, `original accepted excludes rejected material (${finalProgress.originalAccepted})`);
check(finalProgress.replacementAccepted === 10, `accepted replacement is tracked separately (${finalProgress.replacementAccepted})`);
check(finalProgress.finalAccepted === 150, `final accepted combines original and replacement (${finalProgress.finalAccepted})`);
check(finalProgress.closureReady === true, 'the full closure chain is complete');
check(finalProgress.status === W.PO_STATUS.FULL, `PO fulfillment status is ${finalProgress.status}`);
const storedPO = W.getPOByRef('PO-900');
check(storedPO.status === W.PO_STATUS.FULL, `persisted PO fulfillment status ${storedPO.status}`);
check(storedPO.payload.poDetails.pendingReplacementQty === 0, 'persisted pending replacement qty = 0');

/* Now that the replacement arrived and passed Quality, the Debit Note loop can
   be closed: receive → re-inspect → close. */
section('5b. Debit Note closes only after the replacement passes Quality Check');
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
const closed = W.closeDebitNote(dn1.debitNoteNumber);
check(closed.status === W.DEBIT_NOTE_STATUS.CLOSED, `status → ${closed.status}`);
check(closed.closedBy === 'Priya Purchase', 'closer recorded (Purchase)');
expectThrows(
  () => W.closeDebitNote(dn1.debitNoteNumber),
  /send it to the vendor|already/i,
  'a closed note cannot be closed twice'
);
check(W.getDebitNoteSummaryForRejection(rejectionNumber).committedQty === 10, 'committed qty = 10');

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () =>
    W.createMaterialReceipt({
      poNumber: 'PO-900',
      invoiceNumber: 'TAX-INV-LATE',
      invoiceDate: '2026-10-07',
      items: [{ materialCode: 'RAW-001', receivedQty: 1 }]
    }),
  /already|no further receipt|exceeds/i,
  'a closed PO never reopens for a fresh delivery'
);

/* ------------------ 6. Shared vendor invoice → Supplier Invoice ------------------ */
section('6. Vendor invoice shared with Purchase is recorded as the Supplier Invoice');
check(
  W.getVendorInvoicesAwaitingSupplierInvoice().some((r) => r.receiptNumber === rec1.receiptNumber),
  'the shared vendor invoice is waiting for Purchase'
);
check(
  Math.abs(W.getReceiptInvoiceValue(rec1) - 26550) < 0.01,
  `invoice value priced from the PO (${W.getReceiptInvoiceValue(rec1)})`
);

const prefill = W.getSupplierInvoicePrefill(rec1.receiptNumber);
check(prefill.poReference === 'PO-900', 'prefill points at the PO');
check(prefill.vendorInvoiceNumber === 'TAX-INV-9001', 'prefill carries the vendor invoice number');
check(prefill.vendorName === 'Alpha Steels', 'prefill carries the vendor');
check(prefill.items.length === 2, 'prefill has both received lines');
check(
  prefill.items[0].itemCode === 'RAW-001' &&
    prefill.items[0].quantity === '100' &&
    prefill.items[0].unitPrice === '100' &&
    prefill.items[0].gst === '18' &&
    prefill.items[0].hsnSac === '7208',
  'first prefill line priced and coded from the PO'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => W.markReceiptSupplierInvoice(rec1.receiptNumber, 'BILL-001'),
  /Permission denied/,
  'Store cannot record a Supplier Invoice'
);
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
const billed = W.markReceiptSupplierInvoice(rec1.receiptNumber, 'BILL-001');
check(billed.supplierInvoiceNumber === 'BILL-001', `receipt marked with the Supplier Invoice (${billed.supplierInvoiceNumber})`);
check(billed.supplierInvoiceBy === 'Priya Purchase', 'the Purchase user who recorded it is kept');
check(
  (billed.history || []).some((h) => h.action === 'Recorded as Supplier Invoice'),
  'conversion recorded in the receipt history'
);
check(
  !W.getVendorInvoicesAwaitingSupplierInvoice().some((r) => r.receiptNumber === rec1.receiptNumber),
  'a converted invoice no longer waits for Purchase'
);

/* ------- 7. Replacement does not consume outstanding original PO quantity ------- */
section('7. Original delivery balance stays separate from replacement receipts');
const deliveryPO = {
  reference: 'PO-DELIVERY-RESIDUE', status: 'Partially Received', vendor: 'Alpha Steels',
  payload: { poDetails: { poNumber: 'PO-DELIVERY-RESIDUE' }, vendorDetails: { companyName: 'Alpha Steels' }, items: [
    { itemCode: 'WELD', itemName: 'Welding Electrode E7018 4mm', quantity: 20, unit: 'Kg' },
    { itemCode: 'ANGLE', itemName: 'MS Angle 40x40x5', quantity: 10, unit: 'Kg' },
    { itemCode: 'SHAFT', itemName: 'Shaft Collar 1/2in SS', quantity: 86, unit: 'Nos' },
    { itemCode: 'PROX', itemName: 'Proximity Sensor M18 PNP', quantity: 100, unit: 'Nos' }
  ] }
};
const saveList = (key, rows) => localStorage.setItem(key, JSON.stringify(rows));
saveList('supplierPOHistory', [...ls('supplierPOHistory', []), deliveryPO]);
saveList('materialReceipts', [...ls('materialReceipts', []),
  { receiptNumber: 'REC-DELIVERY-ORIGINAL', poNumber: deliveryPO.reference, invoiceNumber: 'INV-DELIVERY-ORIGINAL', items: [
    { materialCode: 'WELD', materialName: 'Welding Electrode E7018 4mm', receivedQty: 20 },
    { materialCode: 'ANGLE', materialName: 'MS Angle 40x40x5', receivedQty: 10 },
    { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', receivedQty: 76 },
    { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', receivedQty: 90 }
  ] },
  { receiptNumber: 'RR-DELIVERY-REPLACEMENT', poNumber: deliveryPO.reference, isReplacement: true,
    receiptType: 'Replacement Receipt', rejectionNumber: 'RRN-DELIVERY-ORIGINAL', items: [
      { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', receivedQty: 10 },
      { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', receivedQty: 10 }
    ] }
]);
saveList('qualityChecks', [...ls('qualityChecks', []),
  { qcNumber: 'QC-DELIVERY-ORIGINAL', poNumber: deliveryPO.reference, receiptNumber: 'REC-DELIVERY-ORIGINAL', items: [
    { materialCode: 'WELD', materialName: 'Welding Electrode E7018 4mm', receivedQty: 20, acceptedQty: 20, rejectedQty: 0 },
    { materialCode: 'ANGLE', materialName: 'MS Angle 40x40x5', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 },
    { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', receivedQty: 76, acceptedQty: 66, rejectedQty: 10 },
    { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', receivedQty: 90, acceptedQty: 80, rejectedQty: 10 }
  ] },
  { qcNumber: 'QC-DELIVERY-REPLACEMENT', poNumber: deliveryPO.reference, receiptNumber: 'RR-DELIVERY-REPLACEMENT', items: [
    { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 },
    { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }
  ] }
]);
saveList('rejectionReports', [...ls('rejectionReports', []), {
  rejectionNumber: 'RRN-DELIVERY-ORIGINAL', poNumber: deliveryPO.reference, qcNumber: 'QC-DELIVERY-ORIGINAL',
  replacementQty: 20, pendingReplacementQty: 0, items: [
    { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', rejectedQty: 10, replacementQty: 10, pendingReplacementQty: 0 },
    { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', rejectedQty: 10, replacementQty: 10, pendingReplacementQty: 0 }
  ]
}]);

let deliveryProgress = W.getPOProgress(deliveryPO.reference);
check(deliveryProgress.received === 216, `physical received includes 196 original + 20 replacement (${deliveryProgress.received})`);
check(deliveryProgress.pending === 20, `original PO delivery balance excludes the replacement quantities (${deliveryProgress.pending})`);
check(deliveryProgress.acceptedQuantityShortage === 20, 'replacement receipt resolves rejection but does not erase the undelivered accepted shortage');
check(deliveryProgress.lines.find((line) => line.materialCode === 'SHAFT').pendingQty === 10, '10 Shaft Collars remain deliverable');
check(deliveryProgress.lines.find((line) => line.materialCode === 'PROX').pendingQty === 10, '10 Proximity Sensors remain deliverable');

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(() => W.createMaterialReceipt({
  poNumber: deliveryPO.reference, invoiceNumber: 'INV-DELIVERY-DUP-REPL', invoiceDate: '2026-10-08',
  replacementForRejection: 'RRN-DELIVERY-ORIGINAL',
  items: [{ materialCode: 'SHAFT', receivedQty: 1 }]
}), /exceeds the 0/, 'duplicate replacement receipt is refused after rejection replacement is complete');
const additionalReceipt = W.createMaterialReceipt({
  poNumber: deliveryPO.reference, invoiceNumber: 'INV-DELIVERY-ADDITIONAL', invoiceDate: '2026-10-08',
  items: [
    { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', unit: 'Nos', receivedQty: 10 },
    { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', unit: 'Nos', receivedQty: 10 }
  ]
}).receipt;
check(additionalReceipt.receiptNumber.startsWith('REC-'), 'additional original delivery uses a regular receipt');
deliveryProgress = W.getPOProgress(deliveryPO.reference);
check(deliveryProgress.pending === 0, 'new original delivery clears the ordered delivery balance');
check(deliveryProgress.totalAccepted === 196 && deliveryProgress.acceptedQuantityShortage === 20, 'receipt alone does not count as accepted before QC');
expectThrows(() => W.createMaterialReceipt({
  poNumber: deliveryPO.reference, invoiceNumber: 'INV-DELIVERY-OVER', invoiceDate: '2026-10-09',
  items: [{ materialCode: 'SHAFT', receivedQty: 1 }]
}), /exceeds PO pending quantity 0/, 'additional original delivery cannot exceed the remaining ordered quantity');

loginAs('Production Department', 'production_employee', 'Kiran Production');
const additionalQC = W.saveQualityCheck({
  receiptNumber: additionalReceipt.receiptNumber, inspectionDate: '2026-10-09', inspector: 'Kiran',
  items: [
    { materialCode: 'SHAFT', materialName: 'Shaft Collar 1/2in SS', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 },
    { materialCode: 'PROX', materialName: 'Proximity Sensor M18 PNP', receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }
  ]
});
check(additionalQC.status === W.QC_STATUS.APPROVED, 'additional original delivery passes QC');
deliveryProgress = W.getPOProgress(deliveryPO.reference);
check(deliveryProgress.originalAccepted === 196, `original accepted is now 196 (${deliveryProgress.originalAccepted})`);
check(deliveryProgress.replacementAccepted === 20, `replacement accepted remains independently tracked (${deliveryProgress.replacementAccepted})`);
check(deliveryProgress.totalAccepted === 216 && deliveryProgress.acceptedQuantityShortage === 0, 'all ordered quantity is accepted after QC');
check(deliveryProgress.status === W.PO_STATUS.FULL, 'PO fulfillment becomes Fully Received after additional QC approval');

/* ---------------------------------- summary ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
console.log('Replacement / approval flow OK');
