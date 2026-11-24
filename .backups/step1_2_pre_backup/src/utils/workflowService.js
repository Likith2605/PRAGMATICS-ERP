/**
 * Sales Order → Store → Purchase → Receipt → Quality → Inventory → Production
 * ---------------------------------------------------------------------------
 * Department-wise workflow service layered on top of the existing ERP storage
 * (localStorage via storeService.js). Every mutation is permission gated and
 * produces an audit-log entry plus (where relevant) a department notification.
 *
 * Tables owned by this module:
 *   soMaterialAvailabilityChecks  – store material availability check per Sales Order
 *   purchaseIndents               – purchase indents (SO → Purchase)
 *   materialArrivals              – vendor material arrival (PO → Store, no invoice)
 *   materialReceipts              – tax invoice / material receipt (after QC approval)
 *   qualityChecks                 – quality inspection records
 *   rejectionReports              – vendor rejection reports
 *   debitNotes                    – debit notes raised against rejected material
 *
 * Existing tables reused (never duplicated):
 *   salesOrderHistory, supplierPOHistory, inventoryItems, stockTransactions,
 *   storeAuditLog, notifications, vendorMaster
 */

import {
  readLS,
  writeLS,
  appendAuditLog,
  pushNotification,
  getInventoryItems,
  saveInventoryItems,
  getStockTransactions,
  saveStockTransactions,
  addInventoryBatch,
  getExpiryStatus,
  todayStr,
  nowDateTimeStr
} from './storeService.js';
import { generateSequentialNumber, saveSequenceCounter } from './storeSequencer.js';
import {
  acceptVendorQuotation,
  getVendorQuotationByNumber,
  markQuotationPOCreated,
  QUOTATION_STATUS,
  QUOTATION_ACCEPTED_STATUSES,
  QUOTATION_PO_CREATED_STATUSES
} from './storeService.js';
import { getVendorByName } from './vendorMaster.js';
import { calculateLineAmount, calculateGSTAmount, calculateTotals } from './calculations.js';
import { numberToWords } from './numberToWords.js';
import { hasPermission, getCurrentUserInfo, getCurrentDepartment } from './permissions.js';

const WF = {
  checks: 'soMaterialAvailabilityChecks',
  indents: 'purchaseIndents',
  indentSeq: 'purchaseIndentSequence',
  receipts: 'materialReceipts',
  receiptSeq: 'materialReceiptSequence',
  replReceiptSeq: 'replacementReceiptSequence',
  arrivals: 'materialArrivals',
  arrivalSeq: 'materialArrivalSequence',
  qcs: 'qualityChecks',
  qcSeq: 'qualityCheckSequence',
  rejections: 'rejectionReports',
  rejectionSeq: 'rejectionReportSequence',
  debitNotes: 'debitNotes',
  debitNoteSeq: 'debitNoteSequence'
};

const SO_HISTORY = 'salesOrderHistory';
const PO_HISTORY = 'supplierPOHistory';

export const INDENT_STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  PENDING_PURCHASE_ENQUIRY: 'Pending Purchase Enquiry',
  ENQUIRY_CREATED: 'Enquiry Created',
  QUOTATION_RECEIVED: 'Quotation Received',
  QUOTATION_ACCEPTED: 'Quotation Accepted',
  PO_CREATED: 'PO Created',
  COMPLETED: 'Completed',
  AWAITING_PRODUCTION: 'Awaiting Production',
  UNDER_REVIEW: 'Under Purchase Review',
  CONVERTED: 'Converted to PO',
  CANCELLED: 'Cancelled'
};

export const PO_STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  AWAITING_DELIVERY: 'Awaiting Delivery',
  PARTIAL: 'Partially Received',
  AWAITING_QC: 'Received / Awaiting QC',
  QC_APPROVED: 'Quality Approved',
  QC_PARTIAL: 'Partially Quality Approved',
  QC_REJECTED: 'Partially Rejected',
  REPLACEMENT_PENDING: 'Replacement Pending',
  REPLACEMENT_AWAITING_ARRIVAL: 'Replacement In Transit',
  AWAITING_INVENTORY: 'Approved / Awaiting Inventory',
  AWAITING_INVOICE: 'Approved / Awaiting Tax Invoice',
  FULFILLED: 'Fully Fulfilled',
  /** Legacy label kept so historical records keep rendering. */
  FULL: 'Fully Received',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled'
};

/**
 * Company standard purchase terms printed on every Purchase Order. A PO must
 * never leave the system with a blank Terms & Conditions block: this is the
 * fallback whenever neither an override nor the vendor's quoted terms exist.
 */
export const DEFAULT_PO_TERMS =
  '1. Materials must strictly conform to specifications and drawings provided.\n' +
  '2. Test certificate and inspection report must accompany the delivery.\n' +
  '3. Delivery must be made to PRAGMATIC ENGINEERS factory gate during working hours.\n' +
  '4. Payment will be released within agreed terms following quality inspection.';

/** Vendor Enquiry lifecycle. */
export const ENQUIRY_STATUS = {
  DRAFT: 'Draft',
  CREATED: 'Created',
  SENT_TO_VENDOR: 'Sent to Vendor',
  QUOTATION_PENDING: 'Quotation Pending',
  QUOTATION_RECEIVED: 'Quotation Received',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
};

/** PO statuses that must never be treated as open for a fresh delivery. */
const PO_TERMINAL_STATUSES = [PO_STATUS.CLOSED, PO_STATUS.CANCELLED, 'Received', 'Fully Received'];

/**
 * Material Arrival is the Store's first, invoice-free action on an incoming
 * consignment. It only proves that material physically reached the store — it is
 * never an invoice and never touches inventory. Quality Check inspects the
 * arrival; the Tax Invoice / Material Receipt is only raised afterwards for the
 * quantity that actually passed.
 */
export const ARRIVAL_STATUS = {
  PENDING_QC: 'Received / Awaiting Quality Check',
  QC_COMPLETED: 'Quality Checked',
  PARTIAL_REJECTED: 'Partially Rejected',
  FULLY_REJECTED: 'Rejected'
};

/** How an arrival relates to the original PO delivery. */
export const ARRIVAL_TYPE = {
  ORIGINAL: 'Original Delivery',
  REPLACEMENT: 'Replacement Delivery'
};

/** Arrival statuses that still need a Quality Check. */
const ARRIVAL_PENDING_QC_STATUSES = [ARRIVAL_STATUS.PENDING_QC];


export const QC_STATUS = {
  PENDING: 'Pending Quality Check',
  UNDER: 'Under Inspection',
  APPROVED: 'Approved',
  PARTIAL: 'Partially Approved',
  REJECTED: 'Rejected'
};

/** Purchase Indent QC lifecycle values stored on indent.qcStatus. */
export const INDENT_QC_STATUS = {
  SENT: 'Sent to Quality Check',
  DONE: 'Inspected'
};

export const REJECTION_STATUS = {
  RAISED: 'Raised',
  WITH_STORE: 'With Store',
  FORWARDED: 'Forwarded to Purchase',
  SENT_VENDOR: 'Sent to Vendor',
  CLOSED: 'Closed'
};

/**
 * Debit Note lifecycle. A Debit Note is a financial claim against the vendor for
 * material that failed Quality Check. It never touches stock: the rejected
 * quantity is simply not credited into inventory, so issuing a Debit Note only
 * records the money owed back to us.
 *
 * Approval chain (current):
 *
 *   DRAFT ──Store submits──▶ ADMIN_REVIEW ──Admin approves──▶ APPROVED
 *          ──Purchase issues──▶ ISSUED ──Purchase sends to vendor
 *          (with the rejection reasons)──▶ SENT_VENDOR ──replacement received
 *          and re-inspected by Quality──▶ CLOSED
 *
 * REQUESTED / PURCHASE_REVIEW are retained so Debit Notes that were already in
 * flight under the old "Purchase reviews first" order can still be completed.
 * CREATED / SENT / RECORDED are legacy labels kept so historical records keep
 * rendering.
 */
export const DEBIT_NOTE_STATUS = {
  DRAFT: 'Draft',
  /** Legacy — Debit Notes submitted before the Admin-first order. */
  REQUESTED: 'Requested',
  /** Legacy — Purchase review before the Admin approval. */
  PURCHASE_REVIEW: 'Purchase Review',
  /** Store has submitted it — waiting for the Admin approval. */
  ADMIN_REVIEW: 'Admin Approval',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  SENT_VENDOR: 'Sent to Vendor',
  CLOSED: 'Closed',
  /** Legacy labels kept so historical records keep rendering. */
  CREATED: 'Created',
  SENT: 'Sent to Purchase',
  RECORDED: 'Recorded by Purchase'
};

/** Debit Note statuses whose quantities are committed against the rejection.
 *  From REQUESTED onwards the rejected quantity is reserved, so the same
 *  rejected material can never be claimed by a second Debit Note. */
const DEBIT_NOTE_COMMITTED_STATUSES = [
  DEBIT_NOTE_STATUS.REQUESTED,
  DEBIT_NOTE_STATUS.PURCHASE_REVIEW,
  DEBIT_NOTE_STATUS.ADMIN_REVIEW,
  DEBIT_NOTE_STATUS.APPROVED,
  DEBIT_NOTE_STATUS.ISSUED,
  DEBIT_NOTE_STATUS.SENT_VENDOR,
  DEBIT_NOTE_STATUS.CLOSED,
  DEBIT_NOTE_STATUS.CREATED,
  DEBIT_NOTE_STATUS.SENT,
  DEBIT_NOTE_STATUS.RECORDED
];

/** Debit Note statuses that are still open for action. */
export const DEBIT_NOTE_OPEN_STATUSES = [
  DEBIT_NOTE_STATUS.DRAFT,
  DEBIT_NOTE_STATUS.REQUESTED,
  DEBIT_NOTE_STATUS.PURCHASE_REVIEW,
  DEBIT_NOTE_STATUS.ADMIN_REVIEW,
  DEBIT_NOTE_STATUS.APPROVED,
  DEBIT_NOTE_STATUS.ISSUED,
  DEBIT_NOTE_STATUS.SENT_VENDOR,
  DEBIT_NOTE_STATUS.CREATED,
  DEBIT_NOTE_STATUS.SENT
];

/** Statuses Purchase may still act on (review → authorise → issue → vendor → close). */
export const DEBIT_NOTE_PURCHASE_STATUSES = [
  DEBIT_NOTE_STATUS.REQUESTED,
  DEBIT_NOTE_STATUS.PURCHASE_REVIEW,
  DEBIT_NOTE_STATUS.ADMIN_REVIEW,
  DEBIT_NOTE_STATUS.APPROVED,
  DEBIT_NOTE_STATUS.ISSUED,
  DEBIT_NOTE_STATUS.SENT_VENDOR,
  DEBIT_NOTE_STATUS.CREATED,
  DEBIT_NOTE_STATUS.SENT,
  DEBIT_NOTE_STATUS.RECORDED
];

/** Debit Note statuses the Admin must approve before the note can be issued. */
export const DEBIT_NOTE_ADMIN_STATUSES = [DEBIT_NOTE_STATUS.ADMIN_REVIEW];

/** Debit Note statuses that are already issued (issued → sent to vendor → closed,
 *  plus the legacy issued → sent to purchase → recorded path). */
export const DEBIT_NOTE_ISSUED_STATUSES = [
  DEBIT_NOTE_STATUS.ISSUED,
  DEBIT_NOTE_STATUS.SENT_VENDOR,
  DEBIT_NOTE_STATUS.CLOSED,
  DEBIT_NOTE_STATUS.CREATED,
  DEBIT_NOTE_STATUS.SENT,
  DEBIT_NOTE_STATUS.RECORDED
];



/* ------------------------------ low level helpers ------------------------------ */

const getList = (key) => readLS(key, []);
const saveList = (key, list) => writeLS(key, list);

const currentUser = () => {
  const info = getCurrentUserInfo();
  return {
    name: info.employee?.name || info.auth?.username || 'User',
    empId: info.employee?.employeeId || '-',
    dept: info.employee?.department || '-',
    role: info.employee?.role || info.employee?.designation || '-'
  };
};

const requirePerm = (perm, message) => {
  if (!hasPermission(perm)) throw new Error(message || `Permission denied: ${perm}`);
};

const isAdminUser = () => hasPermission('*');

const inDept = (deptName) => isAdminUser() || getCurrentDepartment() === deptName;

const isStore = () => inDept('Store Department');
const isPurchase = () => inDept('Purchase Department');
const isProduction = () => inDept('Production Department');

const deny = (msg) => {
  throw new Error(msg);
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const sameMaterialLine = (a = {}, b = {}) =>
  (a.materialCode && b.materialCode && String(a.materialCode).toLowerCase() === String(b.materialCode).toLowerCase()) ||
  (!a.materialCode && !b.materialCode && String(a.materialName || '').toLowerCase() === String(b.materialName || '').toLowerCase());

const findMatchingReceiptLine = (rows = [], line = {}) => {
  if (line.internalBatchId) {
    const exact = rows.find((candidate) => String(candidate.internalBatchId || '') === String(line.internalBatchId));
    if (exact) return exact;
  }
  const batchNumber = String(line.batchNumber || '').trim().toLowerCase();
  const lotNumber = String(line.lotNumber || '').trim().toLowerCase();
  if (batchNumber || lotNumber) {
    const exact = rows.find((candidate) => sameMaterialLine(candidate, line) &&
      (!batchNumber || String(candidate.batchNumber || '').trim().toLowerCase() === batchNumber) &&
      (!lotNumber || String(candidate.lotNumber || '').trim().toLowerCase() === lotNumber));
    if (exact) return exact;
  }
  return rows.find((candidate) => sameMaterialLine(candidate, line)) || null;
};

const generateInternalReceiptBatchId = () => {
  const id = generateSequentialNumber({ prefix: 'IRB', sequenceKey: 'internalReceiptBatchSequence', historyKey: 'inventoryBatches', idField: 'internalBatchId' });
  saveSequenceCounter('internalReceiptBatchSequence', id);
  return id;
};

const log = (action, reference, details = '') => appendAuditLog({ action, reference, details });

const notify = (title, message, reference, targetDept, type = 'info', link = '') =>
  pushNotification({ title, message, reference, targetDept, type, link });

const historyEntry = (action, details = '') => ({ ...currentUser(), action, details, at: nowDateTimeStr() });

export const ensureWorkflowSeeded = () => {
  [WF.checks, WF.indents, WF.receipts, WF.arrivals, WF.qcs, WF.rejections, WF.debitNotes].forEach((k) => {
    if (!localStorage.getItem(k)) localStorage.setItem(k, '[]');
  });
};

/* ------------------------------ legacy migration ------------------------------ */

/**
 * Backfill the fields introduced by the procurement workflow on records that were
 * created before those fields existed. Existing data is never deleted — only
 * completed with safe defaults, so historical localStorage keeps working.
 */
export const migrateWorkflowRecords = () => {
  // ---- indents ----
  const indents = getIndents().map((i) => ({
    ...i,
    projectId: i.projectId || resolveProjectId({ soNumber: i.soNumber }),
    customer: i.customer || '',
    additionalRequirements: i.additionalRequirements || [],
    clarifications: i.clarifications || [],
    history: i.history || [],
    items: (i.items || []).map((it) => ({
      ...it,
      requiredQty: num(it.requiredQty ?? it.orderedQty ?? it.purchaseQty),
      shortageQty: num(it.shortageQty ?? it.purchaseQty),
      purchaseQty: num(it.purchaseQty ?? it.shortageQty),
      availableQty: num(it.availableQty)
    }))
  }));
  if (JSON.stringify(indents) !== JSON.stringify(getIndents())) saveList(WF.indents, indents);

  // ---- receipts ----
  const receipts = getReceipts().map((r) => ({
    ...r,
    projectId: r.projectId || resolveProjectId({ poNumber: r.poNumber, soNumber: r.soNumber, indentNumber: r.indentNumber }),
    status: r.status || 'Received / Awaiting Quality Check',
    qcStatus: r.qcStatus || QC_STATUS.PENDING,
    postedToInventory: Boolean(r.postedToInventory),
    inventoryPosted: Boolean(r.inventoryPosted ?? r.postedToInventory),
    documents: r.documents || [],
    items: (r.items || []).map((it) => ({
      ...it,
      acceptedQty: num(it.acceptedQty),
      rejectedQty: num(it.rejectedQty),
      batchNumber: it.batchNumber || '',
      lotNumber: it.lotNumber || ''
    }))
  }));
  if (JSON.stringify(receipts) !== JSON.stringify(getReceipts())) saveList(WF.receipts, receipts);

  // ---- material arrivals ----
  // New table, so this is purely additive: a PO that already has Material
  // Receipts simply keeps them and reports zero arrivals until the new Store
  // action is used. No historical receipt is converted or removed.
  const arrivals = getArrivals().map((a) => ({
    ...a,
    arrivalDate: a.arrivalDate || a.createdAt || '',
    arrivalType: a.arrivalType || ARRIVAL_TYPE.ORIGINAL,
    status: a.status || ARRIVAL_STATUS.PENDING_QC,
    qcNumber: a.qcNumber || '',
    qcStatus: a.qcStatus || QC_STATUS.PENDING,
    replacementForRejection: a.replacementForRejection || '',
    replacementArrivalNumber: a.replacementArrivalNumber || '',
    postedToInventory: Boolean(a.postedToInventory),
    inventoryPosted: Boolean(a.inventoryPosted ?? a.postedToInventory),
    documents: a.documents || [],
    history: a.history || [],
    items: (a.items || []).map((it) => ({
      ...it,
      arrivalQty: num(it.arrivalQty ?? it.receivedQty),
      unit: it.unit || 'Nos',
      batchNumber: it.batchNumber || '',
      lotNumber: it.lotNumber || '',
      remarks: it.remarks || ''
    }))
  }));
  if (JSON.stringify(arrivals) !== JSON.stringify(getArrivals())) saveList(WF.arrivals, arrivals);

  // ---- quality checks ----
  const qcs = getQualityChecks().map((q) => ({
    ...q,
    projectId: q.projectId || resolveProjectId({ poNumber: q.poNumber, soNumber: q.soNumber, indentNumber: q.indentNumber }),
    postedToInventory: Boolean(q.postedToInventory),
    inventoryPostedQty: num(q.inventoryPostedQty),
    status: q.status || QC_STATUS.PENDING,
    // Inspections raised from a Material Arrival keep the link so the arrival,
    // the inspection and the Rejection Report stay one traceable chain.
    arrivalNumber: q.arrivalNumber || '',
    arrivalType: q.arrivalType || ARRIVAL_TYPE.ORIGINAL,
    inspectionType: q.inspectionType || (q.arrivalNumber ? 'Arrival Inspection' : q.receiptNumber ? 'Material Receipt Inspection' : 'Indent Inspection'),
    arrivalDate: q.arrivalDate || '',
    history: q.history || [],
    items: (q.items || []).map((it) => ({
      ...it,
      receivedQty: num(it.receivedQty),
      acceptedQty: num(it.acceptedQty),
      rejectedQty: num(it.rejectedQty),
      batchNumber: it.batchNumber || '',
      lotNumber: it.lotNumber || ''
    }))
  }));
  if (JSON.stringify(qcs) !== JSON.stringify(getQualityChecks())) saveList(WF.qcs, qcs);

  // ---- rejection reports ----
  const rejections = getRejectionReports().map((r) => {
    const items = (r.items || []).map((it) => {
      const rejectedQty = num(it.rejectedQty);
      const replacementQty = num(it.replacementQty);
      return { ...it, rejectedQty, replacementQty, pendingReplacementQty: Math.max(0, rejectedQty - replacementQty) };
    });
    return {
      ...r,
      projectId: r.projectId || resolveProjectId({ poNumber: r.poNumber, soNumber: r.soNumber, indentNumber: r.indentNumber }),
      arrivalNumber: r.arrivalNumber || '',
      arrivalType: r.arrivalType || ARRIVAL_TYPE.ORIGINAL,
      receiptNumber: r.receiptNumber || '',
      debitNoteNumbers: r.debitNoteNumbers || [],
      debitNoteQty: num(r.debitNoteQty),
      items,
      replacementQty: items.reduce((a, i) => a + i.replacementQty, 0),
      pendingReplacementQty: items.reduce((a, i) => a + i.pendingReplacementQty, 0),
      history: r.history || []
    };
  });
  if (JSON.stringify(rejections) !== JSON.stringify(getRejectionReports())) saveList(WF.rejections, rejections);

  // ---- debit notes ----
  // Safe defaults only — existing Debit Notes keep their stored figures so a
  // previously issued claim can never be silently recalculated.
  const debitNotes = getDebitNotes().map((d) => ({
    ...d,
    projectId: d.projectId || resolveProjectId({ soNumber: d.soNumber, indentNumber: d.indentNumber, poNumber: d.poNumber }),
    status: d.status || DEBIT_NOTE_STATUS.DRAFT,
    // A Debit Note is now anchored on the Material Arrival that physically
    // brought the rejected material in, so a receipt/invoice is no longer a
    // prerequisite. Existing notes keep their stored receipt reference.
    arrivalNumber: d.arrivalNumber || '',
    arrivalDate: d.arrivalDate || '',
    sentToPurchaseAt: d.sentToPurchaseAt || '',
    sentToPurchaseBy: d.sentToPurchaseBy || '',
    recordedAt: d.recordedAt || '',
    recordedBy: d.recordedBy || '',
    purchaseRemarks: d.purchaseRemarks || '',
    vendorCreditReference: d.vendorCreditReference || '',
    documents: d.documents || [],
    remarks: d.remarks || '',
    history: d.history || [],
    items: (d.items || []).map((it) => ({
      ...it,
      rejectedQty: num(it.rejectedQty),
      debitQty: num(it.debitQty),
      unitPrice: num(it.unitPrice),
      gstPercent: num(it.gstPercent),
      amount: num(it.amount),
      gstAmount: num(it.gstAmount)
    }))
  }));
  if (JSON.stringify(debitNotes) !== JSON.stringify(getDebitNotes())) saveList(WF.debitNotes, debitNotes);

  // ---- purchase orders ----
  reconcilePOStatuses();

  // ---- vendor quotations (safe defaults + legacy status normalisation) ----
  // Nothing is deleted; existing quotations only gain the fields the PO
  // conversion relies on, and the legacy 'Ordered' status is recognised as
  // 'PO Created' so an old quotation can never raise a second PO.
  const quotations = readVendorQuotations().map((q) => {
    const items = (Array.isArray(q.items) ? q.items : []).map((it) => {
      const quotedQty = num(it.quotedQty ?? it.requiredQty);
      const unitPrice = num(it.unitPrice);
      const taxPct = num(it.taxPct ?? it.tax);
      const totalPrice = num(it.totalPrice) || quotedQty * unitPrice;
      return {
        ...it,
        description: it.description || '',
        hsnSac: it.hsnSac || '',
        unit: it.unit || 'Nos',
        quotedQty,
        requiredQty: num(it.requiredQty),
        unitPrice,
        taxPct,
        taxAmount: num(it.taxAmount) || (totalPrice * taxPct) / 100,
        discount: num(it.discount),
        totalPrice
      };
    });
    const subtotal = items.reduce((a, it) => a + it.quotedQty * it.unitPrice, 0);
    const taxAmount = items.reduce((a, it) => a + it.taxAmount, 0);
    const poNumber = q.poNumber || q.purchaseOrderNumber || '';
    return {
      ...q,
      projectId: q.projectId || '',
      soNumber: q.soNumber || '',
      indentNumber: q.indentNumber || '',
      quotationDate: q.quotationDate || q.createdAt || '',
      deliveryDate: q.deliveryDate || '',
      paymentTerms: q.paymentTerms || '',
      otherTerms: q.otherTerms || '',
      acceptedBy: q.acceptedBy || '',
      acceptedDate: q.acceptedDate || '',
      acceptedTime: q.acceptedTime || '',
      items,
      subtotal: num(q.subtotal) || num(q.totalAmount) || subtotal,
      totalAmount: num(q.totalAmount) || subtotal,
      taxAmount,
      totalWithTax: num(q.totalWithTax) || num(q.totalAmount || subtotal) + taxAmount,
      status: poNumber ? QUOTATION_STATUS.PO_CREATED : q.status || QUOTATION_STATUS.RECEIVED,
      poNumber,
      purchaseOrderNumber: q.purchaseOrderNumber || poNumber
    };
  });
  if (JSON.stringify(quotations) !== JSON.stringify(readVendorQuotations())) saveList('vendorQuotations', quotations);

  return true;
};

/* ------------------------------ document lookups ------------------------------ */

export const getSalesOrders = () => readLS(SO_HISTORY, []);
export const getSalesOrderByRef = (ref) =>
  getSalesOrders().find((s) => String(s.reference) === String(ref)) || null;

export const getPurchaseOrders = () => readLS(PO_HISTORY, []);
export const getPOByRef = (ref) =>
  getPurchaseOrders().find((p) => String(p.reference) === String(ref)) || null;

const writePO = (poNumber, patch) => {
  const list = getPurchaseOrders();
  const idx = list.findIndex((p) => String(p.reference) === String(poNumber));
  if (idx === -1) return null;
  const next = { ...list[idx], ...patch };
  list[idx] = next;
  saveList(PO_HISTORY, list);
  return next;
};

const setPOStatus = (poNumber, status, extra = {}) => {
  const po = getPOByRef(poNumber);
  if (!po) return null;
  return writePO(poNumber, {
    status,
    payload: { ...po.payload, poDetails: { ...po.payload?.poDetails, poStatus: status } },
    ...extra
  });
};

/* --------------------------- project id resolution --------------------------- */

/**
 * Project ID is mandatory for traceability. It is always derived from the source
 * document (Sales Order → Indent → PO), never typed again by the user.
 */
export const resolveProjectId = ({ soNumber = '', indentNumber = '', poNumber = '' } = {}) => {
  if (indentNumber) {
    const ind = getIndent(indentNumber);
    if (ind?.projectId) return ind.projectId;
    if (ind?.soNumber) soNumber = ind.soNumber;
  }
  if (poNumber) {
    const po = getPOByRef(poNumber);
    const details = po?.payload?.poDetails || {};
    const fromPo = details.projectId || details.projectRef;
    if (fromPo && fromPo !== '-') return fromPo;
    if (!soNumber && details.salesOrderRef) soNumber = details.salesOrderRef;
    if (!indentNumber && details.indentRef) indentNumber = details.indentRef;
  }
  if (soNumber) {
    const so = getSalesOrderByRef(soNumber);
    const fromSo = so?.payload?.soDetails?.projectId;
    if (fromSo) return fromSo;
  }
  return '';
};

const getPOProjectId = (po) =>
  resolveProjectId({
    soNumber: po?.payload?.poDetails?.salesOrderRef || '',
    indentNumber: po?.payload?.poDetails?.indentRef || '',
    poNumber: po?.reference || ''
  });

/* ------------------------- 1 & 2. Sales Order → Store ------------------------- */

export const buildAvailabilityLines = (soRecord) => {
  const inv = getInventoryItems();
  const items = soRecord?.payload?.items || [];
  return items.map((it, idx) => {
    const code = String(it.itemCode || '').trim();
    const name = String(it.itemName || '').trim();
    const match = inv.find(
      (i) =>
        (code && String(i.itemCode || '').toLowerCase() === code.toLowerCase()) ||
        (name && i.itemName && String(i.itemName).toLowerCase() === name.toLowerCase())
    );
    const availableStock = match ? num(match.currentQty) : 0;
    const orderedQty = num(it.quantity);
    const requiredQty = orderedQty;
    const availableQty = Math.min(availableStock, requiredQty);
    const shortageQty = Math.max(0, requiredQty - availableStock);
    return {
      lineNo: idx + 1,
      materialCode: code || match?.itemCode || '',
      materialName: name || '-',
      drawingNo: it.drawingNo || '',
      hsnSac: it.hsnSac || '',
      unit: it.unit || match?.unit || 'Nos',
      orderedQty,
      availableStock,
      requiredQty,
      availableQty,
      shortageQty,
      purchaseQty: shortageQty,
      status: shortageQty > 0 ? 'Purchase Required' : 'Available',
      inventoryMatched: Boolean(match)
    };
  });
};

export const getAvailabilityCheck = (soNumber) =>
  getList(WF.checks).find((c) => String(c.soNumber) === String(soNumber)) || null;

/** Live (unsaved) availability view used by the Store review screen. */
export const previewAvailability = (soNumber) => {
  const so = getSalesOrderByRef(soNumber);
  if (!so) deny(`Sales Order ${soNumber} not found.`);
  const saved = getAvailabilityCheck(soNumber);
  return {
    soNumber,
    lines: buildAvailabilityLines(so),
    checked: Boolean(saved),
    savedRecord: saved
  };
};

export const saveMaterialAvailabilityCheck = ({ soNumber, remarks = '' }) => {
  requirePerm('indent.view', 'Permission denied: material availability check is restricted.');
  if (!isStore()) deny('Only the Store Department can perform the material availability check.');
  const so = getSalesOrderByRef(soNumber);
  if (!so) deny(`Sales Order ${soNumber} not found.`);

  const lines = buildAvailabilityLines(so);
  if (lines.length === 0) deny('Sales Order has no material lines.');

  const list = getList(WF.checks);
  const idx = list.findIndex((c) => String(c.soNumber) === String(soNumber));
  const user = currentUser();
  const prev = idx >= 0 ? list[idx] : null;
  const record = {
    soNumber,
    projectId: so.payload?.soDetails?.projectId || '',
    customer: so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName || so.company || '',
    orderDate: so.payload?.soDetails?.soDate || so.date || '',
    deliveryDate: so.payload?.soDetails?.deliveryDate || '',
    status: 'Checked',
    lines,
    remarks,
    checkedBy: user.name,
    checkedByEmpId: user.empId,
    checkedByDept: user.dept,
    checkedAt: nowDateTimeStr(),
    checkedDate: todayStr(),
    productionNotified: prev?.productionNotified || false,
    history: [...(prev?.history || []), historyEntry('Availability check saved', `${lines.filter((l) => l.shortageQty > 0).length} material(s) with shortage`)]
  };

  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  saveList(WF.checks, list);

  log('MATERIAL AVAILABILITY CHECK', soNumber, `${lines.length} material(s); ${lines.filter((l) => l.shortageQty > 0).length} require purchase.`);

  maybeNotifyProductionReady(soNumber);
  return record;
};

export const getAvailabilityChecks = () => getList(WF.checks);

/** Sales Orders that still need a store material availability check. */
export const getSalesOrdersAwaitingCheck = () => {
  const checked = new Set(getAvailabilityChecks().map((c) => String(c.soNumber)));
  return getSalesOrders().filter(
    (so) => !checked.has(String(so.reference)) && !['Dispatched', 'Closed'].includes(so.status)
  );
};

/* ----------------------------- 3 & 4. Purchase Indent ----------------------------- */

export const getIndents = () => getList(WF.indents);
export const getIndent = (indentNumber) =>
  getIndents().find((i) => String(i.indentNumber) === String(indentNumber)) || null;

export const getIndentForSO = (soNumber) =>
  getIndents().filter((i) => String(i.soNumber) === String(soNumber));

export const canEditIndent = (indent) => {
  if (!indent) return false;
  if (isAdminUser()) return true;
  if ([INDENT_STATUS.CONVERTED, INDENT_STATUS.CANCELLED].includes(indent.status)) return false;
  const dept = getCurrentDepartment();
  if (dept === 'Store Department') return hasPermission('indent.edit') && indent.status === INDENT_STATUS.DRAFT;
  if (dept === 'Purchase Department')
    return (
      hasPermission('indent.review') &&
      [INDENT_STATUS.SUBMITTED, INDENT_STATUS.AWAITING_PRODUCTION, INDENT_STATUS.UNDER_REVIEW].includes(indent.status)
    );
  return false;
};

export const canSubmitIndent = (indent) =>
  Boolean(indent) &&
  indent.status === INDENT_STATUS.DRAFT &&
  (isAdminUser() || (hasPermission('indent.submit') && getCurrentDepartment() === 'Store Department'));

export const createPurchaseIndent = ({
  soNumber = '',
  reason = '',
  remarks = '',
  requiredDate = '',
  selectedCodes = null,
  lines = null,
  sourceInfo = null
}) => {
  requirePerm('indent.create', 'Permission denied: only the Store Department can create a Purchase Indent.');
  if (!isStore()) deny('Only the Store Department can create a Purchase Indent.');

  /* Two sources of shortage lines are supported:
     1. Sales Order material availability check (default, unchanged behaviour).
     2. An explicit line list with pre-computed shortage (used by the
        Production Requirement workflow via sourceInfo). */
  const fromRequirement = Array.isArray(lines);
  const so = !fromRequirement || soNumber ? getSalesOrderByRef(soNumber) : null;
  if (!fromRequirement && !so) deny(`Sales Order ${soNumber} not found.`);

  let shortageLines;
  if (fromRequirement) {
    shortageLines = lines.filter((l) => num(l.purchaseQty ?? l.shortageQty) > 0);
    if (shortageLines.length === 0) deny('No lines with quantity to indent.');
  } else {
    let check = getAvailabilityCheck(soNumber);
    if (!check) check = saveMaterialAvailabilityCheck({ soNumber, remarks: 'Auto-saved while creating indent.' });

    shortageLines = check.lines.filter(
      (l) => num(l.shortageQty) > 0 && (!selectedCodes || selectedCodes.length === 0 || selectedCodes.includes(l.materialCode || l.materialName))
    );
    if (shortageLines.length === 0) deny('No materials with shortage — nothing to indent. All materials are available.');
  }

  const indentNumber = generateSequentialNumber({
    prefix: 'IND',
    sequenceKey: WF.indentSeq,
    historyKey: WF.indents,
    idField: 'indentNumber'
  });
  const user = currentUser();
  const reqReason = `Shortage from Production Requirement ${sourceInfo?.requirementNumber || ''}`;

  const indent = {
    indentNumber,
    indentDate: todayStr(),
    soNumber,
    projectId: (fromRequirement ? sourceInfo?.projectId : so?.payload?.soDetails?.projectId) || '',
    customer: fromRequirement
      ? sourceInfo?.customer || ''
      : so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName || so.company || '',
    deliveryDate: so?.payload?.soDetails?.deliveryDate || '',
    requiredDate: requiredDate || so?.payload?.soDetails?.deliveryDate || '',
    reason: reason || (fromRequirement ? reqReason : 'Shortage against Sales Order material requirement'),
    ...(fromRequirement
      ? {
          sourceType: sourceInfo?.sourceType || 'productionRequirement',
          requirementNumber: sourceInfo?.requirementNumber || '',
          productionJob: sourceInfo?.productionJob || ''
        }
      : {}),
    storeRemarks: remarks,
    purchaseRemarks: '',
    status: INDENT_STATUS.DRAFT,
    items: shortageLines.map((l) => ({
      materialCode: l.materialCode || '',
      materialName: l.materialName,
      drawingNo: l.drawingNo || '',
      description: l.description || '',
      specification: l.specification || '',
      unit: l.unit || 'Nos',
      requiredQty: num(l.requiredQty || l.orderedQty),
      orderedQty: num(l.orderedQty),
      availableQty: num(l.availableStock ?? l.availableQty),
      shortageQty: num(l.shortageQty),
      purchaseQty: num(l.purchaseQty ?? l.shortageQty),
      requiredDate: fromRequirement
        ? requiredDate || l.requiredDate || ''
        : requiredDate || so.payload?.soDetails?.deliveryDate || '',
      reason: reason || (fromRequirement ? reqReason : 'Shortage against Sales Order'),
      remarks: '',
      source: fromRequirement ? sourceInfo?.source || 'Production Requirement Shortage' : 'Sales Order Shortage'
    })),
    additionalRequirements: [],
    clarifications: [],
    createdBy: user.name,
    createdByEmpId: user.empId,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    updatedAt: nowDateTimeStr(),
    submittedAt: '',
    poNumber: '',
    convertedAt: '',
    history: [historyEntry('Indent created', `${shortageLines.length} material(s) with shortage`)]
  };

  saveList(WF.indents, [indent, ...getIndents()]);
  saveSequenceCounter(WF.indentSeq, indentNumber);
  log(
    'PURCHASE INDENT CREATED',
    indentNumber,
    fromRequirement
      ? `Requirement ${sourceInfo?.requirementNumber || ''} | ${shortageLines.length} material(s)`
      : `SO ${soNumber} | ${shortageLines.length} material(s)`
  );

  notify(
    'New Purchase Indent',
    `Purchase Indent ${indentNumber} is ready for vendor enquiry.`,
    indentNumber,
    'Purchase Department',
    'info'
  );

  return indent;
};

const updateIndentHistory = (indent, action, details) => {
  indent.history = [...(indent.history || []), historyEntry(action, details)];
  indent.updatedAt = nowDateTimeStr();
  return indent;
};

const summarizeChanges = (before, patch) => {
  const changes = [];
  ['reason', 'storeRemarks', 'purchaseRemarks', 'requiredDate'].forEach((f) => {
    if (patch[f] !== undefined && String(patch[f]) !== String(before[f] || '')) {
      changes.push(`${f}: "${before[f] || ''}" → "${patch[f] || ''}"`);
    }
  });
  if (Array.isArray(patch.items) && patch.items.length !== (before.items || []).length) {
    changes.push(`items: ${before.items?.length || 0} → ${patch.items.length}`);
  }
  return changes.join('; ');
};

export const updatePurchaseIndent = (indentNumber, patch = {}) => {
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (!canEditIndent(indent))
    deny(
      `Permission denied: your department cannot edit Purchase Indent ${indentNumber} in status "${indent.status}".`
    );

  const changes = summarizeChanges(indent, patch);
  const before = JSON.parse(JSON.stringify(indent));

  if (Array.isArray(patch.items)) {
    patch.items.forEach((it) => {
      if (!String(it.materialName || '').trim()) deny('Every indent line needs a material name.');
      if (num(it.purchaseQty) <= 0) deny(`Indent quantity must be greater than zero for "${it.materialName}".`);
    });
    if (patch.items.length === 0) deny('A Purchase Indent must contain at least one material.');
    indent.items = patch.items.map((it) => ({ ...it, purchaseQty: num(it.purchaseQty) }));
  }
  if (patch.reason !== undefined) indent.reason = patch.reason;
  if (patch.storeRemarks !== undefined && isStore()) indent.storeRemarks = patch.storeRemarks;
  if (patch.purchaseRemarks !== undefined && isPurchase()) indent.purchaseRemarks = patch.purchaseRemarks;
  if (patch.requiredDate !== undefined) indent.requiredDate = patch.requiredDate;

  updateIndentHistory(indent, 'Indent edited', changes || 'details updated');
  const list = getIndents();
  const idx = list.findIndex((i) => String(i.indentNumber) === String(indentNumber));
  list[idx] = indent;
  saveList(WF.indents, list);
  log('PURCHASE INDENT EDITED', indentNumber, changes || 'details updated');
  void before;
  return indent;
};

export const submitPurchaseIndent = (indentNumber, remarks = '') => {
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (!canSubmitIndent(indent)) deny('Permission denied: only Store can submit a Draft Purchase Indent.');

  indent.status = INDENT_STATUS.SUBMITTED;
  indent.submittedAt = nowDateTimeStr();
  if (remarks) indent.storeRemarks = indent.storeRemarks ? `${indent.storeRemarks}\n${remarks}` : remarks;
  updateIndentHistory(indent, 'Indent submitted to Purchase', remarks);

  const list = getIndents();
  const idx = list.findIndex((i) => String(i.indentNumber) === String(indentNumber));
  list[idx] = indent;
  saveList(WF.indents, list);

  log('PURCHASE INDENT SUBMITTED', indentNumber, indent.requirementNumber ? `Requirement ${indent.requirementNumber}` : `SO ${indent.soNumber}`);
  notify(
    'New Purchase Indent',
    `Indent ${indentNumber} submitted by Store for ${
      indent.requirementNumber ? `Production Requirement ${indent.requirementNumber}` : `Sales Order ${indent.soNumber}`
    }. ${indent.items.length} material(s) require procurement.`,
    indentNumber,
    'Purchase Department',
    'store'
  );
  /* Store has shared the indent: the Admin must approve it before Purchase
     starts the vendor enquiry. Admin sees it on the Executive Dashboard. */
  notify(
    'Purchase Indent shared by Store — approval required',
    `Purchase Indent ${indentNumber} shared by Store for ${
      indent.requirementNumber ? `Requirement ${indent.requirementNumber}` : `Sales Order ${indent.soNumber}`
    } — ${indent.items.length} material(s). Review and approve it so Purchase can send vendor enquiries.`,
    indentNumber,
    'Admin',
    'store',
    `/purchase-indents?indent=${indentNumber}`
  );
  return indent;
};

/**
 * Admin sign-off on a Purchase Indent shared by Store.
 * Until this is done Purchase cannot raise the vendor enquiry for the indent.
 */
export const approveIndentByAdmin = (indentNumber, remarks = '') => {
  requirePerm('indent.admin_approve', 'Permission denied: only the Admin can approve a Purchase Indent.');
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent.adminApprovedAt) {
    deny(`Purchase Indent ${indentNumber} was already approved by ${indent.adminApprovedBy}.`);
  }
  if ([INDENT_STATUS.CANCELLED, INDENT_STATUS.CONVERTED, INDENT_STATUS.COMPLETED].includes(indent.status)) {
    deny(`Purchase Indent ${indentNumber} in status "${indent.status}" cannot be approved.`);
  }

  indent.adminApprovedAt = nowDateTimeStr();
  indent.adminApprovedBy = currentUser().name;
  indent.adminApprovedRemarks = remarks;
  updateIndentHistory(indent, 'Indent approved by Admin', remarks);
  saveIndent(indent);

  log('PURCHASE INDENT APPROVED BY ADMIN', indentNumber, remarks);
  notify(
    'Purchase Indent approved by Admin',
    `Purchase Indent ${indentNumber} is approved by ${currentUser().name}. Purchase can now send vendor enquiries for ${
      indent.items.length
    } material(s).`,
    indentNumber,
    'Purchase Department',
    'info',
    `/purchase-indents?indent=${indentNumber}`
  );
  return indent;
};

export const cancelIndent = (indentNumber, reason = '') => {
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent.status === INDENT_STATUS.CONVERTED) deny('Converted indents cannot be cancelled.');
  const allowed =
    isAdminUser() ||
    getCurrentDepartment() === 'Store Department' ||
    getCurrentDepartment() === 'Purchase Department';
  if (!allowed) deny('Permission denied: cannot cancel this Purchase Indent.');

  indent.status = INDENT_STATUS.CANCELLED;
  indent.cancelReason = reason;
  updateIndentHistory(indent, 'Indent cancelled', reason);
  const list = getIndents();
  const idx = list.findIndex((i) => String(i.indentNumber) === String(indentNumber));
  list[idx] = indent;
  saveList(WF.indents, list);
  log('PURCHASE INDENT CANCELLED', indentNumber, reason);
  return indent;
};

const saveIndent = (indent) => {
  const list = getIndents();
  const idx = list.findIndex((i) => String(i.indentNumber) === String(indent.indentNumber));
  if (idx >= 0) list[idx] = indent;
  else list.unshift(indent);
  saveList(WF.indents, list);
  return indent;
};

/* ------------------ 5. Purchase ↔ Production additional requirements ------------------ */

export const requestProductionClarification = (indentNumber, question = '') => {
  requirePerm('indent.review', 'Permission denied: Purchase review required.');
  if (!isPurchase()) deny('Only the Purchase Department can request Production clarification.');
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent.status === INDENT_STATUS.CANCELLED)
    deny(`Indent in status "${indent.status}" cannot be sent for Production clarification.`);

  const clarification = {
    id: `clr-${Date.now()}`,
    question,
    status: 'Awaiting Production',
    askedBy: currentUser().name,
    askedAt: nowDateTimeStr(),
    answeredAt: ''
  };
  indent.clarifications = [...(indent.clarifications || []), clarification];
  // Only live indents move to Awaiting Production — Draft / Converted / Awaiting keep their status.
  if ([INDENT_STATUS.SUBMITTED, INDENT_STATUS.UNDER_REVIEW].includes(indent.status))
    indent.status = INDENT_STATUS.AWAITING_PRODUCTION;
  updateIndentHistory(indent, 'Production clarification requested', question);
  saveIndent(indent);

  log('PRODUCTION CLARIFICATION REQUESTED', indentNumber, question);
  notify(
    'Clarification Required for Purchase Indent',
    `Purchase needs Production confirmation for Indent ${indentNumber} (Sales Order ${indent.soNumber}): ${question}`,
    indentNumber,
    'Production Department',
    'info'
  );
  return indent;
};

export const provideAdditionalRequirement = (indentNumber, { materialCode = '', materialName, quantity, unit = 'Nos', reason = '', remarks = '' }) => {
  requirePerm('indent.additional', 'Permission denied: only Production can provide additional material requirements.');
  if (!isProduction()) deny('Only the Production/Quality Department can provide additional material requirements.');
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (!String(materialName || '').trim()) deny('Additional material name is required.');
  if (num(quantity) <= 0) deny('Additional quantity must be greater than zero.');

  const user = currentUser();
  const req = {
    id: `areq-${Date.now()}`,
    materialCode: materialCode || '',
    materialName,
    quantity: num(quantity),
    unit,
    reason,
    remarks,
    status: 'Provided',
    requestedBy: user.name,
    requestedByEmpId: user.empId,
    requestedByDept: user.dept,
    requestedAt: nowDateTimeStr()
  };
  indent.additionalRequirements = [...(indent.additionalRequirements || []), req];
  const openClrs = (indent.clarifications || []).filter((c) => c.status === 'Awaiting Production');
  openClrs.forEach((c) => {
    c.status = 'Answered';
    c.answeredAt = nowDateTimeStr();
  });
  if (indent.status === INDENT_STATUS.AWAITING_PRODUCTION) indent.status = INDENT_STATUS.SUBMITTED;
  updateIndentHistory(indent, 'Additional material requirement provided', `${materialName} × ${quantity} ${unit} — ${reason}`);
  saveIndent(indent);

  log('ADDITIONAL MATERIAL REQUIREMENT', indentNumber, `${materialName} × ${quantity} ${unit}`);
  notify(
    'Additional Material Requirement',
    `Production requires additional material for Indent ${indentNumber}: ${materialName} × ${quantity} ${unit}. ${reason}`,
    indentNumber,
    'Purchase Department',
    'info'
  );
  return indent;
};

export const reviewAdditionalRequirement = (indentNumber, reqId, action, remarks = '') => {
  requirePerm('indent.review', 'Permission denied: Purchase review required.');
  if (!isPurchase()) deny('Only the Purchase Department can review additional requirements.');
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  const req = (indent.additionalRequirements || []).find((r) => r.id === reqId);
  if (!req) deny('Additional requirement not found.');

  req.status = action === 'approve' ? 'Approved' : 'Rejected';
  req.reviewedBy = currentUser().name;
  req.reviewedAt = nowDateTimeStr();
  req.reviewRemarks = remarks;

  if (action === 'approve') {
    indent.items = [
      ...(indent.items || []),
      {
        materialCode: req.materialCode || '',
        materialName: req.materialName,
        drawingNo: '',
        unit: req.unit || 'Nos',
        orderedQty: 0,
        availableQty: 0,
        purchaseQty: req.quantity,
        requiredDate: indent.requiredDate || '',
        reason: req.reason || 'Production additional requirement',
        remarks: req.remarks || '',
        source: 'Production Additional Requirement',
        additionalRequirementId: req.id
      }
    ];
    if (indent.status === INDENT_STATUS.AWAITING_PRODUCTION) indent.status = INDENT_STATUS.SUBMITTED;
  }
  updateIndentHistory(indent, `Additional requirement ${req.status.toLowerCase()}`, `${req.materialName} — ${remarks}`);
  saveIndent(indent);

  log('ADDITIONAL REQUIREMENT REVIEWED', indentNumber, `${req.materialName}: ${req.status}`);
  notify(
    `Indent ${indentNumber} — Additional Requirement ${req.status}`,
    `Purchase ${req.status.toLowerCase()} additional material "${req.materialName}" (${req.quantity} ${req.unit}) for Indent ${indentNumber}.`,
    indentNumber,
    'Production Department',
    action === 'approve' ? 'store' : 'info'
  );
  return indent;
};

/* ------------------------ 6 & 7. Indent → Purchase Order ------------------------ */

export const markIndentConverted = (indentNumber, poNumber) => {
  requirePerm('indent.convert', 'Permission denied: only Purchase can convert an indent into a Purchase Order.');
  if (!isPurchase()) deny('Only the Purchase Department can convert a Purchase Indent into a Purchase Order.');
  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent.status === INDENT_STATUS.CANCELLED) deny('Cancelled indents cannot be converted.');
  if (indent.status === INDENT_STATUS.CONVERTED)
    deny(`Purchase Indent ${indentNumber} is already converted to PO ${indent.poNumber}.`);

  indent.status = INDENT_STATUS.CONVERTED;
  indent.poNumber = poNumber;
  indent.convertedAt = nowDateTimeStr();
  updateIndentHistory(indent, 'Converted to Purchase Order', `PO ${poNumber}`);
  saveIndent(indent);

  log('INDENT CONVERTED TO PO', indentNumber, `PO ${poNumber}`);
  const po = getPOByRef(poNumber);
  const projectId = po?.payload?.poDetails?.projectId || po?.payload?.poDetails?.projectRef || indent.projectId || '';
  notify(
    'Purchase Order created',
    `Purchase Order ${poNumber} has been created for Project ${projectId || '—'}${indent.soNumber ? ` / Sales Order ${indent.soNumber}` : ''}.\nVendor: ${po?.vendor || '—'}\nThe ordered materials will appear in Store for receipt when delivered.`,
    poNumber,
    'Store Department',
    'store'
  );
  notify(
    'Purchase Order created',
    `PO ${poNumber} created from Purchase Indent ${indentNumber} for Project ${projectId || '—'}.`,
    poNumber,
    'Purchase Department',
    'info'
  );
  return indent;
};

/** Materials (with quantities) an indent authorises Purchase to buy. */
export const getIndentPurchaseAuthority = (indentNumber) => {
  const indent = getIndent(indentNumber);
  if (!indent) return null;
  const map = {};
  (indent.items || []).forEach((it) => {
    const key = String(it.materialCode || it.materialName || '').toLowerCase();
    if (!key) return;
    map[key] = (map[key] || 0) + num(it.purchaseQty);
  });
  return map;
};

/* -------------------- 5 & 6 & 7. Indent → Vendor Enquiry → Quotation → PO -------------------- */

const readVendorEnquiries = () => readLS('vendorEnquiries', []);
const readVendorQuotations = () => readLS('vendorQuotations', []);

/** Vendor Enquiries raised against a Purchase Indent. */
export const getVendorEnquiriesForIndent = (indentNumber) =>
  readVendorEnquiries().filter((e) => String(e.indentNumber || '') === String(indentNumber || ''));

/** Vendor Quotations received against a Vendor Enquiry. */
export const getVendorQuotationsForEnquiry = (enquiryNumber) =>
  readVendorQuotations().filter((q) => String(q.enquiryNumber || '') === String(enquiryNumber || ''));

/** Every Vendor Enquiry / Quotation that belongs to a Purchase Indent. */
export const getProcurementChainForIndent = (indentNumber) => {
  const enquiries = getVendorEnquiriesForIndent(indentNumber);
  const quotations = enquiries.flatMap((e) => getVendorQuotationsForEnquiry(e.enquiryNumber));
  return { enquiries, quotations };
};

/** The Purchase Order already generated from a quotation, if any. */
export const getPOForQuotation = (quotationNumber) => {
  const ref = String(quotationNumber || '');
  if (!ref) return null;
  const list = readLS(PO_HISTORY, []);
  return (
    list.find(
      (po) =>
        String(po?.payload?.poDetails?.quotationRef || '') === ref ||
        String(po?.quotationRef || '') === ref
    ) || null
  );
};

/** True when this quotation has already produced a Purchase Order. */
export const quotationAlreadyConverted = (quotation) => {
  if (!quotation) return false;
  if (QUOTATION_PO_CREATED_STATUSES.includes(String(quotation.status))) return true;
  if (String(quotation.poNumber || quotation.purchaseOrderNumber || '').trim()) return true;
  return Boolean(getPOForQuotation(quotation.quotationNumber));
};

/** Quotation is accepted and has not yet produced a PO → it may be converted. */
export const canCreatePOFromQuotation = (quotationNumber) => {
  const q = getVendorQuotationByNumber(quotationNumber);
  if (!q) return { allowed: false, reason: `Vendor Quotation ${quotationNumber} not found.`, quotation: null };
  if (!QUOTATION_ACCEPTED_STATUSES.includes(String(q.status))) {
    return {
      allowed: false,
      reason: `Vendor Quotation ${q.quotationNumber} is "${q.status || 'unknown'}" — accept it before creating a Purchase Order.`,
      quotation: q
    };
  }
  if (quotationAlreadyConverted(q)) {
    return {
      allowed: false,
      reason: `Vendor Quotation ${q.quotationNumber} already generated Purchase Order ${q.poNumber || q.purchaseOrderNumber || ''}.`,
      quotation: q
    };
  }
  return { allowed: true, reason: '', quotation: q };
};

/**
 * Accept a Vendor Quotation (validation + Accepted By / Date / Time) so the
 * Purchase Order action unlocks. Thin wrapper over the store service.
 */
export const acceptQuotation = (quotationNumber, acceptedBy) =>
  acceptVendorQuotation(quotationNumber, { acceptedBy });

/**
 * Build a full Purchase Order draft from an ACCEPTED Vendor Quotation.
 *
 * The accepted quotation is the COMMERCIAL SOURCE: vendor, every item, quantity,
 * unit, unit price, discount, tax, totals, delivery and payment terms are copied
 * verbatim. Material master price, previous PO price, average purchase price and
 * inventory price are deliberately ignored so the PO can never drift from the
 * price the vendor actually quoted and the Purchase approved.
 *
 * Pure function — nothing is written. Used both to pre-fill the Purchase Order
 * form and by `createPurchaseOrderFromQuotation` for the actual save, so there is
 * exactly one mapping in the system.
 */
export const buildPOFromQuotation = (quotationNumber, overrides = {}) => {
  const q = getVendorQuotationByNumber(quotationNumber);
  if (!q) deny(`Vendor Quotation ${quotationNumber} not found.`);

  /* source documents must exist and agree with each other */
  const enquiry = String(q.enquiryNumber || '').trim()
    ? readVendorEnquiries().find((e) => String(e.enquiryNumber) === String(q.enquiryNumber)) || null
    : null;
  if (!enquiry) deny(`Vendor Enquiry ${q.enquiryNumber || '-'} not found for quotation ${q.quotationNumber}.`);

  const indentNumber = q.indentNumber || enquiry.indentNumber || '';
  const indent = indentNumber ? getIndent(indentNumber) : null;
  const soNumber = q.soNumber || enquiry.soNumber || (indent ? indent.soNumber : '');
  /* Project ID is inherited, never asked for (falls back through the chain). */
  const projectId =
    q.projectId || enquiry.projectId || (indent ? indent.projectId : '') || resolveProjectId({ soNumber, indentNumber });

  /* vendor details come from the quotation and are enriched from Vendor Master */
  const master = getVendorByName(q.vendorName) || null;
  const vendorDetails = {
    vendorId: master?.seq || q.vendorId || '',
    vendorName: q.vendorName || master?.name || '',
    companyName: q.vendorName || master?.name || '',
    vendorCode: master?.seq ? `V-${String(master.seq).padStart(3, '0')}` : '',
    address: master?.address || q.vendorAddress || '',
    contactPerson: q.vendorContact || '',
    contactNumber: master?.phone || q.vendorPhone || '',
    email: master?.email || q.vendorEmail || '',
    gstNumber: master?.gstin || q.vendorGstin || '',
    paymentTerms: q.paymentTerms || ''
  };

  /* every quotation line becomes a PO line with the identical commercial values */
  const lines = (Array.isArray(q.items) ? q.items : []).filter(
    (l) => String(l?.materialName || l?.materialCode || '').trim()
  );
  if (lines.length === 0) deny(`Vendor Quotation ${q.quotationNumber} has no items to convert.`);
  lines.forEach((l, i) => {
    if (!(num(l.quotedQty) > 0)) deny(`Quotation ${q.quotationNumber} item ${i + 1} ("${l.materialName}") has no valid quantity.`);
    if (l.unitPrice === '' || l.unitPrice === null || l.unitPrice === undefined)
      deny(`Quotation ${q.quotationNumber} item ${i + 1} ("${l.materialName}") has no unit price.`);
  });

  const poItems = lines.map((l) => {
    const quantity = num(l.quotedQty);
    const unitPrice = num(l.unitPrice);
    const gst = num(l.taxPct ?? q.taxPct);
    const amount = calculateLineAmount(quantity, unitPrice);
    return {
      itemCode: l.materialCode || '',
      itemName: l.materialName || '',
      description: l.description || '',
      hsnSac: l.hsnSac || '',
      drawingNo: l.drawingNo || '',
      materialId: l.materialId || '',
      quantity,
      unit: l.unit || 'Nos',
      unitPrice,
      gst,
      /* the project's existing line/tax calculation is the only tax maths used */
      amount,
      gstAmount: calculateGSTAmount(amount, gst),
      /* carried through for traceability — the PO price itself is never changed */
      taxPct: gst,
      taxAmount: num(l.taxAmount) || calculateGSTAmount(amount, gst),
      discountPct: num(l.discount),
      discountAmount: (amount * num(l.discount)) / 100,
      quotationTotal: num(l.totalPrice),
      deliveryDate: l.deliveryDate || q.deliveryDate || '',
      itemRemarks: l.remarks || ''
    };
  });

  /* reuse the project's single tax/total calculation — no duplicate maths */
  const subtotal = poItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const discountValue = num(q.discountAmount) || (subtotal * num(q.discountPct)) / 100;
  const totals = calculateTotals(poItems, discountValue);

  const expectedDelivery = q.deliveryDate || '';
  const poNumber =
    overrides.poNumber ||
    generateSequentialNumber({
      prefix: 'PO',
      sequenceKey: 'purchaseOrderSequence',
      historyKey: PO_HISTORY,
      idField: 'reference'
    });

  const poDetails = {
    poNumber,
    poDate: overrides.poDate || todayStr(),
    deliveryDueDate: overrides.deliveryDueDate || expectedDelivery || '',
    /* --- full source document chain (inherited, never re-entered) --- */
    projectRef: projectId,
    projectId,
    salesOrderRef: soNumber || '',
    soNumber: soNumber || '',
    prRef: '',
    indentRef: indentNumber || '',
    enquiryRef: enquiry.enquiryNumber || '',
    quotationRef: q.quotationNumber,
    quotationDate: q.quotationDate || '',
    /* --- commercial terms copied from the quotation --- */
    paymentTerms: q.paymentTerms || '30 Days from Invoice',
    quotationTerms: q.otherTerms || q.remarks || '',
    discount: discountValue,
    poStatus: overrides.poStatus || PO_STATUS.SUBMITTED,
    /* --- PO-specific fields (editable by the Purchase user) --- */
    deliveryAddress: overrides.deliveryAddress || '',
    billingAddress: overrides.billingAddress || '',
    transportTerms: overrides.transportTerms || '',
    notes: overrides.notes || '',
    internalNotes: overrides.internalNotes || '',
    approvedBy: overrides.approvedBy || '',
    /* The legal terms printed on the PO are the company standard ones and are
       never blank. The vendor's own quoted terms stay separate in quotationTerms
       (they are shown as their own block, not mixed into the legal clause list). */
    termsAndConditions: (overrides.termsAndConditions || '').trim() || DEFAULT_PO_TERMS,
    /* --- PO-to-Supplier format fields (Your Ref, Ship To, charges) --- */
    yourRefNo: overrides.yourRefNo || q.quotationNumber || '',
    yourRefDate: overrides.yourRefDate || q.quotationDate || '',
    shipToName: overrides.shipToName || '',
    shipToAddress: overrides.shipToAddress || '',
    shipToMobile: overrides.shipToMobile || '',
    packingCharges: overrides.packingCharges ?? '',
    freight: overrides.freight ?? ''
  };

  /* PO-level grand total includes packing charges + freight (PO template) */
  const poGrandTotal = Number(
    (totals.grandTotal + (Number(poDetails.packingCharges) || 0) + (Number(poDetails.freight) || 0)).toFixed(2)
  );

  const payload = {
    poDetails,
    vendorDetails,
    companyDetails: readLS('companySettings', {}),
    items: poItems,
    totals,
    amountInWords: numberToWords(totals.grandTotal),
    sourceQuotation: {
      quotationNumber: q.quotationNumber,
      quotationDate: q.quotationDate || '',
      acceptedBy: q.acceptedBy || '',
      acceptedDate: q.acceptedDate || '',
      acceptedTime: q.acceptedTime || '',
      subtotal: num(q.subtotal) || num(q.totalAmount),
      taxAmount: num(q.taxAmount),
      totalWithTax: num(q.totalWithTax)
    }
  };

  return {
    poNumber,
    entry: {
      date: poDetails.poDate,
      reference: poNumber,
      vendor: vendorDetails.companyName || vendorDetails.vendorName || '-',
      projectRef: projectId || '-',
      soRef: soNumber || '',
      indentRef: indentNumber || '',
      enquiryRef: enquiry.enquiryNumber || '',
      quotationRef: q.quotationNumber,
      quotationNumber: q.quotationNumber,
      quotationDate: poDetails.quotationDate,
      dueDate: poDetails.deliveryDueDate || '-',
      total: `₹ ${poGrandTotal.toFixed(2)}`,
      status: poDetails.poStatus,
      payload
    },
    totals,
    items: poItems,
    poDetails,
    vendorDetails
  };
};

/**
 * THE authoritative Vendor Quotation → Purchase Order conversion.
 *
 * This is the only place a Purchase Order may be generated from a quotation.
 * Order of operations:
 *   1. find quotation            8. copy quotation commercial values (buildPOFromQuotation)
 *   2. quotation exists          9. generate PO number (existing PO numbering)
 *   3. status = Accepted        10. create the PO
 *   4. no PO generated yet      11. link PO back to the quotation
 *   5. vendor exists            12. update quotation status → PO Created
 *   6. all items present        13. notify the Store Department
 *   7. source references exist  14. return the created PO
 *
 * @param {string} quotationNumber
 * @param {object} overrides PO-specific fields only (PO number/date, delivery &
 *        billing address, transport terms, remarks, internal notes, approval).
 *        Quotation commercial values are never overridden.
 */
export const createPurchaseOrderFromQuotation = (quotationNumber, overrides = {}) => {
  requirePerm('purchase.order');

  /* 1–4. quotation exists, is accepted, and has not already produced a PO */
  const gate = canCreatePOFromQuotation(quotationNumber);
  if (!gate.allowed) deny(gate.reason);
  const quotation = gate.quotation;

  /* 5–7. vendor, items and source references are validated inside the builder */
  const draft = buildPOFromQuotation(quotation.quotationNumber, overrides);
  const { poNumber, entry, totals, poDetails, vendorDetails } = draft;

  /* 9–10. persist the Purchase Order */
  const history = readLS(PO_HISTORY, []);
  if (history.some((po) => String(po?.reference) === String(poNumber) && String(po?.payload?.poDetails?.quotationRef) === String(quotation.quotationNumber)))
    deny(`Purchase Order ${poNumber} already exists for quotation ${quotation.quotationNumber}.`);
  writeLS(PO_HISTORY, [entry, ...history]);
  saveSequenceCounter('purchaseOrderSequence', poNumber);

  /* 11–12. traceability: quotation → PO, and the PO → chain references */
  markQuotationPOCreated(quotation.quotationNumber, poNumber);
  try {
    linkPOToProcurementChain(poNumber, {
      enquiryNumber: poDetails.enquiryRef || '',
      quotationNumber: poDetails.quotationRef || ''
    });
  } catch (e) {
    log('PO CHAIN LINK WARNING', poNumber, String(e.message || e));
  }

  /* the Purchase Indent is only converted once a PO exists for it */
  if (poDetails.indentRef) {
    try {
      const indent = getIndent(poDetails.indentRef);
      if (indent && indent.status !== INDENT_STATUS.CONVERTED) {
        markIndentConverted(poDetails.indentRef, poNumber);
      }
    } catch (e) {
      log('PO INDENT CONVERT WARNING', poNumber, String(e.message || e));
    }
  }

  log(
    'PURCHASE ORDER FROM QUOTATION',
    poNumber,
    `Quotation ${quotation.quotationNumber} | Vendor ${vendorDetails.companyName || vendorDetails.vendorName} | ₹${Number(
      totals.grandTotal || 0
    ).toFixed(2)}`
  );

  /* 13. Store Department is notified — the PO then flows Store → Receipt → QC */
  notify(
    'Purchase Order from Accepted Quotation',
    `PO ${poNumber} was created from accepted quotation ${quotation.quotationNumber} for ${
      vendorDetails.companyName || vendorDetails.vendorName
    }. Amount: ₹${Number(totals.grandTotal || 0).toFixed(2)}${
      poDetails.projectRef ? `. Project ${poDetails.projectRef}` : ''
    }. Record the vendor delivery on the Tax Invoice / Material Receipt screen when it arrives — that receipt is shared with Quality and Purchase.`,
    poNumber,
    'Store Department',
    'info',
    `/material-receipts?po=${encodeURIComponent(poNumber)}`
  );

  return getPOByRef(poNumber) || entry;
};

/**
 * Validate a Purchase Order against the procurement chain it claims to come from.
 * Reference documents must exist and the ordered quantity must stay within the
 * quantity the source document authorised (prevents over-ordering).
 */
export const validatePOProcurementChain = ({
  indentNumber = '',
  enquiryNumber = '',
  quotationNumber = '',
  items = []
} = {}) => {
  const indent = indentNumber ? getIndent(indentNumber) : null;
  if (indentNumber && !indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent && indent.status === INDENT_STATUS.CANCELLED)
    deny(`Purchase Indent ${indentNumber} is cancelled — a Purchase Order cannot be raised.`);

  let enquiry = null;
  if (enquiryNumber) {
    enquiry = readVendorEnquiries().find((e) => String(e.enquiryNumber) === String(enquiryNumber)) || null;
    if (!enquiry) deny(`Vendor Enquiry ${enquiryNumber} not found.`);
  }
  let quotation = null;
  if (quotationNumber) {
    quotation = readVendorQuotations().find((q) => String(q.quotationNumber) === String(quotationNumber)) || null;
    if (!quotation) deny(`Vendor Quotation ${quotationNumber} not found.`);
    /* Only an ACCEPTED quotation may become a Purchase Order. Enforced here at the
       service layer so hiding the button in the UI is never the only protection. */
    if (!QUOTATION_ACCEPTED_STATUSES.includes(String(quotation.status))) {
      deny(
        `Vendor Quotation ${quotationNumber} is "${quotation.status || 'unknown'}" — only an Accepted quotation can be converted into a Purchase Order.`
      );
    }
    if (enquiry && String(quotation.enquiryNumber) !== String(enquiry.enquiryNumber))
      deny(`Vendor Quotation ${quotationNumber} does not belong to Vendor Enquiry ${enquiryNumber}.`);
  }

  /* quantity authority: quotation → enquiry → indent (in that order) */
  const authorityMap = {};
  const addAuthority = (rows, qtyField) => {
    (rows || []).forEach((r) => {
      const key = String(r.materialCode || r.materialName || '').toLowerCase();
      if (!key) return;
      authorityMap[key] = (authorityMap[key] || 0) + num(r[qtyField]);
    });
  };
  if (quotation) addAuthority(quotation.items, 'quotedQty');
  else if (enquiry) addAuthority(enquiry.items, 'requiredQty');
  else if (indent) addAuthority(indent.items, 'purchaseQty');

  if (Object.keys(authorityMap).length > 0 && items.length > 0) {
    (items || []).forEach((it) => {
      const key = String(it.itemCode || it.itemName || '').toLowerCase();
      if (!key || authorityMap[key] === undefined) return;
      const ordered = num(it.quantity);
      if (ordered <= 0) return;
      if (ordered > authorityMap[key]) {
        deny(
          `Ordered quantity ${ordered} for "${it.itemName || it.itemCode}" exceeds the ${authorityMap[key]} unit(s) authorised by ${
            quotation ? `quotation ${quotation.quotationNumber}` : enquiry ? `enquiry ${enquiry.enquiryNumber}` : `indent ${indent.indentNumber}`
          }.`
        );
      }
    });
  }

  return { indent, enquiry, quotation };
};

/**
 * Link a freshly created Purchase Order back to its Vendor Enquiry / Quotation
 * and inherit the Project ID / Sales Order / Indent references.
 */
export const linkPOToProcurementChain = (poNumber, { enquiryNumber = '', quotationNumber = '' } = {}) => {
  const po = getPOByRef(poNumber);
  if (!po) return null;
  const chain = validatePOProcurementChain({
    indentNumber: po.payload?.poDetails?.indentRef || '',
    enquiryNumber,
    quotationNumber
  });

  const enquiry = chain.enquiry;
  const quotation = chain.quotation;
  const details = po.payload?.poDetails || {};
  const inherited = {
    projectId:
      details.projectId ||
      details.projectRef ||
      quotation?.projectId ||
      enquiry?.projectId ||
      (chain.indent ? chain.indent.projectId : '') ||
      resolveProjectId({ poNumber }),
    projectRef:
      details.projectRef ||
      quotation?.projectId ||
      enquiry?.projectId ||
      (chain.indent ? chain.indent.projectId : '') ||
      resolveProjectId({ poNumber }),
    salesOrderRef: details.salesOrderRef || quotation?.soNumber || enquiry?.soNumber || (chain.indent ? chain.indent.soNumber : ''),
    indentRef: details.indentRef || quotation?.indentNumber || enquiry?.indentNumber || '',
    enquiryRef: enquiry ? enquiry.enquiryNumber : details.enquiryRef || '',
    quotationRef: quotation ? quotation.quotationNumber : details.quotationRef || '',
    paymentTerms: details.paymentTerms || quotation?.paymentTerms || enquiry?.paymentTerms || '',
    deliveryDueDate: details.deliveryDueDate || quotation?.deliveryDate || ''
  };
  if (inherited.projectRef === '-') inherited.projectRef = inherited.projectId || '';

  writePO(poNumber, {
    projectRef: inherited.projectRef || po.projectRef,
    soRef: inherited.salesOrderRef,
    indentRef: inherited.indentRef,
    enquiryRef: inherited.enquiryRef,
    quotationRef: inherited.quotationRef,
    payload: { ...po.payload, poDetails: { ...details, ...inherited } }
  });

  if (enquiry || quotation) {
    const enquiries = readVendorEnquiries();
    const eIdx = enquiries.findIndex((e) => String(e.enquiryNumber) === String((enquiry || quotation)?.enquiryNumber || ''));
    if (eIdx >= 0) {
      enquiries[eIdx] = { ...enquiries[eIdx], poNumber: poNumber, status: 'Closed', closedAt: nowDateTimeStr() };
      writeLS('vendorEnquiries', enquiries);
    }
    if (quotation) {
      const quotations = readVendorQuotations();
      const qIdx = quotations.findIndex((q) => String(q.quotationNumber) === String(quotation.quotationNumber));
      if (qIdx >= 0) {
        quotations[qIdx] = { ...quotations[qIdx], poNumber: poNumber, status: QUOTATION_STATUS.PO_CREATED };
        writeLS('vendorQuotations', quotations);
      }
    }
  }

  if (inherited.indentRef) {
    const indent = getIndent(inherited.indentRef);
    if (indent && indent.status !== INDENT_STATUS.CONVERTED) markIndentConverted(inherited.indentRef, poNumber);
  }
  syncPOStatus(poNumber, { force: true });
  log('PO LINKED TO PROCUREMENT CHAIN', poNumber, `${inherited.enquiryRef ? `VE ${inherited.enquiryRef} | ` : ''}${inherited.quotationRef ? `VQ ${inherited.quotationRef} | ` : ''}${inherited.indentRef ? `IND ${inherited.indentRef}` : ''}`);
  return getPOByRef(poNumber);
};

/* --------------------- 7 & 8 & 10. PO progress and receipts --------------------- */

export const getReceipts = () => getList(WF.receipts);
export const getReceipt = (receiptNumber) =>
  getReceipts().find((r) => String(r.receiptNumber) === String(receiptNumber)) || null;
export const getReceiptsForPO = (poNumber) =>
  getReceipts().filter((r) => String(r.poNumber) === String(poNumber));

/* ------------------------- 11A. Vendor Material Arrival (PO → Store) ------------------------- */

/**
 * A Material Arrival is the Store's invoice-free first action on a consignment.
 * It records only that material physically reached the store against a PO, so
 * Quality has something real to inspect. It never creates a tax invoice, never
 * credits inventory, and never changes the ordered quantity.
 *
 * Replacement Deliveries are the mechanism that closes a rejected balance: a
 * rejected quantity stays pending against the original PO until replacement
 * material arrives against that same PO. Because the quantity is bounded by the
 * outstanding rejection, a replacement can never inflate the ordered quantity.
 */
export const getArrivals = () => getList(WF.arrivals);
export const getArrival = (arrivalNumber) =>
  getArrivals().find((a) => String(a.arrivalNumber) === String(arrivalNumber)) || null;
export const getArrivalsForPO = (poNumber) =>
  getArrivals().filter((a) => String(a.poNumber) === String(poNumber));

/** Arrivals whose material is physically in the store but not yet inspected. */
export const getArrivalsAwaitingQualityCheck = () =>
  getArrivals().filter(
    (a) => !a.qcNumber && ARRIVAL_PENDING_QC_STATUSES.includes(String(a.status))
  );

export const getArrivalForQualityCheck = (arrivalNumber) =>
  getArrivals().find((a) => String(a.arrivalNumber) === String(arrivalNumber)) || null;

export const getRejectionReportsForArrival = (arrivalNumber) =>
  getRejectionReports().filter((r) => String(r.arrivalNumber || '') === String(arrivalNumber));

const saveArrival = (arrival) => {
  const list = getArrivals();
  const idx = list.findIndex((a) => String(a.arrivalNumber) === String(arrival.arrivalNumber));
  if (idx >= 0) list[idx] = arrival;
  else list.unshift(arrival);
  saveList(WF.arrivals, list);
  return arrival;
};

/**
 * Per-PO-line arrival balance. This is the single place that decides how much
 * more material may physically arrive, and it is what guarantees a replacement
 * can only ever cover rejected quantity rather than adding to the PO.
 */
const arrivalBalanceForLine = (progressLine, { replacementForRejection = '' } = {}) => {
  const ordered = num(progressLine?.orderedQty);
  const arrived = num(progressLine?.arrivedQty);
  const rejected = num(progressLine?.rejectedQty);
  const replaced = num(progressLine?.replacementArrivedQty);

  // A replacement delivery is capped by the rejection it is answering.
  if (replacementForRejection) {
    const report = getRejectionReport(replacementForRejection);
    const reportLine = (report?.items || []).find(
      (l) =>
        (progressLine?.materialCode && String(l.materialCode || '').toLowerCase() === String(progressLine.materialCode).toLowerCase()) ||
        (!progressLine?.materialCode && String(l.materialName || '').toLowerCase() === String(progressLine?.materialName || '').toLowerCase())
    );
    const rejectedOnReport = reportLine ? num(reportLine.rejectedQty) - num(reportLine.replacementQty) : 0;
    return {
      maxQty: Math.max(0, rejectedOnReport),
      label: `outstanding rejected quantity on ${replacementForRejection}`,
      reportLine: reportLine || null,
      report
    };
  }

  return {
    // An original delivery is capped by what the PO still physically needs,
    // counting material already received (original + replacement) against it.
    maxQty: Math.max(0, ordered - arrived),
    label: 'PO pending quantity',
    reportLine: null,
    report: null
  };
};

/**
 * Record a Vendor Material Arrival against a Purchase Order.
 *
 * Service-layer guarantees (cannot be bypassed from the UI):
 *   1. Only Store may record an arrival.
 *   2. No invoice, receipt or inventory movement is created — inspection first.
 *   3. An original delivery may never exceed the PO's outstanding ordered
 *      quantity, so ordered quantity can never be inflated by an arrival.
 *   4. A replacement delivery may never exceed the rejected quantity it answers,
 *      and a rejection can only be replaced once.
 */
export const recordMaterialArrival = ({
  poNumber,
  arrivalDate,
  dcNumber = '',
  dcDate = '',
  vehicleNumber = '',
  deliveredBy = '',
  contactNumber = '',
  transporter = '',
  remarks = '',
  items = [],
  documents = [],
  replacementForRejection = ''
}) => {
  requirePerm('arrival.create', 'Permission denied: only Store can record a Vendor Material Arrival.');
  if (!isStore()) deny('Only the Store Department can record a Vendor Material Arrival.');

  const po = getPOByRef(poNumber);
  if (!po) deny(`Purchase Order ${poNumber} not found.`);
  if (po.status === 'Cancelled') deny(`PO ${poNumber} is Cancelled — arrivals are not allowed.`);
  if (po.status === PO_STATUS.CLOSED || po.status === 'Received') {
    const closed = getPOProgress(poNumber);
    deny(
      `PO ${poNumber} is already ${po.status} (Ordered ${closed.ordered} | Received ${closed.received} | Pending ${closed.pending}). No further arrival is allowed.`
    );
  }

  const progress = getPOProgress(poNumber);
  if (progress.lines.length === 0) deny(`Purchase Order ${poNumber} has no material lines.`);

  let replacementReport = null;
  if (replacementForRejection) {
    replacementReport = getRejectionReport(replacementForRejection);
    if (!replacementReport) deny(`Rejection Report ${replacementForRejection} not found.`);
    if (String(replacementReport.poNumber) !== String(poNumber))
      deny(
        `Rejection Report ${replacementForRejection} belongs to PO ${replacementReport.poNumber}, not ${poNumber}. A replacement must be received against the original PO.`
      );
    if (getArrivalsForPO(poNumber).some((a) => String(a.replacementForRejection) === String(replacementForRejection)))
      deny(
        `A replacement arrival for Rejection Report ${replacementForRejection} is already recorded. Record another Rejection Report for further replacement material.`
      );
  }

  const lines = (items || []).filter((l) => num(l.arrivalQty) > 0);
  if (lines.length === 0) deny('Enter an arrival quantity for at least one material.');

  lines.forEach((line) => {
    const qty = num(line.arrivalQty);
    const progressLine = progress.lines.find(
      (p) =>
        (line.materialCode && String(p.materialCode).toLowerCase() === String(line.materialCode).toLowerCase()) ||
        (!line.materialCode && String(p.materialName || '').toLowerCase() === String(line.materialName || '').toLowerCase())
    );
    if (!progressLine)
      deny(`"${line.materialName || line.materialCode}" is not part of PO ${poNumber}.`);
    const balance = arrivalBalanceForLine(progressLine, { replacementForRejection });
    if (qty > balance.maxQty + 1e-9)
      deny(
        replacementForRejection
          ? `Replacement quantity ${qty} exceeds the ${balance.maxQty} ${progressLine.unit} still outstanding on ${replacementForRejection} for "${progressLine.materialName}".`
          : `Arrival quantity ${qty} exceeds the PO ${balance.label} of ${balance.maxQty} for "${progressLine.materialName}". (Ordered ${progressLine.orderedQty} | Already arrived ${progressLine.arrivedQty})`
      );
  });

  const arrivalNumber = generateSequentialNumber({
    prefix: 'MAT-ARR',
    sequenceKey: WF.arrivalSeq,
    historyKey: WF.arrivals,
    idField: 'arrivalNumber'
  });
  const user = currentUser();
  const arrivalType = replacementReport ? ARRIVAL_TYPE.REPLACEMENT : ARRIVAL_TYPE.ORIGINAL;
  const soNumber = po.payload?.poDetails?.salesOrderRef || '';
  const projectId = resolveProjectId({ poNumber, soNumber, indentNumber: po.payload?.poDetails?.indentRef });

  const arrival = {
    arrivalNumber,
    arrivalDate: arrivalDate || todayStr(),
    arrivalType,
    poNumber,
    soNumber,
    projectId,
    indentNumber: po.payload?.poDetails?.indentRef || '',
    vendor: po.vendor || po.payload?.vendorDetails?.companyName || '-',
    dcNumber,
    dcDate,
    vehicleNumber,
    deliveredBy,
    contactNumber,
    transporter,
    remarks,
    status: ARRIVAL_STATUS.PENDING_QC,
    qcStatus: QC_STATUS.PENDING,
    qcNumber: '',
    rejectionNumber: replacementReport?.rejectionNumber || '',
    replacementForRejection: replacementReport?.rejectionNumber || '',
    replacementForQc: replacementReport?.qcNumber || '',
    postedToInventory: false,
    inventoryPosted: false,
    documents: documents || [],
    items: lines.map((l) => {
      const progressLine = progress.lines.find(
        (p) =>
          (l.materialCode && String(p.materialCode).toLowerCase() === String(l.materialCode).toLowerCase()) ||
          (!l.materialCode && String(p.materialName || '').toLowerCase() === String(l.materialName || '').toLowerCase())
      );
      return {
        materialCode: l.materialCode || progressLine?.materialCode || '',
        materialName: l.materialName || progressLine?.materialName || '',
        unit: l.unit || progressLine?.unit || 'Nos',
        orderedQty: num(progressLine?.orderedQty),
        arrivalQty: num(l.arrivalQty),
        pendingBefore: num(progressLine?.arrivedQty),
        pendingAfter: num(progressLine?.pendingQty),
        batchNumber: l.batchNumber || '',
        internalBatchId: l.internalBatchId || (!String(l.batchNumber || '').trim() ? generateInternalReceiptBatchId() : ''),
        lotNumber: l.lotNumber || '',
        remarks: l.remarks || ''
      };
    }),
    createdBy: user.name,
    createdByEmpId: user.empId,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    history: [
      historyEntry(
        replacementReport ? 'Replacement material arrived' : 'Material arrived',
        `${lines.length} material(s), ${lines.reduce((a, l) => a + num(l.arrivalQty), 0)} unit(s)${
          replacementReport ? ` | replacement for ${replacementReport.rejectionNumber}` : ''
        }`
      )
    ]
  };

  saveArrival(arrival);
  saveSequenceCounter(WF.arrivalSeq, arrivalNumber);

  // The rejected balance is consumed by the arrival itself — nothing is closed
  // until the replacement material passes its own inspection.
  if (replacementReport) {
    const keyOf = (l) => String(l.materialCode || l.materialName || '').trim().toLowerCase();
    const arrivedByKey = new Map(
      lines.map((l) => [
        keyOf(l),
        num(l.arrivalQty)
      ])
    );
    replacementReport.items = (replacementReport.items || []).map((l) => {
      const arrQty = arrivedByKey.get(keyOf(l));
      if (!arrQty) return l;
      const replacementQty = num(l.replacementQty) + arrQty;
      return {
        ...l,
        replacementQty,
        pendingReplacementQty: Math.max(0, num(l.rejectedQty) - replacementQty)
      };
    });
    replacementReport.replacementQty = replacementReport.items.reduce((a, i) => a + num(i.replacementQty), 0);
    replacementReport.pendingReplacementQty = replacementReport.items.reduce(
      (a, i) => a + Math.max(0, num(i.rejectedQty) - num(i.replacementQty)),
      0
    );
    replacementReport.replacementArrivalNumber = arrivalNumber;
    replacementReport.replacementArrivedAt = nowDateTimeStr();
    replacementReport.history = [
      ...(replacementReport.history || []),
      historyEntry('Replacement material received in Store', `${arrivalNumber} | awaiting quality inspection`)
    ];
    saveRejection(replacementReport);
  }

  syncPOStatus(poNumber, { arrivalNumber });

  const arrivedTotal = lines.reduce((a, l) => a + num(l.arrivalQty), 0);
  log(
    'MATERIAL ARRIVAL RECORDED',
    arrivalNumber,
    `PO ${poNumber} | ${arrivalType} | ${lines.length} line(s) | ${arrivedTotal} unit(s)`
  );

  notify(
    'Vendor material arrived – Quality Check required',
    `Material Arrival ${arrivalNumber} recorded against PO ${poNumber}.\nProject ID: ${projectId || '—'}\nVendor: ${arrival.vendor}\nArrived Quantity: ${arrivedTotal}\nArrival Type: ${arrivalType}${
      replacementReport ? `\nReplacement for: ${replacementReport.rejectionNumber}` : ''
    }\nQuality inspection is required before inventory.`,
    arrivalNumber,
    'Production Department',
    'info'
  );
  notify(
    replacementReport ? 'Replacement material arrived' : 'Material arrival recorded',
    `Material Arrival ${arrivalNumber} (PO ${poNumber}, ${arrivalType}) recorded by Store. ${arrivedTotal} unit(s) awaiting Quality Check.`,
    arrivalNumber,
    'Purchase Department',
    'info'
  );

  return { arrival, progress: getPOProgress(poNumber) };
};

export const updateArrivalDocuments = (arrivalNumber, documents) => {
  requirePerm('arrival.create', 'Permission denied: arrival documents can only be updated by Store.');
  const arrival = getArrival(arrivalNumber);
  if (!arrival) deny(`Material Arrival ${arrivalNumber} not found.`);
  arrival.documents = documents || [];
  arrival.history = [
    ...(arrival.history || []),
    historyEntry('Documents updated', `${arrival.documents.length} file(s)`)
  ];
  saveArrival(arrival);
  log('ARRIVAL DOCUMENTS UPDATED', arrivalNumber, `${arrival.documents.length} file(s)`);
  return arrival;
};

/**
 * Full quantity ledger for a Purchase Order.
 *
 * Eight independently tracked figures per line, so no stage can silently stand
 * in for another:
 *   orderedQty              – what the PO committed to buy
 *   arrivedQty              – physically in the store (Material Arrival records)
 *   receivedQty             – legacy alias of arrivedQty (kept for old screens)
 *   acceptedQty / passedQty – what Quality has passed
 *   rejectedQty             – what Quality has rejected
 *   replacementArrivedQty   – replacement material received for those rejections
 *   replacementAcceptedQty  – replacement material that itself passed
 *   inventoryPostedQty      – accepted quantity credited to stock
 *   invoicedQty             – accepted quantity covered by a tax invoice
 *   pendingQty              – ordered quantity not yet physically arrived
 *   pendingReplacementQty   – rejected quantity still waiting to be replaced
 *   pendingAcceptedQty      – passed quantity not yet added to inventory
 *   pendingInvoiceQty       – inventory-posted quantity not yet invoiced
 *
 * Closure requires ALL of: everything arrived, everything passed, no unresolved
 * rejection, replacement resolved, inventory posted and tax invoice recorded.
 */
export const getPOProgress = (poNumber, { excludeReceipt = '' } = {}) => {
  const po = getPOByRef(poNumber);
  const poItems = po?.payload?.items || [];
  // excludeReceipt: while a stored receipt is being edited or deleted its own
  // quantities must not count against it — a receipt never blocks itself.
  const receipts = getReceiptsForPO(poNumber).filter(
    (r) => !excludeReceipt || String(r.receiptNumber) !== String(excludeReceipt)
  );
  const arrivals = getArrivalsForPO(poNumber);
  const poQCs = getQualityChecks().filter((q) => String(q.poNumber || '') === String(poNumber));
  const qcNumbers = new Set(poQCs.map((q) => String(q.qcNumber)));
  const poRejections = getRejectionReports().filter((r) => qcNumbers.has(String(r.qcNumber)));

  // Replacement arrivals are identified both explicitly and by the Rejection
  // Report they answer, so an older/hand-created arrival is still counted right.
  const replacementArrivals = arrivals.filter(
    (a) =>
      String(a.arrivalType) === ARRIVAL_TYPE.REPLACEMENT ||
      Boolean(a.replacementForRejection) ||
      Boolean(a.rejectionNumber)
  );
  const replacementArrivalNumbers = new Set(replacementArrivals.map((a) => String(a.arrivalNumber)));
  // Replacement material booked as a Material Receipt against this same PO
  // (RR-…). It counts as a physical delivery but never as ordered quantity.
  const replacementReceipts = receipts.filter(
    (r) =>
      r.isReplacement === true ||
      String(r.receiptType || '') === 'Replacement Receipt' ||
      Boolean(r.replacementForRejection) ||
      Boolean(r.rejectionNumber)
  );
  const replacementReceiptNumbers = new Set(replacementReceipts.map((r) => String(r.receiptNumber)));
  // Quality inspections of replacement material, across every source it can take.
  const replacementQCs = poQCs.filter(
    (q) =>
      replacementArrivalNumbers.has(String(q.arrivalNumber || '')) ||
      replacementReceiptNumbers.has(String(q.receiptNumber || '')) ||
      String(q.arrivalType) === ARRIVAL_TYPE.REPLACEMENT
  );
  // Inspections raised straight from a Purchase Indent: no arrival and no
  // receipt, so the inspection itself is the only record that material arrived.
  const indentSourcedQCs = poQCs.filter((q) => !q.arrivalNumber && !q.receiptNumber);

  const lines = poItems.map((it) => {
    const orderedQty = num(it.quantity);
    const matchLine = (l) =>
      (it.itemCode && String(l.materialCode).toLowerCase() === String(it.itemCode).toLowerCase()) ||
      (!it.itemCode && l.materialName === it.itemName);
    // A single GRN/QC may split the same material across several supplier
    // batches. Sum those lines within each document while counting each source
    // document once; never select only its first matching line.
    const sumLines = (rows, field) =>
      rows.reduce((sum, r) => sum + (r.items || []).filter(matchLine).reduce((lineSum, line) => lineSum + num(line[field]), 0), 0);

    /* --- physical delivery: Material Arrival is the source of truth --- */
    const rawArrivedQty = sumLines(arrivals, 'arrivalQty');
    const replacementReceiptQty = sumLines(replacementReceipts, 'receivedQty');
    const replacementArrivedQty = sumLines(replacementArrivals, 'arrivalQty') + replacementReceiptQty;

    // A PO predating Material Arrivals has no arrival rows at all. Its receipts
    // were the arrival; where the inspection was raised straight from a Purchase
    // Indent the inspected quantity is the only proof of delivery. Fall back to
    // those so historical POs keep their original totals — on both the arrived
    // and received views of the same physical delivery.
    const legacyReceiptQty = sumLines(receipts, 'receivedQty');
    const legacyInspectedQty = sumLines(indentSourcedQCs, 'receivedQty');
    const baseDeliveredQty = rawArrivedQty > 0 ? rawArrivedQty : legacyReceiptQty || legacyInspectedQty;
    // Replacement receipts on an arrival-based PO are an extra physical delivery,
    // so they are added to the arrival total rather than replacing it.
    const legacyDeliveredQty = rawArrivedQty > 0 ? baseDeliveredQty + replacementReceiptQty : baseDeliveredQty;
    const arrivedQty = legacyDeliveredQty;
    const receivedQty = legacyDeliveredQty;
    const isLegacyArrival = rawArrivedQty <= 0 && legacyReceiptQty > 0;
    const originalArrivedQty = Math.max(0, arrivedQty - replacementArrivedQty);

    /* --- inspection outcomes --- */
    const inspectedQty = sumLines(poQCs, 'receivedQty');
    const acceptedQty = sumLines(poQCs, 'acceptedQty');
    const rejectedQty = sumLines(poQCs, 'rejectedQty');
    const inventoryPostedQty = poQCs.reduce((sum, q) => {
      if (!q.postedToInventory) return sum;
      return sum + (q.items || []).filter(matchLine).reduce((lineSum, line) => lineSum + num(line.acceptedQty), 0);
    }, 0);

    /**
     * A rejection is only resolved once replacement material for it has itself
     * passed inspection. Replacement that has merely arrived, or been ordered on
     * a separate replacement PO, is still outstanding — so the original PO keeps
     * reporting a pending replacement instead of closing.
     */
    const replacementAcceptedQty = replacementQCs.reduce((sum, q) => {
      return sum + (q.items || []).filter(matchLine).reduce((lineSum, line) => lineSum + num(line.acceptedQty), 0);
    }, 0);

    // Replacements raised as a separate PO (legacy path) also resolve rejections.
    // Track what that replacement PO has physically received as well as passed,
    // so the original PO's rejection balance can retire when the legacy cycle
    // completes instead of staying open forever.
    const legacyReplacement = poRejections.reduce((acc, r) => {
      const replacementQtyOnLine = (r.items || []).filter(matchLine).reduce((lineSum, line) => lineSum + num(line.replacementQty), 0);
      if (replacementQtyOnLine <= 0) return acc;
      const replacementIndent = r.repurchaseIndentNumber ? getIndent(r.repurchaseIndentNumber) : null;
      const replacementPO = replacementIndent?.poNumber;
      if (!replacementPO) return acc;
      try {
        const rp = getPOProgress(replacementPO);
        const rLine = (rp.lines || []).find(
          (l) =>
            (l.materialCode && String(l.materialCode).toLowerCase() === String(it.itemCode || '').toLowerCase()) ||
            (!l.materialCode && l.itemName === it.itemName)
        );
        if (!rLine) return acc;
        return {
          received: acc.received + Math.min(replacementQtyOnLine, num(rLine.receivedQty)),
          accepted: acc.accepted + Math.min(replacementQtyOnLine, num(rLine.acceptedQty))
        };
      } catch {
        return acc;
      }
    }, { received: 0, accepted: 0 });
    const legacyReplacementAcceptedQty = legacyReplacement.accepted;

    const invoicedQty = isLegacyArrival ? legacyReceiptQty : sumLines(receipts, 'receivedQty');
    const totalReplacementAccepted = replacementAcceptedQty + legacyReplacementAcceptedQty;
    const openRejectedQty = Math.max(0, rejectedQty - totalReplacementAccepted);
    const pendingReplacementQty = Math.max(
      0,
      rejectedQty - Math.max(replacementArrivedQty, legacyReplacement.received)
    );
    // What the closure gate counts as "passed": this PO's own inspections plus
    // replacement material that a legacy separate replacement PO delivered and
    // Quality approved on this PO's behalf.
    const creditedAcceptedQty = Math.min(orderedQty, acceptedQty + legacyReplacementAcceptedQty);

    return {
      materialCode: it.itemCode || '',
      materialName: it.itemName || '-',
      unit: it.unit || 'Nos',
      orderedQty,
      arrivedQty,
      originalArrivedQty,
      replacementArrivedQty,
      receivedQty,
      inspectedQty,
      acceptedQty,
      passedQty: acceptedQty,
      rejectedQty,
      replacementQty: sumLines(poRejections, 'replacementQty'),
      replacementAcceptedQty: totalReplacementAccepted,
      creditedAcceptedQty,
      inventoryPostedQty,
      invoicedQty,
      openRejectedQty,
      pendingReplacementQty,
      pendingQty: Math.max(0, orderedQty - receivedQty),
      // Accepted-but-not-yet-stocked, and stocked-but-not-yet-invoiced.
      pendingAcceptedQty: Math.max(0, acceptedQty - inventoryPostedQty),
      pendingInvoiceQty: Math.max(0, inventoryPostedQty - invoicedQty),
      isLegacyArrival
    };
  });

  const ordered = lines.reduce((a, l) => a + l.orderedQty, 0);
  const arrived = lines.reduce((a, l) => a + l.arrivedQty, 0);
  const received = lines.reduce((a, l) => a + l.receivedQty, 0);
  const pending = lines.reduce((a, l) => a + l.pendingQty, 0);
  const inspected = lines.reduce((a, l) => a + l.inspectedQty, 0);
  const accepted = lines.reduce((a, l) => a + l.acceptedQty, 0);
  const creditedAccepted = lines.reduce((a, l) => a + num(l.creditedAcceptedQty), 0);
  const rejected = lines.reduce((a, l) => a + l.rejectedQty, 0);
  const inventoryPosted = lines.reduce((a, l) => a + l.inventoryPostedQty, 0);
  const invoiced = lines.reduce((a, l) => a + l.invoicedQty, 0);
  const replacement = lines.reduce((a, l) => a + l.replacementQty, 0);
  const replacementArrived = lines.reduce((a, l) => a + l.replacementArrivedQty, 0);
  const replacementAccepted = lines.reduce((a, l) => a + l.replacementAcceptedQty, 0);
  const openRejected = lines.reduce((a, l) => a + l.openRejectedQty, 0);
  const pendingReplacement = lines.reduce((a, l) => a + l.pendingReplacementQty, 0);
  const pendingAccepted = lines.reduce((a, l) => a + l.pendingAcceptedQty, 0);
  const pendingInvoice = lines.reduce((a, l) => a + l.pendingInvoiceQty, 0);

  const fullyReceived = ordered > 0 && pending === 0;
  const allInspected = ordered > 0 && inspected >= received && received > 0;
  const anyInspection = accepted > 0 || rejected > 0;
  const replacementPending = openRejected > 0;
  const allAccepted = ordered > 0 && accepted + rejected >= ordered;
  const awaitingInventory = pendingAccepted > 0;
  const awaitingInvoice = pendingInvoice > 0;

  /**
   * Closure gate. Every one of these must hold, and each is derived from stored
   * records only — the UI has no way to force a PO closed early.
   */
  const closureChecks = {
    allArrived: ordered > 0 && pending === 0,
    allAccepted: ordered > 0 && creditedAccepted >= ordered,
    noUnresolvedRejection: openRejected === 0 && pendingReplacement === 0,
    inventoryPosted: pendingAccepted === 0,
    invoiceRecorded: pendingInvoice === 0
  };
  const closureReady = ordered > 0 && Object.values(closureChecks).every(Boolean);

  /* physical delivery status — a PO closes only when the full chain is done */
  let status = po?.status || '';
  if (po && !['Cancelled', PO_STATUS.CLOSED].includes(status)) {
    if (closureReady) status = PO_STATUS.CLOSED;
    else if (received > 0) status = PO_STATUS.PARTIAL;
  }

  /* procurement fulfilment status — a rejected balance is never "fully fulfilled" */
  let fulfillmentStatus;
  if (ordered === 0) fulfillmentStatus = po?.status || PO_STATUS.DRAFT;
  else if (closureReady) fulfillmentStatus = PO_STATUS.FULFILLED;
  else if (replacementPending) fulfillmentStatus = PO_STATUS.REPLACEMENT_PENDING;
  else if (pendingReplacement > 0) fulfillmentStatus = PO_STATUS.REPLACEMENT_AWAITING_ARRIVAL;
  else if (awaitingInvoice && !awaitingInventory) fulfillmentStatus = PO_STATUS.AWAITING_INVOICE;
  else if (awaitingInventory && fullyReceived && allAccepted) fulfillmentStatus = PO_STATUS.AWAITING_INVENTORY;
  else if (fullyReceived && !anyInspection) fulfillmentStatus = PO_STATUS.AWAITING_QC;
  else if (allAccepted && rejected === 0) fulfillmentStatus = PO_STATUS.QC_APPROVED;
  else if (allInspected && rejected > 0) fulfillmentStatus = PO_STATUS.QC_REJECTED;
  else if (anyInspection && rejected > 0) fulfillmentStatus = PO_STATUS.QC_REJECTED;
  else if (anyInspection) fulfillmentStatus = PO_STATUS.QC_APPROVED;
  else if (received > 0) fulfillmentStatus = PO_STATUS.AWAITING_QC;
  else fulfillmentStatus = status || PO_STATUS.AWAITING_DELIVERY;

  return {
    poNumber,
    poStatus: po?.status || '',
    lines,
    ordered,
    arrived,
    received,
    pending,
    inspected,
    accepted,
    passed: accepted,
    rejected,
    creditedAccepted,
    // Physically received but not yet inspected — the Quality Check queue.
    qcPending: Math.max(0, received - inspected),
    inventoryPosted,
    invoiced,
    replacement,
    replacementArrived,
    replacementAccepted,
    openRejected,
    pendingReplacement,
    pendingAccepted,
    pendingInvoice,
    allInspected,
    allAccepted,
    awaitingInventory,
    awaitingInvoice,
    closureChecks,
    closureReady,
    status,
    computedStatus: status,
    fulfillmentStatus,
    fullyReceived,
    replacementPending,
    closed: Boolean(po && (status === PO_STATUS.CLOSED || po.status === PO_STATUS.CLOSED)),
    projectId: getPOProjectId(po),
    soNumber: po?.payload?.poDetails?.salesOrderRef || '',
    indentNumber: po?.payload?.poDetails?.indentRef || '',
    vendor: po?.vendor || po?.payload?.vendorDetails?.companyName || '',
    qcCount: poQCs.length,
    receiptCount: receipts.length,
    arrivalCount: arrivals.length
  };
};

/**
 * Persist the Purchase Order status derived from the delivery + inspection ledger.
 *
 * Closure rule (service layer — the UI cannot bypass it):
 *   a PO closes only when the whole chain is complete: everything ordered has
 *   physically arrived, all of it has passed Quality Check, no rejection is left
 *   unresolved, replacement material (if any) has itself passed, the accepted
 *   quantity is in inventory, and the tax invoice has been recorded.
 * A rejected quantity keeps the PO open; replacement is received against the same
 * PO and can never raise the ordered quantity.
 */
export const syncPOStatus = (poNumber, extra = {}) => {
  const po = getPOByRef(poNumber);
  if (!po) return null;
  if (['Cancelled', 'Received'].includes(po.status)) return po;
  const progress = getPOProgress(poNumber);
  if (progress.ordered <= 0) return po;

  const next = progress.status;
  if (po.status === next && !extra.force) return po;

  const patch = {
    orderedQty: progress.ordered,
    receivedQty: progress.received,
    arrivedQty: progress.arrived,
    pendingQty: progress.pending,
    acceptedQty: progress.accepted,
    passedQty: progress.passed,
    rejectedQty: progress.rejected,
    pendingReplacementQty: progress.pendingReplacement,
    inventoryPostedQty: progress.inventoryPosted,
    invoicedQty: progress.invoiced,
    closureReady: progress.closureReady,
    fulfillmentStatus: progress.fulfillmentStatus,
    ...extra
  };
  delete patch.silent;
  delete patch.force;
  if (next === PO_STATUS.CLOSED) {
    patch.closedAt = po.closedAt || nowDateTimeStr();
    patch.closedReason =
      'All ordered quantity arrived, passed Quality Check, replacement resolved, added to inventory and tax invoice recorded';
  }
  return writePO(poNumber, {
    ...patch,
    status: next,
    payload: {
      ...po.payload,
      poDetails: {
        ...po.payload?.poDetails,
        poStatus: next,
        fulfillmentStatus: progress.fulfillmentStatus,
        pendingQty: progress.pending,
        pendingReplacementQty: progress.pendingReplacement,
        pendingAcceptedQty: progress.pendingAccepted,
        pendingInvoiceQty: progress.pendingInvoice
      }
    }
  });
};

const PO_SHORT_CLOSE_REASONS = new Set([
  'Vendor unable to supply',
  'Customer order cancelled',
  'Material requirement reduced',
  'Alternative supplier selected',
  'Remaining quantity no longer required'
]);

/**
 * Short-close the still-unreceived balance of an existing PO without changing
 * its original ordered quantity or any arrival, QC, receipt, or invoice record.
 * The Purchase Manager approval and audit details are stored on the PO record.
 */
export const shortClosePurchaseOrder = (poNumber, { reason = '', remarks = '' } = {}) => {
  requirePerm('purchase.order.short_close', 'Permission denied: only a Purchase Manager or administrator can short-close a Purchase Order.');
  const po = getPOByRef(poNumber);
  if (!po) deny(`Purchase Order ${poNumber} was not found.`);
  if (po.status === PO_STATUS.CANCELLED) deny(`Purchase Order ${poNumber} is cancelled and cannot be short-closed.`);
  if (po.status === PO_STATUS.DRAFT) deny(`Purchase Order ${poNumber} is still a draft and cannot be short-closed.`);
  if (po.shortClose?.closedAt) deny(`Purchase Order ${poNumber} has already been short-closed.`);
  if (!PO_SHORT_CLOSE_REASONS.has(String(reason).trim())) deny('Select a valid short-close reason.');
  const note = String(remarks || '').trim();
  if (!note) deny('Enter remarks explaining the short-close decision.');

  const progress = getPOProgress(poNumber);
  const remaining = Number(progress.pending) || 0;
  if (remaining <= 0) deny(`Purchase Order ${poNumber} has no unreceived quantity to short-close.`);
  if (progress.qcPending > 0 || progress.pendingAccepted > 0 || progress.pendingInvoice > 0 || progress.openRejected > 0 || progress.pendingReplacement > 0) {
    deny(`Purchase Order ${poNumber} has receipts, inspection, inventory, invoice, or rejection work still in progress. Complete or resolve that work before short-closing.`);
  }

  const user = currentUser();
  const at = nowDateTimeStr();
  const closure = {
    shortClosedQty: remaining,
    lines: (progress.lines || []).filter((line) => num(line.pendingQty) > 0).map((line) => ({
      itemCode: line.materialCode || '',
      itemName: line.materialName || '',
      quantity: num(line.pendingQty),
      unit: line.unit || ''
    })),
    reason: String(reason).trim(),
    remarks: note,
    closedAt: at,
    closedBy: user.name,
    employeeId: user.empId,
    department: user.dept,
    approvedBy: user.name,
    approvedByEmployeeId: user.empId,
    approvedAt: at
  };
  const updated = writePO(poNumber, {
    status: PO_STATUS.CLOSED,
    shortClose: closure,
    shortCloseHistory: [...(po.shortCloseHistory || []), closure],
    closedAt: at,
    closedReason: String(reason).trim(),
    closedBy: user.name,
    payload: {
      ...po.payload,
      poDetails: {
        ...po.payload?.poDetails,
        poStatus: PO_STATUS.CLOSED,
        shortClose: closure
      }
    }
  });
  log('PO SHORT-CLOSED', poNumber, `Short-closed ${remaining} unit(s) | ${reason} | Approved by ${user.name} | ${note}`);
  notify('Purchase Order short-closed', `PO ${poNumber}: ${remaining} unit(s) short-closed by ${user.name}. Reason: ${reason}.`, poNumber, 'Store Department', 'info');
  return updated;
};

/** Backfill the new PO fields (status / fulfillment / quantities) on historical records. */
export const reconcilePOStatuses = () => {
  getPurchaseOrders().forEach((po) => {
    if (!po?.reference || String(po.reference).startsWith('legacy')) return;
    try {
      syncPOStatus(po.reference, { force: true });
    } catch {
      /* ignore malformed legacy records */
    }
  });
};

const validateReceiptLines = (poNumber, incoming, excludeReceipt = '') => {
  const po = getPOByRef(poNumber);
  const progress = getPOProgress(poNumber, { excludeReceipt });
  // When an existing receipt is re-validated (excludeReceipt set) the PO may be
  // terminal *because of this very receipt* — only its own quantities are
  // checked below, so the closure gate does not block a correction.
  if (!excludeReceipt && po && PO_TERMINAL_STATUSES.includes(po.status)) {
    deny(
      `PO ${poNumber} is ${po.status} (Ordered ${progress.ordered} | Arrived ${progress.received} | Pending ${progress.pending}). No further receipt is allowed — a closed PO is never reopened.`
    );
  }
  if (progress.lines.length === 0) deny(`Purchase Order ${poNumber} has no material lines.`);

  const receivedByPOLine = new Map();
  incoming.forEach((line) => {
    const qty = num(line.receivedQty);
    if (qty <= 0) return;
    const key = String(line.materialCode || line.materialName || '').toLowerCase();
    const progressLine = progress.lines.find(
      (l) =>
        (line.materialCode && String(l.materialCode).toLowerCase() === key) ||
        (!line.materialCode && String(l.materialName || '').toLowerCase() === key)
    );
    if (!progressLine) deny(`"${line.materialName || line.materialCode}" is not part of PO ${poNumber}.`);
    const allocated = (receivedByPOLine.get(progressLine) || 0) + qty;
    receivedByPOLine.set(progressLine, allocated);
    if (allocated > progressLine.pendingQty)
      deny(
        `Received quantity ${allocated} exceeds PO pending quantity ${progressLine.pendingQty} for "${progressLine.materialName}". (Ordered ${progressLine.orderedQty} | Arrived ${progressLine.receivedQty} | Pending ${progressLine.pendingQty})`
      );
  });
};

/**
 * The Tax Invoice / Material Receipt is raised only after Quality has passed the
 * material, so it documents the *accepted* quantity — never the arrived or the
 * rejected quantity. It also cannot exceed what the PO has ordered, and a
 * PO may not be invoiced beyond its own ordered quantity.
 */
const validateInvoiceIsWithinOrdered = (poNumber, incoming, excludeReceipt = '') => {
  const progress = getPOProgress(poNumber, { excludeReceipt });
  const invoicedByPOLine = new Map();
  incoming.forEach((line) => {
    const qty = num(line.receivedQty);
    if (qty <= 0) return;
    const key = String(line.materialCode || line.materialName || '').toLowerCase();
    const progressLine = progress.lines.find(
      (l) =>
        (line.materialCode && String(l.materialCode).toLowerCase() === key) ||
        (!line.materialCode && String(l.materialName || '').toLowerCase() === key)
    );
    if (!progressLine) deny(`"${line.materialName || line.materialCode}" is not part of PO ${poNumber}.`);
    const invoicedBefore = progressLine.invoicedQty;
    const allocated = (invoicedByPOLine.get(progressLine) || 0) + qty;
    invoicedByPOLine.set(progressLine, allocated);
    if (invoicedBefore + allocated > progressLine.orderedQty + 1e-9)
      deny(
        `Tax invoice quantity ${allocated} would take "${progressLine.materialName}" to ${invoicedBefore + allocated}, above the ordered quantity ${progressLine.orderedQty}. An invoice can never exceed the Purchase Order.`
      );
  });
};

/**
 * When the receipt is the tax-invoice documentation for an already inspected
 * Purchase Indent, quantities are validated against the passed (accepted)
 * quantity of that inspection instead of the PO pending quantity.
 */
const validateReceiptLinesAgainstQC = (qc, incoming) => {
  const used = new Map();
  incoming.forEach((line) => {
    const qty = num(line.receivedQty);
    if (qty <= 0) return;
    const qcLine = findMatchingReceiptLine(qc.items || [], line);
    if (!qcLine) deny(`"${line.materialName || line.materialCode}" was not inspected in ${qc.qcNumber}.`);
    const allocated = (used.get(qcLine) || 0) + qty;
    used.set(qcLine, allocated);
    if (allocated > num(qcLine.acceptedQty))
      deny(
        `Receipt quantity ${allocated} exceeds the passed quantity ${num(qcLine.acceptedQty)} of ${qc.qcNumber} for "${qcLine.materialName}".`
      );
  });
};

/** Quality Check results that still allow a tax invoice to be raised against them. */
export const INVOICE_ELIGIBLE_QC_STATUSES = [QC_STATUS.APPROVED, QC_STATUS.PARTIAL, QC_STATUS.REJECTED];

/**
 * Tax Invoice / Material Receipt.
 *
 * In the current flow this is raised only *after* Quality has inspected the
 * Material Arrival: it documents the quantity that passed, never the rejected
 * quantity. It must therefore be linked to the Quality Check that approved it.
 * A PO that predates Material Arrivals has no arrival to link to, so the legacy
 * path (receipt as the first document) is preserved for those records only.
 *
 * Service-layer guarantees:
 *   1. Only Store may enter it.
 *   2. On the current flow a linked, completed Quality Check is required.
 *   3. Receipt quantity per material may never exceed that inspection's passed
 *      quantity, and may never take the PO above its ordered quantity.
 *   4. An invoice number can never be reused.
 */
export const createMaterialReceipt = ({
  poNumber,
  invoiceNumber,
  invoiceDate,
  dcNumber = '',
  dcDate = '',
  vehicleNumber = '',
  deliveredBy = '',
  contactNumber = '',
  transporter = '',
  remarks = '',
  items = [],
  documents = [],
  linkedQcNumber = '',
  replacementForRejection = '',
  originalReceiptNumber = '',
  debitNoteNumber = ''
}) => {
  requirePerm('receipt.create', 'Permission denied: only Store can enter a Tax Invoice / Material Receipt.');
  if (!isStore()) deny('Only the Store Department can enter a Tax Invoice / Material Receipt.');

  const po = getPOByRef(poNumber);
  if (!po) deny(`Purchase Order ${poNumber} not found.`);
  if (po.status === 'Cancelled') deny(`PO ${poNumber} is Cancelled — receipts are not allowed.`);

  /* Replacement material answers an open Rejection Report on this very PO. It
   * never raises the ordered quantity: it is capped by the rejected balance that
   * is still outstanding, and it may only be booked while that balance exists. */
  let replacementReport = null;
  if (replacementForRejection) {
    replacementReport = getRejectionReport(replacementForRejection);
    if (!replacementReport) deny(`Rejection Report ${replacementForRejection} not found.`);
    if (String(replacementReport.poNumber) !== String(poNumber))
      deny(
        `Rejection Report ${replacementForRejection} belongs to PO ${replacementReport.poNumber}, not ${poNumber}. A replacement must be received against the original PO.`
      );
  }

  if (po.status === PO_STATUS.CLOSED || po.status === 'Received') {
    const closedProgress = getPOProgress(poNumber);
    const replacementAllowed = Boolean(replacementReport) && closedProgress.pendingReplacement > 0;
    if (!replacementAllowed)
      deny(
        `PO ${poNumber} is already ${po.status} — Ordered ${closedProgress.ordered} | Arrived ${closedProgress.received} | Pending ${closedProgress.pending}. Rejected quantity is replaced by booking a replacement Material Receipt against the same PO.`
      );
  }

  if (!String(invoiceNumber || '').trim()) deny('Invoice Number is required.');
  if (!invoiceDate) deny('Invoice Date is required.');

  let linkedQc = null;
  if (linkedQcNumber) {
    linkedQc = getQualityCheck(linkedQcNumber);
    if (!linkedQc) deny(`Quality Check ${linkedQcNumber} not found.`);
    if (String(linkedQc.poNumber) !== String(poNumber))
      deny(`Quality Check ${linkedQcNumber} belongs to PO ${linkedQc.poNumber}, not ${poNumber}.`);
    if (linkedQc.receiptNumber)
      deny(`Quality Check ${linkedQcNumber} is already linked to receipt ${linkedQc.receiptNumber}.`);
    if (![QC_STATUS.APPROVED, QC_STATUS.PARTIAL, QC_STATUS.REJECTED].includes(linkedQc.status))
      deny(`Quality Check ${linkedQcNumber} is still "${linkedQc.status}" — complete the inspection before entering the tax invoice.`);
  }

  const normalizedInvoice = String(invoiceNumber).trim();
  const duplicate = getReceipts().find(
    (r) => String(r.invoiceNumber || '').trim().toLowerCase() === normalizedInvoice.toLowerCase()
  );
  if (duplicate)
    deny(
      `Duplicate invoice number "${normalizedInvoice}" — already recorded on receipt ${duplicate.receiptNumber} for PO ${duplicate.poNumber}.`
    );

  const isReplacement = Boolean(replacementForRejection);
  const lines = items.filter((l) => num(l.receivedQty) > 0);
  if (lines.length === 0) deny('Enter a received quantity for at least one material.');
  if (isReplacement && linkedQc)
    deny('Replacement material is booked first and inspected afterwards — leave the Quality Check link empty.');

  // Shelf life capture: an expiry date must belong to an identified batch, and
  // already-expired material never enters the store (supplier handles it via
  // Debit Note instead).
  lines.forEach((l) => {
    if (l.expiryDate && getExpiryStatus(l.expiryDate).status === 'EXPIRED')
      deny(
        `Expired material refused: "${l.materialName || l.materialCode}" carries expiry date ${l.expiryDate}. Raise a Debit Note against the supplier instead of receiving it.`
      );
  });

  if (isReplacement) {
    // Replacement receipt: validated against the rejected balance that is still
    // outstanding on the Rejection Report — never against the PO pending quantity,
    // which is already 0 by the time the replacement lands.
    const replacementProgress = getPOProgress(poNumber);
    lines.forEach((line) => {
      const qty = num(line.receivedQty);
      if (qty <= 0) return;
      const key = String(line.materialCode || line.materialName || '').toLowerCase();
      const progressLine = replacementProgress.lines.find(
        (l) =>
          (line.materialCode && String(l.materialCode).toLowerCase() === key) ||
          (!line.materialCode && String(l.materialName || '').toLowerCase() === key)
      );
      if (!progressLine) deny(`"${line.materialName || line.materialCode}" is not part of PO ${poNumber}.`);
      const balance = arrivalBalanceForLine(progressLine, { replacementForRejection });
      if (qty > balance.maxQty + 1e-9)
        deny(
          `Replacement quantity ${qty} exceeds the ${balance.maxQty} ${progressLine.unit} still outstanding on ${replacementForRejection} for "${progressLine.materialName}". (Rejected ${progressLine.rejectedQty} | Replacement received ${progressLine.replacementArrivedQty})`
        );
    });
  } else {
    // On the current flow the tax invoice documents the passed quantity, so it must
    // hang off the inspection that approved it. A PO with no Material Arrival at all
    // predates this flow and keeps its original receipt-first behaviour.
    const poHasArrivals = getArrivalsForPO(poNumber).length > 0;
    if (poHasArrivals && !linkedQc)
      deny(
        `PO ${poNumber} uses Material Arrival. Record the Quality Check first — a Tax Invoice can only cover material that has passed inspection.`
      );
    if (linkedQc) {
      if (!INVOICE_ELIGIBLE_QC_STATUSES.includes(linkedQc.status))
        deny(
          `Quality Check ${linkedQcNumber} is "${linkedQc.status}" — complete the inspection before entering the tax invoice.`
        );
      validateReceiptLinesAgainstQC(linkedQc, lines);
      validateInvoiceIsWithinOrdered(poNumber, lines);
    } else {
      validateReceiptLines(poNumber, lines);
    }
  }

  const progressBefore = getPOProgress(poNumber);
  const receiptNumber = generateSequentialNumber({
    prefix: isReplacement ? 'RR' : 'REC',
    sequenceKey: isReplacement ? WF.replReceiptSeq : WF.receiptSeq,
    historyKey: WF.receipts,
    idField: 'receiptNumber'
  });
  const user = currentUser();
  const linkedDebitNote = isReplacement
    ? debitNoteNumber || (getDebitNotesForRejection(replacementForRejection)[0]?.debitNoteNumber || '')
    : '';

  const receipt = {
    receiptNumber,
    receiptDate: todayStr(),
    poNumber,
    projectId: linkedQc?.projectId || resolveProjectId({ poNumber, soNumber: po.payload?.poDetails?.salesOrderRef }),
    soNumber: po.payload?.poDetails?.salesOrderRef || linkedQc?.soNumber || '',
    indentNumber: po.payload?.poDetails?.indentRef || linkedQc?.indentNumber || '',
    vendor: po.vendor || po.payload?.vendorDetails?.companyName || '-',
    invoiceNumber: normalizedInvoice,
    invoiceDate,
    dcNumber,
    dcDate,
    vehicleNumber,
    deliveredBy,
    contactNumber,
    transporter,
    remarks,
    // A receipt raised after inspection documents an already-approved quantity,
    // so it is "Invoiced" rather than awaiting anything.
    status: linkedQc ? 'Invoiced / Quality Approved' : 'Received / Awaiting Quality Check',
    source: linkedQc ? 'Quality Check' : 'Material Receipt',
    qcStatus: linkedQc ? linkedQc.status : QC_STATUS.PENDING,
    qcNumber: linkedQcNumber || '',
    arrivalNumber: linkedQc?.arrivalNumber || '',
    // Replacement chain: this receipt answers a Rejection Report on the same PO
    // and points back at the original delivery, inspection and Debit Note.
    isReplacement,
    receiptType: isReplacement ? 'Replacement Receipt' : 'Original Receipt',
    rejectionNumber: replacementReport?.rejectionNumber || '',
    replacementForQc: replacementReport?.qcNumber || '',
    originalReceiptNumber: replacementReport?.receiptNumber || originalReceiptNumber || '',
    originalQcNumber: replacementReport?.qcNumber || '',
    debitNoteNumber: linkedDebitNote,
    postedToInventory: Boolean(linkedQc?.postedToInventory),
    inventoryPosted: Boolean(linkedQc?.postedToInventory),
    documents: documents || [],
    // The vendor invoice the Store received is shared with both downstream
    // teams: Quality (to run the inspection) and Purchase (to record it as
    // the Supplier Invoice / vendor bill for this PO).
    invoiceSharedAt: nowDateTimeStr(),
    invoiceSharedWith: ['Quality Department', 'Purchase Department'],
    supplierInvoiceNumber: '',
    items: lines.map((l) => ({
      materialCode: l.materialCode || '',
      materialName: l.materialName || '',
      unit: l.unit || 'Nos',
      orderedQty: num(l.orderedQty),
      receivedQty: num(l.receivedQty),
      pendingBefore: progressBefore.lines.find((p) => p.materialCode === l.materialCode)?.pendingQty ?? '',
      pendingAfter: 0,
      batchNumber: l.batchNumber || '',
      internalBatchId: l.internalBatchId || (!String(l.batchNumber || '').trim() ? generateInternalReceiptBatchId() : ''),
      lotNumber: l.lotNumber || '',
      mfgDate: l.mfgDate || '',
      expiryDate: l.expiryDate || '',
      remarks: l.remarks || ''
    })),
    createdBy: user.name,
    createdByEmpId: user.empId,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    history: [
      historyEntry(
        isReplacement ? 'Replacement material received' : 'Receipt entered',
        linkedQc
          ? `${lines.length} material(s) from invoice ${normalizedInvoice} against ${linkedQc.qcNumber}`
          : isReplacement
            ? `${lines.length} material(s) from invoice ${normalizedInvoice} | replacement for ${replacementForRejection}`
            : `${lines.length} material(s) from invoice ${normalizedInvoice}`
      ),
      historyEntry(
        'Tax invoice shared with Quality and Purchase',
        `Invoice ${normalizedInvoice} (PO ${poNumber}) sent to Quality for inspection and to Purchase for Supplier Invoice recording`
      )
    ]
  };

  saveList(WF.receipts, [receipt, ...getReceipts()]);
  saveSequenceCounter(isReplacement ? WF.replReceiptSeq : WF.receiptSeq, receiptNumber);

  // The replacement consumes the rejected balance on the Rejection Report. The
  // rejected quantity itself is never written off here — it only retires when the
  // replacement material passes its own Quality Check.
  if (isReplacement && replacementReport) {
    const keyOf = (l) => String(l.materialCode || l.materialName || '').trim().toLowerCase();
    const receivedByKey = new Map(lines.map((l) => [keyOf(l), num(l.receivedQty)]));
    replacementReport.items = (replacementReport.items || []).map((l) => {
      const recvQty = receivedByKey.get(keyOf(l));
      if (!recvQty) return l;
      const replacementQty = num(l.replacementQty) + recvQty;
      return {
        ...l,
        replacementQty,
        pendingReplacementQty: Math.max(0, num(l.rejectedQty) - replacementQty)
      };
    });
    replacementReport.replacementQty = replacementReport.items.reduce((a, i) => a + num(i.replacementQty), 0);
    replacementReport.pendingReplacementQty = replacementReport.items.reduce(
      (a, i) => a + Math.max(0, num(i.rejectedQty) - num(i.replacementQty)),
      0
    );
    replacementReport.replacementReceiptNumber = receiptNumber;
    replacementReport.replacementArrivedAt = nowDateTimeStr();
    replacementReport.history = [
      ...(replacementReport.history || []),
      historyEntry('Replacement material received in Store', `${receiptNumber} | awaiting quality inspection`)
    ];
    saveRejection(replacementReport);
  }

  if (linkedQc) {
    const qlist = getQualityChecks();
    const qidx = qlist.findIndex((q) => String(q.qcNumber) === String(linkedQc.qcNumber));
    if (qidx >= 0) {
      qlist[qidx] = {
        ...qlist[qidx],
        receiptNumber,
        history: [
          ...(qlist[qidx].history || []),
          historyEntry('Tax invoice recorded', `${receiptNumber} | invoice ${normalizedInvoice}`)
        ]
      };
      saveList(WF.qcs, qlist);
    }
  }

  const progressAfter = syncPOStatus(poNumber, { receiptNumber }) || getPOProgress(poNumber);
  const invoicedTotal = lines.reduce((a, l) => a + num(l.receivedQty), 0);

  log('MATERIAL RECEIPT ENTERED', receiptNumber, `PO ${poNumber} | Invoice ${normalizedInvoice} | ${lines.length} line(s)`);

  // The vendor invoice the Store recorded is handed to Quality: it is the
  // document the inspection is run against.
  notify(
    'Vendor tax invoice shared for Quality Check',
    `Vendor invoice ${normalizedInvoice} on receipt ${receiptNumber} (PO ${poNumber}, vendor ${receipt.vendor}, ${invoicedTotal} unit(s)) is shared with Quality for the inspection.${
      linkedQc ? `\nQuality Check: ${linkedQc.qcNumber}` : '\nQuality inspection is required before inventory posting.'
    }`,
    receiptNumber,
    'Production Department',
    'info',
    `/quality-checks?receipt=${encodeURIComponent(receiptNumber)}`
  );

  if (linkedQc) {
    notify(
      'Tax invoice recorded for quality-approved material',
      `Tax Invoice / Material Receipt ${receiptNumber} recorded for PO ${poNumber}.\nInvoice: ${normalizedInvoice}\nQuality Check: ${linkedQc.qcNumber}\nInvoiced Quantity: ${invoicedTotal}\nInvoice availability confirmed for Purchase.`,
      receiptNumber,
      'Purchase Department',
      'info',
      `/supplier-invoice?receipt=${encodeURIComponent(receiptNumber)}`
    );
    notify(
      'Tax invoice recorded against Quality Check',
      `Invoice ${normalizedInvoice} stored on receipt ${receiptNumber} for ${linkedQc.qcNumber} (PO ${poNumber}).`,
      receiptNumber,
      'Store Department',
      'store',
      `/material-receipts?receipt=${encodeURIComponent(receiptNumber)}`
    );
  } else {
    notify(
      isReplacement ? 'Replacement material received — Quality Check required' : 'Material Receipt entered — Quality Check required',
      `Material Receipt ${receiptNumber} against PO ${poNumber} requires quality inspection.\nInvoice: ${normalizedInvoice}\nProject ID: ${receipt.projectId || '—'}\nVendor: ${receipt.vendor}\nReceived Quantity: ${invoicedTotal}${
        isReplacement ? `\nReplacement for: ${replacementForRejection}` : ''
      }\nQuality inspection is required before inventory posting.`,
      receiptNumber,
      'Production Department',
      'info',
      `/quality-checks?receipt=${encodeURIComponent(receiptNumber)}`
    );
    if (isReplacement)
      notify(
        'Replacement delivery booked against the same PO',
        `Replacement Receipt ${receiptNumber} (invoice ${normalizedInvoice}) received against PO ${poNumber} for Rejection Report ${replacementForRejection}. Ordered quantity is unchanged; rejected balance remains until Quality approves the replacement.`,
        receiptNumber,
        'Purchase Department',
        'purchase',
        `/supplier-invoice?receipt=${encodeURIComponent(receiptNumber)}`
      );
  }

  // Purchase records the vendor invoice it received through Store as the
  // Supplier Invoice / vendor bill for this PO.
  notify(
    'Vendor tax invoice shared — record as Supplier Invoice',
    `Store recorded vendor invoice ${normalizedInvoice} on receipt ${receiptNumber} against PO ${poNumber}.\nVendor: ${receipt.vendor}\nQuantity: ${invoicedTotal}\nThis is the invoice received from the vendor — convert it into the Supplier Invoice / vendor bill for this PO.`,
    receiptNumber,
    'Purchase Department',
    'purchase',
    `/supplier-invoice?receipt=${encodeURIComponent(receiptNumber)}`
  );

  // The invoice is the last step of the chain, so its completion is what closes
  // the PO — the message reports the real remaining gates rather than assuming.
  if (progressAfter.closed) {
    notify(
      'PO Closed – Supply chain complete',
      `PO ${poNumber} is now fully received and approved.\nOrdered: ${progressAfter.ordered}\nAccepted: ${progressAfter.accepted}\nInvoiced: ${progressAfter.invoiced}`,
      poNumber,
      'Purchase Department',
      'info'
    );
  } else {
    const outstanding = [];
    if (progressAfter.pending > 0) outstanding.push(`${progressAfter.pending} not yet arrived`);
    if (progressAfter.openRejected > 0 || progressAfter.pendingReplacement > 0)
      outstanding.push(`${progressAfter.pendingReplacement} awaiting replacement`);
    if (progressAfter.pendingAccepted > 0) outstanding.push(`${progressAfter.pendingAccepted} awaiting inventory`);
    if (progressAfter.pendingInvoice > 0) outstanding.push(`${progressAfter.pendingInvoice} awaiting tax invoice`);
    notify(
      'Tax invoice recorded – PO still open',
      `PO ${poNumber}: Ordered ${progressAfter.ordered} | Arrived ${progressAfter.arrived} | Passed ${progressAfter.accepted} | Rejected ${progressAfter.rejected} | Invoiced ${progressAfter.invoiced}. Outstanding: ${
        outstanding.length ? outstanding.join(', ') : 'none'
      }.`,
      poNumber,
      'Purchase Department',
      'info'
    );
  }

  return { receipt, progress: getPOProgress(poNumber) };
};

export const updateReceiptDocuments = (receiptNumber, documents) => {
  requirePerm('receipt.create', 'Permission denied: receipt documents can only be updated by Store.');
  const receipt = getReceipt(receiptNumber);
  if (!receipt) deny(`Receipt ${receiptNumber} not found.`);
  receipt.documents = documents || [];
  receipt.history = [...(receipt.history || []), historyEntry('Documents updated', `${receipt.documents.length} file(s)`)];
  const list = getReceipts();
  const idx = list.findIndex((r) => r.receiptNumber === receiptNumber);
  list[idx] = receipt;
  saveList(WF.receipts, list);
  log('RECEIPT DOCUMENTS UPDATED', receiptNumber, `${receipt.documents.length} file(s)`);
  return receipt;
};

/* --------------------- 11B. Correcting / removing a receipt --------------------- */

const receiptLineKey = (l) => String(l.materialCode || l.materialName || '').trim().toLowerCase();

/**
 * Edit a Tax Invoice / Material Receipt that has not been posted to inventory.
 *
 * Store-only, and every create-time rule is re-checked with this receipt's own
 * quantities excluded from the PO progress — a receipt never blocks itself, so
 * an unchanged edit always passes while a raise above the PO pending / the
 * inspection's passed quantity is still refused. Header, supplier/delivery
 * details, documents and the received lines (quantity, Batch / Lot, Mfg /
 * Expiry, remarks) are all editable; a replacement booking keeps the Rejection
 * Report's consumed balance in step with the new quantity.
 */
export const updateMaterialReceipt = (receiptNumber, patch = {}) => {
  requirePerm('receipt.create', 'Permission denied: only Store can edit a Tax Invoice / Material Receipt.');
  if (!isStore()) deny('Only the Store Department can edit a Tax Invoice / Material Receipt.');

  const receipt = getReceipt(receiptNumber);
  if (!receipt) deny(`Receipt ${receiptNumber} not found.`);
  if (receipt.postedToInventory || receipt.inventoryPosted)
    deny(`${receiptNumber} has already been added to inventory — it can no longer be edited.`);
  const qc = getQualityCheckForReceipt(receiptNumber);
  if (qc && qc.postedToInventory)
    deny(`Quality Check ${qc.qcNumber} has been posted to inventory — ${receiptNumber} can no longer be edited.`);
  if (String(receipt.supplierInvoiceNumber || '').trim())
    deny(
      `Purchase already recorded Supplier Invoice ${receipt.supplierInvoiceNumber} against ${receiptNumber} — ask Purchase to correct it first.`
    );
  if (getDebitNotesForReceipt(receiptNumber).length > 0)
    deny(`A Debit Note depends on ${receiptNumber} — it can no longer be edited.`);

  const po = getPOByRef(receipt.poNumber);
  if (!po) deny(`Purchase Order ${receipt.poNumber} not found.`);
  if (po.status === 'Cancelled') deny(`PO ${receipt.poNumber} is Cancelled — ${receiptNumber} can no longer be edited.`);

  const invoiceNumber = String(patch.invoiceNumber ?? receipt.invoiceNumber ?? '').trim();
  if (!invoiceNumber) deny('Invoice Number is required.');
  const invoiceDate = patch.invoiceDate ?? receipt.invoiceDate;
  if (!invoiceDate) deny('Invoice Date is required.');
  const duplicate = getReceipts().find(
    (r) =>
      String(r.receiptNumber) !== String(receiptNumber) &&
      String(r.invoiceNumber || '').trim().toLowerCase() === invoiceNumber.toLowerCase()
  );
  if (duplicate)
    deny(
      `Duplicate invoice number "${invoiceNumber}" — already recorded on receipt ${duplicate.receiptNumber} for PO ${duplicate.poNumber}.`
    );

  const isReplacement = Boolean(receipt.isReplacement);
  const incoming = (patch.items || receipt.items || []).filter((l) => num(l.receivedQty) > 0);
  if (incoming.length === 0) deny('Enter a received quantity for at least one material.');

  // Shelf life: an expiry date belongs to an identified batch, and already
  // expired material never enters the store (the supplier is debited instead).
  incoming.forEach((l) => {
    if (l.expiryDate && !String(l.batchNumber || '').trim() && !String(l.internalBatchId || '').trim())
      deny(`Enter a supplier batch number or internal receipt-batch ID for "${l.materialName || l.materialCode}" before tracking expiry.`);
    if (l.expiryDate && getExpiryStatus(l.expiryDate).status === 'EXPIRED')
      deny(
        `Expired material refused: "${l.materialName || l.materialCode}" carries expiry date ${l.expiryDate}. Raise a Debit Note against the supplier instead of receiving it.`
      );
  });

  if (isReplacement && receipt.rejectionNumber) {
    /* Replacement material is capped by the rejected balance still outstanding
     * on the Rejection Report — which already includes this receipt's own
     * booking, so the receipt's original quantity is counted back in. */
    const ownByKey = new Map((receipt.items || []).map((l) => [receiptLineKey(l), num(l.receivedQty)]));
    const replacementProgress = getPOProgress(receipt.poNumber, { excludeReceipt: receiptNumber });
    incoming.forEach((line) => {
      const qty = num(line.receivedQty);
      if (qty <= 0) return;
      const key = receiptLineKey(line);
      const progressLine = replacementProgress.lines.find(
        (l) =>
          (line.materialCode && String(l.materialCode).toLowerCase() === key) ||
          (!line.materialCode && String(l.materialName || '').toLowerCase() === key)
      );
      if (!progressLine) deny(`"${line.materialName || line.materialCode}" is not part of PO ${receipt.poNumber}.`);
      const balance = arrivalBalanceForLine(progressLine, { replacementForRejection: receipt.rejectionNumber });
      const allowed = balance.maxQty + (ownByKey.get(key) || 0);
      if (qty > allowed + 1e-9)
        deny(
          `Replacement quantity ${qty} exceeds the ${allowed} ${progressLine.unit} available on ${receipt.rejectionNumber} for "${progressLine.materialName}".`
        );
    });
  } else if (qc) {
    if (!INVOICE_ELIGIBLE_QC_STATUSES.includes(qc.status))
      deny(
        `Quality Check ${qc.qcNumber} is "${qc.status}" — complete the inspection before editing the tax invoice.`
      );
    validateReceiptLinesAgainstQC(qc, incoming);
    validateInvoiceIsWithinOrdered(receipt.poNumber, incoming, receiptNumber);
  } else {
    const poHasArrivals = getArrivalsForPO(receipt.poNumber).length > 0;
    if (poHasArrivals)
      deny(
        `PO ${receipt.poNumber} uses Material Arrival. Record the Quality Check first — a Tax Invoice can only cover material that has passed inspection.`
      );
    validateReceiptLines(receipt.poNumber, incoming, receiptNumber);
  }

  const progressExcl = getPOProgress(receipt.poNumber, { excludeReceipt: receiptNumber });
  const user = currentUser();
  const updated = {
    ...receipt,
    invoiceNumber,
    invoiceDate,
    dcNumber: patch.dcNumber ?? receipt.dcNumber ?? '',
    dcDate: patch.dcDate ?? receipt.dcDate ?? '',
    vehicleNumber: patch.vehicleNumber ?? receipt.vehicleNumber ?? '',
    deliveredBy: patch.deliveredBy ?? receipt.deliveredBy ?? '',
    contactNumber: patch.contactNumber ?? receipt.contactNumber ?? '',
    transporter: patch.transporter ?? receipt.transporter ?? '',
    remarks: patch.remarks ?? receipt.remarks ?? '',
    documents: Array.isArray(patch.documents) ? patch.documents : receipt.documents || [],
    items: incoming.map((l) => ({
      materialCode: l.materialCode || '',
      materialName: l.materialName || '',
      unit: l.unit || 'Nos',
      orderedQty: num(l.orderedQty),
      receivedQty: num(l.receivedQty),
      pendingBefore:
        progressExcl.lines.find(
          (p) =>
            (l.materialCode && String(p.materialCode).toLowerCase() === String(l.materialCode).toLowerCase()) ||
            (!l.materialCode && String(p.materialName || '').toLowerCase() === String(l.materialName || '').toLowerCase())
        )?.pendingQty ?? '',
      pendingAfter: 0,
      batchNumber: l.batchNumber || '',
      lotNumber: l.lotNumber || '',
      mfgDate: l.mfgDate || '',
      expiryDate: l.expiryDate || '',
      remarks: l.remarks || ''
    })),
    editedBy: user.name,
    editedAt: nowDateTimeStr(),
    history: [
      ...(receipt.history || []),
      historyEntry(
        'Receipt edited',
        `${incoming.length} material(s) | invoice ${invoiceNumber} | PO ${receipt.poNumber}`
      )
    ]
  };

  // A replacement booking consumes rejected balance — keep the report in step.
  if (isReplacement && receipt.rejectionNumber) {
    const report = getRejectionReport(receipt.rejectionNumber);
    if (report) {
      const oldByKey = new Map((receipt.items || []).map((l) => [receiptLineKey(l), num(l.receivedQty)]));
      const newByKey = new Map(updated.items.map((l) => [receiptLineKey(l), num(l.receivedQty)]));
      report.items = (report.items || []).map((it) => {
        const delta = (newByKey.get(receiptLineKey(it)) || 0) - (oldByKey.get(receiptLineKey(it)) || 0);
        if (!delta) return it;
        const replacementQty = Math.max(0, num(it.replacementQty) + delta);
        return { ...it, replacementQty, pendingReplacementQty: Math.max(0, num(it.rejectedQty) - replacementQty) };
      });
      report.replacementQty = report.items.reduce((a, i) => a + num(i.replacementQty), 0);
      report.pendingReplacementQty = report.items.reduce(
        (a, i) => a + Math.max(0, num(i.rejectedQty) - num(i.replacementQty)),
        0
      );
      report.history = [
        ...(report.history || []),
        historyEntry('Replacement receipt edited', `${receiptNumber} | ${updated.items.length} line(s)`)
      ];
      saveRejection(report);
    }
  }

  const list = getReceipts();
  const idx = list.findIndex((r) => String(r.receiptNumber) === String(receiptNumber));
  if (idx < 0) deny(`Receipt ${receiptNumber} not found.`);
  list[idx] = updated;
  saveList(WF.receipts, list);

  const progressAfter = syncPOStatus(receipt.poNumber, { receiptNumber }) || getPOProgress(receipt.poNumber);
  log(
    'MATERIAL RECEIPT EDITED',
    receiptNumber,
    `PO ${receipt.poNumber} | Invoice ${invoiceNumber} | ${updated.items.length} line(s)`
  );
  return { receipt: updated, progress: progressAfter };
};

/**
 * Remove a Tax Invoice / Material Receipt that has not been posted to
 * inventory. Store-only. Everything the receipt handed downstream is put back:
 * a linked Quality Check is unlinked (so a corrected invoice can be recorded
 * again) and a replacement booking gives its consumed balance back to the
 * Rejection Report. Receipts already stocked, invoiced by Purchase or claimed
 * through a Debit Note are never removed.
 */
export const deleteMaterialReceipt = (receiptNumber, reason = '') => {
  requirePerm('receipt.create', 'Permission denied: only Store can delete a Tax Invoice / Material Receipt.');
  if (!isStore()) deny('Only the Store Department can delete a Tax Invoice / Material Receipt.');

  const receipt = getReceipt(receiptNumber);
  if (!receipt) deny(`Receipt ${receiptNumber} not found.`);
  if (receipt.postedToInventory || receipt.inventoryPosted)
    deny(`${receiptNumber} has already been added to inventory — it can no longer be deleted.`);
  const qc = getQualityCheckForReceipt(receiptNumber);
  if (qc && qc.postedToInventory)
    deny(`Quality Check ${qc.qcNumber} has been posted to inventory — ${receiptNumber} can no longer be deleted.`);
  if (String(receipt.supplierInvoiceNumber || '').trim())
    deny(
      `Purchase already recorded Supplier Invoice ${receipt.supplierInvoiceNumber} against ${receiptNumber} — void it with Purchase first.`
    );
  const debitNotes = getDebitNotesForReceipt(receiptNumber);
  if (debitNotes.length > 0)
    deny(
      `Debit Note ${debitNotes.map((d) => d.debitNoteNumber).join(', ')} depends on ${receiptNumber} — cancel it first.`
    );

  // Unlink the inspection so a corrected tax invoice can be recorded again.
  if (qc) {
    const qlist = getQualityChecks();
    const qidx = qlist.findIndex((q) => String(q.qcNumber) === String(qc.qcNumber));
    if (qidx >= 0) {
      qlist[qidx] = {
        ...qlist[qidx],
        receiptNumber: '',
        history: [
          ...(qlist[qidx].history || []),
          historyEntry('Tax invoice removed', `${receiptNumber} deleted${reason ? ` — ${reason}` : ''}`)
        ]
      };
      saveList(WF.qcs, qlist);
    }
  }

  // Give the consumed rejected balance back to the Rejection Report.
  if (receipt.isReplacement && receipt.rejectionNumber) {
    const report = getRejectionReport(receipt.rejectionNumber);
    if (report) {
      const ownByKey = new Map((receipt.items || []).map((l) => [receiptLineKey(l), num(l.receivedQty)]));
      report.items = (report.items || []).map((it) => {
        const own = ownByKey.get(receiptLineKey(it)) || 0;
        if (!own) return it;
        const replacementQty = Math.max(0, num(it.replacementQty) - own);
        return { ...it, replacementQty, pendingReplacementQty: Math.max(0, num(it.rejectedQty) - replacementQty) };
      });
      report.replacementQty = report.items.reduce((a, i) => a + num(i.replacementQty), 0);
      report.pendingReplacementQty = report.items.reduce(
        (a, i) => a + Math.max(0, num(i.rejectedQty) - num(i.replacementQty)),
        0
      );
      if (String(report.replacementReceiptNumber || '') === String(receiptNumber)) {
        report.replacementReceiptNumber = '';
        report.replacementArrivedAt = '';
      }
      report.history = [
        ...(report.history || []),
        historyEntry('Replacement receipt deleted', `${receiptNumber} removed${reason ? ` — ${reason}` : ''}`)
      ];
      saveRejection(report);
    }
  }

  const list = getReceipts().filter((r) => String(r.receiptNumber) !== String(receiptNumber));
  saveList(WF.receipts, list);
  syncPOStatus(receipt.poNumber);
  log(
    'MATERIAL RECEIPT DELETED',
    receiptNumber,
    `PO ${receipt.poNumber} | Invoice ${receipt.invoiceNumber} | ${(receipt.items || []).length} line(s)${
      reason ? ` | ${reason}` : ''
    }`
  );
  return { receiptNumber, poNumber: receipt.poNumber };
};

/* ----------------- Vendor invoice shared with Purchase → Supplier Invoice ----------------- */

const poItemFor = (poItems, line) =>
  (poItems || []).find(
    (i) =>
      (i.itemCode && String(i.itemCode).toLowerCase() === String(line.materialCode || '').toLowerCase()) ||
      (!i.itemCode &&
        String(i.itemName || '').toLowerCase() === String(line.materialName || '').toLowerCase())
  ) || null;

/** Value of the vendor invoice recorded on a receipt, priced from its PO (GST included). */
export const getReceiptInvoiceValue = (receipt) => {
  if (!receipt) return 0;
  const poItems = getPOByRef(receipt.poNumber)?.payload?.items || [];
  return (receipt.items || []).reduce((sum, l) => {
    const poItem = poItemFor(poItems, l);
    const amount = num(l.receivedQty) * (poItem ? num(poItem.unitPrice) : 0);
    return sum + amount + (poItem ? (amount * num(poItem.gst)) / 100 : 0);
  }, 0);
};

/**
 * Vendor invoices the Store recorded on Material Receipts and shared with
 * Purchase, still waiting to be converted into a Supplier Invoice / vendor bill.
 */
export const getVendorInvoicesAwaitingSupplierInvoice = () =>
  getReceipts().filter(
    (r) => String(r.invoiceNumber || '').trim() && !String(r.supplierInvoiceNumber || '').trim()
  );

/**
 * Draft a Supplier Invoice from the vendor invoice the Store recorded for a PO,
 * so Purchase does not re-type what the vendor already billed.
 */
export const getSupplierInvoicePrefill = (receiptNumber) => {
  const receipt = getReceipt(receiptNumber);
  if (!receipt) deny(`Material Receipt ${receiptNumber} not found.`);
  const poItems = getPOByRef(receipt.poNumber)?.payload?.items || [];
  return {
    receiptNumber: receipt.receiptNumber,
    poReference: receipt.poNumber || '',
    projectId: receipt.projectId || '',
    vendorName: receipt.vendor || '',
    vendorInvoiceNumber: receipt.invoiceNumber || '',
    vendorInvoiceDate: receipt.invoiceDate || '',
    notes: `Vendor bill against Purchase Order ${receipt.poNumber || '—'} | vendor invoice ${
      receipt.invoiceNumber || '—'
    } | receipt ${receipt.receiptNumber}`,
    items: (receipt.items || []).map((l) => {
      const poItem = poItemFor(poItems, l);
      return {
        itemCode: l.materialCode || poItem?.itemCode || '',
        itemName: l.materialName || poItem?.itemName || '',
        drawingNo: poItem?.drawingNo || '',
        hsnSac: poItem?.hsnSac || '',
        quantity: String(num(l.receivedQty)),
        unit: l.unit || poItem?.unit || 'Nos',
        unitPrice: poItem ? String(num(poItem.unitPrice)) : '',
        gst: poItem ? String(num(poItem.gst)) : '18'
      };
    })
  };
};

/** Purchase recorded the shared vendor invoice as the Supplier Invoice for its PO. */
export const markReceiptSupplierInvoice = (receiptNumber, supplierInvoiceNumber) => {
  requirePerm('purchase.supplier_invoice', 'Permission denied: only Purchase can record a Supplier Invoice.');
  const receipt = getReceipt(receiptNumber);
  if (!receipt) deny(`Material Receipt ${receiptNumber} not found.`);
  if (!String(supplierInvoiceNumber || '').trim()) deny('Supplier Invoice / Bill number is required.');

  receipt.supplierInvoiceNumber = String(supplierInvoiceNumber).trim();
  receipt.supplierInvoiceAt = nowDateTimeStr();
  receipt.supplierInvoiceBy = currentUser().name;
  receipt.history = [
    ...(receipt.history || []),
    historyEntry(
      'Recorded as Supplier Invoice',
      `Bill ${receipt.supplierInvoiceNumber} | vendor invoice ${receipt.invoiceNumber || '—'} | PO ${receipt.poNumber || '—'}`
    )
  ];
  const list = getReceipts();
  const idx = list.findIndex((r) => String(r.receiptNumber) === String(receiptNumber));
  if (idx >= 0) list[idx] = receipt;
  saveList(WF.receipts, list);

  log('SUPPLIER INVOICE RECORDED', receiptNumber, `PO ${receipt.poNumber} | bill ${receipt.supplierInvoiceNumber}`);
  notify(
    `Vendor invoice recorded as Supplier Invoice ${receipt.supplierInvoiceNumber}`,
    `Vendor invoice ${receipt.invoiceNumber || '—'} on receipt ${receiptNumber} (PO ${receipt.poNumber}) is recorded against ${receipt.vendor || 'the vendor'}.`,
    receiptNumber,
    'Store Department',
    'store'
  );
  return receipt;
};

/* ---------------------------- 12. Quality Check ---------------------------- */

/* --------------------------- 12. Purchase Indent → Quality Check --------------------------- */

export const getQualityChecks = () => getList(WF.qcs);
export const getQualityCheck = (qcNumber) =>
  getQualityChecks().find((q) => String(q.qcNumber) === String(qcNumber)) || null;
export const getQualityCheckForReceipt = (receiptNumber) =>
  getQualityChecks().find((q) => String(q.receiptNumber) === String(receiptNumber)) || null;
export const getQualityCheckForArrival = (arrivalNumber) =>
  getQualityChecks().find((q) => String(q.arrivalNumber || '') === String(arrivalNumber)) || null;
export const getQualityCheckForIndent = (indentNumber) =>
  getQualityChecks().find((q) => String(q.indentNumber || '') === String(indentNumber)) || null;

/** Completed inspection raised from a Purchase Indent that still needs its tax invoice / receipt. */
export const getUnlinkedQualityCheckForPO = (poNumber) =>
  getQualityChecks().find(
    (q) =>
      String(q.poNumber || '') === String(poNumber) &&
      !q.receiptNumber &&
      [QC_STATUS.APPROVED, QC_STATUS.PARTIAL, QC_STATUS.REJECTED].includes(q.status)
  ) || null;

export const getIndentsAwaitingQualityCheck = () =>
  getIndents().filter((i) => i.qcStatus === INDENT_QC_STATUS.SENT && !i.qcNumber && i.status !== INDENT_STATUS.CANCELLED);

/** Rejection reports raised against a Purchase Indent (linked through its QC). */
export const getRejectionReportsForIndent = (indentNumber) =>
  getRejectionReports().filter((r) => String(r.indentNumber || '') === String(indentNumber));

/**
 * Hand a converted Purchase Indent (with linked PO) over to Quality for inspection.
 * The Quality Check page picks it up in its inspection queue; the resulting report
 * becomes visible to Store inside the Purchase Indent.
 */
export const sendIndentToQualityCheck = (indentNumber, { remarks = '' } = {}) => {
  if (!hasPermission('indent.review') && !hasPermission('receipt.create'))
    deny('Permission denied: only Purchase/Store can send a Purchase Indent to Quality Check.');

  const indent = getIndent(indentNumber);
  if (!indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent.status === INDENT_STATUS.CANCELLED) deny('A cancelled Purchase Indent cannot be sent to Quality Check.');
  if (!indent.poNumber) deny(`Purchase Indent ${indentNumber} is not linked to a Purchase Order yet.`);
  if (indent.qcStatus === INDENT_QC_STATUS.SENT)
    deny(`Purchase Indent ${indentNumber} is already sent to Quality Check.`);
  if (getQualityCheckForIndent(indentNumber)) deny(`Quality Check already recorded for Purchase Indent ${indentNumber}.`);

  const progress = getPOProgress(indent.poNumber);
  if (progress.lines.length === 0) deny(`Purchase Order ${indent.poNumber} has no material lines.`);
  if (progress.ordered > 0 && progress.pending === 0)
    deny(`PO ${indent.poNumber} is fully received — there is no pending material left to inspect.`);

  indent.qcStatus = INDENT_QC_STATUS.SENT;
  indent.sentToQCAt = nowDateTimeStr();
  indent.sentToQCBy = currentUser().name;
  indent.sentToQCRemarks = remarks;
  updateIndentHistory(
    indent,
    'Sent to Quality Check',
    `PO ${indent.poNumber} | pending ${progress.pending} unit(s) across ${progress.lines.filter((l) => l.pendingQty > 0).length} material(s)`
  );
  const list = getIndents();
  const idx = list.findIndex((i) => String(i.indentNumber) === String(indentNumber));
  if (idx >= 0) list[idx] = indent;
  saveList(WF.indents, list);

  log('SENT TO QUALITY CHECK', indentNumber, `PO ${indent.poNumber} | ${progress.pending} unit(s) pending`);
  notify(
    'Purchase Indent sent to Quality Check',
    `Purchase Indent ${indentNumber} (PO ${indent.poNumber}) is awaiting material inspection. ${progress.pending} unit(s) pending.`,
    indentNumber,
    'Production Department',
    'info'
  );
  return indent;
};

const deriveQCStatus = (items) => {
  if (!items || items.length === 0) return QC_STATUS.PENDING;
  const totalReceived = items.reduce((a, i) => a + num(i.receivedQty), 0);
  const totalRejected = items.reduce((a, i) => a + num(i.rejectedQty), 0);
  const totalAccepted = items.reduce((a, i) => a + num(i.acceptedQty), 0);
  if (totalReceived === 0) return QC_STATUS.PENDING;
  if (totalRejected === 0 && totalAccepted === 0) return QC_STATUS.UNDER;
  if (totalRejected === 0 && totalAccepted > 0) return QC_STATUS.APPROVED;
  if (totalAccepted === 0 && totalRejected > 0) return QC_STATUS.REJECTED;
  return QC_STATUS.PARTIAL;
};

/**
 * Create or update the quality inspection for a Material Arrival, a Material
 * Receipt, or a Purchase Indent.
 *
 * In the current flow the Material Arrival is the source: Store records that
 * material physically arrived (no invoice), and this inspection splits the
 * arrived quantity into passed and rejected. Rejected quantity produces a
 * Rejection Report and stays pending against the same PO until replacement
 * material arrives and passes its own inspection.
 *
 * Validations: accepted + rejected <= arrived (per material), rejected <= arrived.
 */
export const saveQualityCheck = ({
  arrivalNumber = '',
  receiptNumber = '',
  indentNumber = '',
  inspectionDate,
  inspector = '',
  inspectorEmpId = '',
  remarks = '',
  items = [],
  documents = [],
  status: forcedStatus = ''
}) => {
  requirePerm('production.qc.manage', 'Permission denied: quality inspection is restricted to Production/Quality.');
  if (!isProduction()) deny('Only the Production/Quality Department can perform a Quality Check.');

  const sources = [arrivalNumber, receiptNumber, indentNumber].filter(Boolean);
  if (sources.length === 0)
    deny('Select a Material Arrival, Material Receipt or Purchase Indent to inspect.');
  if (sources.length > 1)
    deny('Provide exactly one source for the Quality Check — Material Arrival, Material Receipt or Purchase Indent.');

  const arrival = arrivalNumber ? getArrival(arrivalNumber) : null;
  const receipt = !arrival && receiptNumber ? getReceipt(receiptNumber) : null;
  const indent = !arrival && !receipt && indentNumber ? getIndent(indentNumber) : null;
  if (arrivalNumber && !arrival) deny(`Material Arrival ${arrivalNumber} not found.`);
  if (receiptNumber && !receipt) deny(`Material Receipt ${receiptNumber} not found.`);
  if (indentNumber && !indent) deny(`Purchase Indent ${indentNumber} not found.`);
  if (indent && !indent.poNumber) deny(`Purchase Indent ${indentNumber} is not linked to a Purchase Order yet.`);

  const source = arrival
    ? 'Material Arrival'
    : receipt
      ? 'Material Receipt'
      : 'Purchase Indent';

  const poNumber = arrival ? arrival.poNumber : receipt ? receipt.poNumber : indent.poNumber;
  const soNumber = arrival ? arrival.soNumber : receipt ? receipt.soNumber : indent.soNumber;
  const linkedIndentNumber = arrival
    ? arrival.indentNumber || ''
    : receipt
      ? receipt.indentNumber || ''
      : indent.indentNumber;
  const projectId = arrival?.projectId || receipt?.projectId || '';
  const vendor = arrival?.vendor || receipt?.vendor || '';
  const progress = getPOProgress(poNumber);

  const lines = items.filter((i) => num(i.receivedQty) > 0 || num(i.acceptedQty) > 0 || num(i.rejectedQty) > 0);
  if (lines.length === 0) deny('Enter inspection results for at least one material.');

  lines.forEach((l) => {
    const received = num(l.receivedQty);
    const accepted = num(l.acceptedQty);
    const rejected = num(l.rejectedQty);
    if (accepted < 0 || rejected < 0) deny('Quantities cannot be negative.');
    if (rejected > received) deny(`Rejected quantity ${rejected} exceeds received quantity ${received} for "${l.materialName}".`);
    if (accepted + rejected > received)
      deny(`Accepted + Rejected (${accepted + rejected}) cannot exceed Received (${received}) for "${l.materialName}".`);
    // Every received unit must be accounted for: nothing may be left undecided,
    // otherwise the receipt, the rejection and the inventory would disagree.
    if (accepted + rejected < received)
      deny(
        `Accepted + Rejected (${accepted + rejected}) must equal Received (${received}) for "${l.materialName}" — every received unit has to be accepted or rejected.`
      );

    if (arrival) {
      // The inspection may never claim more than physically arrived, and the same
      // arrival quantity can only be inspected once.
      const arrivalLine = findMatchingReceiptLine(arrival.items || [], l);
      if (!arrivalLine)
        deny(`"${l.materialName || l.materialCode}" was not part of Material Arrival ${arrivalNumber}.`);
      if (received > num(arrivalLine.arrivalQty) + 1e-9)
        deny(
          `Inspected quantity ${received} exceeds the ${num(arrivalLine.arrivalQty)} ${arrivalLine.unit} that arrived on ${arrivalNumber} for "${arrivalLine.materialName}".`
        );
    } else if (receipt) {
      const receiptLine = findMatchingReceiptLine(receipt.items || [], l);
      if (receiptLine && received > num(receiptLine.receivedQty))
        deny(`Inspected received quantity exceeds receipt quantity for "${l.materialName}".`);
    } else {
      const progressLine = progress.lines.find(
        (p) =>
          (l.materialCode && String(p.materialCode).toLowerCase() === String(l.materialCode).toLowerCase()) ||
          (!l.materialCode && String(p.materialName).toLowerCase() === String(l.materialName || '').toLowerCase())
      );
      if (!progressLine) deny(`"${l.materialName || l.materialCode}" is not part of PO ${poNumber}.`);
      if (received > progressLine.pendingQty)
        deny(
          `Inspected received quantity ${received} exceeds PO pending quantity ${progressLine.pendingQty} for "${progressLine.materialName}".`
        );
    }
  });

  const status = forcedStatus || deriveQCStatus(lines);
  const user = currentUser();
  const existing = arrival
    ? getQualityCheckForArrival(arrivalNumber)
    : receipt
      ? getQualityCheckForReceipt(receiptNumber)
      : getQualityCheckForIndent(indentNumber);
  const poRecord = getPOByRef(poNumber);

  const record = {
    ...(existing || {}),
    qcNumber: existing?.qcNumber || generateSequentialNumber({ prefix: 'QC', sequenceKey: WF.qcSeq, historyKey: WF.qcs, idField: 'qcNumber' }),
    source,
    arrivalNumber: arrival?.arrivalNumber || '',
    arrivalType:
      arrival?.arrivalType ||
      (receipt?.isReplacement ? ARRIVAL_TYPE.REPLACEMENT : ARRIVAL_TYPE.ORIGINAL),
    // An inspection of replacement material is always labelled as such, so the
    // repeated arrival → inspect → reject cycle stays readable.
    inspectionType: arrival
      ? arrival.arrivalType === ARRIVAL_TYPE.REPLACEMENT
        ? 'Replacement Inspection'
        : 'Arrival Inspection'
      : receipt
        ? receipt.isReplacement
          ? 'Replacement Inspection'
          : 'Material Receipt Inspection'
        : 'Indent Inspection',
    receiptNumber: receipt?.receiptNumber || '',
    poNumber,
    soNumber,
    projectId: projectId || resolveProjectId({ soNumber, indentNumber: linkedIndentNumber, poNumber }),
    indentNumber: linkedIndentNumber,
    vendor: vendor || poRecord?.vendor || poRecord?.payload?.vendorDetails?.companyName || '',
    invoiceNumber: receipt?.invoiceNumber || '',
    arrivalDate: arrival?.arrivalDate || '',
    dcNumber: arrival?.dcNumber || receipt?.dcNumber || '',
    vehicleNumber: arrival?.vehicleNumber || receipt?.vehicleNumber || '',
    deliveredBy: arrival?.deliveredBy || receipt?.deliveredBy || '',
    contactNumber: arrival?.contactNumber || receipt?.contactNumber || '',
    transporter: arrival?.transporter || receipt?.transporter || '',
    inspectionDate: inspectionDate || todayStr(),
    inspector: inspector || user.name,
    inspectorEmpId: inspectorEmpId || user.empId,
    inspectorDept: user.dept,
    remarks,
    status,
    items: lines.map((l) => ({
      materialCode: l.materialCode || '',
      materialName: l.materialName || '',
      unit: l.unit || 'Nos',
      receivedQty: num(l.receivedQty),
      acceptedQty: num(l.acceptedQty),
      rejectedQty: num(l.rejectedQty),
      batchNumber: l.batchNumber || '',
      internalBatchId: l.internalBatchId || (!String(l.batchNumber || '').trim() ? generateInternalReceiptBatchId() : ''),
      lotNumber: l.lotNumber || '',
      parameters: l.parameters || '',
      result: l.result || (num(l.rejectedQty) > 0 ? 'Rejected' : 'Accepted'),
      rejectionReason: l.rejectionReason || '',
      remarks: l.remarks || ''
    })),
    documents: documents || existing?.documents || [],
    postedToInventory: existing?.postedToInventory || false,
    createdBy: existing?.createdBy || user.name,
    createdByDept: existing?.createdByDept || user.dept,
    createdAt: existing?.createdAt || nowDateTimeStr(),
    updatedAt: nowDateTimeStr(),
    history: [
      ...(existing?.history || []),
      historyEntry(existing ? 'Inspection updated' : 'Inspection started', `${status} | ${lines.length} material(s)`)
    ]
  };

  const list = getQualityChecks();
  const idx = list.findIndex((q) => String(q.qcNumber) === String(record.qcNumber));
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  saveList(WF.qcs, list);
  if (!existing) saveSequenceCounter(WF.qcSeq, record.qcNumber);

  // Keep non-usable receipt material visible to lot reports while it is being
  // inspected or while accepted stock is still waiting to be posted.
  record.items.forEach((line) => {
    const sourceLines = arrival?.items || receipt?.items || [];
    const sourceLine = findMatchingReceiptLine(sourceLines, line) || {};
    addInventoryBatch({
      internalBatchId: line.internalBatchId || sourceLine.internalBatchId || '',
      batchNumber: line.batchNumber || sourceLine.batchNumber || '',
      supplierBatchNumber: line.batchNumber || sourceLine.batchNumber || '',
      lotNumber: line.lotNumber || sourceLine.lotNumber || '',
      itemCode: line.materialCode || '',
      itemName: line.materialName || '',
      supplier: vendor || '',
      grnNumber: receipt?.receiptNumber || arrival?.arrivalNumber || '',
      receivedDate: receipt?.receiptDate || arrival?.arrivalDate || todayStr(),
      receivedQty: line.receivedQty,
      acceptedQty: line.acceptedQty,
      rejectedQty: line.rejectedQty,
      qtyReceived: 0,
      availableQty: 0,
      blockedQty: line.acceptedQty,
      qcStatus: status,
      expiryDate: line.expiryDate || sourceLine.expiryDate || '',
      mfgDate: line.mfgDate || sourceLine.mfgDate || '',
      warehouse: sourceLine.warehouse || '',
      dimensions: sourceLine.dimensions || line.dimensions || {},
      status: line.rejectedQty > 0 && line.acceptedQty <= 0 ? 'Rejected / Blocked' : 'Awaiting Inventory Post'
    });
  });

  if (arrival) {
    const alist = getArrivals();
    const aidx = alist.findIndex((a) => String(a.arrivalNumber) === String(arrivalNumber));
    if (aidx >= 0) {
      const rejected = record.items.reduce((a, i) => a + i.rejectedQty, 0);
      const accepted = record.items.reduce((a, i) => a + i.acceptedQty, 0);
      alist[aidx] = {
        ...alist[aidx],
        qcStatus: status,
        qcNumber: record.qcNumber,
        status:
          rejected > 0 && accepted <= 0
            ? ARRIVAL_STATUS.FULLY_REJECTED
            : rejected > 0
              ? ARRIVAL_STATUS.PARTIAL_REJECTED
              : ARRIVAL_STATUS.QC_COMPLETED,
        inspectedAt: nowDateTimeStr(),
        history: [
          ...(alist[aidx].history || []),
          historyEntry('Quality Check completed', `${record.qcNumber} | ${status}`)
        ]
      };
      saveList(WF.arrivals, alist);
    }
  } else if (receipt) {
    const rlist = getReceipts();
    const ridx = rlist.findIndex((r) => r.receiptNumber === receiptNumber);
    if (ridx >= 0) {
      rlist[ridx] = { ...rlist[ridx], qcStatus: status, qcNumber: record.qcNumber };
      saveList(WF.receipts, rlist);
    }
  } else if (indent) {
    const ilist = getIndents();
    const iidx = ilist.findIndex((i) => String(i.indentNumber) === String(indent.indentNumber));
    if (iidx >= 0) {
      ilist[iidx] = {
        ...ilist[iidx],
        qcNumber: record.qcNumber,
        qcStatus: INDENT_QC_STATUS.DONE,
        qcResult: status,
        inspectedAt: nowDateTimeStr(),
        history: [
          ...(ilist[iidx].history || []),
          historyEntry('Quality Check completed', `${record.qcNumber} | ${status}`)
        ]
      };
      saveList(WF.indents, ilist);
    }
  }

  log('QUALITY CHECK SAVED', record.qcNumber, `${status} | PO ${poNumber} | ${source}`);

  const rejectedTotal = record.items.reduce((a, i) => a + i.rejectedQty, 0);
  const acceptedTotal = record.items.reduce((a, i) => a + i.acceptedQty, 0);
  const receivedTotal = record.items.reduce((a, i) => a + i.receivedQty, 0);
  const poStatusLabel = syncPOStatus(poNumber)?.status;

  if (rejectedTotal > 0) {
    const rejection = createRejectionReportFromQC(record);
    notify(
      'Quality Rejection Report created',
      `Rejection Report ${rejection.rejectionNumber} created from QC ${record.qcNumber} (${rejectedTotal} unit(s) rejected). Store to process the rejected material and forward documents to Purchase.`,
      rejection.rejectionNumber,
      'Store Department',
      'info',
      record.receiptNumber ? `/material-receipts?receipt=${encodeURIComponent(record.receiptNumber)}` : '/quality-checks'
    );
    notify(
      'Material rejected — replacement purchase required',
      `Material rejected during Quality Check.\nRejection Report: ${rejection.rejectionNumber}\nPO: ${poNumber}\nProject ID: ${record.projectId || '—'}\nRejected Quantity: ${rejectedTotal}\nReplacement purchase is required.`,
      rejection.rejectionNumber,
      'Purchase Department',
      'info',
      '/debit-notes'
    );
  }

  if (indent) {
    notify(
      'Quality Check report ready in Purchase Indents',
      `QC ${record.qcNumber} for Purchase Indent ${indent.indentNumber} (PO ${poNumber}): passed ${acceptedTotal} | rejected ${rejectedTotal}. Store to add the approved quantity to inventory.`,
      indent.indentNumber,
      'Store Department',
      'store'
    );
  } else {
    const isReplacement = record.arrivalType === ARRIVAL_TYPE.REPLACEMENT;
    notify(
      `Quality Check ${
        status === QC_STATUS.APPROVED
          ? 'Approved'
          : status === QC_STATUS.PARTIAL
            ? 'Partially Approved'
            : 'completed'
      }${isReplacement ? ' – Replacement Material' : ''}`,
      `Quality Check ${record.qcNumber} completed on ${record.source} ${
        record.arrivalNumber || record.receiptNumber || ''
      }.\nPO: ${poNumber}\nProject ID: ${record.projectId || '—'}\nInspection Type: ${record.inspectionType}\nInspected: ${receivedTotal}\nPassed: ${acceptedTotal}\nRejected: ${rejectedTotal}\nStore to add the passed quantity to inventory${
        rejectedTotal > 0 ? ' and process the rejected material' : ''
      } and record the tax invoice for the passed quantity.`,
      record.qcNumber,
      'Store Department',
      'store'
    );
    if (rejectedTotal > 0) {
      notify(
        'Rejected material to be processed by Store',
        `QC ${record.qcNumber}: ${rejectedTotal} unit(s) rejected against PO ${poNumber}. This quantity stays pending on the PO — process the physical return and raise a Debit Note.`,
        record.qcNumber,
        'Store Department',
        'info'
      );
    }
    if (acceptedTotal > 0) {
      notify(
        rejectedTotal > 0
          ? 'Quality partially approved the material'
          : 'Quality approved the material — Supplier Invoice can be recorded',
        `Quality Check ${record.qcNumber} passed ${acceptedTotal} of ${receivedTotal} unit(s) received on ${
          record.source
        } ${record.arrivalNumber || record.receiptNumber || ''} (PO ${poNumber}).${
          record.receiptNumber
            ? '\nThe vendor invoice received through Store can now be converted into the Supplier Invoice / vendor bill.'
            : ''
        }`,
        record.receiptNumber || record.qcNumber,
        'Purchase Department',
        'purchase',
        record.receiptNumber
          ? `/supplier-invoice?receipt=${encodeURIComponent(record.receiptNumber)}`
          : '/purchase-order'
      );
    }
  }
  if (poStatusLabel) {
    log('PO STATUS SYNCED', poNumber, `${poStatusLabel} (QC ${record.qcNumber})`);
  }

  return record;
};

/* --------------------------- 13 & 14. Rejection report --------------------------- */

export const getRejectionReports = () => getList(WF.rejections);
export const getRejectionReport = (rejectionNumber) =>
  getRejectionReports().find((r) => String(r.rejectionNumber) === String(rejectionNumber)) || null;

const saveRejection = (report) => {
  const list = getRejectionReports();
  const idx = list.findIndex((r) => String(r.rejectionNumber) === String(report.rejectionNumber));
  if (idx >= 0) list[idx] = report;
  else list.unshift(report);
  saveList(WF.rejections, list);
  return report;
};

export const createRejectionReportFromQC = (qc) => {
  const rejectedLines = (qc.items || []).filter((i) => num(i.rejectedQty) > 0);
  if (rejectedLines.length === 0) deny('No rejected quantity in this inspection.');

  const existing = getRejectionReports().find((r) => String(r.qcNumber) === String(qc.qcNumber));
  if (existing) return existing;

  const rejectionNumber = generateSequentialNumber({
    prefix: 'RRN',
    sequenceKey: WF.rejectionSeq,
    historyKey: WF.rejections,
    idField: 'rejectionNumber'
  });
  const user = currentUser();
  const report = {
    rejectionNumber,
    rejectionDate: todayStr(),
    qcNumber: qc.qcNumber,
    // The Material Arrival is the primary physical link. A receipt is only
    // present on older flows where the invoice was raised before inspection.
    arrivalNumber: qc.arrivalNumber || '',
    arrivalType: qc.arrivalType || ARRIVAL_TYPE.ORIGINAL,
    receiptNumber: qc.receiptNumber,
    indentNumber: qc.indentNumber || '',
    poNumber: qc.poNumber,
    soNumber: qc.soNumber || '',
    projectId: qc.projectId || resolveProjectId({ soNumber: qc.soNumber, indentNumber: qc.indentNumber, poNumber: qc.poNumber }),
    vendor: qc.vendor || '',
    invoiceNumber: qc.invoiceNumber || '',
    status: REJECTION_STATUS.RAISED,
    inspector: qc.inspector || user.name,
    inspectionDate: qc.inspectionDate || todayStr(),
    qualityRemarks: qc.remarks || '',
    dcNumber: '',
    dcDate: '',
    forwardRemarks: '',
    vendorRemarks: '',
    documents: qc.documents || [],
    replacementIndentNumber: '',
    replacementPoNumber: '',
    items: rejectedLines.map((l) => ({
      materialCode: l.materialCode || '',
      materialName: l.materialName || '',
      unit: l.unit || 'Nos',
      receivedQty: num(l.receivedQty),
      acceptedQty: num(l.acceptedQty),
      rejectedQty: num(l.rejectedQty),
      replacementQty: 0,
      pendingReplacementQty: num(l.rejectedQty),
      reason: l.rejectionReason || 'Quality inspection rejection',
      remarks: l.remarks || ''
    })),
    createdBy: user.name,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    history: [historyEntry('Rejection report created', `${rejectedLines.length} material(s), ${qc.qcNumber}`)]
  };
  report.rejectedTotal = report.items.reduce((a, i) => a + i.rejectedQty, 0);
  report.replacementQty = 0;
  report.pendingReplacementQty = report.rejectedTotal;
  saveList(WF.rejections, [report, ...getRejectionReports()]);
  saveSequenceCounter(WF.rejectionSeq, rejectionNumber);
  log('REJECTION REPORT CREATED', rejectionNumber, `QC ${qc.qcNumber} | PO ${qc.poNumber}`);
  return report;
};

/**
 * Raise a new Purchase Indent for the rejected quantity of a Rejection Report
 * (replacement / reorder). The replacement is a brand new Purchase Indent that
 * walks the normal chain again: Indent → Vendor Enquiry → Vendor Quotation →
 * Replacement PO → Store Receipt → Quality Check. A replacement that is rejected
 * again simply produces a new Rejection Report, so the cycle is repeatable.
 */
export const createRepurchaseIndent = (rejectionNumber) => {
  requirePerm('indent.review', 'Permission denied: only Purchase can raise a repurchase indent.');
  if (!isPurchase()) deny('Only the Purchase Department can raise a repurchase indent.');

  const report = getRejectionReport(rejectionNumber);
  if (!report) deny(`Rejection Report ${rejectionNumber} not found.`);
  if (report.repurchaseIndentNumber)
    deny(`Rejection Report ${rejectionNumber} already has replacement indent ${report.repurchaseIndentNumber}.`);
  if (!report.indentNumber) deny(`Rejection Report ${rejectionNumber} is not linked to a Purchase Indent.`);

  const source = getIndent(report.indentNumber);
  if (!source) deny(`Purchase Indent ${report.indentNumber} not found.`);

  // Re-open the report if it was already closed but still carries an open balance.
  const availableQty = (report.items || []).reduce(
    (a, l) => a + Math.max(0, num(l.rejectedQty) - num(l.replacementQty)),
    0
  );
  if (availableQty <= 0)
    deny(`Rejection Report ${rejectionNumber} has no rejected quantity still requiring replacement.`);

  const lines = (report.items || []).filter((l) => num(l.rejectedQty) - num(l.replacementQty) > 0);
  if (lines.length === 0) deny(`Rejection Report ${rejectionNumber} has no rejected quantity to repurchase.`);

  const indentNumber = generateSequentialNumber({
    prefix: 'IND',
    sequenceKey: WF.indentSeq,
    historyKey: WF.indents,
    idField: 'indentNumber'
  });
  const user = currentUser();

  const indent = {
    indentNumber,
    indentDate: todayStr(),
    soNumber: source.soNumber,
    projectId: report.projectId || source.projectId || '',
    customer: source.customer || '',
    deliveryDate: source.deliveryDate || '',
    requiredDate: source.requiredDate || '',
    reason: `Replacement purchase against Rejection Report ${rejectionNumber} (PO ${report.poNumber})`,
    storeRemarks: '',
    purchaseRemarks: `Rejected quantity re-ordered against ${rejectionNumber} (${report.vendor || 'vendor'})`,
    status: INDENT_STATUS.SUBMITTED,
    items: lines.map((l) => ({
      materialCode: l.materialCode || '',
      materialName: l.materialName,
      drawingNo: '',
      description: l.reason || '',
      unit: l.unit || 'Nos',
      requiredQty: num(l.rejectedQty) - num(l.replacementQty),
      orderedQty: num(l.rejectedQty) - num(l.replacementQty),
      availableQty: 0,
      shortageQty: num(l.rejectedQty) - num(l.replacementQty),
      purchaseQty: num(l.rejectedQty) - num(l.replacementQty),
      requiredDate: source.requiredDate || '',
      reason: `Rejected in Quality Check (RRN ${rejectionNumber})`,
      remarks: l.reason || '',
      source: `Repurchase - Rejection ${rejectionNumber}`
    })),
    additionalRequirements: [],
    clarifications: [],
    createdBy: user.name,
    createdByEmpId: user.empId,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    updatedAt: nowDateTimeStr(),
    submittedAt: nowDateTimeStr(),
    poNumber: '',
    convertedAt: '',
    repurchaseFor: rejectionNumber,
    replacementFor: report.rejectionNumber,
    replacementForPo: report.poNumber,
    replacementForQc: report.qcNumber,
    sourceIndent: source.indentNumber,
    history: [
      historyEntry('Repurchase indent created', `${lines.length} rejected material(s) from ${rejectionNumber}`),
      historyEntry('Indent submitted', 'Replacement indent submitted for Vendor Enquiry → Quotation → PO')
    ]
  };

  saveList(WF.indents, [indent, ...getIndents()]);
  saveSequenceCounter(WF.indentSeq, indentNumber);

  report.items = (report.items || []).map((l) => {
    if (num(l.rejectedQty) - num(l.replacementQty) <= 0) return l;
    return { ...l, replacementQty: num(l.replacementQty) + (num(l.rejectedQty) - num(l.replacementQty)) };
  });
  report.replacementQty = report.items.reduce((a, l) => a + num(l.replacementQty), 0);
  report.pendingReplacementQty = report.items.reduce(
    (a, l) => a + Math.max(0, num(l.rejectedQty) - num(l.replacementQty)),
    0
  );
  report.repurchaseIndentNumber = indentNumber;
  report.replacementIndentNumber = indentNumber;
  report.history = [
    ...(report.history || []),
    historyEntry('Repurchase indent raised', `${indentNumber} | ${lines.length} material(s) | ${availableQty} unit(s)`)
  ];
  saveRejection(report);

  syncPOStatus(report.poNumber, { force: true });

  log('REPURCHASE INDENT CREATED', indentNumber, `RRN ${rejectionNumber} | PO ${report.poNumber}`);
  notify(
    'Replacement purchase required',
    `Replacement Indent ${indentNumber} raised for ${availableQty} rejected unit(s) of ${rejectionNumber} (PO ${report.poNumber}). Create Vendor Enquiry → Quotation → Replacement PO.`,
    indentNumber,
    'Store Department',
    'info'
  );
  notify(
    'Replacement indent created',
    `Replacement Indent ${indentNumber} created for ${availableQty} rejected unit(s) against PO ${report.poNumber}.`,
    indentNumber,
    'Purchase Department',
    'info'
  );
  return indent;
};

export const forwardRejectionToPurchase = (rejectionNumber, { dcNumber = '', dcDate = '', forwardRemarks = '', documents = null }) => {
  requirePerm('rejection.forward', 'Permission denied: only Store can forward a rejection to Purchase.');
  if (!isStore()) deny('Only the Store Department can forward a Rejection Report to Purchase.');
  const report = getRejectionReport(rejectionNumber);
  if (!report) deny(`Rejection Report ${rejectionNumber} not found.`);
  if (![REJECTION_STATUS.RAISED, REJECTION_STATUS.WITH_STORE].includes(report.status))
    deny(`Rejection Report is in status "${report.status}" and cannot be forwarded again.`);

  report.status = REJECTION_STATUS.FORWARDED;
  report.dcNumber = dcNumber;
  report.dcDate = dcDate;
  report.forwardRemarks = forwardRemarks;
  if (documents) report.documents = documents;
  report.forwardedBy = currentUser().name;
  report.forwardedAt = nowDateTimeStr();
  report.history = [...(report.history || []), historyEntry('Forwarded to Purchase with DC', `DC ${dcNumber || '—'} | ${forwardRemarks}`)];
  saveRejection(report);

  log('REJECTION FORWARDED TO PURCHASE', rejectionNumber, `DC ${dcNumber || '-'} | PO ${report.poNumber}`);
  notify(
    'Rejection Report + DC received from Store',
    `Rejection Report ${rejectionNumber} (PO ${report.poNumber}) with DC ${dcNumber || '-'} is ready for vendor communication.`,
    rejectionNumber,
    'Purchase Department',
    'info'
  );
  return report;
};

export const sendRejectionToVendor = (rejectionNumber, { vendorRemarks = '' }) => {
  requirePerm('indent.review', 'Permission denied: only Purchase can communicate rejections to the vendor.');
  if (!isPurchase()) deny('Only the Purchase Department can send rejection documents to the vendor.');
  const report = getRejectionReport(rejectionNumber);
  if (!report) deny(`Rejection Report ${rejectionNumber} not found.`);
  if (![REJECTION_STATUS.FORWARDED, REJECTION_STATUS.WITH_STORE].includes(report.status))
    deny('Store must forward the Rejection Report + DC to Purchase before vendor communication.');

  report.status = REJECTION_STATUS.SENT_VENDOR;
  report.vendorRemarks = vendorRemarks;
  report.vendorNotifiedBy = currentUser().name;
  report.vendorNotifiedAt = nowDateTimeStr();
  report.history = [...(report.history || []), historyEntry('Sent to vendor', vendorRemarks)];
  saveRejection(report);

  log('REJECTION SENT TO VENDOR', rejectionNumber, vendorRemarks);
  notify(
    'Rejection sent to vendor',
    `Rejection Report ${rejectionNumber} (PO ${report.poNumber}) has been communicated to ${report.vendor || 'the vendor'}.`,
    rejectionNumber,
    'Store Department',
    'store'
  );
  return report;
};

/* ------------------------- 14A. Debit Note (rejected material) ------------------------- */

/* ------------------------------ debit note read helpers ------------------------------ */

export const getDebitNotes = () => getList(WF.debitNotes);
export const getDebitNote = (debitNoteNumber) =>
  getDebitNotes().find((d) => String(d.debitNoteNumber) === String(debitNoteNumber)) || null;
export const getDebitNotesForRejection = (rejectionNumber) =>
  getDebitNotes().filter((d) => String(d.rejectionNumber) === String(rejectionNumber));
export const getDebitNotesForQualityCheck = (qcNumber) =>
  getDebitNotes().filter((d) => String(d.qcNumber) === String(qcNumber));
export const getDebitNotesForReceipt = (receiptNumber) =>
  getDebitNotes().filter((d) => d.receiptNumber && String(d.receiptNumber) === String(receiptNumber));

const saveDebitNote = (note) => {
  const list = getDebitNotes();
  const idx = list.findIndex((d) => String(d.debitNoteNumber) === String(note.debitNoteNumber));
  if (idx >= 0) list[idx] = note;
  else list.unshift(note);
  saveList(WF.debitNotes, list);
  return note;
};

/* ------------------------------ line matching + pricing ------------------------------ */

/**
 * A Debit Note line always describes *purchased* material, so the tax invoice /
 * material receipt only proves that the material physically arrived — it is the
 * Purchase Order that carries the agreed rate and GST percentage. The PO is
 * therefore the single authoritative price source for a Debit Note.
 */
const findPOItemForRejectedLine = (po, line) => {
  const poItems = po?.payload?.items || [];
  const code = String(line.materialCode || '').trim().toLowerCase();
  return (
    poItems.find((it) => code && String(it.itemCode || '').trim().toLowerCase() === code) ||
    poItems.find((it) => String(it.itemName || '').trim().toLowerCase() === String(line.materialName || '').trim().toLowerCase()) ||
    null
  );
};

/** Rejected lines that still have quantity available to claim.
 *  `excludeDebitNoteNumber` lets a Debit Note that is already reserved (it is
 *  re-validated on every status change) see the balance as it was before its own
 *  quantities were counted, so an approval never blocks itself. */
const debitedQtyByLine = (rejectionNumber, excludeDebitNoteNumber = '') => {
  const map = new Map();
  getDebitNotesForRejection(rejectionNumber)
    .filter(
      (d) =>
        DEBIT_NOTE_COMMITTED_STATUSES.includes(d.status) &&
        String(d.debitNoteNumber || '') !== String(excludeDebitNoteNumber)
    )
    .forEach((d) => {
      (d.items || []).forEach((it) => {
        const key = String(it.materialCode || it.materialName || '').trim().toLowerCase();
        map.set(key, num(map.get(key)) + num(it.debitQty));
      });
    });
  return map;
};

/**
 * Build everything the Debit Note form needs for a Rejection Report, resolving
 * the linked Quality Check, Material Receipt and Purchase Order automatically so
 * the user never types a linked document number. Read-only: nothing is written.
 */
export const getDebitNoteContext = (rejectionNumber, { excludeDebitNoteNumber = '' } = {}) => {
  const report = getRejectionReport(rejectionNumber);
  if (!report) return null;

  const qc = report.qcNumber ? getQualityCheck(report.qcNumber) : null;
  const arrival = report.arrivalNumber ? getArrival(report.arrivalNumber) : null;
  const receipt = report.receiptNumber ? getReceipt(report.receiptNumber) : null;
  const po = report.poNumber ? getPOByRef(report.poNumber) : null;
  const alreadyDebited = debitedQtyByLine(rejectionNumber, excludeDebitNoteNumber);

  const lines = (report.items || [])
    .map((l) => {
      const key = String(l.materialCode || l.materialName || '').trim().toLowerCase();
      const rejectedQty = num(l.rejectedQty);
      const debitedQty = num(alreadyDebited.get(key));
      const poItem = findPOItemForRejectedLine(po, l);
      return {
        materialCode: l.materialCode || poItem?.itemCode || '',
        materialName: l.materialName || poItem?.itemName || '',
        unit: l.unit || poItem?.unit || 'Nos',
        hsnSac: poItem?.hsnSac || '',
        reason: l.reason || '',
        rejectedQty,
        debitedQty,
        remainingQty: Math.max(0, rejectedQty - debitedQty),
        // Pricing always comes from the PO. A missing rate is a data problem that
        // must stop the Debit Note — an invented price would be an incorrect claim.
        unitPrice: num(poItem?.unitPrice),
        gstPercent: num(poItem?.gst),
        priceMissing: !poItem || poItem.unitPrice === '' || poItem.unitPrice === null || poItem.unitPrice === undefined,
        // A blank GST rate must not silently become a 0% (tax-free) credit note.
        gstMissing: !poItem || poItem.gst === '' || poItem.gst === null || poItem.gst === undefined
      };
    })
    .filter((l) => l.rejectedQty > 0);

  // Pricing always from the PO; GST and HSN come from PO if available.
  const vendor = report.vendor || arrival?.vendor || receipt?.vendor || po?.payload?.vendorDetails?.companyName || '';
  const vendorDetails = {
    name: vendor,
    gstNumber: po?.payload?.vendorDetails?.gstNumber || arrival?.vendorGstNumber || receipt?.vendorGstNumber || '',
    address: po?.payload?.vendorDetails?.address || arrival?.vendorAddress || receipt?.vendorAddress || ''
  };

  // The tax invoice number we display — prefer the linked receipt (legacy),
  // then the arrival's delivery challan/invoice data, then empty string.
  const invoiceNumber = report.invoiceNumber || receipt?.invoiceNumber || arrival?.invoiceNumber || qc?.invoiceNumber || '';

  return {
    rejection: report,
    qc,
    arrival,
    receipt,
    // The valid anchors for a Debit Note: the Material Arrival that physically
    // delivered the rejected material (current flow), or a legacy receipt.
    hasArrival: Boolean(arrival),
    hasReceipt: Boolean(receipt),
    hasSource: Boolean(arrival || receipt),
    po,
    vendor,
    vendorDetails,
    invoiceNumber,
    lines,
    totalRejectedQty: lines.reduce((a, l) => a + l.rejectedQty, 0),
    totalDebitedQty: lines.reduce((a, l) => a + l.debitedQty, 0),
    totalRemainingQty: lines.reduce((a, l) => a + l.remainingQty, 0),
    fullyDebited: lines.length > 0 && lines.every((l) => l.remainingQty <= 0)
  };
};

/* ------------------------------ debit note write helpers ------------------------------ */

/**
 * Recalculate every derived money field on a Debit Note from its own items.
 * The Debit Note mirrors the PO tax treatment (single GST rate split evenly into
 * CGST / SGST) and never invents a rate: whatever the PO carried is used as-is.
 */
const recomputeDebitNoteAmounts = (note) => {
  const items = (note.items || []).map((it) => {
    const debitQty = num(it.debitQty);
    const unitPrice = num(it.unitPrice);
    const gstPercent = num(it.gstPercent);
    const amount = calculateLineAmount(debitQty, unitPrice);
    const gstAmount = calculateGSTAmount(amount, gstPercent);
    return {
      ...it,
      debitQty,
      unitPrice,
      gstPercent,
      amount,
      gstAmount,
      cgstAmount: Number((gstAmount / 2).toFixed(2)),
      sgstAmount: Number((gstAmount / 2).toFixed(2)),
      lineTotal: Number((amount + gstAmount).toFixed(2))
    };
  });
  note.items = items;

  const totals = calculateTotals(items, 0);
  note.subtotal = totals.subtotal;
  note.taxableAmount = totals.taxableAmount;
  note.totalGST = Number(totals.totalGST.toFixed(2));
  note.cgst = totals.cgst;
  note.sgst = totals.sgst;
  note.grandTotal = totals.grandTotal;
  note.totalDebitQty = items.reduce((a, it) => a + it.debitQty, 0);
  // numberToWords already renders the currency word (e.g. "One Thousand Rupees").
  note.amountInWords = `${numberToWords(totals.grandTotal)} only`;
  return note;
};

/**
 * Validate a proposed Debit Note against the persisted workflow and return the
 * normalised, priced note. This is the single guard used by both create and
 * update so the browser and the storage layer enforce identical rules.
 */
const validateAndBuildDebitNote = ({ rejectionNumber, debitNoteDate, items, remarks, excludeDebitNoteNumber = '' }) => {
  const report = getRejectionReport(rejectionNumber);
  if (!report) deny(`Rejection Report ${rejectionNumber} not found.`);

  /**
   * A Debit Note is anchored on the Material Arrival that physically brought the
   * rejected material in, together with its Quality Check and Rejection Report. A
   * tax invoice is *not* required: in the current flow the invoice only covers
   * passed material, so requiring it would make a rejected-material claim
   * impossible to raise. Pricing still comes solely from the Purchase Order.
   */
  const arrival = report.arrivalNumber ? getArrival(report.arrivalNumber) : null;
  const receipt = report.receiptNumber ? getReceipt(report.receiptNumber) : null;
  if (!arrival && !receipt)
    deny(
      `Rejection Report ${rejectionNumber} is not linked to a Material Arrival. Record the arrival that delivered the rejected material before raising a Debit Note.`
    );

  const po = report.poNumber ? getPOByRef(report.poNumber) : null;
  if (!po) deny(`Purchase Order ${report.poNumber} not found — original PO pricing is required.`);

  const ctx = getDebitNoteContext(rejectionNumber, { excludeDebitNoteNumber });
  if (!ctx.lines.length) deny(`Rejection Report ${rejectionNumber} has no rejected quantity.`);

  const requested = (items || []).filter((it) => num(it.debitQty) > 0);
  if (requested.length === 0) deny('Enter a debit quantity for at least one material.');

  const seen = new Set();
  const normalised = requested.map((it) => {
    const key = String(it.materialCode || it.materialName || '').trim().toLowerCase();
    const line = ctx.lines.find(
      (l) => String(l.materialCode || l.materialName || '').trim().toLowerCase() === key
    );
    if (!line)
      deny(`"${it.materialName || it.materialCode}" is not a rejected line on Rejection Report ${rejectionNumber}.`);
    if (seen.has(key)) deny(`"${line.materialName}" is listed twice on the Debit Note.`);
    seen.add(key);

    const debitQty = num(it.debitQty);
    if (debitQty <= 0) deny(`Debit quantity for "${line.materialName}" must be greater than zero.`);
    if (debitQty > line.remainingQty + 1e-9)
      deny(
        `Debit quantity for "${line.materialName}" is ${debitQty} but only ${line.remainingQty} ${line.unit} of the ${line.rejectedQty} rejected is still unclaimed.`
      );
    if (line.priceMissing)
      deny(
        `Purchase Order ${report.poNumber} has no rate for "${line.materialName}". Add the PO rate before raising a Debit Note.`
      );
    if (line.gstMissing)
      deny(
        `Purchase Order ${report.poNumber} has no GST rate for "${line.materialName}". Add the GST rate before raising a Debit Note — it cannot be assumed.`
      );

    return {
      materialCode: line.materialCode,
      materialName: line.materialName,
      unit: line.unit,
      hsnSac: line.hsnSac,
      reason: line.reason,
      rejectedQty: line.rejectedQty,
      previouslyDebitedQty: line.debitedQty,
      remainingBeforeThisNote: line.remainingQty,
      debitQty,
      unitPrice: line.unitPrice,
      gstPercent: line.gstPercent
    };
  });

  const user = currentUser();
  return recomputeDebitNoteAmounts({
    debitNoteNumber: '',
    debitNoteDate: debitNoteDate || todayStr(),
    status: DEBIT_NOTE_STATUS.DRAFT,
    // Every linked document is resolved from the workflow, never typed in.
    rejectionNumber: report.rejectionNumber,
    rejectionDate: report.rejectionDate,
    qcNumber: report.qcNumber || '',
    qcDate: report.inspectionDate || '',
    inspector: report.inspector || '',
    receiptNumber: receipt.receiptNumber,
    receiptDate: receipt.createdAt || '',
    invoiceNumber: report.invoiceNumber || receipt.invoiceNumber || '',
    invoiceDate: receipt.invoiceDate || '',
    poNumber: report.poNumber,
    poDate: po?.date || po?.createdAt || '',
    indentNumber: report.indentNumber || '',
    soNumber: report.soNumber || '',
    projectId: report.projectId || '',
    vendor: ctx.vendor,
    vendorGstNumber: ctx.vendorDetails.gstNumber,
    vendorAddress: ctx.vendorDetails.address,
    qualityRemarks: report.qualityRemarks || '',
    rejectionRemarks: report.forwardRemarks || report.vendorRemarks || '',
    remarks: remarks || '',
    documents: [],
    items: normalised,
    createdBy: user.name,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    history: []
  });
};

/**
 * Create a Debit Note for rejected material. Reuses the existing rejected
 * quantity only — it never creates a receipt, never touches inventory, and never
 * changes the linked PO, receipt, QC or Rejection Report.
 */
export const createDebitNote = ({ rejectionNumber, debitNoteDate, items, remarks = '', documents = null }) => {
  requirePerm('debitnote.create', 'Permission denied: you cannot raise a Debit Note.');
  if (!rejectionNumber) deny('Select the Rejection Report this Debit Note belongs to.');

  const note = validateAndBuildDebitNote({ rejectionNumber, debitNoteDate, items, remarks });

  note.debitNoteNumber = generateSequentialNumber({
    prefix: 'DN',
    sequenceKey: WF.debitNoteSeq,
    historyKey: WF.debitNotes,
    idField: 'debitNoteNumber'
  });
  if (getDebitNote(note.debitNoteNumber)) deny(`Debit Note ${note.debitNoteNumber} already exists.`);

  note.history = [historyEntry('Debit note drafted', `${note.items.length} material(s), ${note.grandTotal}`)];
  if (documents) note.documents = documents;
  saveDebitNote(note);
  saveSequenceCounter(WF.debitNoteSeq, note.debitNoteNumber);

  log('DEBIT NOTE DRAFTED', note.debitNoteNumber, `RRN ${rejectionNumber} | PO ${note.poNumber} | ${note.grandTotal}`);
  return note;
};

/** Re-validate and store changes to a Draft Debit Note. Issued notes are locked. */
export const updateDebitNote = (debitNoteNumber, patch = {}) => {
  requirePerm('debitnote.create', 'Permission denied: you cannot edit a Debit Note.');
  const existing = getDebitNote(debitNoteNumber);
  if (!existing) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (existing.status !== DEBIT_NOTE_STATUS.DRAFT)
    deny(`Debit Note ${debitNoteNumber} is already issued and can no longer be edited.`);

  const merged = validateAndBuildDebitNote({
    rejectionNumber: existing.rejectionNumber,
    debitNoteDate: patch.debitNoteDate ?? existing.debitNoteDate,
    items: patch.items ?? existing.items,
    remarks: patch.remarks ?? existing.remarks
  });

  const note = {
    ...existing,
    ...merged,
    debitNoteNumber: existing.debitNoteNumber,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    documents: patch.documents ?? existing.documents ?? [],
    updatedAt: nowDateTimeStr(),
    history: [
      ...(existing.history || []),
      historyEntry('Debit note updated', `${merged.items.length} material(s), ${merged.grandTotal}`)
    ]
  };
  saveDebitNote(note);
  log('DEBIT NOTE UPDATED', note.debitNoteNumber, `RRN ${note.rejectionNumber} | ${note.grandTotal}`);
  return note;
};

/**
 * Issue a Debit Note.
 *
 * ONLY an Admin-approved Debit Note may be issued — there is deliberately no
 * "Draft → Issued" shortcut, so neither the Purchase review nor the Admin
 * approval can be skipped.
 *
 * From this point its quantities are committed against the Rejection Report, so
 * the same rejected material cannot be claimed twice.
 */
export const issueDebitNote = (debitNoteNumber) => {
  requirePerm('debitnote.create', 'Permission denied: you cannot issue a Debit Note.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (DEBIT_NOTE_ISSUED_STATUSES.includes(note.status)) deny(`Debit Note ${debitNoteNumber} is already issued.`);
  if (note.status !== DEBIT_NOTE_STATUS.APPROVED)
    deny(
      note.status === DEBIT_NOTE_STATUS.ADMIN_REVIEW
        ? `Debit Note ${debitNoteNumber} is awaiting Admin approval — the Admin must approve it before Purchase can issue it to the vendor.`
        : note.status === DEBIT_NOTE_STATUS.DRAFT
          ? `Debit Note ${debitNoteNumber} is still a Draft — submit it for Admin approval first; Purchase can only issue a Debit Note the Admin has approved.`
          : `Debit Note ${debitNoteNumber} is "${note.status}" — the Admin must approve it before Purchase can issue it to the vendor.`
    );

  // Re-validate against live data in case the rejection changed since drafting.
  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const issued = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.ISSUED,
    documents: note.documents || [],
    createdBy: note.createdBy,
    createdAt: note.createdAt,
    issuedAt: nowDateTimeStr(),
    issuedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry(
        'Debit note issued to vendor',
        `${fresh.items.length} material(s), ${fresh.grandTotal} | approved by Admin before issue`
      )
    ]
  };
  saveDebitNote(issued);

  // Read-only back-reference on the Rejection Report. No quantity, status or
  // document on the PO / receipt / QC is altered.
  const report = getRejectionReport(issued.rejectionNumber);
  if (report) {
    report.debitNoteNumbers = [...new Set([...(report.debitNoteNumbers || []), issued.debitNoteNumber])];
    report.debitNoteQty = num(report.debitNoteQty) + num(issued.totalDebitQty);
    report.history = [
      ...(report.history || []),
      historyEntry('Debit note issued', `${issued.debitNoteNumber} · ${issued.grandTotal}`)
    ];
    saveRejection(report);
  }

  log('DEBIT NOTE ISSUED', issued.debitNoteNumber, `RRN ${issued.rejectionNumber} | PO ${issued.poNumber} | ${issued.grandTotal}`);
  notify(
    `Debit Note ${issued.debitNoteNumber} issued`,
    `${issued.grandTotal} claimed from ${issued.vendor || 'vendor'} for rejected material on Rejection Report ${issued.rejectionNumber}.`,
    issued.debitNoteNumber,
    'Purchase Department',
    'purchase'
  );
  return issued;
};

/* ------------- Debit Note approval chain: Request → Purchase review → approve ------------- */

/**
 * Store raises the Debit Note Request. The rejected quantity is reserved from
 * this point (a Draft is still free to edit or abandon), so a second Debit Note
 * cannot be raised on the same rejected material while this one is in flight.
 *
 * The request goes straight to ADMIN APPROVAL — the Admin must approve it
 * before the Purchase Department may take it up, issue it and send it to the
 * vendor. Store keeps visibility of its own request.
 */
export const submitDebitNoteRequest = (debitNoteNumber) => {
  requirePerm('debitnote.create', 'Permission denied: you cannot submit a Debit Note request.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (note.status !== DEBIT_NOTE_STATUS.DRAFT)
    deny(`Debit Note ${debitNoteNumber} is "${note.status}" — only a Draft Debit Note can be sent for Admin approval.`);

  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const requested = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.ADMIN_REVIEW,
    documents: note.documents || [],
    requestedAt: nowDateTimeStr(),
    requestedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry(
        'Debit note request raised',
        `${fresh.items.length} material(s), ${fresh.grandTotal} — sent to Admin for approval`
      )
    ]
  };
  saveDebitNote(requested);
  log('DEBIT NOTE SENT FOR ADMIN APPROVAL', requested.debitNoteNumber, `RRN ${requested.rejectionNumber} | PO ${requested.poNumber} | ${requested.grandTotal}`);
  notify(
    `Debit Note ${requested.debitNoteNumber} awaits your approval`,
    `Store raised a Debit Note Request of ${requested.grandTotal} against ${requested.vendor || 'vendor'} for Rejection Report ${requested.rejectionNumber}. Admin approval is required before the Purchase Department may proceed and send it to the vendor.`,
    requested.debitNoteNumber,
    'Admin',
    'approval'
  );
  notify(
    `Debit Note ${requested.debitNoteNumber} raised — awaiting Admin approval`,
    `Your Debit Note Request of ${requested.grandTotal} against ${requested.vendor || 'vendor'} for Rejection Report ${requested.rejectionNumber} is with the Admin for approval. Purchase takes it up only after the Admin approves.`,
    requested.debitNoteNumber,
    'Store Department',
    'store'
  );
  return requested;
};

/** Purchase opens a Debit Note Request for review. */
export const reviewDebitNote = (debitNoteNumber) => {
  requirePerm('debitnote.record', 'Permission denied: only Purchase can review a Debit Note.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (note.status !== DEBIT_NOTE_STATUS.REQUESTED)
    deny(`Debit Note ${debitNoteNumber} is "${note.status}" — only a Requested Debit Note can be taken up for review.`);

  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const reviewed = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.PURCHASE_REVIEW,
    reviewedAt: nowDateTimeStr(),
    reviewedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry('Purchase review started', `${fresh.grandTotal} against ${fresh.vendor || 'vendor'}`)
    ]
  };
  saveDebitNote(reviewed);
  log('DEBIT NOTE UNDER PURCHASE REVIEW', reviewed.debitNoteNumber, `RRN ${reviewed.rejectionNumber} | ${reviewed.grandTotal}`);
  return reviewed;
};

/**
 * Purchase authorises the reviewed Debit Note. The note does NOT become
 * issuable yet: it moves to Admin Approval, and only the Admin can take it
 * to APPROVED (after which Purchase issues it to the vendor).
 */
export const approveDebitNote = (debitNoteNumber) => {
  requirePerm('debitnote.record', 'Permission denied: only Purchase can authorise a Debit Note.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (note.status !== DEBIT_NOTE_STATUS.PURCHASE_REVIEW)
    deny(`Debit Note ${debitNoteNumber} is "${note.status}" — start the Purchase review before authorising it.`);

  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const authorised = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.ADMIN_REVIEW,
    purchaseAuthorizedAt: nowDateTimeStr(),
    purchaseAuthorizedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry('Purchase authorised the debit note', `${fresh.items.length} material(s), ${fresh.grandTotal} — sent to Admin for approval`)
    ]
  };
  saveDebitNote(authorised);
  log('DEBIT NOTE SENT FOR ADMIN APPROVAL', authorised.debitNoteNumber, `RRN ${authorised.rejectionNumber} | PO ${authorised.poNumber} | ${authorised.grandTotal}`);
  notify(
    `Debit Note ${authorised.debitNoteNumber} awaits your approval`,
    `Purchase authorised the Debit Note of ${authorised.grandTotal} against ${authorised.vendor || 'vendor'} for Rejection Report ${authorised.rejectionNumber}. Admin approval is required before Purchase can issue it to the vendor.`,
    authorised.debitNoteNumber,
    'Admin',
    'approval'
  );
  return authorised;
};

/**
 * Admin approves the Debit Note. The note is handed over to the Purchase
 * Department, which may now issue it and send it to the vendor together with
 * the rejection reasons (issue → send to vendor → close).
 */
export const approveDebitNoteByAdmin = (debitNoteNumber) => {
  requirePerm('debitnote.admin_approve', 'Permission denied: only the Admin can approve a Debit Note.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (note.status !== DEBIT_NOTE_STATUS.ADMIN_REVIEW)
    deny(
      `Debit Note ${debitNoteNumber} is "${note.status}" — only a Debit Note awaiting Admin approval can be approved.`
    );

  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const approved = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.APPROVED,
    adminApprovedAt: nowDateTimeStr(),
    adminApprovedBy: currentUser().name,
    approvedAt: nowDateTimeStr(),
    approvedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry(
        'Debit note approved by Admin',
        `${fresh.items.length} material(s), ${fresh.grandTotal} — sent to Purchase to issue and send to the vendor`
      )
    ]
  };
  saveDebitNote(approved);
  log('DEBIT NOTE APPROVED BY ADMIN', approved.debitNoteNumber, `RRN ${approved.rejectionNumber} | PO ${approved.poNumber} | ${approved.grandTotal}`);
  notify(
    `Debit Note ${approved.debitNoteNumber} approved by Admin — send it to ${approved.vendor || 'the vendor'}`,
    `Admin approved the Debit Note of ${approved.grandTotal} against ${approved.vendor || 'vendor'} for Rejection Report ${approved.rejectionNumber}. `
      + `Rejection reasons: ${rejectionSummaryText(approved)}. Issue the Debit Note and send it to the vendor with these rejection details.`,
    approved.debitNoteNumber,
    'Purchase Department',
    'purchase'
  );
  notify(
    `Debit Note ${approved.debitNoteNumber} approved`,
    `Admin approved the Debit Note of ${approved.grandTotal} against ${approved.vendor || 'vendor'}. It has been handed over to the Purchase Department to send to the vendor.`,
    approved.debitNoteNumber,
    'Store Department',
    'store'
  );
  return approved;
};

/**
 * One-line summary of why the material was rejected, built from the Debit Note
 * lines. Used in notifications and in the vendor hand-over record so Purchase
 * always forwards the reason along with the claim.
 */
export const rejectionSummaryText = (note) => {
  const lines = (note?.items || []).filter((it) => num(it.debitQty) > 0 || num(it.rejectedQty) > 0);
  if (!lines.length) return note?.qualityRemarks || note?.rejectionRemarks || 'Quality inspection rejection';
  return lines
    .map((it) => `${it.materialName} × ${num(it.debitQty) || num(it.rejectedQty)} ${it.unit || ''} — ${it.reason || 'Quality inspection rejection'}`)
    .join('; ');
};

/**
 * Build the rejection notice Purchase forwards to the vendor: exactly what was
 * rejected, how much, and why — sourced from the Rejection Report / QC, never
 * typed in.
 */
export const buildVendorRejectionNotice = (note) => ({
  sentAt: nowDateTimeStr(),
  sentBy: currentUser().name,
  vendor: note.vendor || '',
  vendorGstNumber: note.vendorGstNumber || '',
  debitNoteNumber: note.debitNoteNumber,
  rejectionNumber: note.rejectionNumber || '',
  qcNumber: note.qcNumber || '',
  receiptNumber: note.receiptNumber || '',
  poNumber: note.poNumber || '',
  qualityRemarks: note.qualityRemarks || '',
  rejectionRemarks: note.rejectionRemarks || '',
  lines: (note.items || [])
    .filter((it) => num(it.debitQty) > 0 || num(it.rejectedQty) > 0)
    .map((it) => ({
      materialCode: it.materialCode || '',
      materialName: it.materialName,
      unit: it.unit || '',
      rejectedQty: num(it.rejectedQty),
      debitQty: num(it.debitQty),
      reason: it.reason || 'Quality inspection rejection'
    }))
});

/**
 * Purchase hands the issued Debit Note to the vendor — together with the
 * rejection notice, so the vendor is told exactly what was rejected, how much,
 * and why (from the Rejection Report / QC, never typed in).
 */
export const sendDebitNoteToVendor = (debitNoteNumber) => {
  requirePerm('debitnote.record', 'Permission denied: only Purchase can send a Debit Note to the vendor.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (![DEBIT_NOTE_STATUS.ISSUED, DEBIT_NOTE_STATUS.CREATED, DEBIT_NOTE_STATUS.SENT].includes(note.status))
    deny(`Debit Note ${debitNoteNumber} is "${note.status}" — issue the Debit Note before sending it to the vendor.`);

  const notice = buildVendorRejectionNotice(note);
  const reasons = rejectionSummaryText(note);

  const sent = {
    ...note,
    status: DEBIT_NOTE_STATUS.SENT_VENDOR,
    vendorNotice: notice,
    sentToVendorAt: notice.sentAt,
    sentToVendorBy: notice.sentBy,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry(
        'Debit note sent to vendor with rejection reasons',
        `${note.grandTotal} claimed from ${note.vendor || 'vendor'} | ${reasons}`
      )
    ]
  };
  saveDebitNote(sent);
  log('DEBIT NOTE SENT TO VENDOR', sent.debitNoteNumber, `RRN ${sent.rejectionNumber} | ${sent.grandTotal} | ${reasons}`);
  notify(
    `Debit Note ${sent.debitNoteNumber} sent to ${sent.vendor || 'vendor'} with rejection reasons`,
    `Purchase forwarded the Debit Note of ${sent.grandTotal} for Rejection Report ${sent.rejectionNumber} to ${sent.vendor || 'vendor'}.\n`
      + `Reason(s) for rejection: ${reasons}.`
      + (sent.qualityRemarks ? `\nQuality remarks: ${sent.qualityRemarks}` : '')
      + `\nReplacement material is awaited — the Debit Note closes after it is received and passes Quality Check.`,
    sent.debitNoteNumber,
    'Store Department',
    'store'
  );
  return sent;
};

/**
 * Purchase closes the Debit Note.
 *
 * Normally this happens only once the replacement material has been received
 * and passed Quality Check (i.e. the Rejection Report has no pending
 * replacement left), so the claim is not settled before the loop is complete.
 * The Admin may force-close a note where the vendor settled by credit note
 * without sending a replacement.
 */
export const closeDebitNote = (debitNoteNumber, { force = false } = {}) => {
  requirePerm('debitnote.record', 'Permission denied: only Purchase can close a Debit Note.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (![DEBIT_NOTE_STATUS.SENT_VENDOR, DEBIT_NOTE_STATUS.RECORDED].includes(note.status))
    deny(`Debit Note ${debitNoteNumber} is "${note.status}" — send it to the vendor before closing.`);

  let closureNote = '';
  const canForceClose = hasPermission('debitnote.admin_approve');
  if (force && !canForceClose)
    deny('Permission denied: only the Admin can force-close a Debit Note without a replacement.');
  if (!force) {
    const report = getRejectionReport(note.rejectionNumber);
    const pending = report ? num(report.pendingReplacementQty ?? report.rejectedTotal) : 0;
    if (pending > 0) {
      if (!canForceClose)
        deny(
          `Debit Note ${debitNoteNumber} cannot be closed yet: ${pending} unit(s) on Rejection Report ${note.rejectionNumber} are still awaiting replacement. `
            + `Store must receive the replacement material and Quality must inspect it first — only the Admin can force-close without a replacement.`
        );
      closureNote = ` | force-closed by Admin with ${pending} unit(s) of replacement still pending`;
    }
  }

  const closed = {
    ...note,
    status: DEBIT_NOTE_STATUS.CLOSED,
    closedAt: nowDateTimeStr(),
    closedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry('Debit note closed', `${note.grandTotal} settled with ${note.vendor || 'vendor'}${closureNote}`)
    ]
  };
  saveDebitNote(closed);
  log('DEBIT NOTE CLOSED', closed.debitNoteNumber, `RRN ${closed.rejectionNumber} | ${closed.grandTotal}`);
  notify(
    `Debit Note ${closed.debitNoteNumber} closed`,
    `Debit Note of ${closed.grandTotal} against ${closed.vendor || 'vendor'} is closed for Rejection Report ${closed.rejectionNumber}.`,
    closed.debitNoteNumber,
    'Store Department',
    'store'
  );
  return closed;
};


/**
 * Send a Debit Note from Issued to the Purchase Department.
 * Changes the status from CREATED to SENT, making the note visible to Purchase
 * for vendor communication and recording the credit.
 */
export const sendDebitNoteToPurchase = (debitNoteNumber) => {
  requirePerm('debitnote.record', 'Permission denied: only Purchase can send a Debit Note to the vendor.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (note.status !== DEBIT_NOTE_STATUS.CREATED)
    deny(`Debit Note ${debitNoteNumber} is already "${note.status}" and cannot be sent.`);
  if (note.arrivalNumber === '' && note.receiptNumber === '')
    deny(`Debit Note ${debitNoteNumber} must be linked to a Material Arrival or Material Receipt.`);

  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const sent = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.SENT,
    documents: note.documents || [],
    createdBy: note.createdBy,
    createdAt: note.createdAt,
    sentAt: nowDateTimeStr(),
    sentBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry('Debit note sent to Purchase', `${fresh.items.length} material(s), ${fresh.grandTotal}`)
    ]
  };
  saveDebitNote(sent);

  // Read-only back-reference on the Rejection Report.
  const report = getRejectionReport(sent.rejectionNumber);
  if (report) {
    report.debitNoteNumbers = [...new Set([...(report.debitNoteNumbers || []), sent.debitNoteNumber])];
    report.debitNoteQty = num(report.debitNoteQty) + num(sent.totalDebitQty);
    report.history = [
      ...(report.history || []),
      historyEntry('Debit note sent to Purchase', `${sent.debitNoteNumber} · ${sent.grandTotal}`)
    ];
    saveRejection(report);
  }

  log('DEBIT NOTE SENT TO PURCHASE', sent.debitNoteNumber, `RRN ${sent.rejectionNumber} | PO ${sent.poNumber} | ${sent.grandTotal}`);
  notify(
    `Debit Note ${sent.debitNoteNumber} sent to Purchase`,
    `${sent.grandTotal} claimed from ${sent.vendor || 'vendor'} for rejected material on RRN ${sent.rejectionNumber}. Sent to Purchase Department for vendor communication.`,
    sent.debitNoteNumber,
    'Purchase Department',
    'purchase'
  );
  return sent;
};

/**
 * Record a Debit Note that has been sent to Purchase. Changes the status from SENT
 * to RECORDED, indicating the Purchase Department has confirmed the credit note
 * against the vendor and the financial claim is now official.
 */
export const recordDebitNote = (debitNoteNumber) => {
  requirePerm('debitnote.record', 'Permission denied: only Purchase can record a Debit Note.');
  const note = getDebitNote(debitNoteNumber);
  if (!note) deny(`Debit Note ${debitNoteNumber} not found.`);
  if (note.status !== DEBIT_NOTE_STATUS.SENT)
    deny(`Debit Note ${debitNoteNumber} is already "${note.status}" and cannot be recorded.`);
  if (note.arrivalNumber === '' && note.receiptNumber === '')
    deny(`Debit Note ${debitNoteNumber} must be linked to a Material Arrival or Material Receipt.`);

  const fresh = validateAndBuildDebitNote({
    rejectionNumber: note.rejectionNumber,
    debitNoteDate: note.debitNoteDate,
    items: note.items,
    remarks: note.remarks,
    excludeDebitNoteNumber: note.debitNoteNumber
  });

  const recorded = {
    ...note,
    ...fresh,
    debitNoteNumber: note.debitNoteNumber,
    status: DEBIT_NOTE_STATUS.RECORDED,
    documents: note.documents || [],
    createdBy: note.createdBy,
    createdAt: note.createdAt,
    recordedAt: nowDateTimeStr(),
    recordedBy: currentUser().name,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(note.history || []),
      historyEntry('Debit note recorded', `${fresh.items.length} material(s), ${fresh.grandTotal}`)
    ]
  };
  saveDebitNote(recorded);

  // Read-only back-reference on the Rejection Report.
  const report = getRejectionReport(recorded.rejectionNumber);
  if (report) {
    report.debitNoteNumbers = [...new Set([...(report.debitNoteNumbers || []), recorded.debitNoteNumber])];
    report.debitNoteQty = num(report.debitNoteQty) + num(recorded.totalDebitQty);
    report.history = [
      ...(report.history || []),
      historyEntry('Debit note recorded', `${recorded.debitNoteNumber} · ${recorded.grandTotal}`)
    ];
    saveRejection(report);
  }

  log('DEBIT NOTE RECORDED', recorded.debitNoteNumber, `RRN ${recorded.rejectionNumber} | PO ${recorded.poNumber} | ${recorded.grandTotal}`);
  notify(
    `Debit Note ${recorded.debitNoteNumber} recorded`,
    `${recorded.grandTotal} recorded from ${recorded.vendor || 'vendor'} for rejected material on RRN ${recorded.rejectionNumber}. The credit has been confirmed against the vendor.`,
    recorded.debitNoteNumber,
    'Purchase Department',
    'purchase'
  );
  return recorded;
};

/** Summary used by the PO progress / rejection screens for read-only display. */
export const getDebitNoteSummaryForRejection = (rejectionNumber) => {
  const notes = getDebitNotesForRejection(rejectionNumber);
  return {
    count: notes.length,
    numbers: notes.map((d) => d.debitNoteNumber),
    committedQty: notes
      .filter((d) => DEBIT_NOTE_COMMITTED_STATUSES.includes(d.status))
      .reduce((a, d) => a + num(d.totalDebitQty), 0),
    committedValue: notes
      .filter((d) => DEBIT_NOTE_COMMITTED_STATUSES.includes(d.status))
      .reduce((a, d) => a + num(d.grandTotal), 0),
    notes
  };
};

/* ------------------- 15 & 16. Quality approval → Inventory ------------------- */

/** QC outcomes that allow accepted material into available inventory. */
export const INVENTORY_ELIGIBLE_QC_STATUSES = [QC_STATUS.APPROVED, QC_STATUS.PARTIAL];

/**
 * The ONLY path that increases available inventory.
 *
 * Service-layer guarantees (cannot be bypassed from the UI):
 *   1. A Quality Check record must exist.
 *   2. Its status must be Approved or Partially Approved.
 *   3. Accepted quantity must be > 0 and must never exceed the inspected received
 *      quantity — rejected quantity is never posted.
 *   4. Posting is idempotent per material line: a line that is already posted is
 *      skipped instead of being added twice.
 */
export const postApprovedMaterialToInventory = (qcNumber) => {
  requirePerm('receipt.create', 'Permission denied: only Store can confirm inventory receipt.');
  if (!isStore()) deny('Only the Store Department can confirm approved material into inventory.');
  const qc = getQualityCheck(qcNumber);
  if (!qc) deny(`Quality Check ${qcNumber} not found. No inspection = no inventory update.`);

  /* --- rule 1 & 2: inspection must exist and be approved --- */
  if (!INVENTORY_ELIGIBLE_QC_STATUSES.includes(qc.status)) {
    deny(
      `QC ${qcNumber} is "${qc.status}". Only Approved / Partially Approved material can be posted to inventory.`
    );
  }

  /* --- rule 4: never post the same accepted quantity twice --- */
  if (qc.postedToInventory) deny(`QC ${qcNumber} has already been posted to inventory.`);

  const lines = (qc.items || []).map((l) => {
    const accepted = num(l.acceptedQty);
    const rejected = num(l.rejectedQty);
    const received = num(l.receivedQty);
    if (accepted < 0 || rejected < 0) deny('Quantities cannot be negative.');
    if (accepted + rejected > received)
      deny(
        `Accepted + Rejected (${accepted + rejected}) cannot exceed Received (${received}) for "${l.materialName}".`
      );
    if (accepted > received)
      deny(`Accepted quantity ${accepted} cannot exceed the inspected received quantity ${received}.`);
    return { ...l, acceptedQty: accepted, rejectedQty: rejected, receivedQty: received };
  });

  const acceptedLines = lines.filter((l) => l.acceptedQty > 0);
  if (acceptedLines.length === 0) deny('No accepted quantity available to add to inventory.');

  const inv = getInventoryItems();
  const nextInv = [...inv];
  const txs = [];
  const postedLines = [];

  acceptedLines.forEach((l) => {
    /* --- rule 4 (per line): a second post of the same line is a no-op --- */
    const alreadyPosted = getStockTransactions().some(
      (t) =>
        String(t.qcNumber || '') === String(qc.qcNumber) &&
        String(t.itemCode || '') === String(l.materialCode || '') &&
        num(t.acceptedQty) > 0
    );
    if (alreadyPosted) {
      postedLines.push({ ...l, postedQty: 0, skipped: true });
      return;
    }

    const matchIdx = nextInv.findIndex(
      (it) =>
        (l.materialCode && String(it.itemCode || '').toLowerCase() === String(l.materialCode).toLowerCase()) ||
        (l.materialName && it.itemName && String(it.itemName).toLowerCase() === String(l.materialName).toLowerCase())
    );
    let balanceAfter;
    if (matchIdx !== -1) {
      const cur = num(nextInv[matchIdx].currentQty);
      nextInv[matchIdx] = { ...nextInv[matchIdx], currentQty: cur + l.acceptedQty };
      balanceAfter = cur + l.acceptedQty;
    } else {
      nextInv.unshift({
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemCode: l.materialCode || `PRAG-MAT-${Math.floor(100 + Math.random() * 900)}`,
        itemName: l.materialName,
        category: 'Raw Material',
        hsnSac: '',
        unit: l.unit || 'Nos',
        currentQty: l.acceptedQty,
        reservedQty: 0,
        minReorderLevel: 0,
        unitCost: 0,
        sellingPrice: 0,
        location: 'Main Store',
        warehouse: 'Main Store',
        itemType: 'PO Linked'
      });
      balanceAfter = l.acceptedQty;
    }

    /* Identity of the delivered material: the inspection line wins, then the
     * linked Tax Invoice / Material Receipt (the Store types Batch / Lot there,
     * which is what the stock ledger, the batch register and the issue slip
     * must show). */
    const receiptLine = qc.receiptNumber
      ? findMatchingReceiptLine(getReceipts().find((r) => String(r.receiptNumber) === String(qc.receiptNumber))?.items || [], l)
      : null;
    const batchNo = l.batchNumber || receiptLine?.batchNumber || '';
    const lotNumber = l.lotNumber || receiptLine?.lotNumber || '';
    const internalBatchId = l.internalBatchId || receiptLine?.internalBatchId || (!batchNo ? generateInternalReceiptBatchId() : '');
    const batchRecord = addInventoryBatch({
      internalBatchId,
      batchNumber: batchNo,
      supplierBatchNumber: batchNo,
      lotNumber,
      itemCode: l.materialCode || '',
      itemName: l.materialName,
      supplier: qc.vendor || '',
      grnNumber: qc.receiptNumber || qc.arrivalNumber || '',
      receivedDate: todayStr(),
      mfgDate: l.mfgDate || receiptLine?.mfgDate || '',
      expiryDate: l.expiryDate || receiptLine?.expiryDate || '',
      receivedQty: l.receivedQty,
      acceptedQty: l.acceptedQty,
      rejectedQty: l.rejectedQty,
      qtyReceived: l.acceptedQty,
      availableQty: l.acceptedQty,
      blockedQty: 0,
      warehouse: receiptLine?.warehouse || '',
      dimensions: receiptLine?.dimensions || l.dimensions || {},
      qcStatus: qc.status,
      status: l.acceptedQty > 0 ? 'In Stock' : 'Rejected / Blocked'
    });

    txs.push({
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: todayStr(),
      dateTime: nowDateTimeStr(),
      itemCode: l.materialCode || '-',
      itemName: l.materialName,
      unit: l.unit || 'Nos',
      type: 'IN',
      quantity: l.acceptedQty,
      acceptedQty: l.acceptedQty,
      rejectedQty: l.rejectedQty,
      balanceAfter,
      reason: 'Purchase Inward (Quality Approved Material)',
      source: 'Quality Approved Material',
      reference: qc.receiptNumber || qc.indentNumber || qc.qcNumber,
      transactionNumber: qc.receiptNumber || qc.qcNumber,
      poReference: qc.poNumber,
      poNumber: qc.poNumber,
      receiptNumber: qc.receiptNumber || '',
      qcNumber: qc.qcNumber,
      projectId: qc.projectId || '',
      soNumber: qc.soNumber || '',
      indentNumber: qc.indentNumber || '',
      batchNo,
      lotNumber,
      internalBatchId,
      receiptBatchId: batchRecord?.id || '',
      supplier: qc.vendor || '',
      vendor: qc.vendor || '',
      receivedBy: currentUser().name,
      postedAt: nowDateTimeStr()
    });
    postedLines.push({ ...l, postedQty: l.acceptedQty });
  });

  if (txs.length === 0) deny(`QC ${qcNumber} accepted quantity has already been posted to inventory.`);

  saveInventoryItems(nextInv);
  saveStockTransactions([...txs, ...getStockTransactions()]);

  qc.postedToInventory = true;
  qc.postedAt = nowDateTimeStr();
  qc.postedBy = currentUser().name;
  qc.inventoryPostedQty = postedLines.reduce((a, l) => a + l.postedQty, 0);
  qc.postedItems = postedLines.map((l) => ({
    materialCode: l.materialCode || '',
    materialName: l.materialName,
    acceptedQty: l.acceptedQty,
    postedQty: l.postedQty
  }));
  qc.history = [...(qc.history || []), historyEntry('Accepted material added to inventory', `${postedLines.length} line(s) | ${qc.inventoryPostedQty} unit(s)`)];
  const qlist = getQualityChecks();
  const qidx = qlist.findIndex((q) => q.qcNumber === qcNumber);
  qlist[qidx] = qc;
  saveList(WF.qcs, qlist);

  const rlist = getReceipts();
  const ridx = rlist.findIndex((r) => r.receiptNumber === qc.receiptNumber);
  if (ridx >= 0) {
    rlist[ridx] = { ...rlist[ridx], postedToInventory: true, inventoryPosted: true };
    saveList(WF.receipts, rlist);
  }

  syncPOStatus(qc.poNumber, { force: true });

  log('INVENTORY POSTED', qc.qcNumber, `${postedLines.length} line(s) against PO ${qc.poNumber}`);

  acceptedLines.forEach((l) => {
    notify(
      'Approved material added to inventory',
      `Material ${l.materialName}, quantity ${l.acceptedQty}, has been approved and added to inventory against PO-${qc.poNumber}.`,
      qc.receiptNumber,
      'Production Department',
      'store'
    );
  });
  notify(
    'Inventory receipt confirmed',
    `Accepted material from ${qc.receiptNumber ? `receipt ${qc.receiptNumber}` : `Purchase Indent ${qc.indentNumber}`} (PO ${qc.poNumber}) added to inventory.`,
    qc.receiptNumber || qc.indentNumber || qc.qcNumber,
    'Store Department',
    'store'
  );

  if (qc.soNumber) maybeNotifyProductionReady(qc.soNumber);
  return { qc, posted: postedLines.length, postedQty: qc.inventoryPostedQty };
};

/* ------------------- 17. Sales Order material procurement status ------------------- */

export const getSalesOrderMaterialStatus = (soNumber) => {
  const so = getSalesOrderByRef(soNumber);
  if (!so) return null;

  const check = getAvailabilityCheck(soNumber);
  const inv = getInventoryItems();
  const indents = getIndentForSO(soNumber).filter((i) => i.status !== INDENT_STATUS.CANCELLED);
  const qcs = getQualityChecks().filter((q) => String(q.soNumber) === String(soNumber));

  const purchasedByMaterial = {};
  indents.forEach((ind) => {
    (ind.items || []).forEach((it) => {
      const key = String(it.materialCode || it.materialName || '').toLowerCase();
      if (!key) return;
      purchasedByMaterial[key] = (purchasedByMaterial[key] || 0) + num(it.purchaseQty);
    });
  });

  const receivedByMaterial = {};
  qcs.forEach((q) => {
    (q.items || []).forEach((it) => {
      const key = String(it.materialCode || it.materialName || '').toLowerCase();
      if (!key) return;
      receivedByMaterial[key] = (receivedByMaterial[key] || 0) + num(it.acceptedQty);
    });
  });

  const lines = (so.payload?.items || []).map((it) => {
    const code = String(it.itemCode || '').trim();
    const name = String(it.itemName || '').trim();
    const key = (code || name).toLowerCase();
    const match = inv.find(
      (i) =>
        (code && String(i.itemCode || '').toLowerCase() === code.toLowerCase()) ||
        (name && i.itemName && String(i.itemName).toLowerCase() === name.toLowerCase())
    );
    const received = receivedByMaterial[key] || 0;
    const stock = match ? num(match.currentQty) : 0;
    const available = Math.max(0, stock - received);
    const required = num(it.quantity);
    const purchased = purchasedByMaterial[key] || 0;
    const pending = Math.max(0, required - available - received);
    const status = pending > 0 ? 'Pending' : purchased > 0 ? 'Complete' : 'Available';
    return {
      materialCode: code || match?.itemCode || '',
      materialName: name || '-',
      unit: it.unit || match?.unit || 'Nos',
      required,
      available,
      purchased,
      received,
      pending,
      status
    };
  });

  const shortages = (check?.lines || []).filter((l) => num(l.shortageQty) > 0).length;
  const allAvailable = lines.length > 0 && lines.every((l) => l.pending === 0);
  const status = lines.length === 0 ? 'No Materials' : allAvailable ? 'COMPLETED' : 'MATERIALS PENDING';

  return {
    soNumber,
    lines,
    overallStatus: status,
    checked: Boolean(check),
    checkedAt: check?.checkedAt || '',
    shortageMaterials: shortages,
    indents: indents.map((i) => ({ indentNumber: i.indentNumber, status: i.status, poNumber: i.poNumber }))
  };
};

export const getSalesOrdersWithMaterialStatus = () =>
  getSalesOrders().map((so) => ({ ...so, material: getSalesOrderMaterialStatus(so.reference) }));

/** Fires notification #13 exactly once per Sales Order. */
const maybeNotifyProductionReady = (soNumber) => {
  const status = getSalesOrderMaterialStatus(soNumber);
  if (!status || status.overallStatus !== 'COMPLETED') return;
  const list = getList(WF.checks);
  const idx = list.findIndex((c) => String(c.soNumber) === String(soNumber));
  if (idx >= 0 && list[idx].productionNotified) return;
  if (idx >= 0) {
    list[idx] = { ...list[idx], productionNotified: true, productionNotifiedAt: nowDateTimeStr() };
    saveList(WF.checks, list);
  }
  notify(
    'Materials ready for production',
    `Required materials for Sales Order ${soNumber} are now available in Store and ready for production.`,
    soNumber,
    'Production Department',
    'store'
  );
  log('MATERIALS AVAILABLE FOR PRODUCTION', soNumber, 'All Sales Order materials available');
};

/* ------------------------ 19. Department dashboards ------------------------ */

export const getWorkflowDashboard = () => {
  const soList = getSalesOrders();
  const checks = getAvailabilityChecks();
  const indents = getIndents();
  const receipts = getReceipts();
  const qcs = getQualityChecks();
  const rejections = getRejectionReports();
  const pos = getPurchaseOrders();
  const enquiries = readVendorEnquiries();
  const quotations = readVendorQuotations();

  const checkedSet = new Set(checks.map((c) => String(c.soNumber)));
  const openSOs = soList.filter((so) => !['Dispatched', 'Closed'].includes(so.status));
  const materialStatuses = openSOs.map((so) => getSalesOrderMaterialStatus(so.reference)).filter(Boolean);

  const poProgress = pos
    .filter((p) => !String(p.reference || '').startsWith('legacy'))
    .map((p) => ({ poNumber: p.reference, ...getPOProgress(p.reference) }));

  /* ---- row builders shared by the three department dashboards ---- */
  const qtyOf = (rows, field) => rows.reduce((a, r) => a + num((r.items || []).reduce((s, it) => s + num(it[field]), 0)), 0);

  const storeSections = {
    soAwaitingReview: openSOs
      .filter((so) => !checkedSet.has(String(so.reference)))
      .map((so) => ({
        soNumber: so.reference,
        projectId: so.payload?.soDetails?.projectId || '',
        customer: so.company || so.payload?.customerDetails?.companyName || '',
        orderDate: so.payload?.soDetails?.soDate || so.date || '',
        deliveryDate: so.payload?.soDetails?.deliveryDate || '',
        status: 'Pending Store Review',
        action: 'Review'
      })),
    poAwaitingDelivery: poProgress
      .filter((p) => p.ordered > 0 && p.pending > 0 && !['Cancelled'].includes(p.poStatus))
      .map((p) => ({
        poNumber: p.poNumber,
        projectId: p.projectId,
        soNumber: p.soNumber,
        indentNumber: p.indentNumber,
        vendor: p.vendor,
        ordered: p.ordered,
        received: p.received,
        pending: p.pending,
        status: p.status,
        action: 'Create Tax Invoice / Material Receipt'
      })),
    receiptsAwaitingQC: receipts
      .filter((r) => !r.qcNumber || String(r.qcStatus) === QC_STATUS.PENDING)
      .map((r) => ({
        receiptNumber: r.receiptNumber,
        poNumber: r.poNumber,
        projectId: r.projectId,
        vendor: r.vendor,
        receivedQty: qtyOf([r], 'receivedQty'),
        dateReceived: r.receiptDate,
        status: r.qcStatus || QC_STATUS.PENDING,
        action: 'Awaiting Quality Check'
      })),
    qcCompleted: qcs
      .filter((q) => [QC_STATUS.APPROVED, QC_STATUS.PARTIAL, QC_STATUS.REJECTED].includes(q.status))
      .map((q) => ({
        qcNumber: q.qcNumber,
        poNumber: q.poNumber,
        projectId: q.projectId,
        receiptNumber: q.receiptNumber,
        status: q.status,
        action: 'Open QC Report'
      })),
    acceptedAwaitingPosting: qcs
      .filter((q) => INVENTORY_ELIGIBLE_QC_STATUSES.includes(q.status) && !q.postedToInventory && qtyOf([q], 'acceptedQty') > 0)
      .map((q) => ({
        qcNumber: q.qcNumber,
        poNumber: q.poNumber,
        projectId: q.projectId,
        acceptedQty: qtyOf([q], 'acceptedQty'),
        status: 'Accepted Material Awaiting Inventory Posting',
        action: 'Post to Inventory'
      })),
    rejectedMaterials: rejections
      .filter((r) => num(r.pendingReplacementQty ?? qtyOf([r], 'rejectedQty')) > 0)
      .map((r) => ({
        rejectionNumber: r.rejectionNumber,
        poNumber: r.poNumber,
        projectId: r.projectId,
        vendor: r.vendor,
        rejectedQty: num(r.pendingReplacementQty ?? qtyOf([r], 'rejectedQty')),
        status: r.status,
        action: 'Process Rejected Material'
      })),
    replacementAwaitingReceipt: indents
      .filter((i) => i.replacementFor && !i.poNumber)
      .map((i) => ({
        indentNumber: i.indentNumber,
        projectId: i.projectId,
        soNumber: i.soNumber,
        purchaseQty: qtyOf([i], 'purchaseQty'),
        status: 'Replacement Pending',
        action: 'Purchase to raise replacement PO'
      }))
  };

  const purchaseSections = {
    indentsAwaitingProcurement: indents
      .filter((i) => [INDENT_STATUS.SUBMITTED, INDENT_STATUS.UNDER_REVIEW, INDENT_STATUS.AWAITING_PRODUCTION].includes(i.status))
      .map((i) => ({
        indentNumber: i.indentNumber,
        indentDate: i.indentDate,
        soNumber: i.soNumber,
        projectId: i.projectId,
        customer: i.customer,
        materialCount: (i.items || []).length,
        purchaseQty: qtyOf([i], 'purchaseQty'),
        requiredDate: i.requiredDate,
        createdBy: i.createdBy,
        status: i.status,
        action: getProcurementChainForIndent(i.indentNumber).quotations.length ? 'Create Purchase Order' : 'Create Vendor Enquiry'
      })),
    vendorEnquiries: enquiries.map((e) => ({
      enquiryNumber: e.enquiryNumber,
      projectId: e.projectId,
      indentNumber: e.indentNumber,
      soNumber: e.soNumber,
      materialCount: (e.items || []).length,
      vendors: (e.vendors || []).length,
      status: e.status || 'Draft',
      action: (e.quotationNumbers || []).length ? 'Quotation Received' : 'Awaiting Quotation'
    })),
    vendorQuotations: quotations.map((q) => ({
      quotationNumber: q.quotationNumber,
      enquiryNumber: q.enquiryNumber,
      projectId: q.projectId,
      indentNumber: q.indentNumber,
      vendor: q.vendorName,
      quantity: qtyOf([q], 'quotedQty'),
      totalAmount: num(q.totalAmount),
      status: q.status || QUOTATION_STATUS.RECEIVED,
      poNumber: q.poNumber || q.purchaseOrderNumber || '',
      action: quotationAlreadyConverted(q)
        ? 'PO Created'
        : QUOTATION_ACCEPTED_STATUSES.includes(String(q.status))
          ? 'Create Purchase Order'
          : 'Accept Quotation'
    })),
    purchaseOrders: poProgress.map((p) => ({
      poNumber: p.poNumber,
      projectId: p.projectId,
      soNumber: p.soNumber,
      indentNumber: p.indentNumber,
      vendor: p.vendor,
      ordered: p.ordered,
      received: p.received,
      pending: p.pending,
      qcPending: p.qcPending,
      accepted: p.creditedAccepted,
      rejected: p.rejected,
      pendingReplacement: p.pendingReplacement,
      replacementArrived: p.replacementArrived,
      status: p.status,
      fulfillmentStatus: p.fulfillmentStatus,
      action: p.pending > 0 ? 'Awaiting Delivery' : 'Received'
    })),
    rejectionsAwaitingReplacement: rejections
      .filter((r) => !r.repurchaseIndentNumber)
      .map((r) => ({
        rejectionNumber: r.rejectionNumber,
        poNumber: r.poNumber,
        projectId: r.projectId,
        vendor: r.vendor,
        rejectedQty: qtyOf([r], 'rejectedQty'),
        status: r.status,
        action: 'Create Reorder / Replacement Purchase'
      })),
    replacementOrders: indents
      .filter((i) => i.replacementFor)
      .map((i) => ({
        indentNumber: i.indentNumber,
        projectId: i.projectId,
        soNumber: i.soNumber,
        poNumber: i.poNumber || '—',
        purchaseQty: qtyOf([i], 'purchaseQty'),
        status: i.status,
        action: i.poNumber ? `Replacement PO ${i.poNumber}` : 'Raise replacement PO'
      }))
  };

  const qualitySections = {
    awaitingCheck: [
      ...receipts
        .filter((r) => !r.qcNumber || String(r.qcStatus) === QC_STATUS.PENDING)
        .map((r) => ({
          source: 'Material Receipt',
          reference: r.receiptNumber,
          poNumber: r.poNumber,
          projectId: r.projectId,
          soNumber: r.soNumber,
          indentNumber: r.indentNumber,
          vendor: r.vendor,
          quantity: qtyOf([r], 'receivedQty'),
          status: r.qcStatus || QC_STATUS.PENDING,
          action: 'Start Quality Check'
        })),
      ...indents
        .filter((i) => i.qcStatus === INDENT_QC_STATUS.SENT && !i.qcNumber)
        .map((i) => ({
          source: 'Purchase Indent',
          reference: i.indentNumber,
          poNumber: i.poNumber,
          projectId: i.projectId,
          soNumber: i.soNumber,
          indentNumber: i.indentNumber,
          vendor: '',
          quantity: qtyOf([i], 'purchaseQty'),
          status: 'Awaiting Inspection',
          action: 'Start Quality Check'
        }))
    ],
    inProgress: qcs.filter((q) => q.status === QC_STATUS.UNDER || q.status === QC_STATUS.PENDING),
    approved: qcs.filter((q) => q.status === QC_STATUS.APPROVED),
    partiallyApproved: qcs.filter((q) => q.status === QC_STATUS.PARTIAL),
    rejected: qcs.filter((q) => q.status === QC_STATUS.REJECTED)
  };

  const store = {
    awaitingChecks: storeSections.soAwaitingReview.length,
    checkedOrders: checks.length,
    materialAvailable: materialStatuses.filter((s) => s.overallStatus === 'COMPLETED').length,
    materialsPending: materialStatuses.filter((s) => s.overallStatus === 'MATERIALS PENDING').length,
    indentsDraft: indents.filter((i) => i.status === INDENT_STATUS.DRAFT).length,
    indentsSubmitted: indents.filter((i) => [INDENT_STATUS.SUBMITTED, INDENT_STATUS.AWAITING_PRODUCTION, INDENT_STATUS.UNDER_REVIEW].includes(i.status)).length,
    receipts: receipts.length,
    pendingReceipts: storeSections.poAwaitingDelivery.length,
    poPartial: poProgress.filter((p) => p.status === PO_STATUS.PARTIAL).length,
    poFull: poProgress.filter((p) => p.fullyReceived).length,
    poClosed: poProgress.filter((p) => p.closed).length,
    pendingQC: storeSections.receiptsAwaitingQC.length,
    acceptedAwaitingPosting: storeSections.acceptedAwaitingPosting.length,
    rejectedMaterials: storeSections.rejectedMaterials.length,
    replacementAwaitingReceipt: storeSections.replacementAwaitingReceipt.length,
    qcCompleted: storeSections.qcCompleted.length,
    rejectionsToForward: rejections.filter((r) => [REJECTION_STATUS.RAISED, REJECTION_STATUS.WITH_STORE].includes(r.status)).length,
    sections: storeSections
  };

  const purchase = {
    newIndents: purchaseSections.indentsAwaitingProcurement.length,
    awaitingProduction: indents.filter((i) => i.status === INDENT_STATUS.AWAITING_PRODUCTION).length,
    underReview: indents.filter((i) => i.status === INDENT_STATUS.UNDER_REVIEW).length,
    readyToConvert: indents.filter((i) => i.status === INDENT_STATUS.SUBMITTED).length,
    converted: indents.filter((i) => i.status === INDENT_STATUS.CONVERTED).length,
    posTotal: poProgress.length,
    posPartial: poProgress.filter((p) => p.status === PO_STATUS.PARTIAL).length,
    posFull: poProgress.filter((p) => p.fullyReceived).length,
    posOpen: storeSections.poAwaitingDelivery.length,
    receipts: receipts.length,
    enquiries: enquiries.length,
    quotations: quotations.length,
    replacementsPending: purchaseSections.rejectionsAwaitingReplacement.length,
    replacementOrders: purchaseSections.replacementOrders.length,
    rejectionsForVendor: rejections.filter((r) => r.status === REJECTION_STATUS.FORWARDED).length,
    sections: purchaseSections
  };

  const production = {
    salesOrders: openSOs.length,
    additionalRequests: indents.reduce((a, i) => a + (i.additionalRequirements || []).length, 0),
    pendingClarifications: indents.reduce(
      (a, i) => a + (i.clarifications || []).filter((c) => c.status === 'Awaiting Production').length,
      0
    ),
    awaitingQC: qualitySections.awaitingCheck.length,
    underInspection: qcs.filter((q) => q.status === QC_STATUS.UNDER).length,
    rejectedMaterials: rejections.length,
    approvedMaterials: qcs.filter((q) => INVENTORY_ELIGIBLE_QC_STATUSES.includes(q.status)).length,
    materialsAvailable: materialStatuses.filter((s) => s.overallStatus === 'COMPLETED').length,
    sections: qualitySections
  };

  return {
    store,
    purchase,
    production,
    quality: qualitySections,
    counts: {
      salesOrders: soList.length,
      indents: indents.length,
      receipts: receipts.length,
      qualityChecks: qcs.length,
      rejections: rejections.length,
      purchaseOrders: poProgress.length,
      vendorEnquiries: enquiries.length,
      vendorQuotations: quotations.length
    }
  };
};

/* ------------------------- document traceability ------------------------- */

export const getDocumentChain = (soNumber) => {
  const so = getSalesOrderByRef(soNumber);
  if (!so) return null;
  const indents = getIndentForSO(soNumber);
  const poNumbers = new Set();
  indents.forEach((i) => i.poNumber && poNumbers.add(i.poNumber));
  const receipts = getReceipts().filter((r) => String(r.soNumber) === String(soNumber) || poNumbers.has(r.poNumber));
  const qcs = getQualityChecks().filter((q) => receipts.some((r) => r.receiptNumber === q.receiptNumber));
  const rejections = getRejectionReports().filter((r) => qcs.some((q) => q.qcNumber === r.qcNumber));
  return {
    salesOrder: so,
    availabilityCheck: getAvailabilityCheck(soNumber),
    indents,
    purchaseOrders: [...poNumbers].map((p) => getPOByRef(p)).filter(Boolean),
    receipts,
    qualityChecks: qcs,
    rejections,
    materialStatus: getSalesOrderMaterialStatus(soNumber)
  };
};

export default {
  ensureWorkflowSeeded,
  getWorkflowDashboard
};
