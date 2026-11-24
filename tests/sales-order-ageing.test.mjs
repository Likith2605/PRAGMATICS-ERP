import assert from 'node:assert/strict';
import { applyReportFilters } from '../src/utils/reportFilters.js';
import { calculateSalesOrderAgeing, formatMoneyByCurrency, formatQuantityMap, sumQuantityMaps } from '../src/utils/salesOrderAgeing.js';
import { buildReportWorkbook } from '../src/utils/reportExports.js';
import * as XLSX from 'xlsx';

const line = (itemCode, itemName, quantity, unit = 'Nos', lineId = '') => ({ itemCode, itemName, quantity, unit, ...(lineId ? { lineId } : {}) });
const so = (reference, projectId, items, extra = {}) => ({
  reference,
  date: '2026-01-01',
  company: 'Test Customer',
  payload: { soDetails: { soNumber: reference, projectId }, items },
  ...extra
});
const dc = (reference, salesOrderRef, items, status = 'Dispatched') => ({
  reference,
  status,
  salesOrderRef,
  payload: { dcDetails: { dcNumber: reference, salesOrderRef, challanStatus: status }, items }
});

// Same project must not leak one order's challan quantity into another order.
const sharedProject = calculateSalesOrderAgeing([
  so('SO-A', 'P-1', [line('A', 'Widget A', 10)]),
  so('SO-B', 'P-1', [line('B', 'Widget B', 20)])
], [dc('DC-A', 'SO-A', [line('A', 'Widget A', 3)])]);
assert.equal(sharedProject.rows[0].deliveredQty, '3 Nos');
assert.equal(sharedProject.rows[0].pendingQty, '7 Nos');
assert.equal(sharedProject.rows[1].deliveredQty, '0');
assert.equal(sharedProject.rows[1].pendingQty, '20 Nos');

const byOrderId = calculateSalesOrderAgeing([
  so('SO-ID', 'P-ID', [line('ID-A', 'ID Widget', 4)], { id: 'sales-order-db-id' })
], [{ reference: 'DC-ID', salesOrderId: 'sales-order-db-id', status: 'Dispatched', payload: { dcDetails: { dcNumber: 'DC-ID' }, items: [line('ID-A', 'ID Widget', 1)] } }]);
assert.equal(byOrderId.rows[0].deliveredQty, '1 Nos', 'an exact recorded Sales Order ID is a valid link');

// Exact order/item/UOM allocation, multiple items and multiple partial deliveries.
const partials = calculateSalesOrderAgeing([so('SO-M', 'P-2', [
  line('A', 'Widget A', 10, 'Nos'), line('B', 'Steel', 5, 'Kg'), line('C', 'Oil', 8, 'L')
])], [
  dc('DC-1', 'SO-M', [line('A', 'Widget A', 2, 'Nos'), line('B', 'Steel', 1, 'Kg')]),
  dc('DC-2', 'SO-M', [line('A', 'Widget A', 3, 'Nos'), line('C', 'Oil', 4, 'L')])
]);
assert.equal(partials.rows[0].orderedQty, '10 Nos | 5 Kg | 8 L');
assert.equal(partials.rows[0].deliveredQty, '5 Nos | 1 Kg | 4 L');
assert.equal(partials.rows[0].pendingQty, '5 Nos | 4 Kg | 4 L');

// A unit mismatch is an exception and makes pending for that UOM unavailable.
const wrongUnit = calculateSalesOrderAgeing([so('SO-U', 'P-3', [line('A', 'Steel', 10, 'Kg')])], [dc('DC-U', 'SO-U', [line('A', 'Steel', 2, 'Nos')])]);
assert.equal(wrongUnit.rows[0].deliveredQty, '0');
assert.match(wrongUnit.rows[0].pendingQty, /Unavailable \(Kg\)/);
assert.match(wrongUnit.exceptions[0].reason, /UOM does not match/);

// Missing Sales Order reference stays unallocated and marks a matching order's pending UOM unknown.
const noReference = calculateSalesOrderAgeing([so('SO-N', 'P-4', [line('A', 'Bracket', 7, 'Nos')])], [dc('DC-N', '', [line('A', 'Bracket', 2, 'Nos')])]);
assert.equal(noReference.rows[0].deliveredQty, '0');
assert.match(noReference.rows[0].pendingQty, /Unavailable \(Nos\)/);
assert.match(noReference.exceptions[0].reason, /Missing Sales Order reference/);

const noChallanNumber = calculateSalesOrderAgeing([so('SO-NO-DC', 'P-4A', [line('A', 'Bracket', 6)])], [{ salesOrderRef: 'SO-NO-DC', payload: { dcDetails: { salesOrderRef: 'SO-NO-DC' }, items: [line('A', 'Bracket', 2)] } }]);
assert.match(noChallanNumber.rows[0].pendingQty, /Unavailable \(Nos\)/);
assert.match(noChallanNumber.exceptions[0].reason, /no recorded unique reference/);

// A provided but unresolved line reference is not silently replaced with item matching.
const ambiguousLine = calculateSalesOrderAgeing([so('SO-L', 'P-5', [line('A', 'Bracket', 7, 'Nos', 'LINE-1')])], [dc('DC-L', 'SO-L', [line('A', 'Bracket', 2, 'Nos', 'LINE-404')])]);
assert.equal(ambiguousLine.rows[0].deliveredQty, '0');
assert.match(ambiguousLine.exceptions[0].reason, /Explicit challan line reference/);

// Exact item name may be used when a code is absent only if it resolves to one identity.
const ambiguousName = calculateSalesOrderAgeing([so('SO-AMB', 'P-6', [line('A', 'Shared name', 3), line('B', 'Shared name', 4)])], [dc('DC-AMB', 'SO-AMB', [{ itemName: 'Shared name', quantity: 1, unit: 'Nos' }])]);
assert.match(ambiguousName.exceptions[0].reason, /multiple Sales Order line groups/);

// Over-delivery is displayed explicitly instead of disappearing at the ordered quantity.
const over = calculateSalesOrderAgeing([so('SO-O', 'P-7', [line('A', 'Bracket', 5)])], [dc('DC-O', 'SO-O', [line('A', 'Bracket', 8)])]);
assert.equal(over.rows[0].deliveredQty, '8 Nos');
assert.equal(over.rows[0].pendingQty, '0');
assert.equal(over.rows[0].overDeliveredQty, '3 Nos');
assert.match(over.rows[0].allocationStatus, /Over-delivered/);

// Duplicate challan references are excluded in full to prevent duplicate quantities.
const duplicates = calculateSalesOrderAgeing([so('SO-D', 'P-8', [line('A', 'Bracket', 10)])], [
  dc('DC-DUP', 'SO-D', [line('A', 'Bracket', 2)]), dc('DC-DUP', 'SO-D', [line('A', 'Bracket', 2)])
]);
assert.equal(duplicates.rows[0].deliveredQty, '0');
assert.match(duplicates.rows[0].pendingQty, /Unavailable \(Nos\)/);
assert.match(duplicates.exceptions[0].reason, /Duplicate challan reference/);

// Duplicate SO references are ambiguous; the same challan cannot be assigned to both.
const duplicateOrders = calculateSalesOrderAgeing([
  so('SO-DUP', 'P-9', [line('A', 'Bracket', 5)]), so('SO-DUP', 'P-9', [line('A', 'Bracket', 5)])
], [dc('DC-REF', 'SO-DUP', [line('A', 'Bracket', 2)])]);
assert.equal(duplicateOrders.rows[0].deliveredQty, '0');
assert.equal(duplicateOrders.rows[1].deliveredQty, '0');
assert.match(duplicateOrders.exceptions[0].reason, /duplicated/);

// Filtered summaries and workbook exports retain only the filtered orders and split dimensions.
const filteredRows = applyReportFilters({
  rows: partials.rows,
  dateField: 'orderDate',
  filters: [{ key: 'customerName' }],
  selections: { customerName: 'Test Customer' }
}).filteredRows;
assert.equal(formatQuantityMap(sumQuantityMaps(filteredRows, 'orderedByUnit')), '10 Nos | 5 Kg | 8 L');
assert.equal(formatMoneyByCurrency([
  { orderValue: 10, orderValueCurrency: 'INR' }, { orderValue: 2, orderValueCurrency: 'USD' }
]), 'INR 10 | USD 2');
const workbook = buildReportWorkbook({ title: 'Ageing filtered', columns: [{ key: 'soNumber', label: 'Sales Order' }, { key: 'pendingQty', label: 'Pending' }], rows: filteredRows.map((row) => ({ soNumber: row.soNumber, pendingQty: row.pendingQty })) });
const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
const exported = XLSX.utils.sheet_to_json(reopened.Sheets['Ageing filtered'], { header: 1, defval: '' });
assert.ok(exported.some((row) => row.includes('SO-M')));
assert.ok(exported.some((row) => row.includes('5 Nos | 4 Kg | 4 L')));
console.log('Sales Order Ageing tests passed: exact reference/item/UOM allocation, partials, exceptions, over-delivery, duplicate prevention, filtered summaries and XLSX rows.');
