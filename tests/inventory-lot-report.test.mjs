import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear()
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

save('inventoryItems', [{ itemCode: 'RM-1', itemName: 'Steel bar', unit: 'kg', shelfLifeManaged: true }]);
save('inventoryBatches', [{ id: 'batch-1', internalBatchId: 'IRB-0001', itemCode: 'RM-1', itemName: 'Steel bar', supplierBatchNumber: '', batchNumber: '', grnNumber: 'REC-1', warehouse: 'A1', qtyReceived: 10, availableQty: 7, blockedQty: 1, rejectedQty: 1, reservedQty: 1, expiryDate: '2027-01-01', qcStatus: 'Partially Approved', dimensions: { thickness: 4 } }]);
save('stockTransactions', [
  { receiptBatchId: 'batch-1', date: '2026-01-01', itemCode: 'RM-1', itemName: 'Steel bar', type: 'IN', quantity: 10, reason: 'Quality Approved Material' },
  { receiptBatchId: 'batch-1', date: '2026-01-02', itemCode: 'RM-1', type: 'OUT', quantity: 3, reason: 'Store Issue' }
]);

const reports = await import('../src/utils/inventoryReportData.js');
const availability = reports.getLotAvailabilityRows();
assert.equal(availability.length, 1);
assert.equal(availability[0].internalBatchId, 'IRB-0001');
assert.equal(availability[0].usableQty, 4, 'usable quantity excludes reservations, blocked and rejected stock');
assert.equal(availability[0].reservedQty, 1);
assert.equal(availability[0].dimensions.thickness, 4);
const ledger = reports.getLocationLotLedgerRows();
assert.equal(ledger.length, 2, 'receiptBatchId links movements via batch record id');
assert.equal(ledger[1].closingQty, 7);
console.log('Inventory lot report linkage and quantity checks passed.');
