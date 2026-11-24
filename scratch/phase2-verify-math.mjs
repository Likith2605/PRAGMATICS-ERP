// READ-ONLY Phase 2 report-math verification against REAL erp_state data.
// Replicates the exact calculations used by the new report pages and the
// existing pages they must agree with. Never writes anything.
import { getPool, closeDatabase } from '../server/database.js';

const db = getPool();
const get = async (key) => {
  const r = await db.query('SELECT data FROM erp_state WHERE storage_key = $1', [key]);
  return r.rows[0]?.data ?? null;
};

// ── Safeguard 7: Material Issue Register ────────────────────────────────
// Page flattens si.items[] and sums currentIssueQty (MaterialIssueRegisterPage).
// Existing StoreIssuesPage shows si.items.length per issue — cross-check both.
const issues = (await get('storeIssueHistory')) || [];
let flatLines = 0;
let totalIssuedQty = 0;
const perIssue = {};
issues.forEach((si) => {
  const lines = (si.items || []).length;
  const qty = (si.items || []).reduce((a, it) => a + (Number(it.currentIssueQty) || 0), 0);
  flatLines += lines;
  totalIssuedQty += qty;
  perIssue[si.issueNumber] = { lines, qty };
});
console.log('--- Safeguard 7: Material Issue Register ---');
console.log('issues in storeIssueHistory:', issues.length);
console.log('flattened issue lines (report rows):', flatLines);
console.log('total issued qty (register TOTAL):', totalIssuedQty);
const sample = Object.entries(perIssue).slice(0, 3);
sample.forEach(([k, v]) => console.log(`  sample ${k}: ${v.lines} line(s), qty ${v.qty}`));

// ── Safeguard 8: Material with Supplier ─────────────────────────────────
// Page uses atVendor = max(0, issuedQty - receivedQty) — the SAME formula as
// HTOutsourcePage.jsx line 200. Verify totals match on real records.
const htr = (await get('htOutsourceRequests')) || [];
const atVendor = (r) => Math.max(0, (Number(r.issuedQty) || 0) - (Number(r.receivedQty) || 0));
const pageTotal = htr.reduce((a, r) => a + atVendor(r), 0);
const vendorMap = {};
htr.forEach((r) => {
  const v = r.vendorName || 'Pending';
  vendorMap[v] = (vendorMap[v] || 0) + atVendor(r);
});
console.log('--- Safeguard 8: Material with Supplier ---');
console.log('HTR records:', htr.length);
console.log('total At Vendor (report + HT Outsource page):', pageTotal);
Object.entries(vendorMap)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .forEach(([v, q]) => console.log(`  ${v}: ${q}`));

// ── Customer mapping (safeguard 5 data shape check) ─────────────────────
const so = (await get('salesOrderHistory')) || [];
const inv = (await get('customerInvoiceHistory')) || [];
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
const txNames = new Set();
so.forEach((r) => { const n = norm(r.company || r.payload?.customerDetails?.companyName); if (n) txNames.add(n); });
inv.forEach((r) => { const n = norm(r.company || r.payload?.customerDetails?.companyName); if (n) txNames.add(n); });
console.log('--- Safeguard 5: customer name shapes ---');
console.log('sales orders:', so.length, '| invoices:', inv.length, '| distinct exact company names:', txNames.size);
console.log('sample names:', [...txNames].slice(0, 4));

// ── Valuation cross-check (safeguard 6 basis) ───────────────────────────
const mr = await db.query("SELECT count(*) AS n FROM module_records WHERE storage_key = 'inventoryItems'");
console.log('--- Valuation source ---');
console.log('inventoryItems per-record rows (module_records):', mr.rows[0].n);

await closeDatabase();

// ── Offline fixture check of report formulas (in-memory only) ───────────
// The live mirrored arrays are empty (post-cleanup state), so the grouping /
// totals math is exercised here against synthetic rows in memory. Nothing is
// written to the database, localStorage, or any file.
console.log('--- Offline fixture: Material Issue grouping (safeguard 7) ---');
const fxIssues = [
  { issueNumber: 'SI-1', receivedBy: 'Ravi', items: [{ currentIssueQty: 3 }, { currentIssueQty: 2 }] },
  { issueNumber: 'SI-2', receivedBy: 'Ravi', items: [{ currentIssueQty: 4 }] },
  { issueNumber: 'SI-3', receivedBy: 'Amit', items: [{ currentIssueQty: 1 }] }
];
let fxLines = 0;
let fxTotal = 0;
const fxByEmp = {};
fxIssues.forEach((si) => (si.items || []).forEach((it) => {
  fxLines += 1;
  const q = Number(it.currentIssueQty) || 0;
  fxTotal += q;
  fxByEmp[si.receivedBy] = (fxByEmp[si.receivedBy] || 0) + q;
}));
// Expected: 4 lines, total 10; Ravi 9, Amit 1.
console.log('lines:', fxLines, '(expect 4) | total:', fxTotal, '(expect 10) | by employee:', JSON.stringify(fxByEmp), '(expect Ravi 9, Amit 1)');
console.log('PASS grouping:', fxLines === 4 && fxTotal === 10 && fxByEmp.Ravi === 9 && fxByEmp.Amit === 1);

console.log('--- Offline fixture: atVendor formula (safeguard 8) ---');
const fxHtr = [
  { issuedQty: 10, receivedQty: 4 },
  { issuedQty: 5, receivedQty: 7 },
  { issuedQty: 0, receivedQty: 0 }
];
const fxAt = (r) => Math.max(0, (Number(r.issuedQty) || 0) - (Number(r.receivedQty) || 0));
const fxTotal2 = fxHtr.reduce((a, r) => a + fxAt(r), 0);
// Expected: 6 + 0 (clamped, same as HT Outsource page) + 0 = 6.
console.log('atVendor total:', fxTotal2, '(expect 6 — second row clamps to 0 like HTOutsourcePage)');
console.log('PASS formula:', fxTotal2 === 6);
