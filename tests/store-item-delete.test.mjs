import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear()
};
localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn: true, role: 'Administrator', roleKey: 'admin', token: 'test-admin' }));

const { deleteInventoryItemIfUnused } = await import('../src/utils/storeService.js');
const item = { id: 'item-1', itemCode: 'MAT-1', itemName: 'Steel Bar', currentQty: 0 };
const setList = (key, records) => localStorage.setItem(key, JSON.stringify(records));

const reset = () => {
  localStorage.clear();
  localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn: true, role: 'Administrator', roleKey: 'admin', token: 'test-admin' }));
  setList('inventoryItems', [item]);
};

reset();
setList('stockTransactions', [{ id: 'unrelated-tx', itemCode: 'MAT-OTHER' }]);
assert.equal(deleteInventoryItemIfUnused(item.id).id, item.id);
assert.deepEqual(JSON.parse(localStorage.getItem('inventoryItems')), []);
assert.deepEqual(JSON.parse(localStorage.getItem('stockTransactions')), [{ id: 'unrelated-tx', itemCode: 'MAT-OTHER' }]);

const references = [
  ['stockTransactions', [{ itemCode: item.itemCode }]],
  ['inventoryTransactions', [{ itemCode: item.itemCode }]],
  ['supplierPOHistory', [{ payload: { items: [{ itemCode: item.itemCode }] } }]],
  ['purchaseOrders', [{ items: [{ materialCode: item.itemCode }] }]],
  ['storePurchaseRequests', [{ items: [{ materialId: item.itemCode }] }]],
  ['materialReceipts', [{ items: [{ materialCode: item.itemCode }] }]],
  ['materialArrivals', [{ items: [{ materialCode: item.itemCode }] }]],
  ['storeGRNs', [{ items: [{ itemCode: item.itemCode }] }]],
  ['storeIssueHistory', [{ items: [{ materialId: item.itemCode }] }]],
  ['materialReturnHistory', [{ items: [{ materialId: item.itemCode }] }]],
  ['employeeIssueLog', [{ itemCode: item.itemCode }]],
  ['materialRequests', [{ items: [{ materialId: item.itemCode }] }]],
  ['productionRequirements', [{ items: [{ itemId: item.id }] }]],
  ['productionJobCards', [{ materials: [{ itemCode: item.itemCode }] }]],
  ['productionDispatchRequests', [{ items: [{ itemCode: item.itemCode }] }]],
  ['qualityChecks', [{ lines: [{ materialCode: item.itemCode }] }]],
  ['inventoryBatches', [{ itemCode: item.itemCode }]],
  ['stockTransfers', [{ itemCode: item.itemCode }]],
  ['stockVerifications', [{ itemId: item.id }]],
  ['rejectionReports', [{ items: [{ materialCode: item.itemCode }] }]],
  ['debitNotes', [{ items: [{ materialCode: item.itemCode }] }]]
];

for (const [key, records] of references) {
  reset();
  setList(key, records);
  const savedRecords = localStorage.getItem(key);
  assert.throws(
    () => deleteInventoryItemIfUnused(item.id),
    /used in existing transactions/,
    `${key} reference should block item deletion`
  );
  assert.deepEqual(JSON.parse(localStorage.getItem('inventoryItems')), [item]);
  assert.equal(localStorage.getItem(key), savedRecords);
}

reset();
setList('inventoryItems', [{ ...item, currentQty: 2 }]);
assert.throws(() => deleteInventoryItemIfUnused(item.id), /stock or reserved quantity/);
assert.deepEqual(JSON.parse(localStorage.getItem('inventoryItems')), [{ ...item, currentQty: 2 }]);

reset();
setList('inventoryItems', [{ ...item, reservedQty: 1 }]);
assert.throws(() => deleteInventoryItemIfUnused(item.id), /stock or reserved quantity/);
assert.deepEqual(JSON.parse(localStorage.getItem('inventoryItems')), [{ ...item, reservedQty: 1 }]);

reset();
setList('inventoryItems', [{ ...item, currentQty: 'unknown' }]);
assert.throws(() => deleteInventoryItemIfUnused(item.id), /stock or reserved quantity/);

reset();
localStorage.setItem('qualityChecks', '{invalid');
assert.throws(() => deleteInventoryItemIfUnused(item.id), /history could not be verified/);
assert.deepEqual(JSON.parse(localStorage.getItem('inventoryItems')), [item]);

console.log(`Store item deletion checks passed (${references.length} reference sources, stock and safe deletion).`);
