import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const service = await readFile(new URL('../src/services/tallyExportService.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/pages/TallyExportPage.jsx', import.meta.url), 'utf8');

assert.doesNotMatch(service, /localStorage|getItem\(['"](?:customerInvoiceHistory|supplierInvoiceHistory|debitNotes)['"]/);
assert.match(service, /customerInvoices/);
assert.match(service, /supplierInvoices/);
assert.match(service, /debitNotes/);
assert.match(page, /listCustomerInvoices/);
assert.match(page, /listSupplierInvoicesFromPostgres/);
assert.match(page, /listDebitNotes/);
assert.match(page, /vendorMaster/);
console.log('PASS Tally export source transactions are supplied by PostgreSQL APIs');
