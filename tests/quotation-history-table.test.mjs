import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pages/QuotationPage.jsx', import.meta.url), 'utf8');
const historyStart = source.indexOf('<h2>Quotation History</h2>');
const historyEnd = source.indexOf('</table>', historyStart);
assert.notEqual(historyStart, -1, 'Quotation History section exists');
assert.notEqual(historyEnd, -1, 'Quotation History table exists');
const table = source.slice(historyStart, historyEnd);
for (const label of ['Date', 'Reference No', 'Project ID', 'Company Name', 'Total Amount', 'Action']) {
  assert.ok(table.includes(`<th>${label}</th>`), `${label} header is present`);
}
assert.ok(!table.includes('Balance Status'), 'Balance Status header is removed');
assert.ok(!table.includes('transaction.balanceStatus'), 'Balance Status row value is removed');
assert.ok(table.includes('colSpan="6"'), 'empty-state row spans all six remaining columns');
assert.ok(table.includes('quotation-history-table'), 'quotation history uses its six-column layout class');
assert.ok(source.includes('currentHistory[index].balanceStatus'), 'quotation balance calculations remain untouched');
console.log('Quotation History table checks passed: six requested columns, no Balance Status display, and balance calculation preserved.');
