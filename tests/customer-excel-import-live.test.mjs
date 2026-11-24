import 'dotenv/config';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { CUSTOMER_EXCEL_COLUMNS, mapCustomerExcelRow, validateCustomerExcelRow } from '../src/utils/customerExcelImport.js';

const base = process.env.ERP_TEST_API_URL || 'http://127.0.0.1:3001/api';
assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'Admin credentials must be configured');

const loginResponse = await fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
});
assert.equal(loginResponse.status, 200, 'admin login succeeds against the running API');
const { token } = await loginResponse.json();
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const phoneSamples = ['9876543210', '123', '+91 98765 43210', '(080) 2345-6789', '00012-345 ext 9', ''];
const importedRows = Array.from({ length: 21 }, (_, index) => ({
  'Sl No': index === 0 ? '' : `00${index}`,
  'Customer Name': index === 0 ? '' : `QA Import Freeform ${index}`,
  Address: index % 4 === 0 ? '' : `Unit ${index}, QA Road ${index + 1}`,
  'GST No': index % 3 === 0 ? 'bad GST / repeated' : `GST-${index % 2}`,
  'Tel No.': phoneSamples[index % phoneSamples.length],
  'Contact Person': index % 5 === 0 ? '' : `Contact ${index}`,
  'Contact Person No': phoneSamples[(index + 2) % phoneSamples.length],
  'E-Mail': index % 3 === 0 ? 'not-an-email' : 'same invalid email',
  'Vendor Code': `DUPLICATE-${index % 4}`
}));
const sheet = XLSX.utils.json_to_sheet(importedRows, { header: CUSTOMER_EXCEL_COLUMNS });
XLSX.utils.sheet_add_aoa(sheet, [Array(CUSTOMER_EXCEL_COLUMNS.length).fill('')], { origin: -1 });
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, 'Customers');
const fileBytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
const parsedBook = XLSX.read(fileBytes, { type: 'buffer', raw: false, cellDates: true, formula: false });
const parsed = XLSX.utils.sheet_to_json(parsedBook.Sheets.Customers, { defval: '', raw: false, blankrows: false });
const previewRows = parsed.map(mapCustomerExcelRow).filter((row) => Object.values(row).some((value) => value !== null && value !== undefined && value !== ''));
assert.equal(previewRows.length, 21, 'preview contains all 21 supplied rows and ignores only the blank row');
assert.equal(previewRows.filter((row) => validateCustomerExcelRow(row).length === 0).length, 21, 'every row is field-validation free, including blank customer fields');

const currentResult = await request('/state/customerDirectory');
assert.equal(currentResult.status, 200, 'customer directory is readable from PostgreSQL API');
const existing = Array.isArray(currentResult.data.data) ? currentResult.data.data : [];
const testIds = new Set(importedRows.map((_, index) => `qa-import-freeform-2026-${index + 1}`));
const testRecords = previewRows.map((row, index) => ({
  id: `qa-import-freeform-2026-${index + 1}`,
  createdAt: '2026-11-23T00:00:00.000Z',
  slNo: row['Sl No'], companyName: row['Customer Name'], address: row.Address, billingAddress: row.Address,
  gstin: row['GST No'], gstNumber: row['GST No'], phone: row['Tel No.'],
  customerName: row['Contact Person'], contactPerson: row['Contact Person'],
  contactPersonPhone: row['Contact Person No'], contactNo: row['Contact Person No'],
  email: row['E-Mail'], customerCode: row['Vendor Code'], vendorCode: row['Vendor Code']
}));
const nextDirectory = [...testRecords, ...existing.filter((record) => !testIds.has(record?.id))];
const saveResult = await request('/state/customerDirectory', { method: 'PUT', body: JSON.stringify({ data: nextDirectory }) });
assert.equal(saveResult.status, 200, `Save Customers API accepts raw fields: ${saveResult.data.error || ''}`);
const persistedResult = await request('/state/customerDirectory');
assert.equal(persistedResult.status, 200);
const persisted = persistedResult.data.data || [];
const inserted = persisted.filter((record) => testIds.has(record.id));
assert.equal(inserted.length, 21, 'all 21 records are persisted once');
assert.equal(persisted.length, existing.filter((record) => !testIds.has(record?.id)).length + 21, 'existing customer records remain intact');
assert.equal(inserted[0].companyName, '', 'blank Customer Name remains accepted');
assert.equal(inserted[0].gstin, 'bad GST / repeated');
assert.equal(inserted[0].email, 'not-an-email');
assert.equal(inserted[0].phone, '9876543210');
assert.equal(inserted[1].phone, '123');
assert.equal(inserted[2].phone, '+91 98765 43210');
assert.equal(inserted[0].vendorCode, inserted[4].vendorCode, 'repeated Vendor Codes are retained');
assert.ok(inserted.some((record) => record.gstin === inserted.find((entry) => entry.gstin.startsWith('GST-'))?.gstin), 'repeated GST values are retained');

console.log(`Live customer Excel import/API check passed: previewed 21 rows; saved and read back ${inserted.length} records; retained ${existing.length} pre-existing records.`);
