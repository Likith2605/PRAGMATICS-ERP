import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../src/pages/VendorQuotationPreviewPage.jsx', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const listPage = await readFile(new URL('../src/pages/VendorQuotationPage.jsx', import.meta.url), 'utf8');
const api = await readFile(new URL('../src/services/procurementIntakeApi.js', import.meta.url), 'utf8');
const document = await readFile(new URL('../src/components/VendorQuotationPreview.jsx', import.meta.url), 'utf8');

assert.match(page, /getProcurementRecord/);
assert.doesNotMatch(page, /localStorage|getItem\('currentVendorQuotation'\)/);
assert.match(page, /\.then\(\(record\)\s*=>/);
assert.doesNotMatch(page, /useLocation|location\.state/);
assert.match(api, /getProcurementRecord\s*=\s*async\s*\(kind,\s*id\)\s*=>\s*\(await request\([^;]+\.record/);
assert.match(routes, /vendor-quotations\/preview\/:quotationNumber/);
assert.match(listPage, /vendor-quotations\/preview\/\$\{encodeURIComponent\(vq\.quotationNumber\)\}/);
assert.match(listPage, /handleViewPreview/);
assert.match(document, /totalWithTax/);
assert.match(document, /otherTerms/);
console.log('PASS Vendor Quotation Preview uses persistent PostgreSQL ID');
