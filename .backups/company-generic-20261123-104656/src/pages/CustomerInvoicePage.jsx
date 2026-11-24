import React, { useState, useEffect, useMemo } from 'react';
import AddableSelect from '../components/AddableSelect.jsx';
import { DEFAULT_UNITS } from '../utils/addableMasters.js';
import { useLocation, useNavigate } from 'react-router-dom';
import defaultLogoUrl from '../assets/logo.png';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from '../utils/calculations.js';
import { numberToWords } from '../utils/numberToWords.js';
import { amountInWords as wordsFor, convertToINR, CURRENCIES, getCurrency, isForeignCurrency, money, moneyPlain } from '../utils/currency.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import { getNextSequentialNumber, saveDocSequence } from '../utils/sequenceGenerator.js';
import { getAllProjectsSummary, getFullProjectData } from '../utils/projectTracker.js';
import { getMasterCustomerList } from '../utils/customerMaster.js';
import { getInvoiceBillTo, getInvoiceShipTo, makeInvoiceAddress } from '../utils/invoiceAddresses.js';
import { pushNotification, appendAuditLog } from '../utils/storeService.js';
import WorkflowNavigator from '../components/WorkflowNavigator.jsx';
import ProjectIdAutocomplete from '../components/ProjectIdAutocomplete.jsx';
import ReportRegister from '../components/ReportRegister.jsx';
import AdvanceRegister from '../components/AdvanceRegister.jsx';

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

const invCurrency = (row) => row?.payload?.invoiceDetails?.currency || row?.currency || 'INR';
const invTotalINR = (row) => {
  const stored = Number(row?.amountINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (invCurrency(row) !== 'INR') return Number(row?.payload?.amountINR) || 0;
  return parseINR(row?.total);
};
const invReceivedINR = (row) => {
  const stored = Number(row?.receivedINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (invCurrency(row) !== 'INR') return Number(row?.payload?.receivedINR) || 0;
  return parseINR(row?.status === 'Paid' ? row?.total : row?.amountReceived);
};
const invBalanceINR = (row) => {
  const stored = Number(row?.balanceINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (invCurrency(row) !== 'INR') return Number(row?.payload?.balanceINR) || 0;
  return parseINR(row?.status === 'Paid' ? 0 : row?.balanceDue);
};
const invTotalCell = (row) =>
  isForeignCurrency(invCurrency(row)) ? row?.total || '' : invTotalINR(row).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const invReceivedCell = (row) =>
  isForeignCurrency(invCurrency(row))
    ? row?.status === 'Paid'
      ? row?.total || ''
      : row?.amountReceived || ''
    : invReceivedINR(row).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const invBalanceCell = (row) =>
  isForeignCurrency(invCurrency(row))
    ? row?.status === 'Paid'
      ? '0.00'
      : row?.balanceDue || ''
    : invBalanceINR(row).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const generateInvoiceNumber = () => {
  return getNextSequentialNumber('INV', 'customerInvoiceSequence', 'customerInvoiceHistory', 'reference');
};

const emptyItem = {
  itemCode: '',
  itemName: '',
  drawingNo: '',
  lotNumber: '',
  hsnSac: '',
  quantity: '',
  unit: 'Nos',
  unitPrice: '',
  gst: '18'
};

const masterCustomers = getMasterCustomerList();
const normalizeCustomerName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
const addressesMatch = (left, right) =>
  Object.keys(left).every((key) => left[key] === right[key]);
const findExactMasterCustomer = (name) => {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return null;
  return masterCustomers.find((customer) =>
    [customer.customerName, customer.companyName].some((candidate) => normalizeCustomerName(candidate) === normalized)
  ) || null;
};

const customerDetailsFromMaster = (master, fallback = {}) => {
  const masterAddress = makeInvoiceAddress({ ...fallback, ...master });
  return {
    customerName: master.contactPerson || master.customerName || fallback.customerName || '',
    companyName: master.companyName || master.customerName || fallback.companyName || '',
    address: master.address || fallback.address || '',
    contactNumber: master.contactNumber || master.phone || fallback.contactNumber || '',
    email: master.email || fallback.email || '',
    gstNumber: master.gstNumber || master.gstin || fallback.gstNumber || '',
    state: master.state || masterAddress.state || fallback.state || '',
    city: master.city || masterAddress.city || fallback.city || '',
    pinCode: master.pinCode || master.pincode || master.postalCode || masterAddress.pinCode || fallback.pinCode || ''
  };
};

const InvoiceAddressDocumentBox = ({ title, address }) => {
  const location = [address.city, address.state, address.pinCode].filter(Boolean).join(', ');
  return (
    <div className="doc-half-box invoice-address-document-box">
      <div className="doc-box-header">{title}</div>
      <div className="doc-box-body">
        <div className="doc-customer-name">{address.name || '-'}</div>
        {address.address && <div className="doc-customer-address">{address.address}</div>}
        {location && <div className="doc-customer-address">{location}</div>}
        <div className="doc-customer-inline">
          {address.contactNumber && <div>Contact: {address.contactNumber}</div>}
          {address.gstNumber && <div>GSTIN: {address.gstNumber}</div>}
        </div>
      </div>
    </div>
  );
};

const CustomerInvoicePage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [history, setHistory] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [reportTab, setReportTab] = useState('invoices'); // 'invoices' | 'sales' | 'receivables' | 'advances'

  // Form states
  const [invoiceDetails, setInvoiceDetails] = useState({
    invoiceNumber: generateInvoiceNumber(),
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    quotationRef: '',
    salesOrderRef: '',
    dcRef: '',
    customerPoNumber: '',
    customerPoDate: '',
    projectId: '',
    placeOfSupply: '',
    paymentTerms: 'Net 30 Days',
    paymentStatus: 'Pending', // 'Pending' | 'Partial' | 'Paid'
    amountReceived: '',
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
  const [billTo, setBillTo] = useState(makeInvoiceAddress());
  const [shipTo, setShipTo] = useState(makeInvoiceAddress());

  const applyCustomerDetails = (details, shippingDetails) => {
    const customer = details || {};
    const billingAddress = makeInvoiceAddress(customer);
    setCustomerDetails(customer);
    setBillTo(billingAddress);
    setShipTo(shippingDetails ? makeInvoiceAddress(shippingDetails) : billingAddress);
  };

  const handleCustomerNameChange = (name) => {
    const master = findExactMasterCustomer(name);
    if (master) {
      const details = customerDetailsFromMaster(master);
      applyCustomerDetails(details);
      setInvoiceDetails((previous) => ({
        ...previous,
        placeOfSupply: details.state || previous.placeOfSupply
      }));
      return;
    }

    const shouldCopyToShipping = addressesMatch(billTo, shipTo);
    const nextBillTo = { ...billTo, name };
    setBillTo(nextBillTo);
    if (shouldCopyToShipping) setShipTo(nextBillTo);
    setCustomerDetails((previous) => ({
      ...previous,
      customerName: name,
      companyName: name
    }));
  };

  const updateBillTo = (field, value) => {
    const shouldCopyToShipping = addressesMatch(billTo, shipTo);
    const nextBillTo = { ...billTo, [field]: value };
    setBillTo(nextBillTo);
    if (shouldCopyToShipping) setShipTo(nextBillTo);
    const customerField = {
      name: { customerName: value, companyName: value },
      address: { address: value },
      city: { city: value },
      state: { state: value },
      pinCode: { pinCode: value },
      gstNumber: { gstNumber: value },
      contactNumber: { contactNumber: value }
    }[field];
    if (customerField) setCustomerDetails((previous) => ({ ...previous, ...customerField }));
  };

  const updateShipTo = (field, value) =>
    setShipTo((previous) => ({ ...previous, [field]: value }));

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
      const stored = localStorage.getItem('customerInvoiceHistory');
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
    setInvoiceDetails((prev) => ({ ...prev, projectId: pid }));
    if (!pid || !pid.trim()) {
      setProjectAutoLinkMsg('');
      return;
    }

    const data = directData || getFullProjectData(pid);
    if (data && (data.customerDetails?.customerName || data.customerDetails?.companyName || (data.items && data.items.length > 0))) {
      const master = findExactMasterCustomer(data.customerDetails?.companyName) ||
        findExactMasterCustomer(data.customerDetails?.customerName);
      const resolvedCustomer = master
        ? customerDetailsFromMaster(master, data.customerDetails)
        : data.customerDetails;
      if (resolvedCustomer) applyCustomerDetails(resolvedCustomer, data.shipTo || data.shippingAddress);

      setInvoiceDetails((prev) => ({
        ...prev,
        quotationRef: data.quotationRef || prev.quotationRef,
        salesOrderRef: data.soNumber || prev.salesOrderRef,
        customerPoNumber: data.customerPoNumber || prev.customerPoNumber,
        placeOfSupply: resolvedCustomer?.state || prev.placeOfSupply
      }));

      if (data.items && data.items.length > 0) {
        const isBlank = items.length === 1 && !items[0].itemName.trim();
        if (isBlank) {
          setItems(data.items);
        }
      }

      setProjectAutoLinkMsg(`✓ Linked to Project: ${pid} (${resolvedCustomer?.companyName || resolvedCustomer?.customerName || 'Matched'})`);
    } else {
      setProjectAutoLinkMsg('');
    }
  };

  // Handle incoming conversions from any ERP module
  useEffect(() => {
    if (location.state?.fromQuotation && location.state?.quotation) {
      const q = location.state.quotation;
      const invNum = location.state.invoiceNumber || generateInvoiceNumber();

      setInvoiceDetails({
        invoiceNumber: invNum,
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        quotationRef: q.quotationDetails?.quotationNumber || '',
        salesOrderRef: '',
        projectId: q.quotationDetails?.projectId || '',
        placeOfSupply: q.quotationDetails?.placeOfSupply || '',
        paymentStatus: 'Pending',
        paymentTerms: 'Due in 30 Days',
        discount: q.quotationDetails?.discount || '',
        currency: q.quotationDetails?.currency || 'INR',
        exchangeRate: q.quotationDetails?.exchangeRate ?? '',
        rateDate: q.quotationDetails?.rateDate || '',
        rateAtConversion: q.quotationDetails?.exchangeRate ?? '',
        taxMode: q.quotationDetails?.taxMode || 'intra',
        notes: q.quotationDetails?.notes || '',
        termsAndConditions: q.quotationDetails?.termsAndConditions || q.termsAndConditions || ''
      });

      if (q.customerDetails) applyCustomerDetails(q.customerDetails, q.shipTo || q.shippingAddress);
      if (q.companyDetails) setCompanyDetails(q.companyDetails);
      if (q.items && q.items.length > 0) setItems(q.items);

      setMode('create');
    } else if (location.state?.fromSalesOrder && location.state?.salesOrder) {
      const so = location.state.salesOrder;
      setInvoiceDetails({
        invoiceNumber: generateInvoiceNumber(),
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        quotationRef: so.soDetails?.quotationRef || '',
        salesOrderRef: so.soDetails?.soNumber || '',
        projectId: so.soDetails?.projectId || '',
        placeOfSupply: so.soDetails?.placeOfSupply || '',
        paymentStatus: 'Pending',
        paymentTerms: 'Due in 30 Days',
        discount: so.soDetails?.discount || '',
        currency: so.soDetails?.currency || 'INR',
        exchangeRate: so.soDetails?.exchangeRate ?? '',
        rateDate: so.soDetails?.rateDate || '',
        rateAtConversion: so.soDetails?.rateAtConversion || so.soDetails?.exchangeRate || '',
        taxMode: so.soDetails?.taxMode || 'intra',
        notes: so.soDetails?.notes || '',
        termsAndConditions: so.soDetails?.termsAndConditions || ''
      });

      if (so.customerDetails) applyCustomerDetails(so.customerDetails, so.shipTo || so.shippingAddress);
      if (so.companyDetails) setCompanyDetails(so.companyDetails);
      if (so.items && so.items.length > 0) setItems(so.items);

      setMode('create');
    } else if (location.state?.fromDeliveryChallan && location.state?.deliveryChallan) {
      const dc = location.state.deliveryChallan;
      setInvoiceDetails({
        invoiceNumber: generateInvoiceNumber(),
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        quotationRef: dc.dcDetails?.customerPoRef || '',
        salesOrderRef: dc.dcDetails?.salesOrderRef || `DC: ${dc.dcDetails?.dcNumber}`,
        dcRef: dc.dcDetails?.dcNumber || '',
        jobCardNumber: dc.jobCardNumber || dc.dcDetails?.jobCardNumber || '',
        projectId: dc.dcDetails?.projectId || '',
        placeOfSupply: dc.dcDetails?.deliveryLocation || '',
        paymentStatus: 'Pending',
        paymentTerms: 'Due in 30 Days',
        discount: dc.dcDetails?.discount || '',
        currency: dc.dcDetails?.currency || 'INR',
        exchangeRate: dc.dcDetails?.exchangeRate ?? '',
        rateDate: dc.dcDetails?.rateDate || '',
        rateAtConversion: dc.dcDetails?.exchangeRate ?? '',
        taxMode: dc.dcDetails?.taxMode || 'intra',
        notes: `Dispatched via Delivery Challan ${dc.dcDetails?.dcNumber} dated ${dc.dcDetails?.dcDate}. Transporter: ${dc.dcDetails?.transporterName || '-'}`,
        termsAndConditions: dc.dcDetails?.termsAndConditions || ''
      });

      if (dc.customerDetails) {
        const dcShipTo = dc.shipTo || dc.shippingAddress || (dc.dcDetails?.deliveryLocation
          ? { ...dc.customerDetails, address: dc.dcDetails.deliveryLocation }
          : undefined);
        applyCustomerDetails(dc.customerDetails, dcShipTo);
      }
      if (dc.companyDetails) setCompanyDetails(dc.companyDetails);
      if (dc.items && dc.items.length > 0) setItems(dc.items);

      setMode('create');
    } else if (location.state?.fromJobCard && location.state?.jobCard) {
      const jc = location.state.jobCard;
      setInvoiceDetails({
        invoiceNumber: generateInvoiceNumber(),
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        quotationRef: '',
        salesOrderRef: jc.salesOrderRef || `Job Card: ${jc.jobCardNumber}`,
        jobCardNumber: jc.jobCardNumber || '',
        projectId: jc.projectId || '',
        placeOfSupply: 'Karnataka (29)',
        paymentStatus: 'Pending',
        paymentTerms: 'Due in 30 Days',
        discount: '',
        notes: `Produced under Job Card ${jc.jobCardNumber}. QC Accepted Qty: ${jc.qualityControl?.finalQC?.acceptedQty || jc.orderQuantity} Nos`,
        termsAndConditions: ''
      });

      applyCustomerDetails({
        customerName: jc.customerName || '',
        companyName: jc.customerName || '',
        address: '',
        contactNumber: '',
        email: '',
        gstNumber: '',
        state: 'Karnataka'
      });

      setItems([
        {
          itemCode: jc.jobCardNumber,
          itemName: jc.partName,
          drawingNo: jc.drawingNumber,
          hsnSac: '8483',
          quantity: jc.qualityControl?.finalQC?.acceptedQty || jc.orderQuantity,
          unit: 'Nos',
          unitPrice: '',
          gst: '18'
        }
      ]);

      setMode('create');
    } else if (location.state?.viewInvoice) {
      setSelectedInvoice(location.state.viewInvoice);
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
        lotNumber: item.lotNumber || item.lotNo || '',
        unit: item.unit || 'Nos',
        amount,
        gstAmount
      };
    });
  }, [items]);

  const currencyCode = invoiceDetails.currency || 'INR';
  const taxMode = invoiceDetails.taxMode || 'intra';

  const totals = useMemo(
    () => calculateTotals(computedItems, invoiceDetails.discount, taxMode),
    [computedItems, invoiceDetails.discount, taxMode]
  );
  const amountInWords = useMemo(() => wordsFor(totals.grandTotal, currencyCode), [totals.grandTotal, currencyCode]);
  const totalINR = convertToINR(totals.grandTotal, currencyCode, invoiceDetails.exchangeRate);

  const viewCurrency = selectedInvoice?.invoiceDetails?.currency || 'INR';
  const viewTaxMode = selectedInvoice?.invoiceDetails?.taxMode || 'intra';
  const viewBillTo = getInvoiceBillTo(selectedInvoice || {});
  const viewShipTo = getInvoiceShipTo(selectedInvoice || {});
  const viewHasAnyLotNumber = Boolean(
    selectedInvoice?.items?.some((item) => String(item.lotNumber || item.lotNo || '').trim())
  );
  const viewMoney = (value) => {
    const amount = Number(value || 0);
    if (isForeignCurrency(viewCurrency)) return `${viewCurrency} ${moneyPlain(amount, viewCurrency)}`;
    return amount.toFixed(2);
  };
  const viewWords = selectedInvoice?.amountInWords || wordsFor(selectedInvoice?.totals?.grandTotal || 0, viewCurrency);

  const balanceDue = useMemo(() => {
    const grandTotal = Number(totals.grandTotal) || 0;
    const received = Number(invoiceDetails.amountReceived) || 0;
    return Math.max(0, grandTotal - received);
  }, [totals.grandTotal, invoiceDetails.amountReceived]);

  const handleFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveInvoice = (e) => {
    e.preventDefault();
    if (!String(billTo.name || customerDetails.companyName || customerDetails.customerName || '').trim()) {
      alert('Please provide Customer Name.');
      return;
    }

    if (isForeignCurrency(currencyCode) && !(Number(invoiceDetails.exchangeRate) > 0)) {
      alert(`Exchange rate (1 ${currencyCode} to INR) is required before saving a non-INR invoice.`);
      return;
    }

    const receivedINR = convertToINR(Number(invoiceDetails.amountReceived) || 0, currencyCode, invoiceDetails.exchangeRate);
    const balanceINR = convertToINR(balanceDue, currencyCode, invoiceDetails.exchangeRate);

    const payload = {
      invoiceDetails: {
        ...invoiceDetails,
        balanceDue
      },
      customerDetails,
      billTo,
      shipTo,
      companyDetails,
      items: computedItems,
      totals,
      amountInWords,
      currency: currencyCode,
      amountINR: totalINR,
      receivedINR,
      balanceINR
    };

    try {
      const stored = localStorage.getItem('customerInvoiceHistory');
      let current = stored ? JSON.parse(stored) : [];
      const entry = {
        date: invoiceDetails.invoiceDate,
        reference: invoiceDetails.invoiceNumber,
        quotationRef: invoiceDetails.quotationRef || '-',
        company: billTo.name || customerDetails.companyName || customerDetails.customerName || '-',
        total: money(totals.grandTotal, currencyCode),
        amountReceived: money(Number(invoiceDetails.amountReceived) || 0, currencyCode),
        balanceDue: money(balanceDue, currencyCode),
        currency: currencyCode,
        amountINR: totalINR,
        receivedINR,
        balanceINR,
        status: invoiceDetails.paymentStatus || 'Pending',
        payload
      };

      const existingIndex = current.findIndex((h) => h.reference === entry.reference);
      if (existingIndex !== -1) {
        current[existingIndex] = entry;
      } else {
        current.unshift(entry);
      }
      saveDocSequence('customerInvoiceSequence', invoiceDetails.invoiceNumber);
      localStorage.setItem('customerInvoiceHistory', JSON.stringify(current));
      setHistory(current);
      setSelectedInvoice(payload);
      setMode('view');

      appendAuditLog({ action: 'INVOICE CREATED', reference: invoiceDetails.invoiceNumber, details: `Customer: ${customerDetails.customerName} | Amount: ${money(totals.grandTotal, currencyCode)}` });
      pushNotification({ title: 'New Customer Invoice', message: `Invoice ${invoiceDetails.invoiceNumber} created for ${customerDetails.customerName || customerDetails.companyName}. Amount: ${money(totals.grandTotal, currencyCode)}.`, type: 'info', reference: invoiceDetails.invoiceNumber, targetDept: 'Accounts Department' });
    } catch (err) {
      console.error('Failed to save invoice', err);
    }
  };

  const handlePrintPDF = () => {
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!selectedInvoice) return;
    try {
      const isLegacy = selectedInvoice.isLegacy;
      const fyLabel = selectedInvoice.fyLabel || 'FY 2026-27';
      const pdfTitle = `Tax Invoice (${fyLabel})`;
      const pdfPayload = {
        ...selectedInvoice,
        documentTitle: pdfTitle,
        forTitle: 'Billed To (Customer):',
        detailsTitle: 'Invoice Details:',
        documentDetails: [
          { label: 'Invoice No', value: selectedInvoice.invoiceDetails?.invoiceNumber || '-' },
          { label: 'Invoice Date', value: selectedInvoice.invoiceDetails?.invoiceDate || '-' },
          { label: 'Due Date', value: selectedInvoice.invoiceDetails?.dueDate || '-' },
          { label: 'Quotation Ref', value: selectedInvoice.invoiceDetails?.quotationRef || '-' },
          { label: 'Project ID', value: selectedInvoice.invoiceDetails?.projectId || '-' }
        ],
        quotationDetails: {
          quotationNumber: selectedInvoice.invoiceDetails?.invoiceNumber,
          quotationDate: selectedInvoice.invoiceDetails?.invoiceDate,
          placeOfSupply: selectedInvoice.billTo?.state || selectedInvoice.customerDetails?.state || '',
          projectId: selectedInvoice.invoiceDetails?.projectId,
          termsAndConditions: selectedInvoice.invoiceDetails?.termsAndConditions,
          notes: selectedInvoice.invoiceDetails?.notes
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
              ? 'Create Customer Invoice'
              : mode === 'view'
              ? `Tax Invoice: ${selectedInvoice?.invoiceDetails?.invoiceNumber || ''}`
              : 'Customer Invoices'}
          </h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to Invoices
            </button>
          ) : (
            <button
              className="button-primary"
              onClick={() => {
                setInvoiceDetails({
                  invoiceNumber: generateInvoiceNumber(),
                  invoiceDate: new Date().toISOString().slice(0, 10),
                  dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
                  quotationRef: '',
                  salesOrderRef: '',
                  projectId: '',
                  placeOfSupply: '',
                  paymentStatus: 'Pending',
                  paymentTerms: 'Due in 30 Days',
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
                setCustomerDetails({
                  customerName: '',
                  companyName: '',
                  address: '',
                  contactNumber: '',
                  email: '',
                  gstNumber: '',
                  state: ''
                });
                setBillTo(makeInvoiceAddress());
                setShipTo(makeInvoiceAddress());
                setMode('create');
              }}
            >
              + Create Invoice
            </button>
          )}
        </div>
      </div>

      {(mode !== 'list' || selectedInvoice?.invoiceDetails?.projectId || invoiceDetails?.projectId) && (
        <WorkflowNavigator
          projectId={selectedInvoice?.invoiceDetails?.projectId || invoiceDetails?.projectId}
          currentStage="customerInvoice"
          sourceDocument={selectedInvoice || location.state?.deliveryChallan || null}
        />
      )}

      <div className="content-block">
        {mode === 'list' && (
          <>
            <div className="tab-nav report-tabs">
              <button type="button" className={`tab-link ${reportTab === 'invoices' ? 'active' : ''}`} onClick={() => setReportTab('invoices')}>
                Invoices
              </button>
              <button type="button" className={`tab-link ${reportTab === 'sales' ? 'active' : ''}`} onClick={() => setReportTab('sales')}>
                Sales Report
              </button>
              <button type="button" className={`tab-link ${reportTab === 'receivables' ? 'active' : ''}`} onClick={() => setReportTab('receivables')}>
                Accounts Receivable
              </button>
              <button type="button" className={`tab-link ${reportTab === 'advances' ? 'active' : ''}`} onClick={() => setReportTab('advances')}>
                Advances Received
              </button>
            </div>

            {reportTab === 'invoices' && (
            <>
            <div className="block-header">
              <h2>Invoice History</h2>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table customer-invoice-history-table">
                <colgroup>
                  <col className="customer-invoice-history-date" />
                  <col className="customer-invoice-history-number" />
                  <col className="customer-invoice-history-quotation" />
                  <col className="customer-invoice-history-customer" />
                  <col className="customer-invoice-history-job-card" />
                  <col className="customer-invoice-history-total" />
                  <col className="customer-invoice-history-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Invoice No</th>
                    <th>Quotation Ref</th>
                    <th>Customer / Company</th>
                    <th>Job Card (QC)</th>
                    <th className="customer-invoice-total-cell">Total Value</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length > 0 ? (
                    history.map((inv, idx) => {
                      const invoicePayload = inv.payload || {};
                      const invoiceProject = invoicePayload.invoiceDetails?.projectId;
                      const linkedJobCard = invoiceProject ? getFullProjectData(invoiceProject, invoicePayload) : null;
                      const qcPassed = Boolean(linkedJobCard?.jobCardComplete);
                      return (
                      <tr key={idx}>
                        <td>{inv.date}</td>
                        <td><strong>{inv.reference}</strong></td>
                        <td>{inv.quotationRef || '-'}</td>
                        <td>{inv.company}</td>
                        <td style={{ color: qcPassed ? '#166534' : '#64748b', fontWeight: qcPassed ? 600 : 400 }}>
                          {linkedJobCard?.jobCardNumber ? `${linkedJobCard.jobCardNumber} · ${qcPassed ? 'Completed / QC Pass' : 'Pending'}` : 'Not linked · Pending'}
                        </td>
                        <td className="customer-invoice-total-cell">{inv.total}</td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="button-small"
                              onClick={() => {
                                setSelectedInvoice(inv.payload);
                                setMode('view');
                              }}
                            >
                              View / Print
                            </button>
                            <button
                              className="button-small"
                              onClick={() => {
                                const p = inv.payload;
                                setInvoiceDetails(p.invoiceDetails);
                                setCustomerDetails(p.customerDetails);
                                setBillTo(getInvoiceBillTo(p));
                                setShipTo(getInvoiceShipTo(p));
                                setCompanyDetails(p.companyDetails);
                                setItems(p.items);
                                setMode('create');
                              }}
                            >
                              Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan="7" className="no-history-row">
                        No Invoices yet. Convert a Quotation or click "+ Create Invoice".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            </>
            )}

            {reportTab === 'sales' && (
              <ReportRegister
                title="Sales Report"
                subTitle="Customer Invoices (Sales Register)"
                filename={`Sales-Report-${new Date().toISOString().slice(0, 10)}`}
                dateField="date"
                columns={[
                  { key: 'date', label: 'Date' },
                  { key: 'reference', label: 'Invoice No' },
                  { key: 'quotationRef', label: 'Quotation Ref', render: (r) => r.quotationRef || '-' },
                  { key: 'company', label: 'Customer / Company' },
                  { key: 'gt', label: 'Gross Total (INR)', align: 'right', render: invTotalCell },
                  { key: 'received', label: 'Received (INR)', align: 'right', render: invReceivedCell },
                  { key: 'bal', label: 'Balance Due (INR)', align: 'right', render: invBalanceCell },
                ]}
                rows={history}
                excludeCommonFilterKeys={['status']}
                totals={[
                  { colKey: 'gt', render: (rs) => rs.reduce((a, r) => a + invTotalINR(r), 0) },
                  { colKey: 'received', render: (rs) => rs.reduce((a, r) => a + invReceivedINR(r), 0) },
                  { colKey: 'bal', render: (rs) => rs.reduce((a, r) => a + invBalanceINR(r), 0) }
                ]}
              />
            )}

            {reportTab === 'receivables' && (
              <ReportRegister
                title="Accounts Receivable"
                subTitle="Outstanding customer balances"
                filename={`Accounts-Receivable-${new Date().toISOString().slice(0, 10)}`}
                dateField="date"
                columns={[
                  { key: 'date', label: 'Invoice Date' },
                  { key: 'reference', label: 'Invoice No' },
                  { key: 'company', label: 'Customer / Company' },
                  { key: 'gt', label: 'Invoice Total (INR)', align: 'right', render: invTotalCell },
                  { key: 'received', label: 'Received (INR)', align: 'right', render: invReceivedCell },
                  { key: 'bal', label: 'Outstanding (INR)', align: 'right', render: invBalanceCell },
                ]}
                rows={history.filter((r) => r.status !== 'Paid')}
                excludeCommonFilterKeys={['status']}
                totals={[
                  { colKey: 'gt', render: (rs) => rs.reduce((a, r) => a + invTotalINR(r), 0) },
                  { colKey: 'received', render: (rs) => rs.reduce((a, r) => a + invReceivedINR(r), 0) },
                  { colKey: 'bal', render: (rs) => rs.reduce((a, r) => a + invBalanceINR(r), 0) }
                ]}
              />
            )}

            {reportTab === 'advances' && (
              <AdvanceRegister
                storageKey="customerAdvanceHistory"
                title="Advance Received from Customers"
                filenamer={`Advance-Received-${new Date().toISOString().slice(0, 10)}`}
                partyLabel="Customer"
                prefix="CAR"
                againstLabel="Against Invoice / SO / PO"
              />
            )}
          </>
        )}

        {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSaveInvoice}>
            <div className="form-section">
              <div className="section-heading">
                <h3>Invoice Meta Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Invoice Number</label>
                  <input
                    type="text"
                    value={invoiceDetails.invoiceNumber}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, invoiceNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Quotation Ref</label>
                  <input
                    type="text"
                    value={invoiceDetails.quotationRef}
                    placeholder="e.g. QT-260829-101"
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, quotationRef: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Invoice Date</label>
                  <input
                    type="date"
                    value={invoiceDetails.invoiceDate}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, invoiceDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Due Date</label>
                  <input
                    type="date"
                    value={invoiceDetails.dueDate}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, dueDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Payment Terms</label>
                  <input
                    type="text"
                    value={invoiceDetails.paymentTerms}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, paymentTerms: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Amount Received / Advance ({getCurrency(currencyCode).symbol})</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="e.g. 50000"
                    value={invoiceDetails.amountReceived || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      const num = Number(val) || 0;
                      const grandTotal = Number(totals.grandTotal) || 0;
                      let st = 'Pending';
                      if (num >= grandTotal && grandTotal > 0) st = 'Paid';
                      else if (num > 0) st = 'Partial';
                      setInvoiceDetails({ ...invoiceDetails, amountReceived: val, paymentStatus: st });
                    }}
                  />
                  <div style={{ fontSize: '11px', color: balanceDue > 0 ? '#b91c1c' : '#166534', fontWeight: 'bold', marginTop: '3px' }}>
                    Balance Due: {money(balanceDue, currencyCode)}
                  </div>
                </div>
                <div className="field-group">
                  <label>Currency</label>
                  <select
                    value={currencyCode}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, currency: e.target.value })}
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
                      value={invoiceDetails.exchangeRate}
                      onChange={(e) => setInvoiceDetails({ ...invoiceDetails, exchangeRate: e.target.value })}
                      placeholder="e.g. 83.4500"
                    />
                  </div>
                )}
                <div className="field-group">
                  <label>Tax Treatment</label>
                  <select
                    value={taxMode}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, taxMode: e.target.value })}
                  >
                    <option value="intra">CGST + SGST (within state)</option>
                    <option value="inter">IGST (inter-state)</option>
                    <option value="export">Export / LUT - zero rated</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>Project ID (Master Auto-link)</label>
                  <ProjectIdAutocomplete
                    value={invoiceDetails.projectId}
                    onChange={(val) => setInvoiceDetails((prev) => ({ ...prev, projectId: val }))}
                    onSelectProject={(pid, fullData) => handleProjectLookup(pid, fullData)}
                    placeholder="Search or select Project ID (e.g. PE-2627-0001)..."
                    autoLinkMsg={projectAutoLinkMsg}
                  />
                </div>
                <div className="field-group">
                  <label>Place of Supply</label>
                  <input
                    type="text"
                    value={invoiceDetails.placeOfSupply}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, placeOfSupply: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="invoice-address-grid">
              <div className="form-section">
                <div className="section-heading">
                  <h3>Bill To</h3>
                </div>
                <div className="invoice-address-fields">
                  <div className="field-group invoice-address-full-width">
                    <label>Customer / Company Name *</label>
                    <input
                      type="text"
                      list="customer-master-options"
                      required
                      value={billTo.name}
                      onChange={(e) => handleCustomerNameChange(e.target.value)}
                    />
                    <datalist id="customer-master-options">
                      {masterCustomers.map((customer, index) => {
                        const name = customer.companyName || customer.customerName;
                        return name ? <option key={`${name}-${index}`} value={name} /> : null;
                      })}
                    </datalist>
                  </div>
                  <div className="field-group invoice-address-full-width">
                    <label>Billing Address</label>
                    <textarea
                      rows="3"
                      value={billTo.address}
                      onChange={(e) => updateBillTo('address', e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label>City</label>
                    <input value={billTo.city} onChange={(e) => updateBillTo('city', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>State</label>
                    <input value={billTo.state} onChange={(e) => updateBillTo('state', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>PIN Code</label>
                    <input value={billTo.pinCode} onChange={(e) => updateBillTo('pinCode', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>GSTIN</label>
                    <input value={billTo.gstNumber} onChange={(e) => updateBillTo('gstNumber', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>Contact Number</label>
                    <input value={billTo.contactNumber} onChange={(e) => updateBillTo('contactNumber', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>Email</label>
                    <input
                      type="email"
                      value={customerDetails.email || ''}
                      onChange={(e) => setCustomerDetails((previous) => ({ ...previous, email: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div className="section-heading">
                  <h3>Ship To</h3>
                </div>
                <div className="invoice-address-fields">
                  <div className="field-group invoice-address-full-width">
                    <label>Consignee / Company Name</label>
                    <input
                      value={shipTo.name}
                      onChange={(e) => updateShipTo('name', e.target.value)}
                    />
                  </div>
                  <div className="field-group invoice-address-full-width">
                    <label>Shipping Address</label>
                    <textarea
                      rows="3"
                      value={shipTo.address}
                      onChange={(e) => updateShipTo('address', e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label>City</label>
                    <input value={shipTo.city} onChange={(e) => updateShipTo('city', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>State</label>
                    <input value={shipTo.state} onChange={(e) => updateShipTo('state', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>PIN Code</label>
                    <input value={shipTo.pinCode} onChange={(e) => updateShipTo('pinCode', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>GSTIN</label>
                    <input value={shipTo.gstNumber} onChange={(e) => updateShipTo('gstNumber', e.target.value)} />
                  </div>
                  <div className="field-group">
                    <label>Contact Number</label>
                    <input value={shipTo.contactNumber} onChange={(e) => updateShipTo('contactNumber', e.target.value)} />
                  </div>
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Invoice Line Items</h3>
              </div>
              <div className="item-table-wrapper">
                <table className="item-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>SL.No</th>
                      <th style={{ width: '260px' }}>Item Description</th>
                      <th style={{ width: '130px' }}>Drawing No.</th>
                      <th style={{ width: '120px' }}>Lot No.</th>
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
                            value={item.lotNumber || item.lotNo || ''}
                            onChange={(e) => handleFieldChange(idx, 'lotNumber', e.target.value)}
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
                      <td colSpan={11}>
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
                      value={invoiceDetails.discount}
                      onChange={(e) => setInvoiceDetails({ ...invoiceDetails, discount: e.target.value })}
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
                  value={invoiceDetails.termsAndConditions}
                  onChange={(e) => setInvoiceDetails({ ...invoiceDetails, termsAndConditions: e.target.value })}
                />
              </div>
              <div className="field-group full-width" style={{ marginTop: '16px' }}>
                <label>Notes</label>
                <textarea
                  rows="2"
                  value={invoiceDetails.notes}
                  onChange={(e) => setInvoiceDetails({ ...invoiceDetails, notes: e.target.value })}
                />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setMode('list')}>
                Cancel
              </button>
              <button type="submit" className="button-primary">
                Save Tax Invoice
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedInvoice && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end' }}>
              <button className="button-primary" onClick={handleDownloadPDF}>
                Download PDF
              </button>
              <button className="button-secondary" onClick={handlePrintPDF}>
                Print Invoice
              </button>
              <button
                className="button-secondary"
                onClick={() => {
                  setInvoiceDetails(selectedInvoice.invoiceDetails);
                  setCustomerDetails(selectedInvoice.customerDetails);
                  setBillTo(getInvoiceBillTo(selectedInvoice));
                  setShipTo(getInvoiceShipTo(selectedInvoice));
                  setCompanyDetails(selectedInvoice.companyDetails);
                  setItems(selectedInvoice.items);
                  setMode('create');
                }}
              >
                Edit Invoice
              </button>
            </div>

            <div className="doc-page-container">
              <div className="quotation-doc-sheet printable">
                <h1 className="doc-main-title">Tax Invoice</h1>

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
                  <InvoiceAddressDocumentBox title="Bill To (Billing Address):" address={viewBillTo} />
                  <InvoiceAddressDocumentBox title="Ship To (Shipping Address):" address={viewShipTo} />
                </div>

                <div className="doc-full-box invoice-document-details">
                  <div className="doc-box-title">Invoice Details:</div>
                  <div className="invoice-document-details-grid">
                      <div><strong>Invoice No:</strong> {selectedInvoice.invoiceDetails?.invoiceNumber || '-'}</div>
                      <div><strong>Invoice Date:</strong> {selectedInvoice.invoiceDetails?.invoiceDate || '-'}</div>
                      {selectedInvoice.invoiceDetails?.dueDate && (
                        <div><strong>Due Date:</strong> {selectedInvoice.invoiceDetails.dueDate}</div>
                      )}
                      {selectedInvoice.invoiceDetails?.quotationRef && (
                        <div><strong>Quotation Ref:</strong> {selectedInvoice.invoiceDetails.quotationRef}</div>
                      )}
                      {selectedInvoice.invoiceDetails?.projectId && (
                        <div><strong>Project ID:</strong> {selectedInvoice.invoiceDetails.projectId}</div>
                      )}
                      <div>
                        <strong>Currency:</strong> {viewCurrency}
                        {isForeignCurrency(viewCurrency) && selectedInvoice.invoiceDetails?.exchangeRate
                          ? ` (1 ${viewCurrency} = ${selectedInvoice.invoiceDetails.exchangeRate} INR)`
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

                {/* Items Table */}
                <table className="doc-items-table">
                  <thead>
                    <tr>
                      <th className="th-slno">SL.No</th>
                      <th style={{ textAlign: 'left', width: '120px' }}>Drawing No.</th>
                      <th style={{ textAlign: 'left' }}>Item Description</th>
                      {viewHasAnyLotNumber && (
                        <th style={{ textAlign: 'left', width: '100px' }}>Lot No.</th>
                      )}
                      <th className="th-hsnSac">HSN/SAC</th>
                      <th className="th-quantity text-right">Qty</th>
                      <th className="th-unit text-center">Unit</th>
                      <th className="th-unitPrice text-right">Price</th>
                      <th className="th-gst text-right">GST%</th>
                      <th className="th-amount text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedInvoice.items?.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-center">{idx + 1}</td>
                        <td className="text-left">{item.drawingNo || '-'}</td>
                        <td className="text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                        </td>
                        {viewHasAnyLotNumber && (
                          <td className="text-left">{String(item.lotNumber || item.lotNo || '').trim() || '-'}</td>
                        )}
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
                      <td colSpan={viewHasAnyLotNumber ? 5 : 4} className="font-bold text-left">Total</td>
                      <td className="font-bold text-right">
                        {selectedInvoice.items?.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
                      </td>
                      <td></td>
                      <td></td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedInvoice.totals?.totalGST)}
                      </td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedInvoice.totals?.subtotal)}
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
                          {selectedInvoice?.invoiceDetails?.notes || selectedInvoice?.notes || '-'}
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
                          {viewMoney(selectedInvoice.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Taxable</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedInvoice.totals?.taxableAmount || selectedInvoice.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax rate</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {selectedInvoice.items?.find(i => Number(i.gst) > 0)?.gst ? `${selectedInvoice.items.find(i => Number(i.gst) > 0).gst}%` : (selectedInvoice.items?.[0]?.gst ? `${selectedInvoice.items[0].gst}%` : '0%')}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax Amount</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedInvoice.totals?.totalGST)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1.5px solid #0f172a', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Other</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedInvoice.totals?.otherCharges)}
                        </td>
                      </tr>
                      <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                        <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>
                          {viewMoney(selectedInvoice.totals?.grandTotal)}
                        </td>
                      </tr>
                      {(Number(selectedInvoice.invoiceDetails?.amountReceived) > 0 ||
                        selectedInvoice.invoiceDetails?.paymentStatus === 'Paid') && (
                        <>
                          <tr style={{ borderTop: '1px solid #cbd5e1', color: '#166534' }}>
                            <td style={{ padding: '5px 10px', borderRight: '1px solid #cbd5e1' }}>Amount Received</td>
                            <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: '600' }}>
                              {selectedInvoice.invoiceDetails?.paymentStatus === 'Paid'
                                ? viewMoney(selectedInvoice.totals?.grandTotal)
                                : viewMoney(selectedInvoice.invoiceDetails?.amountReceived)}
                            </td>
                          </tr>
                          <tr style={{
                            fontWeight: 'bold',
                            color: Number(selectedInvoice.invoiceDetails?.balanceDue) > 0 && selectedInvoice.invoiceDetails?.paymentStatus !== 'Paid' ? '#b91c1c' : '#166534'
                          }}>
                            <td style={{ padding: '5px 10px', borderRight: '1px solid #cbd5e1' }}>Balance Payable</td>
                            <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                              {selectedInvoice.invoiceDetails?.paymentStatus === 'Paid'
                                ? '0.00'
                                : viewMoney(selectedInvoice.invoiceDetails?.balanceDue)}
                            </td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Notes */}
                {selectedInvoice.invoiceDetails?.notes && (
                  <div className="doc-full-box">
                    <div className="doc-box-title">Notes:</div>
                    <div className="doc-box-text">{selectedInvoice.invoiceDetails.notes}</div>
                  </div>
                )}

                {/* Terms and Signatory */}
                <div className="doc-bottom-split">
                  <div className="doc-terms-box">
                    <div className="doc-box-title">Terms & Conditions:</div>
                    <div className="doc-terms-list">
                      {selectedInvoice.invoiceDetails?.termsAndConditions ? (
                        selectedInvoice.invoiceDetails.termsAndConditions.split(/\r?\n/).map((t, idx) => (
                          <div key={idx} className="doc-term-item">{t}</div>
                        ))
                      ) : (
                        <div className="doc-term-item">Payment due within agreed terms. Goods once sold will not be taken back.</div>
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

export default CustomerInvoicePage;
