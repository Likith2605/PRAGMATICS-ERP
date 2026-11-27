import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../src/pages/BackupExportPage.jsx', import.meta.url), 'utf8');

for (const api of [
  'listInventoryItems',
  'listQuotations',
  'listSalesOrders',
  'listCustomerInvoices',
  'listEnquiries',
  'getCustomerPurchaseOrders',
  'listDeliveryChallans',
  'listPurchaseOrders',
  'listSupplierInvoicesFromPostgres',
  'listJobCards'
]) {
  assert.ok(page.includes(api), `Backup exports and record counts must use ${api}`);
}

assert.match(page, /const items = await loader\(\)/);
assert.match(page, /PostgreSQL export data counts could not be loaded/);
assert.match(page, /\{exportDataError && <p role="alert"/);
assert.doesNotMatch(page, /localStorage\.getItem/);

console.log('PASS ERP spreadsheet exports and record counts use PostgreSQL APIs');
