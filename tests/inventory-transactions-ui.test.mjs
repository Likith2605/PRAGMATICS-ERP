import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeStockLedgerRecord } from '../src/services/inventoryApi.js';

const page = await readFile(new URL('../src/pages/InventoryTransactionsPage.jsx', import.meta.url), 'utf8');
const routes = await readFile(new URL('../server/inventoryRoutes.js', import.meta.url), 'utf8');

const movement = normalizeStockLedgerRecord({
  id: 'ledger-1',
  entry_date: '2026-01-03',
  entry_time: '2026-01-03T10:15:00.000Z',
  item_code: 'MAT-1',
  movement_type: 'TRANSFER_OUT',
  quantity: '2.5',
  balance_after: '7.5',
  unit: 'Kg',
  source_doc_ref: 'TR-1',
  batch_no: 'B-1',
  lot_number: 'LOT-1',
  created_by: 'store@example.test',
  reason: 'Store transfer',
  payload: { projectId: 'PRJ-1', issuedTo: 'Store A', issuedToId: 'EMP-1' }
}, new Map([['MAT-1', 'Steel']]));

assert.deepEqual(
  {
    itemCode: movement.itemCode,
    itemName: movement.itemName,
    type: movement.type,
    quantity: movement.quantity,
    balanceAfter: movement.balanceAfter,
    transactionNumber: movement.transactionNumber,
    batchNo: movement.batchNo,
    lotNumber: movement.lotNumber,
    projectId: movement.projectId,
    issuedTo: movement.issuedTo,
    issuedBy: movement.issuedBy
  },
  {
    itemCode: 'MAT-1',
    itemName: 'Steel',
    type: 'OUT',
    quantity: 2.5,
    balanceAfter: 7.5,
    transactionNumber: 'TR-1',
    batchNo: 'B-1',
    lotNumber: 'LOT-1',
    projectId: 'PRJ-1',
    issuedTo: 'Store A',
    issuedBy: 'store@example.test'
  }
);
assert.match(page, /listAllStockLedger/);
assert.doesNotMatch(page, /getStockTransactions/);
assert.match(page, /role="alert"/);
assert.match(routes, /router\.get\('\/ledger', allowRead,/);
console.log('PASS inventory transaction ledger source and normalization');
