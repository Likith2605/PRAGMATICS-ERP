import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import {
  getAdvanceShipmentRows, getAvailableIssuedStockRows, getCustomerMaterialStatusRows,
  getGRNPOPRRows, getInwardRows, getMRNDetailRows, getSupplierDirectoryRows,
  trackAFilterOptions, qtyByUnit
} from '../../utils/trackAReportData.js';

const amount = (value) => value == null ? '' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const date = () => new Date().toISOString().slice(0, 10);

const REPORTS = {
  suppliers: {
    title: 'List of Supplier', filename: 'Supplier-List', dateFilters: false, dateFilterNote: 'Date filtering is not applicable to the supplier master and undated transaction-count snapshots.', getRows: getSupplierDirectoryRows,
    note: 'Directory uses the existing vendor master only. Transaction names are not automatically merged with master suppliers.',
    columns: [
      { key: 'supplierCode', label: 'Supplier Code' }, { key: 'supplierName', label: 'Supplier Name' },
      { key: 'category', label: 'Product / Service' }, { key: 'contact', label: 'Contact' },
      { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'address', label: 'Address' },
      { key: 'gstin', label: 'GSTIN' }, { key: 'status', label: 'Status' },
      { key: 'source', label: 'Source' }, { key: 'referenceCount', label: 'Source Record Count' }
    ],
    filterKeys: ['supplierName', 'category', 'status']
  },
  stock: {
    title: 'Available / Issued Stock', filename: 'Available-Issued-Stock', dateFilters: false,
    dateFilterNote: 'Date filtering is not applicable to the current stock snapshot; dated movement totals are shown separately.',
    getRows: getAvailableIssuedStockRows,
    note: 'Available quantity is the current item snapshot less reserved quantity. Issue totals are read from stock transactions; they are not added again from issue slips. Reconciliation status is informational and does not adjust stock.',
    columns: [
      { key: 'itemCode', label: 'Item Code' }, { key: 'itemName', label: 'Item Name' },
      { key: 'category', label: 'Category' }, { key: 'unit', label: 'Unit' },
      { key: 'currentQty', label: 'Current Qty', align: 'right', renderText: (r) => amount(r.currentQty) },
      { key: 'reservedQty', label: 'Reserved', align: 'right', renderText: (r) => amount(r.reservedQty) },
      { key: 'availableQty', label: 'Available', align: 'right', renderText: (r) => amount(r.availableQty) },
      { key: 'issuedQty', label: 'Issued (ledger)', align: 'right', renderText: (r) => amount(r.issuedQty) },
      { key: 'returnedQty', label: 'Returned (ledger)', align: 'right', renderText: (r) => amount(r.returnedQty) },
      { key: 'recordedLedgerNet', label: 'Recorded Net Movement', align: 'right', renderText: (r) => amount(r.recordedLedgerNet) },
      { key: 'variance', label: 'Snapshot Variance', align: 'right', renderText: (r) => amount(r.variance) },
      { key: 'reconciliation', label: 'Reconciliation' }
    ], filterKeys: ['category', 'reconciliation']
  },
  inward: {
    title: 'Inward Report', filename: 'Inward-Report', dateFilters: true, dateField: 'date', getRows: getInwardRows,
    note: 'Arrival, material receipt and GRN posting are shown as separate event types. Do not sum them as separate physical deliveries.',
    columns: [
      { key: 'date', label: 'Date' }, { key: 'eventType', label: 'Event Type' }, { key: 'reference', label: 'Reference' },
      { key: 'poNumber', label: 'PO No' }, { key: 'supplier', label: 'Supplier' }, { key: 'invoiceOrDN', label: 'Invoice / Delivery Note' },
      { key: 'itemCode', label: 'Item Code' }, { key: 'itemName', label: 'Item Name' }, { key: 'eventQty', label: 'Event Qty', align: 'right', renderText: (r) => amount(r.eventQty) },
      { key: 'acceptedQty', label: 'QC Accepted', align: 'right', renderText: (r) => amount(r.acceptedQty) },
      { key: 'rejectedQty', label: 'QC Rejected', align: 'right', renderText: (r) => amount(r.rejectedQty) },
      { key: 'unit', label: 'Unit' }, { key: 'qcNumber', label: 'QC No' }, { key: 'sourceNote', label: 'Link Status' }
    ], filterKeys: ['eventType', 'supplier', 'poNumber']
  },
  grnPoPr: {
    title: 'GRN – PO – PR Report', filename: 'GRN-PO-PR-Report', dateFilters: true, dateField: 'date', getRows: getGRNPOPRRows,
    note: 'Only explicit PR/Indent and document references are shown. Missing source links remain blank; PO line order is retained when matching progress lines.',
    columns: [
      { key: 'date', label: 'PO Date' }, { key: 'prNumber', label: 'PR No' }, { key: 'indentNumber', label: 'Indent No' },
      { key: 'poNumber', label: 'PO No' }, { key: 'supplier', label: 'Supplier' }, { key: 'status', label: 'PO Status' },
      { key: 'itemCode', label: 'Item Code' }, { key: 'itemName', label: 'Item' }, { key: 'unit', label: 'Unit' },
      { key: 'orderedQty', label: 'Ordered', align: 'right', renderText: (r) => amount(r.orderedQty) },
      { key: 'receivedQty', label: 'Received', align: 'right', renderText: (r) => amount(r.receivedQty) },
      { key: 'pendingQty', label: 'Pending', align: 'right', renderText: (r) => amount(r.pendingQty) },
      { key: 'rate', label: 'PO Rate', align: 'right', renderText: (r) => amount(r.rate) },
      { key: 'receiptRefs', label: 'Receipt Ref(s)' }, { key: 'grnRefs', label: 'GRN Ref(s)' }, { key: 'qcRefs', label: 'QC Ref(s)' },
      { key: 'relationshipStatus', label: 'PR / Indent Link' }
    ], filterKeys: ['supplier', 'status', 'poNumber']
  },
  advanceShipment: {
    title: 'Advance Shipment Report', filename: 'Advance-Shipment-Report', dateFilters: true, dateField: 'date', getRows: getAdvanceShipmentRows,
    note: 'No advance shipment notice source exists in the current ERP. Actual material arrivals are not relabelled as advance shipments. This report will remain empty until an ASN workflow records source data.',
    columns: [
      { key: 'date', label: 'ASN Date' }, { key: 'asnNumber', label: 'ASN No' }, { key: 'supplier', label: 'Supplier' },
      { key: 'poNumber', label: 'PO No' }, { key: 'expectedArrival', label: 'Expected Arrival' },
      { key: 'carrier', label: 'Carrier / Tracking' }, { key: 'shippedQty', label: 'Shipped Qty' }, { key: 'status', label: 'Status' }
    ], filterKeys: []
  },
  customerMaterialStatus: {
    title: 'Customer Material Status', filename: 'Customer-Material-Status', dateFilters: true, dateField: 'date', getRows: getCustomerMaterialStatusRows,
    note: 'Production is linked only by exact Sales Order reference and item identity. Unlinked production is not assigned to customer orders.',
    columns: [
      { key: 'date', label: 'Order Date' }, { key: 'customer', label: 'Customer' }, { key: 'salesOrder', label: 'Sales Order' },
      { key: 'projectId', label: 'Project' }, { key: 'itemCode', label: 'Item Code' }, { key: 'itemName', label: 'Item' }, { key: 'unit', label: 'Unit' },
      { key: 'orderedQty', label: 'Ordered', align: 'right', renderText: (r) => amount(r.orderedQty) },
      { key: 'jobCardCount', label: 'Job Cards', align: 'right' },
      { key: 'producedQty', label: 'Recorded Output', align: 'right', renderText: (r) => amount(r.producedQty) },
      { key: 'acceptedQty', label: 'QC Accepted', align: 'right', renderText: (r) => amount(r.acceptedQty) },
      { key: 'dispatchedQty', label: 'Dispatched', align: 'right', renderText: (r) => amount(r.dispatchedQty) },
      { key: 'readyQty', label: 'Ready', align: 'right', renderText: (r) => amount(r.readyQty) }, { key: 'status', label: 'Status' }
    ], filterKeys: ['customer', 'projectId', 'status']
  },
  mrnDetail: {
    title: 'MRN Detail', filename: 'MRN-Detail', dateFilters: true, dateField: 'date', getRows: getMRNDetailRows,
    note: 'MR numbers come from existing MR-… Material Request records. Repeated same-item request lines are shown, but their issue/return quantities remain unallocated when no stable line link exists.',
    columns: [
      { key: 'date', label: 'MR Date' }, { key: 'mrNumber', label: 'MR No' }, { key: 'requestedBy', label: 'Requested By' },
      { key: 'jobCardNumber', label: 'Job Card' }, { key: 'salesOrder', label: 'Sales Order' }, { key: 'projectId', label: 'Project' },
      { key: 'customer', label: 'Customer' }, { key: 'itemCode', label: 'Item Code' }, { key: 'itemName', label: 'Item' }, { key: 'unit', label: 'Unit' },
      { key: 'prNumbers', label: 'PR No(s)' }, { key: 'indentNumbers', label: 'Indent No(s)' },
      { key: 'requestedQty', label: 'Requested', align: 'right', renderText: (r) => amount(r.requestedQty) },
      { key: 'issuedQty', label: 'Gross Issued', align: 'right', renderText: (r) => amount(r.issuedQty) },
      { key: 'returnedQty', label: 'Returned', align: 'right', renderText: (r) => amount(r.returnedQty) },
      { key: 'pendingIssueQty', label: 'Pending Issue', align: 'right', renderText: (r) => amount(r.pendingIssueQty) },
      { key: 'issueRefs', label: 'Issue Ref(s)' }, { key: 'status', label: 'Status' }
    ], filterKeys: ['mrNumber', 'jobCardNumber', 'projectId', 'status']
  }
};

const TrackAReportPage = ({ reportType }) => {
  const config = REPORTS[reportType];
  const rows = useMemo(() => config?.getRows ? config.getRows() : [], [config]);
  const filters = useMemo(() => trackAFilterOptions(rows), [rows]);
  if (!config) return null;
  const filterSpec = config.filterKeys.map((key) => ({
    key,
    placeholder: `All ${key === 'poNumber' ? 'POs' : key === 'mrNumber' ? 'MRs' : key}`,
    options: (filters[({ poNumber: 'poNumbers', mrNumber: 'mrNumbers', projectId: 'projects',
      category: 'categories', reconciliation: 'reconciliations', eventType: 'eventTypes' })[key] || `${key}s`] || filters[key] || [])
      .map((value) => ({ value, label: value }))
  }));
  const totals = reportType === 'stock'
    ? [
        { colKey: 'availableQty', render: (rs) => qtyByUnit(rs, 'availableQty') },
        { colKey: 'issuedQty', render: (rs) => qtyByUnit(rs, 'issuedQty') }
      ]
    : reportType === 'mrnDetail'
      ? [{ colKey: 'requestedQty', render: (rs) => qtyByUnit(rs, 'requestedQty') }]
      : [];

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      {config.note && <div className="content-block" style={{ marginBottom: 14, color: '#475569', fontSize: 13 }}>{config.note}</div>}
      <ReportRegister
        title={config.title}
        subTitle={`${rows.length} source row(s) · read-only`}
        filename={`${config.filename}-${date()}`}
        rows={rows}
        dateField={config.dateField || 'date'}
        dateFilters={config.dateFilters}
        dateFilterNote={config.dateFilterNote}
        filters={filterSpec}
        columns={config.columns}
        totals={totals}
        enableCSV
      />
    </div>
  );
};

export default TrackAReportPage;
