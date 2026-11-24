/**
 * Store Issue reference entry test (name / Job Card / PO / Customer at issue time).
 * Run:  node tests/store-issue-refs.test.mjs
 *
 * Covers:
 *   issueMaterial({ issueRefs }) stamps the store person's Job Card / PO Number /
 *   Customer Name onto the Store Issue slip, the stock transaction and the audit
 *   trail — while the Material Request itself is never rewritten by Stores.
 *   Omitting issueRefs keeps the pre-existing behaviour (MR values reused).
 *   A Job Card from another project is still rejected.
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
const { STATUS, SOURCE_TYPE } = S;

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
let mr1Number = '';
const materialRequests = () => ls('materialRequests', []);
const stockTransactions = () => ls('stockTransactions', []);
const auditLog = () => ls('storeAuditLog', []);

/* ---------------------------------- fixtures ---------------------------------- */
localStorage.setItem(
  'inventoryItems',
  JSON.stringify([
    { id: 'INV-RM-001', itemCode: 'RM001', itemName: 'EN8 Round Bar', category: 'Raw Material', unit: 'Nos', currentQty: 100, reservedQty: 0 },
    { id: 'INV-RM-002', itemCode: 'RM002', itemName: 'Cutting Oil', category: 'Consumable', unit: 'L', currentQty: 50, reservedQty: 0 }
  ])
);

localStorage.setItem(
  'productionJobCards',
  JSON.stringify([
    { jobCardNumber: 'JC-2026-001', salesOrderRef: 'SO-2026-001', projectId: 'PRJ-1', projectName: 'Frame Assembly', customerName: 'ACME Controls', partName: 'Frame' },
    { jobCardNumber: 'JC-9001', salesOrderRef: 'SO-2026-009', projectId: 'PRJ-9', projectName: 'Other Project', customerName: 'Zenith Ltd', partName: 'Housing' }
  ])
);

const additionalItem = (code, name, qty, unit) => ({
  materialId: code,
  materialName: name,
  unit,
  requiredQty: qty,
  sourceType: SOURCE_TYPE.ADDITIONAL,
  reason: 'Site requirement beyond the Terms list'
});

/* -------------------------------------------------------------------------- */
section('1. Store person can enter Job Card / PO Number / Customer at issue time');
{
  loginAs('Production Department', 'production_manager', 'Ravi Kumar');
  const mr1 = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-001',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    projectName: 'Frame Assembly',
    items: [additionalItem('RM001', 'EN8 Round Bar', 10, 'Nos')]
  });
  S.submitMaterialRequest(mr1.mrNumber);

  loginAs('Store Department', 'store_manager', 'Suresh Store');
  const si = S.issueMaterial({
    mrNumber: mr1.mrNumber,
    issueQtyById: { RM001: 4 },
    receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
    remarks: 'Handed over at gate',
    issueRefs: {
      jobCardNumber: 'JC-2026-001',
      poNumber: 'PO-7788',
      customer: 'ACME Controls Pvt Ltd'
    }
  });

  check(si.jobCardNumber === 'JC-2026-001', 'SI carries the entered Job Card', si.jobCardNumber);
  check(si.poNumber === 'PO-7788', 'SI carries the entered PO Number', String(si.poNumber));
  check(si.customer === 'ACME Controls Pvt Ltd', 'SI carries the entered Customer Name', si.customer);

  const tx = stockTransactions().find((t) => t.reference === si.issueNumber);
  check(Boolean(tx), 'Stock transaction written for the issue');
  check(tx.jobCardNumber === 'JC-2026-001' && tx.poNumber === 'PO-7788' && tx.customer === 'ACME Controls Pvt Ltd',
    'Stock transaction carries Job Card / PO / Customer', JSON.stringify({ jc: tx.jobCardNumber, po: tx.poNumber, cu: tx.customer }));

  const entry = auditLog().find((a) => a.action === 'MATERIAL ISSUED' && a.reference === si.issueNumber);
  check(Boolean(entry) && /PO-7788/.test(entry.details) && /ACME Controls Pvt Ltd/.test(entry.details),
    'Audit trail records PO and Customer', entry ? entry.details : 'missing');

  const mrAfter = materialRequests().find((m) => m.mrNumber === mr1.mrNumber);
  check(mrAfter.customer === 'ACME Controls', 'Material Request customer NOT rewritten by Stores', mrAfter.customer);
  check(mrAfter.jobCardNumber === 'JC-2026-001', 'Material Request job card untouched', mrAfter.jobCardNumber);
  check(mrAfter.poNumber === undefined || mrAfter.poNumber === '', 'Material Request gains no PO Number', String(mrAfter.poNumber));

  const listed = S.getStoreIssues().find((i) => i.issueNumber === si.issueNumber);
  check(listed && listed.poNumber === 'PO-7788' && listed.customer === 'ACME Controls Pvt Ltd',
    'Store Issues register reads back PO / Customer', JSON.stringify(listed && { po: listed.poNumber, cu: listed.customer }));

  mr1Number = mr1.mrNumber;
}

/* -------------------------------------------------------------------------- */
section('2. Backward compatibility — no issueRefs keeps the old behaviour');
{
  loginAs('Store Department', 'store_manager', 'Suresh Store');
  const si = S.issueMaterial({
    mrNumber: mr1Number,
    issueQtyById: { RM001: 6 },
    receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
    remarks: 'Balance issue'
  });
  check(si.jobCardNumber === 'JC-2026-001', 'Job Card falls back to the Material Request value', si.jobCardNumber);
  check(si.customer === 'ACME Controls', 'Customer falls back to the Material Request value', si.customer);
  check(si.poNumber === '' || si.poNumber === undefined, 'PO Number empty when not supplied', String(si.poNumber));

  const mrAfter = materialRequests().find((m) => m.mrNumber === mr1Number);
  check(mrAfter.status === STATUS.FULL, 'Issue lifecycle still completes to Fully Issued', mrAfter.status);
}

/* -------------------------------------------------------------------------- */
section('3. Cross-project guard still applies to the entered Job Card');
{
  loginAs('Production Department', 'production_manager', 'Ravi Kumar');
  const mr2 = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-001',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    projectName: 'Frame Assembly',
    items: [additionalItem('RM002', 'Cutting Oil', 5, 'L')]
  });
  S.submitMaterialRequest(mr2.mrNumber);

  loginAs('Store Department', 'store_manager', 'Suresh Store');
  expectThrows(
    () =>
      S.issueMaterial({
        mrNumber: mr2.mrNumber,
        issueQtyById: { RM002: 5 },
        receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
        issueRefs: { jobCardNumber: 'JC-9001', poNumber: 'PO-9999', customer: 'Zenith Ltd' }
      }),
    /Cross-project linkage blocked/,
    'Job Card from another project is refused'
  );

  /* same project, different (empty) Job Card is allowed */
  const si = S.issueMaterial({
    mrNumber: mr2.mrNumber,
    issueQtyById: { RM002: 5 },
    receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
    issueRefs: { jobCardNumber: 'JC-2026-001', poNumber: '', customer: '' }
  });
  check(si.customer === 'ACME Controls' && si.jobCardNumber === 'JC-2026-001',
    'Empty PO / Customer fall back to the Material Request values', JSON.stringify({ po: si.poNumber, cu: si.customer }));
}

/* -------------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Store issue reference entry OK');
