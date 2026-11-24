import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pages/CustomerInvoicePage.jsx', import.meta.url), 'utf8');
const sectionStart = source.indexOf('<h2>Invoice History</h2>');
const tableStart = source.indexOf('<table className="history-table customer-invoice-history-table">', sectionStart);
const tableEnd = source.indexOf('</table>', tableStart);
assert.notEqual(sectionStart, -1, 'Invoice History section exists');
assert.notEqual(tableStart, -1, 'Invoice History table exists');
assert.notEqual(tableEnd, -1, 'Invoice History table closes');
const table = source.slice(tableStart, tableEnd);
for (const label of ['Date', 'Invoice No', 'Quotation Ref', 'Customer / Company', 'Job Card (QC)', 'Total Value', 'Action']) {
  const header = label === 'Total Value'
    ? '<th className="customer-invoice-total-cell">Total Value</th>'
    : `<th>${label}</th>`;
  assert.ok(table.includes(header), `${label} header is present`);
}
assert.ok(!table.includes('<th>Received</th>'), 'Received header is removed');
assert.ok(!table.includes('<th>Balance Due</th>'), 'Balance Due header is removed');
assert.ok(!table.includes('inv.amountReceived'), 'received amount is not displayed in Invoice History');
assert.ok(!table.includes('inv.balanceDue'), 'balance due is not displayed in Invoice History');
assert.ok(table.includes('colSpan="7"'), 'empty-state row spans the seven remaining columns');
assert.ok(source.includes('const invReceivedINR'), 'received amount calculations remain available for reports');
assert.ok(source.includes('const invBalanceCell'), 'balance calculations remain available for reports');
console.log('Customer Invoice History checks passed: seven requested columns, payment values hidden only from this table, and calculations preserved.');
