import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { CUSTOMER_EXCEL_COLUMNS, mapCustomerExcelRow, validateCustomerExcelRow } from '../src/utils/customerExcelImport.js';

const phoneValues = ['9876543210', '12345678901', '+91 98765 43210', '(080) 2345-6789', '080-2345 6789 ext. 42', '00123-456 789', ''];
const records = Array.from({ length: 21 }, (_, index) => ({
  'Sl No': index === 0 ? '' : `000${index}`,
  'Customer Name': index === 0 ? '' : `Customer ${index + 1}`,
  Address: index === 0 ? '' : `Address ${index + 1} / Suite ${index}`,
  'GST No': index % 2 ? 'not-a-gstin' : 'REPEATED-GST',
  'Tel No.': phoneValues[index % phoneValues.length],
  'Contact Person': index === 0 ? '' : `Person ${index + 1}`,
  'Contact Person No': phoneValues[(index + 2) % phoneValues.length],
  'E-Mail': index % 2 ? 'not-an-email' : 'repeated@example',
  'Vendor Code': `REPEATED-${index % 3}`
}));
records.splice(10, 0, Object.fromEntries(CUSTOMER_EXCEL_COLUMNS.map((column) => [column, ''])));

// Exercise the same SheetJS workbook parsing options as ExcelImportDialog.
const source = XLSX.utils.json_to_sheet(records, { header: CUSTOMER_EXCEL_COLUMNS });
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, source, 'Customers');
const parsedBook = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', raw: false, cellDates: true });
const parsedRows = XLSX.utils.sheet_to_json(parsedBook.Sheets.Customers, { defval: '', raw: false, blankrows: false });

const mappedRows = parsedRows.map((row) => mapCustomerExcelRow(row));
const previewRows = mappedRows.filter((row) => Object.values(row).some((value) => value !== null && value !== undefined && value !== ''));
assert.equal(previewRows.length, 21, 'all 21 supplied rows reach preview and the completely empty row is ignored');
const expectedRows = records.filter((row) => Object.values(row).some((value) => value !== ''));
for (let index = 0; index < previewRows.length; index += 1) {
  const mapped = previewRows[index];
  assert.deepEqual(validateCustomerExcelRow(mapped), [], 'no customer field triggers validation');
  assert.equal(mapped['Tel No.'], expectedRows[index]['Tel No.'], 'customer phone text is preserved');
  assert.equal(mapped['Contact Person No'], expectedRows[index]['Contact Person No'], 'contact person phone text is preserved');
  assert.equal(mapped['GST No'], expectedRows[index]['GST No'], 'GST value is preserved exactly');
  assert.equal(mapped['E-Mail'], expectedRows[index]['E-Mail'], 'email value is preserved exactly');
}
assert.deepEqual(validateCustomerExcelRow({ 'Customer Name': '', 'Tel No.': '+91 98765 43210' }), []);

console.log('Customer Excel import checks passed: 21 mixed-value rows accepted, blank rows ignored, and all cell values preserved without field validation.');
