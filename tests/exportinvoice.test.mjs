/**
 * Unit tests for the two-PDF feature helpers:
 *   - src/utils/poTemplate.js        (PO packing/freight totals + Rs words)
 *   - src/utils/exportInvoiceService.js (USD totals, numbering, CRUD)
 *
 * Run:  node tests/exportinvoice.test.mjs
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

const P = await import('../src/utils/poTemplate.js');
const E = await import('../src/utils/exportInvoiceService.js');

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

/* ================================ poTemplate ================================ */
console.log('\n== computePOTotals');
const base = {
  subtotal: 16850,
  discount: 0,
  taxableAmount: 16850,
  totalGST: 3033,
  cgst: 1516.5,
  sgst: 1516.5,
  grandTotal: 19883
};

const t1 = P.computePOTotals(base, { packingCharges: 500, freight: 300 });
check(t1.subTotal === 17350, 'sub total = taxable + packing (17350)', `got ${t1.subTotal}`);
check(t1.grandTotal === 20683, 'grand total = sub total + cgst + sgst + freight (20683)', `got ${t1.grandTotal}`);
check(t1.gstRate === 9, 'the effective half-rate is 9% (18% GST)', `got ${t1.gstRate}`);
check(t1.packingCharges === 500 && t1.freight === 300, 'packing and freight are carried through');

const t2 = P.computePOTotals(base, {});
check(t2.packingCharges === 0 && t2.freight === 0, 'legacy POs without charge fields default to 0');
check(t2.grandTotal === 19883, 'legacy grand total is unchanged', `got ${t2.grandTotal}`);

const t3 = P.computePOTotals({ ...base, discount: 850, taxableAmount: 16000, totalGST: 2880, cgst: 1440, sgst: 1440, grandTotal: 18880 }, { packingCharges: 200, freight: 100 });
check(t3.discount === 850, 'the document discount is carried to the block');
check(t3.grandTotal === 19180, 'discount + packing + freight + tax combine (19180)', `got ${t3.grandTotal}`);

console.log('\n== poAmountInWords');
check(P.poAmountInWords(20683) === 'Rs. Twenty Thousand Six Hundred Eighty Three Only.', 'integer words format Rs. ... Only.', `got "${P.poAmountInWords(20683)}"`);
check(P.poAmountInWords(19883) === 'Rs. Nineteen Thousand Eight Hundred Eighty Three Only.', 'matches the attached PO sample wording', `got "${P.poAmountInWords(19883)}"`);
check(P.poAmountInWords(0) === 'Rs. Zero Only.', 'zero renders safely', `got "${P.poAmountInWords(0)}"`);
check(P.poAmountInWords(1000.5) === 'Rs. One Thousand and Fifty Paise Only.', 'paise are kept', `got "${P.poAmountInWords(1000.5)}"`);

/* ============================ exportInvoiceService ============================ */
console.log('\n== numbering & words');
const preview = E.previewExportInvoiceNumber();
check(/^GST\/\d{2}-\d{2}\/001$/.test(preview), `preview number follows GST/yy-yy/nnn (${preview})`);
check(E.usdAmountInWords(850) === 'Eight Hundred Fifty Only.', 'USD words match the attached sample', `got "${E.usdAmountInWords(850)}"`);
check(E.usdAmountInWords(0) === 'Zero Only.', 'zero USD words render', `got "${E.usdAmountInWords(0)}"`);

console.log('\n== totals');
const calc = E.computeExportTotals([
  { description: 'Part A', quantity: 10.625, rate: 80 },
  { description: 'Part B', quantity: 2, rate: 12.5 },
  { description: '   ', quantity: 5, rate: 100 }
]);
check(calc.rows.length === 2, 'blank-description rows are dropped');
check(calc.rows[0].amount === 850, 'qty x rate line amount (850)', `got ${calc.rows[0].amount}`);
check(calc.amountUSD === 875, 'total USD sums the line amounts (875)', `got ${calc.amountUSD}`);

console.log('\n== CRUD');
localStorage.setItem('companySettings', JSON.stringify({ companyName: 'PRAGMATIC ENGINEERS' }));
const good = {
  invoiceNumber: 'GST/26-27/001',
  invoiceDate: '2026-10-01',
  buyer: { name: 'ABC TRADING LLC', address: 'Dubai' },
  items: [{ description: 'CNC PARTS', quantity: 4, rate: 25 }]
};
const entry = E.createExportInvoice(good);
check(entry.reference === 'GST/26-27/001', 'the invoice is created under its number');
check(entry.payload.totals.amountUSD === 100, 'the stored total is 100', `got ${entry.payload.totals.amountUSD}`);
check(entry.payload.amountInWords === 'One Hundred Only.', 'the stored words are computed', `got "${entry.payload.amountInWords}"`);
check(E.previewExportInvoiceNumber() === 'GST/26-27/002', 'the sequence advanced to 002');
check(E.getExportInvoice('GST/26-27/001')?.buyer === 'ABC TRADING LLC' || E.getExportInvoice('GST/26-27/001')?.payload?.buyer?.name === 'ABC TRADING LLC', 'the invoice can be read back');

try {
  E.createExportInvoice(good);
  check(false, 'a duplicate invoice number is rejected');
} catch (err) {
  check(/already exists/.test(err.message), `a duplicate invoice number is rejected → "${err.message}"`);
}

try {
  E.createExportInvoice({ invoiceNumber: 'GST/26-27/009', invoiceDate: '2026-10-01', buyer: { name: '' }, items: [{ description: 'X', quantity: 1, rate: 1 }] });
  check(false, 'a missing buyer is rejected');
} catch (err) {
  check(/Buyer/.test(err.message), `a missing buyer is rejected → "${err.message}"`);
}

try {
  E.createExportInvoice({ invoiceNumber: 'GST/26-27/009', invoiceDate: '2026-10-01', buyer: { name: 'X' }, items: [] });
  check(false, 'an empty item list is rejected');
} catch (err) {
  check(/item/.test(err.message), `an empty item list is rejected → "${err.message}"`);
}

const updated = E.updateExportInvoice('GST/26-27/001', {
  ...good,
  items: [{ description: 'CNC PARTS', quantity: 8, rate: 25 }],
  status: 'Issued'
});
check(updated.payload.totals.amountUSD === 200, 'update recomputes the total (200)', `got ${updated.payload.totals.amountUSD}`);
check(updated.status === 'Issued', 'update stores the status');

let deleteMessage = '';
try { E.deleteExportInvoice('GST/26-27/001'); } catch (error) { deleteMessage = error.message; }
check(deleteMessage.includes('cancelled through the controlled workflow'), 'permanent deletion is rejected; invoices must use controlled cancellation');
check(E.getExportInvoice('GST/26-27/001') !== null, 'the invoice remains available after rejected permanent deletion');

console.log('\n== export profile');
const prof = E.saveExportProfile({ iecNumber: 'TEST-IEC-1' });
check(prof.iecNumber === 'TEST-IEC-1', 'profile saves');
check(E.getExportProfile().iecNumber === 'TEST-IEC-1', 'profile reads back');
check(E.getExportProfile().lutNumber === E.DEFAULT_EXPORT_PROFILE.lutNumber, 'profile preserves the configured default LUT value');

console.log('\n== static text');
check(E.lutDeclarationText('LUT-1').includes('Rule 96A'), 'the Rule 96A declaration mentions Rule 96A');
check(E.lutDeclarationText('LUT-1').includes('LUT-1'), 'the LUT number is embedded');
check(E.CLAIM_DRAWBACK_LINE.includes('Duty Drawback'), 'the duty drawback line exists');
check(E.CLAIM_MEIS_LINE.includes('MEIS'), 'the MEIS/RODTEP line exists');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('PO template + Export Invoice service OK');
