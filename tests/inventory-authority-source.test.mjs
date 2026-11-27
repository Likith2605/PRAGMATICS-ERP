import assert from 'node:assert/strict';
import fs from 'node:fs';

const selector = fs.readFileSync('src/components/MaterialNameSelector.jsx', 'utf8');
const production = fs.readFileSync('src/pages/ProductionItemRequirementsPage.jsx', 'utf8');
const productionRequests = fs.readFileSync('src/pages/ProductionMaterialRequestsPage.jsx', 'utf8');
const inventoryPage = fs.readFileSync('src/pages/InventoryPage.jsx', 'utf8');
const inventoryApi = fs.readFileSync('src/services/inventoryApi.js', 'utf8');

assert(!selector.includes('getInventoryItems'), 'Material selector must not read the localStorage-backed store helper');
assert(selector.includes("from '../services/inventoryApi.js'"), 'Material selector must use the Inventory API');
assert(!/Inventory Item Master\s*\(\{matches\.length\}/.test(selector), 'The separate Inventory Item Master label must be removed');
assert(production.includes('items={inventoryRecords}') || production.includes('inventoryRecords'), 'Production Item Requirements must provide PostgreSQL inventory records');
assert(productionRequests.includes('items={inventory}'), 'Production Material Requests must use the shared PostgreSQL inventory records');
assert(inventoryPage.includes('listInventoryItems'), 'Inventory Management must use the PostgreSQL inventory API');
assert(inventoryApi.includes('export const listInventoryItems'), 'Inventory API must expose the authoritative item list');
assert(inventoryApi.includes('/inventory/items'), 'Inventory API must target the inventory_items route');

console.log('Inventory authority source: 7 checks passed.');
