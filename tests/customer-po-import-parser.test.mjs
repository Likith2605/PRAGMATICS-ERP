import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  CUSTOMER_PO_EXCEL_COLUMNS,
  customerPOHeaderOrderIsValid,
  normalizeCustomerPOHeader,
  missingCustomerPOColumns,
  parseCustomerPOExcelRows,
  readCustomerPOWorkbook,
  validateCustomerPOExcelRecord
} from '../src/utils/customerPOExcelImport.js';

const row = (values = {}) => Object.fromEntries(CUSTOMER_PO_EXCEL_COLUMNS.map((column) => [column, values[column] ?? '']));
const makePO = (poNumber, poDate, customerName, description, quantity = 2, delivered = 1, price = 15) => row({
  'Sl No': '01', 'PO No': poNumber, 'PO Date': poDate, 'Customer Name': customerName,
  'Description of Goods': description, Quantity: quantity, 'Delivered Quantity': delivered,
  'Balance Quantity': quantity - delivered, Price: price, Amount: quantity * price,
  'PO Balance Quantity Price': 12
});

assert.deepEqual(CUSTOMER_PO_EXCEL_COLUMNS, ['Sl No', 'PO No', 'PO Date', 'Customer Name', 'Description of Goods', 'Quantity', 'Delivered Quantity', 'Balance Quantity', 'Price', 'Amount', 'PO Balance Quantity Price']);
assert.deepEqual(missingCustomerPOColumns(CUSTOMER_PO_EXCEL_COLUMNS), []);
assert.deepEqual(missingCustomerPOColumns(CUSTOMER_PO_EXCEL_COLUMNS.slice(1)), ['Sl No']);
assert.equal(customerPOHeaderOrderIsValid(CUSTOMER_PO_EXCEL_COLUMNS), true);
assert.equal(customerPOHeaderOrderIsValid([...CUSTOMER_PO_EXCEL_COLUMNS].reverse()), false);
assert.equal(normalizeCustomerPOHeader('  Delivered\n  Quantity  '), 'delivered quantity');
assert.equal(normalizeCustomerPOHeader('PO DATE'), 'po date');

const sampleRows = [
  makePO('PO-100', '2024-04-01', 'Alpha Ltd', 'First part'),
  row({ 'Description of Goods': 'Second part', Quantity: 3, 'Delivered Quantity': 1, 'Balance Quantity': 2, Price: 20, Amount: 60, 'PO Balance Quantity Price': 40 }),
  makePO('PO-101', '2024-05-02', 'Beta Ltd', 'Third part', 1, 0, 50)
];
const groups = parseCustomerPOExcelRows(sampleRows, validateCustomerPOExcelRecord);
assert.equal(groups.length, 2, 'a workbook with two header rows yields two PO records');
assert.equal(groups[0].items.length, 2, 'a blank-header continuation row stays attached to its PO');
assert.equal(groups[0].items[1].description, 'Second part');
assert.equal(groups[0].row.poNumber, 'PO-100');
assert.equal(groups[0].row.poDate, '2024-04-01');
assert.equal(groups[1].row.customerName, 'Beta Ltd');
assert.equal(groups.every((group) => group.errors.length === 0), true);

const blankContinuation = parseCustomerPOExcelRows([makePO('PO-102', '2024-04-03', 'Gamma Ltd', 'Only item'), row()], validateCustomerPOExcelRecord);
assert.equal(blankContinuation.length, 1, 'fully blank rows are ignored');
assert.equal(blankContinuation[0].items.length, 1);

const invalid = parseCustomerPOExcelRows([
  makePO('PO-BAD', '2024-02-30', 'Bad Date', 'Bad date item'),
  makePO('PO-BAD-QTY', '2024-01-01', 'Bad Quantity', 'Zero quantity', 0, 0, 4),
  makePO('PO-BAD-PRICE', '2024-01-01', 'Bad Price', 'Negative price', 1, 0, -2),
  row({ 'PO No': 'PO-MISSING-CUSTOMER', 'PO Date': '2024-01-01', 'Description of Goods': 'Missing customer', Quantity: 1, 'Delivered Quantity': 0, 'Balance Quantity': 1, Price: 1, Amount: 1 })
], validateCustomerPOExcelRecord);
assert(invalid[0].errors.some((error) => error.includes('valid date')));
assert(invalid[1].errors.some((error) => error.includes('Quantity')));
assert(invalid[2].errors.some((error) => error.includes('Price')));
assert(invalid[3].errors.some((error) => error.includes('Customer Name')));

const duplicate = parseCustomerPOExcelRows([
  makePO('PO-DUP', '2024-01-01', 'Same Ltd', 'One'),
  makePO('PO-DUP', '2024-01-01', 'Same Ltd', 'Two')
], validateCustomerPOExcelRecord);
assert(duplicate.every((group) => group.errors.some((error) => error.includes('Duplicate'))));

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([CUSTOMER_PO_EXCEL_COLUMNS, ...sampleRows.map((record) => CUSTOMER_PO_EXCEL_COLUMNS.map((column) => record[column]))]), 'Import');
for (const [format, input, readOptions] of [
  ['xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' }],
  ['xls', XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }), { type: 'buffer' }],
  ['csv', XLSX.utils.sheet_to_csv(workbook.Sheets.Import), { type: 'string' }]
]) {
  const read = XLSX.read(input, { ...readOptions, cellDates: true });
  const sheet = read.Sheets[read.SheetNames[0]];
  const parsed = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true, blankrows: true });
  assert.equal(parsed.length, 3, `${format} parsing retains the three source data rows`);
  assert.equal(parseCustomerPOExcelRows(parsed, validateCustomerPOExcelRecord).length, 2, `${format} parsing groups the same two POs`);
  const extracted = readCustomerPOWorkbook(read);
  assert.equal(extracted.rows.length, 3, `${format} header detection extracts the expected data rows`);
}

const legacyHeaders = ['SL NO', ' PO No ', 'PO Date', 'Customer Name', 'Description of Goods', 'Quantity', 'Delivered\nQuantity', 'Balance Quantity', 'Price', 'Amount', 'PO Balance Quantity\nPrice'];
const formattedWorkbook = XLSX.utils.book_new();
const cover = XLSX.utils.aoa_to_sheet([['Purchase Order Archive'], ['Financial Year 2020-2021']]);
XLSX.utils.book_append_sheet(formattedWorkbook, cover, 'Cover');
const legacySheet = XLSX.utils.aoa_to_sheet([
  ['Company Historical Customer Purchase Orders'], [], legacyHeaders,
  ...sampleRows.map((record) => CUSTOMER_PO_EXCEL_COLUMNS.map((column) => record[column]))
]);
legacySheet['!merges'] = [XLSX.utils.decode_range('A1:K1')];
XLSX.utils.book_append_sheet(formattedWorkbook, legacySheet, 'Customer POs');
const extractedLegacy = readCustomerPOWorkbook(formattedWorkbook);
assert.equal(extractedLegacy.sheetName, 'Customer POs', 'worksheet scan skips the cover worksheet');
assert.equal(extractedLegacy.headerRowNumber, 3, 'header detection skips title and blank rows');
assert.equal(extractedLegacy.rows.length, 3);
assert.equal(extractedLegacy.populatedRows, 3);
assert.equal(parseCustomerPOExcelRows(extractedLegacy.rows, validateCustomerPOExcelRecord, extractedLegacy.headerRowNumber - 1)[0].rowNumber, 4, 'source row numbers account for the detected header offset');

const missingWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(missingWorkbook, XLSX.utils.aoa_to_sheet([['Not a Customer PO sheet'], ['PO No', 'Customer Name']]), 'Sheet1');
assert.throws(() => readCustomerPOWorkbook(missingWorkbook), /Could not find all 11 required Customer PO headings.*Missing:/);

console.log('PASS: Customer PO header detection, worksheet selection, grouping, validation, and xlsx/xls/csv fixtures.');
