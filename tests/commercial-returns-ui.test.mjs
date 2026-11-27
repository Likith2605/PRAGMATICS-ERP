import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const returnsPage = await readFile(new URL('../src/pages/MaterialReturnsPage.jsx', import.meta.url), 'utf8');
const vendorPage = await readFile(new URL('../src/pages/VendorMasterPage.jsx', import.meta.url), 'utf8');

assert.doesNotMatch(returnsPage, /localStorage|salesReturnHistory|purchaseReturnHistory|customerInvoiceHistory|supplierInvoiceHistory/);
assert.match(returnsPage, /listSalesReturns/);
assert.match(returnsPage, /listPurchaseReturns/);
assert.match(returnsPage, /listCustomerInvoices/);
assert.match(returnsPage, /listSupplierInvoicesFromPostgres/);
assert.match(returnsPage, /createSalesReturn/);
assert.match(returnsPage, /createPurchaseReturn/);
assert.match(returnsPage, /could not be loaded from PostgreSQL/);
assert.doesNotMatch(vendorPage, /purchaseReturnHistory/);
assert.match(vendorPage, /listPurchaseReturns/);
console.log('PASS sales and purchase return screens use authenticated PostgreSQL APIs');
