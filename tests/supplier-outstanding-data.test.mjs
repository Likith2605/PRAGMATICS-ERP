import assert from 'node:assert/strict';
import {
  buildSupplierOutstandingPartySummary,
  buildSupplierOutstandingRows,
  buildSupplierOutstandingSummary,
  sumSupplierOutstanding
} from '../src/utils/supplierOutstandingData.js';

const invoice = (reference, {
  supplier = 'North Metals', currency = 'INR', total = 100, paid = 0, advance = 0, status = 'Pending'
} = {}) => ({
  reference,
  vendor: supplier,
  date: '2026-11-25',
  status,
  advanceAdjusted: advance,
  payload: {
    vendorDetails: { companyName: supplier },
    invoiceDetails: { currency, amountPaid: paid, advanceAdjusted: advance },
    totals: { grandTotal: total }
  }
});
const advance = (advanceNumber, { supplier = 'North Metals', currency = 'INR', applied = 0, deletedAt = null } = {}) => ({
  advanceNumber, party: supplier, currency, appliedAmount: applied, deletedAt
});

const records = [
  invoice('NO-ADVANCE', { total: 100, paid: 20 }),
  invoice('PARTIAL', { total: 100, paid: 10, advance: 30, status: 'Partial' }),
  invoice('FULL', { total: 80, advance: 80, status: 'Paid' }),
  invoice('PAYMENT-AND-ADVANCE', { total: 200, paid: 50, advance: 25, status: 'Partial' }),
  invoice('SPLIT-A', { total: 50, advance: 50, status: 'Paid' }),
  invoice('SPLIT-B', { total: 70, advance: 70, status: 'Paid' }),
  invoice('OTHER-ADVANCE', { total: 100, advance: 15, status: 'Partial' }),
  invoice('REVERSED', { total: 50 }),
  invoice('USD-OUTSTANDING', { currency: 'USD', total: 100, paid: 10, advance: 30, status: 'Partial' }),
  invoice('CANCELLED', { total: 90, status: 'Cancelled' }),
  invoice('DRAFT', { total: 60, status: 'Draft' }),
  invoice('REJECTED', { total: 40, status: 'Rejected' })
];
const advances = [
  advance('UNALLOCATED'),
  advance('DELETED', { deletedAt: '2026-11-26T00:00:00.000Z' }),
  advance('PART-ADVANCE', { applied: 30 }),
  advance('FULL-ADVANCE', { applied: 80 }),
  advance('MIXED-ADVANCE', { applied: 25 }),
  advance('SPLIT-ADVANCE', { applied: 120 }),
  advance('SECOND-ADVANCE', { applied: 15 }),
  advance('REVERSED-ADVANCE', { applied: 0 }),
  advance('USD-ADVANCE', { currency: 'USD', applied: 30 }),
  advance('CANCELLED-SUPPLIER-ADVANCE', { applied: 0, supplier: 'Cancelled Vendor' }),
  advance('DRAFT-SUPPLIER-ADVANCE', { applied: 0, supplier: 'Draft Vendor' }),
  advance('REJECTED-SUPPLIER-ADVANCE', { applied: 0, supplier: 'Rejected Vendor' })
];

const activeAdvances = advances;
activeAdvances.find((row) => row.advanceNumber === 'UNALLOCATED').appliedAmount = 0;
const rows = buildSupplierOutstandingRows(records, activeAdvances);
assert.deepEqual(rows.map((row) => row.invoiceNumber), [
  'NO-ADVANCE', 'PARTIAL', 'PAYMENT-AND-ADVANCE', 'OTHER-ADVANCE', 'REVERSED', 'USD-OUTSTANDING'
]);
assert.equal(rows.find((row) => row.invoiceNumber === 'NO-ADVANCE').outstandingAmount, 80);
assert.equal(rows.find((row) => row.invoiceNumber === 'PARTIAL').outstandingAmount, 60);
assert.equal(rows.find((row) => row.invoiceNumber === 'PAYMENT-AND-ADVANCE').outstandingAmount, 125);
assert.equal(rows.find((row) => row.invoiceNumber === 'OTHER-ADVANCE').advanceAllocated, 15);
assert.equal(rows.find((row) => row.invoiceNumber === 'USD-OUTSTANDING').outstandingAmount, 60);
assert.equal(rows.some((row) => row.invoiceNumber === 'FULL'), false, 'fully settled invoices are not reported as outstanding');
assert.equal(rows.some((row) => row.invoiceNumber === 'CANCELLED'), false, 'cancelled invoices are excluded');
assert.equal(rows.some((row) => row.invoiceNumber === 'DRAFT'), false, 'draft invoices are excluded');
assert.equal(rows.some((row) => row.invoiceNumber === 'REJECTED'), false, 'rejected invoices are excluded');
assert.equal(rows.find((row) => row.invoiceNumber === 'NO-ADVANCE').advanceAllocated, 0,
  'an unallocated advance is never attached to an invoice balance');

const byCurrency = buildSupplierOutstandingSummary(rows);
assert.deepEqual(byCurrency.map((row) => [row.currency, row.outstandingAmount]), [['INR', 400], ['USD', 60]]);
assert.equal(sumSupplierOutstanding(rows.filter((row) => row.currency === 'INR'), 'outstandingAmount'), 400);
const partySummary = buildSupplierOutstandingPartySummary(rows);
assert.equal(partySummary.find((row) => row.currency === 'INR').outstandingAmount, 400);

assert.throws(
  () => buildSupplierOutstandingRows([invoice('MISMATCH', { advance: 15 })], [advance('MISMATCH-ADVANCE', { applied: 14 })]),
  /do not reconcile/
);
assert.throws(
  () => buildSupplierOutstandingRows([invoice('OVERPAID', { total: 10, paid: 8, advance: 3 })], [advance('OVERPAID-ADVANCE', { applied: 3 })]),
  /exceed its amount/
);
assert.throws(
  () => buildSupplierOutstandingRows([invoice('MISSING-PAID', { total: 'not-money' })], []),
  /not a valid decimal/
);
assert.throws(
  () => buildSupplierOutstandingRows([], null),
  /requires complete PostgreSQL/
);
assert.equal(
  buildSupplierOutstandingSummary([
    { currency: 'INR', invoiceAmount: 0.1001, amountPaid: 0, advanceAllocated: 0, outstandingAmount: 0.1001 },
    { currency: 'INR', invoiceAmount: 0.2002, amountPaid: 0, advanceAllocated: 0, outstandingAmount: 0.2002 }
  ])[0].outstandingAmount,
  0.3003,
  'financial totals add at four-decimal precision without binary floating-point accumulation'
);

console.log('Supplier Outstanding calculation checks passed.');
