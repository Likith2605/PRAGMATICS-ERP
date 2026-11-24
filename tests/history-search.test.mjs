import assert from 'node:assert/strict';
import {
  filterProjectRequests,
  filterQuotationHistory,
  filterSalesOrderHistory,
  filterVendorPurchaseOrders,
  filterBallooningProjects,
  filterMaterialRecords,
  filterDebitCandidates
} from '../src/utils/historySearch.js';

const enquiries = [
  {
    projectId: 'ENQ-260001', customerName: 'Asha Rao', contactPerson: 'Asha Rao',
    companyName: 'Northstar Controls', phone: '+91 98765 43210', email: 'asha@northstar.example',
    projectName: 'Cooling Skid Upgrade', items: [{ drawingNo: 'DWG-AX47-02' }]
  },
  { projectId: 'ENQ-260002', customerName: 'Ravi Kumar', companyName: 'Pioneer Works', phone: '9000000000', items: [{ drawingNo: 'PX-200' }] }
];
for (const term of ['ENQ-260001', 'enq-26', 'NORTHSTAR', 'sha ra', '98765', 'northstar.example', 'Skid Up', 'ax47']) {
  assert.equal(filterProjectRequests(enquiries, term)[0], enquiries[0], `enquiry partial search matches ${term}`);
}
assert.equal(filterProjectRequests(enquiries, 'not-present').length, 0, 'enquiry search returns no rows for an unmatched term');
assert.equal(filterProjectRequests(enquiries, '').length, enquiries.length, 'clearing enquiry search restores every record');

const quotations = [
  {
    date: '2026-11-19', reference: 'QT-260045', projectId: 'PRJ-AX-45', company: 'Northstar Controls',
    payload: { customerDetails: { customerName: 'Asha Rao' }, quotationDetails: { projectId: 'PRJ-AX-45', quotationDate: '2026-11-19' } }
  },
  { date: '2026-10-04', reference: 'QT-260012', projectId: 'PRJ-B-12', company: 'Pioneer Works', payload: {} }
];
for (const term of ['QT-260045', 'qt-260', 'AX-4', 'northstar', 'sha r', '2026-11']) {
  assert.equal(filterQuotationHistory(quotations, term)[0], quotations[0], `quotation partial search matches ${term}`);
}
assert.equal(filterQuotationHistory(quotations, 'no quotation like this').length, 0, 'quotation search returns no rows for an unmatched term');
assert.equal(filterQuotationHistory(quotations, '').length, quotations.length, 'clearing quotation search restores every record');

const salesOrders = [
  {
    reference: 'SO-260119-451', date: '2026-11-19', quotationRef: 'QT-260045', company: 'Northstar Controls',
    payload: { soDetails: { projectId: 'PRJ-AX-45', soDate: '2026-11-19' }, customerDetails: { customerName: 'Asha Rao' } }
  },
  { reference: 'SO-260104-112', quotationRef: 'QT-260012', company: 'Pioneer Works', payload: { soDetails: { projectId: 'PRJ-B-12' } } }
];
for (const term of ['SO-260119-451', 'so-2601', 'QT-260045', 'northstar', 'Asha R', 'PRJ-AX', '2026-11']) {
  assert.equal(filterSalesOrderHistory(salesOrders, term)[0], salesOrders[0], `Sales Order partial search matches ${term}`);
}
assert.equal(filterSalesOrderHistory(salesOrders, 'missing').length, 0, 'Sales Order search returns no rows for unmatched terms');
assert.equal(filterSalesOrderHistory(salesOrders, '').length, salesOrders.length, 'clearing Sales Order search restores all rows');

const vendorPO = { reference: 'PO-260001', vendor: 'Northstar Supply', date: '2026-11-19', status: 'Submitted', payload: { poDetails: { salesOrderRef: 'SO-260119-451' } } };
const vendorRows = [{ po: vendorPO, progress: { lines: [{ materialName: 'Stainless Steel Bracket' }], computedStatus: 'Partially Received' } }];
for (const term of ['PO-260001', 'PO-26', 'NORTHSTAR', 'SO-260119', 'steel brac', '2026-11', 'partially received']) {
  assert.equal(filterVendorPurchaseOrders(vendorRows, term)[0], vendorRows[0], `Vendor PO partial search matches ${term}`);
}
assert.equal(filterVendorPurchaseOrders(vendorRows, 'missing').length, 0, 'Vendor PO search returns no rows for unmatched terms');
assert.equal(filterVendorPurchaseOrders(vendorRows, '')[0].po, vendorPO, 'clearing Vendor PO search restores the original actionable row');

const ballooningProjects = [
  { projectNumber: 'BAL-26001', customerName: 'Northstar Controls', partNumber: 'PART-AX45', drawingNumber: 'DWG-AX47-02', revision: 'C', status: 'Under Review', createdBy: 'Ravi Kumar' },
  { projectId: 'BAL-26002', customerName: 'Pioneer Works', partName: 'Housing', drawingNumber: 'DWG-PX-11', revision: 'A', status: 'Approved', createdBy: 'Meena Rao' }
];
for (const term of ['BAL-26001', 'bal-26', 'NORTHSTAR', 'PART-AX', 'AX47-02', 'c', 'under review', 'Ravi K']) {
  assert.equal(filterBallooningProjects(ballooningProjects, term)[0], ballooningProjects[0], `Ballooning partial search matches ${term}`);
}
assert.equal(filterBallooningProjects(ballooningProjects, 'missing').length, 0, 'Ballooning search returns no rows for unmatched terms');
assert.equal(filterBallooningProjects(ballooningProjects, '').length, ballooningProjects.length, 'clearing Ballooning search restores all projects');

const materialRecords = [
  { receiptNumber: 'MR-26019', poNumber: 'PO-26008', soNumber: 'SO-007', vendor: 'Northstar Supply', invoiceNumber: 'INV-45', receiptDate: '2026-11-19', receiptType: 'Replacement', qcStatus: 'Pending' },
  { receiptNumber: 'MR-26020', vendor: 'Pioneer Works', qcStatus: 'Accepted' }
];
for (const term of ['MR-26019','mr-26','PO-26008','so-007','NORTHSTAR','inv-45','2026-11','replacement','pending']) {
  assert.equal(filterMaterialRecords(materialRecords, term, ['receiptNumber','poNumber','soNumber','vendor','invoiceNumber','receiptDate','receiptType','qcStatus'])[0], materialRecords[0], `receipt search matches ${term}`);
}
assert.equal(filterMaterialRecords(materialRecords, 'absent', ['receiptNumber']).length, 0, 'receipt search handles no results');
assert.equal(filterMaterialRecords(materialRecords, '', ['receiptNumber']).length, 2, 'clearing restores every receipt');
const debitCandidates = [{ rejection: { rejectionNumber: 'RR-09', rejectionDate: '2026-11-19', poNumber: 'PO-8', qcNumber: 'QC-1' }, receipt: { receiptNumber: 'MR-1' }, vendor: 'Northstar' }];
for (const term of ['rr-09','2026-11','PO-8','qc-1','mr-1','NORTHSTAR']) assert.equal(filterDebitCandidates(debitCandidates, term).length, 1, `debit candidate search matches ${term}`);
assert.equal(filterDebitCandidates(debitCandidates, 'missing').length, 0, 'debit candidate search handles no results');
assert.equal(filterDebitCandidates(debitCandidates, '').length, 1, 'clearing debit candidate search restores the candidate');

console.log('Search helper checks passed for enquiries, quotations, sales orders, vendor POs, ballooning, material records, and debit candidates.');
