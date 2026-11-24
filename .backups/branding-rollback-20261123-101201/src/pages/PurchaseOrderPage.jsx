import React, { useState, useEffect, useMemo } from 'react';
import { FileText, ReceiptText, Upload } from 'lucide-react';
import ExcelImportDialog from '../components/ExcelImportDialog.jsx';
import { getVendorMaster } from '../utils/vendorMaster.js';
import AddableSelect from '../components/AddableSelect.jsx';
import { DEFAULT_UNITS } from '../utils/addableMasters.js';
import { useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from '../utils/calculations.js';
import { numberToWords } from '../utils/numberToWords.js';
import { generatePurchaseOrderPDF } from '../services/pdfGenerator.js';
import { saveWorkflowDocument, deleteWorkflowDocument, openWorkflowDocument } from '../utils/workflowFiles.js';
import { computePOTotals, poAmountInWords } from '../utils/poTemplate.js';
import { getNextSequentialNumber, saveDocSequence } from '../utils/sequenceGenerator.js';
import { pushNotification, appendAuditLog, dateOnly } from '../utils/storeService.js';
import {
  getIndent,
  getIndents,
  markIndentConverted,
  getPOProgress,
  INDENT_STATUS,
  validatePOProcurementChain,
  linkPOToProcurementChain,
  buildPOFromQuotation,
  createPurchaseOrderFromQuotation,
  canCreatePOFromQuotation,
  DEFAULT_PO_TERMS
} from '../utils/workflowService.js';
import { hasPermission } from '../utils/permissions.js';
import ReportRegister from '../components/ReportRegister.jsx';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterMaterialRecords } from '../utils/historySearch.js';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import TermsTemplateEditor from '../components/TermsTemplateEditor.jsx';

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

const generatePONumber = () => {
  return getNextSequentialNumber('PO', 'purchaseOrderSequence', 'supplierPOHistory', 'reference');
};

/** Never let a corrupt localStorage entry break the Purchase Order screen. */
const readStoredList = (key) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeReference = (value) => String(value || '').trim().toUpperCase();

const hasVendorEnquiryForIndent = (indent, enquiries) => {
  const indentRef = normalizeReference(indent?.indentNumber);
  if (!indentRef) return false;
  return enquiries.some((enquiry) => {
    const enquiryIndent = normalizeReference(enquiry?.indentNumber);
    const enquiryPR = normalizeReference(enquiry?.prNumber);
    return enquiryIndent === indentRef || (!enquiryIndent && enquiryPR === indentRef);
  });
};

const hasPurchaseOrderForIndent = (indent, purchaseOrders) => {
  const indentRef = normalizeReference(indent?.indentNumber);
  if (!indentRef) return false;
  return purchaseOrders.some((order) => [
    order?.indentRef,
    order?.indentNumber,
    order?.payload?.indentRef,
    order?.payload?.poDetails?.indentRef,
    order?.payload?.poDetails?.indentNumber,
    order?.poDetails?.indentRef,
    order?.poDetails?.indentNumber
  ].some((reference) => normalizeReference(reference) === indentRef));
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

/** Saved PO terms templates (storage key used by the template picker). */
const PO_TERMS_TEMPLATES_KEY = 'poTermsTemplates';

const PO_TERMS_TEMPLATES = [
  { id: 'po-standard', number: 1, name: 'Standard Purchase Terms', content: DEFAULT_PO_TERMS },
  {
    id: 'po-fabrication',
    number: 2,
    name: 'Fabrication / Machining PO',
    content:
      '1. Work shall be carried out as per the approved drawings and specifications shared with the order.\n' +
      '2. Material test certificate and inspection report must accompany the delivery.\n' +
      '3. No material substitution or dimensional deviation is permitted without written approval.\n' +
      '4. Delivery must be made to PRAGMATIC ENGINEERS factory gate during working hours.\n' +
      '5. Payment will be released within agreed terms following quality inspection.'
  },
  {
    id: 'po-critical',
    number: 3,
    name: 'Critical / Safety Parts',
    content:
      '1. Materials must strictly conform to the specifications, drawings and revisions stated in the order.\n' +
      '2. 100% inspection with a dimensional / CMM report is mandatory for every batch.\n' +
      '3. Test certificates and traceability documents must accompany the delivery.\n' +
      '4. Rejection at incoming inspection is at vendor cost, including replacement and re-inspection.\n' +
      '5. Payment will be released within agreed terms following quality inspection.'
  }
];

/** The vendor quotation a PO was raised from — used for the read-only quoted-terms block. */
const findSourceQuotation = (ref) => {
  if (!ref) return null;
  return readStoredList('vendorQuotations').find((q) => String(q.quotationNumber) === String(ref)) || null;
};

const PurchaseOrderPage = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [history, setHistory] = useState([]);
  const [inventoryList, setInventoryList] = useState([]);
  const [selectedPO, setSelectedPO] = useState(null);
  const [reportTab, setReportTab] = useState('orders'); // 'orders' | 'open'
  const [poSearch, setPoSearch] = useState('');
  const [showExcelImport, setShowExcelImport] = useState(false);
  const poImportColumns = ['PO Number','PO Date','Vendor Name','Vendor Code','Project ID','Item Code','Item Description','Quantity','Unit','Rate','GST','Tax Amount','Total Amount','Delivery Date','Payment Terms','Remarks'];
  const validatePOImportRow = (row) => {
    const errors = [];
    if (!String(row['PO Number'] || '').trim()) errors.push('PO Number is required');
    if (!String(row['PO Date'] || '').trim()) errors.push('PO Date is required');
    if (!String(row['Vendor Name'] || row['Vendor Code'] || '').trim()) errors.push('Vendor Name or Vendor Code is required');
    if (!String(row['Item Code'] || '').trim()) errors.push('Item Code is required');
    if (!Number.isFinite(Number(row.Quantity)) || Number(row.Quantity) <= 0) errors.push('Quantity must be greater than zero');
    if (!Number.isFinite(Number(row.Rate)) || Number(row.Rate) < 0) errors.push('Rate must be non-negative');
    const expectedTax = (Number(row.Quantity) || 0) * (Number(row.Rate) || 0) * (Number(row.GST) || 0) / 100;
    if (row['Tax Amount'] !== '' && row['Tax Amount'] != null && Math.abs(Number(row['Tax Amount']) - expectedTax) > 0.02) errors.push('Tax Amount does not match Quantity × Rate × GST');
    const expectedTotal = (Number(row.Quantity) || 0) * (Number(row.Rate) || 0) + expectedTax;
    if (row['Total Amount'] !== '' && row['Total Amount'] != null && Math.abs(Number(row['Total Amount']) - expectedTotal) > 0.02) errors.push('Total Amount does not match line value plus tax');
    const po = String(row['PO Number'] || '').trim().toLowerCase();
    if (po && readStoredList('supplierPOHistory').some((entry) => String(entry.reference || '').trim().toLowerCase() === po)) errors.push('Duplicate PO Number');
    if (row['Item Code'] && !readStoredList('inventoryItems').some((item) => String(item.itemCode).trim().toLowerCase() === String(row['Item Code']).trim().toLowerCase())) errors.push('Invalid Item Code');
    const vendorList = getVendorMaster();
    if (row['Vendor Code'] && !vendorList.some((vendor) => String(vendor.code || vendor.vendorCode || vendor.id || '').toLowerCase() === String(row['Vendor Code']).trim().toLowerCase())) errors.push('Vendor Code not found');
    if (!row['Vendor Code'] && row['Vendor Name'] && !vendorList.some((vendor) => String(vendor.name || vendor.companyName || '').trim().toLowerCase() === String(row['Vendor Name']).trim().toLowerCase())) errors.push('Vendor Name not found');
    return errors;
  };
  const importPurchaseOrders = async (rows) => {
    const groups = new Map();
    rows.forEach((row) => { const key = String(row['PO Number']).trim(); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); });
    const historyRows = [...groups.entries()].map(([number, lines]) => {
      const first = lines[0];
      const vendor = getVendorMaster().find((entry) => (first['Vendor Code'] && String(entry.code || entry.vendorCode || entry.id).toLowerCase() === String(first['Vendor Code']).trim().toLowerCase()) || (first['Vendor Name'] && String(entry.name || entry.companyName).trim().toLowerCase() === String(first['Vendor Name']).trim().toLowerCase()));
      const items = lines.map((line) => { const quantity = Number(line.Quantity), unitPrice = Number(line.Rate), gst = Number(line.GST) || 0, amount = quantity * unitPrice; return { itemCode: String(line['Item Code']).trim(), itemName: String(line['Item Description'] || '').trim() || readStoredList('inventoryItems').find((item) => String(item.itemCode).toLowerCase() === String(line['Item Code']).trim().toLowerCase())?.itemName || '', quantity, unit: String(line.Unit || 'Nos').trim(), unitPrice, gst: String(gst), amount, gstAmount: amount * gst / 100 }; });
      const importedTotals = calculateTotals(items);
      const total = importedTotals.grandTotal;
      const poDetails = { poNumber: number, poDate: String(first['PO Date']), deliveryDueDate: String(first['Delivery Date'] || ''), projectRef: String(first['Project ID'] || ''), paymentTerms: String(first['Payment Terms'] || ''), notes: String(first.Remarks || ''), poStatus: 'Draft', discount: '' };
      const vendorDetails = { vendorName: vendor?.name || vendor?.companyName || String(first['Vendor Name']), companyName: vendor?.name || vendor?.companyName || String(first['Vendor Name']), address: vendor?.address || '', contactNumber: vendor?.phone || '', email: vendor?.email || '', gstNumber: vendor?.gstin || '' };
      const payload = { poDetails, vendorDetails, companyDetails, items, totals: importedTotals, amountInWords: numberToWords(total) };
      return { date: poDetails.poDate, reference: number, vendor: vendorDetails.companyName, projectRef: poDetails.projectRef || '-', dueDate: poDetails.deliveryDueDate || '-', total: `₹ ${total.toFixed(2)}`, status: 'Draft', payload };
    });
    const current = readStoredList('supplierPOHistory');
    localStorage.setItem('supplierPOHistory', JSON.stringify([...historyRows, ...current]));
    appendAuditLog({ action: 'PURCHASE ORDERS IMPORTED', reference: historyRows.map((row) => row.reference).join(', '), details: `${historyRows.length} imported as Draft` });
    setHistory([...historyRows, ...current]);
    return { success: rows.length, skipped: 0 };
  };

  // Form states
  const [poDetails, setPoDetails] = useState({
    poNumber: generatePONumber(),
    poDate: new Date().toISOString().slice(0, 10),
    deliveryDueDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
    projectRef: '',
    salesOrderRef: '',
    prRef: '',
    indentRef: '',
    enquiryRef: '',
    quotationRef: '',
    quotationDate: '',
    /* PO-to-Supplier format: Your Ref No./Date, Ship To, charges */
    yourRefNo: '',
    yourRefDate: '',
    shipToName: '',
    shipToAddress: '',
    shipToMobile: '',
    packingCharges: '',
    freight: '',
    paymentTerms: '30 Days from Invoice',
    poStatus: 'Submitted', // Draft | Submitted | Approved | Partially Received | Fully Received | Closed | Cancelled (legacy: Issued | In Transit | Received)
    discount: '',
    notes: '',
    termsAndConditions: DEFAULT_PO_TERMS
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

  // Load from localStorage & auto-sync with bills
  useEffect(() => {
    try {
      const storedPOs = localStorage.getItem('supplierPOHistory');
      let poList = storedPOs ? JSON.parse(storedPOs) : [];

      // Cross-reference with supplier invoices to ensure billing link is always live
      try {
        const storedBills = JSON.parse(localStorage.getItem('supplierInvoiceHistory') || '[]');
        if (Array.isArray(storedBills) && storedBills.length > 0) {
          poList = poList.map((po) => {
            const bill = storedBills.find(
              (b) =>
                (b.poRef && b.poRef !== '-' && b.poRef.trim().toLowerCase() === po.reference?.trim().toLowerCase()) ||
                (b.payload?.invoiceDetails?.poReference &&
                  b.payload.invoiceDetails.poReference.trim().toLowerCase() === po.reference?.trim().toLowerCase())
            );
            if (bill) {
              return {
                ...po,
                billedInvoiceRef: bill.reference || bill.payload?.invoiceDetails?.supplierInvoiceNumber,
                billingStatus: 'Billed'
              };
            }
            return po;
          });
        }
      } catch {}

      // Ordered / Received / Pending / status projection for the PO register
      poList = poList.map((po) => {
        try {
          const progress = getPOProgress(po.reference);
          return { ...po, status: progress.status || po.status, progress };
        } catch {
          return po;
        }
      });

      setHistory(poList);
    } catch {
      setHistory([]);
    }

    try {
      const storedInv = localStorage.getItem('inventoryItems');
      setInventoryList(storedInv ? JSON.parse(storedInv) : []);
    } catch {
      setInventoryList([]);
    }
  }, []);

  const handleViewVendorBill = (invoiceNumber) => {
    try {
      const storedBills = JSON.parse(localStorage.getItem('supplierInvoiceHistory') || '[]');
      const match = storedBills.find((b) => b.reference === invoiceNumber);
      navigate('/supplier-invoice', {
        state: {
          viewInvoice: match ? match.payload : null
        }
      });
    } catch {
      navigate('/supplier-invoice');
    }
  };

  useEffect(() => {
    if (location.state?.viewPO) {
      setSelectedPO(location.state.viewPO);
      setMode('view');
    }
  }, [location.state]);

  /**
   * Accepted Vendor Quotation → Purchase Order.
   * Every commercial value (vendor, items, quantities, unit price, discount, tax,
   * totals, delivery & payment terms) and the whole document chain are fetched
   * from the quotation, so the Purchase user never re-enters anything. Only the
   * PO-specific fields stay editable.
   */
  const loadQuotationAsPO = (quotationNumber) => {
    const gate = canCreatePOFromQuotation(quotationNumber);
    if (!gate.allowed) {
      alert(gate.reason);
      return;
    }
    let draft;
    try {
      draft = buildPOFromQuotation(quotationNumber);
    } catch (err) {
      alert(err.message);
      return;
    }
    setPoDetails((prev) => ({ ...prev, ...draft.poDetails, poNumber: draft.poNumber }));
    setVendorDetails((prev) => ({ ...prev, ...draft.vendorDetails }));
    setItems(draft.items.map((it) => ({ ...emptyItem, ...it, gst: String(it.gst ?? '') })));
    setMode('create');
    setSelectedPO(null);
  };

  /** Open an existing Purchase Order (e.g. "View Purchase Order" from a quotation). */
  const loadPOForView = (poNumber) => {
    const po = readStoredList('supplierPOHistory').find((h) => String(h.reference) === String(poNumber));
    if (!po) return;
    setHistory((prev) =>
      prev.some((h) => String(h.reference) === String(poNumber))
        ? prev.map((h) => (String(h.reference) === String(poNumber) ? { ...h, progress: getPOProgress(poNumber) } : h))
        : [{ ...po, progress: getPOProgress(poNumber) }, ...prev]
    );
    setSelectedPO(po.payload);
    setMode('view');
  };

  useEffect(() => {
    if (location.state?.fromSalesOrder && location.state?.salesOrder) {
      navigate('/vendor-enquiry', { replace: true });
      return;
    }
    const quotationNumber = location.state?.fromQuotation;
    if (quotationNumber) {
      loadQuotationAsPO(quotationNumber);
      return;
    }
    const openPO = location.state?.openPO;
    if (openPO) {
      loadPOForView(openPO);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const handleSelectItemFromInventory = (index, itemCode) => {
    const found = inventoryList.find((i) => i.itemCode === itemCode);
    if (found) {
      setItems((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          itemCode: found.itemCode,
          itemName: found.itemName,
          hsnSac: found.hsnSac || '',
          unit: found.unit || 'Nos',
          unitPrice: found.unitCost || found.unitPrice || ''
        };
        return next;
      });
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

  const totals = useMemo(() => calculateTotals(computedItems, poDetails.discount), [computedItems, poDetails.discount]);
  const amountInWords = useMemo(() => numberToWords(totals.grandTotal), [totals.grandTotal]);
  /* PO template totals: shared totals + packing charges + freight (PO level) */
  const poTotals = useMemo(() => computePOTotals(totals, poDetails), [totals, poDetails]);
  const poWords = useMemo(() => poAmountInWords(poTotals.grandTotal), [poTotals.grandTotal]);

  const handleFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  /**
   * Send the Purchase Order PDF to the Store Department that raised the Purchase
   * Indent: the file is written to the workflow document store, its metadata is
   * attached to the saved PO record (so Store can open it from the receipt
   * screen) and Store is notified with a deep link to /material-receipts?po=...
   *
   * A PO always carries exactly one current document: on a re-save the payload
   * still holds the superseded attachment, so its file is removed here.
   * Returns the payload with the attachment stamped on it.
   */
  const sendPODocumentToStore = async (poNumber, payload) => {
    try {
      const previousDocs = payload.poDocuments || [];
      const blob = await generatePurchaseOrderPDF(payload, { blob: true });
      if (!blob) return payload;
      const meta = await saveWorkflowDocument(
        new File([blob], `PurchaseOrder-${poNumber}.pdf`, { type: 'application/pdf' })
      );
      meta.kind = 'Purchase Order';
      const stamped = { ...payload, poDocuments: [meta] };
      const stored = readStoredList('supplierPOHistory').map((h) =>
        String(h.reference) === String(poNumber) ? { ...h, payload: stamped } : h
      );
      localStorage.setItem('supplierPOHistory', JSON.stringify(stored));
      previousDocs.forEach((old) => {
        if (old?.id && old.id !== meta.id) deleteWorkflowDocument(old.id);
      });
      const indentRef = payload.poDetails?.indentRef || '';
      pushNotification({
        title: 'Purchase Order PDF sent to Store',
        message: `The Purchase Order document for ${poNumber}${indentRef ? ` raised from Purchase Indent ${indentRef}` : ''} is attached for ${payload.vendorDetails?.companyName || payload.vendorDetails?.vendorName || 'the vendor'} — open it from the Tax Invoice / Material Receipt screen.`,
        type: 'info',
        reference: poNumber,
        targetDept: 'Store Department',
        link: `/material-receipts?po=${encodeURIComponent(poNumber)}`,
        docId: meta.id,
        docName: meta.name
      });
      return stamped;
    } catch (err) {
      console.error('Failed to send the Purchase Order PDF to Store', err);
      return payload;
    }
  };

  const handleSavePO = async (e) => {
    e.preventDefault();
    const editingExistingPO = selectedPO?.poDetails?.poNumber === poDetails.poNumber;
    if (!vendorDetails.vendorName.trim() && !vendorDetails.companyName.trim()) {
      alert('Please enter Vendor / Supplier Name.');
      return;
    }

    if (!editingExistingPO) {
      if (!poDetails.quotationRef) {
        alert('Create a Vendor Enquiry, record the Vendor Quotation, and get Admin approval before creating a Purchase Order.');
        return;
      }
      const gate = canCreatePOFromQuotation(poDetails.quotationRef);
      if (!gate.allowed) {
        alert(gate.reason);
        return;
      }
    }

    /* --- procurement chain validation (indent / enquiry / quotation must exist) --- */
    try {
      validatePOProcurementChain({
        indentNumber: poDetails.indentRef || '',
        enquiryNumber: poDetails.enquiryRef || '',
        quotationNumber: poDetails.quotationRef || '',
        items: computedItems
      });
    } catch (err) {
      alert(err.message);
      return;
    }

    const payload = {
      poDetails,
      vendorDetails,
      companyDetails,
      items: computedItems,
      totals,
      amountInWords
    };

    try {
      /* ------------------------------------------------------------------
       * A Purchase Order raised from an ACCEPTED Vendor Quotation is created by
       * the workflow service — that is the single authoritative quotation → PO
       * path (validation, price copy, PO number, quotation linkage, Store
       * notification). Existing PO edits retain the direct update path below.
       * ------------------------------------------------------------------ */
      if (poDetails.quotationRef && !editingExistingPO) {
        const created = createPurchaseOrderFromQuotation(poDetails.quotationRef, {
          poNumber: poDetails.poNumber,
          poDate: poDetails.poDate,
          deliveryDueDate: poDetails.deliveryDueDate,
          poStatus: poDetails.poStatus,
          deliveryAddress: poDetails.deliveryAddress,
          billingAddress: poDetails.billingAddress,
          transportTerms: poDetails.transportTerms,
          notes: poDetails.notes,
          internalNotes: poDetails.internalNotes,
          termsAndConditions: poDetails.termsAndConditions,
          yourRefNo: poDetails.yourRefNo,
          yourRefDate: poDetails.yourRefDate,
          shipToName: poDetails.shipToName,
          shipToAddress: poDetails.shipToAddress,
          shipToMobile: poDetails.shipToMobile,
          packingCharges: poDetails.packingCharges,
          freight: poDetails.freight
        });
        const stamped = await sendPODocumentToStore(created.reference, created.payload);
        setHistory(readStoredList('supplierPOHistory').map((h) => ({ ...h, progress: getPOProgress(h.reference) })));
        setSelectedPO(stamped);
        setMode('view');
        return;
      }

      const stored = localStorage.getItem('supplierPOHistory');
      let current = stored ? JSON.parse(stored) : [];
      const existingIndex = current.findIndex((h) => h.reference === poDetails.poNumber);
      /* Keep the current document on the entry until the new PDF is written, so
         the superseded file can be purged once the fresh one is stored. */
      const previousDocs = existingIndex !== -1 ? (current[existingIndex]?.payload?.poDocuments || []) : [];
      const entry = {
        date: poDetails.poDate,
        reference: poDetails.poNumber,
        vendor: vendorDetails.companyName || vendorDetails.vendorName || '-',
        projectRef: poDetails.projectRef || '-',
        soRef: poDetails.salesOrderRef || '',
        indentRef: poDetails.indentRef || '',
        dueDate: poDetails.deliveryDueDate || '-',
        total: `₹ ${poTotals.grandTotal.toFixed(2)}`,
        status: poDetails.poStatus || 'Submitted',
        payload: previousDocs.length ? { ...payload, poDocuments: previousDocs } : payload
      };

      if (existingIndex !== -1) {
        current[existingIndex] = entry;
      } else {
        current.unshift(entry);
      }
      saveDocSequence('purchaseOrderSequence', poDetails.poNumber);
      localStorage.setItem('supplierPOHistory', JSON.stringify(current));
      const stamped = await sendPODocumentToStore(entry.reference, entry.payload);
      setHistory(readStoredList('supplierPOHistory').map((h) => ({ ...h, progress: getPOProgress(h.reference) })));
      setSelectedPO(stamped);
      setMode('view');

      appendAuditLog({ action: 'PO CREATED', reference: poDetails.poNumber, details: `Vendor: ${vendorDetails.companyName || vendorDetails.vendorName} | Amount: ₹${poTotals.grandTotal.toFixed(2)}` });
      pushNotification({ title: 'New Purchase Order — delivery to be recorded by Store', message: `PO ${poDetails.poNumber} created for ${vendorDetails.companyName || vendorDetails.vendorName}. Amount: ₹${poTotals.grandTotal.toFixed(2)}. Record the vendor delivery on the Tax Invoice / Material Receipt screen — it is shared with Quality and Purchase.`, type: 'info', reference: poDetails.poNumber, targetDept: 'Store Department', link: `/material-receipts?po=${encodeURIComponent(poDetails.poNumber)}` });
      pushNotification({ title: 'PO Raised for Material Shortage', message: `PO ${poDetails.poNumber} issued for ${vendorDetails.companyName || vendorDetails.vendorName}. Short materials will be procured.`, type: 'info', reference: poDetails.poNumber, targetDept: 'Production Department', link: '/production' });

      if (poDetails.prRef) {
        try {
          const storedPRs = JSON.parse(localStorage.getItem('storePurchaseRequests') || '[]');
          const updatedPRs = storedPRs.map((p) => p.prNumber === poDetails.prRef ? { ...p, status: 'Converted to PO', poNumber: poDetails.poNumber, convertedAt: new Date().toISOString() } : p);
          localStorage.setItem('storePurchaseRequests', JSON.stringify(updatedPRs));
          appendAuditLog({ action: 'PR CONVERTED TO PO', reference: poDetails.prRef, details: `Converted to PO ${poDetails.poNumber}` });
        } catch (e) { /* ignore */ }
      }

      // Sales Order → Purchase Indent → Vendor Enquiry → Quotation → Purchase Order traceability
      try {
        linkPOToProcurementChain(poDetails.poNumber, {
          enquiryNumber: poDetails.enquiryRef || '',
          quotationNumber: poDetails.quotationRef || ''
        });
      } catch (e) {
        console.warn('Procurement chain linking failed', e);
      }

      if (poDetails.indentRef) {
        try {
          const indent = getIndent(poDetails.indentRef);
          if (indent && indent.status !== INDENT_STATUS.CONVERTED) {
            markIndentConverted(poDetails.indentRef, poDetails.poNumber);
          }
        } catch (e) {
          console.warn('Indent conversion failed', e);
        }
      }
    } catch (err) {
      console.error('Failed to save Purchase Order', err);
      alert(err.message || 'Failed to save Purchase Order.');
    }
  };

  /**
   * Direct Purchase Order → Inventory is disabled (NO QUALITY APPROVAL = NO INVENTORY
   * UPDATE). The button now opens the Tax Invoice / Material Receipt screen, which is
   * the only entry point for a vendor delivery.
   */
  const handleInwardStock = (poPayload) => {
    const poNumber = poPayload?.poDetails?.poNumber;
    if (!poNumber) return;
    const progress = getPOProgress(poNumber);
    if (progress.pending === 0 && progress.ordered > 0) {
      alert(
        `PO ${poNumber} is already fully received (Pending 0) and closed.\nRejected quantity must be re-ordered on a new replacement PO.`
      );
      return;
    }
    navigate('/material-receipts', { state: { newReceiptFor: poNumber } });
  };

  const handleConvertToVendorBill = (po) => {
    navigate('/supplier-invoice', {
      state: {
        fromPO: true,
        po: po
      }
    });
  };

  const handlePrintPDF = async () => {
    if (!selectedPO) return;
    try {
      await generatePurchaseOrderPDF(selectedPO, { print: true });
    } catch {
      window.print();
    }
  };

  const handleDownloadPDF = async () => {
    if (!selectedPO) return;
    try {
      await generatePurchaseOrderPDF(selectedPO);
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
              ? 'Create Purchase Order'
              : mode === 'view'
              ? `Purchase Order: ${selectedPO?.poDetails?.poNumber || ''}`
              : 'Purchase Orders'}
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
              <button className="button-secondary" onClick={() => navigate('/vendor-quotations')}>Vendor Quotations</button>
              <button type="button" className="button-secondary" onClick={() => setShowExcelImport(true)}><Upload size={16}/> Import Excel</button>
            </>
          )}
        </div>
      </div>

      {showExcelImport && <ExcelImportDialog title="Purchase Orders" columns={poImportColumns} example={['PO-IMPORT-001','2026-01-15','Example Steel Suppliers','VEND-001','PRJ-001','PRAG-101','MS Plate 10mm',10,'Kg',85,18,153,1003,'2026-02-15','30 Days','Sample import']} instructions={['Required: PO Number, PO Date, Vendor Name or Vendor Code, Item Code, Quantity, Rate.', 'One item per row. Repeat the same PO Number to group multiple items into one Purchase Order.', 'Vendor and Item Code must match existing masters. Tax Amount and Total Amount are checked per line when supplied.', 'Imported Purchase Orders are created as Draft; normal quotation approval, approval and receiving workflows remain required.']} validate={validatePOImportRow} onImport={importPurchaseOrders} onClose={() => setShowExcelImport(false)}/>}

      {mode === 'list' && hasPermission('indent.convert') && (() => {
        const convertible = [INDENT_STATUS.SUBMITTED, INDENT_STATUS.AWAITING_PRODUCTION, INDENT_STATUS.UNDER_REVIEW];
        const vendorEnquiries = readStoredList('vendorEnquiries');
        const purchaseOrders = readStoredList('supplierPOHistory');
        const pendingIndents = getIndents().filter(
          (i) => i.sourceType !== 'storeDirect' && convertible.includes(i.status)
            && !hasVendorEnquiryForIndent(i, vendorEnquiries)
            && !hasPurchaseOrderForIndent(i, purchaseOrders)
        );
        if (pendingIndents.length === 0) return null;
        return (
          <div className="content-block" style={{ marginBottom: '16px' }}>
            <div className="block-header">
              <h2>Purchase Indents awaiting Vendor Enquiry ({pendingIndents.length})</h2>
            </div>
            <p style={{ margin: '0 0 12px', color: '#64748b', fontSize: '13px' }}>
              Create a Vendor Enquiry from an Admin-approved indent. A Purchase Order can be created only after the Vendor Quotation is approved by Admin.
            </p>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Indent No</th>
                    <th>Date</th>
                    <th>Sales Order</th>
                    <th>Customer</th>
                    <th>Materials</th>
                    <th>Required Date</th>
                    <th>Status</th>
                    <th>Next Step</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingIndents.map((i) => (
                    <tr key={i.indentNumber}>
                      <td><strong>{i.indentNumber}</strong></td>
                      <td>{i.indentDate}</td>
                      <td>{i.soNumber}</td>
                      <td>{i.customer || '—'}</td>
                      <td>{i.items?.length || 0}</td>
                      <td>{i.requiredDate || '—'}</td>
                      <td>
                        <span
                          className={`status-badge st-${String(i.status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
                        >
                          {i.status}
                        </span>
                      </td>
                      <td>
                        {(() => {
                          const hasEnquiry = hasVendorEnquiryForIndent(i, vendorEnquiries);
                          const canCreateEnquiry = i.sourceType !== 'storeDirect' && i.status === INDENT_STATUS.SUBMITTED && Boolean(i.adminApprovedAt);
                          return (
                            <button
                              className="button-small button-primary"
                              disabled={!hasEnquiry && !canCreateEnquiry}
                              onClick={() => navigate('/vendor-enquiry', {
                                state: canCreateEnquiry ? { purchaseIndent: i.indentNumber } : undefined
                              })}
                            >
                              {hasEnquiry ? 'Open Vendor Enquiries' : canCreateEnquiry ? 'Create Vendor Enquiry' : 'Awaiting Admin approval'}
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <div className="content-block">
        {mode === 'list' && (
          <>
            <div className="tab-nav report-tabs">
              <button type="button" className={`tab-link ${reportTab === 'orders' ? 'active' : ''}`} onClick={() => setReportTab('orders')}>
                Purchase Orders
              </button>
              <button type="button" className={`tab-link ${reportTab === 'open' ? 'active' : ''}`} onClick={() => setReportTab('open')}>
                Open PO Report
              </button>
            </div>

            {reportTab === 'orders' && (
            <>
            <div className="block-header">
              <h2>Purchase Orders</h2>
            </div>
            <RecordSearchBar value={poSearch} onChange={setPoSearch} placeholder="Search PO, supplier, project, SO, date, status..." label="Search purchase orders" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>PO Date</th>
                    <th>PO Number</th>
                    <th>Supplier / Vendor</th>
                    <th>Project / SO Ref</th>
                    <th>Due Date</th>
                    <th>Total Value</th>
                    <th>Status</th>
                    <th>PO Fulfillment Progress</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filterMaterialRecords(history, poSearch, ['reference','vendor','projectRef','soRef','date','dueDate','status']).length > 0 ? (
                    filterMaterialRecords(history, poSearch, ['reference','vendor','projectRef','soRef','date','dueDate','status']).map((po, idx) => {
                      const prog = getPOProgress(po.reference);
                      const displayStatus = prog.fulfillmentStatus || po.status;
                      return (
                      <tr key={idx}>
                        <td>{po.date}</td>
                        <td><strong>{po.reference}</strong></td>
                        <td>{po.vendor}</td>
                        <td>{po.projectRef || '-'}</td>
                        <td>{po.dueDate || '-'}</td>
                        <td>{po.total}</td>
                        <td>
                          <div>
                            <span
                              style={{
                                padding: '4px 10px',
                                borderRadius: '20px',
                                fontSize: '12px',
                                fontWeight: '600',
                                background:
                                  displayStatus === 'Received' || displayStatus === 'Fully Received' || displayStatus === 'Closed'
                                    ? '#dcfce7'
                                    : displayStatus === 'In Transit' || displayStatus === 'Partially Received' || displayStatus === 'Submitted'
                                    ? '#fef3c7'
                                    : displayStatus === 'Cancelled'
                                    ? '#fee2e2'
                                    : '#e0e7ff',
                                color:
                                  displayStatus === 'Received' || displayStatus === 'Fully Received' || displayStatus === 'Closed'
                                    ? '#166534'
                                    : displayStatus === 'Cancelled'
                                    ? '#b91c1c'
                                    : displayStatus === 'In Transit' || displayStatus === 'Partially Received' || displayStatus === 'Submitted'
                                    ? '#92400e'
                                    : '#3730a3'
                              }}
                            >
                              {displayStatus}
                            </span>
                            {prog.ordered > 0 && (
                              <div style={{ marginTop: '4px', fontSize: '11px', color: '#64748b' }}>
                                Fulfillment: {prog.fulfillmentStatus}
                              </div>
                            )}
                            {po.billedInvoiceRef && (
                              <div style={{ marginTop: '4px' }}>
                                <span
                                  style={{
                                    padding: '2px 8px',
                                    borderRadius: '12px',
                                    fontSize: '11px',
                                    fontWeight: '700',
                                    background: '#f3e8ff',
                                    color: '#6b21a8'
                                  }}
                                >
                                  <ReceiptText size={14} aria-hidden="true" /> Bill: {po.billedInvoiceRef}
                                </span>
                              </div>
                            )}
                          </div>
                        </td>
                        <td>
                          {(() => {
                            const prog = getPOProgress(po.reference);
                            if (prog.ordered === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                            const cell = (label, value, color) => (
                              <div style={{ whiteSpace: 'nowrap' }}>
                                <span style={{ color: '#64748b', fontWeight: 600 }}>{label}:</span>{' '}
                                <span style={{ color, fontWeight: 700 }}>{value}</span>
                              </div>
                            );
                            return (
                              <div style={{ fontSize: '11.5px', lineHeight: 1.45 }}>
                                {cell('Ordered', prog.ordered, '#334155')}
                                {cell('Original Received', prog.originalArrived, '#166534')}
                                {cell('Original Accepted', prog.originalAccepted, '#166534')}
                                {cell('Rejected', prog.rejected, prog.rejected > 0 ? '#b91c1c' : '#166534')}
                                {cell('Replacement Received', prog.replacementArrived, '#1d4ed8')}
                                {cell('Replacement Accepted', prog.replacementAccepted, '#1d4ed8')}
                                {cell('Total Accepted', `${prog.totalAccepted} / ${prog.ordered}`, '#166534')}
                                {cell('Physical Receipt Balance', prog.physicalReceiptBalance, prog.physicalReceiptBalance > 0 ? '#b91c1c' : '#166534')}
                                {cell('Accepted Quantity Shortage', prog.acceptedQuantityShortage, prog.acceptedQuantityShortage > 0 ? '#b91c1c' : '#166534')}
                                {cell('QC Pending', prog.qcPending, prog.qcPending > 0 ? '#b45309' : '#166534')}
                                {cell('Unresolved Rejected', prog.openRejected, prog.openRejected > 0 ? '#b91c1c' : '#166534')}
                              </div>
                            );
                          })()}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="button-small"
                              onClick={() => {
                                setSelectedPO(po.payload);
                                setMode('view');
                              }}
                            >
                              View
                            </button>
                            {prog.pending > 0 && !['Cancelled'].includes(displayStatus) && (
                              <button
                                className="button-small"
                                onClick={() => handleInwardStock(po.payload)}
                                style={{ color: '#16a34a', borderColor: '#bbf7d0' }}
                                title="Record vendor delivery against this PO (Tax Invoice / Material Receipt)"
                              >
                                Receive
                              </button>
                            )}
                            {po.billedInvoiceRef ? (
                              <button
                                className="button-small"
                                style={{ color: '#7c3aed', borderColor: '#ddd6fe' }}
                                onClick={() => handleViewVendorBill(po.billedInvoiceRef)}
                                title="View Linked Vendor Bill"
                              >
                                View Bill
                              </button>
                            ) : (
                              <button
                                className="button-small"
                                style={{ color: '#86198f', borderColor: '#f5d0fe' }}
                                onClick={() => handleConvertToVendorBill(po.payload)}
                                title="Record Vendor Bill for this PO"
                              >
                                Record Bill
                              </button>
                            )}
                            <button
                              className="button-small"
                              onClick={() => {
                                const p = po.payload;
                                setPoDetails(p.poDetails);
                                setVendorDetails(p.vendorDetails);
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
                      <td colSpan="9" className="no-history-row">
                        {history.length ? 'No purchase orders match your search.' : 'No Purchase Orders yet. Create one from an Admin-approved Vendor Quotation.'}
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
                title="Open PO Report"
                subTitle="Purchase orders not yet fully received / cancelled"
                filename={`Open-PO-${new Date().toISOString().slice(0, 10)}`}
                dateField="date"
                columns={[
                  { key: 'date', label: 'PO Date' },
                  { key: 'reference', label: 'PO No' },
                  { key: 'vendor', label: 'Supplier / Vendor' },
                  { key: 'projectRef', label: 'Project / SO Ref', render: (r) => r.projectRef || '-' },
                  { key: 'dueDate', label: 'Due Date', render: (r) => r.dueDate || '-' },
                  { key: 'amount', label: 'PO Value (₹)', align: 'right', render: (r) => parseINR(r.total).toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
                  { key: 'orderedQuantity', label: 'Ordered Quantity' },
                  { key: 'originalReceived', label: 'Original Received' },
                  { key: 'originalAccepted', label: 'Original Accepted' },
                  { key: 'rejected', label: 'Rejected' },
                  { key: 'replacementReceived', label: 'Replacement Received' },
                  { key: 'replacementAccepted', label: 'Replacement Accepted' },
                  { key: 'totalAccepted', label: 'Total Accepted' },
                  { key: 'physicalReceiptBalance', label: 'Physical Receipt Balance' },
                  { key: 'acceptedQuantityShortage', label: 'Accepted Quantity Shortage' },
                  { key: 'qcPending', label: 'QC Pending' },
                  { key: 'status', label: 'Status' }
                ]}
                rows={history.map((r) => {
                  const progress = getPOProgress(r.reference);
                  return { ...r, status: progress.fulfillmentStatus || r.status,
                    orderedQuantity: progress.ordered, originalReceived: progress.originalArrived,
                    originalAccepted: progress.originalAccepted, rejected: progress.rejected,
                    replacementReceived: progress.replacementArrived, replacementAccepted: progress.replacementAccepted,
                    totalAccepted: progress.totalAccepted, physicalReceiptBalance: progress.physicalReceiptBalance,
                    acceptedQuantityShortage: progress.acceptedQuantityShortage, qcPending: progress.qcPending };
                }).filter((r) => !['Received', 'Fully Received', 'Closed', 'Cancelled'].includes(r.status))}
                totals={[
                  { colKey: 'amount', render: (rs) => rs.reduce((a, r) => a + parseINR(r.total), 0) }
                ]}
              />
            )}
          </>
        )}

        {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSavePO}>
            {poDetails.quotationRef && (
              <div
                className="tax-summary"
                style={{ marginBottom: '16px', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '12px', borderRadius: '8px' }}
              >
                <div style={{ fontSize: '13px', color: '#166534', fontWeight: 600, marginBottom: '6px' }}>
                  Generated from accepted Vendor Quotation {poDetails.quotationRef}
                  {poDetails.quotationDate ? ` dated ${poDetails.quotationDate}` : ''}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '6px', fontSize: '12px', color: '#334155' }}>
                  <div><strong>Vendor:</strong> {vendorDetails.companyName || vendorDetails.vendorName || '-'}</div>
                  <div><strong>Purchase Indent:</strong> {poDetails.indentRef || '-'}</div>
                  <div><strong>Vendor Enquiry:</strong> {poDetails.enquiryRef || '-'}</div>
                  <div><strong>Vendor Quotation:</strong> {poDetails.quotationRef || '-'}</div>
                  <div><strong>Sales Order:</strong> {poDetails.salesOrderRef || '-'}</div>
                  <div><strong>Project ID:</strong> {poDetails.projectRef || '-'}</div>
                </div>
              </div>
            )}
            <div className="form-section">
              <div className="section-heading">
                <h3>PO Meta Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>PO Number</label>
                  <input
                    type="text"
                    value={poDetails.poNumber}
                    onChange={(e) => setPoDetails({ ...poDetails, poNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>PO Date</label>
                  <input
                    type="date"
                    value={poDetails.poDate}
                    onChange={(e) => setPoDetails({ ...poDetails, poDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Your Ref No. (Vendor Quotation / Reference)</label>
                  <input
                    type="text"
                    value={poDetails.yourRefNo || ''}
                    onChange={(e) => setPoDetails({ ...poDetails, yourRefNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Your Ref Date</label>
                  <input
                    type="date"
                    value={poDetails.yourRefDate || ''}
                    onChange={(e) => setPoDetails({ ...poDetails, yourRefDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Expected Delivery Date</label>
                  <input
                    type="date"
                    value={poDetails.deliveryDueDate}
                    onChange={(e) => setPoDetails({ ...poDetails, deliveryDueDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Project / SO Reference</label>
                  <input
                    type="text"
                    placeholder="e.g. PRAG-PRJ-01 or SO-XXXX"
                    value={poDetails.projectRef}
                    onChange={(e) => setPoDetails({ ...poDetails, projectRef: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Link to Purchase Request (Optional)</label>
                  <select
                    value={poDetails.prRef || ''}
                    onChange={(e) => setPoDetails({ ...poDetails, prRef: e.target.value })}
                  >
                    <option value="">-- None --</option>
                    {(() => {
                      try {
                        const prs = JSON.parse(localStorage.getItem('storePurchaseRequests') || '[]');
                        return prs.filter((p) => p.status === 'Approved').map((p) => (
                          <option key={p.prNumber} value={p.prNumber}>{p.prNumber} - {p.partName || p.projectId || 'N/A'} ({p.items?.length || 0} items)</option>
                        ));
                      } catch { return []; }
                    })()}
                  </select>
                </div>
                <div className="field-group">
                  <label>Link to Purchase Indent (Optional)</label>
                  <select
                    value={poDetails.indentRef || ''}
                    onChange={(e) => {
                      const indentNo = e.target.value;
                      if (!indentNo) {
                        setPoDetails({ ...poDetails, indentRef: '' });
                        return;
                      }
                      const ind = getIndent(indentNo);
                      if (!ind) return;
                      setPoDetails((prev) => ({
                        ...prev,
                        indentRef: indentNo,
                        salesOrderRef: ind.soNumber || prev.salesOrderRef,
                        projectRef: ind.projectId || prev.projectRef,
                        deliveryDueDate: ind.requiredDate || prev.deliveryDueDate,
                        notes: `Converted from Purchase Indent ${indentNo} (Sales Order ${ind.soNumber}).`
                      }));
                      setItems(
                        (ind.items || []).map((it) => ({
                          itemCode: it.materialCode || '',
                          itemName: it.materialName || '',
                          drawingNo: it.drawingNo || '',
                          hsnSac: '',
                          quantity: it.purchaseQty || 1,
                          unit: it.unit || 'Nos',
                          unitPrice: '',
                          gst: '18'
                        }))
                      );
                    }}
                  >
                    <option value="">-- None --</option>
                    {(() => {
                      try {
                        const list = JSON.parse(localStorage.getItem('purchaseIndents') || '[]');
                        return list
                          .filter((i) => i.sourceType !== 'storeDirect' && i.status !== 'Cancelled' && i.status !== 'Converted to PO')
                          .map((i) => (
                            <option key={i.indentNumber} value={i.indentNumber}>
                              {i.indentNumber} - {i.soNumber} ({i.items?.length || 0} materials)
                            </option>
                          ));
                      } catch { return []; }
                    })()}
                  </select>
                </div>
                <div className="field-group">
                  <label>Link to Vendor Enquiry (Optional)</label>
                  <select
                    value={poDetails.enquiryRef || ''}
                    onChange={(e) => {
                      const enqNo = e.target.value;
                      const enq = readStoredList('vendorEnquiries').find(
                        (x) => String(x.enquiryNumber) === String(enqNo)
                      );
                      setPoDetails((prev) => ({
                        ...prev,
                        enquiryRef: enqNo,
                        quotationRef: '',
                        indentRef: enq?.indentNumber || prev.indentRef,
                        salesOrderRef: enq?.soNumber || prev.salesOrderRef,
                        projectRef: enq?.projectId || prev.projectRef,
                        paymentTerms: enq?.paymentTerms || prev.paymentTerms
                      }));
                    }}
                  >
                    <option value="">-- None --</option>
                    {readStoredList('vendorEnquiries')
                      .filter((e) => {
                        const sourceIndent = e.indentNumber ? getIndent(e.indentNumber) : null;
                        return sourceIndent?.sourceType !== 'storeDirect' && (!sourceIndent || sourceIndent.status !== 'Converted to PO');
                      })
                      .map((e) => (
                        <option key={e.enquiryNumber} value={e.enquiryNumber}>
                          {e.enquiryNumber} - {e.indentNumber || e.prNumber || 'Ad-hoc'} ({e.items?.length || 0} materials)
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field-group">
                  <label>Vendor Quotation (Optional)</label>
                  <select
                    value={poDetails.quotationRef || ''}
                    onChange={(e) => {
                      const vqNo = e.target.value;
                      if (!vqNo) {
                        setPoDetails((prev) => ({ ...prev, quotationRef: '' }));
                        return;
                      }
                      /* Same authoritative loader used by the "Create Purchase Order"
                         action on the Vendor Quotation screen — vendor, items, prices,
                         totals and the whole chain come from the quotation. */
                      loadQuotationAsPO(vqNo);
                    }}
                  >
                    <option value="">-- None --</option>
                    {readStoredList('vendorQuotations')
                      .filter((q) => canCreatePOFromQuotation(q.quotationNumber).allowed)
                      .map((q) => (
                        <option key={q.quotationNumber} value={q.quotationNumber}>
                          {q.quotationNumber} - {q.vendorName} ({q.enquiryNumber})
                        </option>
                      ))}
                  </select>
                  <small className="field-hint">
                    Only accepted quotations that have not yet generated a Purchase Order.
                  </small>
                </div>
                <div className="field-group">
                  <label>Payment Terms</label>
                  <input
                    type="text"
                    value={poDetails.paymentTerms}
                    onChange={(e) => setPoDetails({ ...poDetails, paymentTerms: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Order Status</label>
                  <select
                    value={poDetails.poStatus}
                    onChange={(e) => setPoDetails({ ...poDetails, poStatus: e.target.value })}
                  >
                    <option value="Draft">Draft</option>
                    <option value="Submitted">Submitted</option>
                    <option value="Approved">Approved</option>
                    <option value="Awaiting Delivery">Awaiting Delivery</option>
                    <option value="Partially Received">Partially Received</option>
                    <option value="Fully Received">Fully Received</option>
                    <option value="Issued">Issued (legacy)</option>
                    <option value="In Transit">In Transit (legacy)</option>
                    <option value="Received">Received (legacy)</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
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
                  <label>GST Number</label>
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
                <h3>Ship To (Delivery Location)</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Ship To Contact Person</label>
                  <input
                    type="text"
                    placeholder="e.g. Mr. Varadaraj (Stores)"
                    value={poDetails.shipToName || ''}
                    onChange={(e) => setPoDetails({ ...poDetails, shipToName: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Ship To Mobile</label>
                  <input
                    type="text"
                    placeholder="e.g. +91 9880519466"
                    value={poDetails.shipToMobile || ''}
                    onChange={(e) => setPoDetails({ ...poDetails, shipToMobile: e.target.value })}
                  />
                </div>
                <div className="field-group full-width">
                  <label>Ship To Address</label>
                  <textarea
                    rows="2"
                    placeholder="Delivery address (company / site / city - pincode)"
                    value={poDetails.shipToAddress || ''}
                    onChange={(e) => setPoDetails({ ...poDetails, shipToAddress: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Materials & Items to Purchase</h3>
              </div>
              <div className="item-table-wrapper">
                <table className="item-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>SL.No</th>
                      <th style={{ width: '260px' }}>Description</th>
                      <th style={{ width: '140px' }}>Drawing / Spec</th>
                      <th style={{ width: '110px' }}>HSN/SAC</th>
                      <th style={{ width: '90px' }}>Qty</th>
                      <th style={{ width: '110px' }}>Unit</th>
                      <th style={{ width: '125px' }}>Unit Rate</th>
                      <th style={{ width: '85px' }}>Disc %</th>
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
                            placeholder="Item Name"
                            value={item.itemName || ''}
                            onChange={(e) => handleFieldChange(idx, 'itemName', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="Spec/Drawing"
                            value={item.drawingNo || ''}
                            onChange={(e) => handleFieldChange(idx, 'drawingNo', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="HSN"
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
                          <AddableSelect value={item.unit || 'Nos'} onChange={(event) => handleFieldChange(idx, 'unit', event.target.value)} options={DEFAULT_UNITS} masterType="unit" title="Add Unit of Measurement" addLabel="+ Add New Unit" addNewInOptions />
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
                            placeholder="0"
                            value={item.discountPct ?? ''}
                            onChange={(e) => handleFieldChange(idx, 'discountPct', e.target.value)}
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
                          + Add Material / Item
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
                      value={poDetails.discount}
                      onChange={(e) => setPoDetails({ ...poDetails, discount: e.target.value })}
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
                <div className="tax-summary-row">
                  <span>Packing Charges</span>
                  <div>
                    ₹{' '}
                    <input
                      type="number"
                      value={poDetails.packingCharges ?? ''}
                      onChange={(e) => setPoDetails({ ...poDetails, packingCharges: e.target.value })}
                      placeholder="0.00"
                      className="discount-input"
                    />
                  </div>
                </div>
                <div className="tax-summary-row">
                  <span>Freight</span>
                  <div>
                    ₹{' '}
                    <input
                      type="number"
                      value={poDetails.freight ?? ''}
                      onChange={(e) => setPoDetails({ ...poDetails, freight: e.target.value })}
                      placeholder="0.00"
                      className="discount-input"
                    />
                  </div>
                </div>
                <div className="tax-summary-row total">
                  <span>Grand Total</span>
                  <strong>₹ {poTotals.grandTotal.toFixed(2)}</strong>
                </div>
                <div className="amount-in-words">
                  <span>Total Purchase Value In Amount</span>
                  <p>{poWords}</p>
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Terms & Delivery Instructions</h3>
              </div>

              {/* A. Legal terms printed on the PO — company standard, template-driven */}
              <TermsTemplateEditor
                label="PO Terms and Conditions"
                value={poDetails.termsAndConditions}
                onChange={(v) => setPoDetails({ ...poDetails, termsAndConditions: v })}
                storageKey={PO_TERMS_TEMPLATES_KEY}
                defaultTemplates={PO_TERMS_TEMPLATES}
                newTemplatePrefix="PO Terms"
                addModalTitle="Add Purchase Order Terms Template"
                addModalSubtitle="Create a reusable terms set for future purchase orders."
                hint="These clauses are printed on the Purchase Order sent to the vendor. Pick a saved template, edit as needed, or add your own with ＋ Add Template."
                rows={5}
              />

              {/* B. What the vendor actually offered — carried from the quotation, read-only */}
              {(() => {
                const src = findSourceQuotation(poDetails.quotationRef);
                if (!src) return null;
                const quotedTerms = poDetails.quotationTerms || src.otherTerms || '';
                return (
                  <div className="field-group full-width" style={{ marginTop: '16px' }}>
                    <label>Vendor Quoted Terms (from {src.quotationNumber}) — read only</label>
                    <div
                      style={{
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px',
                        padding: '12px',
                        background: '#f8fafc',
                        fontSize: '13px',
                        lineHeight: '1.7'
                      }}
                    >
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}>
                        <div><strong>Vendor:</strong> {src.vendorName || '-'}</div>
                        <div><strong>Quotation:</strong> {src.quotationNumber}</div>
                        <div><strong>Quotation Date:</strong> {dateOnly(src.quotationDate || src.createdAt) || '-'}</div>
                        <div><strong>Payment Terms:</strong> {src.paymentTerms || poDetails.paymentTerms || '-'}</div>
                        <div><strong>Validity:</strong> {src.validity || '-'}</div>
                        <div><strong>Delivery:</strong> {src.deliveryDays ? `${src.deliveryDays} days` : '-'}</div>
                      </div>
                      {quotedTerms && (
                        <div style={{ marginTop: '8px' }}>
                          <strong>Vendor quoted terms:</strong> {quotedTerms}
                        </div>
                      )}
                      {src.remarks && (
                        <div style={{ marginTop: '4px', color: '#475569' }}>
                          <strong>Vendor remarks:</strong> {src.remarks}
                        </div>
                      )}
                    </div>
                    <p className="muted-text" style={{ fontSize: '12px', marginTop: '6px' }}>
                      Carried over from the approved quotation so the vendor's offer cannot drift from the order.
                    </p>
                  </div>
                );
              })()}

              {/* C. Per-order operational instructions */}
              <div className="field-group full-width" style={{ marginTop: '16px' }}>
                <label>Special Instructions / Delivery Gate Notes</label>
                <textarea
                  rows="2"
                  value={poDetails.notes}
                  onChange={(e) => setPoDetails({ ...poDetails, notes: e.target.value })}
                  placeholder="e.g. deliver at Gate 2, 9 AM – 5 PM; mark crates with PO number and project ID"
                />
              </div>
              <div className="field-group full-width" style={{ marginTop: '16px' }}>
                <label>
                  Internal Notes{' '}
                  <span style={{ fontWeight: 400, color: '#64748b' }}>(not printed on the PO)</span>
                </label>
                <textarea
                  rows="2"
                  value={poDetails.internalNotes || ''}
                  onChange={(e) => setPoDetails({ ...poDetails, internalNotes: e.target.value })}
                  placeholder="Only for the Purchase team — follow-up calls, negotiation notes, expected dispatch"
                />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setMode('list')}>
                Cancel
              </button>
              <button type="submit" className="button-primary">
                Save Purchase Order
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedPO && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end' }}>
              {/* "Record Delivery (Tax Invoice / Receipt)" and "Enter Tax Invoice /
                  Material Receipt" both opened the same /material-receipts form for the
                  same PO — one action offered twice, and it is a Store action that a
                  Purchase user could never save. Removed: the Store raises the receipt
                  from Inventory / Material Receipts. */}
              <button className="button-primary" onClick={handleDownloadPDF}>
                Download PDF
              </button>
              <button className="button-secondary" onClick={handlePrintPDF}>
                Print PO
              </button>
              {(selectedPO.poDocuments || []).map((d) => (
                <button
                  key={d.id}
                  className="button-secondary"
                  onClick={() => openWorkflowDocument(d)}
                  title={`Sent to the Store Department on save — ${d.name}`}
                >
                  <FileText size={14} aria-hidden="true" /> PO PDF sent to Store
                </button>
              ))}
              <button
                className="button-secondary"
                onClick={() => {
                  setPoDetails(selectedPO.poDetails);
                  setVendorDetails(selectedPO.vendorDetails);
                  setCompanyDetails(selectedPO.companyDetails);
                  setItems(selectedPO.items);
                  setMode('create');
                }}
              >
                Edit PO
              </button>
              {history.find((h) => h.reference === selectedPO.poDetails?.poNumber)?.billedInvoiceRef ? (
                <button
                  className="button-secondary"
                  onClick={() =>
                    handleViewVendorBill(
                      history.find((h) => h.reference === selectedPO.poDetails?.poNumber)?.billedInvoiceRef
                    )
                  }
                  style={{ background: '#f5f3ff', color: '#6d28d9', borderColor: '#ddd6fe', fontWeight: '600' }}
                >
                  <ReceiptText size={14} aria-hidden="true" /> View Linked Bill ({history.find((h) => h.reference === selectedPO.poDetails?.poNumber)?.billedInvoiceRef})
                </button>
              ) : (
                <button
                  className="button-secondary"
                  onClick={() => handleConvertToVendorBill(selectedPO)}
                  style={{ background: '#fdf4ff', color: '#86198f', borderColor: '#f5d0fe', fontWeight: '600' }}
                >
                  <ReceiptText size={14} aria-hidden="true" /> Record Vendor Bill
                </button>
              )}
            </div>

            <div className="doc-page-container">
              <div className="quotation-doc-sheet printable">
                <h1 className="doc-main-title">PURCHASE ORDER</h1>

                {/* Company Header Box */}
                <div className="doc-company-box">
                    <div className="doc-company-left">
                      <div className="doc-company-name">{selectedPO.companyDetails?.companyName || 'PRAGMATIC ENGINEERS'}</div>
                      <div className="doc-company-details">
                        <div>{selectedPO.companyDetails?.address || 'NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083'}</div>
                        <div>GSTIN: {selectedPO.companyDetails?.gstin || '29AKWPP8736E1ZA'}</div>
                        <div>Phone: {selectedPO.companyDetails?.phone || '+91 9880030466'}</div>
                      </div>
                    </div>
                    <div className="doc-company-mid">
                      <div>Email: {selectedPO.companyDetails?.email || 'pragmatic.vasudev@gmail.com'}</div>
                      <div>State: {(selectedPO.companyDetails?.state || 'Karnataka (29)').replace(/\s*\(.*\)\s*$/, '')}</div>
                    </div>
                    <div className="doc-company-logo">
                      <img src={logoUrl} alt="Company Logo" />
                    </div>
                  </div>

                  {/* Split Box */}
                <div className="doc-split-box">
                  <div className="doc-half-box">
                    <div className="doc-box-header">Vendor / Supplier:</div>
                    <div className="doc-box-body">
                      <div className="doc-customer-name">
                        {selectedPO.vendorDetails?.companyName || selectedPO.vendorDetails?.vendorName || '-'}
                      </div>
                      {selectedPO.vendorDetails?.address && (
                        <div className="doc-customer-address">{selectedPO.vendorDetails.address}</div>
                      )}
                      <div className="doc-customer-inline">
                        {selectedPO.vendorDetails?.contactNumber && (
                          <div>Contact: {selectedPO.vendorDetails.contactNumber}</div>
                        )}
                        {selectedPO.vendorDetails?.gstNumber && (
                          <div>GSTIN: {selectedPO.vendorDetails.gstNumber}</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="doc-half-box doc-half-right">
                    <div className="doc-box-header">Purchase Order Details:</div>
                    <div className="doc-box-body">
                      <div><strong>PO Number:</strong> {selectedPO.poDetails?.poNumber || '-'}</div>
                      <div><strong>PO Date:</strong> {selectedPO.poDetails?.poDate || '-'}</div>
                      <div><strong>Your Ref No.:</strong> {selectedPO.poDetails?.yourRefNo || selectedPO.poDetails?.quotationRef || '-'}</div>
                      <div><strong>Your Ref Date:</strong> {selectedPO.poDetails?.yourRefDate || selectedPO.poDetails?.quotationDate || '-'}</div>
                      {selectedPO.poDetails?.deliveryDueDate && (
                        <div><strong>Target Delivery:</strong> {selectedPO.poDetails.deliveryDueDate}</div>
                      )}
                      {selectedPO.poDetails?.projectRef && (
                        <div><strong>Project Ref:</strong> {selectedPO.poDetails.projectRef}</div>
                      )}
                      <div><strong>Payment Terms:</strong> {selectedPO.poDetails?.paymentTerms || '30 Days'}</div>
                      <div><strong>Status:</strong> {getPOProgress(selectedPO.poDetails?.poNumber).status || selectedPO.poDetails?.poStatus || 'Issued'}</div>
                      {selectedPO.poDetails?.indentRef && (
                        <div><strong>Purchase Indent:</strong> {selectedPO.poDetails.indentRef}</div>
                      )}
                      {selectedPO.poDetails?.salesOrderRef && (
                        <div><strong>Sales Order:</strong> {selectedPO.poDetails.salesOrderRef}</div>
                      )}
                      {(() => {
                        const prog = getPOProgress(selectedPO.poDetails?.poNumber);
                        if (!prog.ordered) return null;
                        return (
                          <>
                            <div style={{ fontWeight: 700 }}>
                              Ordered: {prog.ordered} | Physical receipt balance: {prog.physicalReceiptBalance} | Accepted quantity shortage: {prog.acceptedQuantityShortage}
                              {prog.status === 'Fully Received' ? ' - Fully Received' : prog.status === 'Received / Awaiting QC' ? ' - Awaiting Quality Check' : ''}
                            </div>
                            <div style={{ fontWeight: 600, fontSize: '12px', color: '#475569' }}>
                              Original Received: {prog.originalArrived} | Original Accepted: {prog.originalAccepted} | Rejected: {prog.rejected} | Replacement Received: {prog.replacementArrived} | Replacement Accepted: {prog.replacementAccepted} | Total Accepted: {prog.totalAccepted} | QC Pending: {prog.qcPending} | Unresolved Rejected: {prog.openRejected}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Ship To (per PO-to-Supplier format) */}
                <div className="doc-full-box">
                  <div className="doc-box-title">Ship To:</div>
                  <div className="doc-box-text">
                    {selectedPO.poDetails?.shipToName && <div>{selectedPO.poDetails.shipToName}</div>}
                    <div>{selectedPO.companyDetails?.companyName || 'PRAGMATIC ENGINEERS'}</div>
                    <div>{selectedPO.poDetails?.shipToAddress || selectedPO.poDetails?.deliveryAddress || '-'}</div>
                    {selectedPO.poDetails?.shipToMobile && <div>Mobile: {selectedPO.poDetails.shipToMobile}</div>}
                  </div>
                </div>

                {/* Intro */}
                <div style={{ margin: '10px 0', fontSize: '12.5px', textAlign: 'justify' }}>
                  We take pleasure in placing our order with you for the supply of the following items
                  against the subject PO in accordance with the terms and conditions mentioned.
                </div>

                {/* Items Table (PO-to-Supplier format) */}
                <table className="doc-items-table">
                  <thead>
                    <tr>
                      <th className="th-slno">SL.No</th>
                      <th style={{ textAlign: 'left' }}>Description of Materials</th>
                      <th className="th-hsnSac">HSN/SAC</th>
                      <th className="th-quantity text-right">QTY</th>
                      <th className="th-unit text-center">UOM</th>
                      <th className="th-unitPrice text-right">Rate</th>
                      <th className="th-gst text-right">Disc %</th>
                      <th className="th-unitPrice text-right">Unit Price</th>
                      <th className="th-amount text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPO.items?.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-center">{idx + 1}</td>
                        <td className="text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                          {(item.itemCode || item.drawingNo) && (
                            <div style={{ fontSize: '11px', color: '#475569' }}>
                              {[item.itemCode, item.drawingNo ? `(${item.drawingNo})` : ''].filter(Boolean).join(' ')}
                            </div>
                          )}
                        </td>
                        <td className="text-left">{item.hsnSac || '-'}</td>
                        <td className="text-right">{item.quantity || 0}</td>
                        <td className="text-center">{item.unit || 'Nos'}</td>
                        <td className="text-right">{Number(item.unitPrice || 0).toFixed(2)}</td>
                        <td className="text-right">{Number(item.discountPct || 0) > 0 ? item.discountPct : '-'}</td>
                        <td className="text-right">
                          {(Number(item.unitPrice || 0) * (1 - (Number(item.discountPct || 0) / 100))).toFixed(2)}
                        </td>
                        <td className="text-right">{Number(item.amount || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="doc-total-row">
                      <td colSpan={3} className="font-bold text-left">Total</td>
                      <td className="font-bold text-right">
                        {selectedPO.items?.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
                      </td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td></td>
                      <td className="font-bold text-right">
                        {Number(selectedPO.totals?.subtotal || 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                {/* Totals block (PO-to-Supplier format) */}
                {(() => {
                  const pt = computePOTotals(selectedPO.totals || {}, selectedPO.poDetails || {});
                  return (
                    <div className="doc-tax-summary-wrapper">
                      <div className="doc-tax-right">
                        <div className="doc-summary-line">
                          <span>Total Amount</span>
                          <span>₹ {pt.totalAmount.toFixed(2)}</span>
                        </div>
                        {pt.discount > 0 && (
                          <div className="doc-summary-line">
                            <span>Discount</span>
                            <span>- ₹ {pt.discount.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="doc-summary-line">
                          <span>Packing Charges</span>
                          <span>₹ {pt.packingCharges.toFixed(2)}</span>
                        </div>
                        <div className="doc-summary-line">
                          <span>Sub Total</span>
                          <span>₹ {pt.subTotal.toFixed(2)}</span>
                        </div>
                        {pt.totalGST > 0 && (
                          <>
                            <div className="doc-summary-line">
                              <span>CGST @ {pt.gstRate}%</span>
                              <span>₹ {pt.cgst.toFixed(2)}</span>
                            </div>
                            <div className="doc-summary-line">
                              <span>SGST @ {pt.gstRate}%</span>
                              <span>₹ {pt.sgst.toFixed(2)}</span>
                            </div>
                          </>
                        )}
                        <div className="doc-summary-line">
                          <span>FREIGHT</span>
                          <span>₹ {pt.freight.toFixed(2)}</span>
                        </div>
                        <div className="doc-summary-line doc-summary-total">
                          <strong>GRAND TOTAL</strong>
                          <strong>₹ {pt.grandTotal.toFixed(2)}</strong>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Amount in Words (PO-to-Supplier format) */}
                <div className="doc-full-box">
                  <div className="doc-box-title">Total Purchase Value In Amount:</div>
                  <div className="doc-box-text">
                    {poAmountInWords(computePOTotals(selectedPO.totals || {}, selectedPO.poDetails || {}).grandTotal)}
                  </div>
                </div>

                {/* Notes */}
                {selectedPO.poDetails?.notes && (
                  <div className="doc-full-box">
                    <div className="doc-box-title">Delivery Instructions:</div>
                    <div className="doc-box-text">{selectedPO.poDetails.notes}</div>
                  </div>
                )}

                {/* Vendor's own offer, carried from the quotation (not our legal terms) */}
                {(() => {
                  const pd = selectedPO.poDetails || {};
                  const src = findSourceQuotation(pd.quotationRef);
                  const quoted = pd.quotationTerms || src?.otherTerms || '';
                  const lines = [
                    pd.paymentTerms ? `Payment terms: ${pd.paymentTerms}` : '',
                    src?.validity ? `Quotation valid until: ${src.validity}` : '',
                    src?.deliveryDays ? `Delivery: ${src.deliveryDays} days` : '',
                    quoted ? `Terms quoted by vendor: ${quoted}` : ''
                  ].filter(Boolean);
                  if (!lines.length) return null;
                  return (
                    <div className="doc-full-box">
                      <div className="doc-box-title">
                        As Quoted by Vendor{src ? ` (${src.quotationNumber}${src.vendorName ? `, ${src.vendorName}` : ''})` : ''}:
                      </div>
                      <div className="doc-terms-list">
                        {lines.map((t, idx) => (
                          <div key={idx} className="doc-term-item">{t}</div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

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
                        <div className="doc-term-item">Standard purchase terms and inspection criteria apply.</div>
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

export default PurchaseOrderPage;

