import assert from 'node:assert/strict';
import { normalizeSalesOrderItemLines, normalizeSalesOrderRecord } from '../src/services/salesOrderApi.js';

const multiple = normalizeSalesOrderRecord({
  reference: 'SO-MULTI',
  payload: {
    soDetails: { soNumber: 'SO-MULTI', projectId: 'PRJ-MULTI' },
    customerDetails: { customerName: 'Customer', companyName: 'Company' },
    items: [
      { itemCode: 'RAW-1', itemName: 'Plate', drawingNo: 'DWG-1', quantity: 2, unit: 'Nos' },
      { itemCode: 'RAW-2', itemName: 'Bracket', drawingNo: 'DWG-2', quantity: 4, unit: 'Nos' }
    ]
  }
});
assert.equal(normalizeSalesOrderItemLines(multiple).length, 2);
assert.equal(normalizeSalesOrderItemLines(multiple)[0].drawingNo, 'DWG-1');
assert.equal(normalizeSalesOrderItemLines(multiple)[1].quantity, 4);

const legacy = normalizeSalesOrderRecord({
  reference: 'SO-LEGACY',
  payload: {
    soDetails: { soNumber: 'SO-LEGACY', projectId: 'PRJ-LEGACY' },
    customerDetails: { customerName: 'Legacy Customer' },
    orderItems: [
      { itemCode: 'LEG-1', itemName: 'Legacy Item', drawingNumber: 'LEG-DWG', quantity: 7, unit: 'Kg' }
    ]
  }
});
const legacyLines = normalizeSalesOrderItemLines(legacy);
assert.equal(legacyLines.length, 1);
assert.equal(legacyLines[0].drawingNo, 'LEG-DWG');
assert.equal(legacyLines[0].quantity, 7);

const missing = normalizeSalesOrderRecord({
  reference: 'SO-MISSING',
  payload: {
    soDetails: { soNumber: 'SO-MISSING' },
    customerDetails: { customerName: 'Missing Customer' }
  }
});
assert.equal(normalizeSalesOrderItemLines(missing).length, 0);

console.log('Sales Order item normalization: 3 scenarios passed.');
