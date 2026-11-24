import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { hasPermission, isAdmin, getCurrentUserInfo } from '../utils/permissions.js';
import {
  getAllVendorEnquiries,
  getAllVendorQuotations,
  createVendorQuotation,
  updateVendorQuotation,
  updateVendorEnquiry,
  deleteVendorQuotation,
  QUOTATION_STATUS,
  QUOTATION_ACCEPTED_STATUSES,
  QUOTATION_PO_CREATED_STATUSES,
  dateOnly
} from '../utils/storeService.js';
import {
  canCreatePOFromQuotation,
  quotationAlreadyConverted,
  getPOForQuotation,
  acceptQuotation,
  getSalesOrderByRef
} from '../utils/workflowService.js';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterMaterialRecords } from '../utils/historySearch.js';
import { enrichCustomerDetails } from '../utils/customerMaster.js';
import {
  getQuotationFormVendorChoices,
  hasPendingEnquiryVendor,
  hasQuotationForEnquiryVendor,
  vendorEntryName
} from '../utils/vendorQuotationVendor.js';

const STATUS_COLORS = {
  Received: { bg: '#eff6ff', color: '#1d4ed8' },
  Accepted: { bg: '#f0fdf4', color: '#166534' },
  'PO Created': { bg: '#ecfdf5', color: '#065f46' },
  Ordered: { bg: '#ecfdf5', color: '#065f46' },
  Rejected: { bg: '#fef2f2', color: '#991b1b' },
  Cancelled: { bg: '#f1f5f9', color: '#475569' }
};

/** Accepted → PO may be created. PO Created → PO already exists. */
const isAcceptedQuotation = (q) => QUOTATION_ACCEPTED_STATUSES.includes(String(q?.status));
const isConvertedQuotation = (q) => QUOTATION_PO_CREATED_STATUSES.includes(String(q?.status)) || quotationAlreadyConverted(q);
const poNumberOf = (q) => q?.poNumber || q?.purchaseOrderNumber || getPOForQuotation(q?.quotationNumber)?.reference || '';
const rupees = (n) => `₹ ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const StatusBadge = ({ status }) => {
  const c = STATUS_COLORS[status] || STATUS_COLORS.Received;
  return (
    <span className="status-badge" style={{ background: c.bg, color: c.color }}>
      {status}
    </span>
  );
};

const VendorQuotationPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const canCreate = hasPermission('purchase_request.create') || hasPermission('purchase_request.approve');
  /* Quotations are recorded by Purchase but approved only by the Admin. */
  const canApprove = isAdmin();

  const [enquiries, setEnquiries] = useState([]);
  const [quotations, setQuotations] = useState([]);
  const [quotationSearch, setQuotationSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedEnquiry, setSelectedEnquiry] = useState(null);
  const [editingQuotation, setEditingQuotation] = useState(null);
  const [vqItems, setVqItems] = useState([]);
  const [vendorName, setVendorName] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [vendorContact, setVendorContact] = useState('');
  const [vendorEmail, setVendorEmail] = useState('');
  const [enquiryVendorChoices, setEnquiryVendorChoices] = useState([]);
  const [selectedVendorKey, setSelectedVendorKey] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [validity, setValidity] = useState('');
  const [quotationDate, setQuotationDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [otherTerms, setOtherTerms] = useState('');
  const [vqRemarks, setVqRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [compareList, setCompareList] = useState([]);
  const [viewDetail, setViewDetail] = useState(null);

  useEffect(() => {
    setEnquiries(getAllVendorEnquiries());
    setQuotations(getAllVendorQuotations());
  }, []);
  const filteredQuotations = useMemo(() => filterMaterialRecords(quotations, quotationSearch, ['quotationNumber','enquiryNumber','vendorName','indentNumber','prNumber','poNumber','quotationDate','createdAt','totalAmount','status']), [quotations, quotationSearch]);

  useEffect(() => {
    if (location.state?.fromVendorEnquiry && location.state?.vendorEnquiry) {
      const enq = location.state.vendorEnquiry;
      handleSelectEnquiry(enq);
    } else if (location.state?.enquiryNumber) {
      const enq = getAllVendorEnquiries().find((e) => e.enquiryNumber === location.state.enquiryNumber);
      if (enq) handleSelectEnquiry(enq);
    }
  }, [location.state]);

  /* Notification deep link: clicking the Admin's "awaiting approval" notification
     opens /vendor-quotations?quotation=VQ-xxxx — open that quotation's detail card. */
  useEffect(() => {
    const wanted = searchParams.get('quotation');
    if (!wanted) return;
    if (getAllVendorQuotations().some((q) => q.quotationNumber === wanted)) {
      setViewDetail(wanted);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams]);

  const handleSelectEnquiry = (enq) => {
    setEditingQuotation(null);
    setSelectedEnquiry(enq);
    // A stale preview link or legacy route can still open a completed enquiry.
    // Keep its vendor details visible instead of rendering blank fields.
    const choices = getQuotationFormVendorChoices(enq, getAllVendorQuotations());
    const selectedId = enq.selectedVendorId || enq.selectedVendor?.vendorId || enq.selectedVendor?.vendorMasterId || enq.selectedVendor?.seq || '';
    const selectedName = vendorEntryName(enq.selectedVendor);
    const enquiryVendor = choices.find((v) => selectedId && String(v.vendorId) === String(selectedId))
      || choices.find((v) => selectedName && v.name.toLowerCase() === selectedName.toLowerCase())
      || choices[0]
      || { key: '', vendorId: '', name: '', contact: '', email: '' };
    setEnquiryVendorChoices(choices);
    setSelectedVendorKey(enquiryVendor.key);
    setVqItems((enq.items || []).map((it) => ({
      materialId: it.materialId,
      materialCode: it.materialCode || '',
      materialName: it.materialName,
      description: it.description || '',
      unit: it.unit,
      requiredQty: it.shortageQty || it.requiredQty,
      quotedQty: it.shortageQty || it.requiredQty,
      unitPrice: '',
      discount: 0,
      taxPct: 0,
      taxAmount: 0,
      totalPrice: 0,
      deliveryDays: '',
      deliveryDate: '',
      remarks: ''
    })));
    setVendorId(enquiryVendor.vendorId || '');
    setVendorName(enquiryVendor.name || '');
    setVendorContact(enquiryVendor.contact || '');
    setVendorEmail(enquiryVendor.email || '');
    setDeliveryDays('');
    setPaymentTerms('');
    setValidity('');
    setVqRemarks('');
    setCreating(true);
  };

  const handleEnquiryVendorChange = (key) => {
    const choice = enquiryVendorChoices.find((vendor) => vendor.key === key);
    if (!choice) return;
    setSelectedVendorKey(key);
    setVendorId(choice.vendorId || '');
    setVendorName(choice.name || '');
    setVendorContact(choice.contact || '');
    setVendorEmail(choice.email || '');
  };

  const handleVendorMasterPick = (vendor) => {
    setVendorId(vendor.seq || '');
    setVendorName(vendor.name || '');
    setVendorContact(vendor.contactPerson || vendor.contact || '');
    setVendorEmail(vendor.email || '');
  };

  const handleEditQuotation = (quotation) => {
    const enquiry = getAllVendorEnquiries().find((entry) => entry.enquiryNumber === quotation.enquiryNumber);
    if (!enquiry) {
      alert(`Vendor Enquiry ${quotation.enquiryNumber} could not be found.`);
      return;
    }
    setEditingQuotation(quotation);
    setSelectedEnquiry(enquiry);
    setEnquiryVendorChoices([]);
    setSelectedVendorKey('');
    setVendorId(quotation.vendorId || '');
    setVendorName(quotation.vendorName || '');
    setVendorContact(quotation.vendorContact || '');
    setVendorEmail(quotation.vendorEmail || '');
    setVqItems((quotation.items || []).map((item) => {
      const qty = Number(item.quotedQty) || 0;
      const price = Number(item.unitPrice) || 0;
      const discount = Number(item.discount) || 0;
      const discountAmount = Number(item.discountAmount) || ((qty * price * discount) / 100);
      const totalPrice = Number(item.totalPrice) || (qty * price - discountAmount);
      const taxPct = Number(item.taxPct) || 0;
      return {
        ...item,
        unitPrice: String(item.unitPrice ?? ''),
        quotedQty: String(item.quotedQty ?? item.requiredQty ?? ''),
        discount,
        discountAmount,
        taxPct,
        taxAmount: Number(item.taxAmount) || (totalPrice * taxPct) / 100,
        totalPrice,
        deliveryDays: String(item.deliveryDays || quotation.deliveryDays || ''),
        deliveryDate: item.deliveryDate || quotation.deliveryDate || ''
      };
    }));
    setDeliveryDays(String(quotation.deliveryDays || ''));
    setPaymentTerms(quotation.paymentTerms || '');
    setValidity(quotation.validity || '');
    setQuotationDate(quotation.quotationDate || new Date().toISOString().slice(0, 10));
    setOtherTerms(quotation.otherTerms || '');
    setVqRemarks(quotation.remarks || '');
    setCreating(true);
  };

  const handleBackToList = () => {
    setCreating(false);
    setEditingQuotation(null);
    setSelectedEnquiry(null);
    setViewDetail(null);
  };

  const updateVQItem = (idx, field, val) => {
    setVqItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      const updated = { ...it, [field]: val };
      if (['unitPrice', 'quotedQty', 'discount', 'taxPct'].includes(field)) {
        const gross = (Number(updated.quotedQty) || 0) * (Number(updated.unitPrice) || 0);
        updated.discountAmount = (gross * (Number(updated.discount) || 0)) / 100;
        updated.totalPrice = gross - updated.discountAmount;
        updated.taxAmount = (updated.totalPrice * (Number(updated.taxPct) || 0)) / 100;
      }
      return updated;
    }));
  };

  const totalAmount = vqItems.reduce((sum, it) => sum + (Number(it.totalPrice) || 0), 0);
  const totalTax = vqItems.reduce((sum, it) => sum + (Number(it.taxAmount) || 0), 0);
  const grandTotal = totalAmount + totalTax;

  const handleCreateVQ = () => {
    if (!selectedEnquiry) return;
    if (!vendorName.trim()) return alert('Enter vendor name.');
    if (!editingQuotation && hasQuotationForEnquiryVendor(selectedEnquiry, { vendorId, name: vendorName }, getAllVendorQuotations())) {
      return alert(`A vendor quotation from ${vendorName.trim()} is already recorded for this enquiry.`);
    }
    const validItems = vqItems.filter((it) => Number(it.unitPrice) > 0);
    if (validItems.length === 0) return alert('Enter unit price for at least one material.');
    try {
      setBusy(true);
      if (editingQuotation) {
        const subtotal = validItems.reduce((sum, item) => sum + (Number(item.quotedQty) || 0) * (Number(item.unitPrice) || 0), 0);
        const discountAmount = validItems.reduce((sum, item) => sum + (Number(item.discountAmount) || 0), 0);
        const taxAmount = validItems.reduce((sum, item) => sum + (Number(item.taxAmount) || 0), 0);
        const updated = updateVendorQuotation(editingQuotation.quotationNumber, {
          vendorId,
          vendorName: vendorName.trim(),
          vendorContact: vendorContact.trim(),
          vendorEmail: vendorEmail.trim(),
          items: validItems,
          subtotal,
          totalAmount,
          discountAmount,
          taxAmount,
          totalWithTax: totalAmount + taxAmount,
          deliveryDays: Number(deliveryDays) || 0,
          deliveryDate: validItems[0]?.deliveryDate || '',
          paymentTerms: paymentTerms.trim(),
          validity: validity.trim(),
          quotationDate,
          otherTerms: otherTerms.trim(),
          remarks: vqRemarks.trim()
        });
        setBusy(false);
        setQuotations(getAllVendorQuotations());
        setEditingQuotation(null);
        handleBackToList();
        return updated;
      }
      const record = createVendorQuotation({
        enquiryNumber: selectedEnquiry.enquiryNumber,
        vendorId,
        vendorName: vendorName.trim(),
        vendorContact: vendorContact.trim(),
        vendorEmail: vendorEmail.trim(),
        items: validItems,
        totalAmount,
        deliveryDays: Number(deliveryDays) || 0,
        paymentTerms: paymentTerms.trim(),
        validity: validity.trim(),
        quotationDate,
        deliveryDate: validItems[0]?.deliveryDate || '',
        otherTerms: otherTerms.trim(),
        remarks: vqRemarks.trim()
      });
      const enqVendors = (selectedEnquiry.vendors || []).map((v) => {
        const name = vendorEntryName(v);
        const id = typeof v === 'object' && v
          ? (v.vendorId || v.vendorMasterId || v.vendorSeq || v.seq || '')
          : '';
        const isMatch = (vendorId && String(id) === String(vendorId))
          || name.toLowerCase() === vendorName.trim().toLowerCase();
        return isMatch
          ? { ...(typeof v === 'object' && v ? v : { name }), status: 'Quotation Received' }
          : v;
      });
      const allReceived = enqVendors.every((v) => v.status === 'Quotation Received');
      updateVendorEnquiry(selectedEnquiry.enquiryNumber, {
        vendors: enqVendors,
        status: allReceived ? 'Quotations Received' : selectedEnquiry.status
      });
      setBusy(false);
      setQuotations(getAllVendorQuotations());
      setEnquiries(getAllVendorEnquiries());
      handleBackToList();
    } catch (err) {
      setBusy(false);
      alert(err.message);
    }
  };

  /** Accept Quotation — Admin-only approval; validation + Accepted By/Date/Time happen in the service. */
  const handleAccept = (quotationNumber) => {
    if (!canApprove) {
      alert('Only the Admin can approve a vendor quotation. Your approval request has been notified to the Admin.');
      return;
    }
    if (!window.confirm(`Approve vendor quotation ${quotationNumber}? This will reject other quotations for the same enquiry.`)) return;
    try {
      const info = getCurrentUserInfo();
      acceptQuotation(quotationNumber, info.employee?.name || info.auth?.username || 'Administrator');
      const vq = quotations.find((q) => q.quotationNumber === quotationNumber);
      if (vq) {
        quotations.filter((q) => q.enquiryNumber === vq.enquiryNumber && q.quotationNumber !== quotationNumber).forEach((q) => {
          if (isConvertedQuotation(q)) return;
          updateVendorQuotation(q.quotationNumber, { status: QUOTATION_STATUS.REJECTED });
        });
      }
      setQuotations(getAllVendorQuotations());
    } catch (err) {
      alert(err.message);
    }
  };

  /** Create Purchase Order — hands the accepted quotation to the existing PO screen. */
  const handleCreatePO = (quotationNumber) => {
    const gate = canCreatePOFromQuotation(quotationNumber);
    if (!gate.allowed) {
      alert(gate.reason);
      return;
    }
    navigate('/purchase-order', { state: { fromQuotation: quotationNumber } });
  };

  /** View Purchase Order — the quotation already produced a PO. */
  const handleViewPO = (quotationNumber) => {
    const poNumber = poNumberOf(quotations.find((q) => q.quotationNumber === quotationNumber));
    if (!poNumber) return;
    navigate('/purchase-order', { state: { openPO: poNumber } });
  };

  /**
   * Customer Purchase Order — opens the existing Customer PO screen prefilled
   * from this quotation: Project ID, quotation reference, commercial terms,
   * the customer (from the enquiry/indent/SO chain) and every quoted item with
   * its quantity, price, discount and GST. The vendor (supplier) is deliberately
   * NOT written into the customer block — the quotation's own customer is used.
   */
  const handleCustomerPO = (vq) => {
    /* the Customer PO screen is guarded by sales.customer_order — say so plainly
       instead of silently bouncing to the home page. */
    if (!hasPermission('sales.customer_order')) {
      alert('You do not have permission to open the Customer Purchase Order. Ask your administrator for the Sales Customer Order permission.');
      return;
    }
    /* the party on a Customer PO is the END CUSTOMER (from the enquiry/indent/SO
       chain), never the vendor who quoted. Fall back to the Sales Order. */
    const soNumber = vq.soNumber || '';
    const so = soNumber ? getSalesOrderByRef(soNumber) : null;
    const customerName = vq.customer || so?.payload?.customerDetails?.companyName || '';

    const items = (vq.items || []).map((it) => ({
      itemCode: it.materialCode || '',
      itemName: it.materialName || '',
      description: it.description || '',
      drawingNo: '',
      hsnSac: it.hsnSac || '',
      quantity: it.quotedQty || it.requiredQty || 0,
      unit: it.unit || 'Nos',
      unitPrice: it.unitPrice || 0,
      gst: String(it.taxPct ?? 18)
    }));

    /* calculateTotals() treats discount as an absolute amount — mirror the same
       derivation the quotation → PO conversion uses when the stored total is absent */
    const gross = items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unitPrice), 0);
    const discount = Number(vq.discountAmount) || (gross * Number(vq.discountPct || 0)) / 100;

    navigate('/customer-purchase-order', {
      state: {
        fromQuotation: true,
        quotation: {
          quotationDetails: {
            quotationNumber: vq.quotationNumber || '',
            projectId: vq.projectId || '',
            placeOfSupply: '',
            discount: Number(discount.toFixed(2)),
            notes: vq.remarks || '',
            termsAndConditions: vq.otherTerms || vq.remarks || ''
          },
          customerDetails: customerName ? enrichCustomerDetails(customerName) : undefined,
          items
        }
      }
    });
  };

  const handleReject = (quotationNumber) => {
    /* Rejecting decides the quotation's fate just like approving, so it is part
       of the same Admin-only approval step. */
    if (!canApprove) {
      alert('Only the Admin can approve or reject a vendor quotation.');
      return;
    }
    if (!window.confirm(`Reject vendor quotation ${quotationNumber}?`)) return;
    try {
      updateVendorQuotation(quotationNumber, { status: QUOTATION_STATUS.REJECTED });
      setQuotations(getAllVendorQuotations());
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = (quotationNumber) => {
    if (!isAdmin() || !window.confirm(`Delete draft vendor quotation ${quotationNumber}? Submitted quotations use the controlled workflow.`)) return;
    try {
      deleteVendorQuotation(quotationNumber);
      setQuotations(getAllVendorQuotations());
    } catch (err) {
      alert(err.message);
    }
  };

  const toggleCompare = (vq) => {
    setCompareList((prev) => {
      const exists = prev.find((q) => q.quotationNumber === vq.quotationNumber);
      if (exists) return prev.filter((q) => q.quotationNumber !== vq.quotationNumber);
      return [...prev, vq];
    });
  };

  const handleViewPreview = (vq) => {
    navigate('/vendor-quotations/preview', { state: { vendorQuotation: vq } });
  };

  const handleActionChange = (vq, action) => {
    if (!action) return;
    if (action === 'viewPreview') {
      handleViewPreview(vq);
    } else if (action === 'edit' && canCreate && vq.status === QUOTATION_STATUS.RECEIVED && !isConvertedQuotation(vq)) {
      handleEditQuotation(vq);
    } else if (action === 'createPO') {
      handleCreatePO(vq.quotationNumber);
    } else if (action === 'accept') {
      handleAccept(vq.quotationNumber);
    } else if (action === 'reject') {
      handleReject(vq.quotationNumber);
    } else if (action === 'customerPO') {
      handleCustomerPO(vq);
    } else if (action === 'delete' && canCreate) {
      handleDelete(vq.quotationNumber);
    }
  };

  const currentQuotations = getAllVendorQuotations();
  const sentEnquiries = enquiries.filter((e) =>
    ['Sent', 'Quotations Received'].includes(e.status) && hasPendingEnquiryVendor(e, currentQuotations)
  );

  if (creating && selectedEnquiry) {
    return (
      <div className="page-section">
        <div className="page-header">
          <div>
            <h1>{editingQuotation ? 'Edit Vendor Quotation' : 'Receive Vendor Quotation'}</h1>
            <p className="page-description">
              {editingQuotation ? `Quotation: ${editingQuotation.quotationNumber}` : `Enquiry: ${selectedEnquiry.enquiryNumber}`}
            </p>
          </div>
          <div className="header-actions">
            <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
            <button className="button-secondary" onClick={handleBackToList}>
              Back to Quotations
            </button>
          </div>
        </div>

        <div className="content-block">
          <div className="form-section">
            <div className="section-heading">
              <h3>Enquiry Reference</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Enquiry No</label>
                <input type="text" className="action-select" value={selectedEnquiry.enquiryNumber} readOnly />
              </div>
              <div className="field-group">
                <label>PR Reference</label>
                <input type="text" className="action-select" value={selectedEnquiry.prNumber} readOnly />
              </div>
              <div className="field-group">
                <label>Project</label>
                <input type="text" className="action-select" value={selectedEnquiry.projectId || '-'} readOnly />
              </div>
            </div>
          </div>

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Vendor Details</h3>
            </div>
            <div className="section-grid">
              {enquiryVendorChoices.length > 1 && (
                <div className="field-group">
                  <label>Vendor from Enquiry</label>
                  <select
                    className="action-select"
                    value={selectedVendorKey}
                    onChange={(e) => handleEnquiryVendorChange(e.target.value)}
                  >
                    {enquiryVendorChoices.map((vendor) => (
                      <option key={vendor.key} value={vendor.key}>{vendor.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field-group">
                <label>Vendor Name *</label>
                <VendorMasterAutocomplete
                  className="action-select"
                  value={vendorName}
                  onChange={(value) => {
                    setVendorName(value);
                    if (value !== vendorName) setVendorId('');
                  }}
                  onSelect={handleVendorMasterPick}
                  placeholder="Vendor name"
                />
              </div>
              <div className="field-group">
                <label>Contact Person</label>
                <input type="text" className="action-select" value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} />
              </div>
              <div className="field-group">
                <label>Email</label>
                <input type="email" className="action-select" value={vendorEmail} onChange={(e) => setVendorEmail(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Quoted Prices</h3>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Material</th>
                    <th>Description</th>
                    <th>Unit</th>
                    <th>Required</th>
                    <th>Quoted Qty</th>
                    <th>Unit Price (₹)</th>
                    <th>Disc %</th>
                    <th>Tax %</th>
                    <th>Tax Amt (₹)</th>
                    <th>Subtotal (₹)</th>
                    <th>Total (₹)</th>
                    <th>Delivery Days</th>
                    <th>Delivery Date</th>
                  </tr>
                </thead>
                <tbody>
                  {vqItems.map((it, idx) => (
                    <tr key={idx}>
                      <td>{idx + 1}</td>
                      <td><strong>{it.materialName || it.materialId}</strong></td>
                      <td><input type="text" className="action-select" value={it.description} onChange={(e) => updateVQItem(idx, 'description', e.target.value)} style={{ width: '130px', padding: '4px 6px' }} /></td>
                      <td>{it.unit}</td>
                      <td>{it.requiredQty}</td>
                      <td><input type="number" className="action-select" value={it.quotedQty} onChange={(e) => updateVQItem(idx, 'quotedQty', e.target.value)} style={{ width: '70px', padding: '4px 6px' }} /></td>
                      <td><input type="number" className="action-select" value={it.unitPrice} onChange={(e) => updateVQItem(idx, 'unitPrice', e.target.value)} style={{ width: '100px', padding: '4px 6px' }} /></td>
                      <td><input type="number" className="action-select" value={it.discount} onChange={(e) => updateVQItem(idx, 'discount', e.target.value)} style={{ width: '60px', padding: '4px 6px' }} /></td>
                      <td><input type="number" className="action-select" value={it.taxPct} onChange={(e) => updateVQItem(idx, 'taxPct', e.target.value)} style={{ width: '60px', padding: '4px 6px' }} /></td>
                      <td style={{ fontWeight: 600 }}>₹{Number(it.taxAmount || 0).toFixed(2)}</td>
                      <td>₹{((Number(it.quotedQty) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discountAmount) || 0)).toFixed(2)}</td>
                      <td style={{ fontWeight: 600 }}>₹{Number(it.totalPrice || 0).toFixed(2)}</td>
                      <td><input type="number" className="action-select" value={it.deliveryDays} onChange={(e) => updateVQItem(idx, 'deliveryDays', e.target.value)} style={{ width: '70px', padding: '4px 6px' }} /></td>
                      <td><input type="date" className="action-select" value={it.deliveryDate} onChange={(e) => updateVQItem(idx, 'deliveryDate', e.target.value)} style={{ width: '140px', padding: '4px 6px' }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Terms</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Overall Delivery (days)</label>
                <input type="number" className="action-select" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} />
              </div>
              <div className="field-group">
                <label>Payment Terms</label>
                <input type="text" className="action-select" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. 30 days" />
              </div>
              <div className="field-group">
                <label>Validity</label>
                <input type="text" className="action-select" value={validity} onChange={(e) => setValidity(e.target.value)} placeholder="e.g. 30 days" />
              </div>
              <div className="field-group">
                <label>Quotation Date</label>
                <input type="date" className="action-select" value={quotationDate} onChange={(e) => setQuotationDate(e.target.value)} />
              </div>
              <div className="field-group">
                <label>Other Quotation Terms</label>
                <input type="text" className="action-select" value={otherTerms} onChange={(e) => setOtherTerms(e.target.value)} placeholder="e.g. material to be new stock, packing extra" />
              </div>
            </div>
            <div className="tax-summary" style={{ marginTop: '16px' }}>
              <div className="tax-summary-row">
                <span>Subtotal</span>
                <span>₹{totalAmount.toFixed(2)}</span>
              </div>
              <div className="tax-summary-row">
                <span>Tax / GST</span>
                <span>₹{totalTax.toFixed(2)}</span>
              </div>
              <div className="tax-summary-row total">
                <span>Total Amount</span>
                <span style={{ fontWeight: 700, fontSize: '16px' }}>₹{grandTotal.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Remarks</h3>
            </div>
            <div className="field-group full-width">
              <textarea className="action-select" rows={2} value={vqRemarks} onChange={(e) => setVqRemarks(e.target.value)} style={{ resize: 'vertical' }} />
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: '20px' }}>
            <button type="button" className="button-primary" onClick={handleCreateVQ} disabled={busy}>{busy ? 'Saving...' : editingQuotation ? 'Update Vendor Quotation' : 'Save Vendor Quotation'}</button>
            <button type="button" className="button-secondary" onClick={handleBackToList}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Vendor Quotations</h1>
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          {sentEnquiries.length > 0 && (
            <button className="button-primary" onClick={() => handleSelectEnquiry(sentEnquiries[0])}>
              + Receive Vendor Quotation
            </button>
          )}
        </div>
      </div>

      {/* Enquiries Ready for VQ */}
      {sentEnquiries.length > 0 && (
        <div className="content-block">
          <div className="block-header">
            <div>
              <h2>Enquiries Ready for Vendor Quotation</h2>
              <p className="section-description">Select an enquiry to receive a vendor quotation.</p>
            </div>
            <span className="count-badge">{sentEnquiries.length} Enquiries</span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Enquiry No</th>
                  <th>PR Ref</th>
                  <th>Project</th>
                  <th>Vendors</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sentEnquiries.map((enq) => (
                  <tr key={enq.enquiryNumber}>
                    <td><strong>{enq.enquiryNumber}</strong></td>
                    <td>{enq.prNumber}</td>
                    <td>{enq.projectId || '-'}</td>
                    <td>{enq.vendors?.length || 0}</td>
                    <td><StatusBadge status={enq.status} /></td>
                    <td>
                      <button
                        type="button"
                        className="button-small"
                        style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
                        onClick={() => handleSelectEnquiry(enq)}
                      >
                        Receive VQ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Compare Section */}
      {compareList.length >= 2 && (
        <div className="content-block">
          <div className="block-header">
            <div>
              <h2>Compare Vendor Quotations</h2>
              <p className="section-description">Side-by-side comparison of selected quotations.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button type="button" className="button-secondary button-small" onClick={() => setCompareList([])}>Clear Comparison</button>
              <span className="count-badge">{compareList.length} Selected</span>
            </div>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Quotation No</th>
                  {compareList[0]?.items?.map((it, idx) => <th key={idx}>{it.materialName}</th>)}
                  <th>Total Amount</th>
                  <th>Delivery</th>
                  <th>Payment</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {compareList.map((vq) => (
                  <tr key={vq.quotationNumber}>
                    <td><strong>{vq.vendorName}</strong></td>
                    <td>{vq.quotationNumber}</td>
                    {vq.items?.map((it, idx) => (
                      <td key={idx}>₹{Number(it.unitPrice || 0).toFixed(2)} x {it.quotedQty}</td>
                    ))}
                    <td style={{ fontWeight: 700 }}>₹{Number(vq.totalAmount || 0).toFixed(2)}</td>
                    <td>{vq.deliveryDays || '-'} days</td>
                    <td>{vq.paymentTerms || '-'}</td>
                    <td>
                      {vq.status === 'Accepted' ? (
                        <span style={{ color: '#16a34a', fontWeight: 600 }}>Accepted</span>
                      ) : canApprove ? (
                        <button type="button" className="button-small" style={{ background: '#16a34a', color: '#ffffff', borderColor: '#15803d' }} onClick={() => handleAccept(vq.quotationNumber)}>Approve</button>
                      ) : (
                        <span style={{ color: '#64748b', fontSize: '12px' }}>Awaiting Admin approval</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* All Vendor Quotations */}
      <div className="content-block">
        <div className="block-header">
          <div>
            <h2>Vendor Quotation History</h2>
            <p className="section-description">All received vendor quotations and their status.</p>
          </div>
          <span className="count-badge">
            {quotations.length} Quotation{quotations.length !== 1 ? 's' : ''}
          </span>
        </div>
        <RecordSearchBar value={quotationSearch} onChange={setQuotationSearch} placeholder="Search quotation, enquiry, vendor, PR, PO, amount, status..." label="Search vendor quotation history" />

        {quotations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">+</div>
            <h3>No vendor quotations yet</h3>
            <p>Receive vendor quotations from an enquiry to compare and select.</p>
            {sentEnquiries.length > 0 && (
              <button className="button-primary" onClick={() => handleSelectEnquiry(sentEnquiries[0])}>
                + Receive Vendor Quotation
              </button>
            )}
          </div>
        ) : filteredQuotations.length === 0 ? (
          <div className="empty-state"><h3>No vendor quotations match your search</h3><p>Clear the search to see all quotations.</p></div>
        ) : (
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>VQ No</th>
                  <th>Enquiry</th>
                  <th>Indent</th>
                  <th>Sales Order</th>
                  <th>Project ID</th>
                  <th>Vendor</th>
                  <th>Materials</th>
                  <th>Total</th>
                  <th>Delivery</th>
                  <th>Status</th>
                  <th>PO</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredQuotations.map((vq) => {
                  const poNumber = poNumberOf(vq);
                  const canCreatePO = canCreatePOFromQuotation(vq.quotationNumber).allowed;
                  return (
                  <tr key={vq.quotationNumber}>
                    <td>{dateOnly(vq.quotationDate || vq.createdAt) || '-'}</td>
                    <td><strong>{vq.quotationNumber}</strong></td>
                    <td>{vq.enquiryNumber}</td>
                    <td>{vq.indentNumber || '-'}</td>
                    <td>{vq.soNumber || '-'}</td>
                    <td>{vq.projectId || '-'}</td>
                    <td>{vq.vendorName}</td>
                    <td>{vq.items?.length || 0}</td>
                    <td style={{ fontWeight: 600 }}>₹{Number(vq.totalAmount || 0).toFixed(2)}</td>
                    <td>{vq.deliveryDays || '-'} days</td>
                    <td>
                      <StatusBadge status={vq.status} />
                      {vq.status === QUOTATION_STATUS.RECEIVED && !canApprove && (
                        <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>
                          Awaiting Admin approval
                        </div>
                      )}
                      {vq.acceptedBy && (
                        <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>
                          {vq.acceptedBy} · {dateOnly(vq.acceptedDate)} {vq.acceptedTime || ''}
                        </div>
                      )}
                    </td>
                    <td>{poNumber ? <strong>{poNumber}</strong> : '-'}</td>
                    <td>
                      {poNumber && (
                        <button
                          type="button"
                          className="button-secondary button-small"
                          onClick={() => handleViewPO(vq.quotationNumber)}
                          style={{ marginRight: '6px' }}
                        >
                          View Purchase Order
                        </button>
                      )}
                      <select
                        className="action-select"
                        defaultValue=""
                        onChange={(e) => {
                          handleActionChange(vq, e.target.value);
                          e.target.value = '';
                        }}
                      >
                        <option value="" disabled>Action</option>
                        {canCreatePO && <option value="createPO">Create Purchase Order</option>}
                        <option value="viewPreview">View / Print Preview</option>
                        <option value="customerPO">Customer Purchase Order</option>
                        {canCreate && vq.status === QUOTATION_STATUS.RECEIVED && !isConvertedQuotation(vq) && (
                          <option value="edit">Edit Quotation Prices</option>
                        )}
                        {vq.status === QUOTATION_STATUS.RECEIVED && canApprove && <option value="accept">Approve Quotation</option>}
                        {vq.status === QUOTATION_STATUS.RECEIVED && canApprove && <option value="reject" style={{ color: '#dc2626' }}>Reject Quotation</option>}
                        {vq.status === QUOTATION_STATUS.RECEIVED && !canApprove && (
                          <option value="awaiting" disabled>Awaiting Admin approval</option>
                        )}
        {isAdmin() && vq.status === QUOTATION_STATUS.DRAFT && (
                          <option value="delete" style={{ color: '#dc2626' }}>Delete Quotation</option>
                        )}
                      </select>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {viewDetail && (() => {
        const vq = quotations.find((q) => q.quotationNumber === viewDetail);
        if (!vq) return null;
        const poNumber = poNumberOf(vq);
        const canCreatePO = canCreatePOFromQuotation(vq.quotationNumber).allowed;
        return (
          <div className="template-modal-backdrop no-print" onMouseDown={() => setViewDetail(null)}>
            <div className="template-modal" style={{ maxWidth: '820px' }} onMouseDown={(e) => e.stopPropagation()}>
              <div className="template-modal-header">
                <div>
                  <h3>Vendor Quotation ({vq.quotationNumber})</h3>
                  <p>{vq.vendorName}</p>
                </div>
                <button type="button" className="template-modal-close" onClick={() => setViewDetail(null)}>×</button>
              </div>

              <div style={{ padding: '16px 0', fontSize: '13px', lineHeight: '1.6' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px', marginBottom: '14px', background: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
                  <div><strong>Vendor:</strong> {vq.vendorName}</div>
                  <div><strong>Contact:</strong> {vq.vendorContact || '-'}</div>
                  <div><strong>Email:</strong> {vq.vendorEmail || '-'}</div>
                  <div><strong>Status:</strong> <StatusBadge status={vq.status} /></div>
                  <div><strong>Quotation Date:</strong> {dateOnly(vq.quotationDate || vq.createdAt) || '-'}</div>
                  <div><strong>Project ID:</strong> {vq.projectId || '-'}</div>
                  <div><strong>Purchase Indent:</strong> {vq.indentNumber || '-'}</div>
                  <div><strong>Vendor Enquiry:</strong> {vq.enquiryNumber || '-'}</div>
                  <div><strong>Sales Order:</strong> {vq.soNumber || '-'}</div>
                  <div><strong>Delivery:</strong> {vq.deliveryDays || '-'} days</div>
                  <div><strong>Payment:</strong> {vq.paymentTerms || '-'}</div>
                  <div><strong>Validity:</strong> {vq.validity || '-'}</div>
                  <div><strong>Subtotal:</strong> {rupees(vq.subtotal ?? vq.totalAmount)}</div>
                  <div><strong>Tax / GST:</strong> {rupees(vq.taxAmount)}</div>
                  <div><strong>Total:</strong> {rupees(vq.totalWithTax ?? vq.totalAmount)}</div>
                  <div><strong>Purchase Order:</strong> {poNumber || '-'}</div>
                  {vq.acceptedBy && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <strong>Accepted:</strong> ✓ {vq.acceptedBy} on {dateOnly(vq.acceptedDate)} at {vq.acceptedTime || '-'}
                    </div>
                  )}
                </div>

                <strong style={{ fontSize: '14px', color: '#0f172a' }}>Quoted Materials:</strong>
                <div style={{ marginTop: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden' }}>
                  <table className="history-table" style={{ margin: 0 }}>
                    <thead>
                      <tr>
                        <th>SL.No</th>
                        <th>Material</th>
                        <th>Description</th>
                        <th>Unit</th>
                        <th>Qty</th>
                        <th>Unit Price</th>
                        <th>Disc %</th>
                        <th>Tax %</th>
                        <th>Tax Amt</th>
                        <th>Total</th>
                        <th>Delivery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(vq.items || []).map((it, idx) => (
                        <tr key={idx}>
                          <td>{idx + 1}</td>
                          <td><strong>{it.materialName || it.materialId}</strong></td>
                          <td>{it.description || '-'}</td>
                          <td>{it.unit}</td>
                          <td>{it.quotedQty || it.requiredQty}</td>
                          <td>₹{Number(it.unitPrice || 0).toFixed(2)}</td>
                          <td>{Number(it.discount || 0).toFixed(2)}</td>
                          <td>{Number(it.taxPct || 0).toFixed(2)}</td>
                          <td>₹{Number(it.taxAmount || 0).toFixed(2)}</td>
                          <td style={{ fontWeight: 600 }}>₹{Number(it.totalPrice || 0).toFixed(2)}</td>
                          <td>{it.deliveryDays || it.deliveryDate || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {(vq.otherTerms || vq.remarks) && (
                  <div style={{ marginTop: '14px', background: '#fefce8', border: '1px solid #fef08a', padding: '10px', borderRadius: '6px', wordBreak: 'break-word' }}>
                    {vq.otherTerms && <><strong>Other Terms:</strong> <div style={{ color: '#713f12', marginTop: '4px' }}>{vq.otherTerms}</div></>}
                    {vq.remarks && <><strong>Remarks:</strong> <div style={{ color: '#713f12', marginTop: '4px' }}>{vq.remarks}</div></>}
                  </div>
                )}
              </div>

              <div className="template-modal-actions">
                <button className="button-secondary" onClick={() => setViewDetail(null)}>Close</button>
                {vq.status === QUOTATION_STATUS.RECEIVED && canApprove && (
                  <button className="button-primary" onClick={() => { setViewDetail(null); handleAccept(vq.quotationNumber); }}>
                    Approve Quotation
                  </button>
                )}
                {vq.status === QUOTATION_STATUS.RECEIVED && !canApprove && (
                  <span style={{ alignSelf: 'center', color: '#64748b', fontSize: '13px' }}>
                    Awaiting Admin approval
                  </span>
                )}
                {canCreatePO && (
                  <button className="button-primary" onClick={() => { setViewDetail(null); handleCreatePO(vq.quotationNumber); }}>
                    Create Purchase Order
                  </button>
                )}
                {poNumber && (
                  <button className="button-primary" onClick={() => { setViewDetail(null); handleViewPO(vq.quotationNumber); }}>
                    View Purchase Order
                  </button>
                )}
                <button
                  className="button-secondary"
                  style={{ color: '#0369a1', borderColor: '#bae6fd', background: '#f0f9ff', fontWeight: '600' }}
                  onClick={() => {
                    const vqData = vq;
                    setViewDetail(null);
                    handleViewPreview(vqData);
                  }}
                >
                  View Preview
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default VendorQuotationPage;
