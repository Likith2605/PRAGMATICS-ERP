/**
 * Production → Request Material: Terms & Requirement integration test.
 * Run:  node tests/material-request-terms.test.mjs
 *
 * Covers (spec §2-§11, §17, §21):
 *   Sales Order + Job Card → Terms & Requirement items fetched automatically
 *   → Required / Requested / Issued / Balance projection → Store stock +
 *   shortage → request capped at the balance → "+ Add Item" additional items
 *   (Item Master only, reason mandatory) → duplicate prevention → full
 *   Store issue still working with the new traceability fields.
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
const T = await import('../src/utils/materialRequestTermsService.js');
const { SOURCE_TYPE, SOURCE_TYPE_LABEL, STATUS } = S;

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
const auditLog = () => ls('storeAuditLog', []);

/* ---------------------------------- fixtures ---------------------------------- */
localStorage.setItem(
  'inventoryItems',
  JSON.stringify([
    { id: 'INV-RM-001', itemCode: 'RM001', itemName: 'EN8 Round Bar', category: 'Raw Material', unit: 'Nos', currentQty: 60, reservedQty: 0 },
    { id: 'INV-RM-002', itemCode: 'RM002', itemName: 'Cutting Oil', category: 'Consumable', unit: 'L', currentQty: 100, reservedQty: 0 },
    { id: 'INV-RM-003', itemCode: 'RM003', itemName: 'Grinding Wheel', category: 'Consumable', unit: 'Nos', currentQty: 0, reservedQty: 0 },
    { id: 'INV-RM-004', itemCode: 'RM004', itemName: 'Copper Wire', category: 'Raw Material', unit: 'Mtr', currentQty: 1000, reservedQty: 0 },
    { id: 'INV-RM-005', itemCode: 'RM005', itemName: 'Special Cutting Insert', category: 'Tooling', unit: 'Nos', currentQty: 500, reservedQty: 0 },
    { id: 'INV-RM-006', itemCode: 'RM006', itemName: 'MS Angle', category: 'Raw Material', unit: 'Nos', currentQty: 40, reservedQty: 0 },
    { id: 'INV-OFF-9', itemCode: 'OFF-9', itemName: 'Retired Item', category: 'Raw Material', unit: 'Nos', currentQty: 5, reservedQty: 0, active: false }
  ])
);

localStorage.setItem(
  'productionJobCards',
  JSON.stringify([
    { jobCardNumber: 'JC-2026-001', salesOrderRef: 'SO-2026-001', projectId: 'PRJ-1', projectName: 'Frame Assembly', customerName: 'ACME Controls', partName: 'Frame' },
    { jobCardNumber: 'JC-2026-002', salesOrderRef: 'SO-2026-001', projectId: 'PRJ-1', projectName: 'Frame Assembly', customerName: 'ACME Controls', partName: 'Cover' }
  ])
);

const reqItem = (lineId, code, name, qty, unit) => ({
  lineId,
  itemId: `INV-${code}`,
  itemCode: code,
  itemName: name,
  description: name,
  specification: '',
  size: '',
  purpose: '',
  quantity: qty,
  unit,
  requiredDate: '',
  remarks: ''
});

localStorage.setItem(
  'productionRequirements',
  JSON.stringify([
    {
      requirementNumber: 'PR-000001',
      projectId: 'PRJ-1',
      soNumber: 'SO-2026-001',
      jobCardNumber: 'JC-2026-001',
      customer: 'ACME Controls',
      partName: 'Frame',
      status: 'Pending Review',
      items: [
        reqItem('l-rm001', 'RM001', 'EN8 Round Bar', 100, 'Nos'),
        reqItem('l-rm002', 'RM002', 'Cutting Oil', 20, 'L'),
        reqItem('l-rm003', 'RM003', 'Grinding Wheel', 10, 'Nos')
      ]
    },
    {
      requirementNumber: 'PR-000002',
      projectId: 'PRJ-1',
      soNumber: 'SO-2026-001',
      jobCardNumber: 'JC-2026-002',
      customer: 'ACME Controls',
      partName: 'Cover',
      status: 'Draft',
      items: [reqItem('l-rm005', 'RM005', 'Special Cutting Insert', 5, 'Nos')]
    },
    {
      requirementNumber: 'PR-000003',
      projectId: 'PRJ-1',
      soNumber: 'SO-2026-001',
      jobCardNumber: '',
      customer: 'ACME Controls',
      partName: 'Frame',
      status: 'Draft',
      items: [reqItem('l-rm004', 'RM004', 'Copper Wire', 30, 'Mtr')]
    },
    {
      requirementNumber: 'PR-000004',
      projectId: 'PRJ-1',
      soNumber: 'SO-2026-001',
      jobCardNumber: 'JC-2026-001',
      customer: 'ACME Controls',
      partName: 'Frame',
      status: 'Cancelled',
      items: [reqItem('l-rm006', 'RM006', 'MS Angle', 99, 'Nos')]
    }
  ])
);

localStorage.setItem(
  'salesOrderHistory',
  JSON.stringify([
    {
      date: '2026-10-01',
      reference: 'SO-2026-002',
      company: 'Bharat Electronics',
      payload: {
        soDetails: { soNumber: 'SO-2026-002' },
        customerDetails: { customerName: 'Bharat Electronics' },
        items: [
          { itemCode: 'RM001', itemName: 'EN8 Round Bar', quantity: 50, unit: 'Nos' },
          { itemCode: 'NOT-IN-MASTER', itemName: 'Ghost Material', quantity: 5, unit: 'Nos' }
        ]
      }
    }
  ])
);

loginAs('Production Department', 'production_manager', 'Ravi Kumar');

/* ========================================================================== */
section('1. Terms & Requirement items are fetched automatically');
{
  const lines = T.getTermsRequirementLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' });
  const codes = lines.map((l) => l.itemCode);
  check(codes.includes('RM001') && codes.includes('RM002') && codes.includes('RM003'), 'PR items for the selected Job Card appear', JSON.stringify(codes));
  check(codes.includes('RM004'), 'SO-level requirement (no job card) applies to every Job Card of the Sales Order');
  check(!codes.includes('RM005'), 'another Job Card\'s requirements are NOT shown (§12)');
  check(!codes.includes('RM006'), 'Cancelled requirement list is ignored');
  check(lines.every((l) => l.sourceType === SOURCE_TYPE.TERMS_REQUIREMENT), 'every fetched line is TERMS_REQUIREMENT');
  check(lines.every((l) => Boolean(l.termsRequirementItemId)), 'each line keeps its termsRequirementItemId (lineId)', JSON.stringify(lines.map((l) => l.termsRequirementItemId)));
  check(lines.every((l) => Boolean(l.itemId) && Boolean(l.materialId)), 'Item Master id + item code retained');
  const rm1 = lines.find((l) => l.itemCode === 'RM001');
  check(rm1 && rm1.termsRequiredQty === 100 && rm1.unit === 'Nos', 'Required quantity + UOM come from Terms & Requirement', JSON.stringify(rm1));

  const jc2 = T.getTermsRequirementLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-002' }).map((l) => l.itemCode);
  check(jc2.includes('RM005') && !jc2.includes('RM001'), 'a different Job Card gets its own requirement list', JSON.stringify(jc2));

  check(T.getTermsRequirementLines({}).length === 0, 'no Sales Order / Job Card → nothing fetched');
  check(T.getTermsRequirementLines({ salesOrderId: 'SO-NOPE' }).length === 0, 'unknown Sales Order → nothing fetched');
}

section('2. Fallback: Sales Order Ordered Items when no requirement list exists');
{
  const lines = T.getTermsRequirementLines({ salesOrderId: 'SO-2026-002', jobCardNumber: '' });
  check(lines.length === 1, 'only Item-Master-backed Ordered Items are used', JSON.stringify(lines.map((l) => l.itemCode)));
  check(lines[0]?.termsRequirementItemId === 'SO:SO-2026-002#1', 'Terms id points back to the Sales Order line', String(lines[0]?.termsRequirementItemId));
  check(lines[0]?.sourceType === SOURCE_TYPE.TERMS_REQUIREMENT, 'SO fallback lines are TERMS_REQUIREMENT');
}

/* -------------------------------------------------------------------------- */
section('3. Required / Requested / Issued / Balance projection (§4)');
{
  const before = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' });
  const rm1 = before.find((l) => l.itemCode === 'RM001');
  check(rm1.termsRequiredQty === 100 && rm1.requestedQty === 0 && rm1.issuedQty === 0 && rm1.balanceQty === 100, 'nothing requested yet → balance = required', JSON.stringify(rm1));

  /* Production raises MR-1 for 20 out of the 100 required */
  const mr1 = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-001',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    requiredDate: '2026-10-20',
    items: [
      {
        materialId: 'RM001',
        materialName: 'EN8 Round Bar',
        unit: 'Nos',
        requiredQty: 20,
        sourceType: SOURCE_TYPE.TERMS_REQUIREMENT,
        termsRequirementItemId: 'l-rm001',
        termsRequiredQty: 100
      }
    ]
  });
  check(mr1.mrNumber.startsWith('MR-'), 'Material Request auto-numbered', mr1.mrNumber);
  check(mr1.salesOrderId === 'SO-2026-001' && mr1.jobCardId === 'JC-2026-001' && mr1.materialRequestId === mr1.mrNumber, 'salesOrderId / jobCardId / materialRequestId stored (§11)');

  const item = mr1.items[0];
  check(item.sourceType === 'TERMS_REQUIREMENT', 'sourceType stored as TERMS_REQUIREMENT', item.sourceType);
  check(item.termsRequirementItemId === 'l-rm001', 'termsRequirementItemId stored for traceability');
  check(item.itemId === 'INV-RM-001', 'Item Master id retained on the line');
  check(item.termsRequiredQty === 100, 'Terms required quantity retained on the line');

  const mid = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM001');
  check(mid.requestedQty === 20 && mid.issuedQty === 0 && mid.balanceQty === 80, 'after requesting 20 → balance 80', JSON.stringify(mid));

  /* Store issues 10 of the 20 */
  S.submitMaterialRequest(mr1.mrNumber);
  loginAs('Store Department', 'store_manager', 'Suresh Store');
  const si = S.issueMaterial({
    mrNumber: mr1.mrNumber,
    issueQtyById: { RM001: 10 },
    receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true },
    remarks: 'First issue'
  });
  check(si.issueNumber.startsWith('SI-'), 'Material Issue slip created (existing workflow intact)', si.issueNumber);

  loginAs('Production Department', 'production_manager', 'Ravi Kumar');
  const after = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM001');
  check(after.termsRequiredQty === 100, 'Required = 100');
  check(after.requestedQty === 20, 'Already Requested = 20');
  check(after.issuedQty === 10, 'Already Issued = 10');
  check(after.balanceQty === 70, 'Balance = 100 − 20 − 10 = 70', String(after.balanceQty));
  check(after.availableQty === 50, 'Available Store Stock read from the inventory module = 50 (60 − 10 issued)', String(after.availableQty));
  check(after.shortageQty === 20, 'Shortage = 70 − 50 = 20 (§5)', String(after.shortageQty));
}

/* -------------------------------------------------------------------------- */
section('4. Request quantity cannot exceed the balance (§4/§17)');
{
  const base = { jobCardNumber: 'JC-2026-001', salesOrderRef: 'SO-2026-001', customer: 'ACME Controls', partName: 'Frame', projectId: 'PRJ-1' };
  const line = (qty) => ({
    materialId: 'RM001',
    materialName: 'EN8 Round Bar',
    unit: 'Nos',
    requiredQty: qty,
    sourceType: SOURCE_TYPE.TERMS_REQUIREMENT,
    termsRequirementItemId: 'l-rm001',
    termsRequiredQty: 100
  });

  expectThrows(() => S.createMaterialRequest({ ...base, items: [line(80)] }), /exceeds the remaining balance 70/, 'request 80 > balance 70 rejected');

  const mr2 = S.createMaterialRequest({ ...base, items: [line(50)] });
  check(mr2.items[0].requiredQty === 50, 'request 50 ≤ balance 70 accepted');

  /* editing itself does not count against itself */
  S.updateMaterialRequest(mr2.mrNumber, { ...base, items: [line(70)] });
  const stored = materialRequests().find((m) => m.mrNumber === mr2.mrNumber);
  check(stored.items[0].requiredQty === 70, 'editing MR-2 up to the full balance works (own 50 not double counted)');

  expectThrows(() => S.createMaterialRequest({ ...base, items: [line(71)] }), /exceeds the remaining balance/, 'a fresh request after the edit is still capped');

  expectThrows(
    () =>
      S.createMaterialRequest({
        ...base,
        items: [
          { materialId: 'RM004', materialName: 'Copper Wire', unit: 'Mtr', requiredQty: 5, termsRequiredQty: 30, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm004' },
          { materialId: 'RM004', materialName: 'Copper Wire', unit: 'Mtr', requiredQty: 2, termsRequiredQty: 30, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm004' }
        ]
      }),
    /already included in the Material Request/,
    'duplicate item inside one request rejected (§9)'
  );

  expectThrows(
    () =>
      S.createMaterialRequest({
        ...base,
        items: [{ materialId: 'GHOST-1', materialName: 'Ghost', unit: 'Nos', requiredQty: 1 }]
      }),
    /not in the inventory master/,
    'item must exist in the Item Master (§10)'
  );
}

/* -------------------------------------------------------------------------- */
section('5. Additional Item (+ Add Item) rules (§6/§7/§17)');
{
  const base = { jobCardNumber: 'JC-2026-001', salesOrderRef: 'SO-2026-001', customer: 'ACME Controls', partName: 'Frame', projectId: 'PRJ-1' };

  expectThrows(
    () =>
      S.createMaterialRequest({
        ...base,
        items: [
          {
            materialId: 'RM006',
            materialName: 'MS Angle',
            unit: 'Nos',
            requiredQty: 10,
            termsRequiredQty: 10,
            sourceType: SOURCE_TYPE.ADDITIONAL,
            reason: '',
            addedBy: 'Ravi Kumar',
            addedDate: '2026-10-03'
          }
        ]
      }),
    /needs a reason/,
    'Additional Item without a reason rejected'
  );

  const mr = S.createMaterialRequest({
    ...base,
    items: [
      {
        materialId: 'RM006',
        materialName: 'MS Angle',
        unit: 'Nos',
        requiredQty: 10,
        termsRequiredQty: 10,
        sourceType: SOURCE_TYPE.ADDITIONAL,
        reason: 'Item missed in Terms & Requirement',
        addedBy: 'Ravi Kumar',
        addedDate: '2026-10-03'
      }
    ]
  });
  const it = mr.items[0];
  check(it.sourceType === 'ADDITIONAL', 'sourceType stored as ADDITIONAL', it.sourceType);
  check(it.reason === 'Item missed in Terms & Requirement', 'reason stored for the audit trail');
  check(it.addedBy === 'Ravi Kumar' && it.addedDate === '2026-10-03', 'addedBy / addedDate stored');
  check(S.resolveSourceType(it) === SOURCE_TYPE.ADDITIONAL, 'resolveSourceType reads the stored type');
  check(SOURCE_TYPE_LABEL[SOURCE_TYPE.TERMS_REQUIREMENT] === 'Terms Requirement', 'Terms Requirement label');
  check(SOURCE_TYPE_LABEL[SOURCE_TYPE.ADDITIONAL] === 'Additional Item', 'Additional Item label');

  /* legacy line (saved before sourceType existed) still saves without a reason */
  const legacy = S.createMaterialRequest({
    ...base,
    items: [{ materialId: 'OFF-9', materialName: 'Retired Item', unit: 'Nos', requiredQty: 1 }]
  });
  check(legacy.items[0].sourceType === 'ADDITIONAL', 'legacy line falls back to ADDITIONAL (manually added)');
  check(S.resolveSourceType({ termsRequirementItemId: 'l-x' }) === SOURCE_TYPE.TERMS_REQUIREMENT, 'line with a Terms id resolves to TERMS_REQUIREMENT');
}

/* -------------------------------------------------------------------------- */
section('6. Scope rules: cancelled requests + multiple Job Cards (§12/§13)');
{
  const mr3 = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-001',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    items: [
      { materialId: 'RM003', materialName: 'Grinding Wheel', unit: 'Nos', requiredQty: 10, termsRequiredQty: 10, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm003' }
    ]
  });
  const beforeCancel = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM003');
  check(beforeCancel.requestedQty === 10 && beforeCancel.balanceQty === 0, 'a draft request counts as Requested', JSON.stringify(beforeCancel));

  S.cancelMaterialRequest(mr3.mrNumber, 'Not needed');
  const afterCancel = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM003');
  check(afterCancel.requestedQty === 0 && afterCancel.balanceQty === 10, 'a Cancelled request no longer counts (§13)');

  /* sibling job card of the same Sales Order */
  const mr4 = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-002',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Cover',
    projectId: 'PRJ-1',
    items: [
      { materialId: 'RM005', materialName: 'Special Cutting Insert', unit: 'Nos', requiredQty: 5, termsRequiredQty: 5, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm005' }
    ]
  });
  const jc2 = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-002' }).find((l) => l.itemCode === 'RM005');
  check(mr4.jobCardId === 'JC-2026-002' && jc2.requestedQty === 5 && jc2.balanceQty === 0, 'Job Card 2 tracks its own 5/5 requirement', JSON.stringify(jc2));
  const jc1 = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM001');
  check(jc1.requestedQty === 90, 'Job Card 1 = MR-1 (20) + MR-2 (70); Job Card 2 adds nothing to it', String(jc1.requestedQty));
}

/* -------------------------------------------------------------------------- */
section('7. Store stock check + Material Issue end-to-end (§5/§14/§21)');
{
  const lines = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' });
  const rm2 = lines.find((l) => l.itemCode === 'RM002');
  check(rm2.termsRequiredQty === 20 && rm2.availableQty === 100 && rm2.shortageQty === 0, 'stock shown for Cutting Oil (no shortage)', JSON.stringify(rm2));

  const mr5 = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-001',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    items: [
      { materialId: 'RM002', materialName: 'Cutting Oil', unit: 'L', requiredQty: 20, termsRequiredQty: 20, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm002' }
    ]
  });
  S.submitMaterialRequest(mr5.mrNumber);
  check(S.decorateMR(materialRequests().find((m) => m.mrNumber === mr5.mrNumber)).status === STATUS.SUBMITTED, 'submitted to the Store');

  loginAs('Store Department', 'store_manager', 'Suresh Store');
  const short = S.getMaterialShortages(materialRequests().find((m) => m.mrNumber === mr5.mrNumber));
  check(short[0].required === 20 && short[0].available === 100 && short[0].balance === 20 && short[0].shortage === 0, 'Store stock check reuses the existing inventory module', JSON.stringify(short[0]));

  const si = S.issueMaterial({
    mrNumber: mr5.mrNumber,
    issueQtyById: { RM002: 20 },
    receiver: { name: 'Suresh Store', employeeId: 'EMP-STORE-1', acknowledged: true }
  });
  check(si.items[0].currentIssueQty === 20, 'full quantity issued');
  check(si.jobCardNumber === 'JC-2026-001' && si.salesOrderRef === 'SO-2026-001', 'issue slip keeps the Job Card + Sales Order link');

  const inv = S.getInventoryItems().find((i) => i.itemCode === 'RM002');
  check(inv.currentQty === 80, 'store stock decremented 100 → 80', String(inv.currentQty));

  const mr5Stored = materialRequests().find((m) => m.mrNumber === mr5.mrNumber);
  check(S.decorateMR(mr5Stored).status === STATUS.FULL, 'Material Request becomes Fully Issued');

  loginAs('Production Department', 'production_manager', 'Ravi Kumar');
  const rm2After = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM002');
  check(rm2After.requestedQty === 20 && rm2After.issuedQty === 20 && rm2After.balanceQty === 0, 'fully requested + issued → balance 0 (no double request possible)');
}

section('8. Audit trail (§15)');
{
  const entry = auditLog().find((a) => a.action === 'MR CREATED' && a.reference === 'MR-000001');
  check(Boolean(entry), 'MR CREATED audit entry written');
  check(/SO SO-2026-001/.test(entry.details) && /JC JC-2026-001/.test(entry.details), 'audit carries Sales Order + Job Card', entry?.details);
  check(/Terms Requirement/.test(entry.details), 'audit shows the Terms / Additional breakdown', entry?.details);
  const extra = auditLog().find((a) => a.action === 'MR CREATED' && /Additional Item/.test(a.details));
  check(Boolean(extra), 'additional-item request audited separately', extra?.details);
}

/* -------------------------------------------------------------------------- */
section('9. Job Card is optional — the Sales Order anchors the request (§16)');
{
  const noJc = S.createMaterialRequest({
    jobCardNumber: '',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: '',
    items: [
      { materialId: 'RM004', materialName: 'Copper Wire', unit: 'Mtr', requiredQty: 5, termsRequiredQty: 30, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm004' }
    ]
  });
  check(noJc.jobCardNumber === '' && noJc.jobCardId === '', 'request saved without a Job Card', `jc="${noJc.jobCardNumber}"`);
  check(noJc.salesOrderId === 'SO-2026-001' && noJc.materialRequestId === noJc.mrNumber, 'Sales Order + MR aliases still stored');

  const soScope = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: '' }).find((l) => l.itemCode === 'RM004');
  check(soScope.requestedQty === 5, 'a Job-Card-less request still counts in the Sales Order scope', String(soScope.requestedQty));
  const jcScope = T.getMaterialRequestLines({ salesOrderId: 'SO-2026-001', jobCardNumber: 'JC-2026-001' }).find((l) => l.itemCode === 'RM004');
  check(jcScope.requestedQty === 5, 'and it is visible from a Job Card view of the same Sales Order', String(jcScope.requestedQty));

  const withJc = S.createMaterialRequest({
    jobCardNumber: 'JC-2026-001',
    salesOrderRef: 'SO-2026-001',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    items: [
      { materialId: 'RM003', materialName: 'Grinding Wheel', unit: 'Nos', requiredQty: 5, termsRequiredQty: 10, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm003' }
    ]
  });
  check(withJc.jobCardNumber === 'JC-2026-001', 'request saved with a Job Card', withJc.jobCardNumber);

  S.updateMaterialRequest(withJc.mrNumber, {
    salesOrderRef: 'SO-2026-001',
    jobCardNumber: '',
    customer: 'ACME Controls',
    partName: 'Frame',
    projectId: 'PRJ-1',
    items: [
      { materialId: 'RM003', materialName: 'Grinding Wheel', unit: 'Nos', requiredQty: 5, termsRequiredQty: 10, sourceType: SOURCE_TYPE.TERMS_REQUIREMENT, termsRequirementItemId: 'l-rm003' }
    ]
  });
  const cleared = materialRequests().find((m) => m.mrNumber === withJc.mrNumber);
  check(cleared.jobCardNumber === '' && cleared.jobCardId === '', 'clearing the Job Card on edit is honoured', `jc="${cleared.jobCardNumber}"`);

  const noAnchor = S.createMaterialRequest({
    jobCardNumber: '',
    salesOrderRef: '',
    customer: '',
    partName: '',
    items: [{ materialId: 'RM004', materialName: 'Copper Wire', unit: 'Mtr', requiredQty: 1 }]
  });
  check(Boolean(noAnchor.mrNumber), 'the service itself never blocks on a missing Job Card', noAnchor.mrNumber);
}

/* ---------------------------------- summary ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
assert.ok(failed === 0);
