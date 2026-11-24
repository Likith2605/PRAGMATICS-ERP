import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, ArrowLeftRight, Boxes, ClipboardCheck, ClipboardList,
  FilePlus2, FileText, Gauge, HardHat, PackageCheck, PackageOpen, ReceiptText,
  ShoppingCart, Truck, Users, Wrench, Trash2
} from 'lucide-react';
import { hasPermission } from '../utils/permissions.js';
import { deletePurchaseIndent, INDENT_STATUS } from '../utils/workflowService.js';
import { convertToINR } from '../utils/currency.js';
import { invReceivableINR } from '../utils/invoiceValues.js';
import './dashboard.css';

const payloadINR = (payload) => {
  const grandTotal = Number(payload?.totals?.grandTotal) || 0;
  const stored = Number(payload?.amountINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const currency = payload?.invoiceDetails?.currency || payload?.quotationDetails?.currency || payload?.soDetails?.currency || payload?.poDetails?.currency || 'INR';
  if (currency === 'INR') return grandTotal;
  const rate = payload?.invoiceDetails?.exchangeRate ?? payload?.quotationDetails?.exchangeRate ?? payload?.soDetails?.exchangeRate ?? payload?.poDetails?.exchangeRate;
  return convertToINR(grandTotal, currency, rate);
};

const formatINR = (amount) => `₹ ${Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const DashboardMetric = ({ icon: Icon, label, value, note, tone = 'default', onClick }) => {
  const handleKeyDown = (event) => {
    if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onClick();
  };
  return (
    <div className={`dashboard-metric dashboard-metric--${tone}${onClick ? ' is-clickable' : ''}`} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={handleKeyDown}>
      <div className="dashboard-metric-top"><span className="dashboard-metric-label">{label}</span><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></div>
      <div className="dashboard-metric-value">{value}</div>
      <div className="dashboard-metric-note">{note}</div>
    </div>
  );
};

const InvoiceMonthlySummary = ({ invoices }) => {
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, index) => new Date(now.getFullYear(), now.getMonth() - 5 + index, 1));
  const values = new Map(months.map((month) => [`${month.getFullYear()}-${month.getMonth()}`, { amount: 0, count: 0 }]));
  invoices.forEach((invoice) => {
    const rawDate = invoice.date || invoice.payload?.invoiceDetails?.invoiceDate;
    if (!rawDate) return;
    const date = new Date(`${rawDate}T00:00:00`);
    if (!Number.isFinite(date.getTime())) return;
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    const month = values.get(key);
    if (month) {
      month.amount += payloadINR(invoice.payload);
      month.count += 1;
    }
  });
  const data = months.map((month) => ({
    label: month.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
    amount: values.get(`${month.getFullYear()}-${month.getMonth()}`).amount,
    count: values.get(`${month.getFullYear()}-${month.getMonth()}`).count
  }));
  const hasData = data.some((item) => item.count > 0);

  return (
    <section className="content-block dashboard-monthly-summary" aria-labelledby="dashboard-monthly-summary-title">
      <div className="block-header dashboard-monthly-header">
        <div><h2 id="dashboard-monthly-summary-title">Invoiced sales by month</h2><p>Recorded invoices for the last six months</p></div>
      </div>
      {hasData ? (
        <div className="history-table-wrapper"><table className="history-table dashboard-monthly-table">
          <thead><tr><th>Month</th><th>Invoices</th><th>Total invoiced</th></tr></thead>
          <tbody>{data.map((month) => <tr key={month.label}><td>{month.label}</td><td>{month.count}</td><td>{formatINR(month.amount)}</td></tr>)}</tbody>
        </table></div>
      ) : <p className="dashboard-monthly-empty">No invoice records in this period</p>}
    </section>
  );
};

const getEmployeeCount = () => {
  try {
    const raw = localStorage.getItem('employees');
    if (!raw) return 0;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((e) => e.active !== false).length : 0;
  } catch {
    return 0;
  }
};

const DashboardPage = () => {
  const navigate = useNavigate();
  const [showActiveQuotations, setShowActiveQuotations] = useState(false);

  const [quotations, setQuotations] = useState([]);
  const [customerPOs, setCustomerPOs] = useState([]);
  const [salesOrders, setSalesOrders] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [supplierInvoices, setSupplierInvoices] = useState([]);
  const [deliveryChallans, setDeliveryChallans] = useState([]);
  const [customerInvoices, setCustomerInvoices] = useState([]);
  const [materialRequests, setMaterialRequests] = useState([]);
  const [storeIssues, setStoreIssues] = useState([]);
  const [materialReturns, setMaterialReturns] = useState([]);
  const [stockTransactions, setStockTransactions] = useState([]);
  const [purchaseIndents, setPurchaseIndents] = useState([]);

  // Load all module data from localStorage
  useEffect(() => {
    try {
      const q = localStorage.getItem('quotationHistory');
      if (q) setQuotations(JSON.parse(q));

      const cpo = localStorage.getItem('customerPOHistory');
      if (cpo) setCustomerPOs(JSON.parse(cpo));

      const so = localStorage.getItem('salesOrderHistory');
      if (so) setSalesOrders(JSON.parse(so));

      const inv = localStorage.getItem('inventoryItems');
      if (inv) setInventoryItems(JSON.parse(inv));

      const sinv = localStorage.getItem('supplierInvoiceHistory');
      if (sinv) setSupplierInvoices(JSON.parse(sinv));

      const dc = localStorage.getItem('deliveryChallanHistory');
      if (dc) setDeliveryChallans(JSON.parse(dc));

      const cinv = localStorage.getItem('customerInvoiceHistory');
      if (cinv) setCustomerInvoices(JSON.parse(cinv));

      const mrs = localStorage.getItem('materialRequests');
      if (mrs) setMaterialRequests(JSON.parse(mrs));

      const sis = localStorage.getItem('storeIssueHistory');
      if (sis) setStoreIssues(JSON.parse(sis));

      const mrsRet = localStorage.getItem('materialReturnHistory');
      if (mrsRet) setMaterialReturns(JSON.parse(mrsRet));

      const stx = localStorage.getItem('stockTransactions');
      if (stx) setStockTransactions(JSON.parse(stx));

      const pins = localStorage.getItem('purchaseIndents');
      if (pins) setPurchaseIndents(JSON.parse(pins));
    } catch (err) {
      console.warn('Error loading dashboard stats', err);
    }
  }, []);

  // Aggregated Financial & Operational KPIs
  const kpis = useMemo(() => {
    // 1. Sales & Invoicing
    let totalInvoicedRevenue = 0;
    let customerPendingDues = 0;
    customerInvoices.forEach((inv) => {
      const total = payloadINR(inv.payload);
      totalInvoicedRevenue += total;
      customerPendingDues += invReceivableINR(inv);
    });

    // 2. Active Quotations Value
    let activeQuotationValue = 0;
    quotations.forEach((q) => {
      activeQuotationValue += payloadINR(q.payload);
    });

    // 3. Sales Orders in Progress
    const inProgressOrders = salesOrders.filter((s) => s.status !== 'Closed').length;

    // 4. Inventory Assets & Reorder alerts
    let totalInventoryValue = 0;
    let lowStockCount = 0;
    inventoryItems.forEach((it) => {
      const cur = Number(it.currentQty) || 0;
      const cost = Number(it.unitCost) || 0;
      const minLvl = Number(it.minReorderLevel) || 0;
      totalInventoryValue += cur * cost;
      if (cur <= minLvl) lowStockCount++;
    });

    // 5. Procurement & Accounts Payable
    let totalPurchases = 0;
    let accountsPayable = 0;
    supplierInvoices.forEach((sinv) => {
      const total = Number(sinv.payload?.totals?.grandTotal) || 0;
      const paid = Number(sinv.payload?.invoiceDetails?.amountPaid) || (sinv.status === 'Paid' ? total : 0);
      totalPurchases += total;
      if (sinv.status !== 'Paid') {
        accountsPayable += Math.max(0, total - paid);
      }
    });

    return {
      totalInvoicedRevenue,
      customerPendingDues,
      activeQuotationValue,
      totalQuotations: quotations.length,
      inProgressOrders,
      totalSalesOrders: salesOrders.length,
      totalInventoryValue,
      lowStockCount,
      totalPurchases,
      accountsPayable,
      totalDispatches: deliveryChallans.length
    };
  }, [quotations, customerInvoices, salesOrders, inventoryItems, supplierInvoices, deliveryChallans]);

  // Store & Materials Control KPIs (Material Requests / Issues / Returns)
  const storeKPIs = useMemo(() => {
    const pending = materialRequests.filter((m) => m.status === 'Pending Store' || m.status === 'Submitted').length;
    const partial = materialRequests.filter((m) => m.status === 'Partially Issued').length;
    const today = new Date().toISOString().slice(0, 10);
    const issuesToday = storeIssues.filter((i) => i.issueDate === today).length;
    const returnsToday = materialReturns.filter((r) => r.returnDate === today).length;
    const totalIssuedTodayUnits = stockTransactions
      .filter((t) => t.type === 'OUT' && t.transactionNumber && t.date === today)
      .reduce((a, t) => a + (Number(t.quantity) || 0), 0);
    return { pending, partial, issuesToday, returnsToday, totalIssuedTodayUnits };
  }, [materialRequests, storeIssues, materialReturns, stockTransactions]);

  // Recent Activity Pipeline (Latest 5 quotations / orders)
  const recentOrders = useMemo(() => {
    const list = [];
    salesOrders.forEach((so) => {
      list.push({
        type: 'Sales Order',
        reference: so.reference,
        party: so.company,
        date: so.date,
        amount: so.total,
        status: so.status,
        path: '/sales-order'
      });
    });
    quotations.forEach((q) => {
      list.push({
        type: 'Quotation',
        reference: q.reference,
        party: q.company,
        date: q.date,
        amount: q.total,
        status: q.balanceStatus || 'Active',
        path: '/quotation'
      });
    });
    return list.slice(0, 6);
  }, [salesOrders, quotations]);

  // Purchase Indents shared by Store that still need the Admin's approval.
  const canApproveIndent = hasPermission('indent.admin_approve');
  const canDeleteIndent = hasPermission('*');
  const indentsAwaitingApproval = useMemo(() => {
    const list = Array.isArray(purchaseIndents) ? purchaseIndents : [];
    return list.filter(
      (i) =>
        i.sourceType !== 'storeDirect' &&
        !i.adminApprovedAt &&
        [
          INDENT_STATUS.SUBMITTED,
          INDENT_STATUS.UNDER_REVIEW,
          INDENT_STATUS.AWAITING_PRODUCTION,
          INDENT_STATUS.PENDING_PURCHASE_ENQUIRY
        ].includes(i.status)
    );
  }, [purchaseIndents]);

  return (
    <div className="page-section dashboard-page">
      <div className="page-header dashboard-page-header"><div><h1>Executive Dashboard</h1></div></div>
      {canApproveIndent && <section className="content-block dashboard-approval" aria-labelledby="dashboard-approval-title">
        <div className="block-header dashboard-section-header"><div className="dashboard-section-title"><ClipboardCheck size={18} strokeWidth={1.75} aria-hidden="true" /><h2 id="dashboard-approval-title">Purchase indents awaiting approval</h2></div><span className="dashboard-count">{indentsAwaitingApproval.length} pending</span></div>
        {indentsAwaitingApproval.length === 0 ? <p className="dashboard-empty">No purchase indents are waiting for your approval.</p> : <div className="history-table-wrapper"><table className="history-table">
          <thead><tr><th>Indent no</th><th>Date</th><th>Sales order</th><th>Project ID</th><th>Customer</th><th>Materials</th><th>Shared by</th><th>Action</th></tr></thead>
          <tbody>{indentsAwaitingApproval.map((indent) => <tr key={indent.indentNumber}><td><strong>{indent.indentNumber}</strong></td><td>{indent.indentDate || '—'}</td><td>{indent.soNumber || '—'}</td><td>{indent.projectId || '—'}</td><td>{indent.customer || '—'}</td><td>{(indent.items || []).length}</td><td>{indent.createdBy || '—'}{indent.createdByDept ? ` (${indent.createdByDept})` : ''}</td><td><div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}><button className="button-primary button-small" onClick={() => navigate('/purchase-indents', { state: { openIndent: indent.indentNumber } })}>Open &amp; approve</button>{canDeleteIndent && <button className="button-secondary button-small button-delete" onClick={() => {
            if (!window.confirm(`Delete Purchase Indent ${indent.indentNumber}? This cannot be undone.`)) return;
            try {
              deletePurchaseIndent(indent.indentNumber);
              setPurchaseIndents((current) => current.filter((record) => String(record.indentNumber) !== String(indent.indentNumber)));
            } catch (error) {
              window.alert(error.message || 'Unable to delete this Purchase Indent.');
            }
          }}><Trash2 size={14} aria-hidden="true" /> Delete</button>}</div></td></tr>)}</tbody>
        </table></div>}
      </section>}

      <section className="dashboard-metric-section" aria-labelledby="dashboard-financial-title">
        <div className="dashboard-section-heading"><div><h2 id="dashboard-financial-title">Financial and order position</h2><p>Current totals across recorded transactions</p></div></div>
        <div className="dashboard-metric-grid">
          <DashboardMetric icon={ReceiptText} label="Invoiced sales" value={formatINR(kpis.totalInvoicedRevenue)} note={`${customerInvoices.length} tax invoices billed`} tone="sales-blue" />
          <DashboardMetric icon={ArrowLeftRight} label="Accounts receivable" value={formatINR(kpis.customerPendingDues)} note="Unsettled customer payments" tone="receivable-amber" />
          <DashboardMetric icon={ClipboardCheck} label="Orders in progress" value={`${kpis.inProgressOrders} orders`} note={`${kpis.totalSalesOrders} total confirmed orders`} tone="orders-purple" />
          <DashboardMetric icon={Boxes} label="Inventory valuation" value={formatINR(kpis.totalInventoryValue)} note={`${inventoryItems.length} materials and assemblies`} tone="inventory-teal" />
          <DashboardMetric icon={FileText} label="Quotation pipeline" value={formatINR(kpis.activeQuotationValue)} note={`${kpis.totalQuotations} active quotations`} tone="quotation-violet" onClick={() => setShowActiveQuotations((value) => !value)} />
          <DashboardMetric icon={ShoppingCart} label="Accounts payable" value={formatINR(kpis.accountsPayable)} note="Due to material suppliers" tone="payable-rose" />
          <DashboardMetric icon={Activity} label="Low stock alerts" value={`${kpis.lowStockCount} items`} note="Below safety reorder level" tone="stock-orange" onClick={() => navigate('/inventory')} />
          <DashboardMetric icon={Truck} label="Completed dispatches" value={`${kpis.totalDispatches} shipments`} note="Delivery challans issued" tone="dispatch-green" />
        </div>
      </section>

      <InvoiceMonthlySummary invoices={customerInvoices} />

      <section className="dashboard-metric-section" aria-labelledby="dashboard-store-title">
        <div className="dashboard-section-heading"><div><h2 id="dashboard-store-title">Store and materials</h2><p>Requests, issues, returns, and active staff</p></div></div>
        <div className="dashboard-metric-grid dashboard-metric-grid--store">
          <DashboardMetric icon={PackageOpen} label="Material requests pending" value={`${storeKPIs.pending} requests`} note={`${storeKPIs.partial} partially issued`} tone={storeKPIs.pending > 0 ? 'attention' : 'default'} onClick={() => navigate('/store/material-requests')} />
          <DashboardMetric icon={PackageCheck} label="Store issues today" value={`${storeKPIs.issuesToday} slips`} note={`${storeKPIs.totalIssuedTodayUnits} units issued today`} onClick={() => navigate('/store/issues')} />
          <DashboardMetric icon={ArrowLeftRight} label="Material returns today" value={`${storeKPIs.returnsToday} returns`} note="Auto re-added to stock" onClick={() => navigate('/store/returns')} />
          <DashboardMetric icon={Users} label="Employees on roll" value={`${getEmployeeCount()} people`} note="Verified issue recipients" onClick={() => navigate('/employees')} />
        </div>
      </section>

      <section className="content-block dashboard-actions" aria-labelledby="dashboard-actions-title">
        <div className="block-header dashboard-section-header"><div className="dashboard-section-title"><Gauge size={18} strokeWidth={1.75} aria-hidden="true" /><h2 id="dashboard-actions-title">Quick actions</h2></div></div>
        <div className="dashboard-action-grid">{[
          { label: 'New quotation', icon: FilePlus2, path: '/quotation', primary: true },
          { label: 'Record customer PO', icon: ReceiptText, path: '/customer-purchase-order' },
          { label: 'Create sales order', icon: ClipboardCheck, path: '/sales-order' },
          { label: 'Adjust inventory', icon: Boxes, path: '/inventory' },
          { label: 'Issue purchase order', icon: ShoppingCart, path: '/purchase-order' },
          { label: 'Dispatch challan', icon: Truck, path: '/delivery-challan' },
          { label: 'Create tax invoice', icon: ReceiptText, path: '/customer-invoice' },
          { label: 'New material request', icon: HardHat, path: '/production/material-requests' },
          { label: 'Process MR queue', icon: ClipboardList, path: '/store/material-requests' },
          { label: 'Record material return', icon: Wrench, path: '/store/returns' }
        ].map(({ label, icon: Icon, path, primary }) => <button key={label} className={`${primary ? 'button-primary' : 'button-secondary'} dashboard-action`} onClick={() => navigate(path)}><Icon size={16} strokeWidth={1.75} aria-hidden="true" />{label}</button>)}</div>
      </section>

      {showActiveQuotations && <section className="content-block dashboard-active-quotations" aria-labelledby="dashboard-quotations-title">
        <div className="block-header dashboard-section-header"><div className="dashboard-section-title"><FileText size={18} strokeWidth={1.75} aria-hidden="true" /><h2 id="dashboard-quotations-title">Active quotations</h2></div></div>
        <div className="history-table-wrapper"><table className="history-table"><thead><tr><th>Type</th><th>Reference</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>{recentOrders.filter((order) => order.type === 'Quotation' && order.status === 'Pending').length > 0 ? recentOrders.filter((order) => order.type === 'Quotation' && order.status === 'Pending').map((order, index) => <tr key={`${order.reference}-${index}`} tabIndex={0} onClick={() => navigate(order.path)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(order.path); } }}><td><span className="dashboard-type-tag">{order.type}</span></td><td><strong>{order.reference}</strong></td><td>{order.party}</td><td>{order.amount}</td><td><span className="dashboard-pending-status">{order.status}</span></td></tr>) : <tr><td colSpan="5" className="dashboard-empty-cell">No active quotations found.</td></tr>}</tbody>
        </table></div>
      </section>}
    </div>
  );
};

export default DashboardPage;
