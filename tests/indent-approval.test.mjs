/**
 * Purchase Indent → Admin approval → Purchase notification chain.
 * Run:  node tests/indent-approval.test.mjs
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
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  dispatchEvent: () => true
};
await import('./helpers/availability-api-stub.mjs');

const W = await import('../src/utils/workflowService.js');
const { hasPermission } = await import('../src/utils/permissions.js');

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

const expectThrows = async (fn, pattern, label) => {
  try {
    await fn();
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

/* ---------------------------------- fixtures ---------------------------------- */
loginAs('Store Department', 'store_manager', 'Suresh Store');
localStorage.setItem(
  'inventoryItems',
  JSON.stringify([{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100 }])
);
localStorage.setItem(
  'salesOrderHistory',
  JSON.stringify([
    {
      reference: 'SO-001',
      date: '2026-10-01',
      status: 'Open',
      company: 'ACME Controls',
      payload: {
        soDetails: { projectId: 'PRJ-SO-001', soDate: '2026-10-01', deliveryDate: '2026-11-15' },
        customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
        items: [{ itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos' }]
      }
    }
  ])
);
['purchaseIndents', 'notifications', 'storeAuditLog'].forEach((k) => {
  if (!localStorage.getItem(k)) localStorage.setItem(k, '[]');
});

/* --------------------------------- the flow --------------------------------- */
section('1. Store shares the Purchase Indent');
const indent = await W.createPurchaseIndent({ soNumber: 'SO-001' });
check(Boolean(indent.indentNumber), `indent created (${indent.indentNumber})`);
check(indent.status === W.INDENT_STATUS.DRAFT, 'a fresh indent is a Draft');

const submitted = W.submitPurchaseIndent(indent.indentNumber, 'Please review');
check(submitted.status === W.INDENT_STATUS.SUBMITTED, 'indent submitted by Store');

const adminNote = notifications().find(
  (n) => n.targetDept === 'Admin' && n.reference === indent.indentNumber
);
check(Boolean(adminNote), 'the Admin is notified when Store shares an indent');
check(
  Boolean(adminNote) && adminNote.link === `/purchase-indents?indent=${indent.indentNumber}`,
  `the Admin notification links to the indent (${adminNote?.link})`
);
check(
  Boolean(adminNote) && /approval/i.test(adminNote.title + adminNote.message),
  'the Admin notification asks for approval'
);
const purchaseNote = notifications().find(
  (n) => n.targetDept === 'Purchase Department' && n.reference === indent.indentNumber
);
check(Boolean(purchaseNote), 'the Purchase Department is notified about the new indent');

section('2. Only the Admin may approve');
loginAs('Purchase Department', 'purchase_manager', 'Mani Purchase');
check(hasPermission('indent.admin_approve') === false, 'the Purchase role has no indent.admin_approve');
await expectThrows(
  () => W.approveIndentByAdmin(indent.indentNumber),
  /only the Admin/,
  'Purchase cannot approve its own indent'
);
loginAs('Store Department', 'store_manager', 'Suresh Store');
await expectThrows(
  () => W.approveIndentByAdmin(indent.indentNumber),
  /only the Admin/,
  'Store cannot approve the indent it raised'
);

section('3. Admin approves and notifies Purchase');
loginAs('Admin', 'admin', 'Ravi Admin');
check(hasPermission('indent.admin_approve') === true, 'the Admin holds indent.admin_approve');
const approved = await W.approveIndentByAdmin(indent.indentNumber, 'Approved for vendor enquiry');
check(Boolean(approved.adminApprovedAt), `approval timestamp recorded (${approved.adminApprovedAt})`);
check(approved.adminApprovedBy === 'Ravi Admin', `approval recorded against the Admin (${approved.adminApprovedBy})`);
check(approved.adminApprovedRemarks === 'Approved for vendor enquiry', 'approval remarks are stored');
check(approved.status === W.INDENT_STATUS.SUBMITTED, 'the indent status stays Submitted for Purchase');
check(
  (approved.history || []).some((h) => h.action === 'Indent approved by Admin'),
  'approval written to the indent history'
);
check(
  !ls('storeAuditLog', []).some((a) => a.action === 'PURCHASE INDENT APPROVED BY ADMIN'),
  'approval audit is not treated as a browser-local authoritative record'
);

const approvedNote = notifications().find(
  (n) => n.targetDept === 'Purchase Department' && n.reference === indent.indentNumber && /approved by Admin/i.test(n.title)
);
check(Boolean(approvedNote), 'the Purchase Department is notified of the approval');
check(
  Boolean(approvedNote) && approvedNote.link === `/purchase-indents?indent=${indent.indentNumber}`,
  `the approval notification links to the indent (${approvedNote?.link})`
);
check(
  Boolean(approvedNote) && /vendor enquiries/i.test(approvedNote.message),
  'the approval notification tells Purchase to send the vendor enquiry'
);

section('4. Approval is one-shot');
await expectThrows(
  () => W.approveIndentByAdmin(indent.indentNumber),
  /already approved/,
  'an indent cannot be approved twice'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log('Indent approval chain OK');
