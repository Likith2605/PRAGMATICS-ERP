import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const inventoryPage = await read('src/pages/InventoryPage.jsx');
const debitPage = await read('src/pages/DebitNotesPage.jsx');
const tallyPage = await read('src/pages/TallyExportPage.jsx');
const storeApi = await read('src/services/storeApi.js');
const storeIssuesPage = await read('src/pages/StoreIssuesPage.jsx');
const materialReturnsPage = await read('src/pages/MaterialReturnsPage.jsx');
const shelfLifePage = await read('src/pages/ShelfLifePage.jsx');
const debitApi = await read('src/services/debitNoteApi.js');
const inventoryApi = await read('src/services/inventoryApi.js');
const stockLedger = await read('server/stockLedger.js');
const erpStateRoutes = await read('server/erpStateRoutes.js');
const erpStateSync = await read('src/services/erpStateSync.js');

assert.doesNotMatch(inventoryPage, /localStorage\.getItem\(['\"]inventoryItems|localStorage\.setItem\(['\"]inventoryItems|localStorage\.getItem\(['\"]stockTransactions|localStorage\.setItem\(['\"]stockTransactions/);
assert.match(inventoryPage, /listInventoryItems/);
assert.match(inventoryPage, /listAllStockLedger/);
assert.match(inventoryPage, /postInventoryAdjustment/);

assert.match(debitPage, /listDebitNotes|createDebitNote|updateDebitNote/);
assert.match(debitApi, /\/debit-notes/);
assert.match(tallyPage, /listDebitNotes/);

assert.match(storeApi, /\/store\/issue|\/store\/requests|\/store\/returns/);
assert.match(storeIssuesPage, /listInventoryItems/);
assert.match(storeIssuesPage, /listInventoryLots/);
assert.doesNotMatch(storeIssuesPage, /getInventoryBatches|getMaterialShortages|decorateMR/);
assert.match(materialReturnsPage, /returnMaterial as returnMaterialApi/);
assert.doesNotMatch(materialReturnsPage, /utils\/storeService\.js/);
assert.match(shelfLifePage, /listInventoryLots/);
assert.match(shelfLifePage, /postInventoryAdjustment/);
assert.doesNotMatch(shelfLifePage, /getExpiryWatchList|writeOffExpiredBatch|getInventoryItems/);
assert.match(inventoryApi, /\/inventory\/lots/);
assert.match(stockLedger, /INSERT INTO inventory_batches/);
assert.match(stockLedger, /Expiry write-off requires a registered batch/);
assert.match(erpStateRoutes, /['"]debitNotes['"]/);
assert.match(erpStateRoutes, /['"]debitNoteSequence['"]/);
assert.match(erpStateSync, /['"]debitNotes['"]/);
assert.match(erpStateSync, /['"]debitNoteSequence['"]/);

console.log('Store and Debit Note authority consumer checks passed: 23 assertions.');
