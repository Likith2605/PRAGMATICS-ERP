import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const po = {
  reference: 'PO-PDF-FULFILLMENT', status: 'Partially Received', vendor: 'National Bearing Suppliers',
  payload: {
    poDetails: { poNumber: 'PO-PDF-FULFILLMENT', poDate: '2026-11-17', poStatus: 'Partially Received' },
    vendorDetails: { companyName: 'National Bearing Suppliers', address: 'Test address' },
    items: [{ itemCode: 'BRG-1', itemName: 'Bearing', quantity: 216, unit: 'Nos', unitPrice: 100 }],
    totals: { subtotal: 21600, grandTotal: 21600 }
  }
};
save('supplierPOHistory', [po]);
save('materialReceipts', [
  { receiptNumber: 'REC-ORIGINAL', poNumber: po.reference, items: [{ materialCode: 'BRG-1', receivedQty: 216 }] },
  { receiptNumber: 'RR-REPLACEMENT', poNumber: po.reference, isReplacement: true, rejectionNumber: 'RRN-ORIGINAL',
    items: [{ materialCode: 'BRG-1', receivedQty: 20 }] }
]);
save('qualityChecks', [
  { qcNumber: 'QC-ORIGINAL', poNumber: po.reference, receiptNumber: 'REC-ORIGINAL', postedToInventory: true,
    items: [{ materialCode: 'BRG-1', receivedQty: 216, acceptedQty: 196, rejectedQty: 20 }] },
  { qcNumber: 'QC-REPLACEMENT', receiptNumber: 'RR-REPLACEMENT', postedToInventory: false,
    items: [{ materialCode: 'BRG-1', receivedQty: 20, acceptedQty: 20, rejectedQty: 0 }] }
]);
save('rejectionReports', [{ rejectionNumber: 'RRN-ORIGINAL', poNumber: po.reference, qcNumber: 'QC-ORIGINAL',
  items: [{ materialCode: 'BRG-1', rejectedQty: 20, replacementQty: 20, pendingReplacementQty: 0 }] }]);

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const workflow = await vite.ssrLoadModule('/src/utils/workflowService.js');
  const progress = workflow.getPOProgress(po.reference);
  assert.equal(progress.originalAccepted, 196);
  assert.equal(progress.replacementAccepted, 20);
  assert.equal(progress.finalAccepted, 216);
  assert.equal(progress.physicalReceiptBalance, 0);
  assert.equal(progress.acceptedQuantityShortage, 0);
  assert.equal(progress.status, workflow.PO_STATUS.FULL);
  assert.equal(progress.closureReady, false, 'PDF status does not imply invoice/inventory closure');

  const pdfSource = await readFile(new URL('../src/services/pdfGenerator.js', import.meta.url), 'utf8');
  assert.match(pdfSource, /const poProgress = getPOProgress\(po\.poNumber\)/, 'PO PDF uses canonical progress');
  assert.match(pdfSource, /pdf\.text\(ERP_REPORT_FOOTER, 10, pageHeight - 3\)/, 'shared document PDF footer uses canonical ERP text');
  assert.match(pdfSource, /footerText = ERP_REPORT_FOOTER/, 'register PDFs default to the canonical ERP footer');
  for (const label of ['Ordered Quantity', 'Original Received', 'Original Accepted', 'Rejected', 'Replacement Received',
    'Replacement Accepted', 'Total Accepted', 'Physical Receipt Balance', 'Accepted Quantity Shortage', 'QC Pending']) {
    assert.ok(pdfSource.includes(label), `PO PDF includes ${label}`);
  }
  console.log('PO fulfillment and PDF status regression passed.');
} finally {
  await vite.close();
}
