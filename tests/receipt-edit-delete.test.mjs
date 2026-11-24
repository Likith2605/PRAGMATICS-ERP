/**
 * Edit / Delete on a Tax Invoice / Material Receipt (the View screen offers
 * ✏️ Edit and 🗑 Delete alongside the report buttons):
 *
 *  - Store can correct an unposted receipt (invoice, quantity, Batch / Lot,
 *    shelf life, documents) with every create-time rule re-checked
 *  - the receipt never blocks itself: its own quantities are excluded from the
 *    PO progress while it is edited, so an unchanged save always passes
 *  - posted, Purchase-invoiced and Debit-Note-linked receipts are frozen
 *  - delete unlinks the Quality Check and gives a replacement booking's
 *    consumed balance back to the Rejection Report
 *
 * Run:  node tests/receipt-edit-delete.test.mjs
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
const n = (v) => Number(v) || 0;

/* ---------------------------------- fixtures ---------------------------------- */
localStorage.setItem(
  'inventoryItems',
  JSON.stringify([{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', currentQty: 100 }])
);
const poFixture = (ref, date) => ({
  reference: ref,
  date,
  vendor: 'ABC Suppliers',
  status: 'Submitted',
  payload: {
    poDetails: {
      poNumber: ref,
      poDate: date,
      poStatus: 'Submitted',
      projectRef: 'PE-EDIT-1',
      salesOrderRef: 'SO-EDIT-1'
    },
    vendorDetails: { companyName: 'ABC Suppliers' },
    items: [{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', quantity: 10, unitPrice: 500, gst: 18 }],
    totals: { grandTotal: 5900 }
  }
});
localStorage.setItem(
  'supplierPOHistory',
  JSON.stringify([poFixture('PO-EDIT-001', '2026-11-01'), poFixture('PO-EDIT-002', '2026-11-02')])
);
['notifications', 'qualityChecks', 'purchaseIndents', 'materialArrivals', 'rejectionReports',
  'debitNotes', 'storeAuditLog', 'materialReceiptSequence'].forEach((k) => {
  if (!localStorage.getItem(k)) localStorage.setItem(k, '[]');
});
W.ensureWorkflowSeeded();

/* ---------------------------- 1. Store records a receipt ---------------------------- */
section('1. Store records a receipt on a legacy PO');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const r1 = W.createMaterialReceipt({
  poNumber: 'PO-EDIT-001',
  invoiceNumber: 'INV-E1',
  invoiceDate: '2026-11-01',
  items: [
    {
      materialCode: 'MAT-001',
      materialName: 'MS Plate',
      unit: 'Nos',
      receivedQty: 4,
      batchNumber: 'B-1',
      lotNumber: 'L-1',
      mfgDate: '2026-09-01'
    }
  ]
});
const rn = r1?.receipt?.receiptNumber;
check(Boolean(rn), `receipt recorded (${rn})`);

/* ---------------------------- 2. Store edits the receipt ---------------------------- */
section('2. Store edits an unposted receipt');
const upd = W.updateMaterialReceipt(rn, {
  invoiceNumber: 'INV-E1-CORR',
  invoiceDate: '2026-11-02',
  dcNumber: 'DC-55',
  remarks: 'corrected entry',
  items: [
    {
      materialCode: 'MAT-001',
      materialName: 'MS Plate',
      unit: 'Nos',
      orderedQty: 10,
      receivedQty: 6,
      batchNumber: 'B-1',
      lotNumber: 'L-2',
      mfgDate: '2026-09-01',
      expiryDate: '2027-11-30',
      remarks: 'line note'
    }
  ]
});
check(upd.receipt.invoiceNumber === 'INV-E1-CORR', `invoice number updated (${upd.receipt.invoiceNumber})`);
check(upd.receipt.dcNumber === 'DC-55', `DC number updated (${upd.receipt.dcNumber})`);
check(upd.receipt.remarks === 'corrected entry', 'remarks updated');
check(
  upd.receipt.items[0].receivedQty === 6 && upd.receipt.items[0].lotNumber === 'L-2',
  `quantity + Lot No updated (${upd.receipt.items[0].receivedQty} / ${upd.receipt.items[0].lotNumber})`
);
check(
  upd.receipt.items[0].batchNumber === 'B-1' && upd.receipt.items[0].expiryDate === '2027-11-30',
  'Batch No and shelf life carried through the edit'
);
const prog1 = W.getPOProgress('PO-EDIT-001');
check(
  n(prog1.lines[0].invoicedQty) === 6,
  `PO progress follows the edit (${prog1.lines[0].invoicedQty} invoiced)`
);
check(
  (upd.receipt.history || []).some((h) => h.action === 'Receipt edited'),
  'the edit is recorded on the receipt history'
);

/* ------------------------------ 3. edit guards ------------------------------ */
section('3. every create-time rule is re-checked on edit');
expectThrows(
  () => W.updateMaterialReceipt(rn, { items: [{ materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 99 }] }),
  /exceeds PO pending quantity/,
  'quantity above the PO pending is refused'
);
expectThrows(
  () =>
    W.updateMaterialReceipt(rn, {
      items: [{ materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 5, expiryDate: '2027-12-31' }]
    }),
  /supplier batch number or internal receipt-batch ID/,
  'an expiry date without a Batch No is refused'
);
expectThrows(
  () =>
    W.updateMaterialReceipt(rn, {
      items: [
        { materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 5, batchNumber: 'B-1', expiryDate: '2020-01-01' }
      ]
    }),
  /Expired material refused/,
  'expired material is refused'
);
expectThrows(() => W.updateMaterialReceipt(rn, { invoiceNumber: '   ' }), /Invoice Number is required/, 'an empty invoice number is refused');
expectThrows(() => W.updateMaterialReceipt('REC-NOPE', {}), /not found/, 'an unknown receipt is refused');
expectThrows(() => W.deleteMaterialReceipt('REC-NOPE'), /not found/, 'deleting an unknown receipt is refused');

const r2 = W.createMaterialReceipt({
  poNumber: 'PO-EDIT-001',
  invoiceNumber: 'INV-E2',
  invoiceDate: '2026-11-03',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', receivedQty: 2, batchNumber: 'B-2', lotNumber: 'L-3' }
  ]
});
const rn2 = r2?.receipt?.receiptNumber;
check(Boolean(rn2), `second receipt recorded (${rn2})`);
expectThrows(
  () => W.updateMaterialReceipt(rn, { invoiceNumber: 'INV-E2' }),
  /Duplicate invoice/,
  "reusing another receipt's invoice number is refused"
);

loginAs('Production Department', 'production_employee', 'Kiran Production');
expectThrows(
  () => W.updateMaterialReceipt(rn, { invoiceNumber: 'INV-E1-X' }),
  /only store|only the store/i,
  'a non-Store user cannot edit a receipt'
);
expectThrows(
  () => W.deleteMaterialReceipt(rn2),
  /only store|only the store/i,
  'a non-Store user cannot delete a receipt'
);
loginAs('Store Department', 'store_manager', 'Suresh Store');

/* ----------------------- 4. inspection caps the edit ----------------------- */
section('4. the linked inspection caps what the receipt can be edited to');
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc = W.saveQualityCheck({
  receiptNumber: rn,
  inspectionDate: '2026-11-04',
  inspector: 'Kiran Production',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 6, acceptedQty: 6, rejectedQty: 0, batchNumber: 'B-1', lotNumber: 'L-2' }
  ]
});
check(Boolean(qc?.qcNumber), `Quality Check raised (${qc?.qcNumber})`);
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () =>
    W.updateMaterialReceipt(rn, {
      items: [{ materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 7, batchNumber: 'B-1' }]
    }),
  /passed quantity 6/,
  'raising the receipt above the passed quantity is refused'
);
const upd2 = W.updateMaterialReceipt(rn, {
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', orderedQty: 10, receivedQty: 5, batchNumber: 'B-1', lotNumber: 'L-2' }
  ]
});
check(upd2.receipt.items[0].receivedQty === 5, 'the receipt can still be reduced below the passed quantity');

/* ------------------------- 5. delete an unposted receipt ------------------------- */
section('5. deleting an unposted receipt');
const del2 = W.deleteMaterialReceipt(rn2, 'duplicate entry');
check(del2?.receiptNumber === rn2, `receipt ${rn2} deleted`);
check(!W.getReceipt(rn2), 'the receipt is gone from the register');
const prog2 = W.getPOProgress('PO-EDIT-001');
check(n(prog2.lines[0].invoicedQty) === 5, `PO progress drops back (${prog2.lines[0].invoicedQty} invoiced)`);

/* --------------------------- 6. posted receipts freeze --------------------------- */
section('6. a posted receipt is frozen');
W.postApprovedMaterialToInventory(qc.qcNumber);
const posted = W.getReceipt(rn);
check(Boolean(posted?.postedToInventory), 'the receipt is marked posted to inventory');
expectThrows(
  () => W.updateMaterialReceipt(rn, { invoiceNumber: 'INV-POSTED' }),
  /no longer be edited/,
  'a posted receipt cannot be edited'
);
expectThrows(() => W.deleteMaterialReceipt(rn), /no longer be deleted/, 'a posted receipt cannot be deleted');

/* ------------------- 7. Purchase-invoiced receipts freeze ------------------- */
section('7. a receipt Purchase already recorded is frozen');
const r3 = W.createMaterialReceipt({
  poNumber: 'PO-EDIT-002',
  invoiceNumber: 'INV-E3',
  invoiceDate: '2026-11-05',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', receivedQty: 1, batchNumber: 'B-3', lotNumber: 'L-4' }
  ]
});
const rn3 = r3?.receipt?.receiptNumber;
check(Boolean(rn3), `third receipt recorded (${rn3})`);
// Purchase converts the vendor invoice into a Supplier Invoice (SupplierInvoicePage).
const rl = ls('materialReceipts', []);
const rIdx = rl.findIndex((r) => r.receiptNumber === rn3);
rl[rIdx] = { ...rl[rIdx], supplierInvoiceNumber: 'SI-7788' };
localStorage.setItem('materialReceipts', JSON.stringify(rl));
expectThrows(
  () => W.updateMaterialReceipt(rn3, { invoiceNumber: 'INV-E3-B' }),
  /Supplier Invoice SI-7788/,
  'a receipt invoiced by Purchase cannot be edited'
);
expectThrows(() => W.deleteMaterialReceipt(rn3), /Supplier Invoice SI-7788/, 'a receipt invoiced by Purchase cannot be deleted');

/* --------------------- 8. delete unlinks the inspection --------------------- */
section('8. deleting a receipt unlinks its Quality Check');
const r4 = W.createMaterialReceipt({
  poNumber: 'PO-EDIT-002',
  invoiceNumber: 'INV-E4',
  invoiceDate: '2026-11-06',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', receivedQty: 2, batchNumber: 'B-4', lotNumber: 'L-5' }
  ]
});
const rn4 = r4?.receipt?.receiptNumber;
check(Boolean(rn4), `fourth receipt recorded (${rn4})`);
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc4 = W.saveQualityCheck({
  receiptNumber: rn4,
  inspectionDate: '2026-11-07',
  inspector: 'Kiran Production',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 2, acceptedQty: 2, rejectedQty: 0, batchNumber: 'B-4', lotNumber: 'L-5' }
  ]
});
loginAs('Store Department', 'store_manager', 'Suresh Store');
check(W.getQualityCheckForReceipt(rn4)?.qcNumber === qc4?.qcNumber, 'the inspection is linked to the receipt');
W.deleteMaterialReceipt(rn4, 'wrong invoice');
check(!W.getReceipt(rn4), 'the receipt is deleted');
check(!W.getQualityCheckForReceipt(rn4), 'the Quality Check is unlinked from any receipt');
check(W.getQualityCheck(qc4?.qcNumber)?.receiptNumber === '', 'the inspection points at no receipt');

/* ------------- 9. replacement receipts keep the Rejection Report in step ------------- */
section('9. a replacement receipt keeps the Rejection Report in step');
const rejs = ls('rejectionReports', []);
rejs.push({
  rejectionNumber: 'RRN-EDIT-1',
  rejectionDate: '2026-11-01',
  qcNumber: 'QC-EDIT-1',
  poNumber: 'PO-EDIT-002',
  receiptNumber: '',
  soNumber: '',
  vendor: 'ABC Suppliers',
  status: 'With Store',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', rejectedQty: 4, replacementQty: 0, pendingReplacementQty: 4 }
  ],
  replacementQty: 0,
  pendingReplacementQty: 4,
  history: []
});
localStorage.setItem('rejectionReports', JSON.stringify(rejs));

const rr = W.createMaterialReceipt({
  poNumber: 'PO-EDIT-002',
  invoiceNumber: 'INV-R1',
  invoiceDate: '2026-11-08',
  replacementForRejection: 'RRN-EDIT-1',
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', receivedQty: 3, batchNumber: 'BR-1', lotNumber: 'LR-1' }
  ]
});
const rrn = rr?.receipt?.receiptNumber;
check(Boolean(rrn) && rr?.receipt?.isReplacement === true, `replacement receipt recorded (${rrn})`);
let report = W.getRejectionReport('RRN-EDIT-1');
check(n(report?.replacementQty) === 3, `the report consumed 3 units (${report?.replacementQty})`);
check(n(report?.pendingReplacementQty) === 1, `1 unit still outstanding (${report?.pendingReplacementQty})`);

expectThrows(
  () =>
    W.updateMaterialReceipt(rrn, {
      items: [{ materialCode: 'MAT-001', materialName: 'MS Plate', receivedQty: 5, batchNumber: 'BR-1' }]
    }),
  /exceeds the 4/,
  'a replacement can never exceed the rejected balance'
);
const updR = W.updateMaterialReceipt(rrn, {
  items: [
    { materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', orderedQty: 10, receivedQty: 4, batchNumber: 'BR-1', lotNumber: 'LR-2' }
  ]
});
check(updR.receipt.items[0].receivedQty === 4, 'the replacement can be raised up to the full rejected balance');
report = W.getRejectionReport('RRN-EDIT-1');
check(n(report?.replacementQty) === 4 && n(report?.pendingReplacementQty) === 0, 'the report follows the edit');

W.deleteMaterialReceipt(rrn, 're-booked');
check(!W.getReceipt(rrn), 'the replacement receipt is deleted');
report = W.getRejectionReport('RRN-EDIT-1');
check(n(report?.replacementQty) === 0 && n(report?.pendingReplacementQty) === 4, 'the rejected balance is given back');
check(!report?.replacementReceiptNumber, 'the report no longer points at the deleted receipt');

/* ------------------------------ 10. audit trail ------------------------------ */
section('10. audit trail');
const audit = ls('storeAuditLog', []);
check(
  audit.some((e) => e.action === 'MATERIAL RECEIPT EDITED'),
  'the edit is in the audit log',
  audit.map((e) => e.action).join(' | ')
);
check(
  audit.some((e) => e.action === 'MATERIAL RECEIPT DELETED'),
  'the delete is in the audit log',
  audit.map((e) => e.action).join(' | ')
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log('Receipt edit/delete OK');
