/**
 * Multi-currency support: currency helper + tax-mode totals test.
 * Run:  node tests/currency.test.mjs
 *
 * Covers:
 *   currency helpers (symbols, INR fallback, FX conversion, amount in words)
 *   numberToWords backward compatibility (still "Rupees" by default)
 *   calculateTotals tax modes: intra (default CGST/SGST), inter (IGST),
 *   export (zero rated) - and the default output stays byte-identical to the
 *   legacy INR-only calculation.
 */

import assert from 'node:assert/strict';

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

const C = await import('../src/utils/currency.js');
const N = await import('../src/utils/numberToWords.js');
const CALC = await import('../src/utils/calculations.js');

/* ------------------------------- currency catalogue ------------------------------- */
check(C.DEFAULT_CURRENCY === 'INR', 'default currency is INR');
check(C.CURRENCIES.some((c) => c.code === 'INR' && c.symbol === '\u20B9'), 'INR is listed with the rupee symbol');
check(C.CURRENCIES.some((c) => c.code === 'USD' && c.symbol === '$'), 'USD is listed with the dollar symbol');
check(C.CURRENCIES.some((c) => c.code === 'EUR'), 'EUR is offered');
check(C.CURRENCIES.some((c) => c.code === 'GBP'), 'GBP is offered');
check(C.CURRENCIES.some((c) => c.code === 'AED'), 'AED is offered');

check(C.getCurrency('INR').code === 'INR', 'known currency resolves');
check(C.getCurrency('usd').code === 'USD', 'currency codes are case insensitive');
check(C.getCurrency('').code === 'INR', 'empty code falls back to INR');
check(C.getCurrency('XYZ').code === 'INR', 'unknown code falls back to INR');
check(C.getCurrency(undefined).code === 'INR', 'missing code falls back to INR');

check(!C.isForeignCurrency('INR'), 'INR is not a foreign currency');
check(!C.isForeignCurrency(undefined), 'missing currency is treated as INR');
check(C.isForeignCurrency('USD'), 'USD is a foreign currency');

/* ------------------------------- money formatting ------------------------------- */
const inr = C.money(1234.5);
check(inr.includes('\u20B9'), 'INR money keeps the rupee symbol', inr);
check(inr.includes('1,234.50'), 'INR money groups thousands (en-IN)', inr);

const usd = C.money(1234.5, 'USD');
check(usd.includes('$'), 'USD money uses the dollar symbol', usd);
check(usd.includes('1,234.50'), 'USD money is formatted to two decimals', usd);

check(C.money(NaN) === C.money(0), 'NaN renders as zero');
check(C.money('abc', 'GBP').includes('1,234.50') === false, 'non numeric input does not throw', C.money('abc', 'GBP'));
check(C.money(undefined, 'EUR').includes('0.00'), 'undefined renders as 0.00', C.money(undefined, 'EUR'));
check(C.moneyPlain(1000, 'USD') === '1,000.00', 'moneyPlain drops the symbol');
check(C.moneyPlain(1000) === '1,000.00', 'moneyPlain defaults to INR');

/* ------------------------------- INR conversion ------------------------------- */
check(C.convertToINR(100, 'INR') === 100, 'INR amount needs no rate');
check(C.convertToINR(100, 'INR', 0) === 100, 'INR amount ignores a zero rate');
check(C.convertToINR(100, 'USD', 83.4) === 8340, 'foreign amount converts with the stored rate');
check(C.convertToINR(100.5, 'USD', 83.4) === 8381.7, 'conversion rounds to 2 decimals', C.convertToINR(100.5, 'USD', 83.4));
check(C.convertToINR(100, 'USD', 0) === 0, 'an explicit zero rate converts to 0 instead of a bogus value');
check(C.convertToINR(100, 'USD') === 100, 'a missing rate falls back to 1:1 so the amount is never dropped');

/* ------------------------------- amount in words ------------------------------- */
check(N.numberToWords(1062) === 'One Thousand Sixty Two Rupees', 'legacy words still say Rupees', N.numberToWords(1062));
check(C.amountInWords(1062) === 'One Thousand Sixty Two Rupees', 'INR words are unchanged', C.amountInWords(1062));
check(C.amountInWords(1062, 'USD') === 'One Thousand Sixty Two Dollars', 'USD words say Dollars', C.amountInWords(1062, 'USD'));
check(C.amountInWords(2500, 'GBP') === 'Two Thousand Five Hundred Pounds', 'GBP words say Pounds', C.amountInWords(2500, 'GBP'));
check(C.amountInWords(0, 'EUR') === 'Zero Euros', 'zero renders as Zero <currency>', C.amountInWords(0, 'EUR'));
check(N.numberToWords(0) === 'Zero Rupees', 'zero legacy words still say Zero Rupees');
check(N.numberToWords(1062.5).includes('Paise'), 'legacy paise suffix is preserved', N.numberToWords(1062.5));
check(C.amountInWords(1062.5, 'USD').includes('Cents'), 'USD cents suffix', C.amountInWords(1062.5, 'USD'));
check(C.amountInWords(1062, 'XYZ') === 'One Thousand Sixty Two Rupees', 'unknown currency falls back to Rupees');

/* ------------------------------- totals: default (intra) ------------------------------- */
const items = [
  { amount: 1000, gstAmount: 180 },
  { amount: 500, gstAmount: 90 }
];

const base = CALC.calculateTotals(items, 0);
check(base.cgst === 135 && base.sgst === 135, 'default splits GST into CGST + SGST', JSON.stringify(base));
check(base.igst === 0, 'default has no IGST');
check(base.taxMode === 'intra', 'default tax mode is intra state');
check(base.subtotal === 1500, 'subtotal is the sum of line amounts');
check(base.grandTotal === 1770, 'grand total = taxable + GST', String(base.grandTotal));

const withDiscount = CALC.calculateTotals(items, 50);
check(withDiscount.taxableAmount === 1450, 'discount reduces the taxable amount');
check(withDiscount.grandTotal === 1711, 'discount scales the GST too', String(withDiscount.grandTotal));

const legacy = (() => {
  const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const discountValue = 0;
  const taxableAmount = Math.max(0, subtotal - discountValue);
  const discountRatio = subtotal > 0 ? taxableAmount / subtotal : 1;
  const totalGST = items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0) * discountRatio;
  return {
    subtotal: Number(subtotal.toFixed(2)),
    discount: Number(discountValue.toFixed(2)),
    taxableAmount: Number(taxableAmount.toFixed(2)),
    totalGST,
    cgst: Number((totalGST / 2).toFixed(2)),
    sgst: Number((totalGST / 2).toFixed(2)),
    grandTotal: Number((taxableAmount + totalGST).toFixed(2))
  };
})();
const defaulted = CALC.calculateTotals(items, 0);
const legacyComparable = Object.fromEntries(Object.keys(legacy).map((k) => [k, defaulted[k]]));
check(JSON.stringify(legacyComparable) === JSON.stringify(legacy), 'default output matches the legacy INR calculation', JSON.stringify(legacyComparable));

/* ------------------------------- totals: inter state (IGST) ------------------------------- */
const inter = CALC.calculateTotals(items, 0, 'inter');
check(inter.igst === 270, 'inter state moves the whole tax into IGST', String(inter.igst));
check(inter.cgst === 0 && inter.sgst === 0, 'inter state has no CGST/SGST split');
check(inter.totalGST === base.totalGST, 'total tax value is unchanged by the mode');
check(inter.grandTotal === base.grandTotal, 'grand total is unchanged by the mode');
check(inter.taxMode === 'inter', 'tax mode is reported back');

/* ------------------------------- totals: export (zero rated) ------------------------------- */
const exp = CALC.calculateTotals(items, 0, 'export');
check(exp.totalGST === 0, 'export invoices are zero rated', String(exp.totalGST));
check(exp.igst === 0 && exp.cgst === 0 && exp.sgst === 0, 'export invoices carry no tax split');
check(exp.grandTotal === exp.taxableAmount, 'export grand total equals the taxable amount');
check(exp.subtotal === 1500, 'export subtotal is unchanged');

/* ------------------------------- totals: safety ------------------------------- */
const bogus = CALC.calculateTotals(items, 0, 'not-a-mode');
check(bogus.taxMode === 'intra' && bogus.cgst === 135, 'unknown tax mode falls back to intra', JSON.stringify(bogus));
check(CALC.calculateTotals([], 0).grandTotal === 0, 'no items means a zero grand total');

/* ---------------------------------- summary ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
assert.ok(failed === 0);
