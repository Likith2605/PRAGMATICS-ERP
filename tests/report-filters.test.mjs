import assert from 'node:assert/strict';
import { applyReportFilters, formatQuantityByUnit, normalizeReportDate, validateReportDateRange } from '../src/utils/reportFilters.js';
import { buildReportWorkbook, scheduleReportPrint } from '../src/utils/reportExports.js';
import * as XLSX from 'xlsx';

assert.equal(normalizeReportDate('2026-02-08T13:20:00Z'), '2026-02-08');
assert.equal(normalizeReportDate('08/02/2026'), '2026-02-08');
assert.equal(normalizeReportDate('31/02/2026'), null);
assert.equal(validateReportDateRange('2026-02-09', '2026-02-08'), 'From Date cannot be later than To Date.');
assert.equal(validateReportDateRange('08/02/2026', '2026-02-09'), '');

const rows = [
  { date: '2026-02-08', customer: 'Acme', employee: 'E1', item: 'Steel', unit: 'Kg', currency: 'INR', amount: 10 },
  { date: '09/02/2026', customer: 'Acme', employee: 'E2', item: 'Bolt', unit: 'Nos', currency: 'INR', amount: 5 },
  { date: '2026-02-10', customer: 'Beta', employee: 'E1', item: 'Steel', unit: 'Kg', currency: 'USD', amount: 2 },
  { date: '', customer: 'Acme', employee: 'E1', item: 'Bolt', unit: 'Nos', currency: 'INR', amount: 100 }
];
const filters = [
  { key: 'customer', match: (row, value) => row.customer === value },
  { key: 'employee', match: (row, value) => row.employee === value }
];
const result = applyReportFilters({ rows, dateField: 'date', from: '2026-02-08', to: '2026-02-09', filters, selections: { customer: 'Acme', employee: 'E1' }, columns: [{ key: 'item' }] });
assert.equal(result.filteredRows.length, 1, 'combined date, customer, and employee criteria intersect');
assert.equal(result.filteredRows[0].amount, 10);
assert.equal(result.excludedUndated.length, 1, 'undated records are separated when a range is active');
const searchedWithAdvancedFilters = applyReportFilters({ rows, dateField: 'date', from: '2026-02-08', to: '2026-02-09', filters, selections: { customer: 'Acme' }, search: 'steel', columns: [{ key: 'item' }] });
assert.equal(searchedWithAdvancedFilters.filteredRows.length, 1, 'live search intersects with applied date and customer filters');
assert.equal(searchedWithAdvancedFilters.filteredRows[0].amount, 10);
assert.equal(applyReportFilters({ rows, dateFilters: false, filters, selections: { customer: 'Acme' } }).filteredRows.length, 3, 'snapshot mode does not apply a transaction date');
assert.equal(applyReportFilters({ rows, filters, selections: {}, from: '', to: '' }).filteredRows.length, rows.length, 'reset criteria restore the unfiltered source rows');

const qcRows = [
  { checked_at: '2026-02-08 10:30:00', customer: 'Acme', inspector_employee_name: 'QC One', result: 'OK' },
  { checked_at: '2026-02-09', customer: 'Beta', inspector_employee_name: 'QC Two', result: 'NOT OK' },
  { checked_at: '', customer: 'Acme', inspector_employee_name: 'QC One', result: 'OK' }
];
const qcFilters = [
  { key: 'customer', match: (row, value) => row.customer === value },
  { key: 'employee', match: (row, value) => row.inspector_employee_name === value },
  { key: 'status', match: (row, value) => row.result === value }
];
const qcFiltered = applyReportFilters({ rows: qcRows, dateField: 'checked_at', from: '2026-02-08', to: '2026-02-08', filters: qcFilters, selections: { customer: 'Acme', employee: 'QC One', status: 'OK' }, columns: [{ key: 'customer' }] });
assert.equal(qcFiltered.filteredRows.length, 1, 'Quality Report filters use checked_at with exact customer, inspector, and result');
assert.equal(qcFiltered.excludedUndated.length, 1, 'Quality records without checked_at are exceptions');

const rowsByUnit = rows.slice(0, 3).filter((row) => row.unit === 'Kg');
assert.deepEqual([...new Set(rowsByUnit.map((row) => row.unit))], ['Kg']);
assert.equal(formatQuantityByUnit(rows.slice(0, 3), 'amount'), '12 Kg | 5 Nos');
const workbook = buildReportWorkbook({ title: 'Filtered', columns: [{ key: 'item', label: 'Item' }], rows: result.filteredRows, filters: ['Customer: Acme', 'Employee: E1'], period: '2026-02-08 to 2026-02-09' });
const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
const sheetRows = XLSX.utils.sheet_to_json(reopened.Sheets.Filtered, { header: 1, defval: '' });
assert.ok(sheetRows.some((row) => row.includes('Steel')));
assert.ok(!sheetRows.some((row) => row.includes('Bolt')));
assert.ok(sheetRows.some((row) => row.some((cell) => String(cell).includes('Customer: Acme'))));

let printed = 0;
let pageSize = 50;
scheduleReportPrint({ windowObject: { setTimeout: (fn) => fn(), print: () => { assert.equal(pageSize, 'all'); printed += 1; } }, currentPageSize: pageSize, setPageSize: (value) => { pageSize = value; } });
assert.equal(printed, 1);
assert.equal(pageSize, 50);
console.log('Report filter tests passed: date parsing/range validation, combined customer/employee filters, undated exceptions, XLSX filtered data, and print-all behavior.');
