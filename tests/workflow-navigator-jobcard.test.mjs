import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
  setItem: (key, value) => values.set(String(key), String(value)),
  removeItem: (key) => values.delete(String(key)),
  clear: () => values.clear(),
  key: (index) => [...values.keys()][index] ?? null,
  get length() { return values.size; }
};
const put = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const projectId = 'PE-WORKFLOW-TEST';
const jobCard = (status, disposition) => ({
  jobCardNumber: 'JC-WORKFLOW-001', projectId, salesOrderRef: 'SO-WORKFLOW-001',
  partName: 'Test Shaft', drawingNumber: 'DWG-001', status,
  qualityControl: { finalQC: { disposition } }
});
const sourceInvoice = {
  invoiceDetails: {
    invoiceNumber: 'INV-WORKFLOW-001', projectId, salesOrderRef: 'SO-WORKFLOW-001',
    notes: 'Dispatched via Delivery Challan DC-WORKFLOW-001 dated 2026-11-17.'
  },
  items: [{ itemName: 'Test Shaft', drawingNo: 'DWG-001' }]
};

put('projectRequests', [{ projectId, customerName: 'Test Customer', companyName: 'Test Customer', items: [{ itemName: 'Test Shaft', drawingNo: 'DWG-001' }] }]);
put('salesOrderHistory', [{ reference: 'SO-WORKFLOW-001', payload: { soDetails: { projectId, soNumber: 'SO-WORKFLOW-001' }, items: [{ itemName: 'Test Shaft', drawingNo: 'DWG-001' }], customerDetails: {} } }]);
put('deliveryChallanHistory', [{ reference: 'DC-WORKFLOW-001', payload: { jobCardNumber: 'JC-WORKFLOW-001', dcDetails: { dcNumber: 'DC-WORKFLOW-001', projectId, salesOrderRef: 'SO-WORKFLOW-001' }, items: [{ itemName: 'Test Shaft', drawingNo: 'DWG-001' }] } }]);
put('customerInvoiceHistory', [{ reference: 'INV-WORKFLOW-001', payload: sourceInvoice }]);

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const [{ getFullProjectData }, { default: WorkflowNavigator }] = await Promise.all([
    vite.ssrLoadModule('/src/utils/projectTracker.js'),
    vite.ssrLoadModule('/src/components/WorkflowNavigator.jsx')
  ]);
  const render = () => renderToStaticMarkup(React.createElement(
    MemoryRouter,
    null,
    React.createElement(WorkflowNavigator, { projectId, currentStage: 'enquiry', sourceDocument: sourceInvoice })
  ));
  const setJobCard = (record) => put('productionJobCards', record ? [record] : []);
  const htmlForJobCard = (record) => {
    setJobCard(record);
    const data = getFullProjectData(projectId, sourceInvoice);
    const html = render();
    const marker = html.indexOf('5. Job Card (QC)');
    const stageStart = html.lastIndexOf('<div', marker);
    const stageHtml = html.slice(stageStart, html.indexOf('</div>', marker) + 6);
    return { data, html, stageHtml };
  };

  let view = htmlForJobCard(jobCard('Completed', 'PASS'));
  assert.equal(view.data.jobCardNumber, 'JC-WORKFLOW-001', 'linked Job Card reference is resolved via invoice DC/SO/project references');
  assert.equal(view.data.jobCardComplete, true, 'Completed plus final QC PASS qualifies for completion');
  assert.match(view.stageHtml, /background:#f0fdf4/, 'completed QC-passed Job Card stage is green');
  assert.match(view.stageHtml, /JC-WORKFLOW-001/, 'Job Card number is displayed in the stage');

  view = htmlForJobCard(jobCard('In Production', 'PASS'));
  assert.equal(view.data.jobCardComplete, false);
  assert.match(view.stageHtml, /background:#f8fafc/, 'incomplete Job Card stage stays grey');

  view = htmlForJobCard(jobCard('Completed', 'FAIL'));
  assert.equal(view.data.jobCardComplete, false);
  assert.match(view.stageHtml, /background:#f8fafc/, 'failed final QC does not complete the stage');

  view = htmlForJobCard(null);
  assert.equal(view.data.jobCardNumber, '');
  assert.equal(view.data.jobCardComplete, false);
  assert.match(view.stageHtml, /background:#f8fafc/, 'missing Job Card stage stays grey');

  setJobCard(jobCard('Completed', 'PASS'));
  const stagesHtml = render();
  const deliveryMarker = stagesHtml.indexOf('6. Delivery Challan');
  const invoiceMarker = stagesHtml.indexOf('7. GST Invoice');
  const deliveryHtml = stagesHtml.slice(stagesHtml.lastIndexOf('<div', deliveryMarker), stagesHtml.indexOf('</div>', deliveryMarker) + 6);
  const invoiceHtml = stagesHtml.slice(stagesHtml.lastIndexOf('<div', invoiceMarker), stagesHtml.indexOf('</div>', invoiceMarker) + 6);
  assert.match(deliveryHtml, /background:#f0fdf4/, 'Delivery Challan stage remains complete');
  assert.match(invoiceHtml, /background:#f0fdf4/, 'GST Invoice stage remains complete');
  console.log('Workflow navigator Job Card linkage and completion checks passed.');
} finally {
  await vite.close();
}
