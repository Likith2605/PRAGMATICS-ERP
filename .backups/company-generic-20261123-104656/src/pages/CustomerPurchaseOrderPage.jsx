import React, { useState, useEffect, useMemo } from 'react';
import AddableSelect from '../components/AddableSelect.jsx';
import { DEFAULT_UNITS } from '../utils/addableMasters.js';
import { useLocation, useNavigate } from 'react-router-dom';
import defaultLogoUrl from '../assets/logo.png';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from '../utils/calculations.js';
import { amountInWords as wordsFor, convertToINR, CURRENCIES, getCurrency, isForeignCurrency, money, moneyPlain } from '../utils/currency.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import { getAllProjectsSummary, getFullProjectData } from '../utils/projectTracker.js';
import WorkflowNavigator from '../components/WorkflowNavigator.jsx';
import ProjectIdAutocomplete from '../components/ProjectIdAutocomplete.jsx';
import { getNextSequentialNumber, saveDocSequence } from '../utils/sequenceGenerator.js';
import ExcelImportDialog from '../components/ExcelImportDialog.jsx';
import { importCustomerPurchaseOrders, getCustomerPurchaseOrders, getCustomerPurchaseOrder, createCustomerPurchaseOrder } from '../services/customerPurchaseOrderApi.js';
import { CUSTOMER_PO_EXCEL_COLUMNS, validateCustomerPOExcelRecord } from '../utils/customerPOExcelImport.js';
import { Upload } from 'lucide-react';
import { getFinancialYearInfo } from '../utils/financialYear.js';

const generateCustomerPONumber = () => {
  return getNextSequentialNumber('CPO', 'customerPOSequence', null, 'reference');
};

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

const CustomerPurchaseOrderPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [history, setHistory] = useState([]);
  const [quotationList, setQuotationList] = useState([]);
  const [selectedPO, setSelectedPO] = useState(null);
  const [showExcelImport, setShowExcelImport] = useState(false);

  // Filter & Pagination States
  const [sourceTab, setSourceTab] = useState('all'); // 'all' | 'live' | 'legacy'
  const [fyFilter, setFyFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 30;

  const customerPOImportColumns = CUSTOMER_PO_EXCEL_COLUMNS;
  const validateCustomerPORow = (record) => {
    return validateCustomerPOExcelRecord(record);
  };
  const importCustomerPOs = async (records) => {
    const payloadRecords = records.map((record) => ({
      ...record,
      amountInWords: wordsFor(record.items.reduce((sum, item) => sum + item.amount, 0), 'INR')
    }));
    const result = await importCustomerPurchaseOrders(payloadRecords);
    try {
      const savedRecords = await getCustomerPurchaseOrders();
      setHistory(savedRecords);
    } catch (error) {
      console.error('Customer PO import committed, but the dashboard refresh failed', error);
    }
    for (const outcome of result.outcomes.filter((item) => item.status === 'imported')) saveDocSequence('customerPOSequence', outcome.poNumber);
    return { ...result, success: result.newHeaders ?? result.imported, skipped: result.skippedItems ?? 0, outcomes: result.outcomes };
  };
  // Form states
  const [poDetails, setPoDetails] = useState({
    customerPoNumber: generateCustomerPONumber(),
    customerPoDate: new Date().toISOString().slice(0, 10),
    deliveryDueDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
    quotationRef: '',
    projectId: '',
    placeOfSupply: '',
    poStatus: 'Received', // 'Received' | 'Verified' | 'Accepted' | 'Converted to SO'
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
      address: 'PRAGMATIC ENGINEERS Sy. No. 17/3A, "Krishraraju Estate", C.K.Palya Road, Basavanapura, Bannerghatta Road, Bangalore - 560083',
      gstin: '',
      state: 'Karnataka (29)'
    };
  });

  const [items, setItems] = useState([{ ...emptyItem }]);

  // Customer PO records are stored centrally in PostgreSQL.
  useEffect(() => {
    let active = true;
    const refreshCustomerPOs = () => getCustomerPurchaseOrders()
      .then((records) => { if (active) setHistory(records); })
      .catch((error) => console.error('Failed to load Customer POs from PostgreSQL', error));
    refreshCustomerPOs();
    const refreshTimer = window.setInterval(refreshCustomerPOs, 15000);
    try {
      const storedQuotes = localStorage.getItem('quotationHistory');
      setQuotationList(storedQuotes ? JSON.parse(storedQuotes) : []);
    } catch {
      setQuotationList([]);
    }
    return () => { active = false; window.clearInterval(refreshTimer); };
  }, []);

  const [projectSummaryList, setProjectSummaryList] = useState([]);
  const [projectAutoLinkMsg, setProjectAutoLinkMsg] = useState('');

  useEffect(() => {
    setProjectSummaryList(getAllProjectsSummary());
  }, []);

  // Customer PO records from live ERP history
  const allRecords = useMemo(() => {
    return history.map((h) => ({
      ...h,
      isLegacy: h.isLegacy || h.recordType === 'Historical',
      projectId: h.payload?.poDetails?.projectId || h.projectId || '-',
      fyLabel: h.fyLabel || getFinancialYearInfo(h.payload?.poDetails?.customerPoDate || h.date).fyLabel,
      fyCode: h.fyCode || getFinancialYearInfo(h.payload?.poDetails?.customerPoDate || h.date).fyCode
    }));
  }, [history]);

  // Filtered records based on active tab, FY, and search
  const filteredRecords = useMemo(() => {
    let list = allRecords;

    if (sourceTab === 'live') {
      list = list.filter((r) => !r.isLegacy);
    } else if (sourceTab === 'legacy') {
      list = list.filter((r) => r.isLegacy);
    }

    if (fyFilter !== 'all') {
      list = list.filter((r) => r.fyLabel?.includes(fyFilter) || r.fyCode === fyFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((r) => {
        const matchPo = String(r.reference || '').toLowerCase().includes(q);
        const matchProj = String(r.projectId || '').toLowerCase().includes(q);
        const matchComp = String(r.company || '').toLowerCase().includes(q);
        const matchItems = r.payload?.items?.some((it) =>
          String(it.itemName || it.itemDescription || '').toLowerCase().includes(q) ||
          String(it.drawingNo || '').toLowerCase().includes(q)
        );
        return matchPo || matchProj || matchComp || matchItems;
      });
    }

    return list;
  }, [allRecords, sourceTab, fyFilter, searchQuery]);

  // Pagination
  const paginatedRecords = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, currentPage]);

  const totalPages = Math.ceil(filteredRecords.length / pageSize) || 1;

  // Reset to page 1 on filter/search change
  useEffect(() => {
    setCurrentPage(1);
  }, [sourceTab, fyFilter, searchQuery]);

  const handleProjectLookup = (pid, directData) => {
    setPoDetails((prev) => ({ ...prev, projectId: pid }));
    if (!pid || !pid.trim()) {
      setProjectAutoLinkMsg('');
      return;
    }

    const data = directData || getFullProjectData(pid);
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

      if (data.quotationRef && !poDetails.quotationRef) {
        setPoDetails((prev) => ({ ...prev, quotationRef: data.quotationRef }));
      }

      if (data.customerPoNumber && !poDetails.customerPoNumber) {
        setPoDetails((prev) => ({ ...prev, customerPoNumber: data.customerPoNumber }));
      }

      if (data.items && data.items.length > 0) {
        const isBlank = items.length === 1 && !items[0].itemName.trim();
        if (isBlank) {
          setItems(data.items);
        }
      }

      setProjectAutoLinkMsg(`✓ Auto-linked to Project: ${pid} (${data.customerDetails?.companyName || data.customerDetails?.customerName || 'Matched'})`);
    } else {
      setProjectAutoLinkMsg('');
    }
  };

  // Handle incoming data if navigated with state
  useEffect(() => {
    if (location.state?.fromQuotation && location.state?.quotation) {
      const q = location.state.quotation;
      setPoDetails({
        customerPoNumber: generateCustomerPONumber(),
        customerPoDate: new Date().toISOString().slice(0, 10),
        deliveryDueDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
        quotationRef: q.quotationDetails?.quotationNumber || '',
        projectId: q.quotationDetails?.projectId || '',
        placeOfSupply: q.quotationDetails?.placeOfSupply || '',
        poStatus: 'Received',
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
    } else if (location.state?.viewPO) {
      setSelectedPO(location.state.viewPO);
      setMode('view');
    }
  }, [location.state]);

  const handleSelectQuotation = (quotationRef) => {
    if (!quotationRef) return;
    const match = quotationList.find((q) => q.reference === quotationRef);
    if (match && match.payload) {
      const p = match.payload;
      setPoDetails((prev) => ({
        ...prev,
        quotationRef: p.quotationDetails?.quotationNumber || quotationRef,
        projectId: p.quotationDetails?.projectId || prev.projectId,
        placeOfSupply: p.quotationDetails?.placeOfSupply || prev.placeOfSupply,
        discount: p.quotationDetails?.discount || '',
        currency: p.quotationDetails?.currency || prev.currency || 'INR',
        exchangeRate: p.quotationDetails?.exchangeRate ?? prev.exchangeRate ?? '',
        rateDate: p.quotationDetails?.rateDate || '',
        rateAtConversion: p.quotationDetails?.rateAtConversion ?? p.quotationDetails?.exchangeRate ?? '',
        taxMode: p.quotationDetails?.taxMode || prev.taxMode || 'intra',
        notes: p.quotationDetails?.notes || '',
        termsAndConditions: p.quotationDetails?.termsAndConditions || prev.termsAndConditions
      }));

      if (p.customerDetails) setCustomerDetails(p.customerDetails);
      if (p.items && p.items.length > 0) setItems(p.items);
    }
  };

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

  const currencyCode = poDetails.currency || 'INR';
  const taxMode = poDetails.taxMode || 'intra';

  const totals = useMemo(
    () => calculateTotals(computedItems, poDetails.discount, taxMode),
    [computedItems, poDetails.discount, taxMode]
  );
  const amountInWords = useMemo(() => wordsFor(totals.grandTotal, currencyCode), [totals.grandTotal, currencyCode]);
  const totalINR = convertToINR(totals.grandTotal, currencyCode, poDetails.exchangeRate);

  const viewCurrency = selectedPO?.poDetails?.currency || 'INR';
  const viewTaxMode = selectedPO?.poDetails?.taxMode || 'intra';
  const viewMoney = (value) => {
    const amount = Number(value || 0);
    if (isForeignCurrency(viewCurrency)) return `${viewCurrency} ${moneyPlain(amount, viewCurrency)}`;
    return amount.toFixed(2);
  };
  const viewWords = selectedPO?.amountInWords || wordsFor(selectedPO?.totals?.grandTotal || 0, viewCurrency);

  const handleFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSavePO = async (e) => {
    e.preventDefault();
    if (!poDetails.customerPoNumber.trim()) {
      alert('Please enter Customer PO Number.');
      return;
    }
    if (!customerDetails.customerName.trim()) {
      alert('Please enter Customer Name.');
      return;
    }
    if (isForeignCurrency(currencyCode) && !(Number(poDetails.exchangeRate) > 0)) {
      alert(`Exchange rate (1 ${currencyCode} to INR) is required before saving a non-INR Customer PO.`);
      return;
    }

    const payload = {
      poDetails,
      customerDetails,
      companyDetails,
      items: computedItems,
      totals,
      amountInWords,
      amountINR: totalINR,
      currency: currencyCode
    };

    try {
      const entry = await createCustomerPurchaseOrder({
        date: poDetails.customerPoDate,
        reference: poDetails.customerPoNumber,
        company: customerDetails.companyName || customerDetails.customerName || '-',
        status: poDetails.poStatus || 'Received',
        payload
      });
      saveDocSequence('customerPOSequence', poDetails.customerPoNumber);
      setHistory((current) => [entry, ...current.filter((record) => record.reference !== entry.reference)]);
      setSelectedPO(entry.payload);
      setMode('view');
    } catch (err) {
      console.error('Failed to save Customer PO', err);
      alert(err.message || 'Failed to save Customer PO to PostgreSQL.');
    }
  };

  const handleConvertToSalesOrder = (poPayload) => {
    if (poPayload?.isLegacy) {
      alert('Historical archive records are view-only and cannot be converted to Sales Orders.');
      return;
    }
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const serial = Math.floor(100 + Math.random() * 900);
    const soNum = `SO-${year}${month}${day}-${serial}`;

    navigate('/sales-order', {
      state: {
        fromCustomerPO: true,
        soNumber: soNum,
        customerPO: poPayload
      }
    });
  };

  const handleSendToProduction = (poPayload) => {
    navigate('/production', {
      state: {
        fromCustomerPO: true,
        customerPO: poPayload
      }
    });
  };

  const handlePrintPDF = () => {
    window.print();
  };

  const handleViewPO = async (po) => {
    try {
      const record = await getCustomerPurchaseOrder(po.reference);
      setSelectedPO(record.payload);
      setMode('view');
    } catch (error) {
      alert(error.message || 'Could not retrieve this Customer PO from PostgreSQL.');
    }
  };

  const handleDownloadPDF = async () => {
    if (!selectedPO) return;
    try {
      const isLegacy = selectedPO.isLegacy;
      const fyLabel = selectedPO.fyLabel || 'FY 2026-27';
      const pdfTitle = `Customer Purchase Order (${fyLabel})`;
      const pdfPayload = {
        ...selectedPO, 
        documentTitle: pdfTitle,
        forTitle: 'Customer Information:',
        detailsTitle: 'Purchase Order Details:',
        documentDetails: [
          { label: 'Customer PO No', value: selectedPO.poDetails?.customerPoNumber || '-' },
          { label: 'PO Date', value: selectedPO.poDetails?.customerPoDate || '-' },
          { label: 'Target Delivery', value: selectedPO.poDetails?.deliveryDueDate || '-' },
          { label: 'Quotation Ref', value: selectedPO.poDetails?.quotationRef || '-' },
          { label: 'Project ID', value: selectedPO.poDetails?.projectId || '-' },
          { label: 'PO Status', value: selectedPO.poDetails?.poStatus || '-' }
        ],
        quotationDetails: {
          quotationNumber: `PO: ${selectedPO.poDetails?.customerPoNumber}`,
          quotationDate: selectedPO.poDetails?.customerPoDate,
          placeOfSupply: selectedPO.poDetails?.placeOfSupply,
          projectId: selectedPO.poDetails?.projectId,
          termsAndConditions: selectedPO.poDetails?.termsAndConditions,
          notes: selectedPO.poDetails?.notes
        }
      };
      await generateQuotationPDF(pdfPayload);
    } catch {
      alert('Error generating PDF.');
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>
            {mode === 'create'
              ? 'Record Customer Purchase Order'
              : mode === 'view'
              ? `Customer PO: ${selectedPO?.poDetails?.customerPoNumber || ''}`
              : 'Customer Purchase Orders'}
          </h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to PO List
            </button>
          ) : (
            <>
              <button
                className="button-primary"
                onClick={() => {
                  setPoDetails({
                    customerPoNumber: generateCustomerPONumber(),
                    customerPoDate: new Date().toISOString().slice(0, 10),
                    deliveryDueDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
                    quotationRef: '', projectId: '', placeOfSupply: '', poStatus: 'Received', discount: '', currency: 'INR', exchangeRate: '', rateDate: '', rateAtConversion: '', taxMode: 'intra', notes: '', termsAndConditions: ''
                  });
                  setItems([{ ...emptyItem }]);
                  setMode('create');
                }}
              >
                + Record Customer PO
              </button>
              <button type="button" className="button-secondary" onClick={() => setShowExcelImport(true)}><Upload size={16} /> Import Excel</button>
            </>
          )}
        </div>
      </div>

      {showExcelImport && <ExcelImportDialog title="Customer Purchase Orders" columns={customerPOImportColumns} example={[]} existingRecords={history} instructions={['Required columns: Sl No, PO No, PO Date, Customer Name, Description of Goods, Quantity, Delivered Quantity, Balance Quantity, Price, Amount and PO Balance Quantity Price.', 'A row with PO No, PO Date and Customer Name starts a PO; following rows with those fields blank are items for that PO.', 'Imported records are saved to PostgreSQL as Historical / Archived (Pre-ERP), with financial year derived from PO Date.']} validate={validateCustomerPORow} onImport={importCustomerPOs} onClose={() => setShowExcelImport(false)} />}

      {mode !== 'list' && !selectedPO?.isLegacy && (selectedPO?.poDetails?.projectId || poDetails?.projectId) && (
        <WorkflowNavigator
          projectId={selectedPO?.poDetails?.projectId || poDetails?.projectId}
          currentStage="customerPO"
        />
      )}

      <div className="content-block">
        {mode === 'list' && (
          <>
            <div className="block-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <h2>Customer PO Records</h2>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#64748b' }}>
                  Showing <strong>{filteredRecords.length}</strong> total purchase orders across all financial years
                </p>
              </div>

              {/* Source Tabs */}
              <div style={{ display: 'flex', background: '#f1f5f9', padding: '3px', borderRadius: '8px', gap: '4px' }}>
                <button
                  type="button"
                  onClick={() => setSourceTab('all')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '6px',
                    fontSize: '12.5px',
                    fontWeight: '600',
                    border: 'none',
                    cursor: 'pointer',
                    background: sourceTab === 'all' ? '#ffffff' : 'transparent',
                    color: sourceTab === 'all' ? '#0f172a' : '#64748b',
                    boxShadow: sourceTab === 'all' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                  }}
                >
                  All ({allRecords.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSourceTab('live')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '6px',
                    fontSize: '12.5px',
                    fontWeight: '600',
                    border: 'none',
                    cursor: 'pointer',
                    background: sourceTab === 'live' ? '#ffffff' : 'transparent',
                    color: sourceTab === 'live' ? '#166534' : '#64748b',
                    boxShadow: sourceTab === 'live' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                  }}
                >
                  ⚡ Live ERP ({allRecords.filter((r) => !r.isLegacy).length})
                </button>
                <button
                  type="button"
                  onClick={() => setSourceTab('legacy')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '6px',
                    fontSize: '12.5px',
                    fontWeight: '600',
                    border: 'none',
                    cursor: 'pointer',
                    background: sourceTab === 'legacy' ? '#ffffff' : 'transparent',
                    color: sourceTab === 'legacy' ? '#92400e' : '#64748b',
                    boxShadow: sourceTab === 'legacy' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                  }}
                >
                  📜 Historical Archives ({allRecords.filter((r) => r.isLegacy).length})
                </button>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div
              style={{
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
                flexWrap: 'wrap',
                background: '#f8fafc',
                padding: '12px 16px',
                borderRadius: '10px',
                border: '1px solid #e2e8f0',
                margin: '14px 0 16px'
              }}
            >
              <div style={{ flex: '1', minWidth: '240px' }}>
                <input
                  type="text"
                  placeholder="🔍 Search by PO Number, Project ID, Customer, or Part Description..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    height: '36px',
                    padding: '0 12px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '13px',
                    background: '#ffffff',
                    color: '#0f172a',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: '600', color: '#475569' }}>Financial Year:</span>
                <select
                  value={fyFilter}
                  onChange={(e) => setFyFilter(e.target.value)}
                  style={{
                    height: '36px',
                    padding: '0 10px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '13px',
                    background: '#ffffff',
                    color: '#0f172a',
                    cursor: 'pointer'
                  }}
                >
                  <option value="all">All Financial Years (2020 – 2027)</option>
                  <option value="2026-27">FY 2026-27 (Current Live ERP)</option>
                  <option value="2025-26">FY 2025-26 (SKF USA, etc.)</option>
                  <option value="2024-25">FY 2024-25 (NBC Jaipur, etc.)</option>
                  <option value="2023-24">FY 2023-24 (NEI Newai, etc.)</option>
                  <option value="2022-23">FY 2022-23 (NBC Jaipur, etc.)</option>
                  <option value="2021-22">FY 2021-22 (Hilger U.Kern, etc.)</option>
                  <option value="2020-21">FY 2020-21 (Bosch Ltd, etc.)</option>
                </select>
              </div>
            </div>

            <div className="history-table-wrapper">
              <table className="history-table" style={{ width: '100%', tableLayout: 'auto' }}>
                <thead>
                  <tr>
                    <th style={{ width: '115px', whiteSpace: 'nowrap' }}>PO Date</th>
                    <th style={{ width: '145px', whiteSpace: 'nowrap' }}>Project ID</th>
                    <th style={{ width: '160px', whiteSpace: 'nowrap' }}>Customer PO No.</th>
                    <th style={{ minWidth: '220px' }}>Customer / Company</th>
                    <th style={{ width: '135px', whiteSpace: 'nowrap', textAlign: 'right' }}>Total Value</th>
                    <th style={{ width: '160px', whiteSpace: 'nowrap', textAlign: 'center' }}>Data Source</th>
                    <th style={{ width: '110px', whiteSpace: 'nowrap', textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedRecords.length > 0 ? (
                    paginatedRecords.map((po, idx) => (
                      <tr key={idx}>
                        <td style={{ whiteSpace: 'nowrap', fontWeight: '500', color: '#334155' }}>
                          {po.date ? String(po.date).trim().replace(/[\/\s]/g, '-') : '-'}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ fontWeight: '700', color: po.isLegacy ? '#92400e' : '#2563eb' }}>
                            {po.projectId || '-'}
                          </span>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <strong style={{ color: '#0f172a' }}>{po.reference}</strong>
                        </td>
                        <td style={{ lineHeight: '1.45', wordBreak: 'break-word', color: '#1e293b' }}>
                          {po.company}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          <strong style={{ color: '#0f172a' }}>{po.total}</strong>
                        </td>
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                          {po.isLegacy ? (
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '3px 10px',
                                borderRadius: '20px',
                                fontSize: '11px',
                                fontWeight: '700',
                                background: '#fef3c7',
                                color: '#92400e',
                                border: '1px solid #fde68a',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              📜 {po.fyLabel} (Pre-ERP)
                            </span>
                          ) : (
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '3px 10px',
                                borderRadius: '20px',
                                fontSize: '11px',
                                fontWeight: '700',
                                background: '#dcfce7',
                                color: '#166534',
                                border: '1px solid #bbf7d0',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              ⚡ Live ERP Order
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                          <button
                            className="button-small"
                            onClick={() => handleViewPO(po)}
                          >
                            View / Print
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="7" className="no-history-row" style={{ padding: '32px 16px', textAlign: 'center' }}>
                        No purchase orders match the selected filters or search query.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Bar */}
            {totalPages > 1 && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '12px 16px',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '8px',
                  marginTop: '12px',
                  fontSize: '13px',
                  color: '#475569'
                }}
              >
                <div>
                  Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong> ({filteredRecords.length} records)
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="button-small"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    style={{ opacity: currentPage === 1 ? 0.5 : 1, cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}
                  >
                    ◀ Previous
                  </button>
                  <button
                    type="button"
                    className="button-small"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    style={{ opacity: currentPage === totalPages ? 0.5 : 1, cursor: currentPage === totalPages ? 'not-allowed' : 'pointer' }}
                  >
                    Next ▶
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSavePO}>
            <div style={{ marginBottom: '16px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '13px', color: '#64748b', fontWeight: '600' }}>Customer PO ID:</span>
              <strong className="project-id-value" style={{ fontSize: '18px', color: '#0f172a', letterSpacing: '0.5px' }}>{poDetails.customerPoNumber}</strong>
              <span style={{ fontSize: '11px', color: '#94a3b8', marginLeft: '4px' }}>(Auto-generated, editable)</span>
            </div>
            <div className="form-section">
              <div className="section-heading">
                <h3>Customer Purchase Order Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Customer PO Number *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. CPO-2627-0001"
                    value={poDetails.customerPoNumber}
                    onChange={(e) => setPoDetails({ ...poDetails, customerPoNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Customer PO Date *</label>
                  <input
                    type="date"
                    required
                    value={poDetails.customerPoDate}
                    onChange={(e) => setPoDetails({ ...poDetails, customerPoDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Link to Quotation (Optional)</label>
                  <input
                    type="text"
                    list="quotationOptionsList"
                    placeholder="e.g. QT-2026-0001"
                    value={poDetails.quotationRef}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPoDetails((prev) => ({ ...prev, quotationRef: val }));
                      const match = quotationList.find(
                        (q) => q.reference?.trim().toLowerCase() === val.trim().toLowerCase()
                      );
                      if (match) {
                        handleSelectQuotation(match.reference);
                      }
                    }}
                  />
                  <datalist id="quotationOptionsList">
                    {quotationList.map((q) => (
                      <option key={q.reference} value={q.reference}>
                        {q.company} - {q.total}
                      </option>
                    ))}
                  </datalist>
                </div>
                <div className="field-group">
                  <label>Delivery Due Date</label>
                  <input
                    type="date"
                    value={poDetails.deliveryDueDate}
                    onChange={(e) => setPoDetails({ ...poDetails, deliveryDueDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Project ID (Master Auto-link)</label>
                  <ProjectIdAutocomplete
                    value={poDetails.projectId}
                    onChange={(val) => setPoDetails((prev) => ({ ...prev, projectId: val }))}
                    onSelectProject={(pid, fullData) => handleProjectLookup(pid, fullData)}
                    placeholder="Search or select Project ID (e.g. PE-2627-0001)..."
                    autoLinkMsg={projectAutoLinkMsg}
                  />
                </div>
                <div className="field-group">
                  <label>Status</label>
                  <select
                    value={poDetails.poStatus}
                    onChange={(e) => setPoDetails({ ...poDetails, poStatus: e.target.value })}
                  >
                    <option value="Received">Received</option>
                    <option value="Verified">Verified</option>
                    <option value="Accepted">Accepted</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>Currency</label>
                  <select
                    value={currencyCode}
                    onChange={(e) => setPoDetails({ ...poDetails, currency: e.target.value })}
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
                      value={poDetails.exchangeRate}
                      onChange={(e) => setPoDetails({ ...poDetails, exchangeRate: e.target.value })}
                      placeholder="e.g. 83.4500"
                    />
                  </div>
                )}
                <div className="field-group">
                  <label>Tax Treatment</label>
                  <select
                    value={taxMode}
                    onChange={(e) => setPoDetails({ ...poDetails, taxMode: e.target.value })}
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
                <h3>Customer Information</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Customer Name *</label>
                  <input
                    type="text"
                    required
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
                <h3>PO Items & Agreed Rates</h3>
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
                          <AddableSelect value={item.unit || 'Nos'} onChange={(event) => handleFieldChange(idx, 'unit', event.target.value)} options={DEFAULT_UNITS} masterType="unit" title="Add Unit of Measurement" addLabel="+ Add New Unit" />
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
                      value={poDetails.discount}
                      onChange={(e) => setPoDetails({ ...poDetails, discount: e.target.value })}
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
                  value={poDetails.termsAndConditions}
                  onChange={(e) => setPoDetails({ ...poDetails, termsAndConditions: e.target.value })}
                />
              </div>
              <div className="field-group full-width" style={{ marginTop: '16px' }}>
                <label>Notes & PO Special Instructions</label>
                <textarea
                  rows="2"
                  value={poDetails.notes}
                  onChange={(e) => setPoDetails({ ...poDetails, notes: e.target.value })}
                />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setMode('list')}>
                Cancel
              </button>
              <button type="submit" className="button-primary">
                Save Customer PO
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedPO && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setMode('list')}
                style={{ fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                ← Back to PO List
              </button>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button className="button-primary" onClick={handlePrintPDF}>
                  Print PO Sheet
                </button>
                <button className="button-secondary" onClick={handleDownloadPDF}>
                  Download PDF
                </button>
                {!selectedPO.isLegacy && (
                  <>
                    <button
                      className="button-secondary"
                      onClick={() => {
                        setPoDetails(selectedPO.poDetails);
                        setCustomerDetails(selectedPO.customerDetails);
                        setCompanyDetails(selectedPO.companyDetails);
                        setItems(selectedPO.items);
                        setMode('create');
                      }}
                    >
                      Edit PO
                    </button>
                    <button
                      className="button-primary"
                      style={{ background: '#2563eb' }}
                      onClick={() => handleConvertToSalesOrder(selectedPO)}
                    >
                      Convert to Sales Order
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Amber Historical Audit Banner */}
            {selectedPO.isLegacy && (
              <div
                className="no-print"
                style={{
                  background: '#fef3c7',
                  border: '2px solid #f59e0b',
                  borderRadius: '10px',
                  padding: '16px 20px',
                  marginBottom: '20px',
                  color: '#92400e',
                  boxShadow: '0 2px 6px rgba(245, 158, 11, 0.12)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '24px' }}>📜</span>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#b45309' }}>
                      {selectedPO.fyLabel || 'FY Record'}
                    </h3>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span
                      style={{
                        background: '#dbeafe',
                        color: '#1e40af',
                        padding: '6px 14px',
                        borderRadius: '20px',
                        fontWeight: '700',
                        fontSize: '12px',
                        border: '1px solid #bfdbfe'
                      }}
                    >
                      Project ID: {selectedPO.poDetails?.projectId || selectedPO.projectId}
                    </span>
                    <span
                      style={{
                        background: '#fef08a',
                        color: '#854d0e',
                        padding: '6px 14px',
                        borderRadius: '20px',
                        fontWeight: '700',
                        fontSize: '12px',
                        border: '1px solid #fde047'
                      }}
                    >
                      Status: Archived
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="doc-page-container">
              <div className="quotation-doc-sheet printable">
                <h1 className="doc-main-title">
                  {selectedPO.isLegacy
                    ? `Customer Purchase Order (${selectedPO.fyLabel})`
                    : 'Customer Purchase Order'}
                </h1>

                {/* Company Header Box */}
                <div className="doc-company-box">
                    <div className="doc-company-left">
                      <div className="doc-company-name">{brandName}</div>
                      <div className="doc-company-details">
                        <div>{brandCompany.address}</div>
                        <div>GSTIN: {brandCompany.gstin}</div>
                        <div>Phone: {brandCompany.phone}</div>
                      </div>
                    </div>
                    <div className="doc-company-mid">
                      <div>Email: {brandCompany.email}</div>
                      <div>State: {brandCompany.state}</div>
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
                        {selectedPO.customerDetails?.companyName || selectedPO.customerDetails?.customerName || '-'}
                      </div>
                      {selectedPO.customerDetails?.address && (
                        <div className="doc-customer-address">{selectedPO.customerDetails.address}</div>
                      )}
                      <div className="doc-customer-inline">
                        {selectedPO.customerDetails?.contactNumber && (
                          <div>Contact: {selectedPO.customerDetails.contactNumber}</div>
                        )}
                        {selectedPO.customerDetails?.gstNumber && (
                          <div>GSTIN: {selectedPO.customerDetails.gstNumber}</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="doc-half-box doc-half-right">
                    <div className="doc-box-header">Purchase Order Details:</div>
                    <div className="doc-box-body">
                      <div><strong>Customer PO No:</strong> {selectedPO.poDetails?.customerPoNumber || '-'}</div>
                      <div><strong>PO Date:</strong> {selectedPO.poDetails?.customerPoDate || '-'}</div>
                      {selectedPO.poDetails?.deliveryDueDate && (
                        <div><strong>Target Delivery:</strong> {selectedPO.poDetails.deliveryDueDate}</div>
                      )}
                      {selectedPO.poDetails?.quotationRef && (
                        <div><strong>Quotation Ref:</strong> {selectedPO.poDetails.quotationRef}</div>
                      )}
                      {selectedPO.poDetails?.projectId && (
                        <div><strong>Project ID:</strong> {selectedPO.poDetails.projectId}</div>
                      )}
                      <div><strong>PO Status:</strong> {selectedPO.poDetails?.poStatus || 'Received'}</div>
                      <div>
                        <strong>Currency:</strong> {viewCurrency}
                        {isForeignCurrency(viewCurrency) && selectedPO.poDetails?.exchangeRate
                          ? ` (1 ${viewCurrency} = ${selectedPO.poDetails.exchangeRate} INR)`
                          : ''}
                      </div>
                      <div>
                        <strong>Tax:</strong>{' '}
                        {selectedPO.isHistorical
                          ? 'Tax details not provided in source workbook'
                          : viewTaxMode === 'inter'
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
                    {selectedPO.items?.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-center">{item.serialNumber || idx + 1}</td>
                        <td className="text-left">{item.drawingNo || '-'}</td>
                        <td className="text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                        </td>
                        <td className="text-left">{item.hsnSac || '-'}</td>
                        <td className="text-right">{item.quantity || 0}</td>
                        <td className="text-center">{item.unit || 'Nos'}</td>
                        <td className="text-right">{viewMoney(item.unitPrice)}</td>
                        <td className="text-right">{selectedPO.isHistorical ? '—' : item.gst ? `${item.gst}%` : '0%'}</td>
                        <td className="text-right">{viewMoney(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="doc-total-row">
                      <td colSpan={4} className="font-bold text-left">Total</td>
                      <td className="font-bold text-right">
                        {selectedPO.items?.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
                      </td>
                      <td></td>
                      <td></td>
                      <td className="font-bold text-right">
                        {selectedPO.isHistorical ? '—' : viewMoney(selectedPO.totals?.totalGST)}
                      </td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedPO.totals?.subtotal)}
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
                          {selectedPO?.poDetails?.notes || '-'}
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
                          {viewMoney(selectedPO.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Taxable</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedPO.totals?.taxableAmount || selectedPO.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax rate</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {selectedPO.isHistorical ? '—' : selectedPO.items?.find(i => Number(i.gst) > 0)?.gst ? `${selectedPO.items.find(i => Number(i.gst) > 0).gst}%` : (selectedPO.items?.[0]?.gst ? `${selectedPO.items[0].gst}%` : '0%')}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax Amount</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {selectedPO.isHistorical ? '—' : viewMoney(selectedPO.totals?.totalGST)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1.5px solid #0f172a', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Other</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedPO.totals?.otherCharges)}
                        </td>
                      </tr>
                      <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                        <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>
                          {viewMoney(selectedPO.totals?.grandTotal)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Notes */}
                {selectedPO.poDetails?.notes && (
                  <div className="doc-full-box">
                    <div className="doc-box-title">Special Instructions:</div>
                    <div className="doc-box-text">{selectedPO.poDetails.notes}</div>
                  </div>
                )}

                {/* Terms and Signatory */}
                <div className="doc-bottom-split">
                  <div className="doc-terms-box">
                    <div className="doc-box-title">Terms & Conditions:</div>
                    <div className="doc-terms-list">
                      {selectedPO.poDetails?.termsAndConditions ? (
                        selectedPO.poDetails.termsAndConditions.split(/\r?\n/).map((t, idx) => (
                          <div key={idx} className="doc-term-item">{t}</div>
                        ))
                      ) : (
                        <div className="doc-term-item">Purchase order accepted as per agreed quotation terms.</div>
                      )}
                    </div>
                  </div>

                  <div className="doc-sign-box">
                    <div className="doc-sign-company">For {brandName}</div>
                    <div className="doc-sign-space"></div>
                    <div className="doc-sign-line"></div>
                  </div>
                </div>

                {/* Footer */}
                <div className="doc-sheet-footer">
                  <span>Customer Purchase Order Record - Pragmatics ERP</span>
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

export default CustomerPurchaseOrderPage;
