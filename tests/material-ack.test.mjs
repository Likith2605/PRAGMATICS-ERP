/**
 * Store → Production Material Acknowledgement — service tests.
 * Run:  node tests/material-ack.test.mjs
 *
 * Covers spec scenarios 1-8 and 10:
 *   1. all materials available          -> Fully Available + notification
 *   2. some materials available         -> Partially Available + indent for shortage
 *   3. no materials available           -> Not Available + indent
 *   4. purchased material received      -> acknowledgement refreshes after inventory post
 *   5. partial procurement              -> remaining shortage recalculated
 *   6. full procurement                 -> Fully Available + notification
 *   7. two projects request same stock  -> same physical stock not double-acknowledged
 *   8. duplicate acknowledgement        -> no duplicate record or notification
 *  10. unauthorised user                -> permission denied
 *
 * Plus the hard business rules: reserved stock excluded, pending-QC stock
 * excluded, verified quantity can never exceed real availability, and a
 * Purchase Indent is never raised twice for one Material Request.
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

const S = await import('../src/utils/storeService.js');
const ACK = await import('../src/utils/materialAckService.js');
const WF = await import('../src/utils/workflowService.js');
const { STATUS } = S;
const {
  ACK_STATUS,
  ACK_LINE_STATUS,
  computeAckLines,
  getAcknowledgement,
  submitAcknowledgement,
  linkPurchaseIndent,
  findIndentForMR,
  getAckQueue,
  matchesAckFilter,
  getProductionAckSummary
} = ACK;

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
    JSON.stringify({ isLoggedIn: true, username: name, email: `${roleKey}@pragmatic.test`, roleKey, department })
  );
};

const ls = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
const materialRequests = () => ls('materialRequests', []);
const notifications = () => ls('notifications', []);
const auditLog = () => ls('storeAuditLog', []);
const indents = () => ls('purchaseIndents', []);
const setInventory = (list) => localStorage.setItem('inventoryItems', JSON.stringify(list));

const setQty = (code, currentQty, reservedQty = 0) => {
  const inv = ls('inventoryItems', []);
  const idx = inv.findIndex((i) => i.itemCode === code);
  const next = { ...inv[idx], currentQty };
  if (reservedQty !== undefined) next.reservedQty = reservedQty;
  inv[idx] = next;
  setInventory(inv);
};

const makeMR = (mrNumber, projectId, items, overrides = {}) => ({
  mrNumber,
  materialRequestId: mrNumber,
  requestDate: '2026-11-04',
  requiredDate: '2026-11-20',
  jobCardNumber: `JC-${mrNumber}`,
  jobCardId: `JC-${mrNumber}`,
  salesOrderRef: 'SO-2026-001',
  salesOrderId: 'SO-2026-001',
  customer: 'ACME Controls',
  partName: 'Bracket',
  drawingNumber: 'DWG-01',
  projectId,
  projectName: `Project ${projectId}`,
  productionDepartment: 'Production Department',
  requestedBy: 'Ravi',
  requestedByEmpId: 'E2',
  priority: 'Normal',
  remarks: '',
  status: STATUS.APPROVED,
  createdBy: 'Ravi',
  createdAt: '2026-11-04 09:00',
  items: items.map(([materialId, materialName, requiredQty, unit]) => ({
    materialId,
    itemId: `INV-${materialId}`,
    materialName,
    unit,
    requiredQty,
    termsRequiredQty: 0,
    sourceType: 'ADDITIONAL',
    reason: 'Line build',
    createdBy: 'Ravi'
  })),
  history: [],
  ...overrides
});

const writeMRs = (list) => localStorage.setItem('materialRequests', JSON.stringify(list));

/* ---------------------------------- fixtures ---------------------------------- */
setInventory([
  { id: 'INV-1', itemCode: 'STEEL', itemName: 'Steel Rod', category: 'Raw Material', unit: 'kg', currentQty: 100, reservedQty: 0 },
  { id: 'INV-2', itemCode: 'BOLTS', itemName: 'Fasteners', category: 'Fastener', unit: 'Nos', currentQty: 200, reservedQty: 80 },
  { id: 'INV-3', itemCode: 'PAINT', itemName: 'Paint', category: 'Consumable', unit: 'L', currentQty: 0, reservedQty: 0 }
]);
localStorage.setItem('notifications', '[]');
localStorage.setItem('storeAuditLog', '[]');
localStorage.setItem('purchaseIndents', '[]');

loginAs('Store Department', 'store_manager', 'Suresh Store');

/* ============================ Scenario 2: partial ============================ */
section('Scenario 2 — some materials available (Steel / Bolts / Paint)');

writeMRs([
  makeMR('MR-000001', 'PRJ-A', [
    ['STEEL', 'Steel Rod', 100, 'kg'],
    ['BOLTS', 'Fasteners', 200, 'Nos'],
    ['PAINT', 'Paint', 20, 'L']
  ])
]);

const mr1 = materialRequests()[0];
const lines1 = computeAckLines(mr1);
const byCode = Object.fromEntries(lines1.map((l) => [l.materialId, l]));

check(byCode.STEEL.availableQty === 100 && byCode.STEEL.shortageQty === 0, 'Steel 100/100 available, no shortage', JSON.stringify(byCode.STEEL));
check(byCode.STEEL.status === ACK_LINE_STATUS.FULL, 'Steel line status = Available');
check(byCode.BOLTS.effectiveAvailable === 120, 'Bolts reserve (80) excluded from availability → 120', `got ${byCode.BOLTS.effectiveAvailable}`);
check(byCode.BOLTS.availableQty === 120 && byCode.BOLTS.shortageQty === 80, 'Bolts 120 available, 80 short');
check(byCode.BOLTS.status === ACK_LINE_STATUS.PARTIAL, 'Bolts line status = Partial');
check(byCode.PAINT.availableQty === 0 && byCode.PAINT.shortageQty === 20, 'Paint 0 available, 20 short');
check(byCode.PAINT.status === ACK_LINE_STATUS.NONE, 'Paint line status = Not Available');
check(
  ACK.ackStatusForLines(lines1) === ACK_STATUS.PARTIAL,
  'overall status = Partially Available',
  ACK.ackStatusForLines(lines1)
);

const notifBefore1 = notifications().length;
const res1 = submitAcknowledgement({
  mrNumber: 'MR-000001',
  lines: [
    { materialId: 'STEEL', verifiedQty: 100 },
    { materialId: 'BOLTS', verifiedQty: 120 },
    { materialId: 'PAINT', verifiedQty: 0 }
  ],
  remarks: 'Steel and bolts on hand, paint to be procured.'
});

check(res1.changed === true, 'acknowledgement was recorded');
const ack1 = getAcknowledgement(materialRequests()[0]);
check(ack1.status === ACK_STATUS.PARTIAL, 'stored status = Partially Available', ack1.status);
check(ack1.history.length === 1, 'one history entry written');
check(ack1.history[0].previousStatus === ACK_STATUS.PENDING, 'history records previous status');
check(ack1.history[0].newStatus === ACK_STATUS.PARTIAL, 'history records new status');
check(ack1.history[0].by === 'Suresh Store', 'history records who acknowledged');
check(ack1.history[0].remarks.includes('paint'), 'history records remarks');
check(notifications().length === notifBefore1 + 1, 'exactly one notification sent to Production');

const notif1 = notifications()[0];
check(notif1.targetDept === 'Production Department', 'notification targeted at Production');
check(notif1.reference === 'MR-000001', 'notification carries the MR number');
check(notif1.message.includes('SO-2026-001'), 'notification carries the Sales Order');
check(notif1.message.includes('PRJ-A'), 'notification carries the Project ID');
check(notif1.message.includes('Steel Rod'), 'notification carries the material name');
check(notif1.message.includes('Partially Available'), 'notification carries the ack status');
check(notif1.link.includes('/production/material-requests'), 'notification links to the Material Request');

/* --------------------- rule: verified qty can never exceed stock --------------------- */
section('Rule — Stores cannot acknowledge more than real unreserved stock');

const resOver = submitAcknowledgement({
  mrNumber: 'MR-000001',
  lines: [{ materialId: 'STEEL', verifiedQty: 9999 }],
  remarks: 'trying to over-claim steel'
});
const ackOver = getAcknowledgement(materialRequests()[0]);
check(
  ackOver.lines.STEEL.acknowledgedQty === 100,
  'verified 9999 was clamped to the real 100 available',
  `got ${ackOver.lines.STEEL.acknowledgedQty}`
);
check(resOver.changed === true, 'a genuine change still records');

/* ============================ Scenario 3: none available ============================ */
section('Scenario 3 — no materials available');

writeMRs([
  makeMR('MR-000002', 'PRJ-B', [['PAINT', 'Paint', 20, 'L']])
]);
const lines3 = computeAckLines(materialRequests()[0]);
check(ACK.ackStatusForLines(lines3) === ACK_STATUS.NONE, 'overall status = Not Available', ACK.ackStatusForLines(lines3));

const res3 = submitAcknowledgement({ mrNumber: 'MR-000002', lines: [], remarks: 'Nil stock.' });
check(res3.changed === true, 'unavailability acknowledged');
check(getAcknowledgement(materialRequests()[0]).status === ACK_STATUS.NONE, 'stored as Not Available');

/* ============================ Purchase Indent linkage ============================ */
section('Rule 5/8 — Purchase Indent created once and stays linked');

/* Scenario 3 overwrote the fixture list — restore the partial request. */
writeMRs([
  makeMR('MR-000001', 'PRJ-A', [
    ['STEEL', 'Steel Rod', 100, 'kg'],
    ['BOLTS', 'Fasteners', 200, 'Nos'],
    ['PAINT', 'Paint', 20, 'L']
  ]),
  makeMR('MR-000002', 'PRJ-B', [['PAINT', 'Paint', 20, 'L']])
]);

const indentRes = linkPurchaseIndent({ mrNumber: 'MR-000001', remarks: 'Indent for bolts + paint' });
check(indentRes.created === true, 'indent created for the shortage');
check(indents().length === 1, 'exactly one indent exists', `got ${indents().length}`);
const createdIndent = indentRes.indent;
check(createdIndent.sourceType === 'materialRequest', 'indent sourceType = materialRequest');
check(createdIndent.requirementNumber === 'MR-000001', 'indent requirementNumber = the MR');
check(createdIndent.projectId === 'PRJ-A', 'indent carries the Project ID');
check(createdIndent.soNumber === 'SO-2026-001', 'indent carries the Sales Order');
const indentCodes = createdIndent.items.map((i) => i.materialCode).sort();
assert.deepEqual(indentCodes, ['BOLTS', 'PAINT'], 'indent holds only the shortage lines');
check(createdIndent.items.every((i) => i.purchaseQty > 0), 'every indent line has a positive quantity');
check(
  createdIndent.items.find((i) => i.materialCode === 'BOLTS').purchaseQty === 80,
  'bolts indented for the 80 shortage'
);
check(findIndentForMR('MR-000001')?.indentNumber === createdIndent.indentNumber, 'indent is discoverable from the MR');

const again = linkPurchaseIndent({ mrNumber: 'MR-000001' });
check(again.created === false, 'second call does NOT create a duplicate indent');
check(indents().length === 1, 'still exactly one indent after re-linking', `got ${indents().length}`);

/* ==================== Scenario 4/5/6: procurement refresh ==================== */
section('Scenarios 4-6 — procurement received, shortage recalculated');

/* Scenario 4: partial procurement — only bolts arrive and pass QC. */
setQty('BOLTS', 280, 80); // +80 accepted through the existing QC posting path
const linesAfterPartial = computeAckLines(materialRequests()[0]);
const boltsAfter = linesAfterPartial.find((l) => l.materialId === 'BOLTS');
check(boltsAfter.availableQty === 200 && boltsAfter.shortageQty === 0, 'bolts shortage cleared after receipt', JSON.stringify(boltsAfter));
const paintAfter = linesAfterPartial.find((l) => l.materialId === 'PAINT');
check(paintAfter.shortageQty === 20, 'paint shortage unchanged (still to be procured)');

submitAcknowledgement({ mrNumber: 'MR-000001', lines: [], remarks: 'Bolts received.' });
const ackMid = getAcknowledgement(materialRequests()[0]);
check(ackMid.status === ACK_STATUS.PARTIAL, 'still Partially Available while paint is outstanding', ackMid.status);
check(ackMid.lines.BOLTS.shortageQty === 0, 'stored bolts shortage is now 0');
check(ackMid.lines.PAINT.shortageQty === 20, 'stored paint shortage still 20');

/* Scenario 6: full procurement — paint arrives too. */
setQty('PAINT', 20, 0);
const notifBefore6 = notifications().length;
submitAcknowledgement({ mrNumber: 'MR-000001', lines: [], remarks: 'Paint received — fully available.' });
const ackFull = getAcknowledgement(materialRequests()[0]);
check(ackFull.status === ACK_STATUS.FULL, 'status auto-changed to Fully Available', ackFull.status);
check(ackFull.lines.PAINT.shortageQty === 0, 'paint shortage now 0');
check(notifications().length === notifBefore6 + 1, 'Production notified of the full availability');
check(notifications()[0].message.includes('Fully Available'), 'notification states Fully Available');

/* The MR itself must NOT have had its issue-lifecycle status hijacked. */
check(materialRequests()[0].status === STATUS.APPROVED, 'mr.status untouched by acknowledgement (backward compatible)', materialRequests()[0].status);

/* ==================== Scenario 7: two projects, one stock ==================== */
section('Scenario 7 — same physical stock cannot serve two projects');

setQty('STEEL', 100, 0);
writeMRs([
  makeMR('MR-000010', 'PRJ-X', [['STEEL', 'Steel Rod', 100, 'kg']]),
  makeMR('MR-000011', 'PRJ-Y', [['STEEL', 'Steel Rod', 100, 'kg']])
]);

submitAcknowledgement({ mrNumber: 'MR-000010', lines: [], remarks: 'Claiming all steel.' });
const xAck = getAcknowledgement(materialRequests().find((m) => m.mrNumber === 'MR-000010'));
check(xAck.status === ACK_STATUS.FULL, 'first project got the full 100 kg', xAck.status);

const mrY = materialRequests().find((m) => m.mrNumber === 'MR-000011');
const linesY = computeAckLines(mrY);
check(linesY[0].blockedQty === 100, '100 kg shown as blocked by the other project', `got ${linesY[0].blockedQty}`);
check(linesY[0].effectiveAvailable === 0, 'no effective stock left for the second project');
check(linesY[0].shortageQty === 100, 'second project sees the full 100 kg as shortage');
check(ACK.ackStatusForLines(linesY) === ACK_STATUS.NONE, 'second project cannot be told Available', ACK.ackStatusForLines(linesY));

const resY = submitAcknowledgement({ mrNumber: 'MR-000011', lines: [{ materialId: 'STEEL', verifiedQty: 100 }], remarks: 'Attempting to claim the same steel.' });
const yAck = getAcknowledgement(materialRequests().find((m) => m.mrNumber === 'MR-000011'));
check(
  yAck.lines.STEEL.acknowledgedQty === 0,
  'second project cannot acknowledge the already-committed 100 kg',
  `got ${yAck.lines.STEEL.acknowledgedQty}`
);
check(resY.acknowledgement.status === ACK_STATUS.NONE, 'second project recorded as Not Available');

/* Once project X actually issues the steel, the commitment must stop blocking. */
localStorage.setItem(
  'storeIssueHistory',
  JSON.stringify([
    {
      issueNumber: 'SI-1',
      mrNumber: 'MR-000010',
      items: [{ materialId: 'STEEL', currentIssueQty: 100 }]
    }
  ])
);
setQty('STEEL', 0, 0); // stock physically left the shelf
const linesYAfterIssue = computeAckLines(materialRequests().find((m) => m.mrNumber === 'MR-000011'));
check(linesYAfterIssue[0].blockedQty === 0, 'issued material no longer double-counted as blocked', `got ${linesYAfterIssue[0].blockedQty}`);
localStorage.setItem('storeIssueHistory', '[]');

/* ==================== Scenario 8: duplicate acknowledgement ==================== */
section('Scenario 8 — duplicate acknowledgement creates nothing');

/* Self-contained fixture so stock does not shift underneath the re-submit. */
setQty('STEEL', 300, 0);
writeMRs([makeMR('MR-000300', 'PRJ-DUP', [['STEEL', 'Steel Rod', 50, 'kg']])]);
submitAcknowledgement({ mrNumber: 'MR-000300', lines: [], remarks: 'Steel confirmed.' });

const beforeDup = JSON.stringify(materialRequests()[0].acknowledgement.history);
const notifBeforeDup = notifications().length;
const dupRes = submitAcknowledgement({
  mrNumber: 'MR-000300',
  lines: [],
  remarks: 'Steel confirmed.' // identical to the submission above
});
check(dupRes.changed === false, 'identical re-submission reported as unchanged');
const afterDup = JSON.stringify(materialRequests()[0].acknowledgement.history);
check(beforeDup === afterDup, 'no second history entry was appended');
check(notifications().length === notifBeforeDup, 'no duplicate notification was sent', `${notifBeforeDup} → ${notifications().length}`);

/* ==================== Rule 4: pending QC is not available ==================== */
section('Rule 4 — material awaiting QC is not counted as available');

setQty('STEEL', 100, 0);
localStorage.setItem(
  'materialReceipts',
  JSON.stringify([
    {
      receiptNumber: 'RC-1',
      poNumber: 'PO-1',
      status: 'Received / Awaiting Quality Check',
      items: [{ materialCode: 'STEEL', receivedQty: 500 }]
    }
  ])
);
writeMRs([makeMR('MR-000400', 'PRJ-QC', [['STEEL', 'Steel Rod', 100, 'kg']])]);
const pendingQcLines = computeAckLines(materialRequests()[0]);
check(
  pendingQcLines[0].currentQty === 100,
  'a 500 kg receipt awaiting QC does not raise on-hand stock',
  `got ${pendingQcLines[0].currentQty}`
);
localStorage.setItem('materialReceipts', '[]');

/* ==================== Rule 3: reserved stock excluded ==================== */
section('Rule 3 — reserved stock is excluded from availability');

setQty('BOLTS', 200, 80);
const reservedLines = computeAckLines(makeMR('MR-000099', 'PRJ-R', [['BOLTS', 'Fasteners', 200, 'Nos']]));
check(reservedLines[0].effectiveAvailable === 120, '200 on hand − 80 reserved = 120 usable', `got ${reservedLines[0].effectiveAvailable}`);

/* ==================== Scenario 10: unauthorised user ==================== */
section('Scenario 10 — unauthorised user cannot acknowledge');

loginAs('Production Department', 'production_employee', 'Ravi Production');
expectThrows(
  () => submitAcknowledgement({ mrNumber: 'MR-000001', lines: [], remarks: 'nope' }),
  /Permission denied/,
  'Production Employee blocked from acknowledging'
);
expectThrows(
  () => linkPurchaseIndent({ mrNumber: 'MR-000001' }),
  /Permission denied/,
  'Production Employee blocked from raising a Purchase Indent'
);

loginAs('Store Department', 'store_employee', 'Anil Store');
writeMRs([makeMR('MR-000500', 'PRJ-SE', [['STEEL', 'Steel Rod', 10, 'kg']])]);
const storeEmpRes = submitAcknowledgement({ mrNumber: 'MR-000500', lines: [], remarks: 'Store Employee may acknowledge.' });
check(storeEmpRes.changed === true, 'Store Employee is allowed to acknowledge');

/* ==================== Scenario 1: all available ==================== */
section('Scenario 1 — all materials available');

setQty('STEEL', 500, 0);
setQty('BOLTS', 900, 0);
setQty('PAINT', 60, 0);
writeMRs([
  makeMR('MR-000100', 'PRJ-FULL', [
    ['STEEL', 'Steel Rod', 50, 'kg'],
    ['BOLTS', 'Fasteners', 100, 'Nos'],
    ['PAINT', 'Paint', 10, 'L']
  ])
]);
const notifBefore1b = notifications().length;
submitAcknowledgement({ mrNumber: 'MR-000100', lines: [], remarks: 'Everything on hand.' });
const ackAll = getAcknowledgement(materialRequests()[0]);
check(ackAll.status === ACK_STATUS.FULL, 'fully available acknowledged', ackAll.status);
check(notifications().length === notifBefore1b + 1, 'Production notified exactly once');
check(notifications()[0].type === 'success', 'notification type is success');

/* ==================== dashboard + filters ==================== */
section('Dashboards and filters');

writeMRs([
  makeMR('MR-000200', 'PRJ-P1', [['STEEL', 'Steel Rod', 10, 'kg']]),
  makeMR('MR-000201', 'PRJ-P2', [['PAINT', 'Paint', 500, 'L']]),
  makeMR('MR-000202', 'PRJ-P3', [['STEEL', 'Steel Rod', 10, 'kg']], { status: STATUS.DRAFT })
]);
localStorage.setItem('notifications', '[]');

const queue = getAckQueue();
check(queue.length === 2, 'queue excludes Draft requests', `got ${queue.length}`);
check(queue.every((r) => r.ack.status === ACK_STATUS.PENDING), 'fresh requests start Pending Acknowledgement');

submitAcknowledgement({ mrNumber: 'MR-000200', lines: [], remarks: 'ok' });
const queue2 = getAckQueue();
check(matchesAckFilter(queue2.find((r) => r.mr.mrNumber === 'MR-000200'), ACK_STATUS.FULL), 'filter Fully Available matches');
check(matchesAckFilter(queue2.find((r) => r.mr.mrNumber === 'MR-000201'), ACK_STATUS.PENDING), 'filter Pending Acknowledgement matches');
check(!matchesAckFilter(queue2.find((r) => r.mr.mrNumber === 'MR-000201'), ACK_STATUS.FULL), 'filter Fully Available excludes pending');

const summary = getProductionAckSummary();
check(summary.length === 2, 'production summary lists ack-eligible requests only', `got ${summary.length}`);
const prodRow = summary.find((s) => s.mr.mrNumber === 'MR-000200');
check(prodRow.totalShortage === 0, 'production summary computes zero shortage when fully available');
check(prodRow.lastAcknowledgedAt !== '', 'production summary exposes last acknowledgement date');

/* ==================== audit trail ==================== */
section('Rule 11 — audit history maintained');

const audit = auditLog();
check(
  audit.some((e) => e.action === 'MATERIAL ACKNOWLEDGED'),
  'acknowledgement recorded in the audit log',
  audit.map((e) => e.action).join(',')
);

/* --------------------------------- summary --------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log('Material Acknowledgement service OK');
