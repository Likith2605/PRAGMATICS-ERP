import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive, ArrowDownLeft, Building2, Boxes, CircleAlert, ClipboardCheck, ClipboardList, FileCheck2,
  FileClock, FileText, Package, PackageCheck, PackageOpen, ReceiptText, RotateCcw,
  ShoppingCart, Truck, Users
} from 'lucide-react';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import { getCurrentUserInfo } from '../utils/permissions.js';
import { listProcurementRecords, listPurchaseOrders, listPurchaseIndentQualityChecks } from '../services/procurementIntakeApi.js';
import { listMaterialReceiptQualityChecksApi, listMaterialReceiptsApi } from '../services/materialReceiptApi.js';
import { getWorkflowDashboard, getSalesOrdersWithMaterialStatus } from '../utils/workflowService.js';
import { getRequirementsAwaitingStoreReview, getRequirementSummary } from '../utils/productionRequirementService.js';
import { listInventoryItems, listAllStockLedger } from '../services/inventoryApi.js';
import { getStoreIssues } from '../services/storeApi.js';
import { listSalesOrders } from '../services/salesOrderApi.js';
import { listModuleRecords } from '../services/moduleRecordsApi.js';
import { listAvailabilityChecks } from '../services/availabilityCheckApi.js';
import { listRequirements } from '../services/productionApi.js';
import { normalizeInventoryItem, normalizeStockLedgerEntry } from '../utils/reportApiData.js';
import './purchase-dashboard.css';
import './store-dashboard.css';
import './store-screens.css';

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const transactionTypeLabel = (transaction) => {
  const reason = String(transaction.reason || '').toLowerCase();
  if (reason.includes('store issue')) return 'Store Issue';
  if (reason.includes('store return')) return 'Store Return';
  if (reason.includes('purchase')) return 'Purchase Receipt';
  if (reason.includes('manual adjustment') || reason.includes('adjustment')) return 'Stock Adjustment';
  if (reason.includes('delivery challan') || reason.includes('dispatch')) return 'Dispatch';
  if (reason.includes('production')) return 'Production';
  if (reason.includes('issued to employee')) return 'Employee Issue';
  return transaction.type === 'IN' ? 'Stock In' : 'Stock Out';
};

const StatCard = ({ label, value, tone = 'neutral', onClick }) => (
  <div
    onClick={onClick}
    style={{
      background: '#fff',
      border: '1px solid #e2e8f0',
      borderRadius: '10px',
      padding: '14px 16px',
      cursor: onClick ? 'pointer' : 'default',
      minWidth: '160px'
    }}
  >
    <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, marginBottom: '6px' }}>{label}</div>
    <div
      style={{
        fontSize: '26px',
        fontWeight: 800,
        color: tone === 'danger' ? '#b91c1c' : tone === 'success' ? '#166534' : tone === 'warn' ? '#b45309' : '#1e293b'
      }}
    >
      {value}
    </div>
  </div>
);

const Section = ({ title, children }) => (
  <div className="content-block">
    <div className="block-header">
      <h3 className="block-title">{title}</h3>
    </div>
    {children}
  </div>
);

const QueueTable = ({ columns, rows, empty, navigate, actionRoute, stateKey }) => (
  <div className="history-table-wrapper">
    <table className="history-table">
      <thead>
        <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length} className="no-history-row">{empty}</td></tr>
        ) : (
          rows.map((r) => (
            <tr key={r.key}>
              {columns.map((c) => (
                <td key={c}>{r.cells[c]}</td>
              ))}
              <td>
                <button
                  className="button-small button-secondary"
                  onClick={() =>
                    navigate(actionRoute, stateKey && r[stateKey] ? { state: { [stateKey]: r[stateKey] } } : undefined)
                  }
                >
                  {r.action || 'Open'}
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

/** Generic projection helper: turns a dashboard row object into table cells. */
const toRows = (list, keyName, fieldMap, nav) =>
  (list || []).map((r, idx) => {
    const cells = {};
    Object.entries(fieldMap).forEach(([header, value]) => {
      const v = typeof value === 'function' ? value(r) : r[value];
      cells[header] = v == null || v === '' ? '—' : v;
    });
    return { key: r[keyName] || `${keyName}-${idx}`, [keyName]: r[keyName], cells, action: r.action };
  });

const PurchaseMetric = ({ icon: Icon, label, value, note, tone = 'default', onClick }) => {
  const onKeyDown = (event) => {
    if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onClick();
  };
  return (
    <div className={`purchase-metric purchase-metric--${tone}${onClick ? ' is-clickable' : ''}`} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={onKeyDown}>
      <div className="purchase-metric-heading"><span>{label}</span><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></div>
      <div className="purchase-metric-value">{value}</div>
      <div className="purchase-metric-note">{note}</div>
    </div>
  );
};

const PurchasePanel = ({ icon: Icon, title, note, children, className = '' }) => (
  <section className={`content-block purchase-panel ${className}`}>
    <div className="purchase-panel-heading">
      <div className="purchase-panel-title"><Icon size={18} strokeWidth={1.75} aria-hidden="true" /><div><h2>{title}</h2>{note && <p>{note}</p>}</div></div>
    </div>
    {children}
  </section>
);

const PurchaseDashboardContent = ({ dash, indents, recentTransactions, supplierCount, navigate }) => {
  const purchaseOrders = dash.purchase.sections.purchaseOrders || [];
  const pendingPOs = purchaseOrders.filter((po) => Number(po.pending) > 0 && !/cancel/i.test(String(po.status || '')));
  const metrics = [
    { label: 'Indents awaiting procurement', value: dash.purchase.newIndents, note: 'Ready for purchase action', icon: ClipboardList, path: '/purchase-indents', tone: dash.purchase.newIndents ? 'attention' : 'default' },
    { label: 'Awaiting production', value: dash.purchase.awaitingProduction, note: 'Indent clarification in progress', icon: FileClock, path: '/purchase-indents' },
    { label: 'Ready to convert', value: dash.purchase.readyToConvert, note: 'Submitted indents', icon: FileCheck2, path: '/purchase-indents', tone: dash.purchase.readyToConvert ? 'attention' : 'default' },
    { label: 'Purchase orders', value: dash.purchase.posTotal, note: 'Orders on record', icon: ShoppingCart, path: '/purchase-order' },
    { label: 'Pending receipt', value: dash.purchase.posOpen, note: 'Open quantity remaining', icon: PackageOpen, path: '/material-receipts', tone: dash.purchase.posOpen ? 'attention' : 'default' },
    { label: 'Partially received', value: dash.purchase.posPartial, note: 'Orders with balance due', icon: PackageCheck, path: '/material-receipts' },
    { label: 'Fully received', value: dash.purchase.posFull, note: 'Orders received in full', icon: Archive, path: '/material-receipts', tone: 'positive' },
    { label: 'Tax invoices and receipts', value: dash.purchase.receipts, note: 'Material receipts on record', icon: ReceiptText, path: '/material-receipts' },
    { label: 'Vendor enquiries', value: dash.purchase.enquiries, note: 'Sourcing requests on record', icon: FileText, path: '/vendor-enquiry' },
    { label: 'Vendor quotations', value: dash.purchase.quotations, note: 'Supplier offers on record', icon: ReceiptText, path: '/vendor-quotations' },
    { label: 'Suppliers quoted', value: supplierCount, note: 'Distinct suppliers on quotations', icon: Users, path: '/vendor-master' },
    { label: 'Rejections awaiting replacement', value: dash.purchase.replacementsPending, note: 'Replacement purchase required', icon: RotateCcw, path: '/material-receipts', tone: dash.purchase.replacementsPending ? 'attention' : 'default' },
    { label: 'Rejections to send to vendor', value: dash.purchase.rejectionsForVendor, note: 'Vendor follow-up required', icon: CircleAlert, path: '/material-receipts', tone: dash.purchase.rejectionsForVendor ? 'attention' : 'default' }
  ];

  return (
    <div className="purchase-dashboard-content">
      <section className="purchase-metric-section" aria-labelledby="purchase-overview-title">
        <div className="purchase-section-heading"><div><h2 id="purchase-overview-title">Purchase position</h2><p>Current procurement, receipt, and supplier totals</p></div></div>
        <div className="purchase-metric-grid">{metrics.map((metric) => <PurchaseMetric key={metric.label} {...metric} onClick={() => navigate(metric.path)} />)}</div>
      </section>

      <PurchasePanel icon={PackageOpen} title="Purchase orders awaiting receipt" note="Open quantities from current purchase order progress">
        <div className="history-table-wrapper"><table className="history-table purchase-table purchase-pending-table">
          <thead><tr><th>PO</th><th>Project ID</th><th>Sales order</th><th>Indent</th><th>Supplier</th><th>Ordered</th><th>Received</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{pendingPOs.length ? pendingPOs.map((po) => <tr key={po.poNumber}>
            <td><strong>{po.poNumber}</strong></td><td>{po.projectId || '—'}</td><td>{po.soNumber || '—'}</td><td>{po.indentNumber || '—'}</td><td>{po.vendor || '—'}</td><td>{po.ordered}</td><td>{po.received}</td><td>{po.pending}</td><td><span className={badgeClass(po.status)}>{po.status || 'Pending'}</span></td>
            <td><button type="button" className="button-small button-secondary" onClick={() => navigate('/purchase-order', { state: { openPO: po.poNumber } })}>Open PO</button></td>
          </tr>) : <tr><td colSpan="10" className="no-history-row">No purchase orders are awaiting receipt.</td></tr>}</tbody>
        </table></div>
      </PurchasePanel>

      <PurchasePanel icon={ArrowDownLeft} title="Recent purchase transactions" note="Latest recorded procurement and receipt activity" className="purchase-recent-panel">
        <div className="history-table-wrapper"><table className="history-table purchase-table">
          <thead><tr><th>Date</th><th>Document</th><th>Reference</th><th>Supplier</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{recentTransactions.length ? recentTransactions.map((row) => <tr key={row.key}>
            <td>{row.date || '—'}</td><td>{row.type}</td><td><strong>{row.reference}</strong></td><td>{row.supplier || '—'}</td><td><span className={badgeClass(row.status)}>{row.status || '—'}</span></td>
            <td><button type="button" className="button-small button-secondary" onClick={() => navigate(row.path, row.state ? { state: row.state } : undefined)}>Open</button></td>
          </tr>) : <tr><td colSpan="6" className="no-history-row">No purchase transactions are available.</td></tr>}</tbody>
        </table></div>
      </PurchasePanel>

      <PurchasePanel icon={Building2} title="Supplier activity" note="Vendor sourcing requests and quotations">
        <div className="purchase-supplier-grid">
          <div className="purchase-supplier-table"><h3>Vendor enquiries</h3><QueueTable
            navigate={navigate} actionRoute="/vendor-enquiry" stateKey="indentNumber"
            columns={['Enquiry', 'Indent', 'Project ID', 'Materials', 'Suppliers', 'Status']}
            rows={toRows(dash.purchase.sections.vendorEnquiries, 'enquiryNumber', {
              Enquiry: 'enquiryNumber', Indent: 'indentNumber', 'Project ID': 'projectId', Materials: 'materialCount', Suppliers: 'vendors', Status: 'status'
            })}
            empty="No vendor enquiries are on record."
          /></div>
          <div className="purchase-supplier-table"><h3>Vendor quotations</h3><QueueTable
            navigate={navigate} actionRoute="/vendor-quotations" stateKey="quotationNumber"
            columns={['Quotation', 'Supplier', 'Enquiry', 'Quantity', 'Total', 'Status']}
            rows={toRows(dash.purchase.sections.vendorQuotations, 'quotationNumber', {
              Quotation: 'quotationNumber', Supplier: 'vendor', Enquiry: 'enquiryNumber', Quantity: 'quantity', Total: (row) => row.totalAmount, Status: 'status'
            })}
            empty="No vendor quotations are on record."
          /></div>
        </div>
      </PurchasePanel>

      <PurchasePanel icon={ClipboardList} title="Purchase indents awaiting procurement">
        <QueueTable navigate={navigate} actionRoute="/purchase-indents" stateKey="indentNumber"
          columns={['Indent', 'Date', 'SO', 'Project ID', 'Customer', 'Materials', 'Purchase Qty', 'Required Date', 'Status']}
          rows={toRows(dash.purchase.sections.indentsAwaitingProcurement, 'indentNumber', {
            Indent: 'indentNumber', Date: 'indentDate', SO: 'soNumber', 'Project ID': 'projectId', Customer: 'customer', Materials: 'materialCount', 'Purchase Qty': 'purchaseQty', 'Required Date': 'requiredDate', Status: 'status'
          })}
          empty="No purchase indent is waiting for procurement action."
        />
      </PurchasePanel>

      <PurchasePanel icon={ShoppingCart} title="Purchase order status" note="Ordered, received, quality, and fulfillment quantities">
        <QueueTable navigate={navigate} actionRoute="/purchase-order" stateKey="poNumber"
          columns={['PO', 'Project ID', 'SO', 'Indent', 'Supplier', 'Ordered', 'Original Received', 'Original Accepted', 'Rejected', 'Replacement Received', 'Replacement Accepted', 'Total Accepted', 'Physical Receipt Balance', 'Accepted Quantity Shortage', 'QC Pending', 'Status', 'Fulfillment']}
          rows={toRows(purchaseOrders, 'poNumber', {
            PO: 'poNumber', 'Project ID': 'projectId', SO: 'soNumber', Indent: 'indentNumber', Supplier: 'vendor', Ordered: 'ordered', 'Original Received': 'originalArrived', 'Original Accepted': 'originalAccepted', Rejected: 'rejected', 'Replacement Received': 'replacementArrived', 'Replacement Accepted': 'replacementAccepted', 'Total Accepted': 'totalAccepted', 'Physical Receipt Balance': 'physicalReceiptBalance', 'Accepted Quantity Shortage': 'acceptedQuantityShortage', 'QC Pending': 'qcPending', Status: 'status', Fulfillment: 'fulfillmentStatus'
          })}
          empty="No purchase orders raised yet."
        />
      </PurchasePanel>

      <PurchasePanel icon={RotateCcw} title="Rejections awaiting replacement purchase">
        <QueueTable navigate={navigate} actionRoute="/material-receipts" stateKey="rejectionNumber"
          columns={['Rejection report', 'PO', 'Project ID', 'Supplier', 'Rejected Qty', 'Status']}
          rows={toRows(dash.purchase.sections.rejectionsAwaitingReplacement, 'rejectionNumber', {
            'Rejection report': 'rejectionNumber', PO: 'poNumber', 'Project ID': 'projectId', Supplier: 'vendor', 'Rejected Qty': 'rejectedQty', Status: 'status'
          })}
          empty="Every rejection has a replacement order in progress."
        />
      </PurchasePanel>

      <PurchasePanel icon={PackageCheck} title="Replacement orders">
        <QueueTable navigate={navigate} actionRoute="/purchase-indents" stateKey="indentNumber"
          columns={['Replacement indent', 'Project ID', 'SO', 'Replacement PO', 'Purchase Qty', 'Status']}
          rows={toRows(dash.purchase.sections.replacementOrders, 'indentNumber', {
            'Replacement indent': 'indentNumber', 'Project ID': 'projectId', SO: 'soNumber', 'Replacement PO': 'poNumber', 'Purchase Qty': 'purchaseQty', Status: 'status'
          })}
          empty="No replacement order has been raised yet."
        />
      </PurchasePanel>

      <PurchasePanel icon={FileText} title="All purchase indents">
        <div className="history-table-wrapper"><table className="history-table purchase-table">
          <thead><tr><th>Indent</th><th>Project ID</th><th>SO</th><th>Customer</th><th>Materials</th><th>Status</th><th>PO</th><th>Action</th></tr></thead>
          <tbody>{indents.length ? indents.map((indent) => <tr key={indent.indentNumber}>
            <td><strong>{indent.indentNumber}</strong></td><td>{indent.projectId || '—'}</td><td>{indent.soNumber || '—'}</td><td>{indent.customer || '—'}</td><td>{indent.items?.length || 0}</td><td><span className={badgeClass(indent.status)}>{indent.status}</span></td><td>{indent.poNumber || '—'}</td>
            <td><button type="button" className="button-small button-secondary" onClick={() => navigate('/purchase-indents', { state: { openIndent: indent.indentNumber } })}>Open</button></td>
          </tr>) : <tr><td colSpan="8" className="no-history-row">No purchase indents are on record.</td></tr>}</tbody>
        </table></div>
      </PurchasePanel>
    </div>
  );
};

const StoreMetric = ({ icon: Icon, label, value, note, tone = 'default', onClick }) => (
  <button type="button" className={`store-metric store-metric--${tone}`} onClick={onClick}>
    <span className="store-metric-heading">{label}<Icon size={17} strokeWidth={1.75} aria-hidden="true" /></span>
    <strong className="store-metric-value">{value}</strong>
    <span className="store-metric-note">{note}</span>
  </button>
);

const StorePanel = ({ icon: Icon, title, note, children }) => (
  <section className="content-block store-panel">
    <div className="store-panel-heading"><div><Icon size={18} strokeWidth={1.75} aria-hidden="true" /><div><h2>{title}</h2>{note && <p>{note}</p>}</div></div></div>
    {children}
  </section>
);

const StoreDataTable = ({ columns, rows, empty, children }) => (
  <div className="history-table-wrapper store-table-wrap"><table className="history-table store-table">
    <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.length ? children(rows) : <tr><td colSpan={columns.length} className="no-history-row">{empty}</td></tr>}</tbody>
  </table></div>
);

const StoreDashboardContent = ({ dash, receipts, inventory, issues, transactions, navigate }) => {
  const pendingMRNs = dash.store.sections.receiptsAwaitingQC || [];
  const pendingQC = dash.quality.awaitingCheck || [];
  const acceptedUnposted = dash.store.sections.acceptedAwaitingPosting || [];
  const dateRank = (date) => { const parsed = Date.parse(date || ''); return Number.isFinite(parsed) ? parsed : 0; };
  const recentReceipts = [...receipts].sort((a, b) => dateRank(b.receiptDate) - dateRank(a.receiptDate)).slice(0, 8);
  const supplierRows = [...receipts.reduce((map, receipt) => {
    const supplier = receipt.vendor || receipt.vendorName || 'Supplier not recorded';
    const row = map.get(supplier) || { supplier, receipts: 0, lines: 0, latest: '' };
    row.receipts += 1;
    row.lines += (receipt.items || []).length;
    if (dateRank(receipt.receiptDate) > dateRank(row.latest)) row.latest = receipt.receiptDate || '';
    map.set(supplier, row);
    return map;
  }, new Map()).values()].sort((a, b) => b.receipts - a.receipts).slice(0, 8);
  const stockValue = inventory.reduce((sum, item) => sum + (Number(item.currentQty) || 0) * (Number(item.unitCost) || 0), 0);
  const stockedItems = inventory.filter((item) => (Number(item.currentQty) || 0) > 0).length;
  const reorderItems = inventory.filter((item) => (Number(item.currentQty) || 0) <= (Number(item.minReorderLevel) || 0)).length;
  const recentIssues = [...issues].sort((a, b) => String(b.issueDate || '').localeCompare(String(a.issueDate || ''))).slice(0, 6);
  const recentTransactions = transactions.slice(0, 8);

  return (
    <div className="store-dashboard-content">
      <section className="store-metric-section" aria-labelledby="store-position-title">
        <div className="store-section-heading"><div><h2 id="store-position-title">Material position</h2><p>Current inventory, receipts, inspection and issue status</p></div></div>
        <div className="store-metric-grid">
          <StoreMetric icon={Boxes} label="Material records" value={inventory.length} note="Items in inventory" onClick={() => navigate('/store/inventory')} />
          <StoreMetric icon={Package} label="Materials in stock" value={stockedItems} note="Records with available quantity" onClick={() => navigate('/store/inventory')} />
          <StoreMetric icon={CircleAlert} label="At or below reorder level" value={reorderItems} note="Materials requiring stock review" tone={reorderItems ? 'attention' : 'default'} onClick={() => navigate('/store/inventory')} />
          <StoreMetric icon={ReceiptText} label="Inventory value" value={`₹${stockValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`} note="Current quantity × unit cost" onClick={() => navigate('/store/inventory')} />
          <StoreMetric icon={PackageOpen} label="Pending MRN / receipt QC" value={pendingMRNs.length} note="Receipts waiting for inspection" tone={pendingMRNs.length ? 'attention' : 'default'} onClick={() => navigate('/material-receipts')} />
          <StoreMetric icon={ClipboardCheck} label="Pending quality inspection" value={pendingQC.length} note="Receipt and indent inspections" tone={pendingQC.length ? 'attention' : 'default'} onClick={() => navigate('/quality-checks')} />
          <StoreMetric icon={PackageCheck} label="Approved, awaiting stock posting" value={acceptedUnposted.length} note="Quality approved material" tone={acceptedUnposted.length ? 'attention' : 'default'} onClick={() => navigate('/quality-checks')} />
          <StoreMetric icon={Truck} label="Material receipts" value={dash.store.receipts} note="Receipts recorded" onClick={() => navigate('/material-receipts')} />
          <StoreMetric icon={ArrowDownLeft} label="Material issues" value={issues.length} note="Issue records on file" onClick={() => navigate('/store/issues')} />
        </div>
      </section>

      <StorePanel icon={PackageOpen} title="Pending Material Receipt Notes" note="Receipts held for quality inspection; inventory changes only after QC approval and posting">
        <StoreDataTable columns={['MRN / Receipt', 'Date', 'PO', 'Supplier', 'Received Qty', 'Status', 'Action']} rows={pendingMRNs} empty="No material receipt is waiting for quality inspection.">
          {(rows) => rows.map((row) => <tr key={row.receiptNumber}>
            <td><strong>{row.receiptNumber}</strong></td><td>{row.dateReceived || '—'}</td><td>{row.poNumber || '—'}</td><td>{row.vendor || '—'}</td><td>{row.receivedQty}</td><td><span className={badgeClass(row.status)}>{row.status}</span></td>
            <td><button className="button-small button-secondary" onClick={() => navigate('/material-receipts', { state: { openReceipt: row.receiptNumber } })}>Open MRN</button></td>
          </tr>)}
        </StoreDataTable>
      </StorePanel>

      <StorePanel icon={ClipboardCheck} title="Pending Quality Inspection" note="Incoming receipts and purchase indent inspections">
        <StoreDataTable columns={['Source', 'Receipt / Indent', 'PO', 'Project ID', 'Supplier', 'Quantity', 'Status', 'Action']} rows={pendingQC} empty="No material is awaiting quality inspection.">
          {(rows) => rows.map((row, index) => <tr key={`${row.reference}-${index}`}>
            <td>{row.source}</td><td><strong>{row.reference}</strong></td><td>{row.poNumber || '—'}</td><td>{row.projectId || '—'}</td><td>{row.vendor || '—'}</td><td>{row.quantity}</td><td><span className={badgeClass(row.status)}>{row.status}</span></td>
            <td><button className="button-small button-secondary" onClick={() => row.source === 'Material Receipt' && row.reference ? navigate(`/quality-checks?receipt=${encodeURIComponent(row.reference)}`) : navigate('/quality-checks')}>Open QC</button></td>
          </tr>)}
        </StoreDataTable>
      </StorePanel>

      <div className="store-dashboard-columns">
        <StorePanel icon={ReceiptText} title="Recent material receipts" note="Latest supplier deliveries and stock posting status">
          <StoreDataTable columns={['Receipt', 'Date', 'PO', 'Supplier', 'Quantity', 'QC / Inventory']} rows={recentReceipts} empty="No material receipts are on record.">
            {(rows) => rows.map((receipt) => <tr key={receipt.receiptNumber}>
              <td><button className="store-table-link" onClick={() => navigate('/material-receipts', { state: { openReceipt: receipt.receiptNumber } })}>{receipt.receiptNumber}</button></td><td>{receipt.receiptDate || '—'}</td><td>{receipt.poNumber || '—'}</td><td>{receipt.vendor || '—'}</td><td>{(receipt.items || []).reduce((sum, item) => sum + (Number(item.receivedQty) || 0), 0)}</td>
              <td><span className={badgeClass(receipt.postedToInventory ? 'Posted' : receipt.qcStatus || 'Pending QC')}>{receipt.postedToInventory ? 'Posted' : receipt.qcStatus || 'Pending QC'}</span></td>
            </tr>)}
          </StoreDataTable>
        </StorePanel>
        <StorePanel icon={Building2} title="Supplier and receipt summary" note="Receipt volume grouped by recorded supplier">
          <StoreDataTable columns={['Supplier', 'Receipts', 'Receipt Lines', 'Latest Receipt']} rows={supplierRows} empty="Supplier receipt information will appear when receipts are recorded.">
            {(rows) => rows.map((row) => <tr key={row.supplier}><td>{row.supplier}</td><td>{row.receipts}</td><td>{row.lines}</td><td>{row.latest || '—'}</td></tr>)}
          </StoreDataTable>
        </StorePanel>
      </div>

      <div className="store-dashboard-columns">
        <StorePanel icon={ArrowDownLeft} title="Recent material issues" note="Issues linked to production material requests">
          <StoreDataTable columns={['Issue', 'Date', 'Material Request', 'Project ID', 'Lines', 'Receiver']} rows={recentIssues} empty="No material issues are on record.">
            {(rows) => rows.map((issue) => <tr key={issue.issueNumber}><td><button className="store-table-link" onClick={() => navigate('/store/issues', { state: { viewIssue: issue.issueNumber } })}>{issue.issueNumber}</button></td><td>{issue.issueDate || '—'}</td><td>{issue.mrNumber || '—'}</td><td>{issue.projectId || '—'}</td><td>{issue.items?.length || 0}</td><td>{issue.receivedBy || '—'}</td></tr>)}
          </StoreDataTable>
        </StorePanel>
        <StorePanel icon={ClipboardList} title="Recent inventory movements" note="Latest posted stock transactions">
          <StoreDataTable columns={['Date', 'Material', 'Movement', 'Quantity', 'Reference']} rows={recentTransactions} empty="No inventory movement is on record.">
            {(rows) => rows.map((transaction, index) => <tr key={`${transaction.transactionNumber || transaction.reference}-${index}`}><td>{transaction.date || transaction.createdAt || '—'}</td><td>{transaction.itemName || transaction.itemCode || '—'}</td><td>{transactionTypeLabel(transaction)}</td><td><span className={badgeClass(transaction.type)}>{transaction.type} {transaction.quantity}</span></td><td>{transaction.reference || transaction.transactionNumber || '—'}</td></tr>)}
          </StoreDataTable>
        </StorePanel>
      </div>
    </div>
  );
};

const EMPTY_WORKFLOW_DATA = {
  indents: [], enquiries: [], quotations: [], purchaseOrders: [], receipts: [],
  salesOrders: [], availabilityChecks: [], qualityChecks: [], rejections: [],
  inventoryItems: [], stockTransactions: [], storeIssues: [], requirements: []
};

const loadWorkflowDashboardData = async () => {
  const [indents, enquiries, quotations, purchaseOrders, receipts, salesOrders,
    availabilityChecks, recordChecks, receiptChecks, indentChecks, rejections,
    inventoryRows, ledgerRows, storeIssues, requirements] = await Promise.all([
    listProcurementRecords('purchaseIndent'),
    listProcurementRecords('vendorEnquiry'),
    listProcurementRecords('vendorQuotation'),
    listPurchaseOrders(),
    listMaterialReceiptsApi(),
    listSalesOrders(),
    listAvailabilityChecks(),
    listModuleRecords('qualityChecks'),
    listMaterialReceiptQualityChecksApi(),
    listPurchaseIndentQualityChecks(),
    listModuleRecords('rejectionReports'),
    listInventoryItems(),
    listAllStockLedger(),
    getStoreIssues(),
    listRequirements()
  ]);
  return {
    indents, enquiries, quotations, purchaseOrders, receipts, salesOrders,
    availabilityChecks: Array.isArray(availabilityChecks) ? availabilityChecks : [],
    qualityChecks: [...new Map([...recordChecks, ...receiptChecks, ...indentChecks]
      .map((record) => [String(record.qcNumber || record.id || ''), record])).values()],
    rejections,
    inventoryItems: inventoryRows.map(normalizeInventoryItem),
    stockTransactions: ledgerRows.map(normalizeStockLedgerEntry),
    storeIssues, requirements
  };
};

const WorkflowDashboardPage = () => {
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);
  const [sourceData, setSourceData] = useState(EMPTY_WORKFLOW_DATA);
  const [dashboardLoadError, setDashboardLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setDashboardLoadError('');
    loadWorkflowDashboardData()
      .then((data) => { if (active) setSourceData(data); })
      .catch((error) => {
        if (!active) return;
        setSourceData(EMPTY_WORKFLOW_DATA);
        setDashboardLoadError(`Dashboard data could not be loaded from PostgreSQL: ${error.message}`);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tick]);
  const info = getCurrentUserInfo();
  const dept = info.employee?.department || '';

  const dash = useMemo(() => getWorkflowDashboard(sourceData), [sourceData]);
  const reqSummary = useMemo(() => getRequirementSummary(sourceData.requirements), [sourceData.requirements]);
  const awaitingReqs = useMemo(() => getRequirementsAwaitingStoreReview(sourceData.requirements), [sourceData.requirements]);
  const soStatus = useMemo(() => getSalesOrdersWithMaterialStatus(sourceData), [sourceData]);
  const indents = sourceData.indents;
  const receipts = sourceData.receipts;
  const serverEnquiries = sourceData.enquiries;
  const serverQuotations = sourceData.quotations;
  const storeInventory = sourceData.inventoryItems;
  const storeIssues = sourceData.storeIssues;
  const stockTransactions = sourceData.stockTransactions;
  const purchaseOrders = useMemo(() => {
    const rows = sourceData.purchaseOrders;
    return Array.isArray(rows) ? rows.filter((record) => record && typeof record === 'object') : [];
  }, [sourceData.purchaseOrders]);
  const purchaseActivity = useMemo(() => {
    const value = (...values) => values.find((entry) => entry != null && String(entry).trim() !== '') || '';
    const rows = [
      ...purchaseOrders.map((record) => {
        const po = record.payload || record;
        const reference = value(record.reference, record.poNumber, po.reference, po.poNumber, po.purchaseOrderNumber);
        const progress = record.progress || {};
        return { key: `po:${reference}`, date: value(record.poDate, po.poDate, po.poDetails?.poDate, record.createdAt, record.date), type: 'Purchase order', reference, supplier: value(record.vendor, po.vendor, record.vendorName, po.vendorDetails?.companyName), status: value(progress?.status, record.status, po.status, po.poStatus, po.poDetails?.poStatus, 'Raised'), path: '/purchase-order', state: { openPO: reference } };
      }),
      ...serverEnquiries.map((record) => ({ key: `enquiry:${record.enquiryNumber}`, date: value(record.enquiryDate, record.createdAt, record.date), type: 'Vendor enquiry', reference: value(record.enquiryNumber, 'Vendor enquiry'), supplier: (record.vendors || []).map((vendor) => typeof vendor === 'string' ? vendor : vendor?.vendorName || vendor?.name).filter(Boolean).join(', '), status: value(record.status, 'Open'), path: '/vendor-enquiry' })),
      ...serverQuotations.map((record) => ({ key: `quotation:${record.quotationNumber}`, date: value(record.quotationDate, record.createdAt, record.date), type: 'Vendor quotation', reference: value(record.quotationNumber, 'Vendor quotation'), supplier: value(record.vendor, record.vendorName, record.supplier), status: value(record.status, 'Recorded'), path: '/vendor-quotations' })),
      ...receipts.map((record) => ({ key: `receipt:${record.receiptNumber}`, date: value(record.receiptDate, record.dateReceived, record.createdAt), type: 'Material receipt', reference: value(record.receiptNumber, 'Material receipt'), supplier: value(record.vendor, record.vendorName), status: value(record.qcStatus, record.status, 'Received'), path: '/material-receipts' })),
      ...indents.map((record) => ({ key: `indent:${record.indentNumber}`, date: value(record.indentDate, record.createdAt), type: 'Purchase indent', reference: value(record.indentNumber, 'Purchase indent'), supplier: value(record.vendor, record.vendorName), status: value(record.status, 'Recorded'), path: '/purchase-indents', state: { openIndent: record.indentNumber } }))
    ].filter((record) => record.reference);
    const timestamp = (record) => {
      const parsed = Date.parse(record.date);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return rows.sort((a, b) => timestamp(b) - timestamp(a)).slice(0, 10);
  }, [purchaseOrders, receipts, indents, serverEnquiries, serverQuotations]);
  const supplierCount = useMemo(() => new Set((dash.purchase.sections.vendorQuotations || []).map((quote) => String(quote.vendor || '').trim()).filter(Boolean)).size, [dash]);
  const rejections = sourceData.rejections;
  const qcs = sourceData.qualityChecks;

  /**
   * Joins every workflow record into one readable chain per PO / receipt so the
   * full SO → Indent → Enquiry → Quotation → PO → Receipt → QC lineage is visible.
   */
  const buildDocumentChains = () => {
    const enquiries = serverEnquiries;
    const quotations = serverQuotations;
    const chains = new Map();

    const upsert = (poNumber, patch) => {
      if (!poNumber) return;
      const key = String(poNumber);
      if (!chains.has(key)) chains.set(key, { key, poNumber });
      Object.assign(chains.get(key), patch);
    };

    indents.forEach((i) => {
      chains.set(`indent:${i.indentNumber}`, {
        key: `indent:${i.indentNumber}`,
        projectId: i.projectId,
        soNumber: i.soNumber,
        indentNumber: i.indentNumber,
        poNumber: i.poNumber
      });
    });

    enquiries.forEach((e) => {
      const link = chains.get(`indent:${e.indentNumber}`);
      if (link) {
        link.enquiryNumber = link.enquiryNumber ? `${link.enquiryNumber}, ${e.enquiryNumber}` : e.enquiryNumber;
        link.projectId = link.projectId || e.projectId;
        link.soNumber = link.soNumber || e.soNumber;
      }
    });

    quotations.forEach((q) => {
      const enq = enquiries.find((e) => String(e.enquiryNumber) === String(q.enquiryNumber));
      const link = enq ? chains.get(`indent:${enq.indentNumber}`) : null;
      if (link) {
        link.quotationNumber = link.quotationNumber ? `${link.quotationNumber}, ${q.quotationNumber}` : q.quotationNumber;
        link.projectId = link.projectId || q.projectId;
        link.soNumber = link.soNumber || q.soNumber;
      }
    });

    receipts.forEach((r) => upsert(r.poNumber, { projectId: r.projectId || undefined, soNumber: r.soNumber || undefined, receiptNumber: r.receiptNumber }));
    qcs.forEach((q) => upsert(q.poNumber, { projectId: q.projectId || undefined, receiptNumber: q.receiptNumber || undefined, qcNumber: q.qcNumber }));
    [...chains.values()].forEach((c) => {
      if (!c.poNumber) return;
      upsert(c.poNumber, {
        projectId: c.projectId,
        soNumber: c.soNumber,
        indentNumber: c.indentNumber,
        enquiryNumber: c.enquiryNumber,
        quotationNumber: c.quotationNumber
      });
    });

    return [...chains.values()]
      .filter((c) => c.projectId || c.indentNumber || c.receiptNumber)
      .map((c) => {
        const progress = c.poNumber ? purchaseOrders.find((po) => String(po.reference || '') === String(c.poNumber))?.progress : null;
        let status = 'In Progress';
        if (c.receiptNumber && !c.qcNumber) status = 'Awaiting Quality Check';
        else if (c.qcNumber) status = 'Quality Checked';
        if (progress && progress.ordered > 0 && progress.pending === 0) status = progress.status || 'Fully Received';
        return { ...c, status };
      })
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  };

  const chains = useMemo(() => buildDocumentChains(), [purchaseOrders, receipts, indents, serverEnquiries, serverQuotations, qcs]);

  const isStore = dept === 'Store Department';  const isPurchase = dept === 'Purchase Department';
  const isProduction = dept === 'Production Department';
  const isAdmin = !isStore && !isPurchase && !isProduction;

  const title = isStore ? 'Store Dashboard' : isPurchase ? 'Purchase Dashboard' : isProduction ? 'Production Dashboard' : 'Workflow Dashboard';

  return (
    <section className={`page-section${isPurchase ? ' purchase-dashboard' : ''}${isStore ? ' store-dashboard' : ''}`}>
      <div className={`page-header${isPurchase ? ' purchase-dashboard-header' : ''}${isStore ? ' store-dashboard-header' : ''}`}>
        <div>
          <h1 className="page-title">{title}</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          <button className={`button-secondary${isPurchase ? ' purchase-refresh' : ''}${isStore ? ' store-refresh' : ''}`} onClick={() => setTick((t) => t + 1)}>{(isPurchase || isStore) && <RotateCcw size={15} aria-hidden="true" />}Refresh</button>
        </div>
      </div>

      {loading ? <div role="status" className="content-block">Loading dashboard data from PostgreSQL...</div>
        : dashboardLoadError ? <div role="alert" className="form-error">{dashboardLoadError}</div>
          : <>

      {isAdmin && (
        <>
          <Section title="Store — Item Requirements, Indents, Receipts, Quality">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <StatCard label="Item Requirements awaiting Store review" value={reqSummary.awaitingReview} tone="warn" onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Requirements with shortage" value={reqSummary.shortage} tone="danger" onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Material available (requirements)" value={reqSummary.materialAvailable} tone="success" onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Requirements completed" value={reqSummary.completed} onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Indents (Draft)" value={dash.store.indentsDraft} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Indents submitted" value={dash.store.indentsSubmitted} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Material receipts" value={dash.store.receipts} onClick={() => navigate('/material-receipts')} />
              <StatCard label="POs pending receipt" value={dash.store.pendingReceipts} tone="warn" onClick={() => navigate('/material-receipts')} />
              <StatCard label="POs partially received" value={dash.store.poPartial} onClick={() => navigate('/material-receipts')} />
              <StatCard label="POs fully received & closed" value={dash.store.poClosed} tone="success" onClick={() => navigate('/material-receipts')} />
              <StatCard label="Materials pending quality check" value={dash.store.pendingQC} tone="warn" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Accepted material awaiting inventory posting" value={dash.store.acceptedAwaitingPosting} tone="warn" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Rejected materials" value={dash.store.rejectedMaterials} tone="danger" onClick={() => navigate('/material-receipts')} />
              <StatCard label="Replacement pending" value={dash.store.replacementAwaitingReceipt} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Rejections to forward to Purchase" value={dash.store.rejectionsToForward} tone="danger" onClick={() => navigate('/material-receipts')} />
            </div>
          </Section>

          <Section title="Item Requirements awaiting Store review">
            <QueueTable
              navigate={navigate}
              actionRoute="/store/item-requirements"
              stateKey="requirementNumber"
              columns={['Requirement', 'Project ID', 'Production Job', 'Customer', 'Date', 'Items', 'Status']}
              rows={toRows(awaitingReqs, 'requirementNumber', {
                Requirement: 'requirementNumber',
                'Project ID': 'projectId',
                'Production Job': 'productionJob',
                Customer: 'customer',
                Date: 'requirementDate',
                Items: (r) => (r.items?.length || 0),
                Status: 'status'
              })}
              empty="No Item Requirement is awaiting Store review."
            />
          </Section>

          <Section title="Purchase Orders awaiting material receipt">
            <QueueTable
              navigate={navigate}
              actionRoute="/material-receipts"
              stateKey="poNumber"
              columns={['PO Number', 'Project ID', 'SO', 'Indent', 'Vendor', 'Ordered | Received | Pending', 'Status']}
              rows={toRows(dash.store.sections.poAwaitingDelivery, 'poNumber', {
                'PO Number': 'poNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                Indent: 'indentNumber',
                Vendor: 'vendor',
                'Ordered | Received | Pending': (r) => `${r.ordered} | ${r.received} | ${r.pending}`,
                Status: 'status'
              })}
              empty="No Purchase Order is awaiting delivery."
            />
          </Section>

          <Section title="Material receipts awaiting quality check">
            <QueueTable
              navigate={navigate}
              actionRoute="/quality-checks"
              stateKey="receiptNumber"
              columns={['Receipt', 'PO', 'Project ID', 'Vendor', 'Received Qty', 'Date Received', 'Status']}
              rows={toRows(dash.store.sections.receiptsAwaitingQC, 'receiptNumber', {
                Receipt: 'receiptNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                Vendor: 'vendor',
                'Received Qty': 'receivedQty',
                'Date Received': 'dateReceived',
                Status: 'status'
              })}
              empty="No material is waiting for a quality check."
            />
          </Section>

          <Section title="Accepted material awaiting inventory posting">
            <QueueTable
              navigate={navigate}
              actionRoute="/quality-checks"
              stateKey="qcNumber"
              columns={['QC No', 'PO', 'Project ID', 'Accepted Qty', 'Status']}
              rows={toRows(dash.store.sections.acceptedAwaitingPosting, 'qcNumber', {
                'QC No': 'qcNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                'Accepted Qty': 'acceptedQty',
                Status: 'status'
              })}
              empty="All approved material has been posted to Inventory."
            />
          </Section>

          <Section title="Rejected material processing">
            <QueueTable
              navigate={navigate}
              actionRoute="/material-receipts"
              stateKey="rejectionNumber"
              columns={['Rejection Report', 'PO', 'Project ID', 'Vendor', 'Rejected Qty', 'Status']}
              rows={toRows(dash.store.sections.rejectedMaterials, 'rejectionNumber', {
                'Rejection Report': 'rejectionNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                Vendor: 'vendor',
                'Rejected Qty': 'rejectedQty',
                Status: 'status'
              })}
              empty="No rejected material is pending action."
            />
          </Section>

          <Section title="Sales Order material status">
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Sales Order</th><th>Customer</th><th>Materials</th><th>Pending Materials</th><th>Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {soStatus.length === 0 ? (
                    <tr><td colSpan="6" className="no-history-row">No sales orders.</td></tr>
                  ) : (
                    soStatus.map((so) => {
                      const pending = (so.material?.lines || []).filter((l) => l.pending > 0);
                      return (
                        <tr key={so.reference}>
                          <td><strong>{so.reference}</strong></td>
                          <td>{so.company}</td>
                          <td>{so.material?.lines?.length || 0}</td>
                          <td>{pending.length}</td>
                          <td><span className={badgeClass(so.material?.overallStatus)}>{so.material?.overallStatus}</span></td>
                          <td>
                            <button className="button-small button-secondary" onClick={() => navigate('/store/item-requirements')}>
                              View in Store
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {isStore && <StoreDashboardContent dash={dash} receipts={receipts} inventory={storeInventory} issues={storeIssues} transactions={stockTransactions} navigate={navigate} />}

      {isPurchase && <PurchaseDashboardContent dash={dash} indents={indents} recentTransactions={purchaseActivity} supplierCount={supplierCount} navigate={navigate} />}

      {isAdmin && (
        <Section title="Purchase — Indents, POs, Receipts, Rejections">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <StatCard label="New Purchase Indents" value={dash.purchase.newIndents} tone="warn" onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Indents awaiting Production" value={dash.purchase.awaitingProduction} onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Indents ready to convert" value={dash.purchase.readyToConvert} tone="warn" onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Indents converted to PO" value={dash.purchase.converted} tone="success" onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Purchase Orders" value={dash.purchase.posTotal} onClick={() => navigate('/purchase-order')} />
            <StatCard label="POs partially received" value={dash.purchase.posPartial} tone="warn" onClick={() => navigate('/material-receipts')} />
            <StatCard label="POs fully received" value={dash.purchase.posFull} tone="success" onClick={() => navigate('/material-receipts')} />
            <StatCard label="Tax invoices / receipts" value={dash.purchase.receipts} onClick={() => navigate('/material-receipts')} />
            <StatCard label="Vendor enquiries" value={dash.purchase.enquiries} onClick={() => navigate('/vendor-enquiry')} />
            <StatCard label="Vendor quotations" value={dash.purchase.quotations} onClick={() => navigate('/vendor-quotations')} />
            <StatCard label="Rejections awaiting replacement" value={dash.purchase.replacementsPending} tone="danger" onClick={() => navigate('/material-receipts')} />
            <StatCard label="Rejections to send to vendor" value={dash.purchase.rejectionsForVendor} tone="danger" onClick={() => navigate('/material-receipts')} />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Purchase Indents awaiting procurement</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/purchase-indents"
              stateKey="indentNumber"
              columns={['Indent', 'Date', 'SO', 'Project ID', 'Customer', 'Materials', 'Purchase Qty', 'Required Date', 'Status']}
              rows={toRows(dash.purchase.sections.indentsAwaitingProcurement, 'indentNumber', {
                Indent: 'indentNumber',
                Date: 'indentDate',
                SO: 'soNumber',
                'Project ID': 'projectId',
                Customer: 'customer',
                Materials: 'materialCount',
                'Purchase Qty': 'purchaseQty',
                'Required Date': 'requiredDate',
                Status: 'status'
              })}
              empty="No purchase indent is waiting for procurement action."
            />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Purchase Order status</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/purchase-order"
              stateKey="poNumber"
              columns={[
                'PO',
                'Project ID',
                'SO',
                'Indent',
                'Vendor',
                'Ordered',
                'Received',
                'QC Pending',
                'Accepted',
                'Rejected',
                'Replacement Pending',
                'Replacement Received',
                'Balance',
                'Status',
                'Fulfillment'
              ]}
              rows={toRows(dash.purchase.sections.purchaseOrders, 'poNumber', {
                PO: 'poNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                Indent: 'indentNumber',
                Vendor: 'vendor',
                Ordered: 'ordered',
                Received: 'received',
                'QC Pending': 'qcPending',
                Accepted: 'accepted',
                Rejected: 'rejected',
                'Replacement Pending': 'pendingReplacement',
                'Replacement Received': 'replacementArrived',
                Balance: 'pending',
                Status: 'status',
                Fulfillment: 'fulfillmentStatus'
              })}
              empty="No purchase orders raised yet."
            />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Rejections awaiting replacement purchase</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/material-receipts"
              stateKey="rejectionNumber"
              columns={['Rejection Report', 'PO', 'Project ID', 'Vendor', 'Rejected Qty', 'Status']}
              rows={toRows(dash.purchase.sections.rejectionsAwaitingReplacement, 'rejectionNumber', {
                'Rejection Report': 'rejectionNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                Vendor: 'vendor',
                'Rejected Qty': 'rejectedQty',
                Status: 'status'
              })}
              empty="Every rejection has a replacement order in progress."
            />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Replacement orders</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/purchase-indents"
              stateKey="indentNumber"
              columns={['Replacement Indent', 'Project ID', 'SO', 'Replacement PO', 'Purchase Qty', 'Status']}
              rows={toRows(dash.purchase.sections.replacementOrders, 'indentNumber', {
                'Replacement Indent': 'indentNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                'Replacement PO': 'poNumber',
                'Purchase Qty': 'purchaseQty',
                Status: 'status'
              })}
              empty="No replacement order has been raised yet."
            />
          </div>

          <div className="history-table-wrapper" style={{ marginTop: '18px' }}>
            <table className="history-table">
              <thead>
                <tr><th>Indent</th><th>Project ID</th><th>SO</th><th>Customer</th><th>Materials</th><th>Status</th><th>PO</th></tr>
              </thead>
              <tbody>
                {indents.length === 0 ? (
                  <tr><td colSpan="7" className="no-history-row">No purchase indents yet.</td></tr>
                ) : (
                  indents.map((i) => (
                    <tr key={i.indentNumber}>
                      <td><strong>{i.indentNumber}</strong></td>
                      <td>{i.projectId || '—'}</td>
                      <td>{i.soNumber}</td>
                      <td>{i.customer || '—'}</td>
                      <td>{i.items?.length || 0}</td>
                      <td><span className={badgeClass(i.status)}>{i.status}</span></td>
                      <td>{i.poNumber || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(isProduction || isAdmin) && (
        <>
          <Section title="Production — Additional requirements, Quality inspections, Material readiness">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <StatCard label="Sales Orders open" value={dash.production.salesOrders} onClick={() => navigate('/sales-order')} />
              <StatCard label="Additional material requests" value={dash.production.additionalRequests} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Indents awaiting clarification" value={dash.production.pendingClarifications} tone="warn" onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Materials awaiting quality check" value={dash.production.awaitingQC} tone="warn" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Inspections in progress" value={dash.production.underInspection} onClick={() => navigate('/quality-checks')} />
              <StatCard label="Rejected materials" value={dash.production.rejectedMaterials} tone="danger" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Approved materials" value={dash.production.approvedMaterials} tone="success" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Materials available for production" value={dash.production.materialsAvailable} tone="success" />
            </div>
          </Section>

          <Section title="Quality inspection queue (awaiting check)">
            <QueueTable
              navigate={navigate}
              actionRoute="/quality-checks"
              stateKey="reference"
              columns={['Source', 'Reference', 'PO', 'Project ID', 'SO', 'Indent', 'Vendor', 'Quantity', 'Status']}
              rows={toRows(dash.quality.awaitingCheck, 'reference', {
                Source: 'source',
                Reference: 'reference',
                PO: 'poNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                Indent: 'indentNumber',
                Vendor: 'vendor',
                Quantity: 'quantity',
                Status: 'status'
              })}
              empty="No material is awaiting inspection."
            />
          </Section>

          <Section title="Quality inspection results">
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr><th>QC No</th><th>Date</th><th>Project ID</th><th>Receipt / Indent</th><th>PO</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {qcs.length === 0 ? (
                    <tr><td colSpan="6" className="no-history-row">No quality inspections recorded yet.</td></tr>
                  ) : (
                    qcs.map((q) => (
                      <tr key={q.qcNumber}>
                        <td><strong>{q.qcNumber}</strong></td>
                        <td>{q.inspectionDate}</td>
                        <td>{q.projectId || '—'}</td>
                        <td>{q.receiptNumber || q.indentNumber || '—'}</td>
                        <td>{q.poNumber || '—'}</td>
                        <td><span className={badgeClass(q.status)}>{q.status}</span></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Sales Orders ready / pending for production">
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr><th>Sales Order</th><th>Customer</th><th>Material List</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {soStatus.length === 0 ? (
                    <tr><td colSpan="4" className="no-history-row">No sales orders.</td></tr>
                  ) : (
                    soStatus.map((so) => (
                      <tr key={so.reference}>
                        <td><strong>{so.reference}</strong></td>
                        <td>{so.company}</td>
                        <td>
                          {(so.material?.lines || []).map((l, idx) => (
                            <div key={idx} style={{ fontSize: '12px' }}>
                              {l.materialName}: required {l.required} · available {l.available} · received {l.received} · pending {l.pending}
                            </div>
                          ))}
                        </td>
                        <td><span className={badgeClass(so.material?.overallStatus)}>{so.material?.overallStatus}</span></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {!isStore && (
      <Section title="Document chain traceability (Project → SO → Indent → Enquiry → Quotation → PO → Receipt → QC)">
        <p style={{ margin: '0 0 12px', color: '#4b5563', fontSize: '13px' }}>
          Project ID is inherited automatically through every document. Rejected material re-enters procurement as a
          new indent/enquiry/quotation/PO so the original Purchase Order is never reopened.
        </p>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Project ID</th><th>SO</th><th>Indent</th><th>Enquiry</th><th>Quotation</th>
                <th>PO</th><th>Receipt</th><th>QC</th><th>Chain Status</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                if (chains.length === 0) {
                  return <tr><td colSpan="9" className="no-history-row">No document chain data yet.</td></tr>;
                }
                return chains.map((c) => (
                  <tr key={c.key}>
                    <td><strong>{c.projectId || '—'}</strong></td>
                    <td>{c.soNumber || '—'}</td>
                    <td>{c.indentNumber || '—'}</td>
                    <td>{c.enquiryNumber || '—'}</td>
                    <td>{c.quotationNumber || '—'}</td>
                    <td>{c.poNumber || '—'}</td>
                    <td>{c.receiptNumber || '—'}</td>
                    <td>{c.qcNumber || '—'}</td>
                    <td><span className={badgeClass(c.status)}>{c.status}</span></td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      </Section>

      )}
      <Section title="Recent workflow activity">
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr><th>Document</th><th>Reference</th><th>Status</th></tr>
            </thead>
            <tbody>
              {[
                ...receipts.slice(0, 5).map((r) => ({ type: 'Material Receipt', ref: r.receiptNumber, status: r.qcStatus || 'Pending Quality Check' })),
                ...qcs.slice(0, 5).map((q) => ({ type: 'Quality Check', ref: q.qcNumber, status: q.status })),
                ...rejections.slice(0, 5).map((r) => ({ type: 'Rejection Report', ref: r.rejectionNumber, status: r.status })),
                ...indents.slice(0, 5).map((i) => ({ type: 'Purchase Indent', ref: i.indentNumber, status: i.status }))
              ]
                .slice(0, 12)
                .map((row, idx) => (
                  <tr key={`${row.ref}-${idx}`}>
                    <td>{row.type}</td>
                    <td><strong>{row.ref}</strong></td>
                    <td><span className={badgeClass(row.status)}>{row.status}</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Section>
      </>}
    </section>
  );
};

export default WorkflowDashboardPage;
