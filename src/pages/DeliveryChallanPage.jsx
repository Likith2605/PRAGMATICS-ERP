import React, { useState, useEffect, useMemo } from 'react';
import AddableSelect from '../components/AddableSelect.jsx';
import { DEFAULT_UNITS } from '../utils/addableMasters.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding, getCompanyProfile } from '../utils/companyBranding.js';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from '../utils/calculations.js';
import { amountInWords as wordsFor, convertToINR, CURRENCIES, getCurrency, isForeignCurrency, money, moneyPlain } from '../utils/currency.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import { getAllProjectsSummary, getFullProjectData } from '../utils/projectTracker.js';
import WorkflowNavigator from '../components/WorkflowNavigator.jsx';
import ProjectIdAutocomplete from '../components/ProjectIdAutocomplete.jsx';
import { hasPermission } from '../utils/permissions.js';
import { isAdmin } from '../utils/auth.js';
import { refreshProductionDispatchRequests } from '../utils/productionDispatchService.js';
import { listDeliveryChallans, createDeliveryChallan, updateDeliveryChallan, confirmDeliveryChallanDispatch, deleteDeliveryChallan, getDeliveryChallanMigrationPreview, importMissingDeliveryChallans } from '../services/deliveryChallanApi.js';
import { pullRecordsFromServer } from '../services/recordsSync.js';
import { getProductionDispatchRequests } from '../utils/productionDispatchService.js';

const generateDCNumber = () => {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const serial = Math.floor(100 + Math.random() * 900);
  return `DC-${year}${month}${day}-${serial}`;
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

const DeliveryChallanPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [history, setHistory] = useState([]);
  const [salesOrderList, setSalesOrderList] = useState([]);
  const [selectedDC, setSelectedDC] = useState(null);
  const [editingChallan, setEditingChallan] = useState(null);
  const [dispatchRequests, setDispatchRequests] = useState(() => getProductionDispatchRequests());
  const [selectedDispatchRequest, setSelectedDispatchRequest] = useState(null);
  const [dispatchError, setDispatchError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [migrationPreview, setMigrationPreview] = useState(null);
  const [migrationSelection, setMigrationSelection] = useState(new Set());
  const [migrationBusy, setMigrationBusy] = useState(false);
  const canCreateFromDispatchRequest = hasPermission('delivery.create');

  // Form states
  const [dcDetails, setDcDetails] = useState({
    dcNumber: generateDCNumber(),
    dcDate: new Date().toISOString().slice(0, 10),
    dispatchDate: new Date().toISOString().slice(0, 10),
    salesOrderRef: '',
    customerPoNumber: '',
    customerPoDate: '',
    projectId: '',
    purposeOfDispatch: 'Direct Sale / Supply', // 'Direct Sale / Supply' | 'Job Work' | 'Trial / Sample' | 'Repair / Return'
    modeOfTransport: 'Road / By Hand',
    vehicleNumber: '',
    lrNumber: '',
    eWayBillNumber: '',
    currency: 'INR',
    exchangeRate: '',
    rateDate: '',
    taxMode: 'intra',
    discount: '',
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

  const [companyDetails, setCompanyDetails] = useState(() => getCompanyProfile());

  const [items, setItems] = useState([{ ...emptyItem }]);

  // Delivery Challans and source Sales Orders are server-authoritative.
  useEffect(() => {
    let active = true;
    Promise.all([listDeliveryChallans(), import('../services/salesOrderApi.js').then((m) => m.listSalesOrders())])
      .then(([dcs, orders]) => { if (active) { setHistory(dcs); setSalesOrderList(orders); setHistoryError(''); } })
      .catch((error) => { if (active) setHistoryError(`Could not load Delivery Challans from PostgreSQL: ${error.message}`); });
    refreshProductionDispatchRequests()
      .then((requests) => { if (active) setDispatchRequests(requests); })
      .catch((error) => { if (active) setDispatchError(`Could not refresh Production dispatch requests: ${error.message}`); });
    const refreshLocalRequests = (event) => {
      if (!event?.detail?.key || event.detail.key === 'productionDispatchRequests')
        setDispatchRequests(getProductionDispatchRequests());
    };
    window.addEventListener('erp-state-change', refreshLocalRequests);
    window.addEventListener('erp-records-synced', refreshLocalRequests);
    return () => {
      active = false;
      window.removeEventListener('erp-state-change', refreshLocalRequests);
      window.removeEventListener('erp-records-synced', refreshLocalRequests);
    };
  }, []);

  const [projectSummaryList, setProjectSummaryList] = useState([]);
  const [projectAutoLinkMsg, setProjectAutoLinkMsg] = useState('');

  useEffect(() => {
    setProjectSummaryList(getAllProjectsSummary());
  }, []);

  const handleProjectLookup = (pid, directData) => {
    setDcDetails((prev) => ({ ...prev, projectId: pid }));
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

      setDcDetails((prev) => ({
        ...prev,
        salesOrderRef: data.soNumber || prev.salesOrderRef,
        customerPoNumber: data.customerPoNumber || prev.customerPoNumber
      }));

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

  // Handle incoming conversion if navigated with state
  useEffect(() => {
    if (location.state?.fromSalesOrder && location.state?.salesOrder) {
      const so = location.state.salesOrder;
      setDcDetails({
        dcNumber: generateDCNumber(),
        dcDate: new Date().toISOString().slice(0, 10),
        dispatchDate: new Date().toISOString().slice(0, 10),
        salesOrderRef: so.soDetails?.soNumber || '',
        customerPoRef: so.soDetails?.quotationRef || '',
        projectId: so.soDetails?.projectId || '',
        purposeOfDispatch: 'Supply for Sale',
        transporterName: '',
        vehicleNumber: '',
        lrNumber: '',
        ewayBillNumber: '',
        deliveryLocation: so.customerDetails?.address || '',
          challanStatus: 'Dispatched',
          discount: so.soDetails?.discount || '',
          currency: so.soDetails?.currency || 'INR',
          exchangeRate: so.soDetails?.exchangeRate ?? '',
          rateDate: so.soDetails?.rateDate || '',
          taxMode: so.soDetails?.taxMode || 'intra',
          notes: so.soDetails?.notes || '',
        termsAndConditions:
          '1. Goods received in good order and condition as per specifications.\n' +
          '2. Discrepancies if any must be notified within 24 hours of receipt.\n' +
          '3. This is an official dispatch delivery document.'
      });

      if (so.customerDetails) setCustomerDetails(so.customerDetails);
      if (so.companyDetails) setCompanyDetails(so.companyDetails);
      if (so.items && so.items.length > 0) setItems(so.items);

      setMode('create');
    } else if (location.state?.viewChallan) {
      setSelectedDC(location.state.viewChallan);
      setMode('view');
    }
  }, [location.state]);

  const handleSelectSalesOrder = (soRef) => {
    if (!soRef) return;
    const match = salesOrderList.find((s) => s.reference === soRef);
    if (match && match.payload) {
      const p = match.payload;
      setDcDetails((prev) => ({
        ...prev,
        salesOrderRef: p.soDetails?.soNumber || soRef,
        customerPoRef: p.soDetails?.quotationRef || prev.customerPoRef,
        projectId: p.soDetails?.projectId || prev.projectId,
        deliveryLocation: p.customerDetails?.address || prev.deliveryLocation,
        discount: p.soDetails?.discount || '',
        currency: p.soDetails?.currency || prev.currency || 'INR',
        exchangeRate: p.soDetails?.exchangeRate ?? prev.exchangeRate ?? '',
        taxMode: p.soDetails?.taxMode || prev.taxMode || 'intra',
        notes: p.soDetails?.notes || ''
      }));

      if (p.customerDetails) setCustomerDetails(p.customerDetails);
      if (p.items && p.items.length > 0) setItems(p.items);
    }
  };

  const beginDispatchRequestChallan = (request) => {
    const linkedOrder = salesOrderList.find((order) =>
      String(order.reference || '') === String(request.salesOrderNo) ||
      String(order.payload?.soDetails?.soNumber || '') === String(request.salesOrderNo)
    );
    const linkedPayload = linkedOrder?.payload || {};
    const soItem = (linkedPayload.items || []).find((item) =>
      String(item.itemName || item.materialName || '').toLowerCase() === String(request.partName || '').toLowerCase()
    ) || linkedPayload.items?.[0] || {};
    const nextDC = {
      ...dcDetails,
      dcNumber: generateDCNumber(),
      dcDate: new Date().toISOString().slice(0, 10),
      dispatchDate: new Date().toISOString().slice(0, 10),
      salesOrderRef: request.salesOrderNo,
      customerPoRef: linkedPayload.soDetails?.quotationRef || '',
      projectId: request.projectId,
      jobCardNumber: request.jobCardNumber,
      dispatchRequestId: request.id,
      eligibleProductionQty: Number(request.eligibleQuantity),
      purposeOfDispatch: 'Supply for Sale',
      challanStatus: 'Challan Created',
      deliveryLocation: linkedPayload.customerDetails?.address || '',
      termsAndConditions: dcDetails.termsAndConditions || '1. Goods received in good order and condition as per specifications.\n2. Discrepancies if any must be notified within 24 hours of receipt.'
    };
    setDcDetails(nextDC);
    setCustomerDetails({
      ...customerDetails,
      ...(linkedPayload.customerDetails || {}),
      customerName: request.customerName,
      companyName: linkedPayload.customerDetails?.companyName || request.customerName,
      address: linkedPayload.customerDetails?.address || ''
    });
    if (linkedPayload.companyDetails) setCompanyDetails(linkedPayload.companyDetails);
    setItems([{
      itemCode: request.jobCardNumber,
      itemName: request.partName,
      drawingNo: request.drawingNumber,
      hsnSac: soItem.hsnSac || '',
      quantity: Number(request.eligibleQuantity),
      unit: soItem.unit || 'Nos',
      unitPrice: soItem.unitPrice || soItem.rate || 0,
      gst: soItem.gst || '18'
    }]);
    setSelectedDispatchRequest(request);
    setDispatchError('');
    setMode('create');
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

  const currencyCode = dcDetails.currency || 'INR';
  const taxMode = dcDetails.taxMode || 'intra';
  const totals = useMemo(
    () => calculateTotals(computedItems, dcDetails.discount, taxMode),
    [computedItems, dcDetails.discount, taxMode]
  );
  const amountInWords = useMemo(() => wordsFor(totals.grandTotal, currencyCode), [totals.grandTotal, currencyCode]);
  const totalINR = convertToINR(totals.grandTotal, currencyCode, dcDetails.exchangeRate);

  const viewCurrency = selectedDC?.dcDetails?.currency || 'INR';
  const viewTaxMode = selectedDC?.dcDetails?.taxMode || 'intra';
  const viewTaxLabel = viewTaxMode === 'inter' ? 'IGST' : viewTaxMode === 'export' ? 'Export (zero rated)' : 'CGST + SGST';
  const viewMoney = (value) => {
    const amount = Number(value || 0);
    if (isForeignCurrency(viewCurrency)) return `${viewCurrency} ${moneyPlain(amount, viewCurrency)}`;
    return amount.toFixed(2);
  };
  const pendingDispatchCount = dispatchRequests.filter((request) => request.status === 'Pending').length;
  const previewLegacyChallans = async () => {
    setMigrationBusy(true);
    try { setMigrationPreview(await getDeliveryChallanMigrationPreview()); setMigrationSelection(new Set()); setHistoryError(''); }
    catch (error) { setHistoryError(`Could not preview legacy Delivery Challans: ${error.message}`); }
    finally { setMigrationBusy(false); }
  };
  const importSelectedChallans = async () => {
    setMigrationBusy(true);
    try {
      const selected = migrationPreview.eligible.filter((record) => migrationSelection.has(record.number));
      const result = await importMissingDeliveryChallans(selected.map((record) => record.payload));
      setHistory(await listDeliveryChallans()); setMigrationPreview(null);
      setHistoryError(result.conflicts.length ? `${result.imported.length} imported; ${result.conflicts.length} conflicts remain unchanged.` : `${result.imported.length} legacy Delivery Challans imported.`);
    } catch (error) { setHistoryError(`Legacy import was not confirmed: ${error.message}`); }
    finally { setMigrationBusy(false); }
  };

  const handleFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveDC = async(e) => {
    e.preventDefault();
    if (!customerDetails.customerName.trim() && !customerDetails.companyName.trim()) {
      alert('Please enter Customer or Company Name.');
      return;
    }

    const dispatchRequestId = dcDetails.dispatchRequestId || '';
    const totalQty = computedItems.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0);
    if (dispatchRequestId) {
      const currentRequest = dispatchRequests.find((request) => request.id === dispatchRequestId);
      if (!currentRequest || currentRequest.status !== 'Pending') {
        alert('This dispatch request is no longer pending. Refresh the Delivery Challan page and try again.');
        return;
      }
      if (history.some((challan) => challan.payload?.dispatchRequestId === dispatchRequestId)) {
        alert('A Delivery Challan already exists for this dispatch request.');
        return;
      }
      if (totalQty <= 0 || totalQty > Number(currentRequest.eligibleQuantity)) {
        alert(`Dispatch quantity must be greater than zero and cannot exceed ${currentRequest.eligibleQuantity}.`);
        return;
      }
      if (history.some((challan) => challan.reference === dcDetails.dcNumber)) {
        alert('This Delivery Challan number is already in use.');
        return;
      }
      if (String(dcDetails.salesOrderRef) !== String(currentRequest.salesOrderNo) ||
        String(dcDetails.projectId) !== String(currentRequest.projectId) ||
        String(customerDetails.customerName) !== String(currentRequest.customerName) ||
        computedItems.length !== 1 || String(computedItems[0].itemName) !== String(currentRequest.partName)) {
        alert('The request-linked Job Card, project, Sales Order, customer and item must remain unchanged.');
        return;
      }
    }

    const payload = {
      dcDetails,
      customerDetails,
      companyDetails,
      items: computedItems,
      ...(dispatchRequestId ? {
        dispatchRequestId,
        jobCardNumber: dcDetails.jobCardNumber,
        eligibleProductionQty: Number(dcDetails.eligibleProductionQty)
      } : {}),
      totals,
      amountInWords,
      currency: currencyCode,
      amountINR: totalINR
    };

    try {
      const createToken = globalThis.crypto?.randomUUID?.() || `dc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const saved = editingChallan
        ? await updateDeliveryChallan(editingChallan.reference, payload, editingChallan.version)
        : await createDeliveryChallan(payload, createToken);
      const current = [saved.record, ...history.filter((h) => h.reference !== saved.record.reference)];
      setEditingChallan(null);
      setHistory(current);
      pullRecordsFromServer().catch(() => {});
      if (dispatchRequestId) setDispatchRequests(await refreshProductionDispatchRequests());

      setSelectedDC(payload);
      setMode('view');
      setDispatchError('');
    } catch (err) {
      console.error('Failed to save Delivery Challan', err);
      alert(err.message || 'Failed to save Delivery Challan.');
    }
  };

  const handleConfirmDispatch = async(dc) => {
    const dcNumber = dc?.dcDetails?.dcNumber;
    const requestId = dc?.dispatchRequestId || dc?.dcDetails?.dispatchRequestId;
    if (!requestId || dc?.dcDetails?.challanStatus !== 'Challan Created') return;
    const dispatchedPayload = { ...dc, dcDetails: { ...dc.dcDetails, challanStatus: 'Dispatched' } };
    try {
      const currentEntry = history.find((entry) => entry.reference === dcNumber);
      if (!currentEntry) throw new Error('Delivery Challan is no longer available in the server list. Refresh and retry.');
      const updated = await confirmDeliveryChallanDispatch(dcNumber, currentEntry.version);
      const nextHistory = history.map((entry) => entry.reference === dcNumber ? updated.record : entry);
      setHistory(nextHistory);
      pullRecordsFromServer().catch(() => {});
      setSelectedDC(dispatchedPayload);
      setDispatchRequests(await refreshProductionDispatchRequests());
      alert('Dispatch confirmed successfully.');
    } catch (error) {
      console.error('Failed to confirm production dispatch', error);
      alert(error.message || 'Could not confirm dispatch.');
    }
  };

  const handleConvertToInvoice = (dc) => {
    navigate('/customer-invoice', {
      state: {
        fromDeliveryChallan: true,
        deliveryChallan: dc
      }
    });
  };

  const handlePrintPDF = () => {
    window.print();
  };

  const handleDownloadPDF = async () => {
    if (!selectedDC) return;
    try {
      const pdfPayload = {
        ...selectedDC,
        documentTitle: 'Delivery Challan',
        forTitle: 'Consignee / Deliver To:',
        detailsTitle: 'Dispatch Details:',
        documentDetails: [
          { label: 'Challan No', value: selectedDC.dcDetails?.dcNumber || '-' },
          { label: 'DC Date', value: selectedDC.dcDetails?.dcDate || '-' },
          { label: 'SO Ref', value: selectedDC.dcDetails?.salesOrderRef || '-' },
          { label: 'Vehicle No', value: selectedDC.dcDetails?.vehicleNumber || '-' },
          { label: 'Transporter', value: selectedDC.dcDetails?.transporterName || '-' },
          { label: 'E-Way Bill', value: selectedDC.dcDetails?.ewayBillNumber || '-' },
          { label: 'Purpose', value: selectedDC.dcDetails?.purposeOfDispatch || 'Supply for Sale' }
        ],
        quotationDetails: {
          quotationNumber: selectedDC.dcDetails?.dcNumber,
          quotationDate: selectedDC.dcDetails?.dcDate,
          placeOfSupply: selectedDC.customerDetails?.state || '',
          projectId: selectedDC.dcDetails?.projectId,
          termsAndConditions: selectedDC.dcDetails?.termsAndConditions,
          notes: selectedDC.dcDetails?.notes
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
              ? 'Create Delivery Challan'
              : mode === 'view'
              ? `Delivery Challan: ${selectedDC?.dcDetails?.dcNumber || ''}`
              : 'Delivery Challans'}
          </h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to Challans
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
            {isAdmin() && <button type="button" className="button-secondary" onClick={previewLegacyChallans} disabled={migrationBusy}>Review Legacy Data</button>}
            <button
              className="button-primary"
              onClick={() => {
                setDcDetails({
                  dcNumber: generateDCNumber(),
                  dcDate: new Date().toISOString().slice(0, 10),
                  dispatchDate: new Date().toISOString().slice(0, 10),
                  salesOrderRef: '',
                  customerPoRef: '',
                  projectId: '',
                  purposeOfDispatch: 'Supply for Sale',
                  transporterName: '',
                  vehicleNumber: '',
                  lrNumber: '',
                  ewayBillNumber: '',
                  deliveryLocation: '',
                  challanStatus: 'Dispatched',
                  discount: '',
                  currency: 'INR',
                  exchangeRate: '',
                  rateDate: '',
                  taxMode: 'intra',
                  notes: '',
                  termsAndConditions:
                    '1. Goods received in good order and condition as per specifications.\n' +
                    '2. Discrepancies if any must be notified within 24 hours of receipt.\n' +
                    '3. This is an official dispatch delivery document.'
                });
                setItems([{ ...emptyItem }]);
                setEditingChallan(null);
                setMode('create');
              }}
            >
              + Create Delivery Challan
            </button></div>
          )}
        </div>
      </div>

      {(mode !== 'list' || selectedDC?.dcDetails?.projectId || dcDetails?.projectId) && (
        <WorkflowNavigator
          projectId={selectedDC?.dcDetails?.projectId || dcDetails?.projectId}
          currentStage="deliveryChallan"
          sourceDocument={selectedDC || null}
        />
      )}

      <div className="content-block">
        {migrationPreview && isAdmin() && mode === 'list' && <section className="content-block" aria-label="Legacy Delivery Challan migration preview">
          <h2>Legacy Delivery Challan Migration Preview</h2>
          <p>Eligible: {migrationPreview.counts.eligible}; existing: {migrationPreview.counts.existing}; conflicts: {migrationPreview.counts.conflicts}; deleted IDs blocked: {migrationPreview.counts.deleted}.</p>
          {migrationPreview.eligible.map((record) => <label key={record.number} style={{ display: 'block', padding: '4px 0' }}><input type="checkbox" checked={migrationSelection.has(record.number)} onChange={(event) => setMigrationSelection((current) => { const next = new Set(current); if (event.target.checked) next.add(record.number); else next.delete(record.number); return next; })} /> {record.number}</label>)}
          {[...migrationPreview.conflicts, ...migrationPreview.deleted].map((record, index) => <p key={`${record.number}-${index}`}>{record.number}: {record.reason || 'Previously deleted; import blocked.'}</p>)}
          <button type="button" className="button-primary" disabled={migrationBusy || !migrationSelection.size} onClick={importSelectedChallans}>Import Selected</button>{' '}
          <button type="button" className="button-secondary" onClick={() => setMigrationPreview(null)}>Close Preview</button>
        </section>}
        {mode === 'list' && (
          <>
            <div className="form-section" style={{ marginBottom: '22px', border: pendingDispatchCount ? '2px solid #f59e0b' : undefined }}>
              <div className="block-header">
                <h2>Production Dispatch Requests <span className="badge" style={{ marginLeft: 8, background: pendingDispatchCount ? '#fef3c7' : '#e2e8f0', color: pendingDispatchCount ? '#92400e' : '#475569' }}>{pendingDispatchCount} pending</span></h2>
              </div>
      {dispatchError && <div role="alert" className="alert alert-error">{dispatchError}</div>}
              <div className="history-table-wrapper">
                <table className="history-table">
                  <thead><tr>
                    <th>Job Card No</th><th>Project ID</th><th>Sales Order No</th><th>Customer Name</th>
                    <th>Part / Component</th><th>Drawing Number</th><th>Production Quantity</th><th>QC Status</th>
                    <th>Dispatch Requested By</th><th>Dispatch Request Date</th><th>Status</th><th>Action</th>
                  </tr></thead>
                  <tbody>
                    {dispatchRequests.length ? dispatchRequests.map((request) => (
                      <tr key={request.id} style={request.status === 'Pending' ? { background: '#fffbeb', fontWeight: 600 } : undefined}>
                        <td>{request.jobCardNumber}</td><td>{request.projectId}</td><td>{request.salesOrderNo}</td><td>{request.customerName}</td>
                        <td>{request.partName}</td><td>{request.drawingNumber || '-'}</td><td>{request.productionQuantity}</td><td>{request.qcStatus}</td>
                        <td>{request.dispatchRequestedBy}</td><td>{new Date(request.requestedAt).toLocaleString()}</td>
                        <td>{request.status}</td>
                        <td><button type="button" className="button-small" onClick={() => setSelectedDispatchRequest(request)}>View Details</button></td>
                      </tr>
                    )) : <tr><td colSpan="12" className="no-history-row">No Production dispatch requests have been received.</td></tr>}
                  </tbody>
                </table>
              </div>
              {selectedDispatchRequest && (
                <div style={{ marginTop: 16, padding: 16, background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 8 }}>
                  <div className="section-heading"><h3>Dispatch Request Details — {selectedDispatchRequest.jobCardNumber}</h3></div>
                  <p>Project: {selectedDispatchRequest.projectId} · Sales Order: {selectedDispatchRequest.salesOrderNo} · Customer: {selectedDispatchRequest.customerName}</p>
                  <p>Part: {selectedDispatchRequest.partName} · Drawing: {selectedDispatchRequest.drawingNumber || '-'} · Eligible quantity: {selectedDispatchRequest.eligibleQuantity} · QC: {selectedDispatchRequest.qcStatus}</p>
                  <p>Requested by {selectedDispatchRequest.dispatchRequestedBy} on {new Date(selectedDispatchRequest.requestedAt).toLocaleString()} · Status: {selectedDispatchRequest.status}</p>
                  {canCreateFromDispatchRequest && selectedDispatchRequest.status === 'Pending' && (
                    <button type="button" className="button-primary" onClick={() => beginDispatchRequestChallan(selectedDispatchRequest)}>Create Delivery Challan</button>
                  )}
                </div>
              )}
            </div>
            <div className="block-header">
              <h2>Delivery Challan Records</h2>
            </div>
            {historyError && <div role="alert" className="alert alert-error">{historyError}</div>}
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>DC Date</th>
                    <th>Challan No.</th>
                    <th>Sales Order Ref</th>
                    <th>Customer / Consignee</th>
                    <th>Transporter / Vehicle</th>
                    <th>Quantity</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length > 0 ? (
                    history.map((dc, idx) => (
                      <tr key={idx}>
                        <td>{dc.date}</td>
                        <td><strong>{dc.reference}</strong></td>
                        <td>{dc.salesOrderRef || '-'}</td>
                        <td>{dc.company}</td>
                        <td>{dc.vehicle || '-'}</td>
                        <td>{dc.totalQty || '-'}</td>
                        <td>
                          <span
                            style={{
                              padding: '4px 10px',
                              borderRadius: '20px',
                              fontSize: '12px',
                              fontWeight: '600',
                              background:
                                dc.status === 'Delivered'
                                  ? '#dcfce7'
                                  : dc.status === 'In Transit'
                                  ? '#fef3c7'
                                  : '#e0e7ff',
                              color:
                                dc.status === 'Delivered'
                                  ? '#166534'
                                  : dc.status === 'In Transit'
                                  ? '#92400e'
                                  : '#3730a3'
                            }}
                          >
                            {dc.status}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="button-small"
                              onClick={() => {
                                setSelectedDC(dc.payload);
                                setMode('view');
                              }}
                            >
                              View / Print
                            </button>
                            {!dc.payload?.dispatchRequestId && <button
                              className="button-small"
                              onClick={() => {
                                const p = dc.payload;
                                setDcDetails(p.dcDetails);
                                setCustomerDetails(p.customerDetails);
                                setCompanyDetails(p.companyDetails);
                                setItems(p.items);
                                setEditingChallan(dc);
                                setMode('create');
                              }}
                            >
                              Edit
                            </button>}
                            {isAdmin() && <button type="button" className="button-small" style={{ color: '#b91c1c' }} onClick={async () => {
                              if (!window.confirm(`Move Delivery Challan ${dc.reference} to the Recycle Bin?`)) return;
                              try { await deleteDeliveryChallan(dc.reference, dc.version, 'Admin deletion'); setHistory(await listDeliveryChallans()); }
                              catch (error) { setHistoryError(`Delete was not confirmed: ${error.message}`); }
                            }}>Delete</button>}
                            <button
                              className="button-small"
                              style={{ color: '#86198f', borderColor: '#f5d0fe' }}
                              onClick={() => handleConvertToInvoice(dc.payload)}
                            >
                              Invoice
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="8" className="no-history-row">
                        No Delivery Challans generated yet. Click "+ Create Delivery Challan".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSaveDC}>
            <div className="form-section">
              <div className="section-heading">
                <h3>Delivery Challan Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Challan Number</label>
                  <input
                    type="text"
                    value={dcDetails.dcNumber}
                    onChange={(e) => setDcDetails({ ...dcDetails, dcNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Challan Date</label>
                  <input
                    type="date"
                    value={dcDetails.dcDate}
                    onChange={(e) => setDcDetails({ ...dcDetails, dcDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Link to Sales Order (Optional)</label>
                  <select
                    value={dcDetails.salesOrderRef}
                    onChange={(e) => handleSelectSalesOrder(e.target.value)}
                    disabled={Boolean(dcDetails.dispatchRequestId)}
                  >
                    <option value="">-- Select Existing Sales Order --</option>
                    {salesOrderList.map((so) => (
                      <option key={so.reference} value={so.reference}>
                        {so.reference} - {so.company} ({so.total})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group">
                  <label>Project ID (Master Auto-link)</label>
                  <ProjectIdAutocomplete
                    value={dcDetails.projectId || ''}
                    onChange={(val) => setDcDetails((prev) => ({ ...prev, projectId: val }))}
                    onSelectProject={(pid, fullData) => handleProjectLookup(pid, fullData)}
                    placeholder="Search or select Project ID (e.g. PE-2627-0001)..."
                    autoLinkMsg={projectAutoLinkMsg}
                    disabled={Boolean(dcDetails.dispatchRequestId)}
                  />
                </div>
                <div className="field-group">
                  <label>Dispatch Date</label>
                  <input
                    type="date"
                    value={dcDetails.dispatchDate}
                    onChange={(e) => setDcDetails({ ...dcDetails, dispatchDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Purpose of Dispatch</label>
                  <select
                    value={dcDetails.purposeOfDispatch}
                    onChange={(e) => setDcDetails({ ...dcDetails, purposeOfDispatch: e.target.value })}
                  >
                    <option value="Supply for Sale">Supply for Sale</option>
                    <option value="Job Work / Machining">Job Work / Machining</option>
                    <option value="Trial / Demo">Trial / Demo</option>
                    <option value="Returnable">Returnable</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>Challan Status</label>
                  <select
                    value={dcDetails.challanStatus}
                    onChange={(e) => setDcDetails({ ...dcDetails, challanStatus: e.target.value })}
                    disabled={Boolean(dcDetails.dispatchRequestId)}
                  >
                    {dcDetails.dispatchRequestId && <option value="Challan Created">Challan Created</option>}
                    <option value="Dispatched">Dispatched</option>
                    <option value="In Transit">In Transit</option>
                    <option value="Delivered">Delivered</option>
                    <option value="Returned">Returned</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Transportation & Vehicle Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Transporter Name</label>
                  <input
                    type="text"
                    placeholder="e.g. VRL Logistics / Self / Local Delivery"
                    value={dcDetails.transporterName}
                    onChange={(e) => setDcDetails({ ...dcDetails, transporterName: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Vehicle Number</label>
                  <input
                    type="text"
                    placeholder="e.g. KA-04-AB-1234"
                    value={dcDetails.vehicleNumber}
                    onChange={(e) => setDcDetails({ ...dcDetails, vehicleNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>LR / Consignment No.</label>
                  <input
                    type="text"
                    placeholder="e.g. LR-89102"
                    value={dcDetails.lrNumber}
                    onChange={(e) => setDcDetails({ ...dcDetails, lrNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>E-Way Bill Number</label>
                  <input
                    type="text"
                    placeholder="e.g. 541098234120"
                    value={dcDetails.ewayBillNumber}
                    onChange={(e) => setDcDetails({ ...dcDetails, ewayBillNumber: e.target.value })}
                  />
                </div>
                <div className="field-group full-width">
                  <label>Delivery / Destination Location</label>
                  <input
                    type="text"
                    placeholder="Customer Factory or Site Address"
                    value={dcDetails.deliveryLocation}
                    onChange={(e) => setDcDetails({ ...dcDetails, deliveryLocation: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-section">
              <div className="section-heading">
                <h3>Customer / Consignee Information</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Customer Name *</label>
                  <input
                    type="text"
                    required
                    value={customerDetails.customerName}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, customerName: e.target.value })}
                    disabled={Boolean(dcDetails.dispatchRequestId)}
                  />
                </div>
                <div className="field-group">
                  <label>Company Name</label>
                  <input
                    type="text"
                    value={customerDetails.companyName}
                    onChange={(e) => setCustomerDetails({ ...customerDetails, companyName: e.target.value })}
                    disabled={Boolean(dcDetails.dispatchRequestId)}
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
                <h3>Dispatched Items</h3>
              </div>
              <div className="item-table-wrapper">
                <table className="item-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px' }}>SL.No</th>
                      <th style={{ width: '260px' }}>Description</th>
                      <th style={{ width: '140px' }}>Drawing No.</th>
                      <th style={{ width: '110px' }}>HSN/SAC</th>
                      <th style={{ width: '90px' }}>Dispatch Qty</th>
                      <th style={{ width: '110px' }}>Unit</th>
                      <th style={{ width: '125px' }}>Unit Price</th>
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
                            readOnly={Boolean(dcDetails.dispatchRequestId)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={item.drawingNo || ''}
                            onChange={(e) => handleFieldChange(idx, 'drawingNo', e.target.value)}
                            readOnly={Boolean(dcDetails.dispatchRequestId)}
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
                            min="1"
                            max={dcDetails.eligibleProductionQty || undefined}
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
                            hidden={Boolean(dcDetails.dispatchRequestId)}
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
                          hidden={Boolean(dcDetails.dispatchRequestId)}
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
                      value={dcDetails.discount}
                      onChange={(e) => setDcDetails({ ...dcDetails, discount: e.target.value })}
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
                <h3>Terms & Dispatch Notes</h3>
              </div>
              <div className="field-group full-width">
                <label>Delivery Terms & Conditions</label>
                <textarea
                  rows="3"
                  value={dcDetails.termsAndConditions}
                  onChange={(e) => setDcDetails({ ...dcDetails, termsAndConditions: e.target.value })}
                />
              </div>
              <div className="field-group full-width" style={{ marginTop: '16px' }}>
                <label>Dispatch / Packaging Remarks</label>
                <textarea
                  rows="2"
                  value={dcDetails.notes}
                  onChange={(e) => setDcDetails({ ...dcDetails, notes: e.target.value })}
                />
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setMode('list')}>
                Cancel
              </button>
              <button type="submit" className="button-primary">
                Save & Generate Delivery Challan
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedDC && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end' }}>
              {selectedDC.dispatchRequestId && selectedDC.dcDetails?.challanStatus === 'Challan Created' && (
                <button className="button-primary" onClick={() => handleConfirmDispatch(selectedDC)}>
                  Confirm Actual Dispatch
                </button>
              )}
              <button className="button-primary" onClick={handlePrintPDF}>
                Print Delivery Challan
              </button>
              <button className="button-secondary" onClick={handleDownloadPDF}>
                Download PDF
              </button>
              {!selectedDC.dispatchRequestId && <button
                className="button-secondary"
                onClick={() => {
                  setDcDetails(selectedDC.dcDetails);
                  setCustomerDetails(selectedDC.customerDetails);
                  setCompanyDetails(selectedDC.companyDetails);
                  setItems(selectedDC.items);
                  setMode('create');
                }}
              >
                Edit Challan
              </button>}
            </div>

            <div className="doc-page-container">
              <div className="quotation-doc-sheet printable">
                <h1 className="doc-main-title">DELIVERY CHALLAN</h1>

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
                    <div className="doc-box-header">Consignee / Deliver To:</div>
                    <div className="doc-box-body">
                      <div className="doc-customer-name">
                        {selectedDC.customerDetails?.companyName || selectedDC.customerDetails?.customerName || '-'}
                      </div>
                      {selectedDC.customerDetails?.address && (
                        <div className="doc-customer-address">{selectedDC.customerDetails.address}</div>
                      )}
                      <div className="doc-customer-inline">
                        {selectedDC.customerDetails?.contactNumber && (
                          <div>Contact: {selectedDC.customerDetails.contactNumber}</div>
                        )}
                        {selectedDC.customerDetails?.gstNumber && (
                          <div>GSTIN: {selectedDC.customerDetails.gstNumber}</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="doc-half-box doc-half-right">
                    <div className="doc-box-header">Dispatch Details:</div>
                    <div className="doc-box-body">
                      <div><strong>Challan No:</strong> {selectedDC.dcDetails?.dcNumber || '-'}</div>
                      <div><strong>DC Date:</strong> {selectedDC.dcDetails?.dcDate || '-'}</div>
                      <div>
                        <strong>Currency:</strong> {viewCurrency}
                        {isForeignCurrency(viewCurrency) && selectedDC.dcDetails?.exchangeRate
                          ? ` @ ${selectedDC.dcDetails.exchangeRate}`
                          : ''}
                      </div>
                      {isForeignCurrency(viewCurrency) && (
                        <div>
                          <strong>Value in INR:</strong>{' '}
                          {moneyPlain(
                            convertToINR(
                              selectedDC.totals?.grandTotal || 0,
                              viewCurrency,
                              selectedDC.dcDetails?.exchangeRate
                            ),
                            'INR'
                          )}
                        </div>
                      )}
                      <div><strong>Tax:</strong> {viewTaxLabel}</div>
                      {selectedDC.dcDetails?.salesOrderRef && (
                        <div><strong>SO Ref:</strong> {selectedDC.dcDetails.salesOrderRef}</div>
                      )}
                      {selectedDC.dcDetails?.vehicleNumber && (
                        <div><strong>Vehicle No:</strong> {selectedDC.dcDetails.vehicleNumber}</div>
                      )}
                      {selectedDC.dcDetails?.transporterName && (
                        <div><strong>Transporter:</strong> {selectedDC.dcDetails.transporterName}</div>
                      )}
                      {selectedDC.dcDetails?.ewayBillNumber && (
                        <div><strong>E-Way Bill:</strong> {selectedDC.dcDetails.ewayBillNumber}</div>
                      )}
                      <div><strong>Purpose:</strong> {selectedDC.dcDetails?.purposeOfDispatch || 'Supply for Sale'}</div>
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
                      <th className="th-quantity text-right">Dispatch Qty</th>
                      <th className="th-unit text-center">Unit</th>
                      <th className="th-unitPrice text-right">Rate</th>
                      <th className="th-gst text-right">GST%</th>
                      <th className="th-amount text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedDC.items?.map((item, idx) => (
                      <tr key={idx}>
                        <td className="text-center">{idx + 1}</td>
                        <td className="text-left">{item.drawingNo || '-'}</td>
                        <td className="text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                        </td>
                        <td className="text-left">{item.hsnSac || '-'}</td>
                        <td className="text-right font-bold">{item.quantity || 0}</td>
                        <td className="text-center">{item.unit || 'Nos'}</td>
                        <td className="text-right">{Number(item.unitPrice || 0).toFixed(2)}</td>
                        <td className="text-right">{item.gst ? `${item.gst}%` : '0%'}</td>
                        <td className="text-right">{viewMoney(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="doc-total-row">
                      <td colSpan={4} className="font-bold text-left">Total Dispatched</td>
                      <td className="font-bold text-right">
                        {selectedDC.items?.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0)}
                      </td>
                      <td></td>
                      <td></td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedDC.totals?.totalGST)}
                      </td>
                      <td className="font-bold text-right">
                        {viewMoney(selectedDC.totals?.subtotal)}
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
                          {selectedDC.amountInWords || wordsFor(selectedDC?.totals?.grandTotal || 0, viewCurrency)}
                        </div>
                      </div>
                      <div className="doc-full-box" style={{ margin: 0, border: '1px solid #000', minHeight: '60px', flex: 'auto', boxSizing: 'border-box' }}>
                          <div className="doc-box-title">Notes</div>
                        <div className="doc-box-text" style={{ marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                          {selectedDC?.dcDetails?.notes || '-'}
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
                          {viewMoney(selectedDC.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Taxable</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedDC.totals?.taxableAmount || selectedDC.totals?.subtotal)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax rate</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {selectedDC.items?.find(i => Number(i.gst) > 0)?.gst ? `${selectedDC.items.find(i => Number(i.gst) > 0).gst}%` : (selectedDC.items?.[0]?.gst ? `${selectedDC.items[0].gst}%` : '0%')}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax Amount</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedDC.totals?.totalGST)}
                        </td>
                      </tr>
                      <tr style={{ borderBottom: '1.5px solid #0f172a', background: '#f8fafc' }}>
                        <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Other</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                          {viewMoney(selectedDC.totals?.otherCharges)}
                        </td>
                      </tr>
                      <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                        <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>
                          {viewMoney(selectedDC.totals?.grandTotal)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Notes */}
                {selectedDC.dcDetails?.notes && (
                  <div className="doc-full-box">
                    <div className="doc-box-title">Dispatch Remarks:</div>
                    <div className="doc-box-text">{selectedDC.dcDetails.notes}</div>
                  </div>
                )}

                {/* Terms and Two Signatures (Receiver & Authorized Signatory) */}
                <div className="doc-bottom-split">
                  <div className="doc-terms-box">
                    <div className="doc-box-title">Receiver's Acknowledgment:</div>
                    <div className="doc-terms-list" style={{ marginBottom: '14px' }}>
                      <div className="doc-term-item">Received the above goods in sound condition and exact quantity.</div>
                    </div>
                    <div style={{ marginTop: '24px', borderTop: '1px dashed #94a3b8', paddingTop: '6px', fontSize: '11px', color: '#475569', fontWeight: 'bold' }}>
                      Receiver's Signature & Stamp
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

export default DeliveryChallanPage;

