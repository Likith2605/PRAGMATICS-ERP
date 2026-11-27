/**
 * PostgreSQL-authoritative Purchase Order reconciliation.
 *
 * Every Material Receipt, receipt Quality Check, stock posting and Supplier
 * Invoice that belongs to a Purchase Order recomputes that PO's ordered /
 * received / inspected / accepted / rejected / posted / invoiced quantities
 * inside the SAME database transaction that changed the source record, and
 * stores the result on the Purchase Order row. The browser never derives PO
 * progress from local caches for confirmed data: it reads `record.progress`.
 *
 * Rules kept from the workflow service:
 *   - a Cancelled or Closed Purchase Order never changes status (only its
 *     measured quantities are refreshed);
 *   - ordered quantity can never be raised by a receipt, inspection or invoice;
 *   - a rejected quantity keeps the PO open until replacement material has
 *     itself been received and accepted against the same PO;
 *   - a Purchase Order that does not exist in PostgreSQL (preserved legacy
 *     snapshot only) is never written to — legacy records stay untouched until
 *     an Administrator explicitly imports them.
 */
import { safeAuditValues } from './auth.js';

const num = (value) => Number(value) || 0;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const lineKey = (line) => String(line?.materialCode || line?.itemCode || line?.materialName || line?.itemName || '').trim().toLowerCase();
const isReplacementReceipt = (record) => Boolean(record?.isReplacement)
  || String(record?.receiptType || '') === 'Replacement Receipt'
  || Boolean(record?.replacementForRejection)
  || Boolean(record?.rejectionNumber);

const matchesLine = (item, line) => {
  const itemCode = String(item?.itemCode || item?.materialCode || '').trim().toLowerCase();
  const lineCode = String(line?.materialCode || line?.itemCode || '').trim().toLowerCase();
  if (itemCode && lineCode) return itemCode === lineCode;
  const itemName = String(item?.itemName || item?.materialName || '').trim().toLowerCase();
  const lineName = String(line?.materialName || line?.itemName || '').trim().toLowerCase();
  if (itemName && lineName) return itemName === lineName;
  const key = lineKey(item);
  return Boolean(key) && lineKey(line) === key;
};

const sumMatched = (rows, item, field, pickItems) => rows.reduce((total, row) => {
  const lines = pickItems(row) || [];
  return total + lines.filter((line) => matchesLine(item, line)).reduce((lineTotal, line) => lineTotal + num(line[field]), 0);
}, 0);

const poAudit = (client, req, poNumber, action, before, after, reason = '') => client.query(
  `INSERT INTO purchase_order_audit(po_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [poNumber, req?.user?.id || null, req?.user?.email || 'system', req?.user?.role || req?.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);

/**
 * Measures a Purchase Order strictly from PostgreSQL rows: material receipts,
 * their quality inspections, the stock postings that came out of them and the
 * Supplier Invoices linked to the PO. Returns the progress block plus the
 * canonical fulfillment status derived with the workflow service's rules.
 */
export const measurePurchaseOrder = async (client, po) => {
  const payload = po.payload || {};
  const poItems = Array.isArray(payload?.payload?.items) ? payload.payload.items
    : Array.isArray(payload?.items) ? payload.items : [];

  const receiptRows = await client.query(
    'SELECT receipt_number,payload FROM material_receipts WHERE po_number=$1 AND deleted_at IS NULL ORDER BY receipt_number',
    [po.po_number]
  );
  const receipts = receiptRows.rows.map((row) => ({ receiptNumber: row.receipt_number, ...(row.payload || {}) }));
  const receiptIds = receipts.map((row) => String(row.receiptNumber));
  const inspectionRows = receiptIds.length
    ? await client.query(
      'SELECT qc_number,receipt_number,status,posted_at,posted_qty,payload FROM material_receipt_inspections WHERE receipt_number = ANY($1::text[]) ORDER BY qc_number',
      [receiptIds]
    )
    : { rows: [] };
  const inspections = inspectionRows.rows;
  const inspectionByReceipt = new Map(inspections.map((row) => [String(row.receipt_number), row]));
  const invoiceRows = await client.query(
    'SELECT invoice_number,payload FROM supplier_invoices WHERE po_number=$1 AND deleted_at IS NULL ORDER BY invoice_number',
    [po.po_number]
  );
  const invoices = invoiceRows.rows;

  const originalReceipts = receipts.filter((row) => !isReplacementReceipt(row));
  const replacementReceipts = receipts.filter((row) => isReplacementReceipt(row));
  const originalIds = new Set(originalReceipts.map((row) => String(row.receiptNumber)));
  const replacementIds = new Set(replacementReceipts.map((row) => String(row.receiptNumber)));
  const inspectedIds = new Set(inspections.map((row) => String(row.receipt_number)));
  const receiptItems = (row) => row.items || [];
  const inspectionItems = (row) => row.payload?.items || [];
  const invoiceItems = (row) => row.payload?.payload?.items || row.payload?.items || [];

  const lines = poItems.map((item) => {
    const originalReceived = sumMatched(originalReceipts, item, 'receivedQty', receiptItems);
    const replacementReceived = sumMatched(replacementReceipts, item, 'receivedQty', receiptItems);
    const received = originalReceived + replacementReceived;

    const originalInspections = inspections.filter((row) => originalIds.has(String(row.receipt_number)));
    const replacementInspections = inspections.filter((row) => replacementIds.has(String(row.receipt_number)));
    const uninspectedOriginal = originalReceipts.filter((row) => !inspectedIds.has(String(row.receiptNumber)));
    const uninspectedReplacement = replacementReceipts.filter((row) => !inspectedIds.has(String(row.receiptNumber)));

    const inspected = sumMatched(inspections, item, 'receivedQty', inspectionItems);
    const originalAccepted = sumMatched(originalInspections, item, 'acceptedQty', inspectionItems)
      + sumMatched(uninspectedOriginal, item, 'acceptedQty', receiptItems);
    const replacementAccepted = sumMatched(replacementInspections, item, 'acceptedQty', inspectionItems)
      + sumMatched(uninspectedReplacement, item, 'acceptedQty', receiptItems);
    const accepted = originalAccepted + replacementAccepted;
    const rejected = sumMatched(inspections, item, 'rejectedQty', inspectionItems)
      + sumMatched(receipts.filter((row) => !inspectedIds.has(String(row.receiptNumber))), item, 'rejectedQty', receiptItems);
    const postedInspections = inspections.filter((row) => row.posted_at);
    const inventoryPosted = sumMatched(postedInspections, item, 'acceptedQty', inspectionItems);
    const invoiced = sumMatched(invoices, item, 'quantity', invoiceItems);

    const orderedQty = num(item.quantity ?? item.orderedQty ?? item.qty);
    const pending = Math.max(0, orderedQty - originalReceived);
    const qcPending = Math.max(0, received - inspected);
    const creditedAccepted = orderedQty > 0 ? Math.min(orderedQty, accepted) : accepted;
    const openRejected = Math.max(0, rejected - replacementAccepted);
    const pendingReplacement = Math.max(0, rejected - replacementReceived);

    return {
      materialCode: String(item.itemCode || item.materialCode || ''),
      materialName: String(item.itemName || item.materialName || '-'),
      unit: String(item.unit || 'Nos'),
      orderedQty,
      receivedQty: received,
      originalReceivedQty: originalReceived,
      replacementReceivedQty: replacementReceived,
      inspectedQty: inspected,
      acceptedQty: accepted,
      originalAcceptedQty: originalAccepted,
      replacementAcceptedQty: replacementAccepted,
      creditedAcceptedQty: creditedAccepted,
      rejectedQty: rejected,
      inventoryPostedQty: inventoryPosted,
      invoicedQty: invoiced,
      pendingQty: pending,
      qcPendingQty: qcPending,
      openRejectedQty: openRejected,
      pendingReplacementQty: pendingReplacement,
      pendingAcceptedQty: Math.max(0, accepted - inventoryPosted),
      pendingInvoiceQty: Math.max(0, inventoryPosted - invoiced)
    };
  });

  const total = (field) => lines.reduce((sum, line) => sum + num(line[field]), 0);
  const ordered = total('orderedQty');
  const originalReceived = total('originalReceivedQty');
  const replacementReceived = total('replacementReceivedQty');
  const received = total('receivedQty');
  const inspected = total('inspectedQty');
  const accepted = total('acceptedQty');
  const rejected = total('rejectedQty');
  const inventoryPosted = total('inventoryPostedQty');
  const invoiced = total('invoicedQty');
  const creditedAccepted = total('creditedAcceptedQty');
  const openRejected = total('openRejectedQty');
  const pendingReplacement = total('pendingReplacementQty');
  const pending = total('pendingQty');
  const qcPending = Math.max(0, received - inspected);

  const fullyReceived = ordered > 0 && pending === 0;
  const receiptComplete = fullyReceived && qcPending === 0 && creditedAccepted >= ordered && openRejected === 0 && pendingReplacement === 0;

  const previousStatus = String(po.status || payload.status || '');
  const locked = previousStatus === 'Cancelled' || previousStatus === 'Closed';
  let status = previousStatus;
  if (!locked && ordered > 0) {
    if (receiptComplete) status = 'Fully Received';
    else if (openRejected > 0) status = 'Replacement Pending';
    else if (pendingReplacement > 0) status = 'Replacement In Transit';
    else if (fullyReceived && qcPending > 0) status = 'Received / Awaiting QC';
    else if (received > 0 && !fullyReceived) status = 'Partially Received';
  }

  const closureChecks = {
    allArrived: ordered > 0 && pending === 0,
    allAccepted: ordered > 0 && creditedAccepted >= ordered,
    noUnresolvedRejection: openRejected === 0 && pendingReplacement === 0,
    qualityChecked: qcPending === 0,
    inventoryPosted: Math.max(0, accepted - inventoryPosted) === 0,
    invoiceRecorded: Math.max(0, inventoryPosted - invoiced) === 0
  };

  const progress = {
    ordered,
    received,
    originalReceived,
    replacementReceived,
    pending,
    inspected,
    qcPending,
    accepted,
    creditedAccepted,
    rejected,
    inventoryPosted,
    invoiced,
    openRejected,
    pendingReplacement,
    pendingAccepted: Math.max(0, accepted - inventoryPosted),
    pendingInvoice: Math.max(0, inventoryPosted - invoiced),
    receiptCount: receipts.length,
    inspectionCount: inspections.length,
    invoiceCount: invoices.length,
    closureChecks,
    closureReady: ordered > 0 && Object.values(closureChecks).every(Boolean),
    receiptComplete,
    fullyReceived,
    status,
    fulfillmentStatus: status || (ordered > 0 ? 'Awaiting Delivery' : 'Draft'),
    lines,
    updatedAt: new Date().toISOString()
  };
  return { progress, status, ordered };
};

/**
 * Recomputes and persists PO progress/status. Must be called inside the
 * transaction that changed the source record. Returns null when the PO only
 * exists in the preserved legacy snapshot (never silently modified).
 */
export const reconcilePurchaseOrderProgress = async (client, req, poNumber, reason = 'Material receipt reconciliation') => {
  const reference = String(poNumber || '').trim();
  if (!reference) return null;
  const result = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1 AND deleted_at IS NULL FOR UPDATE', [reference]);
  const po = result.rows[0];
  if (!po) return null;

  const { progress, status } = await measurePurchaseOrder(client, po);
  const current = po.payload || {};
  const previousProgress = current.progress ? { ...current.progress } : null;
  if (previousProgress) delete previousProgress.updatedAt;
  const nextProgress = { ...progress };
  const comparableNext = { ...nextProgress };
  delete comparableNext.updatedAt;
  const poDetails = { ...(current.payload?.poDetails || {}), poStatus: status };
  const statusChanged = String(po.status || '') !== status || String(current.status || '') !== status || String(current.payload?.poDetails?.poStatus || '') !== status;
  const progressChanged = canonical(previousProgress) !== canonical(comparableNext);
  if (!statusChanged && !progressChanged) return { record: po, progress, changed: false };

  const after = {
    ...current,
    status,
    progress: nextProgress,
    payload: { ...(current.payload || {}), poDetails },
    updatedAt: new Date().toISOString()
  };
  const updated = await client.query(
    'UPDATE purchase_orders SET payload=$2::jsonb,status=$3,version=version+1,updated_at=now(),updated_by=$4 WHERE po_number=$1 RETURNING *',
    [reference, JSON.stringify(after), status, req?.user?.email || 'system']
  );
  await poAudit(client, req, reference, statusChanged ? 'STATUS_RECONCILED' : 'PROGRESS_RECONCILED',
    { status: po.status, progress: previousProgress }, { status, progress: nextProgress }, reason);
  return { record: updated.rows[0], progress: nextProgress, changed: true };
};

export default reconcilePurchaseOrderProgress;
