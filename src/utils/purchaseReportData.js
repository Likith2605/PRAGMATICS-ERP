import { getPOProgress, getPurchaseOrders } from './workflowService.js';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

/**
 * Builds report rows from an authoritative Purchase Order list. Callers that
 * have already loaded PostgreSQL rows pass them in; the no-argument helpers
 * remain for legacy/non-browser callers and tests. `record.progress` is written
 * by the PostgreSQL reconciliation service, so browser caches are never used
 * when the server has supplied progress.
 */
export const buildPurchaseReportOrders = (sourceOrders) => (sourceOrders || getPurchaseOrders()).map((po) => {
  const poNumber = po.reference || po.payload?.poDetails?.poNumber || '';
  const progress = po.progress && typeof po.progress === 'object' ? po.progress : getPOProgress(poNumber);
  const details = po.payload?.poDetails || {};
  const vendor = po.vendor || po.payload?.vendorDetails?.companyName || po.payload?.vendorDetails?.vendorName || '-';
  const date = details.poDate || po.date || '';
  const dueDate = details.deliveryDueDate || po.dueDate || '';
  const items = po.payload?.items || [];
  const lines = progress.lines || [];
  return {
    po,
    poNumber,
    vendor,
    date,
    dueDate,
    status: progress.status || po.status || details.poStatus || 'Unknown',
    orderedQuantity: progress.ordered,
    originalReceived: progress.originalArrived,
    originalAccepted: progress.originalAccepted,
    rejected: progress.rejected,
    replacementReceived: progress.replacementArrived,
    replacementAccepted: progress.replacementAccepted,
    totalAccepted: progress.totalAccepted,
    physicalReceiptBalance: progress.physicalReceiptBalance,
    acceptedQuantityShortage: progress.acceptedQuantityShortage,
    qcPending: progress.qcPending,
    currency: details.currency || po.payload?.currency || 'INR',
    progress,
    items: items.map((item, itemIndex) => {
      // getPOProgress preserves source PO item order; the index avoids collapsing
      // duplicate item-code lines onto the same first match.
      const line = lines[itemIndex] || {};
      const orderedQty = number(item.quantity);
      const receivedQty = number(line.receivedQty);
      const rate = number(item.unitPrice ?? item.rate ?? item.price);
      return {
        itemCode: item.itemCode || '',
        itemName: item.itemName || item.materialName || '-',
        category: item.category || item.itemCategory || 'Uncategorised',
        unit: item.unit || line.unit || '',
        currency: details.currency || po.payload?.currency || 'INR',
        orderedQty,
        receivedQty,
        pendingQty: number(line.pendingQty),
        rate,
        purchaseValue: orderedQty * rate,
        status: progress.status || po.status || details.poStatus || 'Unknown'
      };
    })
  };
});

export const getPurchaseReportOrders = (sourceOrders) => buildPurchaseReportOrders(sourceOrders);

export const getStalePurchaseOrderRows = (today = new Date().toISOString().slice(0, 10), sourceOrders) =>
  getPurchaseReportOrders(sourceOrders).flatMap((order) => {
    const dueTime = Date.parse(order.dueDate);
    const todayTime = Date.parse(today);
    if (!order.dueDate || !Number.isFinite(dueTime) || !Number.isFinite(todayTime) || dueTime >= todayTime || ['Closed', 'Cancelled'].includes(order.status)) return [];
    const daysOverdue = Math.floor((todayTime - dueTime) / 86400000);
    return order.items.filter((item) => item.pendingQty > 0).map((item) => ({
      poNumber: order.poNumber,
      supplier: order.vendor,
      date: order.date,
      dueDate: order.dueDate,
      item: item.itemName,
      itemCode: item.itemCode,
      unit: item.unit || 'Unit not recorded',
      orderedQty: item.orderedQty,
      receivedQty: item.receivedQty,
      pendingQty: item.pendingQty,
      daysOverdue,
      status: order.status,
      version: number(order.po.version ?? order.po.recordVersion)
    }));
  });

export const getPreClosedPurchaseOrderRows = (sourceOrders) => getPurchaseReportOrders(sourceOrders).flatMap((order) => {
  if (order.status !== 'Closed') return [];
  const closure = order.po.shortClose || order.po.payload?.poDetails?.shortClose || null;
  const closeLines = closure?.lines || [];
  const hasCloseEvidence = closeLines.length > 0 || Number(closure?.shortClosedQty) > 0 ||
    number(order.po.shortClosedQty) > 0;
  return order.items.filter((item) => item.pendingQty > 0 || hasCloseEvidence).map((item, itemIndex) => {
    const exactCloseLine = closeLines.find((line) => item.itemCode
      ? String(line.itemCode || '').toLowerCase() === String(item.itemCode).toLowerCase()
      : String(line.itemName || '').toLowerCase() === String(item.itemName).toLowerCase());
    const singleLineGlobalQty = order.items.length === 1
      ? number(closure?.shortClosedQty ?? order.po.shortClosedQty) || null
      : null;
    const closedQty = exactCloseLine ? number(exactCloseLine.quantity) : singleLineGlobalQty;
    return {
    poNumber: order.poNumber,
    supplier: order.vendor,
    item: item.itemName,
      unit: item.unit || 'Unit not recorded',
    date: order.date,
    originalOrderedQty: item.orderedQty,
    receivedQty: item.receivedQty,
    shortClosedQty: closedQty,
    closureDate: closure?.closedAt || order.po.closedAt || '',
    closureReason: closure?.reason || order.po.closedReason || 'Not recorded',
    approvedBy: closure?.approvedBy || order.po.closedBy || 'Not recorded',
    remarks: closure?.remarks || (closedQty == null ? 'Closed PO has pending quantity; short-close quantity not evidenced' : 'No remarks recorded'),
    closureEvidence: closedQty == null ? 'Unverified legacy closure' : 'Recorded closure quantity'
  };
  });
});

export const getSupplierWiseItemRows = (sourceOrders) => getPurchaseReportOrders(sourceOrders).flatMap((order) =>
  order.items.map((item) => ({
    supplier: order.vendor,
    item: item.itemName,
    itemCode: item.itemCode,
    unit: item.unit || 'Unit not recorded',
    category: item.category,
    poNumber: order.poNumber,
    date: order.date,
    orderedQty: item.orderedQty,
    receivedQty: item.receivedQty,
    pendingQty: item.pendingQty,
    rate: item.rate,
    purchaseValue: item.purchaseValue,
    status: item.status
  }))
);

export const purchaseOrderFilters = (rows) => ({
  suppliers: [...new Set(rows.map((row) => row.supplier).filter(Boolean))].sort(),
  items: [...new Set(rows.map((row) => row.item).filter(Boolean))].sort(),
  statuses: [...new Set(rows.map((row) => row.status).filter(Boolean))].sort()
});

