import { createHash } from 'node:crypto';
import { safeAuditValues } from './auth.js';

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value, fallback = '') => String(value ?? fallback).trim();
const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);

/** Finds the PostgreSQL inventory master row without ever consulting the
 *  browser. Legacy module_records rows are only used to seed a missing
 *  normalized row during an explicit server-side operation. */
const findInventory = async (client, itemCode, materialName) => {
  const code = text(itemCode);
  if (code) {
    const exact = await client.query(
      'SELECT * FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL FOR UPDATE',
      [code]
    );
    return exact.rows[0] || null;
  }
  if (!text(materialName)) return null;
  const byName = await client.query(
    'SELECT * FROM inventory_items WHERE lower(material_name)=lower($1) AND deleted_at IS NULL ORDER BY item_code LIMIT 1 FOR UPDATE',
    [text(materialName)]
  );
  return byName.rows[0] || null;
};

const findLegacyInventory = async (client, itemCode, materialName) => {
  const code = text(itemCode);
  if (code) {
    const exact = await client.query(
      `SELECT record_id, data, version FROM module_records
        WHERE storage_key='inventoryItems' AND data->>'itemCode'=$1 ORDER BY record_id LIMIT 1 FOR UPDATE`,
      [code]
    );
    return exact.rows[0] || null;
  }
  if (!text(materialName)) return null;
  const byName = await client.query(
    `SELECT record_id, data, version FROM module_records
      WHERE storage_key='inventoryItems' AND lower(data->>'itemName')=lower($1)
      ORDER BY record_id LIMIT 1 FOR UPDATE`,
    [text(materialName)]
  );
  return byName.rows[0] || null;
};

const upsertLegacyInventory = async (client, legacy, data, actor) => {
  if (!legacy) return;
  await client.query(
    `UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4
      WHERE storage_key='inventoryItems' AND record_id=$1 AND version=$2`,
    [legacy.record_id, legacy.version, JSON.stringify(data), actor]
  );
};

const applyBatchMovement = async (client, spec, item, movementType, quantity, actor) => {
  const batchNo = text(spec.batchNo);
  const lotNumber = text(spec.lotNumber);
  const batchId = text(spec.batchId || spec.batchMetadata?.internalBatchId);
  const isExpiryWriteOff = movementType === 'ADJUSTMENT_OUT' && /(expiry|expired) (?:stock )?write-off/i.test(text(spec.reason));
  if (!batchNo && !batchId) {
    if (isExpiryWriteOff) throw bad('Expiry write-off requires a registered batch.');
    return null;
  }
  const batch = batchId
    ? await client.query(
      `SELECT * FROM inventory_batches
        WHERE id=$1 OR (item_code=$2 AND batch_number=$3 AND lot_number=$4)
        ORDER BY CASE WHEN id=$1 THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE`,
      [batchId, item.item_code, batchNo, lotNumber]
    )
    : await client.query(
      'SELECT * FROM inventory_batches WHERE item_code=$1 AND batch_number=$2 AND lot_number=$3 FOR UPDATE',
      [item.item_code, batchNo, lotNumber]
    );
  if (!batch.rowCount) {
    if (movementType === 'OUT') {
      throw bad(`Batch ${batchNo} is not registered for ${item.material_name || item.item_code}.`);
    }
    if (['OUT', 'ISSUE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'RETURN_OUT'].includes(movementType)) {
      throw bad(`Batch ${batchNo || batchId} is not registered for ${item.material_name || item.item_code}.`);
    }
    const metadata = spec.batchMetadata && typeof spec.batchMetadata === 'object' ? spec.batchMetadata : {};
    const id = batchId || `batch-${createHash('sha256').update(`${item.item_code}\0${batchNo}\0${lotNumber}`).digest('hex').slice(0, 32)}`;
    const availableQty = quantity;
    const initialQty = spec.batchInitialQty == null && ['IN', 'OPENING'].includes(movementType)
      ? quantity
      : num(spec.batchInitialQty);
    const inserted = await client.query(
      `INSERT INTO inventory_batches
        (id,item_code,batch_number,lot_number,available_qty,initial_qty,unit,mfg_date,expiry_date,status,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::date,NULLIF($9,'')::date,$10,$11::jsonb)
       ON CONFLICT(id) DO UPDATE SET
         available_qty=inventory_batches.available_qty+EXCLUDED.available_qty,
         initial_qty=inventory_batches.initial_qty+EXCLUDED.initial_qty,
         payload=inventory_batches.payload||EXCLUDED.payload,
         status='Active',updated_at=now()
       WHERE inventory_batches.item_code=EXCLUDED.item_code
         AND inventory_batches.batch_number=EXCLUDED.batch_number
         AND inventory_batches.lot_number=EXCLUDED.lot_number
       RETURNING id,batch_number,available_qty`,
      [id, item.item_code, batchNo, lotNumber, availableQty, initialQty, text(spec.unit, item.unit),
        text(metadata.mfgDate), text(metadata.expiryDate),
        availableQty > 0 ? 'Active' : 'Depleted',
        JSON.stringify(safeAuditValues({ ...metadata, internalBatchId: id }))]
    );
    if (!inserted.rowCount) throw conflict(`Batch ${batchNo || id} already belongs to a different item or lot.`);
    return { ...inserted.rows[0], batchNumber: inserted.rows[0].batch_number, balanceAfter: num(inserted.rows[0].available_qty) };
  }
  const row = batch.rows[0];
  if (row.item_code !== item.item_code) throw conflict(`Batch ${batchId || batchNo} belongs to a different inventory item.`);
  const available = num(row.available_qty);
  const isOutbound = ['OUT', 'ISSUE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'RETURN_OUT'].includes(movementType);
  if (isOutbound && available < quantity) {
    throw bad(`Batch ${batchNo} has only ${available} available for ${item.material_name || item.item_code}.`);
  }
  const expiryDate = dateText(row.expiry_date);
  const expired = expiryDate && expiryDate < new Date().toISOString().slice(0, 10);
  if (isExpiryWriteOff && !expired) {
    throw bad(`Batch ${batchNo || batchId} is not expired and cannot be written off as expired stock.`);
  }
  if (isOutbound && expired && !isExpiryWriteOff) {
    throw conflict(`Batch ${batchNo} expired on ${expiryDate} and cannot be issued.`);
  }
  const nextQty = isOutbound ? Math.max(0, available - quantity) : available + quantity;
  const initialQty = num(row.initial_qty) + (
    spec.batchInitialQty == null && ['IN', 'OPENING'].includes(movementType)
      ? quantity
      : num(spec.batchInitialQty)
  );
  const metadata = spec.batchMetadata && typeof spec.batchMetadata === 'object' ? spec.batchMetadata : {};
  await client.query(
    `UPDATE inventory_batches SET available_qty=$1,initial_qty=$2,
       payload=payload||$3::jsonb,status=$4,updated_at=now()
      WHERE id=$5`,
    [nextQty, initialQty, JSON.stringify(safeAuditValues(metadata)), nextQty > 0 ? 'Active' : 'Depleted', row.id]
  );
  return { id: row.id, batchNumber: row.batch_number, balanceAfter: nextQty };
};

/**
 * Posts one stock movement atomically on an existing transaction.
 *
 * Every permanent movement uses this helper so inventory quantity, the central
 * stock ledger, lot/batch balances, and the audit trail commit or roll back
 * together. Caller must have opened and will close the transaction.
 *
 * @returns {{duplicate:boolean, ledgerId:string, itemCode:string, balanceAfter:number, batch:object|null}}
 */
export const postStockMovement = async (client, req, spec) => {
  const ledgerId = text(spec.ledgerId);
  if (!ledgerId) throw bad('A deterministic stock ledger reference is required.');
  const quantity = num(spec.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw bad('Stock movement quantity must be positive.');

  const existing = await client.query('SELECT * FROM stock_ledger_entries WHERE id=$1 FOR UPDATE', [ledgerId]);
  if (existing.rowCount) {
    const row = existing.rows[0];
    const same = Number(row.quantity) === quantity &&
      text(row.source_doc_ref) === text(spec.sourceDocRef) &&
      text(row.movement_type) === text(spec.movementType);
    if (!same) throw conflict(`Stock ledger entry ${ledgerId} already exists for a different movement.`, row);
    return { duplicate: true, ledgerId, itemCode: row.item_code, balanceAfter: Number(row.balance_after), batch: null };
  }

  let item = await findInventory(client, spec.itemCode, spec.materialName);
  const legacy = await findLegacyInventory(client, spec.itemCode, spec.materialName);
  if (!item) {
    const code = text(spec.itemCode) || text(legacy?.data?.itemCode) ||
      `MAT-${text(spec.materialName).slice(0, 12).toUpperCase().replace(/[^A-Z0-9]+/g, '-') || 'UNKNOWN'}`;
    const inserted = await client.query(
      `INSERT INTO inventory_items (item_code,material_name,category,unit,current_qty,unit_price,payload)
       VALUES ($1,$2,$3,$4,0,$5,$6::jsonb) ON CONFLICT (item_code) DO UPDATE SET updated_at=now() RETURNING *`,
      [code, text(spec.materialName) || code, text(spec.category, 'Raw Material'), text(spec.unit, 'Nos'),
        num(spec.unitCost), JSON.stringify({ createdFromStockMovement: ledgerId, createdBy: req.user?.email || 'System' })]
    );
    item = inserted.rows[0];
  }

  const before = num(item.current_qty);
  const isOutbound = ['OUT', 'ISSUE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT', 'RETURN_OUT'].includes(spec.movementType);
  if (isOutbound && before + 1e-9 < quantity) {
    throw bad(`Insufficient stock for ${item.material_name || item.item_code}: available ${before}, requested ${quantity}.`);
  }
  const defaultLocation = text(item.location) || 'Unassigned';
  const location = text(spec.location) || defaultLocation;
  await client.query(
    `INSERT INTO inventory_location_balances (item_code,location,quantity)
     VALUES($1,$2,$3) ON CONFLICT(item_code,location) DO NOTHING`,
    [item.item_code, location, location === defaultLocation ? before : 0]
  );
  const locationBalance = await client.query(
    'SELECT quantity FROM inventory_location_balances WHERE item_code=$1 AND location=$2 FOR UPDATE',
    [item.item_code, location]
  );
  const locationBefore = num(locationBalance.rows[0]?.quantity);
  if (isOutbound && locationBefore + 1e-9 < quantity) {
    throw bad(`Insufficient stock at ${location} for ${item.material_name || item.item_code}: available ${locationBefore}, requested ${quantity}.`);
  }
  const after = isOutbound ? Math.max(0, before - quantity) : before + quantity;

  await client.query(
    `UPDATE inventory_items SET current_qty=$1,version=version+1,updated_at=now(),
      payload=payload||jsonb_build_object('updatedBy',$2::text) WHERE item_code=$3`,
    [after, req.user?.email || 'System', item.item_code]
  );
  await client.query(
    `UPDATE inventory_location_balances
        SET quantity=$3,version=version+1,updated_at=now()
      WHERE item_code=$1 AND location=$2`,
    [item.item_code, location, isOutbound ? Math.max(0, locationBefore - quantity) : locationBefore + quantity]
  );
  if (legacy) {
    const legacyData = { ...(legacy.data || {}), currentQty: after, itemCode: legacy.data?.itemCode || item.item_code };
    await upsertLegacyInventory(client, legacy, legacyData, req.user?.email || 'System');
  }

  const batch = await applyBatchMovement(client, spec, item, spec.movementType, quantity, req.user?.email || 'System');
  if (batch?.id) {
    const batchLocationInitial = location === defaultLocation
      ? Math.max(0, num(batch.balanceAfter) + (isOutbound ? quantity : -quantity))
      : 0;
    await client.query(
      `INSERT INTO inventory_location_batch_balances(batch_id,item_code,location,quantity)
       VALUES($1,$2,$3,$4) ON CONFLICT(batch_id,location) DO NOTHING`,
      [batch.id, item.item_code, location, batchLocationInitial]
    );
    const batchLocation = await client.query(
      'SELECT quantity FROM inventory_location_batch_balances WHERE batch_id=$1 AND location=$2 FOR UPDATE',
      [batch.id, location]
    );
    const batchLocationBefore = num(batchLocation.rows[0]?.quantity);
    if (isOutbound && batchLocationBefore + 1e-9 < quantity) {
      throw bad(`Insufficient batch stock at ${location} for ${item.material_name || item.item_code}: available ${batchLocationBefore}, requested ${quantity}.`);
    }
    await client.query(
      `UPDATE inventory_location_batch_balances
          SET quantity=$3,version=version+1,updated_at=now()
        WHERE batch_id=$1 AND location=$2`,
      [batch.id, location, isOutbound ? Math.max(0, batchLocationBefore - quantity) : batchLocationBefore + quantity]
    );
  }

  const actor = req.user?.email || 'System';
  const entryDate = text(spec.entryDate) || new Date().toISOString().slice(0, 10);
  await client.query(
    `INSERT INTO stock_ledger_entries (
       id,entry_date,entry_time,item_code,movement_type,quantity,balance_after,unit,unit_cost,
       source_doc_type,source_doc_ref,batch_no,lot_number,created_by,reason,payload
     ) VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [ledgerId, entryDate, item.item_code, spec.movementType, quantity, after, text(spec.unit) || item.unit,
      num(spec.unitCost), text(spec.sourceDocType), text(spec.sourceDocRef), text(spec.batchNo),
      text(spec.lotNumber), actor, text(spec.reason),       JSON.stringify(safeAuditValues({ ...(spec.payload || spec), location }))]
  );
  await client.query(
    `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES($1,$2,$3,'inventoryItems',$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [req.user?.id || null, actor, req.user?.role || req.user?.roleKey || '', item.item_code,
      item.material_name || item.item_code, `STOCK_${spec.movementType}`, text(spec.reason),
      JSON.stringify(safeAuditValues({ currentQty: before, location, locationQty: locationBefore })),
      JSON.stringify(safeAuditValues({ currentQty: after, location, locationQty: isOutbound ? Math.max(0, locationBefore - quantity) : locationBefore + quantity }))]
  );

  return { duplicate: false, ledgerId, itemCode: item.item_code, balanceAfter: after, batch };
};

/** Reads the authoritative stock ledger for a source document. */
export const listStockLedger = async (client, sourceDocRef) => {
  const result = await client.query(
    'SELECT * FROM stock_ledger_entries WHERE source_doc_ref=$1 ORDER BY entry_time, id',
    [text(sourceDocRef)]
  );
  return result.rows;
};

export default { postStockMovement, listStockLedger };
