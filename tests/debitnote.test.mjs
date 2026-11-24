/**
 * Debit Note integration test (no framework required).
 * Run:  node tests/debitnote.test.mjs
 *
 * Covers the rejected-material credit claim:
 *   PO → Tax Invoice / Material Receipt → Quality Check (rejection) →
 *   Debit Note (draft → issued), including PO price/GST fetch, rejected-only
 *   items, remaining-quantity capping, duplicate prevention, read-only
 *   back-references and the "never create a receipt" guarantee.
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
const S = await import('../src/utils/storeService.js');

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

const ls = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
const notifications = () => ls('notifications', []);
const auditLog = () => ls('storeAuditLog', []);

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

const invQty = (code) => {
  const item = ls('inventoryItems', []).find((i) => String(i.itemCode).toLowerCase() === code.toLowerCase());
  return item ? Number(item.currentQty) : null;
};

/* ---------------------------------- fixtures ---------------------------------- */
const seed = () => {
  localStorage.setItem(
    'inventoryItems',
    JSON.stringify([{ itemCode: 'RAW-002', itemName: 'SS 304 Sheet', unit: 'Nos', currentQty: 0 }])
  );

  localStorage.setItem(
    'salesOrderHistory',
    JSON.stringify([
      {
        reference: 'SO-001',
        date: '2026-09-01',
        status: 'Open',
        company: 'ACME Controls',
        payload: {
          soDetails: { projectId: 'PRJ-SO-001', soDate: '2026-09-01' },
          customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
          items: [{ itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos' }]
        }
      }
    ])
  );

  // PO-100 carries real pricing; PO-200 deliberately has a missing rate so the
  // "no PO price" guard can be exercised.
  localStorage.setItem(
    'supplierPOHistory',
    JSON.stringify([
      {
        reference: 'PO-100',
        date: '2026-09-05',
        vendor: 'Alpha Steels',
        status: 'Submitted',
        payload: {
          poDetails: { poNumber: 'PO-100', poDate: '2026-09-05', poStatus: 'Submitted' },
          vendorDetails: {
            companyName: 'Alpha Steels',
            gstNumber: '29AAAAA0000A1Z5',
            address: '12 Industrial Area, Bengaluru'
          },
          items: [
            { itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos', unitPrice: 250, gst: 18, hsnSac: '7209' },
            { itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', quantity: 10, unit: 'Nos', unitPrice: 400, gst: 18, hsnSac: '7228' }
          ]
        }
      },
      {
        reference: 'PO-200',
        date: '2026-09-06',
        vendor: 'Beta Traders',
        status: 'Submitted',
        payload: {
          poDetails: { poNumber: 'PO-200', poDate: '2026-09-06', poStatus: 'Submitted' },
          vendorDetails: { companyName: 'Beta Traders' },
          items: [{ itemCode: 'RAW-009', itemName: 'Special Bearing', quantity: 8, unit: 'Nos', hsnSac: '8483' }]
        }
      },
      {
        // Priced but with NO gst field: a blank tax rate must not become 0%.
        reference: 'PO-300',
        date: '2026-09-07',
        vendor: 'Gamma Metals',
        status: 'Submitted',
        payload: {
          poDetails: { poNumber: 'PO-300', poDate: '2026-09-07', poStatus: 'Submitted' },
          vendorDetails: { companyName: 'Gamma Metals' },
          items: [
            { itemCode: 'RAW-011', itemName: 'Alloy Rivet', quantity: 10, unit: 'Nos', unitPrice: 120, hsnSac: '7318' }
          ]
        }
      }
    ])
  );

  W.ensureWorkflowSeeded();
};

/* Store records the delivery (creates the ONLY receipt for the PO). */
const recordReceipt = (poNumber, invoiceNumber, items) => {
  loginAs('Store Department', 'store_manager', 'Suresh Store');
  return W.createMaterialReceipt({
    poNumber,
    invoiceNumber,
    invoiceDate: '2026-09-08',
    items
  }).receipt;
};

/* =================================== scenario =================================== */
section('Setup');
seed();
check(W.getPurchaseOrders().length === 3, 'seeded 3 purchase orders');
check(ls('debitNotes', []).length === 0, 'debitNotes store starts empty');

section('1. A Debit Note needs a Rejection Report, and only rejected material');
/* PO-100 receives 20 SS 304 Sheet and 5 EN8 Bar; QC rejects part of both lines. */
const receipt = recordReceipt('PO-100', 'TAX-INV-5001', [
  { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', receivedQty: 20 },
  { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 5 }
]);
check(Boolean(receipt?.receiptNumber), `material receipt created: ${receipt?.receiptNumber}`);
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc = W.saveQualityCheck({
  receiptNumber: receipt.receiptNumber,
  inspector: 'Kiran Production',
  inspectionDate: '2026-09-10',
  items: [
    { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', receivedQty: 20, acceptedQty: 17, rejectedQty: 3, rejectionReason: 'Surface scratch' },
    { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 5, acceptedQty: 4, rejectedQty: 1, rejectionReason: 'Diameter out of tolerance' }
  ]
});
check(qc.qcNumber === 'QC-000001', `QC numbered ${qc.qcNumber}`);
const rejection = W.getRejectionReports()[0];
check(rejection?.rejectionNumber === 'RRN-000001', `rejection report ${rejection?.rejectionNumber}`);

section('2. Debit Note context auto-resolves every linked document and PO price');
loginAs('Store Department', 'store_manager', 'Suresh Store');
const ctx = W.getDebitNoteContext(rejection.rejectionNumber);
check(Boolean(ctx), 'context built for the rejection report');
check(ctx.vendor === 'Alpha Steels', `vendor resolved from the workflow (${ctx.vendor})`);
check(ctx.invoiceNumber === 'TAX-INV-5001', `vendor invoice resolved (${ctx.invoiceNumber})`);
check(ctx.receipt?.receiptNumber === receipt.receiptNumber, 'material receipt resolved');
check(ctx.qc?.qcNumber === qc.qcNumber, 'quality check resolved');
check(ctx.po?.reference === 'PO-100', 'purchase order resolved');
check(ctx.hasReceipt === true, 'context reports the receipt exists');
check(ctx.lines.length === 2, 'only the 2 rejected lines are offered');
check(ctx.lines.every((l) => l.rejectedQty > 0), 'no accepted-only line is offered');

const sheetLine = ctx.lines.find((l) => l.materialCode === 'RAW-002');
const barLine = ctx.lines.find((l) => l.materialCode === 'RAW-003');
check(sheetLine.unitPrice === 250, `PO rate fetched for SS 304 Sheet (${sheetLine.unitPrice})`);
check(sheetLine.gstPercent === 18, `PO GST fetched for SS 304 Sheet (${sheetLine.gstPercent}%)`);
check(sheetLine.hsnSac === '7209', `PO HSN fetched (${sheetLine.hsnSac})`);
check(sheetLine.rejectedQty === 3 && sheetLine.remainingQty === 3, 'rejected 3, available 3');
check(barLine.rejectedQty === 1 && barLine.remainingQty === 1, 'rejected 1, available 1');
check(ctx.totalRejectedQty === 4 && ctx.totalRemainingQty === 4, 'total rejected/available = 4');

section('3. Permission gating');
loginAs('Sales Department', 'sales_employee', 'Ravi Sales');
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-002', debitQty: 1 }] }),
  /Permission denied/,
  'sales cannot raise a Debit Note'
);

section('4. Validation guards (missing receipt / no qty / over-debit / no PO rate)');
loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => W.createDebitNote({ rejectionNumber: 'RRN-999999', items: [{ materialCode: 'RAW-002', debitQty: 1 }] }),
  /not found/,
  'unknown rejection report rejected'
);
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [] }),
  /at least one material/,
  'a Debit Note with no quantity is rejected'
);
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-002', debitQty: 4 }] }),
  /only 3 Nos of the 3 rejected is still unclaimed/,
  'debit qty above the rejected qty is rejected'
);
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-002', debitQty: 1 }, { materialCode: 'RAW-002', debitQty: 1 }] }),
  /listed twice/,
  'the same material cannot be listed twice'
);
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-001', materialName: 'MS Plate 10mm', debitQty: 1 }] }),
  /not a rejected line/,
  'a non-rejected material cannot be debited'
);

/* PO-200 has no rate → the claim must be blocked rather than priced at zero. */
const receipt2 = recordReceipt('PO-200', 'TAX-INV-5002', [
  { materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 8 }
]);
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc2 = W.saveQualityCheck({
  receiptNumber: receipt2.receiptNumber,
  inspector: 'Kiran Production',
  inspectionDate: '2026-09-11',
  items: [{ materialCode: 'RAW-009', materialName: 'Special Bearing', unit: 'Nos', receivedQty: 8, acceptedQty: 6, rejectedQty: 2, rejectionReason: 'Bore size out of tolerance' }]
});
const rejection2 = W.getRejectionReports().find((r) => r.qcNumber === qc2.qcNumber);
check(Boolean(rejection2), 'second rejection report created');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const ctx2 = W.getDebitNoteContext(rejection2.rejectionNumber);
check(ctx2.lines[0].priceMissing === true, 'context flags the missing PO rate');
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection2.rejectionNumber, items: [{ materialCode: 'RAW-009', debitQty: 1 }] }),
  /has no rate for "Special Bearing"/,
  'a Debit Note cannot be raised without the PO rate'
);
check(ls('debitNotes', []).length === 0, 'no Debit Note was persisted by any failed attempt');

/* PO-300 is priced but carries no gst field. Defaulting it to 0% would raise a
   tax-free credit note, so the claim must be blocked too. */
const receipt3 = recordReceipt('PO-300', 'TAX-INV-5003', [
  { materialCode: 'RAW-011', materialName: 'Alloy Rivet', unit: 'Nos', receivedQty: 10 }
]);
loginAs('Production Department', 'production_employee', 'Kiran Production');
const qc3 = W.saveQualityCheck({
  receiptNumber: receipt3.receiptNumber,
  inspector: 'Kiran Production',
  inspectionDate: '2026-09-12',
  items: [
    { materialCode: 'RAW-011', materialName: 'Alloy Rivet', unit: 'Nos', receivedQty: 10, acceptedQty: 8, rejectedQty: 2, rejectionReason: 'Head dimension out of tolerance' }
  ]
});
const rejection3 = W.getRejectionReports().find((r) => r.qcNumber === qc3.qcNumber);
check(Boolean(rejection3), 'third rejection report created (priced PO, no GST rate)');

loginAs('Store Department', 'store_manager', 'Suresh Store');
const ctx3 = W.getDebitNoteContext(rejection3.rejectionNumber);
check(ctx3.lines[0].priceMissing === false, 'context does not flag a missing rate on PO-300');
check(ctx3.lines[0].gstMissing === true, 'context flags the missing PO GST rate');
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection3.rejectionNumber, items: [{ materialCode: 'RAW-011', debitQty: 1 }] }),
  /has no GST rate for "Alloy Rivet"/,
  'a Debit Note cannot be raised without the PO GST rate'
);
check(ls('debitNotes', []).length === 0, 'still no Debit Note was persisted by the GST failure');

section('5. Create the Debit Note — prices and GST come from the PO only');
/* Baseline captured here: both receipts now exist and stay exactly as they are. */
const receiptCountBefore = ls('materialReceipts', []).length;
const note = W.createDebitNote({
  rejectionNumber: rejection.rejectionNumber,
  debitNoteDate: '2026-09-12',
  remarks: 'Credit note for material failed at inspection.',
  items: [
    { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', debitQty: 2 },
    { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', debitQty: 1 }
  ]
});
check(note.debitNoteNumber === 'DN-000001', `debit note numbered ${note.debitNoteNumber}`);
check(note.status === W.DEBIT_NOTE_STATUS.DRAFT, 'a new Debit Note starts as Draft');
check(note.receiptNumber === receipt.receiptNumber, 'receipt reference stored');
check(note.invoiceNumber === 'TAX-INV-5001', 'vendor invoice reference stored');
check(note.qcNumber === qc.qcNumber, 'QC reference stored');
check(note.rejectionNumber === rejection.rejectionNumber, 'rejection reference stored');
check(note.poNumber === 'PO-100', 'PO reference stored');
check(note.vendorGstNumber === '29AAAAA0000A1Z5', 'vendor GSTIN resolved from the PO');

const sheet = note.items.find((i) => i.materialCode === 'RAW-002');
check(sheet.unitPrice === 250, 'unit price copied from the PO (not typed)');
check(sheet.gstPercent === 18, 'GST percent copied from the PO (not typed)');
check(sheet.amount === 500, `taxable amount 2 × 250 = ${sheet.amount}`);
check(sheet.gstAmount === 90, `GST amount 18% of 500 = ${sheet.gstAmount}`);
check(sheet.lineTotal === 590, `line total = ${sheet.lineTotal}`);
const bar = note.items.find((i) => i.materialCode === 'RAW-003');
check(bar.amount === 400 && bar.gstAmount === 72 && bar.lineTotal === 472, 'second line priced from the PO');
check(note.subtotal === 900, `subtotal = ${note.subtotal}`);
check(note.totalGST === 162, `total GST = ${note.totalGST}`);
check(note.cgst === 81 && note.sgst === 81, 'GST split evenly into CGST / SGST like the PO');
check(note.grandTotal === 1062, `grand total = ${note.grandTotal}`);
check(/One Thousand Sixty Two Rupees only/i.test(note.amountInWords), `amount in words: "${note.amountInWords}"`);
check(note.totalDebitQty === 3, 'total debit quantity = 3');

section('6. A Draft cannot be issued; Admin approval is mandatory');
const ctxDraft = W.getDebitNoteContext(rejection.rejectionNumber);
check(ctxDraft.lines.find((l) => l.materialCode === 'RAW-002').remainingQty === 3, 'a Draft leaves the full balance available');

expectThrows(
  () => W.issueDebitNote(note.debitNoteNumber),
  /submit it for Admin approval/,
  'a Draft cannot be issued directly — the Draft → Issue shortcut is closed'
);

/* Store submits → straight to the Admin (not to Purchase). */
const submitted = W.submitDebitNoteRequest(note.debitNoteNumber);
check(submitted.status === W.DEBIT_NOTE_STATUS.ADMIN_REVIEW, `submitted → ${submitted.status} (awaiting Admin approval)`);
check(
  ls('notifications', []).some((n) => n.targetDept === 'Admin' && /approval/i.test(n.title || '')),
  'the Admin is notified that a Debit Note awaits approval'
);
check(
  ls('notifications', []).some((n) => n.targetDept === 'Store Department' && n.reference === note.debitNoteNumber),
  'Store keeps visibility of its own request'
);

/* Purchase may NOT act before the Admin approves. */
expectThrows(
  () => W.issueDebitNote(note.debitNoteNumber),
  /awaiting Admin approval/,
  'Purchase cannot issue a Debit Note the Admin has not approved'
);
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
expectThrows(
  () => W.issueDebitNote(note.debitNoteNumber),
  /awaiting Admin approval/,
  'Purchase Manager cannot bypass the Admin approval either'
);

/* Admin approves → handed over to Purchase, with the rejection reasons. */
loginAs('Admin', 'admin', 'Ravi Admin');
const approved = W.approveDebitNoteByAdmin(note.debitNoteNumber);
check(approved.status === W.DEBIT_NOTE_STATUS.APPROVED, `Admin approved → ${approved.status}`);
check(
  ls('notifications', []).some((n) => n.targetDept === 'Purchase Department' && /Rejection reasons:/i.test(n.message || '')),
  'Purchase is handed the Debit Note together with the rejection reasons'
);

loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
const issued = W.issueDebitNote(note.debitNoteNumber);
check(issued.status === W.DEBIT_NOTE_STATUS.ISSUED, `Debit Note issued (status ${issued.status})`);
check(issued.issuedBy === 'Priya Purchase', 'issuing user recorded (Purchase)');
check(
  issued.history.some((h) => /approved by Admin before issue/i.test(h.details || '')),
  'history records that the Admin approved it before issue'
);

const ctxAfter = W.getDebitNoteContext(rejection.rejectionNumber);
check(ctxAfter.lines.find((l) => l.materialCode === 'RAW-002').remainingQty === 1, '2 of 3 SS 304 Sheet now claimed, 1 remains');
check(ctxAfter.lines.find((l) => l.materialCode === 'RAW-003').remainingQty === 0, 'the 1 EN8 Bar is fully claimed');
check(ctxAfter.totalDebitedQty === 3, 'total debited = 3');
check(ctxAfter.totalRemainingQty === 1, 'total remaining = 1');
check(ctxAfter.fullyDebited === false, 'the rejection is not fully debited yet');

const summary = W.getDebitNoteSummaryForRejection(rejection.rejectionNumber);
check(summary.count === 1 && summary.committedQty === 3, 'summary reports the committed quantity');
check(summary.committedValue === 1062, `summary committed value = ${summary.committedValue}`);

expectThrows(() => W.issueDebitNote(note.debitNoteNumber), /already issued/, 'an issued Debit Note cannot be issued twice');
expectThrows(
  () => W.updateDebitNote(note.debitNoteNumber, { items: [{ materialCode: 'RAW-002', debitQty: 1 }] }),
  /can no longer be edited/,
  'an issued Debit Note is locked'
);

section('7. Duplicate prevention across multiple Debit Notes');
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-003', debitQty: 1 }] }),
  /only 0 Nos of the 1 rejected is still unclaimed/,
  'a fully debited material cannot be claimed again'
);
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-002', debitQty: 3 }] }),
  /only 1 Nos of the 3 rejected is still unclaimed/,
  'a second Debit Note cannot re-claim the already debited quantity'
);

section('8. Partial Debit Notes accumulate to the rejected quantity exactly');
const partial = W.createDebitNote({
  rejectionNumber: rejection.rejectionNumber,
  debitNoteDate: '2026-09-14',
  items: [{ materialCode: 'RAW-002', materialName: 'SS 304 Sheet', debitQty: 1 }]
});
check(partial.debitNoteNumber === 'DN-000002', `second debit note numbered ${partial.debitNoteNumber}`);
W.submitDebitNoteRequest(partial.debitNoteNumber);
loginAs('Admin', 'admin', 'Ravi Admin');
W.approveDebitNoteByAdmin(partial.debitNoteNumber);
loginAs('Purchase Department', 'purchase_manager', 'Priya Purchase');
W.issueDebitNote(partial.debitNoteNumber);

const ctxFinal = W.getDebitNoteContext(rejection.rejectionNumber);
check(ctxFinal.totalDebitedQty === 4, 'cumulative debited = 4');
check(ctxFinal.totalRemainingQty === 0, 'nothing left to claim');
check(ctxFinal.fullyDebited === true, 'the rejection is now fully debited');
expectThrows(
  () => W.createDebitNote({ rejectionNumber: rejection.rejectionNumber, items: [{ materialCode: 'RAW-002', debitQty: 1 }] }),
  /only 0 Nos of the 3 rejected is still unclaimed/,
  'no further Debit Note can be raised once everything is claimed'
);

const rejectionFinal = W.getRejectionReport(rejection.rejectionNumber);
check(
  JSON.stringify(rejectionFinal.debitNoteNumbers) === JSON.stringify(['DN-000001', 'DN-000002']),
  `rejection report lists both debit notes (${rejectionFinal.debitNoteNumbers})`
);
check(rejectionFinal.debitNoteQty === 4, `rejection report debited qty = ${rejectionFinal.debitNoteQty}`);
check(rejectionFinal.items[0].rejectedQty === 3, 'the rejection rejected quantity is unchanged');

section('9. No receipt was created and nothing was mutated');
check(receiptCountBefore === 3, 'all 3 receipts existed before any Debit Note was raised');
check(ls('materialReceipts', []).length === receiptCountBefore, 'no extra material receipt was created by any Debit Note');
check(ls('materialReceipts', []).length === 3, 'exactly the 3 manually recorded receipts exist');
check(
  ls('materialReceipts', []).every((r) => !r.debitNoteNumber),
  'the receipt records themselves are untouched by the Debit Note'
);
check(
  ls('qualityChecks', []).every((q) => !q.debitNoteNumber),
  'the quality check records are untouched by the Debit Note'
);
check(
  ls('supplierPOHistory', [])[0].payload.items[0].unitPrice === 250,
  'the purchase order is unchanged'
);
check(invQty('RAW-002') === 0, 'rejected material was never added to inventory');
const stockTxs = ls('stockTransactions', []);
check(!stockTxs.some((t) => String(t.reference || '').startsWith('DN-')), 'no stock transaction was created for a Debit Note');

section('10. Lookups, audit trail and notifications');
check(W.getDebitNote('DN-000001').debitNoteNumber === 'DN-000001', 'getDebitNote by number');
check(W.getDebitNotes().length === 2, 'two Debit Notes stored');
check(W.getDebitNotesForRejection(rejection.rejectionNumber).length === 2, 'lookup by rejection report');
check(W.getDebitNotesForQualityCheck(qc.qcNumber).length === 2, 'lookup by quality check');
check(W.getDebitNotesForReceipt(receipt.receiptNumber).length === 2, 'lookup by material receipt');

check(
  auditLog().some((a) => a.action === 'DEBIT NOTE DRAFTED' && a.reference === 'DN-000001'),
  'DEBIT NOTE DRAFTED written to the audit log'
);
check(
  auditLog().some((a) => a.action === 'DEBIT NOTE ISSUED' && a.reference === 'DN-000001'),
  'DEBIT NOTE ISSUED written to the audit log'
);
check(
  notifications().some((n) => String(n.title).includes('DN-000001') && n.targetDept === 'Purchase Department'),
  'Purchase notified about the issued Debit Note'
);
check(
  W.getDebitNote('DN-000001').history.length >= 2,
  'Debit Note keeps its own history (drafted + issued)'
);

section('11. Migration is additive and safe');
const before = ls('debitNotes', []).length;
W.migrateWorkflowRecords();
check(ls('debitNotes', []).length === before, 'migrateWorkflowRecords does not drop Debit Notes');
check(ls('debitNotes', []).every((d) => d.status && Array.isArray(d.items) && Array.isArray(d.history)), 'migrated Debit Notes keep normalised fields');
check(
  W.getDebitNote('DN-000001').grandTotal === 1062,
  'an issued Debit Note keeps its stored figures after migration'
);

check(S.getInventoryItems().length >= 1, 'inventory module still readable — no side effects');

/* ---------------------------------- summary ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('Debit Note workflow OK');
