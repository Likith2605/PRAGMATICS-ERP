import express from 'express';
import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const text = (value) => String(value ?? '').trim();
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const createIntent = (value) => {
  const intent = { ...value };
  for (const field of ['status', 'createdAt', 'updatedAt', 'version', 'recordVersion', 'decidedBy', 'decidedAt', 'decisionReason', 'approvedBy', 'approvedAt', 'approvalRemarks', 'rejectedAt', 'rejectionReason', 'poNumber', 'convertedAt']) {
    delete intent[field];
  }
  return intent;
};

const authorize = (req, permission) => {
  if (!isAdmin(req) && !hasPermissionForRole(req.user?.roleKey, [permission], req.user?.rolePermissions)) {
    throw Object.assign(new Error(`Permission denied: ${permission}`), { status: 403 });
  }
};

const validate = (record, { requireId = false } = {}) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw bad('Purchase Request data is required.');
  const id = text(record.prNumber);
  if (requireId && (!id || id.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(id))) throw bad('A valid Purchase Request number is required.');
  if (!Array.isArray(record.items) || !record.items.length) throw bad('A Purchase Request must contain at least one material.');
  if (record.items.some((item) => !text(item?.materialName || item?.itemName) ||
      !(Number(item?.requiredQty) > 0) || Number(item?.shortageQty ?? item?.requiredQty) < 0)) {
    throw bad('Every Purchase Request line must have a material name, positive required quantity and non-negative shortage.');
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 2 * 1024 * 1024) throw Object.assign(new Error('Purchase Request exceeds the 2 MB limit.'), { status: 413 });
  return id;
};

const audit = (client, req, id, action, before, after, reason = '') => client.query(
  `INSERT INTO purchase_request_audit(pr_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [id, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);

const rowView = async (client, row) => {
  const items = await client.query(
    'SELECT * FROM purchase_request_items WHERE pr_number=$1 ORDER BY line_number',
    [row.pr_number]
  );
  return {
    ...row.payload,
    prNumber: row.pr_number,
    mrNumber: row.mr_number,
    status: row.status,
    projectId: row.project_id,
    items: items.rows.map((item) => ({ ...item.payload, materialId: item.material_id, materialName: item.material_name, requiredQty: Number(item.required_qty), shortageQty: Number(item.shortage_qty), unit: item.unit })),
    version: Number(row.version),
    recordVersion: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deleteReason: row.delete_reason
  };
};

const insertItems = async (client, id, items) => {
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO purchase_request_items(pr_number,line_number,material_id,material_name,required_qty,shortage_qty,unit,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [id, index + 1, text(item.materialId || item.itemCode), text(item.materialName || item.itemName),
        Number(item.requiredQty), Number(item.shortageQty ?? item.requiredQty), text(item.unit) || 'Nos', JSON.stringify(item)]
    );
  }
};

const nextNumber = async (client) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('procurement-sequence:storePurchaseRequest'))");
  const sequence = await client.query("SELECT last_number FROM procurement_sequences WHERE sequence_key='storePurchaseRequest' FOR UPDATE");
  const maximum = await client.query("SELECT COALESCE(max((regexp_match(pr_number,'([0-9]+)$'))[1]::bigint),0) AS n FROM purchase_requests");
  const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='storePurchaseRequests'");
  let max = Math.max(Number(sequence.rows[0]?.last_number || 0), Number(maximum.rows[0]?.n || 0));
  for (const row of Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : []) {
    const suffix = String(row?.prNumber || '').match(/(\d+)$/);
    if (suffix) max = Math.max(max, Number(suffix[1]));
  }
  const value = max + 1;
  await client.query(
    `INSERT INTO procurement_sequences(sequence_key,last_number,updated_at) VALUES('storePurchaseRequest',$1,now())
     ON CONFLICT(sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`,
    [value]
  );
  return `PR-${String(value).padStart(6, '0')}`;
};

const assertMaterialRequest = async (client, id) => {
  const mrNumber = text(id);
  if (!mrNumber) return '';
  const result = await client.query('SELECT deleted_at FROM material_requests WHERE mr_number=$1', [mrNumber]);
  if (!result.rowCount || result.rows[0].deleted_at) throw conflict(`Material Request ${mrNumber} is missing or deleted.`);
  return mrNumber;
};

router.get('/', async (req, res) => {
  authorize(req, 'purchase_request.view');
  const client = await getPool().connect();
  try {
    const rows = await client.query('SELECT * FROM purchase_requests WHERE deleted_at IS NULL ORDER BY created_at DESC,pr_number');
    const records = [];
    for (const row of rows.rows) records.push(await rowView(client, row));
    res.json({ records });
  } finally { client.release(); }
});

router.post('/', async (req, res) => {
  authorize(req, 'purchase_request.create');
  const payload = req.body?.data;
  validate(payload);
  const token = text(req.body?.createToken);
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-request-token:${token}`]);
    const retry = await client.query('SELECT * FROM purchase_requests WHERE create_token=$1 FOR UPDATE', [token]);
    if (retry.rowCount) {
      const savedIntent = createIntent(retry.rows[0].payload);
      if (!text(payload.prNumber)) delete savedIntent.prNumber;
      if (canonical(savedIntent) !== canonical(createIntent(payload))) throw conflict('This idempotency token was already used for different Purchase Request data.');
      await client.query('COMMIT');
      return res.json({ record: await rowView(client, retry.rows[0]), duplicate: true });
    }
    const mrNumber = await assertMaterialRequest(client, payload.mrNumber);
    const id = text(payload.prNumber) || await nextNumber(client);
    validate({ ...payload, prNumber: id }, { requireId: true });
    const exists = await client.query('SELECT 1 FROM purchase_requests WHERE pr_number=$1', [id]);
    if (exists.rowCount) throw conflict(`Purchase Request ${id} already exists or is protected by deletion.`);
    const record = { ...payload, prNumber: id, mrNumber, status: 'Pending Approval', createdAt: new Date().toISOString() };
    const saved = await client.query(
      `INSERT INTO purchase_requests(pr_number,mr_number,status,project_id,payload,create_token,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$7) RETURNING *`,
      [id, mrNumber, record.status, text(record.projectId), JSON.stringify(record), token, req.user?.email || '']
    );
    await insertItems(client, id, record.items);
    await audit(client, req, id, 'CREATE', null, record);
    await client.query('COMMIT');
    res.status(201).json({ record: await rowView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/:prNumber/approve', async (req, res) => transition(req, res, 'Approved', 'APPROVE'));
router.post('/:prNumber/reject', async (req, res) => transition(req, res, 'Rejected', 'REJECT'));

async function transition(req, res, status, action) {
  authorize(req, 'purchase_request.approve');
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  if (!Number.isInteger(version) || version < 1) throw bad('The current PostgreSQL version is required.');
  if (status === 'Rejected' && !reason) throw bad('A rejection reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM purchase_requests WHERE pr_number=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.prNumber]);
    if (!current.rowCount) throw notFound('Purchase Request not found.');
    const row = current.rows[0];
    if (Number(row.version) !== version) throw conflict('Purchase Request changed on the server. Reload before retrying.', await rowView(client, row));
    if (row.status !== 'Pending Approval') throw conflict(`Only a Pending Approval Purchase Request can be ${status.toLowerCase()}.`);
    const payload = { ...row.payload, status, decisionReason: reason, decidedBy: req.user?.email || '', decidedAt: new Date().toISOString() };
    const saved = await client.query(
      `UPDATE purchase_requests SET status=$2,payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now()
       WHERE pr_number=$1 RETURNING *`,
      [row.pr_number, status, JSON.stringify(payload), req.user?.email || '']
    );
    await audit(client, req, row.pr_number, action, row.payload, payload, reason);
    await client.query('COMMIT');
    res.json({ record: await rowView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

router.delete('/:prNumber', requireAdmin, async (req, res) => {
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  if (!Number.isInteger(version) || version < 1) throw bad('The current PostgreSQL version is required.');
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM purchase_requests WHERE pr_number=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.prNumber]);
    if (!current.rowCount) throw notFound('Purchase Request not found.');
    const row = current.rows[0];
    if (Number(row.version) !== version) throw conflict('Purchase Request changed on the server. Reload before deleting.', await rowView(client, row));
    if (row.status === 'Converted to PO') throw conflict('A Purchase Request linked to a Purchase Order cannot be deleted.');
    const references = await client.query(
      'SELECT 1 FROM vendor_enquiries WHERE pr_number=$1 UNION ALL SELECT 1 FROM purchase_orders WHERE pr_number=$1 LIMIT 1',
      [row.pr_number]
    );
    if (references.rowCount) throw conflict('A Vendor Enquiry or Purchase Order references this Purchase Request.');
    const payload = { ...row.payload, deletedAt: new Date().toISOString(), deletedBy: req.user?.email || '' };
    const deleted = await client.query(
      `UPDATE purchase_requests SET deleted_at=now(),deleted_by=$2,delete_reason=$3,payload=$4::jsonb,
       version=version+1,updated_by=$2,updated_at=now() WHERE pr_number=$1 RETURNING *`,
      [row.pr_number, req.user?.email || '', reason, JSON.stringify(payload)]
    );
    await audit(client, req, row.pr_number, 'DELETE', row.payload, payload, reason);
    await client.query('COMMIT');
    res.json({ record: await rowView(client, deleted.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/migration-preview', requireAdmin, async (req, res) => {
  const [legacy, current] = await Promise.all([
    getPool().query("SELECT data,updated_at FROM erp_state WHERE storage_key='storePurchaseRequests'"),
    getPool().query('SELECT pr_number,payload,deleted_at FROM purchase_requests')
  ]);
  const source = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byId = new Map(current.rows.map((row) => [row.pr_number, row]));
  const eligible = []; const existing = []; const conflicts = []; const deleted = []; const seen = new Set();
  for (const record of source) {
    const id = text(record?.prNumber);
    if (!id || seen.has(id)) { conflicts.push({ id, reason: !id ? 'Missing Purchase Request number.' : 'Duplicate legacy identifier.' }); continue; }
    seen.add(id);
    const row = byId.get(id);
    if (row?.deleted_at) { deleted.push({ id, reason: 'Database record is soft-deleted.' }); continue; }
    if (row) {
      (canonical(row.payload) === canonical(record) ? existing : conflicts).push({ id, reason: canonical(row.payload) === canonical(record) ? 'Already present.' : 'PostgreSQL record differs.' });
      continue;
    }
    try { validate(record, { requireId: true }); eligible.push(record); }
    catch (error) { conflicts.push({ id, reason: error.message }); }
  }
  res.json({ eligible, existing, conflicts, deleted, counts: { eligible: eligible.length, existing: existing.length, conflicts: conflicts.length, deleted: deleted.length }, legacyUpdatedAt: legacy.rows[0]?.updated_at || null });
});

router.post('/migration-preview/import-selected', requireAdmin, async (req, res) => {
  const ids = req.body?.records;
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw bad('Select between 1 and 1000 Purchase Requests from the Admin migration preview.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='storePurchaseRequests' FOR SHARE");
    const source = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    const imported = []; const conflicts = [];
    for (const id of [...new Set(ids.map(text))]) {
      const matches = source.filter((record) => text(record?.prNumber) === id);
      if (matches.length !== 1) { conflicts.push({ id, reason: 'Legacy source record is missing or duplicated.' }); continue; }
      const payload = matches[0];
      try { validate(payload, { requireId: true }); }
      catch (error) { conflicts.push({ id, reason: error.message }); continue; }
      const current = await client.query('SELECT 1 FROM purchase_requests WHERE pr_number=$1 FOR UPDATE', [id]);
      if (current.rowCount) { conflicts.push({ id, reason: 'PostgreSQL row already exists or is protected by deletion.' }); continue; }
      const mrNumber = text(payload.mrNumber);
      if (mrNumber) {
        const mr = await client.query('SELECT deleted_at FROM material_requests WHERE mr_number=$1', [mrNumber]);
        if (!mr.rowCount || mr.rows[0].deleted_at) { conflicts.push({ id, reason: `Material Request ${mrNumber} is missing or deleted.` }); continue; }
      }
      const token = `legacy-purchase-request:${createHash('sha256').update(id).digest('hex')}`;
      const saved = await client.query(
        `INSERT INTO purchase_requests(pr_number,mr_number,status,project_id,payload,create_token,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$7) RETURNING *`,
        [id, mrNumber, text(payload.status) || 'Pending Approval', text(payload.projectId), JSON.stringify(payload), token, req.user?.email || '']
      );
      await insertItems(client, id, payload.items);
      await audit(client, req, id, 'LEGACY_IMPORT', null, payload, 'Selected Admin import from preserved legacy data.');
      imported.push(await rowView(client, saved.rows[0]));
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/:prNumber/audit', async (req, res) => {
  authorize(req, 'purchase_request.view');
  const result = await getPool().query('SELECT id,actor_email,actor_role,action,reason,before_values,after_values,created_at FROM purchase_request_audit WHERE pr_number=$1 ORDER BY id DESC LIMIT 100', [req.params.prNumber]);
  res.json({ audit: result.rows });
});

export default router;
