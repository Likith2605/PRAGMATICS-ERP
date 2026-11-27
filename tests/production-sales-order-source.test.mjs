import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../src/pages/ProductionItemRequirementsPage.jsx', import.meta.url), 'utf8');

assert.match(page, /from '\.\.\/services\/salesOrderApi\.js'/);
assert.match(page, /\blistSalesOrders\b/);
assert.match(page, /\bgetSalesOrder\b/);
assert.doesNotMatch(page, /getSalesOrders|getSalesOrderByRef/);
assert.match(page, /Sales Order could not be loaded from PostgreSQL/);
console.log('PASS Production Item Requirements uses PostgreSQL Sales Order APIs');
