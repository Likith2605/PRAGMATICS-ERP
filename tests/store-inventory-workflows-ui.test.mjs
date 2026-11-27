import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../src/pages/StoreInventoryWorkflowsPage.jsx', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
const inventoryApi = await readFile(new URL('../src/services/inventoryApi.js', import.meta.url), 'utf8');

assert.match(page, /createStockTransfer/);
assert.match(page, /resolveStockTransfer/);
assert.match(page, /createStockVerification/);
assert.match(page, /resolveStockVerification/);
assert.match(page, /Approve &amp; Post/);
assert.match(page, /Approve &amp; Adjust Ledger/);
assert.doesNotMatch(page, /localStorage/);
assert.match(inventoryApi, /location-batch-balances/);
assert.match(routes, /\/store\/inventory-workflows/);
assert.match(sidebar, /Stock Transfers & Verification/);
console.log('PASS Store transfer and verification screens use PostgreSQL workflows');
