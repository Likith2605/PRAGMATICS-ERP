import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { postStockMovement } from './stockLedger.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const validate = (payload) => {
  const number = String(payload?.dcDetails?.dcNumber || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(number)) throw bad('A valid Delivery Challan number is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload?.dcDetails?.dcDate || ''))) throw bad('Delivery Challan date must use YYYY-MM-DD format.');
  if (!String(payload?.customerDetails?.customerName || payload?.customerDetails?.companyName || '').trim()) throw bad('Customer name is required.');
  if (!Array.isArray(payload?.items) || !payload.items.length) throw bad('At least one Delivery Challan item is required.');
  if (Buffer.byteLength(JSON.stringify(payload)) > 5 * 1024 * 1024) throw Object.assign(new Error('Delivery Challan exceeds the record size limit.'), { status: 413 });
  return number;
};
const view = (row) => ({ date: String(row.dc_date).slice(0, 10), reference: row.dc_number, salesOrderRef: row.sales_order_ref || '-', company: row.customer_name, vehicle: row.payload.dcDetails?.vehicleNumber ? `${row.payload.dcDetails.vehicleNumber} (${row.payload.dcDetails.transporterName || 'Self'})` : row.payload.dcDetails?.transporterName || '-', totalQty: `${(row.payload.items || []).reduce((n, item) => n + (Number(item.quantity) || 0), 0)} Units`, total: row.payload.totals?.grandTotal ?? 0, currency: row.payload.currency || 'INR', status: row.status, version: Number(row.version), payload: row.payload });
const audit = (client, req, number, action, before, after, reason = '') => client.query(
  `INSERT INTO delivery_challan_audit(dc_number,user_id,email,role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [number, req.user.id, req.user.email, req.user.role, action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const insertItems = async (client, number, items) => {
  for (const [i, item] of items.entries()) await client.query(
    'INSERT INTO delivery_challan_items(dc_number,line_number,item_name,quantity,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
    [number, i + 1, String(item?.itemName || ''), Number(item?.quantity) || 0, JSON.stringify(item)]
  );
};
const stockMove = async (client, req, payload, number) => {
  for (const [index, item] of (payload.items || []).entries()) {
    const quantity = Number(item?.quantity) || 0;
    if (quantity <= 0) continue;
    const inventory = await client.query(
      `SELECT record_id,data,version FROM module_records WHERE storage_key='inventoryItems'
       AND (data->>'itemCode'=$1 OR lower(data->>'itemName')=lower($2)) ORDER BY record_id LIMIT 1 FOR UPDATE`,
      [String(item.itemCode || ''), String(item.itemName || '')]
    );
    // Preserve the established rule: untracked items do not change stock.
    if (!inventory.rowCount) continue;
    const stockId = `delivery-${number}-${index + 1}`;
    const exists = await client.query("SELECT 1 FROM module_records WHERE storage_key='stockTransactions' AND record_id=$1", [stockId]);
    if (exists.rowCount) continue;
    const data = inventory.rows[0].data || {};
    const balanceAfter = Math.max(0, (Number(data.currentQty) || 0) - quantity);
    const updatedInventory = { ...data, currentQty: balanceAfter };
    await client.query("UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key='inventoryItems' AND record_id=$1 AND version=$2", [inventory.rows[0].record_id, inventory.rows[0].version, JSON.stringify(updatedInventory), req.user.email]);
    const transaction = { id: stockId, date: payload.dcDetails.dispatchDate || payload.dcDetails.dcDate, itemCode: item.itemCode || data.itemCode, itemName: item.itemName, unit: item.unit || 'Nos', type: 'OUT', quantity, balanceAfter, reason: 'Customer Dispatch (Delivery Challan)', reference: number };
    await client.query("INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES('stockTransactions',$1,$2::jsonb,1,now(),$3) ON CONFLICT(storage_key,record_id) DO NOTHING", [stockId, JSON.stringify(transaction), req.user.email]);
    /* Same transaction, one authoritative central ledger row per challan line. */
    await postStockMovement(client, req, {
      ledgerId: stockId,
      itemCode: item.itemCode || data.itemCode,
      materialName: item.itemName || data.itemName,
      movementType: 'OUT',
      quantity,
      unit: item.unit || data.unit || 'Nos',
      unitCost: Number(data.unitPrice || data.rate || 0),
      entryDate: payload.dcDetails.dispatchDate || payload.dcDetails.dcDate,
      sourceDocType: 'Delivery Challan',
      sourceDocRef: number,
      batchNo: item.batchNo || '',
      lotNumber: item.lotNumber || '',
      reason: 'Customer Dispatch (Delivery Challan)',
      payload: transaction
    });
  }
};
const reserveDispatchRequest = async (client, req, payload, number) => {
  const requestId = String(payload.dispatchRequestId || payload.dcDetails?.dispatchRequestId || '');
  if (!requestId) return;
  const result = await client.query("SELECT data,version FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1 FOR UPDATE", [requestId]);
  if (!result.rowCount) throw conflict('Production dispatch request is no longer available. Refresh and retry.');
  const current = result.rows[0].data || {};
  const quantity = (payload.items || []).reduce((n, item) => n + (Number(item.quantity) || 0), 0);
  if (current.status !== 'Pending' || current.challanNumber) throw conflict('Production dispatch request already has a Delivery Challan.');
  if (quantity <= 0 || quantity > Number(current.eligibleQuantity)) throw conflict(`Dispatch quantity must be positive and no more than ${current.eligibleQuantity}.`);
  if (String(payload.dcDetails?.salesOrderRef || '') !== String(current.salesOrderNo || '') || String(payload.dcDetails?.projectId || '') !== String(current.projectId || '') || String(payload.customerDetails?.customerName || '') !== String(current.customerName || '') || (payload.items || []).length !== 1 || String(payload.items[0].itemName || '') !== String(current.partName || '')) throw conflict('The dispatch request customer, project, Sales Order and part must match the Delivery Challan.');
  const at = new Date().toISOString();
  const next = { ...current, status: 'Challan Created', challanNumber: number, challanQuantity: quantity, audit: [...(current.audit || []), { action: 'Delivery Challan created', user: req.user.email, at, reference: number, quantity }] };
  await client.query("UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key='productionDispatchRequests' AND record_id=$1 AND version=$2", [requestId, result.rows[0].version, JSON.stringify(next), req.user.email]);
};
const confirmDispatchRequest = async (client, req, payload, number) => {
  const requestId = String(payload.dispatchRequestId || payload.dcDetails?.dispatchRequestId || '');
  if (!requestId) return;
  const result = await client.query("SELECT data,version FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1 FOR UPDATE", [requestId]);
  if (!result.rowCount) throw conflict('Production dispatch request is missing; dispatch was not confirmed.');
  const current = result.rows[0].data || {};
  if (current.status !== 'Challan Created' || String(current.challanNumber) !== number) throw conflict('The dispatch request is not in a confirmable state for this challan.');
  const at = new Date().toISOString();
  const next = { ...current, status: 'Dispatched', dispatchedAt: at, dispatchedBy: req.user.email, audit: [...(current.audit || []), { action: 'Dispatch confirmed', user: req.user.email, at, reference: number }] };
  await client.query("UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key='productionDispatchRequests' AND record_id=$1 AND version=$2", [requestId, result.rows[0].version, JSON.stringify(next), req.user.email]);
  await stockMove(client, req, payload, number);
};

router.get('/', async (_req, res) => {
  const result = await getPool().query('SELECT * FROM delivery_challans WHERE deleted_at IS NULL ORDER BY dc_date DESC,dc_number DESC');
  res.json({ records: result.rows.map(view) });
});
router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const [legacy, current] = await Promise.all([
    getPool().query("SELECT data FROM erp_state WHERE storage_key='deliveryChallanHistory'"),
    getPool().query('SELECT dc_number,payload,deleted_at FROM delivery_challans')
  ]);
  const old = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const rows = new Map(current.rows.map((r) => [r.dc_number.toLowerCase(), r]));
  const eligible = [], existing = [], conflicts = [], deleted = [], seen = new Set();
  for (const entry of old) {
    const payload = entry?.payload; const number = String(payload?.dcDetails?.dcNumber || entry?.reference || '').trim();
    if (!number || seen.has(number.toLowerCase())) { if (number) conflicts.push({ number, reason: 'Duplicate legacy ID' }); continue; }
    seen.add(number.toLowerCase()); const row = rows.get(number.toLowerCase());
    if (row?.deleted_at) deleted.push({ number });
    else if (row) (JSON.stringify(row.payload) === JSON.stringify(payload) ? existing : conflicts).push({ number, reason: row.payload === payload ? undefined : 'Existing PostgreSQL record differs' });
    else { try { validate(payload); eligible.push({ number, payload }); } catch (e) { conflicts.push({ number, reason: e.message }); } }
  }
  res.json({ eligible, existing, conflicts, deleted, counts: { eligible: eligible.length, existing: existing.length, conflicts: conflicts.length, deleted: deleted.length } });
});
router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) throw bad('Select between 1 and 1000 Delivery Challans to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const imported = [], conflicts = [];
    for (const payload of records) {
      const number = validate(payload); await client.query("SELECT pg_advisory_xact_lock(hashtext('delivery-challan:' || $1))", [number]);
      const current = await client.query('SELECT deleted_at FROM delivery_challans WHERE dc_number=$1 FOR UPDATE', [number]);
      if (current.rowCount) { conflicts.push({ number, reason: current.rows[0].deleted_at ? 'Deleted record is protected' : 'Record already exists' }); continue; }
      await client.query('INSERT INTO delivery_challans(dc_number,dc_date,sales_order_ref,customer_name,status,payload,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7)', [number, payload.dcDetails.dcDate, payload.dcDetails.salesOrderRef || '', payload.customerDetails.customerName || payload.customerDetails.companyName, payload.dcDetails.challanStatus || 'Dispatched', JSON.stringify(payload), req.user.email]);
      await insertItems(client, number, payload.items); await audit(client, req, number, 'IMPORT', null, payload, 'Admin-confirmed legacy migration'); imported.push(number);
    }
    await client.query('COMMIT'); res.json({ imported, conflicts });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
router.get('/:number', async (req, res) => {
  const result = await getPool().query('SELECT * FROM delivery_challans WHERE dc_number=$1 AND deleted_at IS NULL', [req.params.number]);
  if (!result.rowCount) return res.status(404).json({ error: 'Delivery Challan not found.' });
  res.json({ record: view(result.rows[0]) });
});
router.post('/', async (req, res) => {
  const payload = req.body?.data; const number = validate(payload); const token = String(req.body?.createToken || '');
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const prior = await client.query('SELECT * FROM delivery_challans WHERE create_token=$1 FOR UPDATE', [token]);
    if (prior.rowCount) { if (prior.rows[0].deleted_at) throw conflict('Deleted Delivery Challan cannot be recreated by retry.'); await client.query('COMMIT'); return res.json({ record: view(prior.rows[0]), duplicate: true }); }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('delivery-challan:' || $1))", [number]);
    const exists = await client.query('SELECT deleted_at FROM delivery_challans WHERE dc_number=$1 FOR UPDATE', [number]);
    if (exists.rowCount) throw conflict('Delivery Challan number already exists or is protected by a deletion.');
    const result = await client.query('INSERT INTO delivery_challans(dc_number,dc_date,sales_order_ref,customer_name,status,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *', [number, payload.dcDetails.dcDate, payload.dcDetails.salesOrderRef || '', payload.customerDetails.customerName || payload.customerDetails.companyName, payload.dcDetails.challanStatus || 'Dispatched', JSON.stringify(payload), token, req.user.email]);
    await insertItems(client, number, payload.items); await reserveDispatchRequest(client, req, payload, number);
    if (!(payload.dispatchRequestId || payload.dcDetails?.dispatchRequestId)) await stockMove(client, req, payload, number);
    await audit(client, req, number, 'CREATE', null, payload); await client.query('COMMIT'); res.status(201).json({ record: view(result.rows[0]), duplicate: false });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
router.put('/:number', async (req, res) => {
  const number = String(req.params.number); const payload = req.body?.data; if (validate(payload) !== number) throw bad('Delivery Challan number cannot change.');
  const version = Number(req.body?.version); if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const current = await client.query('SELECT * FROM delivery_challans WHERE dc_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Delivery Challan not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Delivery Challan changed on the server. Reload before editing.', view(current.rows[0]));
    const result = await client.query('UPDATE delivery_challans SET dc_date=$2,sales_order_ref=$3,customer_name=$4,status=$5,payload=$6::jsonb,version=version+1,updated_at=now(),updated_by=$7 WHERE dc_number=$1 RETURNING *', [number, payload.dcDetails.dcDate, payload.dcDetails.salesOrderRef || '', payload.customerDetails.customerName || payload.customerDetails.companyName, payload.dcDetails.challanStatus || 'Dispatched', JSON.stringify(payload), req.user.email]);
    await client.query('DELETE FROM delivery_challan_items WHERE dc_number=$1', [number]); await insertItems(client, number, payload.items); await audit(client, req, number, 'UPDATE', current.rows[0].payload, payload); await client.query('COMMIT'); res.json({ record: view(result.rows[0]) });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
router.post('/:number/confirm-dispatch', async (req, res) => {
  const number = String(req.params.number); const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const current = await client.query('SELECT * FROM delivery_challans WHERE dc_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Delivery Challan not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Delivery Challan changed on the server. Reload before dispatch.', view(current.rows[0]));
    if (current.rows[0].status !== 'Challan Created') throw conflict('Only a challan awaiting dispatch can be confirmed.');
    const payload = { ...current.rows[0].payload, dcDetails: { ...current.rows[0].payload.dcDetails, challanStatus: 'Dispatched' } };
    await confirmDispatchRequest(client, req, payload, number);
    const saved = await client.query("UPDATE delivery_challans SET status='Dispatched',payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE dc_number=$1 RETURNING *", [number, JSON.stringify(payload), req.user.email]);
    await audit(client, req, number, 'DISPATCH', current.rows[0].payload, payload); await client.query('COMMIT'); res.json({ record: view(saved.rows[0]) });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
router.delete('/:number', requireAdmin, async (req, res) => {
  const number = String(req.params.number); const version = Number(req.body?.version); if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const current = await client.query('SELECT * FROM delivery_challans WHERE dc_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Delivery Challan not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Delivery Challan changed on the server. Reload before deleting.');
    const references = await client.query("SELECT data FROM erp_state WHERE storage_key=ANY($1::text[])", [['customerInvoiceHistory','exportInvoiceHistory']]);
    const contains = (v) => typeof v === 'string' ? v.toLowerCase() === number.toLowerCase() : Array.isArray(v) ? v.some(contains) : v && typeof v === 'object' ? Object.values(v).some(contains) : false;
    if (references.rows.some((r) => contains(r.data))) throw conflict('Delivery Challan is referenced by an invoice and cannot be moved to the Recycle Bin.');
    const reason = String(req.body?.reason || '').trim(); await client.query('UPDATE delivery_challans SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_by=$2,updated_at=now() WHERE dc_number=$1', [number, req.user.email, reason]);
    await audit(client, req, number, 'SOFT_DELETE', current.rows[0].payload, null, reason); await client.query('COMMIT'); res.json({ deleted: number });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
export default router;
