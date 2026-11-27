import assert from 'node:assert/strict';
import {
  normalizeInventoryBatch,
  normalizeInventoryItem,
  normalizeStockLedgerEntry
} from '../src/utils/reportApiData.js';
import {
  getAvailableIssuedStockRows,
  getGRNPOPRRows
} from '../src/utils/trackAReportData.js';
import { getWorkflowDashboard } from '../src/utils/workflowService.js';
import {
  getLotAvailabilityRows,
  getLocationLotLedgerRows
} from '../src/utils/inventoryReportData.js';
import { applyReportFilters } from '../src/utils/reportFilters.js';

globalThis.localStorage = {
  getItem: () => { throw new Error('Report calculations must not read browser storage'); }
};

const item = normalizeInventoryItem({
  item_code: 'RM-1', material_name: 'Steel', category: 'Raw', unit: 'kg',
  current_qty: '15', reorder_level: '10', unit_price: '4', payload: { reservedQty: 2 }
});
const issue = normalizeStockLedgerEntry({
  id: 'LED-1', item_code: 'RM-1', movement_type: 'ISSUE', quantity: '3',
  unit: 'kg', source_doc_type: 'Store Issue', source_doc_ref: 'ISS-1',
  entry_date: '2026-03-01'
});
const receipt = normalizeStockLedgerEntry({
  id: 'LED-2', item_code: 'RM-1', movement_type: 'RECEIPT', quantity: '10',
  unit: 'kg', source_doc_type: 'Material Receipt', source_doc_ref: 'MRN-1',
  entry_date: '2026-02-28'
});
const stockRows = getAvailableIssuedStockRows({ inventoryItems: [item], stockLedger: [issue, receipt] });
assert.equal(stockRows[0].availableQty, 13);
assert.equal(stockRows[0].issuedQty, 3, 'ISSUE ledger movements are counted as outbound material');
assert.equal(stockRows[0].recordedLedgerNet, 7);
assert.equal(stockRows[0].variance, 8);

const batch = normalizeInventoryBatch({
  id: 'BATCH-1', item_code: 'RM-1', batch_number: 'LOT-1', lot_number: 'L-1',
  initial_qty: '10', available_qty: '7', unit: 'kg',
  payload: { reservedQty: 1, blockedQty: 1, rejectedQty: 1, dimensions: { thickness: 4 } }
});
const lotData = { items: [item], batches: [batch], transactions: [
  { ...receipt, receiptBatchId: 'BATCH-1' },
  { ...issue, receiptBatchId: 'BATCH-1' }
] };
const lotRows = getLotAvailabilityRows(lotData);
assert.equal(lotRows[0].physicalQty, 7);
assert.equal(lotRows[0].usableQty, 4);
assert.equal(lotRows[0].dimensions.thickness, 4);
assert.equal(getLocationLotLedgerRows(lotData).at(-1).closingQty, 7);

const purchaseOrder = {
  reference: 'PO-1',
  vendor: 'Supplier',
  status: 'Partially Received',
  payload: {
    poDetails: { poNumber: 'PO-1', poDate: '2026-02-01', soNumber: 'SO-1', projectId: 'P-1', indentNumber: 'IND-1' },
    items: [{ itemCode: 'RM-1', itemName: 'Steel', quantity: 5, unit: 'kg', unitPrice: 4 }]
  },
  progress: {
    ordered: 5, received: 5, pending: 0, status: 'Fully Received',
    lines: [{ receivedQty: 5, pendingQty: 0 }]
  }
};
const grnRows = getGRNPOPRRows({
  purchaseOrders: [purchaseOrder],
  purchaseRequests: [{ prNumber: 'PR-1', poNumber: 'PO-1' }],
  purchaseIndents: [{ indentNumber: 'IND-1', poNumber: 'PO-1' }],
  receipts: [{ receiptNumber: 'MRN-1', poNumber: 'PO-1' }],
  grns: [{ grnNumber: 'GRN-1', poRef: 'PO-1' }],
  qualityChecks: [{ qcNumber: 'QC-1', poNumber: 'PO-1' }]
});
assert.equal(grnRows.length, 1);
assert.equal(grnRows[0].prNumber, 'PR-1');
assert.equal(grnRows[0].receivedQty, 5);
assert.equal(grnRows[0].receiptRefs, 'MRN-1');
assert.equal(grnRows[0].grnRefs, 'GRN-1');
assert.equal(grnRows[0].qcRefs, 'QC-1');

const dashboard = getWorkflowDashboard({
  salesOrders: [{
    reference: 'SO-1', company: 'Customer', status: 'Open',
    payload: { soDetails: { projectId: 'P-1' }, customerDetails: { companyName: 'Customer' }, items: [{ itemCode: 'RM-1', itemName: 'Steel', quantity: 5 }] }
  }],
  availabilityChecks: [{ soNumber: 'SO-1', lines: [{ shortageQty: 0 }] }],
  indents: [{ indentNumber: 'IND-1', soNumber: 'SO-1', status: 'Submitted', items: [{ materialCode: 'RM-1', purchaseQty: 2 }] }],
  receipts: [{ receiptNumber: 'MRN-1', poNumber: 'PO-1', qcNumber: 'QC-1', qcStatus: 'Approved', items: [{ receivedQty: 5 }] }],
  qualityChecks: [{ qcNumber: 'QC-1', soNumber: 'SO-1', poNumber: 'PO-1', receiptNumber: 'MRN-1', status: 'Approved', items: [{ receivedQty: 5, acceptedQty: 4, rejectedQty: 1 }] }],
  rejections: [{ rejectionNumber: 'REJ-1', poNumber: 'PO-1', status: 'Raised', pendingReplacementQty: 1, items: [{ rejectedQty: 1 }] }],
  purchaseOrders: [purchaseOrder],
  enquiries: [],
  quotations: [],
  inventoryItems: [{ ...item, currentQty: 5 }]
});
assert.equal(dashboard.counts.salesOrders, 1);
assert.equal(dashboard.counts.purchaseOrders, 1);
assert.equal(dashboard.store.checkedOrders, 1);
assert.equal(dashboard.store.acceptedAwaitingPosting, 1);
assert.equal(dashboard.production.materialsAvailable, 1);
assert.equal(dashboard.purchase.posFull, 1);

const filtered = applyReportFilters({
  rows: [{ status: 'Open', quantity: 5 }, { status: 'Closed', quantity: 2 }],
  filters: [{ key: 'status' }],
  selections: { status: 'Open' }
});
assert.deepEqual(filtered.filteredRows.map((row) => row.quantity), [5]);

console.log('Authoritative report and dashboard calculations passed.');
