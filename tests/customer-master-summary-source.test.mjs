import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../src/pages/CustomersPage.jsx', import.meta.url), 'utf8');

for (const api of ['listQuotations', 'listSalesOrders', 'listDeliveryChallans', 'listCustomerInvoices', 'listExportInvoicesApi', "listAdvances('customer')"]) {
  assert.ok(page.includes(api), `Customer summary must use ${api}`);
}
assert.doesNotMatch(page, /readLocalStorageList|customerInvoiceHistory|salesOrderHistory|quotationHistory/);
assert.match(page, /invReceivedINR/);
assert.match(page, /invReceivableINR/);
assert.match(page, /role="alert"/);
console.log('PASS Customer summaries use PostgreSQL transaction APIs');
