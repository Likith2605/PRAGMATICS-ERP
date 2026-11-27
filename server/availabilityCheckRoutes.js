import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.roleKey === 'administrator' || req.user?.role === 'Administrator';
const canRead = (req) => isAdmin(req) || hasPermissionForRole(req.user?.roleKey, ['sales_order.view', 'store.module'], req.user?.rolePermissions);
const canWrite = (req) => isAdmin(req) || hasPermissionForRole(req.user?.roleKey, 'store.module', req.user?.rolePermissions);
const forbidden = () => Object.assign(new Error('Your selected department role does not allow this availability-check operation.'), { status: 403 });
const checkId = (value) => {
  const soNumber = String(value || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(soNumber)) throw bad('A valid Sales Order number is required.');
  return soNumber;
};
const checkView = (row) => ({
  ...row.data,
  id: row.record_id,
  recordVersion: Number(row.version),
  updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  updatedBy: row.updated_by
});
const audit = (client, req, soNumber, action, before, after, reason = '') => client.query(
  `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES($1,$2,$3,'soMaterialAvailabilityChecks',$4,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [req.user.id, req.user.email, req.user.role || req.user.roleKey, soNumber, action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const historyEntry = (req, action, details) => ({
  userId: req.user?.id || '',
  name: req.user?.name || req.user?.email || 'User',
  empId: req.user?.employeeId || '',
  dept: req.user?.department || '',
  action,
  details,
  at: new Date().toISOString()
});
const readSource = async (client, soNumber) => {
  const [salesOrder, inventory] = await Promise.all([
    client.query('SELECT payload FROM sales_orders WHERE so_number=$1 AND deleted_at IS NULL', [soNumber]),
    client.query("SELECT data FROM module_records WHERE storage_key='inventoryItems' ORDER BY record_id")
  ]);
  if (!salesOrder.rowCount) throw conflict(`Sales Order ${soNumber} is not available in PostgreSQL.`);
  const payload = salesOrder.rows[0].payload || {};
  const sourceItems = Array.isArray(payload.items) ? payload.items : [];
  const inventoryItems = inventory.rows.map((row) => row.data || {});
  const lines = sourceItems.map((item, index) => {
    const code = String(item.itemCode || '').trim();
    const name = String(item.itemName || '').trim();
    const match = inventoryItems.find((stock) =>
      (code && String(stock.itemCode || '').toLowerCase() === code.toLowerCase()) ||
      (name && stock.itemName && String(stock.itemName).toLowerCase() === name.toLowerCase())
    );
    const availableStock = Number(match?.currentQty) || 0;
    const orderedQty = Number(item.quantity) || 0;
    const availableQty = Math.min(availableStock, orderedQty);
    const shortageQty = Math.max(0, orderedQty - availableStock);
    return {
      lineNo: index + 1,
      materialCode: code || match?.itemCode || '',
      materialName: name || '-',
      drawingNo: item.drawingNo || '',
      hsnSac: item.hsnSac || '',
      unit: item.unit || match?.unit || 'Nos',
      orderedQty,
      availableStock,
      requiredQty: orderedQty,
      availableQty,
      shortageQty,
      purchaseQty: shortageQty,
      status: shortageQty > 0 ? 'Purchase Required' : 'Available',
      inventoryMatched: Boolean(match)
    };
  });
  if (!lines.length) throw conflict('Sales Order has no material lines.');
  return { payload, lines };
};
const legacyRecordError = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'Record must be an object.';
  if (!String(record.soNumber || '').trim()) return 'Sales Order number is missing.';
  if (!Array.isArray(record.lines) || !record.lines.length) return 'Material check lines are missing.';
  return null;
};

router.get('/', async (req, res) => {
  if (!canRead(req)) throw forbidden();
  const result = await getPool().query(
    "SELECT record_id,data,version,updated_at,updated_by FROM module_records WHERE storage_key='soMaterialAvailabilityChecks' ORDER BY record_id"
  );
  res.json({ records: result.rows.map(checkView) });
});

router.put('/:soNumber', async (req, res) => {
  if (!canWrite(req)) throw forbidden();
  const soNumber = checkId(req.params.soNumber);
  const remarks = String(req.body?.remarks || '').trim().slice(0, 2000);
  const expectedVersion = Number(req.body?.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw bad('The current PostgreSQL availability-check version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('availability-check:' || $1))", [soNumber]);
    const currentResult = await client.query(
      "SELECT record_id,data,version,updated_at,updated_by FROM module_records WHERE storage_key='soMaterialAvailabilityChecks' AND record_id=$1 FOR UPDATE",
      [soNumber]
    );
    const current = currentResult.rows[0] || null;
    const currentVersion = current ? Number(current.version) : 0;
    if (currentVersion !== expectedVersion) throw conflict('Availability check changed in PostgreSQL. Reload before saving.', current ? checkView(current) : null);
    const { payload, lines } = await readSource(client, soNumber);
    const previousData = current?.data || null;
    const now = new Date();
    const check = {
      soNumber,
      projectId: payload.soDetails?.projectId || '',
      customer: payload.customerDetails?.companyName || payload.customerDetails?.customerName || '',
      orderDate: payload.soDetails?.soDate || '',
      deliveryDate: payload.soDetails?.deliveryDate || '',
      status: 'Checked',
      lines,
      remarks,
      checkedBy: req.user?.name || req.user?.email || 'User',
      checkedByEmpId: req.user?.employeeId || '',
      checkedByDept: req.user?.department || '',
      checkedAt: now.toISOString(),
      checkedDate: now.toISOString().slice(0, 10),
      productionNotified: Boolean(previousData?.productionNotified),
      productionNotifiedAt: previousData?.productionNotifiedAt || '',
      history: [...(previousData?.history || []), historyEntry(req, 'Availability check saved', `${lines.filter((line) => line.shortageQty > 0).length} material(s) with shortage`)]
    };
    const saved = await client.query(
      `INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by)
       VALUES('soMaterialAvailabilityChecks',$1,$2::jsonb,1,now(),$3)
       ON CONFLICT(storage_key,record_id) DO UPDATE
       SET data=EXCLUDED.data,version=module_records.version+1,updated_at=now(),updated_by=EXCLUDED.updated_by
       WHERE module_records.version=$4
       RETURNING record_id,data,version,updated_at,updated_by`,
      [soNumber, JSON.stringify(check), req.user.email, expectedVersion]
    );
    if (!saved.rowCount) throw conflict('Availability check changed in PostgreSQL. Reload before saving.');
    await audit(client, req, soNumber, current ? 'UPDATE' : 'CREATE', previousData, check);
    await client.query('COMMIT');
    res.json({ record: checkView(saved.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.post('/:soNumber/production-notified', async (req, res) => {
  if (!canWrite(req)) throw forbidden();
  const soNumber = checkId(req.params.soNumber);
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) throw bad('The current PostgreSQL availability-check version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      "SELECT record_id,data,version,updated_at,updated_by FROM module_records WHERE storage_key='soMaterialAvailabilityChecks' AND record_id=$1 FOR UPDATE",
      [soNumber]
    );
    if (!currentResult.rowCount) throw Object.assign(new Error('Availability check not found.'), { status: 404 });
    const current = currentResult.rows[0];
    if (Number(current.version) !== version) throw conflict('Availability check changed in PostgreSQL. Reload before updating it.', checkView(current));
    if (current.data.productionNotified) {
      await client.query('COMMIT');
      return res.json({ record: checkView(current), duplicate: true });
    }
    const after = { ...current.data, productionNotified: true, productionNotifiedAt: new Date().toISOString() };
    const updated = await client.query(
      `UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4
       WHERE storage_key='soMaterialAvailabilityChecks' AND record_id=$1 AND version=$2
       RETURNING record_id,data,version,updated_at,updated_by`,
      [soNumber, version, JSON.stringify(after), req.user.email]
    );
    await audit(client, req, soNumber, 'PRODUCTION_NOTIFIED', current.data, after);
    await client.query('COMMIT');
    res.json({ record: checkView(updated.rows[0]), duplicate: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const pool = getPool();
  const [legacy, current, salesOrders] = await Promise.all([
    pool.query("SELECT data FROM erp_state WHERE storage_key='soMaterialAvailabilityChecks'"),
    pool.query("SELECT record_id,data FROM module_records WHERE storage_key='soMaterialAvailabilityChecks'"),
    pool.query('SELECT so_number FROM sales_orders WHERE deleted_at IS NULL')
  ]);
  const rows = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byId = new Map(current.rows.map((row) => [row.record_id, row.data]));
  const validOrders = new Set(salesOrders.rows.map((row) => row.so_number));
  const result = { eligible: [], existing: [], conflicts: [] };
  const seen = new Set();
  for (const record of rows) {
    const soNumber = String(record?.soNumber || '').trim();
    const invalid = legacyRecordError(record);
    if (invalid) { result.conflicts.push({ soNumber, reason: invalid }); continue; }
    if (seen.has(soNumber)) { result.conflicts.push({ soNumber, reason: 'Duplicate Sales Order check in the legacy snapshot.' }); continue; }
    seen.add(soNumber);
    if (!validOrders.has(soNumber)) { result.conflicts.push({ soNumber, reason: 'The referenced Sales Order is not present in PostgreSQL.' }); continue; }
    if (!byId.has(soNumber)) result.eligible.push({ soNumber, record });
    else if (JSON.stringify(byId.get(soNumber)) === JSON.stringify(record)) result.existing.push({ soNumber });
    else result.conflicts.push({ soNumber, reason: 'A different PostgreSQL availability check already exists.' });
  }
  res.json({ ...result, counts: Object.fromEntries(Object.entries(result).map(([key, values]) => [key, values.length])) });
});

router.post('/migration-preview/import', requireAdmin, async (req, res) => {
  const requested = req.body?.soNumbers;
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000) throw bad('Select between 1 and 1000 availability checks to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='soMaterialAvailabilityChecks' FOR SHARE");
    const source = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    const byId = new Map(source.map((record) => [String(record?.soNumber || ''), record]));
    const imported = [];
    const conflicts = [];
    for (const soNumber of [...new Set(requested.map(String))]) {
      const record = byId.get(soNumber);
      if (!record || legacyRecordError(record)) { conflicts.push({ soNumber, reason: 'The selected legacy check is no longer valid or present.' }); continue; }
      const salesOrder = await client.query('SELECT 1 FROM sales_orders WHERE so_number=$1 AND deleted_at IS NULL FOR SHARE', [soNumber]);
      if (!salesOrder.rowCount) { conflicts.push({ soNumber, reason: 'The referenced Sales Order is not present in PostgreSQL.' }); continue; }
      const existing = await client.query("SELECT 1 FROM module_records WHERE storage_key='soMaterialAvailabilityChecks' AND record_id=$1 FOR UPDATE", [soNumber]);
      if (existing.rowCount) { conflicts.push({ soNumber, reason: 'A PostgreSQL availability check already exists.' }); continue; }
      await client.query(
        `INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by)
         VALUES('soMaterialAvailabilityChecks',$1,$2::jsonb,1,now(),$3)`,
        [soNumber, JSON.stringify(record), req.user.email]
      );
      await audit(client, req, soNumber, 'LEGACY_IMPORT', null, record, 'Explicit Admin import from migration preview');
      imported.push(soNumber);
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

export default router;
