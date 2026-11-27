const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const dateOf = (tx) => String(tx.date || tx.dateTime || '').slice(0, 10);
const labelOf = (batch) => batch.internalBatchId || batch.supplierBatchNumber || batch.batchNumber || batch.lotNumber || 'Unidentified legacy batch';

const expiryStatus = (expiryDate, nearDays = 30) => {
  if (!expiryDate) return { status: 'UNKNOWN', daysLeft: null };
  const expiry = new Date(`${String(expiryDate).slice(0, 10)}T23:59:59`);
  if (Number.isNaN(expiry.getTime())) return { status: 'UNKNOWN', daysLeft: null };
  const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
  if (daysLeft < 0) return { status: 'EXPIRED', daysLeft };
  if (daysLeft <= nearDays) return { status: 'NEAR', daysLeft };
  return { status: 'VALID', daysLeft };
};

const itemLookup = (items) => new Map(items.map((item) => [String(item.itemCode || '').toLowerCase(), item]));

const attachTransactions = (batches, transactions) => {
  const result = new Map(batches.map((batch) => [batch.id, []]));
  const uncertain = [];
  transactions.forEach((tx) => {
    if (tx.receiptBatchId || tx.internalBatchId) {
      const match = batches.find((batch) =>
        (tx.receiptBatchId && String(batch.id || '') === String(tx.receiptBatchId)) ||
        (tx.internalBatchId && String(batch.internalBatchId || '') === String(tx.internalBatchId))
      );
      if (match) result.get(match.id)?.push(tx);
      else uncertain.push(tx);
      return;
    }
    const sameBatch = batches.filter((batch) =>
      String(batch.itemCode || '').toLowerCase() === String(tx.itemCode || '').toLowerCase() &&
      String(batch.supplierBatchNumber || batch.batchNumber || '').toLowerCase() === String(tx.batchNo || '').toLowerCase() &&
      String(batch.batchNumber || tx.batchNo || '').trim()
    );
    if (sameBatch.length === 1) result.get(sameBatch[0].id)?.push(tx);
    else if (sameBatch.length > 1) uncertain.push(tx);
  });
  return { result, uncertain };
};

const batchRows = ({ items = [], batches = [], transactions = [] } = {}) => {
  const itemIndex = itemLookup(items);
  const { result: txByBatch } = attachTransactions(batches, transactions);
  return batches.map((batch) => {
    const item = itemIndex.get(String(batch.itemCode || '').toLowerCase()) || {};
    const tx = txByBatch.get(batch.id) || [];
    const issued = tx.filter((entry) => entry.type === 'OUT' && !String(entry.reason || '').toLowerCase().includes('stock transfer'))
      .reduce((sum, entry) => sum + number(entry.quantity), 0);
    const transfersOut = tx.filter((entry) => String(entry.reason || '').toLowerCase().includes('stock transfer') && entry.type === 'OUT')
      .reduce((sum, entry) => sum + number(entry.quantity), 0);
    const adjustments = tx.filter((entry) => /adjust|write.off|damage/i.test(entry.reason || ''))
      .reduce((sum, entry) => sum + (entry.type === 'IN' ? number(entry.quantity) : -number(entry.quantity)), 0);
    const current = Math.max(0, number(batch.availableQty));
    const dimensions = { ...(item.dimensions || {}), ...(batch.dimensions || {}) };
    for (const key of ['length', 'width', 'thickness', 'diameter', 'size', 'weight']) {
      dimensions[key] ??= batch[key] ?? item[key] ?? '';
    }
    if (batch.sizeDimensions || item.sizeDimensions) dimensions.size ||= batch.sizeDimensions || item.sizeDimensions;
    const expiry = expiryStatus(batch.expiryDate);
    return {
      id: batch.id,
      material: batch.itemName || item.itemName || batch.itemCode || '-',
      itemCode: batch.itemCode || item.itemCode || '',
      lot: labelOf(batch),
      supplierBatchNumber: batch.supplierBatchNumber || batch.batchNumber || '',
      internalBatchId: batch.internalBatchId || '',
      supplier: batch.supplier || '',
      grnNumber: batch.grnNumber || '',
      location: batch.warehouse || batch.location || 'Unspecified',
      receivedDate: batch.receivedDate || '',
      expiryDate: batch.expiryDate || '',
      expiryStatus: batch.expiryDate ? expiry.status : (batch.shelfLifeManaged ? 'Unknown expiry' : 'Not shelf-life tracked'),
      daysToExpiry: expiry.daysLeft,
      physicalQty: current,
      receivedQty: number(batch.qtyReceived),
      issuedQty: issued,
      adjustmentQty: adjustments,
      transferOutQty: transfersOut,
      reservedQty: Number.isFinite(Number(batch.reservedQty)) ? number(batch.reservedQty) : null,
      blockedQty: number(batch.blockedQty),
      rejectedQty: number(batch.rejectedQty),
      usableQty: Math.max(0, current - number(batch.reservedQty) - number(batch.blockedQty) - number(batch.rejectedQty)),
      qcStatus: batch.qcStatus || batch.status || 'Unknown',
      status: batch.status || 'Unknown',
      unit: batch.unit || item.unit || '',
      dimensions
    };
  });
};

export const getLotWiseStockRows = (data) => batchRows(data).map((batch) => ({
  ...batch,
  openingQty: 0,
  adjustments: batch.adjustmentQty,
  closingQty: batch.physicalQty
}));

export const getExpiredLotRows = (data, today = new Date().toISOString().slice(0, 10)) =>
  batchRows(data).filter((batch) => batch.expiryDate && batch.expiryDate < today && batch.expiryStatus === 'EXPIRED')
    .map((batch) => ({ ...batch, date: batch.expiryDate, status: batch.status || 'Expired' }));

export const getLotAvailabilityRows = (data) => batchRows(data).map((batch) => ({
  ...batch,
  reservedDisplay: batch.reservedQty === null ? 'Not allocated by lot' : batch.reservedQty,
  usableDisplay: batch.reservedQty === null ? 'Not available by lot' : batch.usableQty
}));

export const getLotDimensionRows = (data) => batchRows(data).filter((batch) =>
  Object.values(batch.dimensions).some((value) => value !== '' && value !== null && value !== undefined)
);

export const getLocationLotLedgerRows = ({ items = [], batches = [], transactions = [] } = {}) => {
  const itemIndex = itemLookup(items);
  const { result: txByBatch, uncertain } = attachTransactions(batches, transactions);
  const rows = [];
  batches.forEach((batch) => {
    let balance = 0;
    const entries = [...(txByBatch.get(batch.id) || [])].sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || String(a.dateTime || '').localeCompare(String(b.dateTime || '')));
    entries.forEach((tx) => {
      const openingQty = balance;
      const qty = number(tx.quantity);
      const type = tx.type === 'IN' ? 'Inward' : 'Outward';
      balance += tx.type === 'IN' ? qty : -qty;
      const reason = String(tx.reason || '');
      const transfer = /stock transfer/i.test(reason);
      const adjustment = /adjust|write.off|damage/i.test(reason);
      rows.push({
        date: dateOf(tx), material: tx.itemName || batch.itemName || '', itemCode: tx.itemCode || batch.itemCode || '',
        lot: labelOf(batch), location: tx.warehouse || tx.location || batch.warehouse || 'Unspecified',
        reference: tx.reference || tx.transactionNumber || '', movement: transfer ? 'Transfer' : adjustment ? 'Adjustment' : type,
        inwardQty: tx.type === 'IN' && !transfer ? qty : 0,
        outwardQty: tx.type === 'OUT' && !transfer ? qty : 0,
        transferInQty: transfer && tx.type === 'IN' ? qty : 0,
        transferOutQty: transfer && tx.type === 'OUT' ? qty : 0,
        adjustmentQty: adjustment ? (tx.type === 'IN' ? qty : -qty) : 0,
        openingQty, closingQty: Math.max(0, balance), unit: tx.unit || batch.unit || itemIndex.get(String(batch.itemCode || '').toLowerCase())?.unit || ''
      });
    });
  });
  if (uncertain.length) rows.push({
    date: '', material: 'Legacy transactions with ambiguous batch match', itemCode: '', lot: 'Unallocated',
    location: 'Unspecified', reference: `${uncertain.length} movement(s)`, movement: 'Needs batch identification',
    inwardQty: 0, outwardQty: 0, transferInQty: 0, transferOutQty: 0, adjustmentQty: 0, openingQty: 0, closingQty: '', unit: ''
  });
  return rows;
};

export const getInventoryLotFilterOptions = (rows) => ({
  materials: [...new Set(rows.map((row) => row.material).filter(Boolean))].sort(),
  lots: [...new Set(rows.map((row) => row.lot).filter(Boolean))].sort(),
  locations: [...new Set(rows.map((row) => row.location).filter(Boolean))].sort(),
  statuses: [...new Set(rows.map((row) => row.status || row.expiryStatus || row.qcStatus).filter(Boolean))].sort()
});

export const getPresentLotDimensions = (rows) => ['length', 'width', 'thickness', 'diameter', 'size', 'weight']
  .filter((key) => rows.some((row) => row.dimensions?.[key] !== '' && row.dimensions?.[key] !== null && row.dimensions?.[key] !== undefined));

