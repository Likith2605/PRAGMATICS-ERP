import React, { useState, useEffect, useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import AddableSelect from '../components/AddableSelect.jsx';
import { DEFAULT_UNITS } from '../utils/addableMasters.js';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding, getCompanyProfile } from '../utils/companyBranding.js';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from '../utils/calculations.js';
import { numberToWords } from '../utils/numberToWords.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import ReportRegister from '../components/ReportRegister.jsx';
import AdvanceRegister from '../components/AdvanceRegister.jsx';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterMaterialRecords } from '../utils/historySearch.js';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import { listMasters } from '../services/masterApi.js';
import { listSupplierInvoicesApi, createSupplierInvoiceApi, updateSupplierInvoiceApi, getSupplierInvoiceMigrationPreviewApi, importSupplierInvoicesApi, listPurchaseOrders, getPurchaseOrder } from '../services/procurementIntakeApi.js';
import { isAdmin } from '../utils/auth.js';
import { listMaterialReceiptsApi } from '../services/materialReceiptApi.js';
import {
  getReceipts,
  getReceiptInvoiceValue,
  getSupplierInvoicePrefill,
} from '../utils/workflowService.js';

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

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

const SupplierInvoicePage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [history, setHistory] = useState([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const [pendingInvoiceCreateToken, setPendingInvoiceCreateToken] = useState('');
  const [migrationPreview, setMigrationPreview] = useState(null);
  const [migrationSelection, setMigrationSelection] = useState([]);
  const [migrationMessage, setMigrationMessage] = useState('');
  const [poList, setPoList] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [reportTab, setReportTab] = useState('invoices'); // 'invoices' | 'purchase' | 'payables' | 'advances'
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [vendorInvoiceSearch, setVendorInvoiceSearch] = useState('');
  const [purchaseSearch, setPurchaseSearch] = useState('');
  const [payablesSearch, setPayablesSearch] = useState('');
  const [advanceSearch, setAdvanceSearch] = useState('');

  // Form states
  const [invoiceDetails, setInvoiceDetails] = useState({
    supplierInvoiceNumber: '',
    supplierInvoiceDate: new Date().toISOString().slice(0, 10),
    paymentDueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    poReference: '',
    projectId: '',
    paymentTerms: '30 Days Net',
    paymentStatus: 'Pending', // 'Pending' | 'Partial' | 'Paid'
    amountPaid: '0',
    advanceAdjusted: 0,
    advanceAdjustedINR: 0,
    paymentMode: 'Bank Transfer (NEFT/RTGS)',
    paymentReference: '',
    paymentDate: '',
    discount: '',
    notes: '',
    termsAndConditions: 'Payment subject to quality verification and GRN inspection approval.'
  });

  const [vendorDetails, setVendorDetails] = useState({
    vendorName: '',
    companyName: '',
    address: '',
    contactNumber: '',
    email: '',
    gstNumber: '',
    state: ''
  });

  const [companyDetails, setCompanyDetails] = useState(() => getCompanyProfile());
  const [vendorMasterRecords, setVendorMasterRecords] = useState([]);
  const [vendorMasterError, setVendorMasterError] = useState('');

  const [items, setItems] = useState([{ ...emptyItem }]);

  // PostgreSQL is authoritative; localStorage is refreshed only after the API confirms.
  useEffect(() => {
    let active = true;
    listMasters('vendors')
      .then((records) => { if (active) { setVendorMasterRecords(records); setVendorMasterError(''); } })
      .catch((error) => { if (active) { setVendorMasterRecords([]); setVendorMasterError(`Vendor Master could not be loaded from PostgreSQL: ${error.message}`); } });
    listSupplierInvoicesApi().then((rows) => { if (active) { setHistory(rows); setHistoryError(''); setHistoryReady(true); } })
      .catch((error) => { if (active) { setHistory([]); setHistoryError(`Supplier Invoices could not be loaded from PostgreSQL: ${error.message}`); setHistoryReady(false); } });
    /* Purchase Orders are loaded from PostgreSQL so PO references, progress and
     * amounts on this screen never come from a browser-only list. */
    listPurchaseOrders().then((rows) => { if (active) setPoList(rows); })
      .catch((error) => { if (active) { setPoList([]); console.warn(`Purchase Orders could not be loaded from PostgreSQL: ${error.message}`); } });
    return () => { active = false; };
  }, []);

  const [poAutoLinkMsg, setPoAutoLinkMsg] = useState('');

  /* Vendor invoices the Store recorded on Material Receipts and shared with
     Purchase — these are the documents Purchase turns into a Supplier Invoice. */
  const [vendorInvoices, setVendorInvoices] = useState([]);
  const [sourceReceipt, setSourceReceipt] = useState('');

  const openMigrationPreview = async () => {
    try {
      const preview = await getSupplierInvoiceMigrationPreviewApi();
      setMigrationPreview(preview);
      setMigrationSelection([]);
      setMigrationMessage('');
    } catch (error) { setMigrationMessage(`Migration preview failed: ${error.message}`); }
  };
  const importSelectedLegacyInvoices = async () => {
    if (!migrationSelection.length) return;
    try {
      const result = await importSupplierInvoicesApi(migrationSelection);
      setHistory(result.records);
      setMigrationMessage(`Imported ${result.imported.length}; unchanged conflicts ${result.conflicts.length}; skipped ${result.skipped.length}.`);
      setMigrationPreview(null);
      setHistoryReady(true);
    } catch (error) { setMigrationMessage(`Import failed: ${error.message}`); }
  };

  const refreshVendorInvoices = async () => {
    try {
      const records = await listMaterialReceiptsApi();
      setVendorInvoices(records.filter((r) => String(r.invoiceNumber || '').trim()));
    } catch (error) {
      setVendorInvoices([]);
      setMigrationMessage(`Material Receipts could not be loaded from PostgreSQL: ${error.message}`);
    }
  };

  useEffect(() => {
    refreshVendorInvoices();
  }, []);

  useEffect(() => {
    if (mode === 'list') refreshVendorInvoices();
  }, [mode]);

  /** Start the Supplier Invoice from the vendor invoice Store already recorded. */
  const handleConvertReceipt = (receiptNumber) => {
    try {
      setPendingInvoiceCreateToken('');
      const prefill = getSupplierInvoicePrefill(receiptNumber);
      setInvoiceDetails((prev) => ({
        ...prev,
        poReference: prefill.poReference,
        projectId: prefill.projectId,
        supplierInvoiceNumber: '',
        supplierInvoiceDate: new Date().toISOString().slice(0, 10),
        notes: prefill.notes
      }));
      setVendorDetails((prev) => ({
        ...prev,
        companyName: prefill.vendorName || prev.companyName
      }));
      setItems(prefill.items.map((i) => ({ ...emptyItem, ...i })));
      setSourceReceipt(receiptNumber);
      setPoAutoLinkMsg(
        `✓ Vendor invoice ${prefill.vendorInvoiceNumber} (receipt ${prefill.receiptNumber}) on PO ${prefill.poReference}`
      );
      setMode('create');
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => {
    if (location.state?.fromPO && location.state?.po) {
      const p = location.state.po;
      setInvoiceDetails((prev) => ({
        ...prev,
        poReference: p.poDetails?.poNumber || '',
        projectId: p.poDetails?.projectRef || '',
        paymentTerms: p.poDetails?.paymentTerms || '30 Days from Invoice',
        discount: p.poDetails?.discount || '',
        notes: `Vendor Bill against Purchase Order ${p.poDetails?.poNumber || ''}`
      }));
      if (p.vendorDetails) setVendorDetails(p.vendorDetails);
      if (p.items && p.items.length > 0) setItems(p.items);
      setPoAutoLinkMsg(`✓ Linked to PO: ${p.poDetails?.poNumber || ''} (${p.vendorDetails?.companyName || p.vendorDetails?.vendorName || ''})`);
      setMode('create');
    } else if (location.state?.viewInvoice) {
      setSelectedInvoice(location.state.viewInvoice);
      setMode('view');
    }
  }, [location.state]);

  /* Notification deep link: /supplier-invoice?receipt=MR-xxxx converts the
     vendor invoice Store recorded on that Material Receipt. */
  useEffect(() => {
    const rec = searchParams.get('receipt');
    if (!rec) return;
    setSearchParams({}, { replace: true });
    /* Resolve the receipt from PostgreSQL, not the browser cache. */
    listMaterialReceiptsApi()
      .then((records) => {
        const receipt = records.find((r) => String(r.receiptNumber) === String(rec));
        if (receipt && String(receipt.invoiceNumber || '').trim()) handleConvertReceipt(rec);
        else if (receipt) handleSelectPO(String(receipt.poNumber || receipt.poReference || ''));
      })
      .catch((error) => console.warn(`Material Receipt ${rec} could not be loaded from PostgreSQL: ${error.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleSelectPO = (poRef) => {
    if (!poRef || !poRef.trim()) {
      setPoAutoLinkMsg('');
      return;
    }
    const cleanRef = poRef.trim().toLowerCase();
    const match = poList.find(
      (p) =>
        p.reference?.trim().toLowerCase() === cleanRef ||
        p.payload?.poDetails?.poNumber?.trim().toLowerCase() === cleanRef
    );
    if (match && match.payload) {
      const p = match.payload;
      setInvoiceDetails((prev) => ({
        ...prev,
        poReference: p.poDetails?.poNumber || match.reference || poRef,
        projectId: p.poDetails?.projectRef || prev.projectId,
        paymentTerms: p.poDetails?.paymentTerms || prev.paymentTerms,
        discount: p.poDetails?.discount || '',
        notes: `Vendor Bill against Purchase Order ${p.poDetails?.poNumber || match.reference}`
      }));

      if (p.vendorDetails) setVendorDetails(p.vendorDetails);
      if (p.items && p.items.length > 0) setItems(p.items);
      setPoAutoLinkMsg(`✓ Linked to PO: ${p.poDetails?.poNumber || match.reference} (${p.vendorDetails?.companyName || p.vendorDetails?.vendorName || ''})`);
    } else {
      setPoAutoLinkMsg('');
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

  const totals = useMemo(() => calculateTotals(computedItems, invoiceDetails.discount), [computedItems, invoiceDetails.discount]);
  const amountInWords = useMemo(() => numberToWords(totals.grandTotal), [totals.grandTotal]);

  const balanceDue = useMemo(() => {
    const total = Number(totals.grandTotal) || 0;
    const paid = Number(invoiceDetails.amountPaid) || 0;
    const advanceAdjusted = Number(invoiceDetails.advanceAdjusted) || 0;
    return Math.max(0, total - paid - advanceAdjusted);
  }, [totals.grandTotal, invoiceDetails.amountPaid, invoiceDetails.advanceAdjusted]);

  // KPIs
  const kpis = useMemo(() => {
    let totalInvoices = history.length;
    let totalPayable = 0;
    let pendingDues = 0;
    let paidCount = 0;

    history.forEach((h) => {
      const grandTotal = Number(h.payload?.totals?.grandTotal) || 0;
      const paid = Number(h.payload?.invoiceDetails?.amountPaid) || 0;
      const advanceAdjusted = Number(h.payload?.invoiceDetails?.advanceAdjusted) || 0;
      totalPayable += grandTotal;
      if (h.status === 'Paid') {
        paidCount++;
      } else {
        pendingDues += Math.max(0, grandTotal - paid - advanceAdjusted);
      }
    });

    return { totalInvoices, totalPayable, pendingDues, paidCount };
  }, [history]);

  const handleFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveInvoice = async (e) => {
    e.preventDefault();
    if (!invoiceDetails.supplierInvoiceNumber.trim()) {
      alert('Please enter Supplier Invoice / Bill Number.');
      return;
    }
    if (!vendorDetails.companyName.trim() && !vendorDetails.vendorName.trim()) {
      alert('Please enter Vendor / Supplier Name.');
      return;
    }

    const payload = {
      invoiceDetails: {
        ...invoiceDetails,
        balanceDue
      },
      vendorDetails,
      companyDetails,
      items: computedItems,
      totals,
      amountInWords
    };

    if (!historyReady) { alert('Supplier Invoice records are not confirmed from PostgreSQL. Reload before saving.'); return; }
    setSavingInvoice(true);
    try {
      const entry = {
        date: invoiceDetails.supplierInvoiceDate,
        reference: invoiceDetails.supplierInvoiceNumber,
        poRef: invoiceDetails.poReference || '-',
        receiptNumber: sourceReceipt || '',
        vendor: vendorDetails.companyName || vendorDetails.vendorName || '-',
        dueDate: invoiceDetails.paymentDueDate || '-',
        total: `₹ ${Number(totals.grandTotal || 0).toFixed(2)}`,
        status: invoiceDetails.paymentStatus || 'Pending',
        balanceDue: `₹ ${balanceDue.toFixed(2)}`,
        payload
      };
      let createToken = pendingInvoiceCreateToken;
      if (!editingInvoice && !createToken) {
        createToken = `supplier-invoice:${crypto.randomUUID()}`;
        setPendingInvoiceCreateToken(createToken);
      }
      const result = editingInvoice
        ? await updateSupplierInvoiceApi(editingInvoice.reference, entry, editingInvoice.version)
        : await createSupplierInvoiceApi(entry, createToken);
      const current = [result.record, ...history.filter((h) => String(h.reference) !== String(result.record.reference))];
      setHistory(current);
      setEditingInvoice(null);
      setPendingInvoiceCreateToken('');

      setSelectedInvoice(payload);
      setMode('view');

      // The Supplier Invoice API atomically links the confirmed invoice to the
      // PostgreSQL receipt; only clear the page's source after confirmation.
      if (sourceReceipt) setSourceReceipt('');
      refreshVendorInvoices();
    } catch (err) {
      alert(`Supplier Invoice was not saved: ${err.message}`);
    } finally {
      setSavingInvoice(false);
    }
  };

  const handlePrintPDF = async () => {
    if (!selectedInvoice) return;
    try {
      const pdfPayload = {
        ...selectedInvoice,
        documentTitle: 'Supplier Invoice',
        forTitle: 'Supplier / Vendor:',
        detailsTitle: 'Invoice / Bill Details:',
        customerDetails: selectedInvoice.vendorDetails,
        documentDetails: [
          { label: 'Supplier Bill No', value: selectedInvoice.invoiceDetails?.supplierInvoiceNumber || '-' },
          { label: 'Bill Date', value: selectedInvoice.invoiceDetails?.supplierInvoiceDate || '-' },
          { label: 'Payment Due Date', value: selectedInvoice.invoiceDetails?.paymentDueDate || '-' },
          { label: 'PO Ref', value: selectedInvoice.invoiceDetails?.poReference || '-' },
          { label: 'Paid', value: `Rs ${Number(selectedInvoice.invoiceDetails?.amountPaid || 0).toFixed(2)}` }
        ],
        quotationDetails: {
          quotationNumber: selectedInvoice.invoiceDetails?.supplierInvoiceNumber,
          quotationDate: selectedInvoice.invoiceDetails?.supplierInvoiceDate,
          placeOfSupply: selectedInvoice.vendorDetails?.state || '',
          projectId: selectedInvoice.invoiceDetails?.poReference,
          termsAndConditions: selectedInvoice.invoiceDetails?.termsAndConditions,
          notes: selectedInvoice.invoiceDetails?.notes
        }
      };
      await generateQuotationPDF(pdfPayload, { print: true });
    } catch {
      window.print();
    }
  };

  const handleDownloadPDF = async () => {
    if (!selectedInvoice) return;
    try {
      const pdfPayload = {
        ...selectedInvoice,
        documentTitle: 'Supplier Invoice',
        forTitle: 'Supplier / Vendor:',
        detailsTitle: 'Invoice / Bill Details:',
        customerDetails: selectedInvoice.vendorDetails,
        documentDetails: [
          { label: 'Supplier Bill No', value: selectedInvoice.invoiceDetails?.supplierInvoiceNumber || '-' },
          { label: 'Bill Date', value: selectedInvoice.invoiceDetails?.supplierInvoiceDate || '-' },
          { label: 'Payment Due Date', value: selectedInvoice.invoiceDetails?.paymentDueDate || '-' },
          { label: 'PO Ref', value: selectedInvoice.invoiceDetails?.poReference || '-' },
          { label: 'Paid', value: `Rs ${Number(selectedInvoice.invoiceDetails?.amountPaid || 0).toFixed(2)}` }
        ],
        quotationDetails: {
          quotationNumber: selectedInvoice.invoiceDetails?.supplierInvoiceNumber,
          quotationDate: selectedInvoice.invoiceDetails?.supplierInvoiceDate,
          placeOfSupply: selectedInvoice.vendorDetails?.state || '',
          projectId: selectedInvoice.invoiceDetails?.poReference,
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
              ? 'Record Supplier Invoice (Vendor Bill)'
              : mode === 'view'
              ? `Supplier Bill: ${selectedInvoice?.invoiceDetails?.supplierInvoiceNumber || ''}`
              : 'Supplier Invoices'}
          </h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to Invoices
            </button>
          ) : (
            <button
              className="button-primary"
              onClick={() => {
                  setEditingInvoice(null);
                  setPendingInvoiceCreateToken('');
                setInvoiceDetails({
                  supplierInvoiceNumber: '',
                  supplierInvoiceDate: new Date().toISOString().slice(0, 10),
                  paymentDueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
                  poReference: '',
                  projectId: '',
                  paymentTerms: '30 Days Net',
                  paymentStatus: 'Pending',
                  amountPaid: '0',
                  advanceAdjusted: 0,
                  advanceAdjustedINR: 0,
                  paymentMode: 'Bank Transfer (NEFT/RTGS)',
                  paymentReference: '',
                  paymentDate: '',
                  discount: '',
                  notes: '',
                  termsAndConditions: 'Payment subject to quality verification and GRN inspection approval.'
                });
                setItems([{ ...emptyItem }]);
                setSourceReceipt('');
                setPoAutoLinkMsg('');
                setMode('create');
              }}
            >
              + Record Supplier Invoice
            </button>
          )}
        </div>
      </div>

      {/* Accounts Payable KPIs */}
      {mode === 'list' && (
        <div className="kpi-grid" style={{ marginBottom: '24px' }}>
          <div className="kpi-card">
            <span className="kpi-title">Total Invoices Logged</span>
            <div className="kpi-value">{kpis.totalInvoices}</div>
            <span className="kpi-delta neutral">Vendor bills on record</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Total Purchases Incurred</span>
            <div className="kpi-value">₹ {kpis.totalPayable.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            <span className="kpi-delta positive">Billed procurement value</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Outstanding Payable Balance</span>
            <div className="kpi-value" style={{ color: kpis.pendingDues > 0 ? '#b91c1c' : '#166534' }}>
              ₹ {kpis.pendingDues.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </div>
            <span className="kpi-delta negative">Due to suppliers</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Settled / Paid Bills</span>
            <div className="kpi-value" style={{ color: '#166534' }}>{kpis.paidCount} Bills</div>
            <span className="kpi-delta positive">Fully cleared payments</span>
          </div>
        </div>
      )}

      <div className="content-block">
        {mode === 'list' && (
          <>
            <div className="tab-nav report-tabs">
              <button type="button" className={`tab-link ${reportTab === 'invoices' ? 'active' : ''}`} onClick={() => setReportTab('invoices')}>
                Supplier Bills
              </button>
              <button type="button" className={`tab-link ${reportTab === 'vendor' ? 'active' : ''}`} onClick={() => setReportTab('vendor')}>
                Vendor Invoices from Store
              </button>
              <button type="button" className={`tab-link ${reportTab === 'purchase' ? 'active' : ''}`} onClick={() => setReportTab('purchase')}>
                Purchase Report
              </button>
              <button type="button" className={`tab-link ${reportTab === 'payables' ? 'active' : ''}`} onClick={() => setReportTab('payables')}>
                Accounts Payable
              </button>
              <button type="button" className={`tab-link ${reportTab === 'advances' ? 'active' : ''}`} onClick={() => setReportTab('advances')}>
                Advance Paid to Suppliers
              </button>
            </div>

            {reportTab === 'invoices' && (
            <>
            <div className="block-header">
              <h2>Supplier Invoice Records</h2>
              {isAdmin() && <button type="button" className="button-secondary" onClick={openMigrationPreview}>Review legacy records</button>}
            </div>
            {migrationMessage && <div role="status" className="form-info">{migrationMessage}</div>}
            {migrationPreview && (
              <section className="content-block" aria-label="Supplier Invoice migration review">
                <h3>Legacy Supplier Invoice migration preview</h3>
                <p>Eligible: {migrationPreview.counts?.eligible || 0} · Existing: {migrationPreview.counts?.existing || 0} · Conflicts: {migrationPreview.counts?.conflicts || 0} · Invalid: {migrationPreview.counts?.invalid || 0}</p>
                <p>Only selected eligible records will be imported. Existing, conflicting and invalid records remain unchanged.</p>
                <div style={{ maxHeight: 260, overflow: 'auto' }}>
                  {(migrationPreview.eligible || []).map((record) => (
                    <label key={record.reference} style={{ display: 'block', padding: '5px 0' }}>
                      <input type="checkbox" checked={migrationSelection.includes(record.reference)} onChange={(event) => setMigrationSelection((current) => event.target.checked ? [...current, record.reference] : current.filter((id) => id !== record.reference))} />{' '}
                      {record.reference} · {record.vendor} · {record.total}
                    </label>
                  ))}
                  {(migrationPreview.existing || []).map((record) => <div key={`existing-${record.reference}`} role="status">Already present, unchanged: {record.reference}</div>)}
                  {(migrationPreview.conflicts || []).map((entry) => <div key={`conflict-${entry.record.reference}`} role="status">Conflict, unchanged: {entry.record.reference}</div>)}
                  {(migrationPreview.invalid || []).map((entry, index) => <div key={`invalid-${index}`} role="status">Invalid, unchanged: {entry.record?.reference || 'unidentified'} — {entry.reason}</div>)}
                </div>
                <div className="form-actions">
                  <button type="button" className="button-secondary" onClick={() => setMigrationPreview(null)}>Close review</button>
                  <button type="button" className="button-primary" disabled={!migrationSelection.length} onClick={importSelectedLegacyInvoices}>Import selected records</button>
                </div>
              </section>
            )}
            <RecordSearchBar value={invoiceSearch} onChange={setInvoiceSearch} placeholder="Search bill, PO, supplier, invoice date, due date, value, status..." label="Search supplier bills" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Bill Date</th>
                    <th>Supplier Bill No.</th>
                    <th>PO Ref</th>
                    <th>Vendor / Supplier</th>
                    <th>Payment Due</th>
                    <th>Total Value</th>
                    <th>Balance Due</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filterMaterialRecords(history, invoiceSearch, ['reference','poRef','vendor','date','dueDate','total','balanceDue','status']).length > 0 ? (
                    filterMaterialRecords(history, invoiceSearch, ['reference','poRef','vendor','date','dueDate','total','balanceDue','status']).map((inv, idx) => (
                      <tr key={idx}>
                        <td>{inv.date}</td>
                        <td><strong>{inv.reference}</strong></td>
                        <td>
                          {inv.poRef && inv.poRef !== '-' ? (
                            <button
                              className="button-small"
                              style={{ padding: '2px 6px', fontSize: '11px', color: '#2563eb', borderColor: '#bfdbfe' }}
                              onClick={async () => {
                                /* PO detail comes from PostgreSQL (state first,
                                   server lookup when the list is stale). */
                                let match = poList.find((p) => p.reference === inv.poRef);
                                if (!match) {
                                  try { match = await getPurchaseOrder(inv.poRef); } catch { match = null; }
                                }
                                navigate('/purchase-order', {
                                  state: {
                                    viewPO: match ? match.payload : null
                                  }
                                });
                              }}
                              title="Jump to Linked Purchase Order"
                            >
                              <ClipboardList size={14} aria-hidden="true" /> {inv.poRef}
                            </button>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td>{inv.vendor}</td>
                        <td>{inv.dueDate || '-'}</td>
                        <td>{inv.total}</td>
                        <td style={{ color: inv.status === 'Paid' ? '#166534' : '#dc2626', fontWeight: 'bold' }}>
                          {inv.status === 'Paid' ? '₹ 0.00' : inv.balanceDue || inv.total}
                        </td>
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
                                setEditingInvoice({ reference: inv.reference, version: inv.version });
                                setInvoiceDetails(p.invoiceDetails);
                                setVendorDetails(p.vendorDetails);
                                setCompanyDetails(p.companyDetails);
                                setItems(p.items);
                                setSourceReceipt('');
                                setMode('create');
                              }}
                            >
                              Edit / Pay
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="9" className="no-history-row">
                        {history.length ? 'No supplier bills match your search.' : 'No Supplier Invoices recorded yet. Click "+ Record Supplier Invoice".'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            </>
            )}

            {reportTab === 'vendor' && (
              <>
                <div className="block-header">
                  <h2>Vendor Invoices received through Store</h2>
                  <span className="muted-text">
                    Shared by the Store when the material receipt was recorded — convert them into Supplier Invoices
                  </span>
                </div>
                <RecordSearchBar value={vendorInvoiceSearch} onChange={setVendorInvoiceSearch} placeholder="Search invoice, receipt, PO, supplier, date, value, status..." label="Search vendor invoices from Store" />
                <div className="history-table-wrapper">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>Vendor Invoice No</th>
                        <th>Invoice Date</th>
                        <th>Receipt</th>
                        <th>PO</th>
                        <th>Vendor / Supplier</th>
                        <th>Invoice Value</th>
                        <th>Quality Status</th>
                        <th>Supplier Bill</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filterMaterialRecords(vendorInvoices, vendorInvoiceSearch, ['invoiceNumber','receiptNumber','poNumber','vendor','invoiceDate','invoiceValue','qcStatus','supplierInvoiceNumber']).length > 0 ? (
                        filterMaterialRecords(vendorInvoices, vendorInvoiceSearch, ['invoiceNumber','receiptNumber','poNumber','vendor','invoiceDate','invoiceValue','qcStatus','supplierInvoiceNumber']).map((r) => (
                          <tr key={r.receiptNumber}>
                            <td><strong>{r.invoiceNumber}</strong></td>
                            <td>{r.invoiceDate || '—'}</td>
                            <td>{r.receiptNumber}</td>
                            <td>{r.poNumber || '—'}</td>
                            <td>{r.vendor || '—'}</td>
                            <td>₹ {getReceiptInvoiceValue(r).toFixed(2)}</td>
                            <td>{r.qcStatus || 'Pending'}</td>
                            <td>{r.supplierInvoiceNumber || <span className="status-badge st-pending-store">Not recorded</span>}</td>
                            <td>
                              {r.supplierInvoiceNumber ? (
                                <span className="status-badge st-approved">Converted</span>
                              ) : (
                                <button
                                  className="button-small button-primary"
                                  onClick={() => handleConvertReceipt(r.receiptNumber)}
                                >
                                  Convert to Supplier Invoice
                                </button>
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="9" className="no-history-row">
                            {vendorInvoices.length ? 'No vendor invoices match your search.' : 'No vendor invoices have been shared by the Store yet.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {reportTab === 'purchase' && (
              <>
              <RecordSearchBar value={purchaseSearch} onChange={setPurchaseSearch} placeholder="Search bill, PO, supplier, date, value, balance, status..." label="Search purchase report" />
              <ReportRegister
                title="Purchase Report"
                subTitle="Supplier invoices / purchases register"
                filename={`Purchase-Report-${new Date().toISOString().slice(0, 10)}`}
                dateField="date"
                columns={[
                  { key: 'date', label: 'Bill Date' },
                  { key: 'reference', label: 'Supplier Bill No' },
                  { key: 'poRef', label: 'PO Ref', render: (r) => r.poRef || '-' },
                  { key: 'vendor', label: 'Vendor / Supplier' },
                  { key: 'dueDate', label: 'Payment Due', render: (r) => r.dueDate || '-' },
                  { key: 'gt', label: 'Bill Total (₹)', align: 'right', render: (r) => parseINR(r.total).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'paid', label: 'Paid (₹)', align: 'right', render: (r) => parseINR(r.payload?.invoiceDetails?.amountPaid).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'advance', label: 'Advance Applied (₹)', align: 'right', render: (r) => parseINR(r.payload?.invoiceDetails?.advanceAdjusted).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'bal', label: 'Balance Due (₹)', align: 'right', render: (r) => parseINR(r.status === 'Paid' ? 0 : r.balanceDue).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                ]}
                rows={filterMaterialRecords(history, purchaseSearch, ['reference','poRef','vendor','date','dueDate','total','balanceDue','status'])}
                showSearch={false}
                excludeCommonFilterKeys={['status']}
                totals={[
                  { colKey: 'gt', render: (rs) => rs.reduce((a, r) => a + parseINR(r.total), 0) },
                  { colKey: 'paid', render: (rs) => rs.reduce((a, r) => a + parseINR(r.payload?.invoiceDetails?.amountPaid), 0) },
                  { colKey: 'advance', render: (rs) => rs.reduce((a, r) => a + parseINR(r.payload?.invoiceDetails?.advanceAdjusted), 0) },
                  { colKey: 'bal', render: (rs) => rs.reduce((a, r) => a + parseINR(r.status === 'Paid' ? 0 : r.balanceDue), 0) }
                ]}
              />
              </>
            )}

            {reportTab === 'payables' && (
              <>
              <RecordSearchBar value={payablesSearch} onChange={setPayablesSearch} placeholder="Search bill, PO, supplier, date, value, balance, status..." label="Search accounts payable" />
              <ReportRegister
                title="Accounts Payable"
                subTitle="Outstanding payables to suppliers"
                filename={`Accounts-Payable-${new Date().toISOString().slice(0, 10)}`}
                dateField="date"
                columns={[
                  { key: 'date', label: 'Bill Date' },
                  { key: 'reference', label: 'Supplier Bill No' },
                  { key: 'poRef', label: 'PO Ref', render: (r) => r.poRef || '-' },
                  { key: 'vendor', label: 'Vendor / Supplier' },
                  { key: 'dueDate', label: 'Due Date', render: (r) => r.dueDate || '-' },
                  { key: 'gt', label: 'Bill Total (₹)', align: 'right', render: (r) => parseINR(r.total).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'paid', label: 'Paid (₹)', align: 'right', render: (r) => parseINR(r.payload?.invoiceDetails?.amountPaid).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'advance', label: 'Advance Applied (₹)', align: 'right', render: (r) => parseINR(r.payload?.invoiceDetails?.advanceAdjusted).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'bal', label: 'Outstanding (₹)', align: 'right', render: (r) => parseINR(r.balanceDue).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                ]}
                rows={filterMaterialRecords(history.filter((r) => r.status !== 'Paid'), payablesSearch, ['reference','poRef','vendor','date','dueDate','total','balanceDue','status'])}
                showSearch={false}
                excludeCommonFilterKeys={['status']}
                totals={[
                  { colKey: 'gt', render: (rs) => rs.reduce((a, r) => a + parseINR(r.total), 0) },
                  { colKey: 'paid', render: (rs) => rs.reduce((a, r) => a + parseINR(r.payload?.invoiceDetails?.amountPaid), 0) },
                  { colKey: 'advance', render: (rs) => rs.reduce((a, r) => a + parseINR(r.payload?.invoiceDetails?.advanceAdjusted), 0) },
                  { colKey: 'bal', render: (rs) => rs.reduce((a, r) => a + parseINR(r.balanceDue), 0) }
                ]}
              />
              </>
            )}

            {reportTab === 'advances' && (
              <>
              <RecordSearchBar value={advanceSearch} onChange={setAdvanceSearch} placeholder="Search supplier, PO / bill, date, amount, status..." label="Search supplier advances" />
              <AdvanceRegister
                kind="supplier"
                title="Advance Paid to Suppliers"
                filenamer={`Advance-Paid-${new Date().toISOString().slice(0, 10)}`}
                partyLabel="Supplier"
                prefix="SAP"
                againstLabel="Against PO / Bill"
                partyList={vendorMasterRecords.map((v) => v.name)}
                searchQuery={advanceSearch}
                invoiceOptions={history}
                onRefresh={async () => setHistory(await listSupplierInvoicesApi())}
              />
              </>
            )}
          </>
        )}

      {historyError && <div role="alert" className="form-error">{historyError}</div>}
      {vendorMasterError && <div role="alert" className="form-error">{vendorMasterError}</div>}
      {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSaveInvoice}>
            <div className="form-section">
              <div className="section-heading">
                <h3>Supplier Invoice Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Supplier Invoice / Bill No. *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. JINDAL/26/1049"
                    value={invoiceDetails.supplierInvoiceNumber}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, supplierInvoiceNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Invoice Date *</label>
                  <input
                    type="date"
                    required
                    value={invoiceDetails.supplierInvoiceDate}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, supplierInvoiceDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Link to Purchase Order (Auto-fills Vendor & Items)</label>
                  <input
                    type="text"
                    list="issuedPOOptionsList"
                    placeholder="e.g. PO-2026-0001"
                    value={invoiceDetails.poReference}
                    onChange={(e) => {
                      const val = e.target.value;
                      setInvoiceDetails((prev) => ({ ...prev, poReference: val }));
                      handleSelectPO(val);
                    }}
                  />
                  <datalist id="issuedPOOptionsList">
                    {poList.map((po) => (
                      <option key={po.reference} value={po.reference}>
                        {po.vendor} - {po.total} ({po.status})
                      </option>
                    ))}
                  </datalist>
                  {poAutoLinkMsg && (
                    <div style={{ fontSize: '11px', color: '#16a34a', fontWeight: '600', marginTop: '3px' }}>
                      {poAutoLinkMsg}
                    </div>
                  )}
                </div>
                <div className="field-group">
                  <label>Payment Due Date</label>
                  <input
                    type="date"
                    value={invoiceDetails.paymentDueDate}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, paymentDueDate: e.target.value })}
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
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Payment Settlement Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Amount Paid (₹)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={invoiceDetails.amountPaid}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, amountPaid: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Balance Remaining</label>
                  <input
                    type="text"
                    readOnly
                    value={`₹ ${balanceDue.toFixed(2)}`}
                    style={{ background: '#f1f5f9', fontWeight: 'bold', color: balanceDue > 0 ? '#dc2626' : '#166534' }}
                  />
                </div>
                <div className="field-group">
                  <label>Payment Mode</label>
                  <select
                    value={invoiceDetails.paymentMode}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, paymentMode: e.target.value })}
                  >
                    <option value="Bank Transfer (NEFT/RTGS)">Bank Transfer (NEFT/RTGS)</option>
                    <option value="Cheque">Cheque</option>
                    <option value="UPI / Online">UPI / Online</option>
                    <option value="Cash">Cash</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>UTR / Transaction Ref No.</label>
                  <input
                    type="text"
                    placeholder="e.g. UTR-9823412341"
                    value={invoiceDetails.paymentReference}
                    onChange={(e) => setInvoiceDetails({ ...invoiceDetails, paymentReference: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Vendor / Supplier Information</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Vendor / Company Name *</label>
                  <VendorMasterAutocomplete
                    required
                    placeholder="Search or type vendor name..."
                    value={vendorDetails.companyName}
                    onChange={(val) => setVendorDetails((prev) => ({ ...prev, companyName: val }))}
                    onSelect={(v) => setVendorDetails((prev) => ({ ...prev, companyName: v.name, address: v.address || prev.address }))}
                  />
                </div>
                <div className="field-group">
                  <label>Contact Person</label>
                  <input
                    type="text"
                    value={vendorDetails.vendorName}
                    onChange={(e) => setVendorDetails({ ...vendorDetails, vendorName: e.target.value })}
                  />
                </div>
                <div className="field-group full-width">
                  <label>Vendor Address</label>
                  <input
                    type="text"
                    value={vendorDetails.address}
                    onChange={(e) => setVendorDetails({ ...vendorDetails, address: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Contact Number</label>
                  <input
                    type="text"
                    value={vendorDetails.contactNumber}
                    onChange={(e) => setVendorDetails({ ...vendorDetails, contactNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Vendor GSTIN</label>
                  <input
                    type="text"
                    value={vendorDetails.gstNumber}
                    onChange={(e) => setVendorDetails({ ...vendorDetails, gstNumber: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Billed Items</h3>
              </div>
              <div className="item-table-wrapper">
                <table className="item-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>SL.No</th>
                      <th style={{ width: '260px' }}>Description</th>
                      <th style={{ width: '140px' }}>Spec / Drawing</th>
                      <th style={{ width: '110px' }}>HSN/SAC</th>
                      <th style={{ width: '90px' }}>Qty</th>
                      <th style={{ width: '110px' }}>Unit</th>
                      <th style={{ width: '125px' }}>Unit Rate</th>
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
                  <span>Subtotal</span>
                  <strong>₹ {totals.subtotal.toFixed(2)}</strong>
                </div>
                <div className="tax-summary-row">
                  <span>Discount</span>
                  <div>
                    ₹{' '}
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
                  <strong>₹ {totals.taxableAmount.toFixed(2)}</strong>
                </div>
                <div className="tax-summary-row">
                  <span>Total GST</span>
                  <strong>₹ {totals.totalGST.toFixed(2)}</strong>
                </div>
                <div className="tax-summary-row total">
                  <span>Grand Total</span>
                  <strong>₹ {totals.grandTotal.toFixed(2)}</strong>
                </div>
                <div className="amount-in-words">
                  <span>Total Amount in Words</span>
                  <p>{amountInWords}</p>
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Notes</h3>
              </div>
              <div className="field-group full-width">
                <label>Remarks / Approval Notes</label>
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
              <button type="submit" className="button-primary" disabled={savingInvoice || !historyReady}>
                {savingInvoice ? 'Saving to PostgreSQL…' : 'Save Supplier Invoice'}
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
                Print Bill Voucher
              </button>
              <button
                className="button-secondary"
                onClick={() => {
                  const found = history.find((row) => String(row.reference) === String(selectedInvoice.invoiceDetails?.supplierInvoiceNumber));
                  setEditingInvoice(found ? { reference: found.reference, version: found.version } : null);
                  setInvoiceDetails(selectedInvoice.invoiceDetails);
                  setVendorDetails(selectedInvoice.vendorDetails);
                  setCompanyDetails(selectedInvoice.companyDetails);
                  setItems(selectedInvoice.items);
                  setMode('create');
                }}
              >
                Edit / Record Payment
              </button>
            </div>

            <div className="doc-page-container">
              <div className="quotation-doc-sheet printable">
                <h1 className="doc-main-title">VENDOR INVOICE VOUCHER</h1>

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
                    <div className="doc-box-header">Supplier / Vendor:</div>
                    <div className="doc-box-body">
                      <div className="doc-customer-name">
                        {selectedInvoice.vendorDetails?.companyName || selectedInvoice.vendorDetails?.vendorName || '-'}
                      </div>
                      {selectedInvoice.vendorDetails?.address && (
                        <div className="doc-customer-address">{selectedInvoice.vendorDetails.address}</div>
                      )}
                      <div className="doc-customer-inline">
                        {selectedInvoice.vendorDetails?.contactNumber && (
                          <div>Contact: {selectedInvoice.vendorDetails.contactNumber}</div>
                        )}
                        {selectedInvoice.vendorDetails?.gstNumber && (
                          <div>GSTIN: {selectedInvoice.vendorDetails.gstNumber}</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="doc-half-box doc-half-right">
                    <div className="doc-box-header">Invoice / Bill Details:</div>
                    <div className="doc-box-body">
                      <div><strong>Supplier Bill No:</strong> {selectedInvoice.invoiceDetails?.supplierInvoiceNumber || '-'}</div>
                      <div><strong>Bill Date:</strong> {selectedInvoice.invoiceDetails?.supplierInvoiceDate || '-'}</div>
                      {selectedInvoice.invoiceDetails?.paymentDueDate && (
                        <div><strong>Payment Due Date:</strong> {selectedInvoice.invoiceDetails.paymentDueDate}</div>
                      )}
                      {selectedInvoice.invoiceDetails?.poReference && (
                        <div><strong>PO Ref:</strong> {selectedInvoice.invoiceDetails.poReference}</div>
                      )}
                      <div><strong>Paid:</strong> ₹ {Number(selectedInvoice.invoiceDetails?.amountPaid || 0).toFixed(2)}</div>
                    </div>
                  </div>
                </div>

                {/* Items Table */}
                <table className="doc-items-table">
                  <thead>
                    <tr>
                      <th className="th-slno">SL.No</th>
                      <th style={{ textAlign: 'left' }}>Item Description</th>
                      <th style={{ textAlign: 'left', width: '90px' }}>Spec / Drawing</th>
                      <th className="th-hsnSac">HSN/SAC</th>
                      <th className="th-quantity text-right">Qty</th>
                      <th className="th-unit text-center">Unit</th>
                      <th className="th-unitPrice text-right">Rate</th>
                      <th className="th-gst text-right">GST%</th>
                      <th className="th-amount text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedInvoice.items?.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-center">{idx + 1}</td>
                        <td className="text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                        </td>
                        <td className="text-left">{item.drawingNo || '-'}</td>
                        <td className="text-left">{item.hsnSac || '-'}</td>
                        <td className="text-right">{item.quantity || 0}</td>
                        <td className="text-center">{item.unit || 'Nos'}</td>
                        <td className="text-right">{Number(item.unitPrice || 0).toFixed(2)}</td>
                        <td className="text-right">{item.gst ? `${item.gst}%` : '0%'}</td>
                        <td className="text-right">{Number(item.amount || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="doc-total-row">
                      <td colSpan={4} className="font-bold text-left">Total</td>
                      <td className="font-bold text-right">
                        {selectedInvoice.items?.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
                      </td>
                      <td></td>
                      <td></td>
                      <td className="font-bold text-right">
                        {Number(selectedInvoice.totals?.totalGST || 0).toFixed(2)}
                      </td>
                      <td className="font-bold text-right">
                        {Number(selectedInvoice.totals?.subtotal || 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                {/* Summary */}
                <div className="doc-tax-summary-wrapper">
                  <div className="doc-tax-summary-grid">
                    <div className="doc-tax-left">
                      <table className="doc-mini-table">
                        <thead>
                          <tr>
                            <th>HSN/SAC</th>
                            <th className="text-right">Taxable</th>
                            <th className="text-right">GST Amount</th>
                            <th className="text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>{selectedInvoice.items?.[0]?.hsnSac || 'General'}</td>
                            <td className="text-right">{Number(selectedInvoice.totals?.taxableAmount || 0).toFixed(2)}</td>
                            <td className="text-right">{Number(selectedInvoice.totals?.totalGST || 0).toFixed(2)}</td>
                            <td className="text-right">{Number(selectedInvoice.totals?.grandTotal || 0).toFixed(2)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <div className="doc-tax-right">
                      <div className="doc-summary-line">
                        <span>Subtotal:</span>
                        <span>₹ {Number(selectedInvoice.totals?.subtotal || 0).toFixed(2)}</span>
                      </div>
                      {Number(selectedInvoice.totals?.discountAmount || 0) > 0 && (
                        <div className="doc-summary-line">
                          <span>Discount:</span>
                          <span>- ₹ {Number(selectedInvoice.totals.discountAmount).toFixed(2)}</span>
                        </div>
                      )}
                      <div className="doc-summary-line">
                        <span>Taxable Amount:</span>
                        <span>₹ {Number(selectedInvoice.totals?.taxableAmount || 0).toFixed(2)}</span>
                      </div>
                      <div className="doc-summary-line doc-summary-total">
                        <strong>Grand Total:</strong>
                        <strong>₹ {Number(selectedInvoice.totals?.grandTotal || 0).toFixed(2)}</strong>
                      </div>
                      <div className="doc-summary-line" style={{ color: '#166534', fontWeight: 'bold' }}>
                        <span>Amount Paid:</span>
                        <span>₹ {Number(selectedInvoice.invoiceDetails?.amountPaid || 0).toFixed(2)}</span>
                      </div>
                      <div className="doc-summary-line" style={{ color: '#dc2626', fontWeight: 'bold' }}>
                        <span>Balance Due:</span>
                        <span>₹ {Number(selectedInvoice.invoiceDetails?.balanceDue || 0).toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Amount in Words */}
                <div className="doc-full-box">
                  <div className="doc-box-title">Total Amount In Words:</div>
                  <div className="doc-box-text">{selectedInvoice.amountInWords}</div>
                </div>

                {/* Notes */}
                {selectedInvoice.invoiceDetails?.notes && (
                  <div className="doc-full-box">
                    <div className="doc-box-title">Remarks:</div>
                    <div className="doc-box-text">{selectedInvoice.invoiceDetails.notes}</div>
                  </div>
                )}

                {/* Terms and Signatory */}
                <div className="doc-bottom-split">
                  <div className="doc-terms-box">
                    <div className="doc-box-title">Payment Voucher Terms:</div>
                    <div className="doc-terms-list">
                      <div className="doc-term-item">{selectedInvoice.invoiceDetails?.termsAndConditions || 'Payment verified as per supplier invoice and purchase order specifications.'}</div>
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
                  <span>Vendor Invoice Record - VYAVASTA ERP</span>
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

export default SupplierInvoicePage;

