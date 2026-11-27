const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const normalizeInventoryItem = (row = {}) => ({
  ...(row.payload || {}),
  ...row,
  id: row.item_code || row.itemCode || row.id,
  itemCode: row.item_code || row.itemCode || row.id,
  itemName: row.material_name || row.materialName || row.itemName || '',
  materialName: row.material_name || row.materialName || row.itemName || '',
  currentQty: number(row.current_qty ?? row.currentQty),
  reservedQty: number(row.payload?.reservedQty ?? row.reservedQty),
  reorderLevel: number(row.reorder_level ?? row.reorderLevel),
  minReorderLevel: number(row.reorder_level ?? row.minReorderLevel),
  unitCost: number(row.unit_price ?? row.unitCost),
  hsnSac: row.hsn_code || row.hsnSac || ''
});

export const normalizeInventoryBatch = (row = {}) => ({
  ...(row.payload || {}),
  ...row,
  id: row.id,
  itemCode: row.item_code || row.itemCode || '',
  itemName: row.payload?.itemName || row.material_name || row.itemName || '',
  batchNumber: row.batch_number || row.batchNumber || '',
  lotNumber: row.lot_number || row.lotNumber || '',
  qtyReceived: number(row.initial_qty ?? row.qtyReceived),
  availableQty: number(row.available_qty ?? row.availableQty),
  expiryDate: row.expiry_date || row.expiryDate || '',
  unit: row.unit || ''
});

const isOutbound = (type) => ['OUT', 'ISSUE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'DISPATCH', 'REJECT'].includes(String(type || '').toUpperCase());

export const normalizeStockLedgerEntry = (row = {}) => ({
  ...(row.payload || {}),
  ...row,
  id: row.id,
  itemCode: row.item_code || row.itemCode || '',
  itemName: row.payload?.itemName || row.item_name || row.itemName || '',
  type: isOutbound(row.movement_type || row.type) ? 'OUT' : 'IN',
  movementType: row.movement_type || row.movementType || '',
  quantity: number(row.quantity),
  date: row.entry_date || row.date || '',
  dateTime: row.entry_time || row.dateTime || '',
  unit: row.unit || '',
  reason: [row.reason, row.source_doc_type].filter(Boolean).join(' '),
  reference: row.source_doc_ref || row.reference || '',
  transactionNumber: row.id || row.transactionNumber || '',
  batchNo: row.batch_no || row.batchNo || '',
  lotNumber: row.lot_number || row.lotNumber || '',
  receiptBatchId: row.payload?.receiptBatchId || row.receiptBatchId || '',
  warehouse: row.payload?.warehouse || row.payload?.location || row.warehouse || ''
});
