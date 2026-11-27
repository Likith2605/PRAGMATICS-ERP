import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const productionPage = await read('src/pages/ProductionPage.jsx');
const materialRequestsPage = await read('src/pages/ProductionMaterialRequestsPage.jsx');
const projectTracker = await read('src/utils/projectTracker.js');
const storeService = await read('src/utils/storeService.js');
const bomPage = await read('src/pages/BOMPage.jsx');
const erpStateSync = await read('src/services/erpStateSync.js');
const erpStateRoutes = await read('server/erpStateRoutes.js');

assert.match(productionPage, /listJobCards/);
assert.match(productionPage, /listSalesOrders/);
assert.match(productionPage, /getCustomerPurchaseOrders/);
assert.match(materialRequestsPage, /getServerMaterialRequests/);
assert.match(materialRequestsPage, /listJobCards/);
assert.match(materialRequestsPage, /listBoms/);
assert.match(materialRequestsPage, /listInventoryItems/);
assert.doesNotMatch(materialRequestsPage, /getJobCards\(\)|getBOMs\(\)|getInventoryItems\(\)|getMaterialRequests\(\)/);

assert.doesNotMatch(projectTracker, /getStoredList\('productionJobCards'\)/);
assert.doesNotMatch(storeService, /readLS\(LS\.productionJobCards|readLS\(BOM_LS_KEY/);
assert.doesNotMatch(storeService, /writeLS\(LS\.productionJobCards|syncJobCardHT|saveJobCards/);
assert.doesNotMatch(storeService, /saveJobCards\s*=/);
assert.match(projectTracker, /getCachedJobCards/);
assert.match(storeService, /getCachedJobCards|getCachedBoms/);
assert.match(bomPage, /listBoms/);

assert.match(erpStateSync, /['"]boms['"]/);
assert.match(erpStateSync, /['"]bomMasterList['"]/);
assert.match(erpStateSync, /['"]productionRequirements['"]/);
assert.match(erpStateRoutes, /['"]boms['"]/);
assert.match(erpStateRoutes, /['"]bomMasterList['"]/);

console.log('Production authority consumer checks passed: 17 assertions.');
