/**
 * Browser storage (localStorage ~5 MB) quota handling.
 *
 * Regression for: "Failed to execute 'setItem' on 'Storage': Setting the
 * value of 'vendorEnquiries' exceeded the quota."
 *
 * Covers:
 *  - writeLS retries after freeing derived data (backup snapshots, old audit
 *    / notification entries) instead of throwing a raw DOMException
 *  - a friendly, actionable error when nothing can be freed
 *  - launch-time enforceStorageBudget()
 *  - createVendorEnquiry succeeding while storage is full of snapshots
 *  - audit log / notification caps
 *  - performAutoSystemBackup keeping the snapshot archive inside its budget
 */

let QUOTA = 3 * 1024 * 1024;
const mem = new Map();

const bytes = () => {
  let n = 0;
  for (const [k, v] of mem) n += String(k).length + String(v).length;
  return n;
};

const quotaError = (key) => {
  const err = new Error(
    `Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`
  );
  err.name = 'QuotaExceededError';
  err.code = 22;
  return err;
};

globalThis.localStorage = {
  getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
  setItem: (k, v) => {
    const key = String(k);
    const val = String(v);
    const prev = mem.has(key) ? String(mem.get(key)).length : 0;
    if (bytes() - prev + key.length + val.length > QUOTA) throw quotaError(key);
    mem.set(key, val);
  },
  removeItem: (k) => mem.delete(String(k)),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  }
};

const origWarn = console.warn;
console.warn = () => {};

const S = await import('../src/utils/storeService.js');
const B = await import('../src/utils/backupManager.js');

/* --------------------------------- runner --------------------------------- */
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

const section = (name) => console.log(`\n== ${name}`);

const ls = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? JSON.stringify(fallback));
const reset = () => mem.clear();

const big = (kb) => 'x'.repeat(kb * 1024);

const seedSnapshots = (entries, kbEach) =>
  localStorage.setItem(
    'erpDailySnapshots',
    JSON.stringify(
      Array.from({ length: entries }, (_, i) => ({
        id: `s-${i}`,
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        data: { stockTransactions: big(kbEach) }
      }))
    )
  );

const seedAudit = (n) =>
  localStorage.setItem(
    'storeAuditLog',
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        id: `a-${i}`,
        action: 'SOME ACTION',
        reference: `REF-${i}`,
        details: 'entry '.repeat(12),
        timestamp: new Date().toISOString()
      }))
    )
  );

const seedNotifications = (n) =>
  localStorage.setItem(
    'notifications',
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `n-${i}`, title: 'T', message: 'm '.repeat(30), read: false })))
  );

/* ---------------------------------- tests --------------------------------- */

const fillToQuota = () => {
  QUOTA = bytes(); // no headroom: the next write can only succeed after cleanup
};

section('1. writeLS recovers instead of throwing when storage is full');

/* 1a — full of automatic backup snapshots (the historical culprit) */
reset();
QUOTA = 3 * 1024 * 1024;
seedSnapshots(3, 100);
seedAudit(600);
seedNotifications(300);
fillToQuota();
let threw = null;
try {
  S.writeLS('vendorEnquiries', [{ enquiryNumber: 'VE-000001', status: 'Draft' }]);
} catch (err) {
  threw = err;
}
check(!threw, '1a: writeLS did not throw', threw ? `→ ${threw.message}` : '');
check(
  (ls('vendorEnquiries', []).length || 0) === 1,
  '1a: the value was written after recovery',
  JSON.stringify(ls('vendorEnquiries', [])).slice(0, 80)
);
check(ls('erpDailySnapshots', []).length <= 1, '1a: backup snapshots trimmed to the latest copy');
check(bytes() < QUOTA, '1a: space was actually freed', `${bytes()} of ${QUOTA}`);

/* 1b — full of audit log entries only */
reset();
QUOTA = 3 * 1024 * 1024;
seedAudit(600);
fillToQuota();
threw = null;
try {
  S.writeLS('vendorEnquiries', [{ enquiryNumber: 'VE-000002' }]);
} catch (err) {
  threw = err;
}
check(!threw, '1b: writeLS did not throw', threw ? `→ ${threw.message}` : '');
check(ls('storeAuditLog', []).length === 500, '1b: audit log trimmed to its 500-entry cap', `${ls('storeAuditLog', []).length}`);

/* 1c — full of notifications only */
reset();
QUOTA = 3 * 1024 * 1024;
seedNotifications(300);
fillToQuota();
threw = null;
try {
  S.writeLS('vendorEnquiries', [{ enquiryNumber: 'VE-000003' }]);
} catch (err) {
  threw = err;
}
check(!threw, '1c: writeLS did not throw', threw ? `→ ${threw.message}` : '');
check(ls('notifications', []).length === 200, '1c: notifications trimmed to their 200-entry cap', `${ls('notifications', []).length}`);

section('2. friendly error when nothing can be reclaimed');
reset();
QUOTA = 3 * 1024 * 1024;
localStorage.setItem('stockTransactions', JSON.stringify({ rows: big(190) })); // business data, never trimmed
fillToQuota();
let msg = '';
try {
  S.writeLS('vendorEnquiries', [{ enquiryNumber: 'VE-000004' }]);
} catch (err) {
  msg = String(err.message);
}
check(/Browser storage is full/i.test(msg), 'error message is human readable', msg.slice(0, 140));
check(/Export a backup/i.test(msg), 'error message says what to do', msg.slice(0, 140));
check(!/exceeded the quota/.test(msg), 'raw DOMException text is not surfaced', msg.slice(0, 140));

section('3. createVendorEnquiry succeeds while storage is full of snapshots');
reset();
QUOTA = 3 * 1024 * 1024;
seedSnapshots(3, 120);
localStorage.setItem(
  'erp_auth',
  JSON.stringify({ isLoggedIn: true, username: 'Suresh', roleKey: 'purchase_manager', department: 'Purchase Department' })
);
fillToQuota();
let enquiry = null;
let enquiryErr = null;
try {
  enquiry = S.createVendorEnquiry({
    prNumber: 'PR-000001',
    projectId: 'PRJ-2026-001',
    items: [{ materialName: 'MS Plate 10mm', unit: 'Nos', requiredQty: 10, shortageQty: 10 }],
    vendors: [{ name: 'CLASSIC ENGINEERING INDUSTRIES', contact: 'Mr. Rao' }],
    remarks: 'Against indent IND-000001',
    termsAndConditions: '1) Quote per piece.'
  });
} catch (err) {
  enquiryErr = err;
}
check(!enquiryErr, 'createVendorEnquiry did not throw', enquiryErr ? `→ ${enquiryErr.message}` : '');
check(Boolean(enquiry?.enquiryNumber), 'enquiry number generated', enquiry?.enquiryNumber || '');
check(
  ls('vendorEnquiries', []).some((e) => e.enquiryNumber === enquiry?.enquiryNumber),
  'enquiry persisted to localStorage'
);

section('4. enforceStorageBudget() reclaims space at launch');
reset();
QUOTA = 6 * 1024 * 1024;
seedSnapshots(3, 1400); // > 4 MB of pure copies
const usedBefore = bytes();
check(usedBefore > 4 * 1024 * 1024, 'storage seeded above the budget', `${usedBefore} bytes`);
const summary = S.enforceStorageBudget();
check(typeof summary === 'string' && summary.length > 0, 'cleanup reported what it freed', String(summary).slice(0, 120));
check(bytes() <= 4 * 1024 * 1024, 'usage now under budget', `${bytes()} bytes`);
check(ls('erpDailySnapshots', []).length <= 1, 'snapshots reduced to the latest copy');
reset();
check(S.enforceStorageBudget() === null, 'nothing to do when comfortably under budget');

section('5. audit log and notification caps');
reset();
QUOTA = 3 * 1024 * 1024;
for (let i = 0; i < 600; i += 1) S.appendAuditLog({ action: `ACT ${i}`, reference: `R-${i}` });
check(ls('storeAuditLog', []).length === 500, 'audit log capped at 500 entries', `${ls('storeAuditLog', []).length}`);
check(ls('storeAuditLog', '')[0]?.action === 'ACT 599', 'newest audit entries are kept');
for (let i = 0; i < 250; i += 1) S.pushNotification({ title: `N ${i}`, message: 'm' });
check(ls('notifications', []).length === 200, 'notifications capped at 200 entries', `${ls('notifications', []).length}`);

section('6. auto backup snapshot archive stays inside its byte budget');
reset();
QUOTA = 3 * 1024 * 1024;
seedSnapshots(7, 100); // 7 days of ~100 KB copies = ~700 KB, over the 600 KB budget
localStorage.setItem('inventoryItems', JSON.stringify([{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm' }]));
const entry = B.performAutoSystemBackup('Unit Test');
check(Boolean(entry), 'auto backup ran', JSON.stringify(entry?.sizeKb || ''));
const snaps = ls('erpDailySnapshots', []);
const snapBytes = JSON.stringify(snaps).length;
check(snaps.length <= 7, 'no more than 7 snapshots kept', `${snaps.length}`);
check(snapBytes <= 600 * 1024 || snaps.length === 1, 'archive within the 600 KB budget', `${snapBytes} bytes`);
check(bytes() < 1024 * 1024, 'storage footprint stays modest', `${bytes()} bytes`);
check(ls('erpBackupAuditLogs', []).length <= 50, 'backup audit log capped');

/* --------------------------------- report --------------------------------- */
console.warn = origWarn;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
