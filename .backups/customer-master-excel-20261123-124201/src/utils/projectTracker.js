import legacyPOData from '../constants/legacyPOData.json';
import { enrichCustomerDetails } from './customerMaster.js';

/**
 * Centralized Project Lifecycle Tracker for the ERP.
 * Links all modules (Enquiry -> Quotation -> Customer PO -> Sales Order -> Job Card -> Delivery Challan -> Invoice)
 * by the unique Project ID.
 */

export const getStoredList = (key) => {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : [];
  } catch (err) {
    console.error(`Error reading ${key} from storage:`, err);
    return [];
  }
};

const normalizeReference = (value) => String(value || '').trim().toUpperCase();
const recordProjectId = (record, kind) => kind === 'jobCard'
  ? record?.projectId || record?.projectRef
  : kind === 'deliveryChallan'
    ? record?.payload?.dcDetails?.projectId || record?.payload?.projectId
    : '';
const recordSORef = (record, kind) => kind === 'jobCard'
  ? record?.salesOrderRef || record?.salesOrderNumber
  : kind === 'deliveryChallan'
    ? record?.payload?.dcDetails?.salesOrderRef || record?.payload?.salesOrderRef
    : '';
const recordDCNumber = (record) => record?.reference || record?.payload?.dcDetails?.dcNumber || '';
const recordJCNumber = (record) => record?.jobCardNumber || record?.payload?.jobCardNumber || record?.payload?.dcDetails?.jobCardNumber || '';

const resolveLinkedDeliveryChallan = ({ challans, invoice, projectId, soNumber }) => {
  if (invoice?.dcDetails) return invoice;
  const details = invoice?.payload?.invoiceDetails || {};
  const noteRef = String(details.notes || '').match(/Delivery Challan\s+([A-Za-z0-9._/-]+)/i)?.[1] || '';
  const explicitRef = details.dcRef || details.deliveryChallanRef || details.dcNumber || invoice?.payload?.dcRef || noteRef;
  if (explicitRef) {
    const exact = challans.find((row) => normalizeReference(recordDCNumber(row)) === normalizeReference(explicitRef));
    if (exact) return exact;
  }

  const invoiceSO = normalizeReference(details.salesOrderRef);
  const project = normalizeReference(projectId);
  const order = normalizeReference(soNumber || details.salesOrderRef);
  const related = challans.filter((row) => {
    const dcProject = normalizeReference(recordProjectId(row, 'deliveryChallan'));
    const dcSO = normalizeReference(recordSORef(row, 'deliveryChallan'));
    return (project && dcProject === project) && (!order || !dcSO || dcSO === order || dcSO === invoiceSO);
  });
  if (related.length <= 1) return related[0] || null;

  const invoiceItems = invoice?.payload?.items || [];
  const itemMatches = related.filter((row) => {
    const dcItems = row?.payload?.items || [];
    return invoiceItems.some((item) => dcItems.some((dcItem) =>
      normalizeReference(item.drawingNo || item.drawingNumber) === normalizeReference(dcItem.drawingNo || dcItem.drawingNumber) &&
      normalizeReference(item.itemName || item.materialName) === normalizeReference(dcItem.itemName || dcItem.materialName)
    ));
  });
  if (itemMatches.length === 1) return itemMatches[0];
  return related.length === 1 ? related[0] : null;
};

const resolveLinkedJobCard = ({ jobCards, invoice, deliveryChallan, projectId, soNumber }) => {
  const details = invoice?.payload?.invoiceDetails || {};
  const explicit = details.jobCardNumber || invoice?.payload?.jobCardNumber || recordJCNumber(deliveryChallan);
  const expectedProject = normalizeReference(projectId);
  const soRefs = [soNumber, details.salesOrderRef, recordSORef(deliveryChallan, 'deliveryChallan')]
    .map(normalizeReference).filter(Boolean);
  const jcByNumber = (number) => jobCards.find((jc) => normalizeReference(jc.jobCardNumber) === normalizeReference(number));
  if (explicit) {
    const exact = jcByNumber(explicit);
    if (exact) {
      const exactProject = normalizeReference(recordProjectId(exact, 'jobCard'));
      const exactSO = normalizeReference(recordSORef(exact, 'jobCard'));
      if ((!exactProject || !expectedProject || exactProject === expectedProject) &&
        (!exactSO || !soRefs.length || soRefs.includes(exactSO))) return exact;
      return null;
    }
  }

  const candidates = jobCards.filter((jc) => {
    const jcSO = normalizeReference(recordSORef(jc, 'jobCard'));
    const jcProject = normalizeReference(recordProjectId(jc, 'jobCard'));
    const projectMatches = expectedProject && jcProject === expectedProject;
    const orderMatches = soRefs.some((ref) => jcSO === ref);
    if (jcProject && expectedProject && jcProject !== expectedProject) return false;
    if (jcSO && soRefs.length && !orderMatches) return false;
    return Boolean(projectMatches || orderMatches);
  });

  const invoiceItems = [...(invoice?.payload?.items || []), ...(deliveryChallan?.payload?.items || [])];
  const itemMatches = candidates.filter((jc) => invoiceItems.some((item) =>
    (normalizeReference(item.drawingNo || item.drawingNumber) && normalizeReference(item.drawingNo || item.drawingNumber) === normalizeReference(jc.drawingNumber)) ||
    (normalizeReference(item.itemName || item.materialName) && normalizeReference(item.itemName || item.materialName) === normalizeReference(jc.partName)) ||
    normalizeReference(item.itemCode) === normalizeReference(jc.jobCardNumber)
  ));
  if (itemMatches.length === 1) return itemMatches[0];
  if (candidates.length === 1) return candidates[0];
  return null;
};

export const isJobCardQCComplete = (jobCard) =>
  String(jobCard?.status || '').trim().toLowerCase() === 'completed' &&
  String(jobCard?.qualityControl?.finalQC?.disposition || '').trim().toLowerCase() === 'pass';

/**
 * Derives a human-friendly Project Name for a given Project ID.
 * Priority: first linked item name -> project request company/customer name -> SO customer.
 * Never returns a fabricated value; returns '' when nothing is known.
 */
export const getProjectNameForId = (projectId) => {
  if (!projectId || typeof projectId !== 'string') return '';
  const cleanId = projectId.trim().toUpperCase();
  if (!cleanId) return '';

  const projectRequests = getStoredList('projectRequests');
  const salesOrders = getStoredList('salesOrderHistory');

  const pr = projectRequests.find((p) => p.projectId?.trim().toUpperCase() === cleanId);
  const so = salesOrders.find((it) => it.payload?.soDetails?.projectId?.trim().toUpperCase() === cleanId);

  const items = so?.payload?.items || pr?.items || [];
  const firstItem = items[0] || {};

  return (
    firstItem.itemName ||
    pr?.companyName ||
    pr?.customerName ||
    so?.payload?.customerDetails?.companyName ||
    so?.payload?.customerDetails?.customerName ||
    ''
  );
};

/**
 * Returns a list of all distinct Project IDs with their customer and order status
 */
export const getAllProjectsSummary = () => {
  const projectRequests = getStoredList('projectRequests');
  const quotations = getStoredList('quotationHistory');
  const customerPOs = getStoredList('customerPOHistory');
  const salesOrders = getStoredList('salesOrderHistory');
  const jobCards = getStoredList('productionJobCards');
  const challans = getStoredList('deliveryChallanHistory');
  const invoices = getStoredList('customerInvoiceHistory');

  const projectMap = new Map();

  // 1. Ingest Project Requests (The Origin)
  projectRequests.forEach((pr) => {
    if (!pr.projectId) return;
    const enriched = enrichCustomerDetails(pr.companyName || pr.customerName, {
      customerName: pr.customerName,
      companyName: pr.companyName,
      address: pr.address,
      phone: pr.phone,
      email: pr.email,
      gstin: pr.gstin
    });

    projectMap.set(pr.projectId, {
      projectId: pr.projectId,
      projectName: pr.items?.[0]?.itemName || pr.companyName || pr.customerName || '',
      customerName: enriched.customerName,
      companyName: enriched.companyName,
      address: enriched.address,
      phone: enriched.phone,
      email: enriched.email,
      gstin: enriched.gstin,
      vendorCode: enriched.vendorCode,
      items: pr.items || [],
      quotationRef: '',
      customerPoNumber: '',
      soNumber: '',
      jobCardNumber: '',
      dcNumber: '',
      invoiceNumber: '',
      status: 'Enquiry Received',
      isLegacy: false,
      fyLabel: 'FY 2026-27',
      createdAt: pr.createdAt || pr.requestedDate
    });
  });

  // 2. Correlate Quotations
  quotations.forEach((q) => {
    const pid = q.payload?.quotationDetails?.projectId;
    if (pid && projectMap.has(pid)) {
      const rec = projectMap.get(pid);
      rec.quotationRef = q.reference || q.payload?.quotationDetails?.quotationNumber || '';
      rec.status = 'Quotation Sent';
      if (!rec.customerName && q.customerDetails?.customerName) {
        rec.customerName = q.customerDetails.customerName;
        rec.companyName = q.customerDetails.companyName;
      }
    }
  });

  // 3. Correlate Customer POs
  customerPOs.forEach((cpo) => {
    const pid = cpo.payload?.poDetails?.projectId;
    if (pid && projectMap.has(pid)) {
      const rec = projectMap.get(pid);
      rec.customerPoNumber = cpo.reference || cpo.payload?.poDetails?.customerPoNumber || '';
      rec.status = 'Customer PO Received';
    }
  });

  // 4. Correlate Sales Orders
  salesOrders.forEach((so) => {
    const pid = so.payload?.soDetails?.projectId;
    if (pid && projectMap.has(pid)) {
      const rec = projectMap.get(pid);
      rec.soNumber = so.reference || so.payload?.soDetails?.soNumber || '';
      rec.status = 'Sales Order Confirmed';
    }
  });

  // 5. Correlate Job Cards (Production)
  jobCards.forEach((jc) => {
    const pid = jc.drawingNumber || jc.salesOrderRef;
    // Check direct or via SO
    projectMap.forEach((rec) => {
      if (rec.soNumber === jc.salesOrderRef || rec.items.some((i) => i.drawingNo === jc.drawingNumber)) {
        rec.jobCardNumber = jc.jobCardNumber;
        rec.status = jc.status === 'Completed' ? 'Production QC Passed' : 'In Production';
      }
    });
  });

  // 6. Correlate Delivery Challans
  challans.forEach((dc) => {
    const pid = dc.payload?.dcDetails?.projectId;
    if (pid && projectMap.has(pid)) {
      const rec = projectMap.get(pid);
      rec.dcNumber = dc.reference || dc.payload?.dcDetails?.dcNumber || '';
      rec.status = 'Dispatched';
    }
  });

  // 7. Correlate Customer Invoices
  invoices.forEach((inv) => {
    const pid = inv.payload?.invoiceDetails?.projectId;
    if (pid && projectMap.has(pid)) {
      const rec = projectMap.get(pid);
      rec.invoiceNumber = inv.reference || inv.payload?.invoiceDetails?.invoiceNumber || '';
      rec.status = 'Invoiced';
    }
  });

  // 8. Ingest Legacy Historical POs
  if (Array.isArray(legacyPOData)) {
    legacyPOData.forEach((lpo) => {
      if (!lpo.projectId) return;
      if (!projectMap.has(lpo.projectId)) {
        const enriched = enrichCustomerDetails(lpo.customerName, {
          customerName: lpo.customerName,
          companyName: lpo.customerName,
          address: 'Verified Customer (Archives)'
        });

        projectMap.set(lpo.projectId, {
          projectId: lpo.projectId,
          projectName: lpo.items?.[0]?.itemDescription || lpo.customerName || '',
          customerName: enriched.customerName,
          companyName: enriched.companyName,
          address: enriched.address,
          phone: enriched.phone,
          email: enriched.email,
          gstin: enriched.gstin,
          vendorCode: enriched.vendorCode,
          items: lpo.items?.map((it, idx) => ({
            itemCode: 'N/A (Pre-ERP)',
            itemName: it.itemDescription || '',
            drawingNo: it.drawingNo || '-',
            quantity: it.quantity || 1,
            unitPrice: it.unitRate || 0,
            amount: it.amount || 0,
            unit: 'Nos',
            hsnSac: '8483'
          })) || [],
          quotationRef: '-',
          customerPoNumber: lpo.poNumber || '',
          soNumber: '-',
          jobCardNumber: '-',
          dcNumber: '-',
          invoiceNumber: '-',
          status: `Archived (${lpo.fyLabel})`,
          isLegacy: true,
          fyLabel: lpo.fyLabel,
          createdAt: lpo.poDate
        });
      }
    });
  }

  return Array.from(projectMap.values());
};

/**
 * Retrieves all cross-module data linked to a specific Project ID
 */
export const getFullProjectData = (projectId, sourceDocument = null) => {
  if (!projectId) return null;
  const cleanId = projectId.trim().toUpperCase();

  const projectRequests = getStoredList('projectRequests');
  const quotations = getStoredList('quotationHistory');
  const customerPOs = getStoredList('customerPOHistory');
  const salesOrders = getStoredList('salesOrderHistory');
  const jobCards = getStoredList('productionJobCards');
  const challans = getStoredList('deliveryChallanHistory');
  const invoices = getStoredList('customerInvoiceHistory');

  // Match origin
  const pr = projectRequests.find((p) => p.projectId?.trim().toUpperCase() === cleanId);
  const q = quotations.find((it) => it.payload?.quotationDetails?.projectId?.trim().toUpperCase() === cleanId);
  const cpo = customerPOs.find((it) => it.payload?.poDetails?.projectId?.trim().toUpperCase() === cleanId);
  const so = salesOrders.find((it) => it.payload?.soDetails?.projectId?.trim().toUpperCase() === cleanId);
  const dc = challans.find((it) => it.payload?.dcDetails?.projectId?.trim().toUpperCase() === cleanId);
  const inv = sourceDocument?.invoiceDetails
    ? { payload: sourceDocument, reference: sourceDocument.invoiceDetails.invoiceNumber }
    : invoices.find((it) => it.payload?.invoiceDetails?.projectId?.trim().toUpperCase() === cleanId);
  const invoiceDocument = sourceDocument?.dcDetails
    ? null
    : inv?.payload || (sourceDocument?.invoiceDetails ? sourceDocument : null);
  const linkedDC = resolveLinkedDeliveryChallan({ challans, invoice: invoiceDocument ? { payload: invoiceDocument } : null, projectId: cleanId, soNumber: so?.reference || so?.payload?.soDetails?.soNumber });
  const sourceDC = sourceDocument?.dcDetails ? sourceDocument : linkedDC;
  const jobCard = resolveLinkedJobCard({ jobCards, invoice: invoiceDocument ? { payload: invoiceDocument } : null, deliveryChallan: sourceDC, projectId: cleanId, soNumber: so?.reference || so?.payload?.soDetails?.soNumber });
  const leg = Array.isArray(legacyPOData) ? legacyPOData.find((l) => l.projectId?.trim().toUpperCase() === cleanId) : null;

  // Line items extraction priority: SO -> Customer PO -> Quotation -> Project Request -> Legacy PO
  const items =
    so?.payload?.items ||
    cpo?.payload?.items ||
    q?.payload?.items ||
    pr?.items?.map((it) => ({
      itemCode: it.drawingNo ? `PRAG-${it.drawingNo.replace(/[^a-zA-Z0-9]/g, '')}` : 'PRAG-001',
      itemName: it.itemName || '',
      drawingNo: it.drawingNo || '',
      drawingFileName: it.drawingFileName || '',
      drawingDataUrl: it.drawingDataUrl || '',
      materialSpec: it.materialSpec || '',
      notes: it.notes || '',
      hsnSac: '8483',
      quantity: it.quantity || 1,
      unit: it.unit || 'Nos',
      unitPrice: 0,
      gst: '18'
    })) ||
    leg?.items?.map((it, idx) => ({
      itemCode: 'N/A (Pre-ERP)',
      itemName: it.itemDescription || '',
      drawingNo: it.drawingNo || '-',
      quantity: it.quantity || 1,
      unitPrice: it.unitRate || 0,
      amount: it.amount || 0,
      unit: 'Nos',
      hsnSac: '8483',
      gst: '0'
    })) ||
    [];

  const rawCustName = pr?.customerName || q?.payload?.customerDetails?.customerName || so?.payload?.customerDetails?.customerName || leg?.customerName || '';
  const rawCompName = pr?.companyName || q?.payload?.customerDetails?.companyName || so?.payload?.customerDetails?.companyName || leg?.customerName || '';
  const enriched = enrichCustomerDetails(rawCompName || rawCustName, {
    customerName: rawCustName,
    companyName: rawCompName,
    address: pr?.address || q?.payload?.customerDetails?.address || so?.payload?.customerDetails?.address,
    contactNumber: pr?.phone || q?.payload?.customerDetails?.contactNumber || so?.payload?.customerDetails?.contactNumber,
    email: pr?.email || q?.payload?.customerDetails?.email || so?.payload?.customerDetails?.email,
    gstNumber: pr?.gstin || q?.payload?.customerDetails?.gstNumber || so?.payload?.customerDetails?.gstNumber
  });

  const customerDetails = {
    customerName: enriched.customerName || rawCustName,
    companyName: enriched.companyName || rawCompName,
    address: enriched.address || 'Verified Customer (Archives)',
    contactNumber: enriched.contactNumber || '',
    email: enriched.email || '',
    gstNumber: enriched.gstNumber || '',
    vendorCode: enriched.vendorCode || '',
    state: q?.payload?.customerDetails?.state || 'Karnataka (29)'
  };

  return {
    projectId: cleanId,
    customerDetails,
    items,
    quotationRef: q?.reference || q?.payload?.quotationDetails?.quotationNumber || '',
    customerPoNumber: cpo?.reference || cpo?.payload?.poDetails?.customerPoNumber || leg?.poNumber || '',
    soNumber: so?.reference || so?.payload?.soDetails?.soNumber || '',
    jobCardNumber: jobCard?.jobCardNumber || '',
    jobCard,
    jobCardComplete: isJobCardQCComplete(jobCard),
    dcNumber: dc?.reference || dc?.payload?.dcDetails?.dcNumber || '',
    invoiceNumber: inv?.reference || inv?.payload?.invoiceDetails?.invoiceNumber || '',
    projectRequest: pr,
    quotation: q?.payload,
    customerPO: cpo?.payload,
    salesOrder: so?.payload,
    deliveryChallan: dc?.payload,
    invoice: inv?.payload,
    isLegacy: Boolean(leg),
    legacyPO: leg
  };
};
