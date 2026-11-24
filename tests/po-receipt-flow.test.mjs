/**
 * Purchase Order → Store → Material Receipt → Quality + Purchase notification chain.
 *  and the Lot Number trail: entered by hand on the receipt, carried into the
 *  Quality Check, the stock ledger, the batch register and finally the issue slip.
 *
 *  - raising a Purchase Order notifies Store with a deep link to the receipt screen
 *  - Store recording the vendor delivery notifies Quality (Production) AND Purchase
 *    with deep links, so both departments can act on the same receipt.
 *
 * Run:  node tests/po-receipt-flow.test.mjs
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
const notifications = () => ls('notifications', []);
const clearNotifications = () => localStorage.setItem('notifications', '[]');

/* ---------------------------------- fixtures ---------------------------------- */
localStorage.setItem(
  'inventoryItems',
  JSON.stringify([{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100 }])
);
localStorage.setItem(
  'salesOrderHistory',
  JSON.stringify([
    {
      reference: 'SO-Q900',
      date: '2026-09-20',
      status: 'Approved',
      company: 'ACME Controls',
      payload: {
        soDetails: { projectId: 'PRJ-1001', projectName: 'Reactor Skid Fabrication', soDate: '2026-09-20', deliveryDate: '2026-10-20' },
        customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
        items: [
          { itemCode: 'MAT-001', itemName: 'MS Plate', quantity: 100, unit: 'Nos' },
          { itemCode: 'MAT-002', itemName: 'Hex Bolt M12', quantity: 50, unit: 'Nos' }
        ]
      }
    }
  ])
);
localStorage.setItem('supplierPOHistory', '[]');
W.ensureWorkflowSeeded();

/* ---------------------------- 1. Purchase raises the PO ---------------------------- */
section('1. Purchase raises a PO from an accepted quotation');
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.saveMaterialAvailabilityCheck({ soNumber: 'SO-Q900', remarks: 'Shortage confirmed' });
const indent = W.createPurchaseIndent({ soNumber: 'SO-Q900', reason: 'PO notification chain' });
check(Boolean(indent?.indentNumber), `purchase indent raised (${indent.indentNumber})`);

loginAs('Purchase Department', 'purchase_manager', 'Prabhu Purchase');
const enquiry = S.createVendorEnquiry({
  indentNumber: indent.indentNumber,
  items: indent.items.map((it) => ({
    materialCode: it.materialCode,
    materialName: it.materialName,
    requiredQty: it.purchaseQty,
    unit: it.unit
  })),
  vendors: [{ name: 'ABC Suppliers' }]
});
const quotation = S.createVendorQuotation({
  enquiryNumber: enquiry.enquiryNumber,
  vendorName: 'ABC Suppliers',
  quotationDate: '2026-09-28',
  items: indent.items.map((it) => ({
    materialCode: it.materialCode,
    materialName: it.materialName,
    unit: it.unit,
    requiredQty: it.purchaseQty,
    quotedQty: it.purchaseQty,
    unitPrice: 500,
    discount: 0,
    taxPct: 18,
    deliveryDays: 15
  }))
});
/* approval is Admin-only — Purchase records, the Admin approves */
expectThrows(
  () => W.acceptQuotation(quotation.quotationNumber, 'Prabhu Purchase'),
  /only the Admin/i,
  'a Purchase user cannot approve the quotation'
);
loginAs('Admin', 'admin', 'Administrator');
W.acceptQuotation(quotation.quotationNumber, 'Administrator');
loginAs('Purchase Department', 'purchase_manager', 'Prabhu Purchase');

clearNotifications();
const po = W.createPurchaseOrderFromQuotation(quotation.quotationNumber);
const poNumber = po?.payload?.poDetails?.poNumber || po?.reference;
check(Boolean(poNumber), `Purchase Order raised (${poNumber})`);

const storeNote = notifications().find(
  (n) => n.targetDept === 'Store Department' && n.reference === poNumber
);
check(Boolean(storeNote), 'Store is notified the moment the Purchase Order is raised');
check(
  Boolean(storeNote) && storeNote.link === `/material-receipts?po=${encodeURIComponent(poNumber)}`,
  `the Store notification deep-links to the receipt screen (${storeNote?.link})`
);
check(
  Boolean(storeNote) && /quality|quality and purchase/i.test(storeNote.message),
  'the Store notification explains the receipt is shared with Quality and Purchase',
  storeNote?.message
);

/* ------------------------ 2. Store records the delivery ------------------------ */
section('2. Store records the vendor delivery (Material Receipt)');
clearNotifications();
loginAs('Store Department', 'store_manager', 'Suresh Store');
const receipt = W.createMaterialReceipt({
  poNumber,
  invoiceNumber: 'INV-9001',
  invoiceDate: '2026-10-06',
  items: indent.items.map((it, i) => ({
    materialCode: it.materialCode,
    materialName: it.materialName,
    unit: it.unit,
    receivedQty: it.purchaseQty,
    batchNumber: i === 0 ? 'BATCH-77' : 'BATCH-78',
    lotNumber: i === 0 ? 'LOT-A1' : 'LOT-A2',
    mfgDate: '2026-08-01',
    expiryDate: '2027-12-31'
  }))
});
const receiptNumber = receipt?.receipt?.receiptNumber;
check(Boolean(receiptNumber), `Material Receipt recorded (${receiptNumber})`);
check(
  receipt?.receipt?.items?.[0]?.lotNumber === 'LOT-A1' && receipt?.receipt?.items?.[1]?.lotNumber === 'LOT-A2',
  'the manually entered Lot Numbers are stored on the receipt lines',
  JSON.stringify((receipt?.receipt?.items || []).map((i) => i.lotNumber))
);
check(
  receipt?.receipt?.items?.[0]?.batchNumber === 'BATCH-77',
  'the Batch No is stored alongside the lot'
);

const qcNotes = notifications().filter(
  (n) => n.targetDept === 'Production Department' && n.reference === receiptNumber
);
check(qcNotes.length > 0, 'Quality (Production) is notified of the receipt');
check(
  qcNotes.every((n) => n.link === `/quality-checks?receipt=${encodeURIComponent(receiptNumber)}`),
  `every Quality notification deep-links to the inspection (${qcNotes[0]?.link})`
);
check(
  qcNotes.some((n) => /quality check required|for Quality Check/i.test(n.title + n.message)),
  'the Quality notification asks for the inspection',
  qcNotes.map((n) => n.title).join(' | ')
);

const purchaseNotes = notifications().filter(
  (n) => n.targetDept === 'Purchase Department' && n.reference === receiptNumber
);
check(purchaseNotes.length > 0, 'Purchase is notified of the same receipt');
check(
  purchaseNotes.some((n) => n.link === `/supplier-invoice?receipt=${encodeURIComponent(receiptNumber)}`),
  `a Purchase notification deep-links to the Supplier Invoice (${purchaseNotes[0]?.link})`
);
check(
  purchaseNotes.some((n) => /Supplier Invoice|quality-approved/i.test(n.title + n.message)),
  'the Purchase notification tells Purchase to record the vendor invoice',
  purchaseNotes.map((n) => n.title).join(' | ')
);

/* --------------------- 3. Quality inspects, Purchase gets the OK --------------------- */
section('3. Quality inspects the shared receipt');
expectThrows(
  () => W.saveQualityCheck({ receiptNumber, items: [] }),
  /Permission denied|Production/,
  'Store cannot perform the Quality Check itself'
);
loginAs('Production Department', 'production_employee', 'Kiran Production');
clearNotifications();
let qc = null;
try {
  qc = W.saveQualityCheck({
    receiptNumber,
    inspectionDate: '2026-10-07',
    inspector: 'Kiran Production',
    items: indent.items.map((it, i) => ({
      materialCode: it.materialCode,
      materialName: it.materialName,
      receivedQty: it.purchaseQty,
      acceptedQty: it.purchaseQty,
      rejectedQty: 0,
      batchNumber: i === 0 ? 'BATCH-77' : 'BATCH-78',
      // line 1 deliberately carries no lot: the receipt still supplies it
      lotNumber: i === 0 ? 'LOT-A1' : ''
    }))
  });
} catch (e) {
  failed += 1;
  failures.push(`quality check failed: ${e.message}`);
  console.log(`  FAIL quality check failed: ${e.message}`);
}
check(Boolean(qc?.qcNumber), `Quality Check raised (${qc.qcNumber})`);
check(
  qc?.items?.[0]?.lotNumber === 'LOT-A1',
  'the Lot Number travels with the inspected line',
  JSON.stringify(qc?.items?.map((i) => i.lotNumber))
);
const afterQc = notifications();
check(
  afterQc.some(
    (n) =>
      n.targetDept === 'Purchase Department' &&
      (n.reference === receiptNumber || n.reference === poNumber)
  ),
  'Purchase is kept in the loop after Quality accepts the material'
);

/* ------------------- 4. Lot Number in the stock ledger ------------------- */
section('4. Lot Number reaches the stock ledger and the batch register');
loginAs('Store Department', 'store_manager', 'Suresh Store');
try {
  W.postApprovedMaterialToInventory(qc.qcNumber);
} catch (e) {
  failed += 1;
  failures.push(`inventory posting failed: ${e.message}`);
  console.log(`  FAIL inventory posting failed: ${e.message}`);
}
const inwardTxs = S.getStockTransactions().filter((t) => t.qcNumber === qc.qcNumber);
check(inwardTxs.length === 2, `accepted quantity posted to inventory (${inwardTxs.length} line(s))`);
const txFirst = inwardTxs.find((t) => t.itemCode === 'MAT-001');
check(
  Boolean(txFirst) && txFirst.batchNo === 'BATCH-77' && txFirst.lotNumber === 'LOT-A1',
  'the INWARD transaction keeps the Batch + Lot that was inspected',
  JSON.stringify(txFirst && { b: txFirst.batchNo, l: txFirst.lotNumber })
);
const txSecond = inwardTxs.find((t) => t.itemCode === 'MAT-002');
check(
  Boolean(txSecond) && txSecond.lotNumber === 'LOT-A2',
  'an inspection line without a lot falls back to the lot typed on the receipt',
  JSON.stringify(txSecond && txSecond.lotNumber)
);
const registerBatch = S.getInventoryBatches().find((b) => b.batchNumber === 'BATCH-77');
check(
  Boolean(registerBatch) && registerBatch.lotNumber === 'LOT-A1',
  'the FEFO / batch register carries the lot with the batch',
  JSON.stringify(registerBatch && registerBatch.lotNumber)
);

/* -------------------- 5. Lot Number on the issue slip -------------------- */
section('5. Lot Number reaches the Store Issue slip and the OUT transaction');
loginAs('Production Department', 'production_manager', 'Ravi Kumar');
const lotMr = S.createMaterialRequest({
  jobCardNumber: '',
  salesOrderRef: '',
  customer: 'ACME Controls',
  partName: 'Frame',
  items: [
    {
      materialId: 'MAT-001',
      materialName: 'MS Plate',
      unit: 'Nos',
      requiredQty: 4,
      sourceType: S.SOURCE_TYPE.ADDITIONAL,
      reason: 'lot traceability'
    }
  ]
});
S.submitMaterialRequest(lotMr.mrNumber);

loginAs('Store Department', 'store_manager', 'Suresh Store');
const lotSi = S.issueMaterial({
  mrNumber: lotMr.mrNumber,
  issueQtyById: { 'MAT-001': 2 },
  receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
  batchInfo: { 'MAT-001': { batchNo: 'BATCH-77' } }
});
check(
  lotSi.items[0].lotNumber === 'LOT-A1',
  'typing the batch on the issue screen pulls its lot automatically',
  JSON.stringify(lotSi.items[0].lotNumber)
);
const outTx = S.getStockTransactions().find((t) => t.transactionNumber === lotSi.issueNumber);
check(
  Boolean(outTx) && outTx.lotNumber === 'LOT-A1' && outTx.batchNo === 'BATCH-77',
  'the OUTWARD transaction carries Batch + Lot',
  JSON.stringify(outTx && { b: outTx.batchNo, l: outTx.lotNumber })
);

const manualSi = S.issueMaterial({
  mrNumber: lotMr.mrNumber,
  issueQtyById: { 'MAT-001': 2 },
  receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
  batchInfo: { 'MAT-001': { batchNo: 'BATCH-78', lotNumber: 'LOT-TYPED' } }
});
check(
  manualSi.items[0].lotNumber === 'LOT-TYPED',
  'a lot typed on the issue screen overrides the register value',
  JSON.stringify(manualSi.items[0].lotNumber)
);
loginAs('Production Department', 'production_manager', 'Ravi Kumar');
const noLotMr = S.createMaterialRequest({
  jobCardNumber: '',
  salesOrderRef: '',
  customer: 'ACME Controls',
  partName: 'Frame',
  items: [
    {
      materialId: 'RAW-001',
      materialName: 'MS Plate 10mm',
      unit: 'Nos',
      requiredQty: 1,
      sourceType: S.SOURCE_TYPE.ADDITIONAL,
      reason: 'legacy stock without captured lot'
    }
  ]
});
S.submitMaterialRequest(noLotMr.mrNumber);
loginAs('Store Department', 'store_manager', 'Suresh Store');
const blankSi = S.issueMaterial({
  mrNumber: noLotMr.mrNumber,
  issueQtyById: { 'RAW-001': 1 },
  receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true }
});
check(
  blankSi.items[0].lotNumber === '',
  'stock received before lot capture still issues with an empty lot',
  JSON.stringify(blankSi.items[0].lotNumber)
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log('PO → Store → Receipt → Quality + Purchase chain OK');
