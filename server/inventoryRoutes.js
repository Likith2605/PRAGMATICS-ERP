import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { postStockMovement } from './stockLedger.js';
import { hasPermissionForRole } from './departmentAccess.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value, fallback = '') => String(value ?? fallback).trim();
const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const allowRead = (req, res, next) => {
  if (isAdmin(req) || hasPermissionForRole(req.user?.roleKey, ['store.module', 'inventory.view', 'inventory.transaction.view', 'inventory.adjust'], req.user?.rolePermissions || [])) return next();
  return res.status(403).json({ error: 'Your department role does not allow Inventory reads.' });
};
const requireInventoryAdjustment = (req, res, next) => {
  if (isAdmin(req) || hasPermissionForRole(req.user?.roleKey, ['inventory.adjust'], req.user?.rolePermissions || [])) return next();
  return res.status(403).json({ error: 'Inventory adjustment requires explicit authorization.' });
};
const auditDocument = (client, req, module, recordId, action, before, after, reason = '') => client.query(
  `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
  [req.user?.id || '', req.user?.email || '', req.user?.role || req.user?.roleKey || '', module,
    recordId, recordId, action, text(reason),
    before ? JSON.stringify(safeAuditValues(before)) : null,
    after ? JSON.stringify(safeAuditValues(after)) : null]
);
const nextStoreDocumentNumber = async (client, prefix, sequenceKey, table, column) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('store-seq:' || $1))", [sequenceKey]);
  const sequence = await client.query('SELECT last_number FROM store_sequences WHERE sequence_key=$1 FOR UPDATE', [sequenceKey]);
  const maximum = await client.query(`SELECT COALESCE(max(substring(${column} from '(\\d+)$')::bigint),0)::bigint AS value FROM ${table}`);
  const next = Math.max(Number(sequence.rows[0]?.last_number) || 0, Number(maximum.rows[0]?.value) || 0) + 1;
  await client.query(
    `INSERT INTO store_sequences(sequence_key,last_number,updated_at) VALUES($1,$2,now())
     ON CONFLICT(sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`,
    [sequenceKey, next]
  );
  return `${prefix}-${String(next).padStart(6, '0')}`;
};
const transferView = async (client, row) => {
  const items = await client.query(
    `SELECT l.*,i.material_name,b.batch_number,b.lot_number
       FROM stock_transfer_items l
       JOIN inventory_items i ON i.item_code=l.item_code
       LEFT JOIN inventory_batches b ON b.id=l.batch_id
      WHERE l.transfer_number=$1 ORDER BY l.line_number`,
    [row.transfer_number]
  );
  return {
    ...(row.payload || {}),
    ...row,
    transferNumber: row.transfer_number,
    transferDate: dateText(row.transfer_date),
    fromLocation: row.from_location,
    toLocation: row.to_location,
    requestedBy: row.requested_by,
    requestedByEmpId: row.requested_by_employee_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionReason: row.resolution_reason,
    recordVersion: Number(row.version),
    items: items.rows.map((line) => ({
      ...(line.payload || {}),
      ...line,
      itemCode: line.item_code,
      itemName: line.material_name,
      batchId: line.batch_id,
      batchNumber: line.batch_number || '',
      lotNumber: line.lot_number || '',
      quantity: num(line.quantity),
      unit: line.unit
    }))
  };
};
const verificationView = async (client, row) => {
  const items = await client.query(
    `SELECT l.*,i.material_name,b.batch_number,b.lot_number
       FROM stock_verification_items l
       JOIN inventory_items i ON i.item_code=l.item_code
       LEFT JOIN inventory_batches b ON b.id=l.batch_id
      WHERE l.verification_number=$1 ORDER BY l.line_number`,
    [row.verification_number]
  );
  return {
    ...(row.payload || {}),
    ...row,
    verificationNumber: row.verification_number,
    verificationDate: dateText(row.verification_date),
    verifiedBy: row.verified_by,
    verifiedById: row.verified_by_employee_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionReason: row.resolution_reason,
    recordVersion: Number(row.version),
    items: items.rows.map((line) => ({
      ...(line.payload || {}),
      ...line,
      itemCode: line.item_code,
      itemName: line.material_name,
      batchId: line.batch_id,
      batchNumber: line.batch_number || '',
      lotNumber: line.lot_number || '',
      systemQty: num(line.system_quantity),
      physicalQty: num(line.physical_quantity),
      difference: num(line.variance),
      unit: line.unit,
      remarks: line.remarks
    }))
  };
};

const allowWrite = (req, res, next) => {
  if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
  const permissions = req.user?.rolePermissions || [];
  if (hasPermissionForRole(req.user?.roleKey, ['store.module', 'inventory.manage', 'inventory.adjust'], permissions)) return next();
  return res.status(403).json({ error: 'Your department role does not allow Inventory changes.' });
};

const audit = (client, req, itemCode, action, before, after, reason = '') => client.query(
  `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES($1,$2,$3,'inventoryItems',$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
  [req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', itemCode,
    after?.material_name || before?.material_name || itemCode, action, reason,
    before ? JSON.stringify(safeAuditValues(before)) : null, after ? JSON.stringify(safeAuditValues(after)) : null]
);

router.get('/items', async (req, res) => {
  const search = `%${text(req.query.search || '').toLowerCase()}%`;
  const result = await getPool().query(
    `SELECT * FROM inventory_items
      WHERE deleted_at IS NULL
        AND (lower(material_name) LIKE $1 OR lower(item_code) LIKE $1 OR lower(category) LIKE $1)
      ORDER BY material_name, item_code`,
    [search]
  );
  res.json({ records: result.rows });
});

router.get('/items/:itemCode', async (req, res) => {
  const result = await getPool().query(
    'SELECT * FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL',
    [req.params.itemCode]
  );
  if (!result.rowCount) throw notFound('Inventory item not found.');
  const batches = await getPool().query(
    'SELECT * FROM inventory_batches WHERE item_code=$1 ORDER BY expiry_date NULLS LAST, batch_number',
    [req.params.itemCode]
  );
  res.json({ record: result.rows[0], batches: batches.rows });
});

router.post('/items', allowWrite, async (req, res) => {
  const data = req.body?.data || req.body || {};
  const itemCode = text(data.itemCode || data.materialCode);
  if (!itemCode) throw bad('Item code is required.');
  if (!text(data.materialName || data.itemName)) throw bad('Material name is required.');
  const version = Number(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM inventory_items WHERE item_code=$1 FOR UPDATE', [itemCode]);
    if (current.rowCount && current.rows[0].deleted_at) throw conflict('This inventory item is deleted.');
    if (current.rowCount && Number.isInteger(version) && Number(current.rows[0].version) !== version) {
      throw conflict('Inventory item changed on the server. Reload before editing.', current.rows[0]);
    }
    const after = {
      material_name: text(data.materialName || data.itemName),
      category: text(data.category, 'Raw Material'),
      unit: text(data.unit, 'Nos'),
      reorder_level: num(data.reorderLevel ?? data.minReorderLevel),
      min_order_qty: num(data.minOrderQty),
      unit_price: num(data.unitPrice),
      shelf_life_managed: Boolean(data.shelfLifeManaged),
      shelf_life_days: Number(data.shelfLifeDays) || 0,
      location: text(data.location),
      hsn_code: text(data.hsnCode)
    };
    if (current.rowCount && num(current.rows[0].current_qty) > 0
      && text(current.rows[0].location, 'Unassigned') !== text(after.location, 'Unassigned')) {
      throw conflict('Inventory location cannot be changed while stock is on hand. Create a stock transfer instead.');
    }
    let saved;
    if (current.rowCount) {
      saved = await client.query(
        `UPDATE inventory_items SET material_name=$2,category=$3,unit=$4,reorder_level=$5,min_order_qty=$6,
          unit_price=$7,shelf_life_managed=$8,shelf_life_days=$9,location=$10,hsn_code=$11,
          payload=$12::jsonb,version=version+1,updated_at=now() WHERE item_code=$1 RETURNING *`,
        [itemCode, after.material_name, after.category, after.unit, after.reorder_level, after.min_order_qty,
          after.unit_price, after.shelf_life_managed, after.shelf_life_days, after.location, after.hsn_code,
          JSON.stringify({ ...data, updatedBy: req.user?.email || 'System' })]
      );
    } else {
      saved = await client.query(
        `INSERT INTO inventory_items (item_code,material_name,category,unit,reorder_level,min_order_qty,unit_price,
          shelf_life_managed,shelf_life_days,location,hsn_code,version,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12::jsonb) RETURNING *`,
        [itemCode, after.material_name, after.category, after.unit, after.reorder_level, after.min_order_qty,
          after.unit_price, after.shelf_life_managed, after.shelf_life_days, after.location, after.hsn_code,
          JSON.stringify({ ...data, createdBy: req.user?.email || 'System', updatedBy: req.user?.email || 'System' })]
      );
    }
    await client.query(
      `INSERT INTO inventory_location_balances(item_code,location,quantity)
       VALUES($1,$2,$3) ON CONFLICT(item_code,location) DO NOTHING`,
      [itemCode, text(after.location) || 'Unassigned', num(saved.rows[0].current_qty)]
    );
    await audit(client, req, itemCode, current.rowCount ? 'MASTER_UPDATE' : 'MASTER_CREATE', current.rows[0] || null, saved.rows[0], text(req.body?.reason));
    await client.query('COMMIT');
    res.status(current.rowCount ? 200 : 201).json({ record: saved.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/** Authoritative soft delete. The row is retained for stock-ledger history. */
router.delete('/items/:itemCode', requireAdmin, async (req, res) => {
  const itemCode = req.params.itemCode;
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  if (!Number.isInteger(version) || version < 1) throw bad('The current PostgreSQL version is required.');
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM inventory_items WHERE item_code=$1 FOR UPDATE', [itemCode]);
    if (!current.rowCount || current.rows[0].deleted_at) throw notFound('Inventory item not found.');
    if (Number(current.rows[0].version) !== version) throw conflict('Inventory item changed on the server. Reload before deleting.', current.rows[0]);
    if (num(current.rows[0].current_qty) !== 0) throw conflict('Inventory item still has stock and cannot be deleted.');
    const openBatches = await client.query('SELECT 1 FROM inventory_batches WHERE item_code=$1 AND available_qty<>0 LIMIT 1', [itemCode]);
    if (openBatches.rowCount) throw conflict('Inventory item has open batches and cannot be deleted.');
    const deleted = await client.query(
      `UPDATE inventory_items SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now()
        WHERE item_code=$1 RETURNING *`,
      [itemCode, req.user?.email || req.user?.roleKey || 'System', reason]
    );
    await audit(client, req, itemCode, 'MASTER_DELETE', current.rows[0], deleted.rows[0], reason);
    await client.query('COMMIT');
    res.json({ record: deleted.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/opening-stock', allowWrite, async (req, res) => {
  const data = req.body || {};
  const itemCode = text(data.itemCode);
  const quantity = num(data.quantity);
  if (!itemCode || quantity <= 0) throw bad('Item code and a positive opening quantity are required.');
  const ledgerId = text(data.idempotencyKey || data.id || `opening-${itemCode}-${text(data.entryDate)}`);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await postStockMovement(client, req, {
      ledgerId, itemCode, materialName: data.materialName || '', movementType: 'OPENING',
      quantity, unit: data.unit || 'Nos', unitCost: data.unitCost || 0,
      entryDate: data.entryDate || new Date().toISOString().slice(0, 10),
      sourceDocType: 'Opening Stock', sourceDocRef: ledgerId,
      location: text(data.location || data.warehouse),
      batchNo: data.batchNo || '', batchId: data.batchId || data.internalBatchId || '',
      batchInitialQty: quantity, lotNumber: data.lotNumber || '',
      batchMetadata: data.batchMetadata || data,
      reason: text(data.reason, 'Opening stock'), payload: data
    });
    await client.query('COMMIT');
    res.status(result.duplicate ? 200 : 201).json({ ...result, duplicate: result.duplicate });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/adjustments', requireInventoryAdjustment, async (req, res) => {
  const data = req.body || {};
  const itemCode = text(data.itemCode);
  const quantity = Math.abs(num(data.quantity));
  if (!itemCode || quantity <= 0) throw bad('Item code and a non-zero adjustment quantity are required.');
  if (!text(data.reason)) throw bad('Adjustment reason is required.');
  const movementType = num(data.quantity) < 0 ? 'ADJUSTMENT_OUT' : 'ADJUSTMENT_IN';
  const ledgerId = text(data.idempotencyKey || `adjust-${itemCode}-${text(data.reason).replace(/\W+/g, '-')}-${text(data.entryDate)}`);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await postStockMovement(client, req, {
      ledgerId, itemCode, materialName: data.materialName || '', movementType, quantity,
      unit: data.unit || 'Nos', unitCost: data.unitCost || 0,
      entryDate: data.entryDate || new Date().toISOString().slice(0, 10),
      sourceDocType: 'Inventory Adjustment', sourceDocRef: ledgerId,
      location: text(data.location || data.warehouse),
      batchNo: data.batchNo || '', batchId: data.batchId || data.internalBatchId || '',
      lotNumber: data.lotNumber || '',
      batchMetadata: data.batchMetadata || data,
      reason: text(data.reason), payload: data
    });
    await client.query('COMMIT');
    res.status(result.duplicate ? 200 : 201).json({ ...result, duplicate: result.duplicate });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/location-balances', allowRead, async (req, res) => {
  const values = [];
  const clauses = [];
  if (text(req.query.itemCode)) {
    values.push(text(req.query.itemCode));
    clauses.push(`b.item_code=$${values.length}`);
  }
  if (text(req.query.location)) {
    values.push(text(req.query.location));
    clauses.push(`b.location=$${values.length}`);
  }
  const result = await getPool().query(
    `SELECT b.item_code, i.material_name, i.unit, b.location, b.quantity, b.version, b.updated_at
       FROM inventory_location_balances b
       JOIN inventory_items i ON i.item_code=b.item_code
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY lower(i.material_name), b.location`,
    values
  );
  res.json({ records: result.rows });
});

router.get('/location-batch-balances', allowRead, async (req, res) => {
  const values = [];
  const clauses = [];
  if (text(req.query.itemCode)) {
    values.push(text(req.query.itemCode));
    clauses.push(`b.item_code=$${values.length}`);
  }
  if (text(req.query.location)) {
    values.push(text(req.query.location));
    clauses.push(`b.location=$${values.length}`);
  }
  const result = await getPool().query(
    `SELECT b.batch_id,b.item_code,i.material_name,i.unit,b.location,b.quantity,b.version,b.updated_at,
            batch.batch_number,batch.lot_number,batch.expiry_date
       FROM inventory_location_batch_balances b
       JOIN inventory_batches batch ON batch.id=b.batch_id
       JOIN inventory_items i ON i.item_code=b.item_code
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY lower(i.material_name),b.location,batch.batch_number`,
    values
  );
  res.json({ records: result.rows });
});

router.post('/transfers', allowWrite, async (req, res) => {
  const data = req.body || {};
  const itemCode = text(data.itemCode);
  const quantity = num(data.quantity);
  if (!itemCode || quantity <= 0) throw bad('Item code and a positive transfer quantity are required.');
  const transferRef = text(data.transferReference || data.idempotencyKey);
  if (!transferRef) throw bad('A unique transfer reference is required.');
  const fromLocation = text(data.fromLocation || data.fromWarehouse);
  const toLocation = text(data.toLocation || data.toWarehouse);
  if (!fromLocation || !toLocation) throw bad('Source and destination locations are required.');
  if (fromLocation.toLocaleLowerCase() === toLocation.toLocaleLowerCase()) throw bad('Source and destination locations must be different.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await postStockMovement(client, req, {
      ledgerId: `transfer-out-${transferRef}`, itemCode, materialName: data.materialName || '',
      movementType: 'TRANSFER_OUT', quantity, unit: data.unit || 'Nos', unitCost: data.unitCost || 0,
      entryDate: data.entryDate || new Date().toISOString().slice(0, 10),
      sourceDocType: 'Stock Transfer', sourceDocRef: transferRef,
      location: fromLocation,
      batchNo: data.batchNo || '', batchId: data.batchId || data.internalBatchId || '',
      lotNumber: data.lotNumber || '',
      batchMetadata: data.batchMetadata || data,
      reason: text(data.reason, `Transfer to ${text(data.toLocation)}`), payload: { ...data, direction: 'OUT' }
    });
    const into = await postStockMovement(client, req, {
      ledgerId: `transfer-in-${transferRef}`, itemCode, materialName: data.materialName || '',
      movementType: 'TRANSFER_IN', quantity, unit: data.unit || 'Nos', unitCost: data.unitCost || 0,
      entryDate: data.entryDate || new Date().toISOString().slice(0, 10),
      sourceDocType: 'Stock Transfer', sourceDocRef: transferRef,
      location: toLocation,
      batchNo: data.batchNo || '', batchId: data.batchId || data.internalBatchId || '',
      lotNumber: data.lotNumber || '',
      batchMetadata: data.batchMetadata || data,
      reason: text(data.reason, `Transfer to ${text(data.toLocation)}`), payload: { ...data, direction: 'IN' }
    });

    await client.query('COMMIT');
    res.status(out.duplicate && into.duplicate ? 200 : 201).json({ out, into, duplicate: out.duplicate && into.duplicate });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/transfer-documents', allowRead, async (req, res) => {
  const status = text(req.query.status);
  const result = await getPool().query(
    `SELECT * FROM stock_transfers ${status ? 'WHERE status=$1' : ''}
      ORDER BY transfer_date DESC,created_at DESC`,
    status ? [status] : []
  );
  const client = await getPool().connect();
  try {
    const records = [];
    for (const row of result.rows) records.push(await transferView(client, row));
    res.json({ records });
  } finally { client.release(); }
});

router.get('/transfer-documents/:transferNumber', allowRead, async (req, res) => {
  const result = await getPool().query('SELECT * FROM stock_transfers WHERE transfer_number=$1', [req.params.transferNumber]);
  if (!result.rowCount) throw notFound('Stock Transfer not found.');
  const client = await getPool().connect();
  try { res.json({ record: await transferView(client, result.rows[0]) }); } finally { client.release(); }
});

router.post('/transfer-documents', allowWrite, async (req, res) => {
  const data = req.body?.data || req.body || {};
  const fromLocation = text(data.fromLocation || data.fromWarehouse);
  const toLocation = text(data.toLocation || data.toWarehouse);
  const idempotencyKey = text(req.body?.idempotencyKey || data.idempotencyKey);
  const lines = Array.isArray(data.items) ? data.items : [];
  if (!idempotencyKey) throw bad('An idempotency key is required to create a Stock Transfer.');
  if (!fromLocation || !toLocation) throw bad('Source and destination locations are required.');
  if (fromLocation.toLocaleLowerCase() === toLocation.toLocaleLowerCase()) throw bad('Source and destination locations must be different.');
  if (!lines.length) throw bad('At least one transfer line is required.');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stock-transfer-create:' || $1))", [idempotencyKey]);
    const duplicate = await client.query(
      'SELECT * FROM stock_transfers WHERE idempotency_key=$1 FOR UPDATE',
      [idempotencyKey]
    );
    if (duplicate.rowCount) {
      const samePayload = await client.query(
        'SELECT request_payload=$2::jsonb AS same FROM stock_transfers WHERE transfer_number=$1',
        [duplicate.rows[0].transfer_number, JSON.stringify(data)]
      );
      if (!samePayload.rows[0]?.same) throw conflict('This Stock Transfer idempotency key was already used for different data.');
      const record = await transferView(client, duplicate.rows[0]);
      await client.query('COMMIT');
      return res.status(200).json({ record, duplicate: true });
    }

    const normalizedLines = [];
    const requested = new Map();
    for (const [index, line] of lines.entries()) {
      const itemCode = text(line.itemCode || line.materialId);
      const quantity = Number(line.quantity);
      if (!itemCode || !Number.isFinite(quantity) || quantity <= 0) throw bad(`Transfer line ${index + 1} needs an item and positive quantity.`);
      const item = await client.query(
        'SELECT * FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL FOR UPDATE',
        [itemCode]
      );
      if (!item.rowCount) throw notFound(`Inventory item ${itemCode} not found.`);
      const inventory = item.rows[0];
      const unit = text(line.unit, inventory.unit);
      if (unit.toLowerCase() !== text(inventory.unit, 'Nos').toLowerCase()) {
        throw bad(`Transfer unit ${unit} does not match ${inventory.unit} for ${itemCode}.`);
      }
      let batchId = text(line.batchId || line.receiptBatchId);
      const batchNo = text(line.batchNumber || line.batchNo);
      const lotNumber = text(line.lotNumber);
      if (batchId || batchNo) {
        const batch = batchId
          ? await client.query('SELECT * FROM inventory_batches WHERE id=$1 AND item_code=$2 FOR UPDATE', [batchId, itemCode])
          : await client.query(
            'SELECT * FROM inventory_batches WHERE item_code=$1 AND batch_number=$2 AND lot_number=$3 FOR UPDATE',
            [itemCode, batchNo, lotNumber]
          );
        if (!batch.rowCount) throw bad(`Selected batch ${batchNo || batchId} is not registered for ${itemCode}.`);
        if (batch.rowCount > 1) throw bad(`Batch ${batchNo} is ambiguous; select its receipt batch ID.`);
        batchId = batch.rows[0].id;
      } else {
        batchId = '';
      }
      const key = `${itemCode}\0${batchId}`;
      const prior = requested.get(key) || 0;
      requested.set(key, prior + quantity);
      const locationStock = await client.query(
        'SELECT quantity FROM inventory_location_balances WHERE item_code=$1 AND location=$2 FOR UPDATE',
        [itemCode, fromLocation]
      );
      if (!locationStock.rowCount || num(locationStock.rows[0].quantity) < prior + quantity) {
        throw bad(`Insufficient stock at ${fromLocation} for ${itemCode}.`);
      }
      if (batchId) {
        const batchStock = await client.query(
          'SELECT quantity FROM inventory_location_batch_balances WHERE batch_id=$1 AND location=$2 FOR UPDATE',
          [batchId, fromLocation]
        );
        if (!batchStock.rowCount || num(batchStock.rows[0].quantity) < prior + quantity) {
          throw bad(`Insufficient batch stock at ${fromLocation} for ${itemCode}.`);
        }
      }
      normalizedLines.push({
        lineNumber: index + 1,
        itemCode,
        itemName: text(inventory.material_name),
        batchId,
        batchNumber: batchNo,
        lotNumber,
        quantity,
        unit,
        payload: line
      });
    }

    const transferNumber = text(data.transferNumber) || await nextStoreDocumentNumber(
      client, 'ST', 'stockTransferSequence', 'stock_transfers', 'transfer_number'
    );
    const payload = {
      ...data,
      transferNumber,
      transferDate: text(data.transferDate || data.date) || new Date().toISOString().slice(0, 10),
      fromLocation,
      toLocation,
      status: 'Pending'
    };
    const inserted = await client.query(
      `INSERT INTO stock_transfers
       (transfer_number,transfer_date,from_location,to_location,requested_by,requested_by_employee_id,remarks,
        idempotency_key,request_payload,payload,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11) RETURNING *`,
      [transferNumber, payload.transferDate, fromLocation, toLocation,
        text(data.requestedBy, req.user?.displayName || req.user?.email || 'User'),
        text(data.requestedByEmpId || data.requestedByEmployeeId),
        text(data.remarks), idempotencyKey, JSON.stringify(data), JSON.stringify(payload), req.user?.email || '']
    );
    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO stock_transfer_items
         (transfer_number,line_number,item_code,batch_id,quantity,unit,payload)
         VALUES($1,$2,$3,NULLIF($4,''),$5,$6,$7::jsonb)`,
        [transferNumber, line.lineNumber, line.itemCode, line.batchId, line.quantity, line.unit, JSON.stringify(line.payload)]
      );
    }
    await auditDocument(client, req, 'stockTransfers', transferNumber, 'STOCK_TRANSFER_CREATED', null, payload);
    const record = await transferView(client, inserted.rows[0]);
    await client.query('COMMIT');
    res.status(201).json({ record });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/transfer-documents/:transferNumber/approve', requireInventoryAdjustment, async (req, res) => {
  const version = Number(req.body?.version);
  const resolutionKey = text(req.body?.idempotencyKey);
  if (!Number.isInteger(version) || version < 1) throw bad('The current Stock Transfer version is required.');
  if (!resolutionKey) throw bad('An idempotency key is required to approve a Stock Transfer.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM stock_transfers WHERE transfer_number=$1 FOR UPDATE', [req.params.transferNumber]);
    if (!current.rowCount) throw notFound('Stock Transfer not found.');
    const transfer = current.rows[0];
    if (transfer.status === 'Completed' && transfer.resolution_key === resolutionKey) {
      const record = await transferView(client, transfer);
      await client.query('COMMIT');
      return res.json({ record, duplicate: true });
    }
    if (Number(transfer.version) !== version) throw conflict('Stock Transfer changed. Reload before approving.', await transferView(client, transfer));
    if (transfer.status !== 'Pending') throw conflict(`Stock Transfer ${transfer.transfer_number} is ${transfer.status}.`);
    const lines = await client.query(
      'SELECT * FROM stock_transfer_items WHERE transfer_number=$1 ORDER BY line_number FOR UPDATE',
      [transfer.transfer_number]
    );
    for (const line of lines.rows) {
      const inventory = (await client.query('SELECT * FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL FOR UPDATE', [line.item_code])).rows[0];
      if (!inventory) throw notFound(`Inventory item ${line.item_code} no longer exists.`);
      const batch = line.batch_id
        ? (await client.query('SELECT * FROM inventory_batches WHERE id=$1 AND item_code=$2 FOR UPDATE', [line.batch_id, line.item_code])).rows[0]
        : null;
      const batchMeta = line.payload || {};
      await postStockMovement(client, req, {
        ledgerId: `transfer-out-${transfer.transfer_number}-${line.line_number}`,
        itemCode: line.item_code,
        materialName: inventory.material_name,
        movementType: 'TRANSFER_OUT',
        quantity: num(line.quantity),
        unit: line.unit,
        entryDate: dateText(transfer.transfer_date),
        sourceDocType: 'Stock Transfer',
        sourceDocRef: transfer.transfer_number,
        batchNo: batch?.batch_number || text(batchMeta.batchNumber || batchMeta.batchNo),
        batchId: line.batch_id || '',
        lotNumber: batch?.lot_number || text(batchMeta.lotNumber),
        location: transfer.from_location,
        reason: `Transfer from ${transfer.from_location} to ${transfer.to_location}`,
        payload: { transferNumber: transfer.transfer_number, location: transfer.from_location, direction: 'OUT' }
      });
      await postStockMovement(client, req, {
        ledgerId: `transfer-in-${transfer.transfer_number}-${line.line_number}`,
        itemCode: line.item_code,
        materialName: inventory.material_name,
        movementType: 'TRANSFER_IN',
        quantity: num(line.quantity),
        unit: line.unit,
        entryDate: dateText(transfer.transfer_date),
        sourceDocType: 'Stock Transfer',
        sourceDocRef: transfer.transfer_number,
        batchNo: batch?.batch_number || text(batchMeta.batchNumber || batchMeta.batchNo),
        batchId: line.batch_id || '',
        lotNumber: batch?.lot_number || text(batchMeta.lotNumber),
        location: transfer.to_location,
        reason: `Transfer from ${transfer.from_location} to ${transfer.to_location}`,
        payload: { transferNumber: transfer.transfer_number, location: transfer.to_location, direction: 'IN' }
      });
    }
    const saved = await client.query(
      `UPDATE stock_transfers SET status='Completed',version=version+1,resolution_key=$2,
         resolved_by=$3,resolved_at=now(),updated_at=now(),payload=payload||$4::jsonb
       WHERE transfer_number=$1 RETURNING *`,
      [transfer.transfer_number, resolutionKey, req.user?.email || '',
        JSON.stringify({ approvedBy: req.user?.email || '', approvedAt: new Date().toISOString() })]
    );
    await auditDocument(client, req, 'stockTransfers', transfer.transfer_number, 'STOCK_TRANSFER_APPROVED', transfer, saved.rows[0]);
    const record = await transferView(client, saved.rows[0]);
    await client.query('COMMIT');
    res.json({ record });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/transfer-documents/:transferNumber/reject', requireInventoryAdjustment, async (req, res) => {
  const version = Number(req.body?.version);
  const resolutionKey = text(req.body?.idempotencyKey);
  const reason = text(req.body?.reason);
  if (!Number.isInteger(version) || version < 1) throw bad('The current Stock Transfer version is required.');
  if (!resolutionKey) throw bad('An idempotency key is required to reject a Stock Transfer.');
  if (!reason) throw bad('A rejection reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM stock_transfers WHERE transfer_number=$1 FOR UPDATE', [req.params.transferNumber]);
    if (!current.rowCount) throw notFound('Stock Transfer not found.');
    const transfer = current.rows[0];
    if (transfer.status === 'Rejected' && transfer.resolution_key === resolutionKey) {
      const record = await transferView(client, transfer);
      await client.query('COMMIT');
      return res.json({ record, duplicate: true });
    }
    if (Number(transfer.version) !== version) throw conflict('Stock Transfer changed. Reload before rejecting.', await transferView(client, transfer));
    if (transfer.status !== 'Pending') throw conflict(`Stock Transfer ${transfer.transfer_number} is ${transfer.status}.`);
    const saved = await client.query(
      `UPDATE stock_transfers SET status='Rejected',version=version+1,resolution_key=$2,
         resolved_by=$3,resolved_at=now(),resolution_reason=$4,updated_at=now(),
         payload=payload||$5::jsonb WHERE transfer_number=$1 RETURNING *`,
      [transfer.transfer_number, resolutionKey, req.user?.email || '', reason,
        JSON.stringify({ rejectedBy: req.user?.email || '', rejectedAt: new Date().toISOString(), rejectionReason: reason })]
    );
    await auditDocument(client, req, 'stockTransfers', transfer.transfer_number, 'STOCK_TRANSFER_REJECTED', transfer, saved.rows[0], reason);
    const record = await transferView(client, saved.rows[0]);
    await client.query('COMMIT');
    res.json({ record });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/verifications', allowRead, async (req, res) => {
  const status = text(req.query.status);
  const result = await getPool().query(
    `SELECT * FROM stock_verifications ${status ? 'WHERE status=$1' : ''}
      ORDER BY verification_date DESC,created_at DESC`,
    status ? [status] : []
  );
  const client = await getPool().connect();
  try {
    const records = [];
    for (const row of result.rows) records.push(await verificationView(client, row));
    res.json({ records });
  } finally { client.release(); }
});

router.get('/verifications/:verificationNumber', allowRead, async (req, res) => {
  const result = await getPool().query('SELECT * FROM stock_verifications WHERE verification_number=$1', [req.params.verificationNumber]);
  if (!result.rowCount) throw notFound('Stock Verification not found.');
  const client = await getPool().connect();
  try { res.json({ record: await verificationView(client, result.rows[0]) }); } finally { client.release(); }
});

router.post('/verifications', allowWrite, async (req, res) => {
  const data = req.body?.data || req.body || {};
  const location = text(data.location);
  const idempotencyKey = text(req.body?.idempotencyKey || data.idempotencyKey);
  const lines = Array.isArray(data.items) ? data.items : [];
  if (!idempotencyKey) throw bad('An idempotency key is required to create a Stock Verification.');
  if (!location) throw bad('A stock location is required.');
  if (!lines.length) throw bad('At least one verification line is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stock-verification-create:' || $1))", [idempotencyKey]);
    const duplicate = await client.query('SELECT * FROM stock_verifications WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey]);
    if (duplicate.rowCount) {
      const samePayload = await client.query(
        'SELECT request_payload=$2::jsonb AS same FROM stock_verifications WHERE verification_number=$1',
        [duplicate.rows[0].verification_number, JSON.stringify(data)]
      );
      if (!samePayload.rows[0]?.same) throw conflict('This Stock Verification idempotency key was already used for different data.');
      const record = await verificationView(client, duplicate.rows[0]);
      await client.query('COMMIT');
      return res.status(200).json({ record, duplicate: true });
    }

    const seenItems = new Set();
    const seenModes = new Map();
    const normalizedLines = [];
    for (const [index, line] of lines.entries()) {
      const itemCode = text(line.itemCode || line.materialId);
      const physical = Number(line.physicalQty ?? line.physicalQuantity);
      if (!itemCode || !Number.isFinite(physical) || physical < 0) throw bad(`Verification line ${index + 1} needs an item and non-negative physical quantity.`);
      const itemResult = await client.query(
        'SELECT * FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL FOR UPDATE',
        [itemCode]
      );
      if (!itemResult.rowCount) throw notFound(`Inventory item ${itemCode} not found.`);
      const item = itemResult.rows[0];
      const unit = text(line.unit, item.unit);
      if (unit.toLowerCase() !== text(item.unit, 'Nos').toLowerCase()) throw bad(`Verification unit ${unit} does not match ${item.unit} for ${itemCode}.`);
      let batchId = text(line.batchId || line.receiptBatchId);
      const batchNo = text(line.batchNumber || line.batchNo);
      const lotNumber = text(line.lotNumber);
      if (batchId || batchNo) {
        const batch = batchId
          ? await client.query('SELECT * FROM inventory_batches WHERE id=$1 AND item_code=$2 FOR UPDATE', [batchId, itemCode])
          : await client.query(
            'SELECT * FROM inventory_batches WHERE item_code=$1 AND batch_number=$2 AND lot_number=$3 FOR UPDATE',
            [itemCode, batchNo, lotNumber]
          );
        if (!batch.rowCount) throw bad(`Selected batch ${batchNo || batchId} is not registered for ${itemCode}.`);
        if (batch.rowCount > 1) throw bad(`Batch ${batchNo} is ambiguous; select its receipt batch ID.`);
        batchId = batch.rows[0].id;
      } else {
        batchId = '';
      }
      const mode = batchId ? 'batch' : 'item';
      const existingMode = seenModes.get(itemCode);
      if ((existingMode && existingMode !== mode) || seenItems.has(`${itemCode}\0${batchId}`)) {
        throw bad(`Verification contains duplicate or overlapping lines for ${itemCode}.`);
      }
      seenModes.set(itemCode, mode);
      seenItems.add(`${itemCode}\0${batchId}`);

      const stock = batchId
        ? await client.query('SELECT quantity FROM inventory_location_batch_balances WHERE batch_id=$1 AND location=$2 FOR UPDATE', [batchId, location])
        : await client.query('SELECT quantity FROM inventory_location_balances WHERE item_code=$1 AND location=$2 FOR UPDATE', [itemCode, location]);
      if (!stock.rowCount) throw bad(`No recorded stock balance exists for ${itemCode} at ${location}.`);
      normalizedLines.push({
        lineNumber: index + 1,
        itemCode,
        itemName: text(item.material_name),
        batchId,
        batchNumber: batchNo,
        lotNumber,
        systemQuantity: num(stock.rows[0].quantity),
        physicalQuantity: physical,
        variance: physical - num(stock.rows[0].quantity),
        unit,
        remarks: text(line.remarks),
        payload: line
      });
    }

    const verificationNumber = text(data.verificationNumber) || await nextStoreDocumentNumber(
      client, 'SV', 'stockVerificationSequence', 'stock_verifications', 'verification_number'
    );
    const payload = { ...data, verificationNumber, location, status: 'Pending Approval' };
    const inserted = await client.query(
      `INSERT INTO stock_verifications
       (verification_number,verification_date,location,verified_by,verified_by_employee_id,remarks,
        idempotency_key,request_payload,payload,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,
      [verificationNumber, text(data.date || data.verificationDate) || new Date().toISOString().slice(0, 10),
        location, req.user?.displayName || req.user?.email || 'User', req.user?.employeeId || '',
        text(data.remarks || data.reason), idempotencyKey, JSON.stringify(data), JSON.stringify(payload), req.user?.email || '']
    );
    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO stock_verification_items
         (verification_number,line_number,item_code,batch_id,system_quantity,physical_quantity,variance,unit,remarks,payload)
         VALUES($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10::jsonb)`,
        [verificationNumber, line.lineNumber, line.itemCode, line.batchId,
          line.systemQuantity, line.physicalQuantity, line.variance, line.unit, line.remarks, JSON.stringify(line.payload)]
      );
    }
    await auditDocument(client, req, 'stockVerifications', verificationNumber, 'STOCK_VERIFICATION_CREATED', null, payload);
    const record = await verificationView(client, inserted.rows[0]);
    await client.query('COMMIT');
    res.status(201).json({ record });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const resolveVerification = (approve) => async (req, res) => {
  const version = Number(req.body?.version);
  const resolutionKey = text(req.body?.idempotencyKey);
  const reason = text(req.body?.reason);
  if (!Number.isInteger(version) || version < 1) throw bad('The current Stock Verification version is required.');
  if (!resolutionKey) throw bad('An idempotency key is required to resolve a Stock Verification.');
  if (!approve && !reason) throw bad('A rejection reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM stock_verifications WHERE verification_number=$1 FOR UPDATE', [req.params.verificationNumber]);
    if (!current.rowCount) throw notFound('Stock Verification not found.');
    const verification = current.rows[0];
    const targetStatus = approve ? 'Approved' : 'Rejected';
    if (verification.status === targetStatus && verification.resolution_key === resolutionKey) {
      const record = await verificationView(client, verification);
      await client.query('COMMIT');
      return res.json({ record, duplicate: true });
    }
    if (Number(verification.version) !== version) throw conflict('Stock Verification changed. Reload before resolving.', await verificationView(client, verification));
    if (verification.status !== 'Pending Approval') throw conflict(`Stock Verification ${verification.verification_number} is ${verification.status}.`);
    const lines = await client.query(
      `SELECT l.*,i.material_name,i.unit AS inventory_unit,b.batch_number,b.lot_number
         FROM stock_verification_items l
         JOIN inventory_items i ON i.item_code=l.item_code
         LEFT JOIN inventory_batches b ON b.id=l.batch_id
        WHERE l.verification_number=$1 ORDER BY l.line_number FOR UPDATE OF l`,
      [verification.verification_number]
    );
    if (approve) {
      for (const line of lines.rows) {
        const currentStock = line.batch_id
          ? await client.query('SELECT quantity FROM inventory_location_batch_balances WHERE batch_id=$1 AND location=$2 FOR UPDATE', [line.batch_id, verification.location])
          : await client.query('SELECT quantity FROM inventory_location_balances WHERE item_code=$1 AND location=$2 FOR UPDATE', [line.item_code, verification.location]);
        if (!currentStock.rowCount || Math.abs(num(currentStock.rows[0].quantity) - num(line.system_quantity)) > 1e-9) {
          throw conflict(`Stock for ${line.item_code} at ${verification.location} changed after verification. Recount before approval.`);
        }
        const variance = num(line.physical_quantity) - num(line.system_quantity);
        if (Math.abs(variance) < 1e-9) continue;
        const batch = line.batch_id
          ? (await client.query('SELECT * FROM inventory_batches WHERE id=$1 FOR UPDATE', [line.batch_id])).rows[0]
          : null;
        const ledgerId = `verification-${verification.verification_number}-${line.line_number}`;
        await postStockMovement(client, req, {
          ledgerId,
          itemCode: line.item_code,
          materialName: line.material_name,
          movementType: variance > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
          quantity: Math.abs(variance),
          unit: line.unit,
          entryDate: dateText(verification.verification_date),
          sourceDocType: 'Stock Verification',
          sourceDocRef: verification.verification_number,
          batchId: line.batch_id || '',
          batchNo: batch?.batch_number || '',
          lotNumber: batch?.lot_number || '',
          location: verification.location,
          reason: `Physical verification adjustment: ${text(line.remarks || verification.remarks)}`,
          payload: { verificationNumber: verification.verification_number, location: verification.location, variance }
        });
        await client.query(
          'UPDATE stock_verification_items SET adjustment_ledger_id=$3,variance=$4 WHERE verification_number=$1 AND line_number=$2',
          [verification.verification_number, line.line_number, ledgerId, variance]
        );
      }
    }
    const saved = await client.query(
      `UPDATE stock_verifications SET status=$2,version=version+1,resolution_key=$3,resolved_by=$4,
         resolved_at=now(),resolution_reason=$5,updated_at=now(),
         payload=payload||$6::jsonb WHERE verification_number=$1 RETURNING *`,
      [verification.verification_number, targetStatus, resolutionKey, req.user?.email || '', reason,
        JSON.stringify(approve
          ? { approvedBy: req.user?.email || '', approvedAt: new Date().toISOString() }
          : { rejectedBy: req.user?.email || '', rejectedAt: new Date().toISOString(), rejectionReason: reason })]
    );
    await auditDocument(client, req, 'stockVerifications', verification.verification_number,
      approve ? 'STOCK_VERIFICATION_APPROVED' : 'STOCK_VERIFICATION_REJECTED',
      verification, saved.rows[0], reason);
    const record = await verificationView(client, saved.rows[0]);
    await client.query('COMMIT');
    res.json({ record });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};
router.post('/verifications/:verificationNumber/approve', requireInventoryAdjustment, resolveVerification(true));
router.post('/verifications/:verificationNumber/reject', requireInventoryAdjustment, resolveVerification(false));

router.get('/ledger', allowRead, async (req, res) => {
  const clauses = [];
  const values = [];
  const add = (column, value) => { if (text(value)) { values.push(value); clauses.push(`${column}=$${values.length}`); } };
  add('item_code', req.query.itemCode);
  add('movement_type', req.query.movementType);
  add('source_doc_ref', req.query.sourceDocRef);
  add('batch_no', req.query.batchNo);
  if (text(req.query.from)) { values.push(req.query.from); clauses.push(`entry_date>=$${values.length}`); }
  if (text(req.query.to)) { values.push(req.query.to); clauses.push(`entry_date<=$${values.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = Number((await getPool().query(`SELECT count(*)::int AS total FROM stock_ledger_entries ${where}`, values)).rows[0].total);
  const limit = Math.min(2000, Math.max(1, Number.parseInt(req.query.limit, 10) || 2000));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const pageValues = [...values, limit, offset];
  const sql = `SELECT * FROM stock_ledger_entries ${where} ORDER BY entry_time DESC,id DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`;
  res.json({ records: (await getPool().query(sql, pageValues)).rows, total, limit, offset });
});

router.get('/valuation', async (_req, res) => {
  const result = await getPool().query(
    `SELECT item_code,material_name,category,unit,current_qty,unit_price,
        (current_qty*unit_price) AS valuation
       FROM inventory_items WHERE deleted_at IS NULL ORDER BY material_name,item_code`
  );
  res.json({ records: result.rows, total: result.rows.reduce((sum, row) => sum + num(row.valuation), 0) });
});

router.get('/lots', async (req, res) => {
  const clauses = ['1=1'];
  const values = [];
  if (text(req.query.itemCode)) { values.push(req.query.itemCode); clauses.push(`item_code=$${values.length}`); }
  if (text(req.query.batchNo)) { values.push(req.query.batchNo); clauses.push(`batch_number=$${values.length}`); }
  const result = await getPool().query(
    `SELECT * FROM inventory_batches WHERE ${clauses.join(' AND ')} ORDER BY expiry_date NULLS LAST,batch_number`,
    values
  );
  res.json({ records: result.rows });
});

router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const [current, legacy] = await Promise.all([
    getPool().query('SELECT item_code FROM inventory_items'),
    getPool().query("SELECT record_id,data,version FROM module_records WHERE storage_key='inventoryItems'")
  ]);
  const active = new Set(current.rows.map((row) => row.item_code));
  const eligible = [];
  const identical = [];
  const conflicting = [];
  for (const row of legacy.rows) {
    const code = text(row.data?.itemCode || row.record_id);
    const payload = { ...(row.data || {}), itemCode: code };
    if (!active.has(code)) eligible.push(payload);
    else identical.push(payload);
  }
  res.json({ eligible, identical, conflicting, invalid: [], totalLegacy: legacy.rows.length });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length) throw bad('Select at least one inventory record to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const imported = [];
    for (const data of records) {
      const code = text(data.itemCode || data.id);
      if (!code) continue;
      const exists = await client.query('SELECT 1 FROM inventory_items WHERE item_code=$1 FOR UPDATE', [code]);
      if (exists.rowCount) continue;
      await client.query(
        `INSERT INTO inventory_items (item_code,material_name,category,unit,current_qty,reorder_level,min_order_qty,
          unit_price,shelf_life_managed,shelf_life_days,location,hsn_code,version,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13::jsonb)`,
        [code, text(data.materialName || data.itemName || code), text(data.category, 'Raw Material'),
          text(data.unit, 'Nos'), num(data.currentQty), num(data.reorderLevel ?? data.minReorderLevel),
          num(data.minOrderQty), num(data.unitPrice), Boolean(data.shelfLifeManaged), Number(data.shelfLifeDays) || 0,
          text(data.location), text(data.hsnCode), JSON.stringify({ ...data, importedBy: req.user?.email || 'Migration' })]
      );
      await client.query(
        `INSERT INTO inventory_location_balances(item_code,location,quantity)
         VALUES($1,$2,$3) ON CONFLICT(item_code,location) DO NOTHING`,
        [code, text(data.location) || 'Unassigned', num(data.currentQty)]
      );
      imported.push(code);
    }
    await client.query('COMMIT');
    res.json({ imported, count: imported.length });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

export default router;
