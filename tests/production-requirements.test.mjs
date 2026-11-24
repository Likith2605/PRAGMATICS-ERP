/**
 * Production Item Requirement workflow test (no framework required).
 * Run:  node tests/production-requirements.test.mjs
 *
 * Covers:
 *   Production creates Required Item List → submit to Store (notification) →
 *   Store stock review (available/shortage math) → Purchase Indent from shortage
 *   (duplicate protection) → Purchase Completed → Material Available → Completed,
 *   plus permissions, validation, deep links and audit trail.
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

const P = await import('../src/utils/productionRequirementService.js');
const W = await import('../src/utils/workflowService.js');
const { REQUIREMENT_STATUS } = P;

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
const requirements = () => ls('productionRequirements', []);
const indents = () => ls('purchaseIndents', []);

/* ---------------------------------- fixtures ---------------------------------- */
localStorage.setItem(
  'inventoryItems',
  JSON.stringify([
    { id: 'INV-RAW-001', itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100, reservedQty: 20 },
    { id: 'INV-RAW-003', itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', unit: 'Nos', currentQty: 10, reservedQty: 0 }
    // RAW-002 (SS 304 Sheet) intentionally missing → no stock
  ])
);

const soRow = (reference, items) => ({
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
    soRow('SO-001', [
      { itemCode: 'RAW-001', itemName: 'MS Plate 10mm', quantity: 50, unit: 'Nos' },
      { itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos' },
      { itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', quantity: 15, unit: 'Nos' }
    ]),
    soRow('SO-002', [{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', quantity: 30, unit: 'Nos' }])
  ])
);

const baseItems = () => [
  { itemName: 'MS Plate 10mm', itemCode: 'RAW-001', description: '10mm MS plate', specification: 'IS2062', quantity: 50, unit: 'Nos', requiredDate: '2026-10-20' },
  { itemName: 'SS 304 Sheet', itemCode: 'RAW-002', description: '2mm sheet', specification: '304 grade', quantity: 20, unit: 'Nos', requiredDate: '2026-10-22' },
  { itemName: 'EN8 Bar 25mm', itemCode: 'RAW-003', description: 'EN8 round bar', specification: '', quantity: 15, unit: 'Nos', requiredDate: '2026-10-25' }
];

const newDraft = (label = 'PR-TEST') => {
  loginAs('Production Department', 'production_manager', 'Kiran Production');
  return P.createRequirement({
    projectId: `PRJ-${label}`,
    soNumber: 'SO-001',
    jobCardNumber: 'JC-0007',
    customer: 'ACME Controls Pvt Ltd',
    partName: 'Control Panel Frame',
    productionJob: 'Batch A — Machining',
    requiredDate: '2026-10-25',
    items: baseItems()
  });
};

/* ========================================================================== */
section('1. Permissions and validation');
/* ========================================================================== */

loginAs('Sales Department', 'sales_employee', 'Ravi Sales');
expectThrows(
  () => P.createRequirement({ projectId: 'PRJ-X', items: baseItems() }),
  /Permission denied/,
  'Sales cannot create an Item Requirement'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => P.createRequirement({ projectId: 'PRJ-X', items: baseItems() }),
  /Production Department/,
  'Store cannot create an Item Requirement'
);

/* Item Requirements are a Production MANAGER responsibility. */
loginAs('Production Department', 'production_employee', 'Kiran Production');
expectThrows(
  () => P.createRequirement({ projectId: 'PRJ-X', items: baseItems() }),
  /Permission denied/,
  'Production Employee cannot create an Item Requirement (Production Manager only)'
);

loginAs('Production Department', 'production_manager', 'Kiran Production');
expectThrows(
  () => P.createRequirement({ projectId: '', items: baseItems() }),
  /Project ID is required/,
  'Project ID is mandatory'
);
expectThrows(
  () => P.createRequirement({ projectId: 'PRJ-1', items: [] }),
  /at least one item/,
  'at least one item is mandatory'
);
expectThrows(
  () =>
    P.createRequirement({
      projectId: 'PRJ-1',
      items: [{ itemName: 'MS Plate 10mm', quantity: 0 }]
    }),
  /quantity must be greater than zero/,
  'item quantity must be > 0'
);
expectThrows(
  () =>
    P.createRequirement({
      projectId: 'PRJ-1',
      items: [{ itemName: '', quantity: 5 }]
    }),
  /select a material\/item from Inventory/i,
  'item material must come from the Inventory Item Master'
);

/* ========================================================================== */
section('2. Create / edit / delete (Production)');
/* ========================================================================== */

const pr1 = newDraft('001');
check(pr1.requirementNumber === 'PR-000001', `first requirement numbered ${pr1.requirementNumber}`);
check(pr1.status === REQUIREMENT_STATUS.DRAFT, 'created as Draft');
check(pr1.items.length === 3, '3 item lines stored');
check(pr1.items[0].lineId && pr1.items[1].lineId && pr1.items[0].lineId !== pr1.items[1].lineId, 'every line gets a unique lineId');
check(pr1.items[0].specification === 'IS2062', 'specification preserved on the line');
check(
  pr1.history.some((h) => h.action === 'Requirement created'),
  'history carries creation entry'
);
check(
  auditLog().some((a) => a.action === 'PRODUCTION REQUIREMENT CREATED' && a.reference === 'PR-000001'),
  'audit log: PRODUCTION REQUIREMENT CREATED'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => P.updateRequirement('PR-000001', { productionJob: 'X' }),
  /Production Department/,
  'Store cannot edit a requirement'
);

loginAs('Production Department', 'production_manager', 'Kiran Production');
const pr1Edited = P.updateRequirement('PR-000001', {
  productionJob: 'Batch A — Machining (revised)',
  items: pr1.items.map((it, idx) => (idx === 0 ? { ...it, quantity: 40 } : it))
});
check(pr1Edited.productionJob.includes('revised'), 'Production can edit the draft header');
check(pr1Edited.items[0].quantity === 40, 'edited line quantity saved');
check(
  pr1Edited.items[0].lineId === pr1.items[0].lineId,
  'existing lineIds survive an edit (stable for store review)'
);

const pr2 = newDraft('002');
check(pr2.requirementNumber === 'PR-000002', `second requirement numbered ${pr2.requirementNumber} (sequence continues)`);

/* ========================================================================== */
section('3. Submit to Store (notification + status)');
/* ========================================================================== */

loginAs('Production Department', 'production_manager', 'Kiran Production');
const submitted = P.submitRequirement('PR-000001');
check(submitted.status === REQUIREMENT_STATUS.PENDING_REVIEW, 'status → Pending Review');
check(Boolean(submitted.submittedAt), 'submittedAt stamped');

const storeNotif = notifications().find(
  (n) => n.reference === 'PR-000001' && n.targetDept === 'Store Department'
);
check(Boolean(storeNotif), 'Store notified about the submission');
check(
  storeNotif?.link === '/store/item-requirements?req=PR-000001',
  `notification deep-links to the review page → "${storeNotif?.link}"`
);
check(
  auditLog().some((a) => a.action === 'REQUIREMENT SUBMITTED TO STORE' && a.reference === 'PR-000001'),
  'audit log: REQUIREMENT SUBMITTED TO STORE'
);

expectThrows(
  () => P.updateRequirement('PR-000001', { productionJob: 'Y' }),
  /Only Draft/,
  'cannot edit after submission'
);
expectThrows(() => P.deleteRequirement('PR-000001'), /Only Draft/, 'cannot delete after submission');
expectThrows(() => P.submitRequirement('PR-000001'), /Only Draft/, 'double submit is rejected');

/* ========================================================================== */
section('4. Store stock review (available / shortage math)');
/* ========================================================================== */

loginAs('Production Department', 'production_manager', 'Kiran Production');
expectThrows(
  () => P.saveStoreReview('PR-000001', {}),
  /Store Department/,
  'Production cannot run the Store review'
);

loginAs('Store Department', 'store_manager', 'Suresh Store');
let review = P.saveStoreReview('PR-000001', {
  remarks: 'RAW-001 partially reserved for SO-009.',
  lineRemarks: {}
});
let lines = review.lines;
check(lines.length === 3, 'review covers all 3 lines');

const plate = lines.find((l) => l.itemCode === 'RAW-001');
const sheet = lines.find((l) => l.itemCode === 'RAW-002');
const bar = lines.find((l) => l.itemCode === 'RAW-003');

check(plate.currentStock === 100 && plate.reservedQty === 20, 'MS Plate stock 100 / reserved 20');
check(plate.availableQty === 80, `MS Plate available = max(0, 100-20) = ${plate.availableQty}`);
check(plate.shortageQty === 0, `MS Plate (req 40 after edit) shortage = ${plate.shortageQty} (available)`);
check(sheet.inventoryMatched === false, 'SS 304 Sheet not found in inventory');
check(sheet.availableQty === 0 && sheet.shortageQty === 20, 'SS 304 Sheet (req 20) shortage = 20');
check(bar.availableQty === 10 && bar.shortageQty === 5, 'EN8 Bar (req 15, stock 10) shortage = 5');
check(bar.remainingShortageQty === 5, 'EN8 Bar pending shortage = 5 before indents');
check(
  review.requirement.status === REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED,
  'status → Shortage Identified'
);
check(
  review.requirement.storeReview.reviewedBy === 'Suresh Store',
  `reviewer recorded (${review.requirement.storeReview.reviewedBy})`
);

const prodNotif = notifications().find(
  (n) => n.reference === 'PR-000001' && n.targetDept === 'Production Department'
);
check(Boolean(prodNotif), 'Production notified about the saved review');
check(
  prodNotif?.link === '/production/item-requirements?req=PR-000001',
  `review notification deep-links to Production → "${prodNotif?.link}"`
);
check(
  auditLog().some((a) => a.action === 'PRODUCTION REQUIREMENT REVIEWED' && a.reference === 'PR-000001'),
  'audit log: PRODUCTION REQUIREMENT REVIEWED'
);

/* Stock-available path (second requirement) */
const pr3 = (() => {
  loginAs('Production Department', 'production_manager', 'Kiran Production');
  const rec = P.createRequirement({
    projectId: 'PRJ-003',
    items: [
      { itemName: 'MS Plate 10mm', itemCode: 'RAW-001', quantity: 10, unit: 'Nos' }
    ]
  });
  P.submitRequirement(rec.requirementNumber);
  return rec;
})();
loginAs('Store Department', 'store_manager', 'Suresh Store');
const okReview = P.saveStoreReview(pr3.requirementNumber, {});
check(
  okReview.requirement.status === REQUIREMENT_STATUS.STOCK_AVAILABLE,
  'fully-stocked requirement → Stock Available'
);
check(
  okReview.lines[0].shortageQty === 0,
  `stock-available line shortage = ${okReview.lines[0].shortageQty}`
);

/* ========================================================================== */
section('5. Purchase Indent from shortage (duplicate protection)');
/* ========================================================================== */

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => P.createIndentFromRequirement({ requirementNumber: 'PR-000001', lineIds: [plate.lineId] }),
  /Select at least one shortage line/,
  'no-shortage line (MS Plate) cannot be indented'
);

const indent1 = P.createIndentFromRequirement({
  requirementNumber: 'PR-000001',
  lineIds: [sheet.lineId],
  reason: 'Urgent — SS 304 sheet',
  remarks: 'Vendor lead time 7 days',
  requiredDate: '2026-10-18'
});
check(indent1.indentNumber === 'IND-000001', `indent created ${indent1.indentNumber}`);
check(indent1.requirementNumber === 'PR-000001', 'indent carries requirementNumber traceability');
check(indent1.sourceType === 'productionRequirement', 'indent sourceType = productionRequirement');
check(indent1.productionJob === 'Batch A — Machining (revised)', 'indent carries production job');
check(indent1.projectId === 'PRJ-001', `indent projectId = ${indent1.projectId}`);
check(indent1.items.length === 1, 'only the shortage line becomes indent item');
check(indent1.items[0].purchaseQty === 20, `indent purchaseQty = ${indent1.items[0].purchaseQty} (shortage)`);
check(indent1.items[0].specification === '304 grade', 'specification flows into the indent item');
check(
  indent1.items[0].source === 'Production Requirement Shortage',
  `indent item source = "${indent1.items[0].source}"`
);
check(indent1.reason === 'Urgent — SS 304 sheet', 'custom reason stored');

let pr1Rec = P.getRequirement('PR-000001');
check(pr1Rec.status === REQUIREMENT_STATUS.PURCHASE_REQUIRED, 'requirement → Purchase Required');
check(
  pr1Rec.indentNumbers.includes('IND-000001'),
  `requirement links indent ${pr1Rec.indentNumbers.join(', ')}`
);
check(
  auditLog().some((a) => a.action === 'REQUIREMENT INDENT CREATED' && a.reference === 'PR-000001'),
  'audit log: REQUIREMENT INDENT CREATED'
);
const purchNotif = notifications().find(
  (n) => n.reference === 'IND-000001' && n.targetDept === 'Purchase Department'
);
check(Boolean(purchNotif), 'Purchase notified about the new indent');

/* Partial indent → remaining shortage recomputed */
lines = P.computeRequirementLines('PR-000001');
const sheetAfter = lines.find((l) => l.lineId === sheet.lineId);
const barAfter = lines.find((l) => l.lineId === bar.lineId);
check(sheetAfter.indentedQty === 20, `SS 304 already indented = ${sheetAfter.indentedQty}`);
check(sheetAfter.remainingShortageQty === 0, 'SS 304 pending shortage now 0 (dup-protected)');
check(barAfter.remainingShortageQty === 5, 'EN8 pending shortage still 5 (not yet indented)');

expectThrows(
  () => P.createIndentFromRequirement({ requirementNumber: 'PR-000001', lineIds: [sheet.lineId] }),
  /Select at least one shortage line/,
  're-indenting an already-indented line is rejected'
);

const indent2 = P.createIndentFromRequirement({ requirementNumber: 'PR-000001' });
check(indent2.indentNumber === 'IND-000002', `second indent ${indent2.indentNumber} covers remaining shortage only`);
check(indent2.items.length === 1 && indent2.items[0].materialCode === 'RAW-003', 'second indent contains EN8 only');
check(indent2.items[0].purchaseQty === 5, `EN8 purchaseQty = ${indent2.items[0].purchaseQty}`);

expectThrows(
  () => P.createIndentFromRequirement({ requirementNumber: 'PR-000001' }),
  /No pending shortage/,
  'fully-indented requirement rejects further indents'
);

/* Cancelled indent frees the shortage again */
loginAs('Store Department', 'store_manager', 'Suresh Store');
W.cancelIndent('IND-000002', 'Vendor cannot deliver in time');
lines = P.computeRequirementLines('PR-000001');
const barCancelled = lines.find((l) => l.lineId === bar.lineId);
check(barCancelled.indentedQty === 0, 'cancelled indent no longer counts as indented');
check(barCancelled.remainingShortageQty === 5, 'pending shortage restored to 5 after cancellation');
const indent2b = P.createIndentFromRequirement({ requirementNumber: 'PR-000001' });
check(indent2b.indentNumber === 'IND-000003', `re-raise after cancellation → ${indent2b.indentNumber}`);

const linked = P.getRequirementIndents('PR-000001');
check(linked.length === 3, `linked indents view returns ${linked.length} indents`);
check(linked.every((i) => i.indentNumber && i.status), 'linked indent rows carry number + status');

/* ========================================================================== */
section('6. Status transitions to completion');
/* ========================================================================== */

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => P.completeRequirement('PR-000001'),
  /Material Available/,
  'cannot complete before material is available'
);

P.markPurchaseCompleted('PR-000001');
pr1Rec = P.getRequirement('PR-000001');
check(pr1Rec.status === REQUIREMENT_STATUS.PURCHASE_COMPLETED, 'Purchase Required → Purchase Completed');
expectThrows(
  () => P.markPurchaseCompleted('PR-000001'),
  /Purchase Required/,
  'double purchase-completed is rejected'
);

P.markMaterialAvailable('PR-000001');
pr1Rec = P.getRequirement('PR-000001');
check(pr1Rec.status === REQUIREMENT_STATUS.MATERIAL_AVAILABLE, 'Purchase Completed → Material Available');

loginAs('Production Department', 'production_manager', 'Kiran Production');
P.completeRequirement('PR-000001');
pr1Rec = P.getRequirement('PR-000001');
check(pr1Rec.status === REQUIREMENT_STATUS.COMPLETED, 'Material Available → Completed');
check(
  pr1Rec.history.some((h) => h.action === 'Requirement completed'),
  'completion recorded in history'
);
expectThrows(
  () => P.completeRequirement('PR-000001'),
  /Material Available/,
  'double completion is rejected'
);
expectThrows(() => P.submitRequirement('PR-000001'), /Only Draft/, 'completed requirement cannot be resubmitted');

loginAs('Store Department', 'store_manager', 'Suresh Store');
expectThrows(
  () => P.createIndentFromRequirement({ requirementNumber: 'PR-000001' }),
  /cannot raise a Purchase Indent/,
  'no indents from a completed requirement'
);
expectThrows(
  () => P.saveStoreReview('PR-000001', {}),
  /cannot be reviewed/,
  'no review on a completed requirement'
);

/* Stock-available requirement completes directly */
P.markMaterialAvailable(pr3.requirementNumber);
P.completeRequirement(pr3.requirementNumber);
check(
  P.getRequirement(pr3.requirementNumber).status === REQUIREMENT_STATUS.COMPLETED,
  'Stock Available requirement can go straight to Completed'
);

/* ========================================================================== */
section('7. Cancel, summary and sequencing');
/* ========================================================================== */

loginAs('Production Department', 'production_manager', 'Kiran Production');
const pr4 = P.createRequirement({
  projectId: 'PRJ-004',
  items: [{ itemName: 'MS Plate 10mm', itemCode: 'RAW-001', quantity: 5, unit: 'Nos' }]
});
expectThrows(
  () => P.deleteRequirement(pr3.requirementNumber),
  /Only Draft/,
  'non-draft requirement cannot be deleted (data preserved)'
);
const pr4b = P.cancelRequirement(pr4.requirementNumber, 'Not needed anymore');
check(pr4b.status === REQUIREMENT_STATUS.CANCELLED, 'draft requirement can be cancelled');
check(
  P.getRequirement(pr4.requirementNumber).status === REQUIREMENT_STATUS.CANCELLED,
  'cancelled record retained (not deleted)'
);

const summary = P.getRequirementSummary();
check(summary.total === 4, `summary sees all 4 requirements (total=${summary.total})`);
check(summary.completed === 2, `summary completed = ${summary.completed}`);
check(summary.drafts === 1, `summary drafts = ${summary.drafts} (PR-000002 never submitted)`);
check(
  P.getRequirementsAwaitingStoreReview().length === 0,
  'nothing awaiting review at the end'
);
check(
  P.getRequirementsForSO('SO-001').length === 2,
  'requirements are findable by Sales Order reference'
);

const numbers = P.getRequirements().map((r) => r.requirementNumber);
check(
  new Set(numbers).size === numbers.length,
  `requirement numbers unique: ${numbers.join(', ')}`
);

/* ========================================================================== */
section('8. Legacy Sales Order workflow untouched');
/* ========================================================================== */

loginAs('Store Department', 'store_manager', 'Suresh Store');
const checkRec = W.saveMaterialAvailabilityCheck({ soNumber: 'SO-001', remarks: 'legacy path' });
check(checkRec.lines.length === 3, 'legacy SO availability check still works (3 lines)');
const legacyPlate = checkRec.lines.find((l) => l.materialCode === 'RAW-001');
check(
  legacyPlate?.availableStock === 100 && legacyPlate?.shortageQty === 0,
  'legacy check still uses currentQty-only stock (RAW-001: stock 100, no shortage)'
);
const legacyIndent = W.createPurchaseIndent({
  soNumber: 'SO-001',
  reason: 'Shortage against Sales Order',
  selectedCodes: ['RAW-002', 'RAW-003']
});
check(legacyIndent.soNumber === 'SO-001', 'legacy SO-based indent still created');
check(legacyIndent.requirementNumber === undefined, 'legacy indent has no requirementNumber (old shape preserved)');
check(legacyIndent.items.every((i) => i.source === 'Sales Order Shortage'), 'legacy items keep SO Shortage source');
check(
  W.getSalesOrdersAwaitingCheck().length >= 1,
  'awaiting-check projection still available for old screens'
);

/* ========================================================================== */
section('9. Inventory Item Master selection (itemId)');
/* ========================================================================== */

loginAs('Production Department', 'production_manager', 'Kiran Production');

check(
  ls('inventoryItems', []).some((i) => i.id === 'INV-RAW-001'),
  'inventory fixture carries unique record ids'
);

const prId = P.createRequirement({
  projectId: 'PRJ-ID-1',
  items: [
    { itemId: 'INV-RAW-001', itemName: 'MS Plate 10mm', itemCode: 'RAW-001', quantity: 10, unit: 'Nos' },
    { itemName: 'SS 304 Sheet', itemCode: 'RAW-002', quantity: 5, unit: 'Nos' }
  ]
});
check(prId.items[0].itemId === 'INV-RAW-001', 'itemId stored on the requirement line');
check(prId.items[1].itemId === '', 'legacy line without itemId still accepted');

/* itemId wins over a stale code/name (master record renamed after selection) */
const prStale = P.createRequirement({
  projectId: 'PRJ-ID-2',
  items: [{ itemId: 'INV-RAW-001', itemName: 'Old Name (stale)', itemCode: 'STALE-999', quantity: 90, unit: 'Nos' }]
});
const [staleLine] = P.computeRequirementLines(prStale.requirementNumber);
check(staleLine.inventoryMatched === true, 'stock matched via itemId even when code/name are stale');
check(
  staleLine.availableQty === 80 && staleLine.shortageQty === 10,
  `stale line stock math (available=${staleLine.availableQty}, shortage=${staleLine.shortageQty})`
);

expectThrows(
  () =>
    P.createRequirement({
      projectId: 'PRJ-ID-3',
      items: [{ itemId: 'INV-DOES-NOT-EXIST', itemName: 'Ghost Item', quantity: 1, unit: 'Nos' }]
    }),
  /select a material\/item from Inventory/i,
  'unknown itemId is rejected'
);
expectThrows(
  () =>
    P.createRequirement({
      projectId: 'PRJ-ID-4',
      items: [
        { itemId: 'INV-RAW-001', itemName: 'MS Plate 10mm', itemCode: 'RAW-001', quantity: 5, unit: 'Nos' },
        { itemId: 'INV-RAW-001', itemName: 'MS Plate 10mm', itemCode: 'RAW-001', quantity: 7, unit: 'Nos' }
      ]
    }),
  /already added to the requirement/,
  'duplicate itemId is rejected'
);
expectThrows(
  () =>
    P.createRequirement({
      projectId: 'PRJ-ID-5',
      items: [
        { itemName: 'Legacy A', itemCode: 'LEG-1', quantity: 1, unit: 'Nos' },
        { itemName: 'Legacy B', itemCode: 'LEG-1', quantity: 2, unit: 'Nos' }
      ]
    }),
  /already added to the requirement/,
  'duplicate item code on legacy lines is rejected'
);
expectThrows(
  () =>
    P.updateRequirement(prId.requirementNumber, {
      items: [
        { itemId: 'INV-RAW-001', itemName: 'MS Plate 10mm', itemCode: 'RAW-001', quantity: 5, unit: 'Nos' },
        { itemId: 'INV-RAW-003', itemName: 'EN8 Bar 25mm', itemCode: 'RAW-003', quantity: 5, unit: 'Nos' },
        { itemId: 'INV-RAW-003', itemName: 'EN8 Bar 25mm', itemCode: 'RAW-003', quantity: 6, unit: 'Nos' }
      ]
    }),
  /already added to the requirement/,
  'edit path rejects duplicate materials too'
);
const prIdEdited = P.updateRequirement(prId.requirementNumber, {
  items: [
    { itemId: 'INV-RAW-003', itemName: 'EN8 Bar 25mm', itemCode: 'RAW-003', quantity: 12, unit: 'Nos', lineId: prId.items[0].lineId }
  ]
});
check(
  prIdEdited.items.length === 1 && prIdEdited.items[0].itemId === 'INV-RAW-003',
  'edit keeps the newly selected itemId'
);

/* --------------------------------- summary --------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
