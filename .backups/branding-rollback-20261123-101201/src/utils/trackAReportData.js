import {
  getGRNs, getInventoryItems, getJobCards, getMaterialRequests,
  getMaterialReturns, getPurchaseRequests, getStockTransactions, getStoreIssues
} from './storeService.js';
import {
  getArrivals, getPOProgress, getPurchaseOrders, getQualityChecks, getReceipts,
  getSalesOrders
} from './workflowService.js';
import { readLocalStorageList } from './reportData.js';

const list = (value) => Array.isArray(value) ? value : [];
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = (value) => String(value || '').trim();
const norm = (value) => clean(value).toLocaleLowerCase();
const docItems = (doc) => list(doc?.items || doc?.payload?.items || doc?.lines || doc?.payload?.lines);
const docNumber = (doc, fields) => fields.map((key) => clean(doc?.[key] || doc?.payload?.[key])).find(Boolean) || '';
const qtyLabel = (amount, unit = '') => `${num(amount).toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
const groupQty = (rows, field) => {
  const units = new Map();
  rows.forEach((row) => {
    const unit = clean(row.unit) || 'Unit not recorded';
    units.set(unit, (units.get(unit) || 0) + num(row[field]));
  });
  return [...units.entries()].map(([unit, qty]) => `${qtyLabel(qty)} ${unit === 'Unit not recorded' ? '' : ''}`.trim()).join(' | ') || '0';
};
const unique = (rows, key) => [...new Set(rows.map((row) => clean(row[key])).filter(Boolean))].sort((a, b) => a.localeCompare(b));

export const getSupplierDirectoryRows = () => {
  const masterRows = readLocalStorageList('vendorMaster').map((vendor) => ({
    supplierCode: vendor.seq ? `V-${vendor.seq}` : '', supplierName: vendor.name || '', category: vendor.product || '',
    contact: vendor.contactPerson || '', phone: vendor.phone || vendor.contactNumber || '', email: vendor.email || '',
    address: String(vendor.address || '').replace(/\s+/g, ' ').trim(), gstin: vendor.gstin || vendor.gstNumber || '',
    status: vendor.active === false ? 'Inactive' : vendor.active === true ? 'Active' : 'Not recorded',
    source: 'Vendor Master', referenceCount: '',
    completeness: [vendor.name, vendor.phone || vendor.contactNumber, vendor.email, vendor.gstin || vendor.gstNumber].filter(Boolean).length
  }));
  const transactionSources = [
    ['Supplier POs', readLocalStorageList('supplierPOHistory'), (row) => row.vendor || row.payload?.vendorDetails?.companyName || row.payload?.vendorDetails?.vendorName],
    ['Material Receipts', getReceipts(), (row) => row.supplier || row.vendor],
    ['Supplier Invoices', readLocalStorageList('supplierInvoiceHistory'), (row) => row.vendor || row.payload?.vendorDetails?.companyName || row.payload?.vendorDetails?.vendorName],
    ['HTR Outsourcing', readLocalStorageList('htOutsourceRequests'), (row) => row.vendorName]
  ];
  const transactionRows = transactionSources.flatMap(([source, entries, supplierOf]) => {
    const grouped = new Map();
    entries.forEach((entry) => {
      const name = clean(supplierOf(entry));
      if (!name) return;
      const key = norm(name);
      const prior = grouped.get(key) || { name, count: 0 };
      prior.count += 1;
      grouped.set(key, prior);
    });
    return [...grouped.values()].map(({ name, count }) => ({
      supplierCode: '', supplierName: name, category: '', contact: '', phone: '', email: '', address: '', gstin: '',
      status: 'Transaction snapshot only', source, referenceCount: count, completeness: 1
    }));
  });
  return [...masterRows, ...transactionRows];
};

export const getAvailableIssuedStockRows = () => {
  const byItem = new Map();
  const unmatchedByUnit = new Map();
  getStockTransactions().forEach((tx) => {
    const code = clean(tx.itemCode);
    const unit = clean(tx.unit) || 'Unit not recorded';
    if (!code || code === '-') {
      const unmatched = unmatchedByUnit.get(unit) || { transactionCount: 0, issuedQty: 0, returnedQty: 0, inwardQty: 0, otherOutQty: 0 };
      unmatched.transactionCount += 1;
      const reason = norm(tx.reason);
      if (tx.type === 'IN') {
        unmatched.inwardQty += num(tx.quantity);
        if (reason.includes('return')) unmatched.returnedQty += num(tx.quantity);
      } else if (tx.type === 'OUT') {
        if (reason.includes('issue') || reason.includes('employee')) unmatched.issuedQty += num(tx.quantity);
        else unmatched.otherOutQty += num(tx.quantity);
      }
      unmatchedByUnit.set(unit, unmatched);
      return;
    }
    const key = `${norm(code)}::${norm(unit)}`;
    const row = byItem.get(key) || { itemCode: code, itemName: tx.itemName || '', unit, inwardQty: 0, issuedQty: 0, returnedQty: 0, otherOutQty: 0, transactionCount: 0 };
    row.transactionCount += 1;
    const reason = norm(tx.reason);
    if (tx.type === 'IN') {
      row.inwardQty += num(tx.quantity);
      if (reason.includes('return')) row.returnedQty += num(tx.quantity);
    } else if (tx.type === 'OUT') {
      if (reason.includes('issue') || reason.includes('employee')) row.issuedQty += num(tx.quantity);
      else row.otherOutQty += num(tx.quantity);
    }
    byItem.set(key, row);
  });
  const txRows = [...byItem.values()];
  const txLookup = new Map(txRows.map((row) => [`${norm(row.itemCode)}::${norm(row.unit)}`, row]));
  const rows = getInventoryItems().map((item) => {
    const itemCode = clean(item.itemCode) || clean(item.id) || 'Uncoded item';
    const unit = clean(item.unit) || 'Unit not recorded';
    const tx = txLookup.get(`${norm(itemCode)}::${norm(unit)}`) || {};
    const currentQty = num(item.currentQty);
    const reservedQty = num(item.reservedQty);
    const ledgerNet = num(tx.inwardQty) - num(tx.issuedQty) - num(tx.otherOutQty);
    const hasTransactions = num(tx.transactionCount) > 0;
    return {
      itemCode, itemName: item.itemName || item.materialName || '', category: item.category || 'Uncategorised',
      unit, currentQty, reservedQty, availableQty: Math.max(0, currentQty - reservedQty),
      issuedQty: num(tx.issuedQty), returnedQty: num(tx.returnedQty), transactionCount: num(tx.transactionCount),
      recordedLedgerNet: hasTransactions ? ledgerNet : null,
      variance: hasTransactions ? currentQty - ledgerNet : null,
      reconciliation: hasTransactions ? (currentQty === ledgerNet ? 'Matches recorded movement net' : 'Unreconciled') : 'No movement history'
    };
  }).sort((a, b) => a.itemCode.localeCompare(b.itemCode));
  [...unmatchedByUnit.entries()].forEach(([unit, unmatched]) => rows.push({
    itemCode: '-', itemName: 'Unclassified stock movements; item identity is not recorded', category: 'Unmatched transactions',
    unit, currentQty: null, reservedQty: null, availableQty: null,
    issuedQty: unmatched.issuedQty, returnedQty: unmatched.returnedQty, transactionCount: unmatched.transactionCount,
    recordedLedgerNet: unmatched.inwardQty - unmatched.issuedQty - unmatched.otherOutQty,
    variance: null, reconciliation: 'No matching item master; excluded from item balances'
  }));
  return rows;
};

export const getInwardRows = () => {
  const qcs = getQualityChecks();
  const rows = [];
  getArrivals().forEach((arrival) => {
    const qc = qcs.find((entry) => String(entry.arrivalNumber || '') === String(arrival.arrivalNumber || ''));
    docItems(arrival).forEach((line) => {
      const qcLines = list(qc?.items).filter((candidate) =>
        (line.materialCode && String(candidate.materialCode || candidate.itemCode || '') === String(line.materialCode)) ||
        (!line.materialCode && line.materialName && norm(candidate.materialName) === norm(line.materialName)));
      const qcLine = qcLines.length === 1 ? qcLines[0] : null;
      rows.push({
      eventType: 'Physical arrival', date: arrival.arrivalDate || arrival.date || '', reference: arrival.arrivalNumber || '',
      poNumber: arrival.poNumber || '', supplier: arrival.supplier || arrival.vendorName || '', itemCode: line.materialCode || line.itemCode || '',
      itemName: line.materialName || line.itemName || '', unit: line.unit || '', eventQty: num(line.arrivalQty ?? line.receivedQty),
      acceptedQty: qcLine ? num(qcLine.acceptedQty) : null, rejectedQty: qcLine ? num(qcLine.rejectedQty) : null,
      qcNumber: qc?.qcNumber || arrival.qcNumber || 'Not linked', invoiceOrDN: arrival.invoiceNumber || arrival.dcNumber || '',
      sourceNote: qcLine ? 'Exact unique item match' : qc ? 'QC line is ambiguous/unmatched' : 'No exact QC reference'
    });
    });
  });
  getReceipts().forEach((receipt) => {
    const qc = qcs.find((entry) => String(entry.receiptNumber || '') === String(receipt.receiptNumber || ''));
    docItems(receipt).forEach((line) => {
      const qcLines = list(qc?.items).filter((candidate) =>
        (line.materialCode && String(candidate.materialCode || candidate.itemCode || '') === String(line.materialCode)) ||
        (!line.materialCode && line.materialName && norm(candidate.materialName) === norm(line.materialName)));
      const qcLine = qcLines.length === 1 ? qcLines[0] : null;
      rows.push({
      eventType: 'Material receipt', date: receipt.receiptDate || receipt.date || '', reference: receipt.receiptNumber || '',
      poNumber: receipt.poNumber || '', supplier: receipt.supplier || receipt.vendor || '', itemCode: line.materialCode || line.itemCode || '',
      itemName: line.materialName || line.itemName || '', unit: line.unit || '', eventQty: num(line.receivedQty ?? line.quantity),
      acceptedQty: qcLine ? num(qcLine.acceptedQty) : null, rejectedQty: qcLine ? num(qcLine.rejectedQty) : null,
      qcNumber: qc?.qcNumber || receipt.qcNumber || 'Not linked', invoiceOrDN: receipt.invoiceNumber || receipt.taxInvoiceNumber || '',
      sourceNote: qcLine ? 'Exact unique item match' : qc ? 'QC line is ambiguous/unmatched' : 'No exact QC reference'
    });
    });
  });
  getGRNs().forEach((grn) => docItems(grn).forEach((line) => rows.push({
    eventType: 'Inventory posting (GRN)', date: grn.grnDate || grn.date || '', reference: grn.grnNumber || '',
    poNumber: grn.poRef || grn.poNumber || '', supplier: grn.supplier || '', itemCode: line.itemCode || line.materialCode || '',
    itemName: line.itemName || line.materialName || '', unit: line.unit || '', eventQty: num(line.acceptedQty ?? line.receivedQty),
    acceptedQty: num(line.acceptedQty), rejectedQty: num(line.rejectedQty), qcNumber: grn.qcNumber || 'Not linked',
    invoiceOrDN: grn.supplierInvoice || '', sourceNote: 'Posting event; do not add to physical arrival totals'
  })));
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
};

export const getGRNPOPRRows = () => {
  const pos = getPurchaseOrders();
  const prs = getPurchaseRequests();
  const indents = readLocalStorageList('purchaseIndents');
  const receipts = getReceipts();
  const grns = getGRNs();
  const qcs = getQualityChecks();
  return pos.flatMap((po) => {
    const poNumber = po.reference || po.payload?.poDetails?.poNumber || '';
    const details = po.payload?.poDetails || {};
    const supplier = po.vendor || po.payload?.vendorDetails?.companyName || po.payload?.vendorDetails?.vendorName || '';
    const progress = getPOProgress(poNumber);
    const items = list(po.payload?.items);
    const linkedPR = prs.find((pr) => [pr.poNumber, pr.purchaseOrderNumber, pr.linkedPONumber].some((n) => n && String(n) === String(poNumber)));
    const linkedIndent = indents.find((ind) => String(ind.poNumber || '') === String(poNumber)) ||
      indents.find((ind) => String(ind.indentNumber || '') === String(details.indentNumber || details.indentRef || ''));
    const poReceipts = receipts.filter((r) => String(r.poNumber || '') === String(poNumber));
    const poGrns = grns.filter((r) => String(r.poRef || r.poNumber || '') === String(poNumber));
    const poQCs = qcs.filter((qc) => String(qc.poNumber || '') === String(poNumber));
    return items.map((line, index) => {
      const state = progress.lines?.[index] || {};
      return {
        date: details.poDate || po.date || '', prNumber: linkedPR?.prNumber || linkedIndent?.prNumber || '',
        indentNumber: linkedIndent?.indentNumber || details.indentNumber || details.indentRef || '',
        poNumber, supplier, status: progress.status || po.status || details.poStatus || 'Not recorded',
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
        itemCode: line.itemCode || '', itemName: line.itemName || line.materialName || '', unit: line.unit || state.unit || '',
        orderedQty: num(line.quantity), receivedQty: num(state.receivedQty), pendingQty: num(state.pendingQty),
        rate: num(line.unitPrice ?? line.rate ?? line.price),
        receiptRefs: poReceipts.map((r) => r.receiptNumber).filter(Boolean).join(', '),
        grnRefs: poGrns.map((r) => r.grnNumber).filter(Boolean).join(', '),
        qcRefs: poQCs.map((q) => q.qcNumber).filter(Boolean).join(', '),
        relationshipStatus: linkedPR || linkedIndent ? 'Linked to request/indent' : 'No explicit PR/Indent link'
      };
    });
  });
};

export const getAdvanceShipmentRows = () => {
  // No ASN/advance-shipment state key or API exists. Actual materialArrivals are
  // intentionally not relabelled as advance shipment notices.
  return [];
};

export const getCustomerMaterialStatusRows = () => {
  const salesOrders = getSalesOrders();
  const jobCards = getJobCards();
  const challans = readLocalStorageList('deliveryChallanHistory');
  return salesOrders.flatMap((order) => {
    const orderRef = order.reference || order.payload?.soDetails?.soNumber || '';
    const so = order.payload || {};
    const soDetails = so.soDetails || {};
    const customer = so.customerDetails?.companyName || so.customerDetails?.customerName || order.company || order.customer || '';
    return list(so.items).map((item) => {
      const itemCode = clean(item.itemCode || item.materialCode);
      const itemName = clean(item.itemName || item.materialName);
      const jcs = jobCards.filter((jc) => String(jc.salesOrderRef || '') === String(orderRef) &&
        ((itemCode && String(jc.itemCode || jc.partCode || '') === itemCode) || (!itemCode && itemName && norm(jc.partName) === norm(itemName))));
      const dcs = challans.filter((dc) => String(dc.salesOrderRef || dc.payload?.dcDetails?.salesOrderRef || '') === String(orderRef));
      const dispatchLines = dcs.flatMap((dc) => docItems(dc).filter((dl) =>
        (itemCode && String(dl.itemCode || '') === itemCode) || (!itemCode && itemName && norm(dl.itemName) === norm(itemName))));
      const accepted = jcs.reduce((sum, jc) => sum + num(jc.qualityControl?.finalQC?.acceptedQty), 0);
      const produced = jcs.reduce((sum, jc) => sum + num(jc.producedQty), 0);
      const dispatched = dispatchLines.reduce((sum, dl) => sum + num(dl.quantity), 0);
      const linked = Boolean(orderRef && (jcs.length || dispatchLines.length));
      return {
        date: soDetails.soDate || order.date || '', customer, salesOrder: orderRef,
        projectId: soDetails.projectId || '', itemCode, itemName, unit: item.unit || '',
        orderedQty: num(item.quantity), jobCardCount: jcs.length, producedQty: produced,
        acceptedQty: accepted, dispatchedQty: dispatched,
        readyQty: linked ? Math.max(0, accepted - dispatched) : null,
        status: linked ? (accepted > dispatched ? 'Ready / partial dispatch' : 'No remaining QC-cleared quantity') : 'Production/dispatch link unavailable'
      };
    });
  });
};

export const getMRNDetailRows = () => {
  const requests = getMaterialRequests();
  const issues = getStoreIssues();
  const returns = getMaterialReturns();
  const purchaseRequests = getPurchaseRequests();
  const indents = readLocalStorageList('purchaseIndents');
  return requests.flatMap((mr) => list(mr.items).map((line, index) => {
    const itemCode = clean(line.materialId || line.itemCode);
    const sameLines = list(mr.items).filter((candidate) => norm(candidate.materialId || candidate.itemCode) === norm(itemCode));
    const linkedIssues = issues.filter((issue) => String(issue.mrNumber || '') === String(mr.mrNumber || ''))
      .flatMap((issue) => list(issue.items).filter((issued) => norm(issued.materialId) === norm(itemCode)));
    const linkedReturns = returns.filter((ret) => String(ret.mrNumber || '') === String(mr.mrNumber || ''))
      .flatMap((ret) => list(ret.items).filter((returned) => norm(returned.materialId) === norm(itemCode)));
    const linkedPRs = purchaseRequests.filter((pr) => String(pr.mrNumber || '') === String(mr.mrNumber || ''));
    const linkedIndents = indents.filter((indent) => String(indent.mrNumber || '') === String(mr.mrNumber || ''));
    const requestedQty = num(line.requiredQty ?? line.quantity ?? line.requestedQty);
    const issuedQty = linkedIssues.reduce((sum, issued) => sum + num(issued.currentIssueQty), 0);
    const returnedQty = linkedReturns.reduce((sum, returned) => sum + num(returned.quantityReturned ?? returned.returnQty ?? returned.quantity), 0);
    const ambiguous = sameLines.length > 1;
    return {
      date: mr.requestDate || mr.date || mr.createdAt || '', mrNumber: mr.mrNumber || '',
      jobCardNumber: mr.jobCardNumber || '', salesOrder: mr.salesOrderRef || '', projectId: mr.projectId || '',
      customer: mr.customer || '', requestedBy: mr.requestedBy || '', itemCode,
      itemName: line.materialName || line.itemName || '', unit: line.unit || '', requestedQty,
      prNumbers: linkedPRs.map((pr) => pr.prNumber).filter(Boolean).join(', '),
      indentNumbers: linkedIndents.map((indent) => indent.indentNumber).filter(Boolean).join(', '),
      issueRefs: issues.filter((issue) => issue.mrNumber === mr.mrNumber).map((issue) => issue.issueNumber).filter(Boolean).join(', '),
      issuedQty: ambiguous ? null : issuedQty, returnedQty: ambiguous ? null : returnedQty,
      pendingIssueQty: ambiguous ? null : Math.max(0, requestedQty - issuedQty),
      status: ambiguous ? 'Repeated item lines; source line link unavailable' : mr.status || 'Not recorded',
      sourceOrdinal: index + 1
    };
  }));
};

export const getOutsourcingReportRows = () => {
  const htr = readLocalStorageList('htOutsourceRequests');
  return htr.map((record) => ({
    date: record.issuedDate || '', process: 'Heat Treatment', deliveryNote: record.outwardChallan || record.deliveryNote || '',
    reference: record.htrNumber || '', supplier: record.vendorName || 'Not assigned', jobCardNumber: record.jobCardNumber || '',
    projectId: record.projectId || '', itemName: record.partName || record.itemName || '', itemCode: record.inventoryItemCode || '',
    unit: record.unit || '', sentQty: num(record.issuedQty || record.qtySent), receivedQty: num(record.receivedQty),
    outstandingQty: Math.max(0, num(record.issuedQty || record.qtySent) - num(record.receivedQty)),
    status: record.status || 'Not recorded', source: 'HTR'
  }));
};

export const trackAFilterOptions = (rows) => ({
  suppliers: unique(rows, 'supplier'), statuses: unique(rows, 'status'),
  supplierNames: unique(rows, 'supplierName'),
  items: unique(rows, 'itemName'), categories: unique(rows, 'category'),
  reconciliations: unique(rows, 'reconciliation'),
  customers: unique(rows, 'customer'), projects: unique(rows, 'projectId'),
  employees: unique(rows, 'employee'), mrNumbers: unique(rows, 'mrNumber'),
  processes: unique(rows, 'process'), eventTypes: unique(rows, 'eventType'),
  poNumbers: unique(rows, 'poNumber')
});

export const qtyByUnit = groupQty;
