// HT outsource stock movement helper. Mirrors the established Delivery Challan
// behaviour: untracked parts do not change stock, tracked parts update the
// normalized inventory, the central ledger and the legacy transaction list in
// one database transaction. postStockMovement() owns the authoritative
// quantity update; this helper only adds the legacy projection.

import { postStockMovement } from './stockLedger.js';

const text = (value, fallback = '') => String(value ?? fallback).trim() || fallback;

export const moveHtStock = async (client, req, spec) => {
  const quantity = Number(spec?.quantity) || 0;
  if (quantity <= 0) return { moved: false };
  const type = String(spec.type || 'OUT').toUpperCase() === 'IN' ? 'IN' : 'OUT';
  const reference = text(spec.reference);
  if (!reference) return { moved: false };

  // Legacy behaviour: a part that is not in the Item Master never moves stock.
  const inventory = await client.query(
    `SELECT record_id, data, version FROM module_records
      WHERE storage_key='inventoryItems'
        AND (data->>'itemCode'=$1 OR lower(data->>'itemName')=lower($2))
      ORDER BY record_id LIMIT 1 FOR UPDATE`,
    [text(spec.itemCode), text(spec.itemName)]
  );
  if (!inventory.rowCount) return { moved: false, reason: 'Part is not tracked in inventory.' };

  const legacy = inventory.rows[0];
  const stockId = `htr-${type.toLowerCase()}-${reference}`;
  const exists = await client.query(
    "SELECT 1 FROM module_records WHERE storage_key='stockTransactions' AND record_id=$1", [stockId]
  );
  if (exists.rowCount) return { moved: false, duplicate: true };

  const itemCode = text(spec.itemCode, text(legacy.data?.itemCode));
  const itemName = text(spec.itemName, text(legacy.data?.itemName));

  // Older databases may only have the legacy Item Master row. Seed the
  // normalized row from it so the ledger posts against the real balance
  // instead of creating an empty stock item.
  const normalized = await client.query(
    'SELECT item_code,current_qty FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL', [itemCode]
  );
  if (!normalized.rowCount) {
    const byName = itemName
      ? await client.query('SELECT item_code,current_qty FROM inventory_items WHERE lower(material_name)=lower($1) AND deleted_at IS NULL ORDER BY item_code LIMIT 1', [itemName])
      : { rowCount: 0 };
    if (!byName.rowCount) {
      await client.query(
        `INSERT INTO inventory_items(item_code,material_name,category,unit,current_qty,unit_price,payload)
         VALUES($1,$2,'Raw Material',$3,$4,$5,$6::jsonb)
         ON CONFLICT (item_code) DO NOTHING`,
        [itemCode || `HT-${reference}`, itemName || itemCode || reference,
          text(legacy.data?.unit, 'Nos'), Number(legacy.data?.currentQty) || 0,
          Number(legacy.data?.unitPrice || legacy.data?.rate || 0),
          JSON.stringify({ seededFromLegacyHt: reference })]
      );
    }
  }

  const movement = await postStockMovement(client, req, {
    ledgerId: stockId,
    itemCode,
    materialName: itemName,
    movementType: type,
    quantity,
    unit: text(legacy.data?.unit, 'Nos'),
    unitCost: Number(legacy.data?.unitPrice || legacy.data?.rate || 0),
    entryDate: text(spec.date, new Date().toISOString().slice(0, 10)),
    sourceDocType: 'HT Outsource Request',
    sourceDocRef: reference,
    reason: type === 'OUT' ? `Out for Heat Treatment → ${text(spec.vendorName)}` : `Heat Treatment return from ${text(spec.vendorName)}`,
    payload: {
      htrNumber: reference,
      jobCardNumber: text(spec.jobCardNumber),
      projectId: text(spec.projectId),
      vendorName: text(spec.vendorName)
    }
  });
  if (movement.duplicate) return { moved: false, duplicate: true };

  const transaction = {
    id: stockId,
    date: text(spec.date, new Date().toISOString().slice(0, 10)),
    dateTime: new Date().toISOString(),
    itemCode,
    itemName,
    unit: text(legacy.data?.unit, 'Nos'),
    type,
    quantity,
    balanceAfter: Number(movement.balanceAfter),
    reason: type === 'OUT' ? `Out for Heat Treatment → ${text(spec.vendorName)}` : `Heat Treatment return from ${text(spec.vendorName)}`,
    reference,
    transactionNumber: reference,
    jobCardNumber: text(spec.jobCardNumber),
    projectId: text(spec.projectId),
    issuedTo: type === 'OUT' ? text(spec.vendorName) : '',
    issuedBy: String(req.user?.email || '')
  };
  await client.query(
    'INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES($1,$2,$3::jsonb,1,now(),$4) ON CONFLICT(storage_key,record_id) DO NOTHING',
    ['stockTransactions', stockId, JSON.stringify(transaction), String(req.user?.email || '')]
  );
  return { moved: true, ledgerId: movement.ledgerId, balanceAfter: Number(movement.balanceAfter) };
};
