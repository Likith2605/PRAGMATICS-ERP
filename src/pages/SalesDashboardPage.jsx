import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ClipboardCheck, FileCheck2, FileClock, FilePlus2,
  FileText, ReceiptText, RefreshCw, Truck
} from 'lucide-react';
import { hasAnyPermission } from '../utils/permissions.js';
import { convertToINR } from '../utils/currency.js';
import { invReceivableINR } from '../utils/invoiceValues.js';
import { listQuotations } from '../services/quotationApi.js';
import { getCustomerPurchaseOrders } from '../services/customerPurchaseOrderApi.js';
import { listSalesOrders } from '../services/salesOrderApi.js';
import { listCustomerInvoices } from '../services/customerInvoiceApi.js';
import { listDeliveryChallans } from '../services/deliveryChallanApi.js';
import './sales-dashboard.css';

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
const getCustomer = (record) => record.company || record.payload?.customerDetails?.companyName || record.payload?.customerDetails?.customerName || '—';
const getDate = (record, fallback = '') => record.date || fallback || '—';
const getStatusClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

const MetricCard = ({ icon: Icon, label, value, note, onClick }) => {
  const handleKeyDown = (event) => {
    if (!onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onClick();
  };
  return (
    <div className={`sales-metric${onClick ? ' is-clickable' : ''}`} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={handleKeyDown}>
      <div className="sales-metric-heading"><span>{label}</span><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></div>
      <div className="sales-metric-value">{value}</div>
      <div className="sales-metric-note">{note}</div>
    </div>
  );
};

const SalesDashboardPage = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [quotations, setQuotations] = useState([]);
  const [customerPOs, setCustomerPOs] = useState([]);
  const [salesOrders, setSalesOrders] = useState([]);
  const [customerInvoices, setCustomerInvoices] = useState([]);
  const [deliveryChallans, setDeliveryChallans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    Promise.all([
      listQuotations(),
      getCustomerPurchaseOrders(),
      listSalesOrders(),
      listCustomerInvoices(),
      listDeliveryChallans()
    ]).then(([qList, poList, soList, invList, dcList]) => {
      if (!active) return;
      setQuotations(Array.isArray(qList) ? qList : []);
      setCustomerPOs(Array.isArray(poList) ? poList : []);
      setSalesOrders(Array.isArray(soList) ? soList : []);
      setCustomerInvoices(Array.isArray(invList) ? invList : []);
      setDeliveryChallans(Array.isArray(dcList) ? dcList : []);
    }).catch((error) => {
      if (!active) return;
      setQuotations([]);
      setCustomerPOs([]);
      setSalesOrders([]);
      setCustomerInvoices([]);
      setDeliveryChallans([]);
      setLoadError(`Sales dashboard data could not be loaded from PostgreSQL: ${error.message}`);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const kpis = useMemo(() => {
    const invoicedSales = customerInvoices.reduce((sum, invoice) => sum + payloadINR(invoice.payload), 0);
    const receivables = customerInvoices.reduce((sum, invoice) => sum + invReceivableINR(invoice), 0);
    const quotationValue = quotations.reduce((sum, quotation) => sum + payloadINR(quotation.payload), 0);
    const openOrders = salesOrders.filter((order) => order.status !== 'Closed');
    return { invoicedSales, receivables, quotationValue, openOrders: openOrders.length };
  }, [quotations, salesOrders, customerInvoices]);

  const pendingQuotations = useMemo(
    () => quotations.filter((quotation) => (quotation.balanceStatus || 'Active') === 'Pending'),
    [quotations]
  );

  const recentTransactions = useMemo(() => {
    const rows = [
      ...quotations.map((record) => ({ type: 'Quotation', reference: record.reference, customer: getCustomer(record), date: getDate(record, record.payload?.quotationDetails?.quotationDate), amount: record.total || '—', status: record.balanceStatus || 'Active', path: '/quotation/preview', state: { quotation: record.payload }, key: `quotation-${record.reference}` })),
      ...customerPOs.map((record) => ({ type: 'Customer PO', reference: record.reference, customer: getCustomer(record), date: getDate(record, record.payload?.poDetails?.customerPoDate), amount: record.total || '—', status: record.status || 'Received', path: '/customer-purchase-order', state: { viewPO: record.payload }, key: `customer-po-${record.reference}` })),
      ...salesOrders.map((record) => ({ type: 'Sales order', reference: record.reference, customer: getCustomer(record), date: getDate(record, record.payload?.soDetails?.soDate), amount: record.total || '—', status: record.status || 'Open', path: '/sales-order', state: { viewOrder: record.payload }, key: `sales-order-${record.reference}` })),
      ...customerInvoices.map((record) => ({ type: 'Tax invoice', reference: record.reference, customer: getCustomer(record), date: getDate(record, record.payload?.invoiceDetails?.invoiceDate), amount: record.total || '—', status: '', path: '/customer-invoice', state: { viewInvoice: record.payload }, key: `invoice-${record.reference}` })),
      ...deliveryChallans.map((record) => ({ type: 'Delivery challan', reference: record.reference, customer: getCustomer(record), date: getDate(record, record.payload?.challanDetails?.challanDate || record.payload?.dcDetails?.challanDate), amount: '—', status: record.status || 'Issued', path: '/delivery-challan', state: { viewChallan: record.payload }, key: `delivery-challan-${record.reference}` }))
    ];
    return rows.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 10);
  }, [quotations, customerPOs, salesOrders, customerInvoices, deliveryChallans]);

  const actions = [
    { label: 'New enquiry', icon: FilePlus2, path: '/project-request', permission: 'sales.enquiry', primary: true },
    { label: 'New quotation', icon: FileText, path: '/quotation', permission: 'sales.quotation' },
    { label: 'Record customer PO', icon: ReceiptText, path: '/customer-purchase-order', permission: 'sales.customer_order' },
    { label: 'Sales orders', icon: ClipboardCheck, path: '/sales-order', permission: 'sales_order.view' },
    { label: 'Customer invoices', icon: FileCheck2, path: '/customer-invoice', permission: 'invoice.view' },
    { label: 'Delivery challans', icon: Truck, path: '/delivery-challan', permission: 'delivery.view' }
  ].filter((action) => hasAnyPermission(action.permission));

  const openTransaction = (record) => navigate(record.path, { state: record.state });

  return (
    <div className="page-section sales-dashboard">
      <div className="page-header sales-dashboard-header">
        <div><h1>Sales Dashboard</h1></div>
        <button type="button" className="button-secondary sales-refresh" onClick={() => setRefreshKey((key) => key + 1)}><RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />Refresh</button>
      </div>

      {loading ? <div role="status" className="content-block">Loading dashboard data from PostgreSQL...</div>
        : loadError ? <div role="alert" className="form-error">{loadError}</div>
          : <>
      <section className="sales-kpi-section" aria-labelledby="sales-position-title">
        <div className="sales-section-heading"><div><h2 id="sales-position-title">Sales position</h2><p>Current totals from recorded transactions</p></div></div>
        <div className="sales-kpi-grid">
          <MetricCard icon={FileText} label="Quotation value" value={formatINR(kpis.quotationValue)} note={`${quotations.length} quotations on record`} onClick={() => navigate('/quotation')} />
          <MetricCard icon={ReceiptText} label="Customer purchase orders" value={customerPOs.length.toLocaleString('en-IN')} note="Customer commitments recorded" onClick={() => navigate('/customer-purchase-order')} />
          <MetricCard icon={ClipboardCheck} label="Sales orders in progress" value={kpis.openOrders.toLocaleString('en-IN')} note={`${salesOrders.length} confirmed orders on record`} onClick={() => navigate('/sales-order')} />
          <MetricCard icon={ArrowDownLeft} label="Invoiced sales" value={formatINR(kpis.invoicedSales)} note={`${customerInvoices.length} tax invoices billed`} onClick={() => navigate('/customer-invoice')} />
          <MetricCard icon={FileClock} label="Accounts receivable" value={formatINR(kpis.receivables)} note="Invoices not marked paid" onClick={() => navigate('/customer-invoice')} />
          <MetricCard icon={Truck} label="Delivery challans" value={deliveryChallans.length.toLocaleString('en-IN')} note="Dispatch documents on record" onClick={() => navigate('/delivery-challan')} />
        </div>
      </section>

      <section className="content-block sales-quotations" aria-labelledby="sales-pending-title">
        <div className="block-header sales-section-header"><div className="sales-section-title"><FileClock size={18} strokeWidth={1.75} aria-hidden="true" /><div><h2 id="sales-pending-title">Quotations requiring follow-up</h2><p>Quotations with pending status</p></div></div><span className="sales-count">{pendingQuotations.length} pending</span></div>
        <div className="history-table-wrapper"><table className="history-table sales-table">
          <thead><tr><th>Reference</th><th>Customer</th><th>Date</th><th>Value</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{pendingQuotations.length ? pendingQuotations.slice(0, 8).map((quotation) => <tr key={quotation.reference}>
            <td><strong>{quotation.reference || '—'}</strong></td><td>{getCustomer(quotation)}</td><td>{getDate(quotation, quotation.payload?.quotationDetails?.quotationDate)}</td><td>{quotation.total || '—'}</td><td><span className={getStatusClass(quotation.balanceStatus || 'Pending')}>{quotation.balanceStatus || 'Pending'}</span></td>
            <td><button type="button" className="button-small button-secondary" onClick={() => navigate('/quotation/preview', { state: { quotation: quotation.payload } })}>Open</button></td>
          </tr>) : <tr><td colSpan="6" className="no-history-row">No quotations are marked pending.</td></tr>}</tbody>
        </table></div>
      </section>

      <section className="content-block sales-recent" aria-labelledby="sales-recent-title">
        <div className="block-header sales-section-header"><div className="sales-section-title"><FileCheck2 size={18} strokeWidth={1.75} aria-hidden="true" /><div><h2 id="sales-recent-title">Recent sales transactions</h2><p>Latest customer documents and dispatch activity</p></div></div></div>
        <div className="history-table-wrapper"><table className="history-table sales-table">
          <thead><tr><th>Date</th><th>Document</th><th>Reference</th><th>Customer</th><th>Value</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{recentTransactions.length ? recentTransactions.map((record) => <tr key={record.key}>
            <td>{record.date}</td><td>{record.type}</td><td><strong>{record.reference || '—'}</strong></td><td>{record.customer}</td><td>{record.amount}</td><td><span className={getStatusClass(record.status)}>{record.status}</span></td>
            <td><button type="button" className="button-small button-secondary" onClick={() => openTransaction(record)}>Open</button></td>
          </tr>) : <tr><td colSpan="7" className="no-history-row">No sales transactions are available.</td></tr>}</tbody>
        </table></div>
      </section>

      {actions.length > 0 && <section className="content-block sales-actions" aria-labelledby="sales-actions-title">
        <div className="block-header sales-section-header"><div className="sales-section-title"><FilePlus2 size={18} strokeWidth={1.75} aria-hidden="true" /><div><h2 id="sales-actions-title">Sales actions</h2><p>Open a sales workflow</p></div></div></div>
        <div className="sales-action-grid">{actions.map(({ label, icon: Icon, path, primary }) => <button key={label} type="button" className={`${primary ? 'button-primary' : 'button-secondary'} sales-action`} onClick={() => navigate(path)}><Icon size={16} strokeWidth={1.75} aria-hidden="true" />{label}</button>)}</div>
      </section>}
      </>}
    </div>
  );
};

export default SalesDashboardPage;
