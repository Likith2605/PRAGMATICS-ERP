import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as XLSX from 'xlsx';
import { buildReportWorkbook, scheduleReportPrint } from '../src/utils/reportExports.js';
import {
  getAdvanceShipmentRows, getAvailableIssuedStockRows, getCustomerMaterialStatusRows,
  getGRNPOPRRows, getInwardRows, getMRNDetailRows, getSupplierDirectoryRows,
  getOutsourcingReportRows
} from '../src/utils/trackAReportData.js';

const fixture = {
  vendorMaster: [{ seq: 11, name: 'Fixture Supplier', phone: '111', active: true }],
  inventoryItems: [{ itemCode: 'RM-1', itemName: 'Fixture Material', category: 'Raw', unit: 'Kg', currentQty: 15, reservedQty: 2 }],
  stockTransactions: [{ itemCode: 'RM-1', itemName: 'Fixture Material', unit: 'Kg', type: 'OUT', quantity: 3, reason: 'Store Issue' }],
  materialArrivals: [{ arrivalNumber: 'ARR-1', arrivalDate: '2026-11-01', poNumber: 'PO-1', supplier: 'Fixture Supplier', items: [{ materialCode: 'RM-1', materialName: 'Fixture Material', arrivalQty: 5, unit: 'Kg' }] }],
  materialReceipts: [{ receiptNumber: 'MRN-1', receiptDate: '2026-11-02', poNumber: 'PO-1', supplier: 'Fixture Supplier', items: [{ materialCode: 'RM-1', materialName: 'Fixture Material', receivedQty: 5, unit: 'Kg' }] }],
  qualityChecks: [{ qcNumber: 'QC-1', arrivalNumber: 'ARR-1', items: [{ materialCode: 'RM-1', acceptedQty: 4, rejectedQty: 1 }] }],
  storeGRNs: [{ grnNumber: 'GRN-1', grnDate: '2026-11-03', poRef: 'PO-1', supplier: 'Fixture Supplier', items: [{ itemCode: 'RM-1', itemName: 'Fixture Material', acceptedQty: 4, unit: 'Kg' }] }],
  supplierPOHistory: [{ reference: 'PO-1', vendor: 'Fixture Supplier', status: 'Open', date: '2026-11-01', payload: { poDetails: { poNumber: 'PO-1', poDate: '2026-11-01', purchaseRequestNumber: 'PR-1' }, items: [{ itemCode: 'RM-1', itemName: 'Fixture Material', quantity: 10, unit: 'Kg', rate: 4 }] } }],
  purchaseIndents: [], purchaseRequestHistory: [], purchaseOrderProgress: [],
  salesOrderHistory: [{ reference: 'SO-1', company: 'Fixture Customer', payload: { soDetails: { soNumber: 'SO-1', projectId: 'P-1', soDate: '2026-11-01', currency: 'INR' }, customerDetails: { companyName: 'Fixture Customer' }, items: [{ itemCode: 'FG-1', itemName: 'Fixture Part', unit: 'Nos', quantity: 10, unitPrice: 100 }] } }],
  productionJobCards: [{ jobCardNumber: 'JC-1', salesOrderRef: 'SO-1', itemCode: 'FG-1', partName: 'Fixture Part', producedQty: 5, qualityControl: { finalQC: { acceptedQty: 4 } } }],
  deliveryChallanHistory: [{ reference: 'DC-1', payload: { dcDetails: { dcNumber: 'DC-1', salesOrderRef: 'SO-1' }, items: [{ itemCode: 'FG-1', itemName: 'Fixture Part', quantity: 1 }] } }],
  materialRequests: [{ mrNumber: 'MR-001', date: '2026-11-01', items: [{ materialId: 'RM-1', materialName: 'Fixture Material', requiredQty: 5, unit: 'Kg' }] }],
  storeIssueHistory: [], materialReturnHistory: [], htOutsourceRequests: []
};

globalThis.localStorage = {
  getItem: (key) => Object.hasOwn(fixture, key) ? JSON.stringify(fixture[key]) : null,
  setItem: () => { throw new Error('Report tests must not write local storage'); },
  removeItem: () => { throw new Error('Report tests must not remove local storage'); }
};
globalThis.window = {
  location: { pathname: '/reports/purchase/inward' },
  document: { createElement: () => ({ href: '', protocol: '', hostname: '', port: '' }) },
  atob: globalThis.atob, btoa: globalThis.btoa,
  setTimeout: (fn) => { fn(); }, print: () => {}
};
globalThis.alert = () => {};

const checks = [];
const checkRows = (name, rows, predicate = (value) => value.length > 0) => {
  assert.ok(Array.isArray(rows), `${name} returns array`);
  assert.ok(predicate(rows), `${name} has fixture-backed rows`);
  checks.push(name);
  return rows;
};

checkRows('Supplier directory', getSupplierDirectoryRows(), (rows) => rows.some((row) => row.supplierName === 'Fixture Supplier'));
checkRows('Available / issued stock', getAvailableIssuedStockRows(), (rows) => rows.some((row) => row.itemCode === 'RM-1' && row.issuedQty === 3));
checkRows('Inward', getInwardRows(), (rows) => rows.some((row) => row.reference === 'ARR-1' && row.acceptedQty === 4));
checkRows('GRN–PO–PR', getGRNPOPRRows(), (rows) => rows.some((row) => row.poNumber === 'PO-1'));
checkRows('Advance shipment empty without source', getAdvanceShipmentRows(), (rows) => rows.length === 0);
checkRows('Customer material status', getCustomerMaterialStatusRows(), (rows) => rows.some((row) => row.salesOrder === 'SO-1'));
checkRows('MRN detail', getMRNDetailRows(), (rows) => rows.some((row) => row.mrNumber === 'MR-001'));
checkRows('Outsourcing source coverage', getOutsourcingReportRows(), (rows) => rows.length === 0);

const reportTypes = [
  'suppliers', 'stock', 'inward', 'grnPoPr', 'advanceShipment', 'customerMaterialStatus', 'mrnDetail'
];
const vite = await createServer({
  configFile: './vite.config.js', server: { middlewareMode: true }, ssr: { noExternal: ['jspdf', 'html2canvas'] },
  resolve: { alias: { 'jspdf-autotable': path.resolve('tests/helpers/jspdf-autotable-ssr.mjs') } },
  appType: 'custom', logLevel: 'error'
});
try {
  const [{ default: TrackAReportPage }, { default: MaterialIssueRegisterPage }, { default: MaterialWithSupplierPage }, { default: ReadyToDespatchPage }, { generateRegisterPDF }] = await Promise.all([
    vite.ssrLoadModule('/src/pages/reports/TrackAReportPage.jsx'),
    vite.ssrLoadModule('/src/pages/reports/MaterialIssueRegisterPage.jsx'),
    vite.ssrLoadModule('/src/pages/reports/MaterialWithSupplierPage.jsx'),
    vite.ssrLoadModule('/src/pages/reports/ReadyToDespatchPage.jsx'),
    vite.ssrLoadModule('/src/services/pdfGenerator.js')
  ]);
  const pageComponents = reportTypes.map((reportType) => [reportType, React.createElement(TrackAReportPage, { reportType })]);
  pageComponents.push(['Employee-wise material issue', React.createElement(MaterialIssueRegisterPage)]);
  pageComponents.push(['OS material with supplier', React.createElement(MaterialWithSupplierPage)]);
  pageComponents.push(['Ready to Dispatch with Value', React.createElement(ReadyToDespatchPage)]);
  const companySettings = { companyName: 'Fixture Company', address: 'Fixture Address', phone: '123' };
  for (const [name, component] of pageComponents) {
    const html = renderToStaticMarkup(component);
    assert.match(html, /Download PDF/, `${name} renders PDF option`);
    assert.match(html, /Download Excel/, `${name} renders Excel option`);
    assert.match(html, />Print</, `${name} renders Print option`);
    checks.push(`${name} view and PDF/XLSX/Print controls`);

    const workbook = buildReportWorkbook({ company: companySettings, title: name, columns: [{ key: 'value', label: 'Value' }], rows: [{ value: 'fixture' }] });
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const reopened = XLSX.read(bytes, { type: 'buffer' });
    assert.ok(reopened.SheetNames.includes(name.slice(0, 31)), `${name} XLSX is serializable and readable`);
    checks.push(`${name} XLSX serialization`);

    const pdf = await generateRegisterPDF({ title: name, company: companySettings, columns: [{ header: 'Value' }], rows: [['fixture']], options: { returnBase64: true } });
    assert.ok(typeof pdf === 'string' && pdf.length > 100, `${name} PDF generation returns content`);
    checks.push(`${name} PDF generation`);
  }
} finally {
  await vite.close();
}

let printed = 0;
let pageSize = 50;
scheduleReportPrint({
  windowObject: { setTimeout: (fn) => fn(), print: () => { assert.equal(pageSize, 'all'); printed += 1; } },
  currentPageSize: pageSize, setPageSize: (size) => { pageSize = size; }
});
assert.equal(printed, 1, 'Print action invoked once with all rows visible');
assert.equal(pageSize, 50, 'Print restores prior pagination after print');
checks.push('Print full-row behavior and pagination restoration');

console.log(`Track A report checks passed: ${checks.length}`);
console.log(checks.map((name) => `  ✓ ${name}`).join('\n'));
