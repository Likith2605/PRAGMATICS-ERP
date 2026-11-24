import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from '../utils/calculations.js';
import { amountInWords as wordsFor, convertToINR, CURRENCIES, getCurrency, isForeignCurrency, money, moneyPlain } from '../utils/currency.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import { getAllProjectsSummary, getFullProjectData } from '../utils/projectTracker.js';
import { pushNotification, appendAuditLog } from '../utils/storeService.js';
import { getSalesOrderMaterialStatus } from '../utils/workflowService.js';
import WorkflowNavigator from '../components/WorkflowNavigator.jsx';
import ProjectIdAutocomplete from '../components/ProjectIdAutocomplete.jsx';
import ReportRegister from '../components/ReportRegister.jsx';

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

const soValueINR = (row) => {
  const stored = Number(row?.amountINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const payloadCurrency = row?.payload?.soDetails?.currency || row?.currency || 'INR';
  if (payloadCurrency !== 'INR') return Number(row?.payload?.amountINR) || 0;
  return parseINR(row?.total);
};

const soValueCell = (row) => {
  const currency = row?.payload?.soDetails?.currency || row?.currency || 'INR';
  if (currency !== 'INR') return `${row?.total || ''}`;
  return soValueINR(row).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

const generateSONumber = () => {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const serial = Math.floor(100 + Math.random() * 900);
  return `SO-${year}${month}${day}-${serial}`;
};

const DEFAULT_UNITS = [
  'Nos', 'Set', 'Pair', 'Kit', 'Assembly', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Bundle'
];

const emptyItem = {
  itemCode: '',
  itemName: '',
  drawingNo: '',
  hsnSac: '',
  quantity: '',
  unit: 'Nos',
  unitPrice: '',
  gst: '18'
};

const SalesOrderPage = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [history, setHistory] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [reportTab, setReportTab] = useState('orders'); // 'orders' | 'open'

  // Form states
  const [soDetails, setSoDetails] = useState({
    soNumber: generateSONumber(),
    soDate: new Date().toISOString().slice(0, 10),
    deliveryDate: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
    quotationRef: '',
    customerPoNumber: '',
    customerPoDate: '',
    projectId: '',
    placeOfSupply: '',
    orderStatus: 'Confirmed',
    discount: '',
    currency: 'INR',
    exchangeRate: '',
    rateDate: '',
    rateAtConversion: '',
    taxMode: 'intra',
    notes: '',
    termsAndConditions: ''
  });

  const [customerDetails, setCustomerDetails] = useState({
    customerName: '',
    companyName: '',
    address: '',
    contactNumber: '',
    email: '',
    gstNumber: '',
    state: ''
  });

  const [companyDetails, setCompanyDetails] = useState(() => {
    try {
      const stored = localStorage.getItem('companySettings');
      if (stored) return JSON.parse(stored);
    } catch {}
    return {
      companyName: 'PRAGMATIC ENGINEERS',
      phone: '+91 9880030466',
      email: 'pragmatic.vasudev@gmail.com',
      address: 'NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083',
      gstin: '',
      state: 'Karnataka (29)'
    };
  });

  const [items, setItems] = useState([{ ...emptyItem }]);

  // Load history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('salesOrderHistory');
      setHistory(stored ? JSON.parse(stored) : []);
    } catch {
      setHistory([]);
    }
  }, []);

  const [projectSummaryList, setProjectSummaryList] = useState([]);
  const [projectAutoLinkMsg, setProjectAutoLinkMsg] = useState('');

  useEffect(() => {
    setProjectSummaryList(getAllProjectsSummary());
  }, []);

  const handleProjectLookup = (pid, directData) => {
    setSoDetails((prev) => ({ ...prev, projectId: pid }));
    if (!pid || !pid.trim()) {
      setProjectAutoLinkMsg('');
      return;
    }

    const data = directData || getFullProjectData(pid);
    if (data?.isLegacy) {
      setProjectAutoLinkMsg('⚠️ Historical archive record (Pre-ERP). Historical data is view-only and cannot be converted to a Sales Order.');
      return;
    }
    if (data && (data.customerDetails?.customerName || data.customerDetails?.companyName || (data.items && data.items.length > 0))) {
      if (data.customerDetails) {
        setCustomerDetails((prev) => ({
          ...prev,
          customerName: data.customerDetails.customerName || prev.customerName,
          companyName: data.customerDetails.companyName || prev.companyName,
          address: data.customerDetails.address || prev.address,
          contactNumber: data.customerDetails.contactNumber || prev.contactNumber,
          email: data.customerDetails.email || prev.email,
          gstNumber: data.customerDetails.gstNumber || prev.gstNumber
        }));
      }

      if (data.quotationRef && !soDetails.quotationRef) {
        setSoDetails((prev) => ({ ...prev, quotationRef: data.quotationRef }));
      }
      if (data.customerPoNumber && !soDetails.customerPoNumber) {
        setSoDetails((prev) => ({ ...prev, customerPoNumber: data.customerPoNumber }));
      }

      if (data.items && data.items.length > 0) {
        const isBlank = items.length === 1 && !items[0].itemName.trim();
        if (isBlank) {
          setItems(data.items);
        }
      }

      setProjectAutoLinkMsg(`✓ Linked to Project: ${pid} (${data.customerDetails?.companyName || data.customerDetails?.customerName || 'Matched'})`);
    } else {
      setProjectAutoLinkMsg('');
    }
  };

  // Handle incoming quotation conversion or edit
  useEffect(() => {
    if (location.state?.fromQuotation && location.state?.quotation) {
      const q = location.state.quotation;
      const soNum = location.state.soNumber || generateSONumber();
      
      setSoDetails({
        soNumber: soNum,
        soDate: new Date().toISOString().slice(0, 10),
        deliveryDate: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
        quotationRef: q.quotationDetails?.quotationNumber || '',
        customerPoNumber: '',
        customerPoDate: '',
        projectId: q.quotationDetails?.projectId || '',
        placeOfSupply: q.quotationDetails?.placeOfSupply || '',
        orderStatus: 'Confirmed',
        discount: q.quotationDetails?.discount || '',
        currency: q.quotationDetails?.currency || 'INR',
        exchangeRate: q.quotationDetails?.exchangeRate ?? '',
        rateDate: q.quotationDetails?.rateDate || '',
        rateAtConversion: q.quotationDetails?.exchangeRate ?? '',
        taxMode: q.quotationDetails?.taxMode || 'intra',
        notes: q.quotationDetails?.notes || '',
        termsAndConditions: q.quotationDetails?.termsAndConditions || q.termsAndConditions || ''
      });

      if (q.customerDetails) setCustomerDetails(q.customerDetails);
      if (q.companyDetails) setCompanyDetails(q.companyDetails);
      if (q.items && q.items.length > 0) setItems(q.items);

      setMode('create');
    } else if (location.state?.viewOrder) {
      setSelectedOrder(location.state.viewOrder);
      setMode('view');
    }
  }, [location.state]);

  const computedItems = useMemo(() => {
    return items.map((item) => {
      const quantity = Number(item.quantity) || 0;
      const unitPrice = Number(item.unitPrice) || 0;
      const gstPercent = Number(item.gst) || 0;
      const amount = calculateLineAmount(quantity, unitPrice);
      const gstAmount = calculateGSTAmount(amount, gstPercent);

      return {
        ...item,
        unit: item.unit || 'Nos',
        amount,
        gstAmount
      };
    });
  }, [items]);

  const currencyCode = soDetails.currency || 'INR';
  const taxMode = soDetails.taxMode || 'intra';

  const totals = useMemo(
    () => calculateTotals(computedItems, soDetails.discount, taxMode),
    [computedItems, soDetails.discount, taxMode]
  );
  const amountInWords = useMemo(() => wordsFor(totals.grandTotal, currencyCode), [totals.grandTotal, currencyCode]);
  const totalINR = convertToINR(totals.grandTotal, currencyCode, soDetails.exchangeRate);

  const viewCurrency = selectedOrder?.soDetails?.currency || 'INR';
  const viewTaxMode = selectedOrder?.soDetails?.taxMode || 'intra';
  const viewMoney = (value) => {
    const amount = Number(value || 0);
    if (isForeignCurrency(viewCurrency)) return `${viewCurrency} ${moneyPlain(amount, viewCurrency)}`;
    return amount.toFixed(2);
  };
  const viewWords = selectedOrder?.amountInWords || wordsFor(selectedOrder?.totals?.grandTotal || 0, viewCurrency);

  const handleFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveOrder = (e) => {
    e.preventDefault();
    if (!customerDetails.customerName.trim()) {
      alert('Please provide Customer Name.');
      return;
    }

    if (isForeignCurrency(currencyCode) && !(Number(soDetails.exchangeRate) > 0)) {
      alert(`Exchange rate (1 ${currencyCode} to INR) is required before saving a non-INR Sales Order.`);
      return;
    }

    const payload = {
      soDetails,
      customerDetails,
      companyDetails,
      items: computedItems,
      totals,
      amountInWords,
      amountINR: totalINR,
      currency: currencyCode
    };

    try {
      const stored = localStorage.getItem('salesOrderHistory');
      let current = stored ? JSON.parse(stored) : [];
      const entry = {
        date: soDetails.soDate,
        reference: soDetails.soNumber,
        quotationRef: soDetails.quotationRef || '-',
        company: customerDetails.companyName || customerDetails.customerName || '-',
        total: money(totals.grandTotal, currencyCode),
        currency: currencyCode,
        amountINR: totalINR,
        status: soDetails.orderStatus || 'Confirmed',
        payload
      };

      const existingIndex = current.findIndex((h) => h.reference === entry.reference);
      const isNew = existingIndex === -1;
      if (existingIndex !== -1) {
        current[existingIndex] = entry;
      } else {
        current.unshift(entry);
      }
      localStorage.setItem('salesOrderHistory', JSON.stringify(current));
      setHistory(current);
      setSelectedOrder(payload);
      setMode('view');

      if (isNew) {
        appendAuditLog({
          action: 'SALES ORDER CREATED',
          reference: soDetails.soNumber,
          details: `Customer: ${customerDetails.companyName || customerDetails.customerName || '-'} | Materials: ${computedItems.length}`
        });
        pushNotification({
          title: 'New Sales Order — item requirement list needed',
          message: `Sales Order ${soDetails.soNumber} (${customerDetails.companyName || customerDetails.customerName || '-'}) has been submitted. Production to create the Required Item List and submit it to Store for stock review.`,
          type: 'info',
          reference: soDetails.soNumber,
          targetDept: 'Production Department',
          link: '/production/item-requirements'
        });
      }
    } catch (err) {
      console.error('Failed to save sales order', err);
    }
  };

  const handlePrintPDF = () => {
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!selectedOrder) return;
    try {
      const pdfPayload = {
        ...selectedOrder,
        documentTitle: 'Sales Order',
        forTitle: 'Customer Information:',
        detailsTitle: 'Sales Order Details:',
        documentDetails: [
          { label: 'SO No', value: selectedOrder.soDetails?.soNumber || '-' },
          { label: 'Date', value: selectedOrder.soDetails?.soDate || '-' },
          { label: 'Target Delivery', value: selectedOrder.soDetails?.deliveryDate || '-' },
          { label: 'Quotation Ref', value: selectedOrder.soDetails?.quotationRef || '-' },
          { label: 'Project ID', value: selectedOrder.soDetails?.projectId || '-' },
          { label: 'Status', value: selectedOrder.soDetails?.orderStatus || 'Confirmed' }
        ],
        quotationDetails: {
          quotationNumber: selectedOrder.soDetails?.soNumber,
          quotationDate: selectedOrder.soDetails?.soDate,
          placeOfSupply: selectedOrder.customerDetails?.state || '',
          projectId: selectedOrder.soDetails?.projectId,
          termsAndConditions: selectedOrder.soDetails?.termsAndConditions,
          notes: selectedOrder.soDetails?.notes
        }
      };
      await generateQuotationPDF(pdfPayload);
    } catch {
      alert('Error generating PDF.');
    }
  };

  const handleSendToProduction = (so) => {
    navigate('/production', {
      state: {
        fromSalesOrder: true,
        salesOrder: so
      }
    });
  };

  const handleCreateDeliveryChallan = (so) => {
    navigate('/delivery-challan', {
      state: {
        fromSalesOrder: true,
        salesOrder: so
      }
    });
  };

  const handleGenerateInvoice = (so) => {
    navigate('/customer-invoice', {
      state: {
        fromSalesOrder: true,
        salesOrder: so
      }
    });
  };

  /* Same connection as "Generate Tax Invoice" — opens the Export Invoice
     (Invoice cum Packing List) pre-filled from this Sales Order. */
  const handleGenerateExportInvoice = (so) => {
    navigate('/export-invoice', {
      state: {
        fromSalesOrder: true,
        salesOrder: so
      }
    });
  };

  const handlePurchaseRawMaterial = (so) => {
    navigate('/purchase-order', {
      state: {
        fromSalesOrder: true,
        salesOrder: so
      }
    });
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">Sales Management</p>
          <h1>
            {mode === 'create'
              ? 'Create Sales Order'
              : mode === 'view'
              ? `Sales Order: ${selectedOrder?.soDetails?.soNumber || ''}`
              : 'Sales Orders'}
          </h1>
          {mode === 'list' && (
            <p className="page-description">Manage confirmed sales orders, production schedules, and dispatch status.</p>
          )}
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to Sales Orders
            </button>
          ) : (
            <button
              className="button-primary"
              onClick={() => {
                setSoDetails({
                  soNumber: generateSONumber(),
                  soDate: new Date().toISOString().slice(0, 10),
                  deliveryDate: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
                  quotationRef: '',
                  customerPoNumber: '',
                  customerPoDate: '',
                  projectId: '',
                  placeOfSupply: '',
                  orderStatus: 'Confirmed',
                  discount: '',
                  currency: 'INR',
                  exchangeRate: '',
                  rateDate: '',
                  rateAtConversion: '',
                  taxMode: 'intra',
                  notes: '',
                  termsAndConditions: ''
                });
                setItems([{ ...emptyItem }]);
                setMode('create');
              }}
            >
              + Create Sales Order
            </button>
          )}
        </div>
      </div>

      {(mode !== 'list' || selectedOrder?.soDetails?.projectId || soDetails?.projectId) && (
        <WorkflowNavigator
          projectId={selectedOrder?.soDetails?.projectId || soDetails?.projectId}
          currentStage="salesOrder"
        />
      )}

      <div className="content-block">
        {mode === 'list' && (
          <>
            <div className="tab-nav report-tabs">
              <button type="button" className={`tab-link ${reportTab === 'orders' ? 'active' : ''}`} onClick={() => setReportTab('orders')}>
                Sales Orders
              </button>
              <button type="button" className={`tab-link ${reportTab === 'open' ? 'active' : ''}`} onClick={() => setReportTab('open')}>
                Open SO Report
              </button>
            </div>

            {reportTab === 'orders' && (
            <>
            <div className="block-header">
              <h2>Sales Order History</h2>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>SO Number</th>
                    <th>Quotation Ref</th>
                    <th>Customer / Company</th>
                    <th>Total Amount</th>
                    <th>Order Status</th>
                    <th>Material Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length > 0 ? (
                    history.map((so, idx) => (
                      <tr key={idx}>
                        <td>{so.date}</td>
                        <td><strong>{so.reference}</strong></td>
                        <td>{so.quotationRef || '-'}</td>
                        <td>{so.company}</td>
                        <td>{so.total}</td>
                        <td>
                          <span
                            style={{
                              padding: '4px 10px',
                              borderRadius: '20px',
                              fontSize: '12px',
                              fontWeight: '600',
                              background:
                                so.status === 'Dispatched'
                                  ? '#dcfce7'
                                  : so.status === 'In Production'
                                  ? '#fef3c7'
                                  : '#e0e7ff',
                              color:
                                so.status === 'Dispatched'
                                  ? '#166534'
                                  : so.status === 'In Production'
                                  ? '#92400e'
                                  : '#3730a3'
                            }}
                          >
                            {so.status}
                          </span>
                        </td>
                        <td>
                          {(() => {
                            const mat = getSalesOrderMaterialStatus(so.reference);
                            if (!mat) return <span style={{ color: '#94a3b8' }}>—</span>;
                            const complete = mat.overallStatus === 'COMPLETED';
                            return (
                              <span
                                style={{
                                  padding: '4px 10px',
                                  borderRadius: '20px',
                                  fontSize: '12px',
                                  fontWeight: '600',
                                  background: complete ? '#dcfce7' : mat.checked ? '#fef3c7' : '#f1f5f9',
                                  color: complete ? '#166534' : mat.checked ? '#92400e' : '#475569'
                                }}
                                title={mat.lines.map((l) => `${l.materialName}: req ${l.required} | avail ${l.available} | recv ${l.received} | pend ${l.pending}`).join('\n')}
                              >
                                {complete ? 'COMPLETED' : mat.checked ? 'MATERIALS PENDING' : 'AWAITING CHECK'}
                              </span>
                            );
                          })()}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <button
                              className="button-small"
                              onClick={() => {
                                setSelectedOrder(so.payload);
                                setMode('view');
                              }}
                            >
                              View
                            </button>
                            <select
                              className="action-select"
                              defaultValue=""
                              onChange={(e) => {
                                const act = e.target.value;
                                if (act === 'edit') {
                                  const p = so.payload;
                                  setSoDetails(p.soDetails);
                                  setCustomerDetails(p.customerDetails);
                                  setCompanyDetails(p.companyDetails);
                                  setItems(p.items);
                                  setMode('create');
                                } else if (act === 'production') {
                                  handleSendToProduction(so.payload);
                                } else if (act === 'challan') {
                                  handleCreateDeliveryChallan(so.payload);
                                } else if (act === 'invoice') {
                                  handleGenerateInvoice(so.payload);
                                } else if (act === 'export_invoice') {
                                  handleGenerateExportInvoice(so.payload);
                                } else if (act === 'po') {
                                  handlePurchaseRawMaterial(so.payload);
                                }
                                e.target.value = '';
                              }}
                            >
                              <option value="" disabled>Workflow Actions ▼</option>
                              <option value="production">🏭 Send to Production</option>
                              <option value="challan">🚚 Create Delivery Challan</option>
                              <option value="invoice">🧾 Generate Tax Invoice</option>
                              <option value="export_invoice">🌐 Generate Export Invoice</option>
                              <option value="po">🛒 Buy Raw Materials (PO)</option>
                              <option value="edit">✏️ Edit Order</option>
                            </select>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="8" className="no-history-row">
                        No Sales Orders yet. Convert a Quotation or click "+ Create Sales Order".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            </>
            )}

            {reportTab === 'open' && (
              <ReportRegister
                title="Open SO Report"
                subTitle="Sales orders not yet fully dispatched / closed"
                filename={`Open-SO-${new Date().toISOString().slice(0, 10)}`}
                dateField="date"
                columns={[
                  { key: 'date', label: 'SO Date' },
                  { key: 'reference', label: 'SO No' },
                  { key: 'quotationRef', label: 'Quotation Ref', render: (r) => r.quotationRef || '-' },
                  { key: 'company', label: 'Customer / Company' },
                  { key: 'amount', label: 'Order Value (INR)', align: 'right', render: soValueCell },
                  { key: 'status', label: 'Order Status' }
                ]}
                rows={history.filter((r) => !['Dispatched', 'Closed'].includes(r.status))}
                totals={[
                  { colKey: 'amount', render: (rs) => rs.reduce((a, r) => a + soValueINR(r), 0) }
                ]}
              />
            )}
          </>
        )}

        {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSaveOrder}>
            <div className="form-section">
              <div className="section-heading">
                <h3>Sales Order Meta Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Sales Order No.</label>
                  <input
                    type="text"
                    value={soDetails.soNumber}
                    onChange={(e) => setSoDetails({ ...soDetails, soNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Quotation Ref</label>
                  <input
                    type="text"
                    value={soDetails.quotationRef}
                    placeholder="e.g. QT-260829-101"
                    onChange={(e) => setSoDetails({ ...soDetails, quotationRef: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Order Date</label>
                  <input
                    type="date"
                    value={soDetails.soDate}
                    onChange={(e) => setSoDetails({ ...soDetails, soDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Target Delivery Date</label>
                  <input
                    type="date"
                    value={soDetails.deliveryDate}
                    onChange={(e) => setSoDetails({ ...soDetails, deliveryDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Project ID (Master Auto-link)</label>
                  <ProjectIdAutocomplete
                    value={soDetails.projectId}
                    onChange={(val) => setSoDetails((prev) => ({ ...prev, projectId: val }))}
                    onSelectProject={(pid, fullData) => handleProjectLookup(pid, fullData)}
                    placeholder="Search or select Project ID (e.g. PE-2627-0001)..."
                    autoLinkMsg={projectAutoLinkMsg}
                  />
                </div>
                <div className="field-group">
                  <label>Order Status</label>
                  <select
                    value={soDetails.orderStatus}
                    onChange={(e) => setSoDetails({ ...soDetails, orderStatus: e.target.value })}
                  >
                    <option value="Confirmed">Confirmed</option>
                    <option value="In Production">In Production</option>
                    <option value="Ready for Dispatch">Ready for Dispatch</option>
                    <option value="Dispatched">Dispatched</option>
                    <option value="Closed">Closed</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>Currency</label>
                  <select
                    value={currencyCode}
                    onChange={(e) => setSoDetails({ ...soDetails, currency: e.target.value })}
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency.code} value={currency.code}>
                        {currency.label}
                      </option>
                    ))}
                  </select>
                </div>
                {isForeignCurrency(currencyCode) && (
                  <div className="field-group">
                    <label>Exchange Rate (1 {currencyCode} to INR) *</label>
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={soDetails.exchangeRate}
                      onChange={(e) => setSoDetails({ ...soDetails, exchangeRate: e.target.value })}
                      placeholder="e.g. 83.4500"
                    />
                  </div>
                )}
                <div className="field-group">
                  <label>Tax Treatment</label>
                  <select
                    value={taxMode}
                    onChange={(e) => setSoDetails({ ...soDetails, taxMode: e.target.value })}
                  >
                    <option value="intra">CGST + SGST (within state)</option>
                    <option value="inter">IGST (inter-state)</option>
                    <option value="export">Export / LUT - zero rated</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Customer Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Customer Name *</label>
                  <input
                    type="text"
                    value={customerDetails.customerName}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, customerName: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Company Name</label>
                  <input
                    type="text"
                    value={customerDetails.companyName}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, companyName: e.target.value })}
                  />
                </div>
                <div className="field-group full-width">
                  <label>Address</label>
                  <textarea
                    rows="3"
                    style={{
                      minHeight: '72px',
                      lineHeight: '1.45',
                      fontSize: '13.5px',
                      padding: '8px 12px',
                      resize: 'vertical',
                      width: '100%',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      fontFamily: 'inherit'
                    }}
                    value={customerDetails.address}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, address: e.target.value })}
                    placeholder="Complete company / plant delivery address"
                  />
                </div>
                <div className="field-group">
                  <label>Contact Number</label>
                  <input
                    type="text"
                    value={customerDetails.contactNumber}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, contactNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>GST Number</label>
                  <input
                    type="text"
                    value={customerDetails.gstNumber}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, gstNumber: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Ordered Items</h3>
              </div>
              <div className="item-table-wrapper">
                <table className="item-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>SL.No</th>
                      <th style={{ width: '260px' }}>Item Description</th>
                      <th style={{ width: '140px' }}>Drawing No.</th>
                      <th style={{ width: '110px' }}>HSN/SAC</th>
                      <th style={{ width: '90px' }}>Qty</th>
                      <th style={{ width: '110px' }}>Unit</th>
                      <th style={{ width: '125px' }}>Price</th>
                      <th style={{ width: '85px' }}>GST%</th>
                      <th style={{ width: '140px' }}>Amount</th>
                      <th className="action-column">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computedItems.map((item, idx) => (
                      <tr key={idx} className="item-row">
                        <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{idx + 1}</td>
                        <td>
                          <input
                            type="text"
                            value={item.itemName || ''}
                            onChange={(e) => handleFieldChange(idx, 'itemName', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={item.drawingNo || ''}
                            onChange={(e) => handleFieldChange(idx, 'drawingNo', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={item.hsnSac || ''}
                            onChange={(e) => handleFieldChange(idx, 'hsnSac', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={item.quantity || ''}
                            onChange={(e) => handleFieldChange(idx, 'quantity', e.target.value)}
                          />
                        </td>
                        <td>
                          <select
                            value={item.unit || 'Nos'}
                            onChange={(e) => handleFieldChange(idx, 'unit', e.target.value)}
                          >
                            {DEFAULT_UNITS.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            value={item.unitPrice || ''}
                            onChange={(e) => handleFieldChange(idx, 'unitPrice', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={item.gst || ''}
                            onChange={(e) => handleFieldChange(idx, 'gst', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            readOnly
                            value={item.amount ? item.amount.toFixed(2) : '0.00'}
                            style={{ background: '#e5e7eb', cursor: 'not-allowed' }}
                          />
                        </td>
                        <td className="action-column">
                          <button
                            type="button"
                            className="button-secondary button-small button-delete"
                            onClick={() => setItems(items.filter((_, i) => i !== idx))}
                            disabled={items.length === 1}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={10}>
                        <button
                          type="button"
                          className="button-secondary button-small"
                          onClick={() => setItems([...items, { ...emptyItem }])}
                        >
                          + Add Item
                        </button>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="tax-summary">
                <div className="tax-summary-row">
                  <span>Subtotal ({currencyCode})</span>
                  <strong>{money(totals.subtotal, currencyCode)}</strong>
                </div>
                <div className="tax-summary-row">
                  <span>Discount</span>
                  <div>
                    {getCurrency(currencyCode).symbol}{' '}
                    <input
                      type="number"
                      value={soDetails.discount}
                      onChange={(e) => setSoDetails({ ...soDetails, discount: e.target.value })}
                      placeholder="0.00"
                      className="discount-input"
                    />
                  </div>
                </div>
                <div className="tax-summary-row">
                  <span>Taxable Amount</span>
                  <strong>{money(totals.taxableAmount, currencyCode)}</strong>
                </div>
                <div className="tax-summary-row">
                  <span>{taxMode === 'inter' ? 'IGST' : taxMode === 'export' ? 'GST (zero rated)' : 'Total GST'}</span>
                  <strong>{money(taxMode === 'inter' ? totals.igst : totals.totalGST, currencyCode)}</strong>
                </div>
                <div className="tax-summary-row total">
                  <span>Grand Total</span>
                  <strong>{money(totals.grandTotal, currencyCode)}</strong>
                </div>
                {isForeignCurrency(currencyCode) && (
                  <div className="tax-summary-row">
                    <span>≈ Value in INR</span>
                    <strong>{money(totalINR, 'INR')}</strong>
                  </div>
                )}
                <div className="amount-in-words">
                  <span>Total Amount in Words</span>
                  <p>{amountInWords}</p>
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Terms & Notes</h3>
              </div>
              <div className="field-group full-width">
                <label>Terms and Conditions</label>
                <textarea
                  rows="3"
                  value={soDetails.termsAndConditions}
                  onChange={(e) => setSoDetails({ ...soDetails, termsAndConditions: e.target.value })}
                />
              </div>
              <div className="field-group full-width" style={{ marginTop: '16px' }}>
                <label>Notes</label>
                <textarea
                  rows="2"
                  value={soDetails.notes}
                  onChange={(e) => setSoDetails({ ...soDetails, notes: e.target.value })}
                />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setMode('list')}>
                Cancel
              </button>
              <button type="submit" className="button-primary">
                Save Sales Order
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedOrder && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end' }}>
              <button className="button-primary" onClick={handlePrintPDF}>
                Print Order
              </button>
              <button className="button-secondary" onClick={handleDownloadPDF}>
                Download PDF
              </button>
              <button
                className="button-secondary"
                onClick={() => {
                  setSoDetails(selectedOrder.soDetails);
                  setCustomerDetails(selectedOrder.customerDetails);
                  setCompanyDetails(selectedOrder.companyDetails);
                  setItems(selectedOrder.items);
                  setMode('create');
                }}
              >
                Edit Order
              </button>
            </div>

            <div className="doc-page-container">
              <div className="quotation-doc-sheet printable">
                <h1 className="doc-main-title">Sales Order</h1>

                {/* Company Header Box */}
                <div className="doc-company-box">
                    <div className="doc-company-left">
                      <div className="doc-company-name">PRAGMATIC ENGINEERS</div>
                      <div className="doc-company-details">
                        <div>NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083</div>
                        <div>GSTIN: 29AKWPP8736E1ZA</div>
                        <div>Phone: +91 9880030466</div>
                      </div>
                    </div>
                    <div className="doc-company-mid">
                      <div>Email: pragmatic.vasudev@gmail.com</div>
                      <div>State: Karnataka</div>
                    </div>
                    <div className="doc-company-logo">
                      <img src={logoUrl} alt="Company Logo" />
                    </div>
                  </div>

                  {/* Split Box */}
                <div className="doc-split-box">
                  <div className="doc-half-box">
                    <div className="doc-box-header">Customer Information:</div>
                    <div className="doc-box-body">
                      <div className="doc-customer-name">
                        {selectedOrder.customerDetails?.companyName || selectedOrder.customerDetails?.customerName || '-'}
                      </div>
                      {selectedOrder.customerDetails?.address && (
                        <div className="doc-customer-address">{selectedOrder.customerDetails.address}</div>
                      )}
                      <div className="doc-customer-inline">
                        {selectedOrder.customerDetails?.contactNumber && (
                          <div>Contact: {selectedOrder.customerDetails.contactNumber}</div>
                        )}
                        {selectedOrder.customerDetails?.state && (
                          <div>State: {selectedOrder.customerDetails.state}</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="doc-half-box doc-half-right">
                    <div className="doc-box-header">Sales Order Details:</div>
                    <div className="doc-box-body">
                      <div><strong>SO No:</strong> {selectedOrder.soDetails?.soNumber || '-'}</div>
                      <div><strong>Date:</strong> {selectedOrder.soDetails?.soDate || '-'}</div>
                      {selectedOrder.soDetails?.deliveryDate && (
                        <div><strong>Target Delivery:</strong> {selectedOrder.soDetails.deliveryDate}</div>
                      )}
                      {selectedOrder.soDetails?.quotationRef && (
                        <div><strong>Quotation Ref:</strong> {selectedOrder.soDetails.quotationRef}</div>
                      )}
                      {selectedOrder.soDetails?.projectId && (
                        <div><strong>Project ID:</strong> {selectedOrder.soDetails.projectId}</div>
                      )}
                      <div><strong>Status:</strong> {selectedOrder.soDetails?.orderStatus || 'Confirmed'}</div>
                      <div>
                        <strong>Currency:</strong> {viewCurrency}
                        {isForeignCurrency(viewCurrency) && selectedOrder.soDetails?.exchangeRate
                          ? ` (1 ${viewCurrency} = ${selectedOrder.soDetails.exchangeRate} INR)`
                          : ''}
                      </div>
                      <div>
                        <strong>Tax:</strong>{' '}
                        {viewTaxMode === 'inter'
                          ? 'IGST (inter-state)'
                          : viewTaxMode === 'export'
                          ? 'Export / LUT - zero rated'
                          : 'CGST + SGST'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Items Table */}
                <table className="doc-items-table">
                  <thead>
                    <tr>
                      <th className="th-slno">SL.No</th>
                      <th style={{ textAlign: 'left', width: '130px' }}>Drawing No.</th>
                      <th style={{ textAlign: 'left' }}>Item Description</th>
                      <th className="th-hsnSac">HSN/SAC</th>
                      <th className="th-quantity text-right">Qty</th>
                      <th className="th-unit text-center">Unit</th>
                      <th className="th-unitPrice text-right">Price</th>
                      <th className="th-gst text-right">GST%</th>
                      <th className="th-amount text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.items?.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-center">{idx + 1}</td>
                        <td className="text-left">{item.drawingNo || '-'}</td>
                        <td className="text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                        </td>
                        <td className="text-left">{item.hsnSac || '-'}</td>
                        <td className="text-right">{item.quantity || 0}</td>
                        <td className="text-center">{item.unit || 'Nos'}</td>
                        <td className="text-right">{viewMoney(item.unitPrice)}</td>
                        <td className="text-right">{item.gst ? `${item.gst}%` : '0%'}</td>
                        <td className="text-right">{viewMoney(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="doc-total-row">
                      <td colSpan={4} className="font-bold text-left">Total</td>
                      <td className="font-bold text-right">
                        {selectedOrder.items?.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
                      </td>
                      <td></td>
                      <td></td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedOrder.totals?.totalGST)}
                      </td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedOrder.totals?.subtotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                {/* Side-by-Side: Amount In Words (Left) & Summary Table (Right) */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '0px', marginTop: '14px', marginBottom: '14px' }}>
                    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '14px', paddingRight: '14px' }}>
                      <div className="doc-full-box" style={{ margin: 0, border: '1px solid #000', minHeight: '60px', flex: 'auto', boxSizing: 'border-box' }}>
                        <div className="doc-box-title">Total Amount In Words:</div>
                        <div className="doc-box-text" style={{ fontWeight: '500', marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                          {viewWords}
                        </div>
                      </div>
                      <div className="doc-full-box" style={{ margin: 0, border: '1px solid #000', minHeight: '60px', flex: 'auto', boxSizing: 'border-box' }}>
                          <div className="doc-box-title">Notes</div>
                        <div className="doc-box-text" style={{ marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                          {selectedOrder?.soDetails?.notes || '-'}
                        </div>
                      </div>
                    </div>

                  <table
                    style={{
                      width: '280px',
                      flexShrink: 0,
                      borderCollapse: 'collapse',
                      border: '1.5px solid #0f172a',
                      fontSize: '12px',
                      color: '#0f172a'
                    }}
                  >
                    <tbody>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Subtotal</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedOrder.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Taxable</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedOrder.totals?.taxableAmount || selectedOrder.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax rate</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {selectedOrder.items?.find(i => Number(i.gst) > 0)?.gst ? `${selectedOrder.items.find(i => Number(i.gst) > 0).gst}%` : (selectedOrder.items?.[0]?.gst ? `${selectedOrder.items[0].gst}%` : '0%')}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax Amount</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedOrder.totals?.totalGST)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1.5px solid #0f172a', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Other</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedOrder.totals?.otherCharges)}
                        </td>
                      </tr>
                      <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                        <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>
                          {viewMoney(selectedOrder.totals?.grandTotal)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Notes */}
                {selectedOrder.soDetails?.notes && (
                  <div className="doc-full-box">
                    <div className="doc-box-title">Notes:</div>
                    <div className="doc-box-text">{selectedOrder.soDetails.notes}</div>
                  </div>
                )}

                {/* Terms and Signatory */}
                <div className="doc-bottom-split">
                  <div className="doc-terms-box">
                    <div className="doc-box-title">Terms & Conditions:</div>
                    <div className="doc-terms-list">
                      {selectedOrder.soDetails?.termsAndConditions ? (
                        selectedOrder.soDetails.termsAndConditions.split(/\r?\n/).map((t, idx) => (
                          <div key={idx} className="doc-term-item">{t}</div>
                        ))
                      ) : (
                        <div className="doc-term-item">Standard delivery and order acceptance terms apply.</div>
                      )}
                    </div>
                  </div>

                  <div className="doc-sign-box">
                    <div className="doc-sign-company">For PRAGMATIC ENGINEERS</div>
                    <div className="doc-sign-space"></div>
                    <div className="doc-sign-line"></div>
                  </div>
                </div>

                {/* Footer */}
                <div className="doc-sheet-footer">
                  <span>This is a computer generated Sales Order.</span>
                  <span>Page 1 of 1</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SalesOrderPage;

