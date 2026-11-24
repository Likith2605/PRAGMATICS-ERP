import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const inventory = await readFile(new URL('../src/pages/InventoryPage.jsx', import.meta.url), 'utf8');
const store = await readFile(new URL('../src/pages/StorePage.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles/erp-theme.css', import.meta.url), 'utf8');

for (const label of ['Item Master & Stock Levels', 'Stock Movement History', 'Receive Purchase Orders', 'Issued to Employees']) {
  assert.ok(inventory.includes(label), `Inventory exposes the ${label} section`);
}
assert.match(inventory, /<StorePage embeddedTab="receive"\s*\/>/, 'Inventory reuses the Store purchase receipt section');
assert.match(inventory, /<StorePage embeddedTab="issues"\s*\/>/, 'Inventory reuses the Store employee issue section');
assert.match(inventory, /className="button-primary" onClick=\{\(\) => selectInventoryTab\('receive'\)\}>\s*Receive Purchase Orders/, 'Inventory header quick action opens the existing receipt tab');
assert.match(store, /localStorage\.getItem\('supplierPOHistory'\)/, 'purchase orders use the existing shared PO history');
assert.match(store, /localStorage\.getItem\('employeeIssueLog'\)/, 'employee issues use the existing issue history');
assert.match(store, /qty > current/, 'employee issue validation still prevents issuing more than stock');
assert.match(store, /type: 'OUT'[\s\S]*?reason: `Issued to Employee:/, 'employee issues continue recording stock-out transactions');
assert.match(store, /hasPermission\('inventory\.adjust'\).*Issue to Employee/, 'issuing actions remain permission gated');
assert.match(styles, /\.inventory-section-tabs\s*\{[^}]*flex-wrap:\s*wrap/s, 'Inventory section tabs reflow on narrow screens');

console.log('Inventory section composition and shared Store workflows passed.');
