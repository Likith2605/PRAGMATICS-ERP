import express from 'express';
import { getPool } from './database.js';
import { requireAdmin } from './auth.js';
import {
  bad, conflict, notFound, text, num, dateOnly, idempotencyToken, readVersion,
  assertVersion, payloadSize, requirePermissions, writeAudit, bomNumber,
  legacyRows, auditRows, historyEntry
} from './productionSupport.js';

const router = express.Router();
const SAFE_NUMBER = /^[A-Za-z0-9._:-]{1,80}$/;

const normalizeLine = (raw, index) => {
  const item = raw || {};
  const materialId = text(item.materialId || item.itemCode || item.materialCode);
  const materialName = text(item.materialName || item.itemName || materialId);
  if (!materialId || !materialName) throw bad(`BOM line ${index + 1} needs a material and a name.`);
  const requiredQty = num(item.requiredQty ?? item.quantityPerUnit ?? item.quantity, -1);
  if (requiredQty < 0) throw bad(`BOM line ${index + 1} quantity cannot be negative.`);
  return {
    materialId,
    materialName,
    grade: text(item.grade),
    spec: text(item.spec),
    sizeDimensions: text(item.sizeDimensions || item.size),
    unit: text(item.unit, 'Nos'),
    requiredQty,
    purpose: text(item.purpose)
  };
};

const normalizePayload = (data, fallbackNumber = '') => {
  payloadSize(data);
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) throw bad('At least one BOM material is required.');
  const normalizedItems = items.map(normalizeLine);
  const partName = text(data?.partName || data?.drawingNumber || data?.partCode);
  if (!partName) throw bad('A part name or drawing number is required.');
  const effectiveDate = dateOnly(data?.effectiveDate, new Date().toISOString().slice(0, 10));
  const version = data?.version === undefined ? undefined : Number(data.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw bad('BOM version must be a positive integer.');
  return {
    ...data,
    id: text(data?.id || fallbackNumber),
    bomNumber: text(data?.bomNumber || fallbackNumber),
    projectId: text(data?.projectId),
    customerName: text(data?.customerName),
    companyName: text(data?.companyName),
    drawingNumber: text(data?.drawingNumber),
    partCode: text(data?.partCode || data?.drawingNumber || partName),
    partName,
    version: version || 1,
    effectiveDate,
    remarks: text(data?.remarks),
    items: normalizedItems
  };
};

const view = (row) => ({ ...(row.payload || {}), bomNumber: row.bom_number, version: Number(row.version), status: row.status, updatedAt: row.updated_at?.toISOString?.() || row.updated_at });

const insertBom = async (client, req, payload, number, options = {}) => {
  await client.query(
    `INSERT INTO bom_headers(bom_number,part_code,part_name,version,effective_date,status,remarks,created_by,updated_by,payload,create_token)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
    [number, payload.partCode, payload.partName, payload.version, payload.effectiveDate,
      payload.status || 'Active', payload.remarks, String(req.user?.email || ''), String(req.user?.email || ''),
      JSON.stringify(payload), options.createToken || null]
  );
  for (const [index, item] of payload.items.entries()) {
    await client.query(
      `INSERT INTO bom_items(bom_number,line_number,item_code,material_name,quantity_per_unit,unit,scrap_percentage,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [number, index + 1, item.materialId, item.materialName, item.requiredQty, item.unit,
        num(item.scrapPercentage, 0), JSON.stringify(item)]
    );
  }
};

const findExisting = async (client, number) => client.query(
  'SELECT * FROM bom_headers WHERE bom_number=$1 FOR UPDATE', [number]
);

router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const [legacy, current] = await Promise.all([
    legacyRows(getPool(), 'bomMasterList'),
    getPool().query('SELECT bom_number,payload,version,deleted_at FROM bom_headers')
  ]);
  const byNumber = new Map(current.rows.map((row) => [String(row.bom_number).toLowerCase(), row]));
  const eligible = [], existing = [], conflicts = [], deleted = [], seen = new Set();
  for (const entry of legacy) {
    const number = text(entry?.id || entry?.bomNumber || entry?.reference);
    if (!number || !SAFE_NUMBER.test(number)) { if (number) conflicts.push({ number, reason: 'Invalid BOM number' }); continue; }
    if (seen.has(number.toLowerCase())) { conflicts.push({ number, reason: 'Duplicate legacy ID' }); continue; }
    seen.add(number.toLowerCase());
    const row = byNumber.get(number.toLowerCase());
    if (row?.deleted_at) { deleted.push({ number }); continue; }
    if (row) {
      (Number(row.version) === Number(entry?.version || 1) ? existing : conflicts).push({ number, reason: 'Existing PostgreSQL BOM has a different version' });
      continue;
    }
    try { eligible.push({ number, payload: normalizePayload(entry, number) }); }
    catch (error) { conflicts.push({ number, reason: error.message }); }
  }
  res.json({ eligible, existing, conflicts, deleted, counts: { eligible: eligible.length, existing: existing.length, conflicts: conflicts.length, deleted: deleted.length } });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) throw bad('Select between 1 and 1000 BOMs to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const imported = [], conflicts = [];
    for (const entry of records) {
      const number = text(entry?.id || entry?.bomNumber || entry?.reference);
      if (!SAFE_NUMBER.test(number)) { conflicts.push({ number, reason: 'Invalid BOM number' }); continue; }
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bom:' || $1))", [number]);
      const existing = await findExisting(client, number);
      if (existing.rowCount) { conflicts.push({ number, reason: existing.rows[0].deleted_at ? 'Deleted record is protected' : 'Record already exists' }); continue; }
      const payload = normalizePayload(entry, number);
      payload.createdBy = String(req.user?.email || payload.createdBy || '');
      await insertBom(client, req, payload, number);
      await writeAudit(client, req, { table: 'bom_audit', idColumn: 'bom_number', id: number, action: 'IMPORT', after: payload, reason: 'Admin-confirmed legacy migration', module: 'bom' });
      imported.push(number);
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/effective', async (req, res) => {
  requirePermissions(req, 'production.view', 'material_request.create', 'job_card.view');
  const part = text(req.query.partCode || req.query.partName || req.query.drawingNumber);
  if (!part) throw bad('partCode is required.');
  const asOf = dateOnly(req.query.date, new Date().toISOString().slice(0, 10));
  const result = await getPool().query(
    `SELECT * FROM bom_headers
      WHERE deleted_at IS NULL AND status IN ('Active','Superseded') AND effective_date <= $2
        AND (lower(part_code)=lower($1) OR lower(part_name)=lower($1) OR lower(payload->>'drawingNumber')=lower($1))
      ORDER BY effective_date DESC, version DESC, bom_number DESC LIMIT 1`,
    [part, asOf]
  );
  if (!result.rowCount) return res.status(404).json({ error: `No effective BOM found for ${part} on ${asOf}.` });
  res.json({ record: view(result.rows[0]) });
});

router.get('/', async (req, res) => {
  const params = [];
  let where = 'deleted_at IS NULL';
  if (req.query.partCode) { params.push(text(req.query.partCode)); where += ` AND lower(part_code)=lower($${params.length})`; }
  if (req.query.status) { params.push(text(req.query.status)); where += ` AND status=$${params.length}`; }
  const result = await getPool().query(
    `SELECT * FROM bom_headers WHERE ${where} ORDER BY effective_date DESC, version DESC, bom_number DESC`, params
  );
  res.json({ records: result.rows.map(view) });
});

router.get('/:number/audit', async (req, res) => {
  const number = String(req.params.number || '');
  const exists = await getPool().query('SELECT 1 FROM bom_headers WHERE bom_number=$1', [number]);
  if (!exists.rowCount) throw notFound('BOM not found.');
  res.json({ entries: await auditRows(getPool(), 'bom_audit', 'bom_number', number, Number(req.query.limit)) });
});

router.get('/:number', async (req, res) => {
  const result = await getPool().query(
    'SELECT * FROM bom_headers WHERE bom_number=$1 AND deleted_at IS NULL', [String(req.params.number || '')]
  );
  if (!result.rowCount) throw notFound('BOM not found.');
  const items = await getPool().query('SELECT * FROM bom_items WHERE bom_number=$1 ORDER BY line_number', [result.rows[0].bom_number]);
  res.json({ record: { ...view(result.rows[0]), items: items.rows.map((row) => ({ ...(row.payload || {}), lineNumber: Number(row.line_number) })) } });
});

router.post('/', async (req, res) => {
  requirePermissions(req, 'material_request.create', 'production.view');
  const createToken = idempotencyToken(req.body?.createToken);
  const payload = normalizePayload(req.body?.data);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT * FROM bom_headers WHERE create_token=$1 FOR UPDATE', [createToken]);
    if (prior.rowCount) {
      if (prior.rows[0].deleted_at) throw conflict('Deleted BOM cannot be recreated by retry.');
      await client.query('COMMIT');
      return res.json({ record: view(prior.rows[0]), duplicate: true });
    }
    const number = await bomNumber(client);
    payload.id = number;
    payload.bomNumber = number;
    payload.status = text(payload.status, 'Active');
    payload.history = [historyEntry(req, 'BOM created', `${payload.items.length} material(s) · version ${payload.version}`)];
    await insertBom(client, req, payload, number, { createToken });
    await writeAudit(client, req, { table: 'bom_audit', idColumn: 'bom_number', id: number, action: 'CREATE', after: payload, module: 'bom' });
    await client.query('COMMIT');
    res.status(201).json({
      record: {
        ...payload,
        bomNumber: number,
        version: payload.version,
        status: payload.status,
        updatedAt: new Date().toISOString(),
        items: payload.items
      },
      duplicate: false
    });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/**
 * Editing a BOM creates a new version. The previous version is superseded but
 * remains readable, so an issued Job Card's snapshot can never be rewritten.
 */
router.put('/:number', async (req, res) => {
  requirePermissions(req, 'material_request.create', 'production.view');
  const number = String(req.params.number || '');
  const version = readVersion(req.body?.version);
  const payload = normalizePayload(req.body?.data, number);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const source = await findExisting(client, number);
    if (!source.rowCount || source.rows[0].deleted_at) throw notFound('BOM not found.');
    assertVersion(source.rows[0], version, 'BOM');
    if (payload.version !== Number(source.rows[0].version) + 1) throw bad(`BOM version must be ${Number(source.rows[0].version) + 1} when creating a new revision.`);

    const before = view(source.rows[0]);
    await client.query(
      "UPDATE bom_headers SET status='Superseded',version=version+1,updated_at=now(),updated_by=$2 WHERE bom_number=$1 AND version=$3",
      [number, req.user?.email || '', version]
    );
    const supersededPayload = { ...(source.rows[0].payload || {}), status: 'Superseded', history: [...((source.rows[0].payload || {}).history || []), historyEntry(req, 'BOM superseded', `Replaced by version ${payload.version}`)] };
    await client.query('UPDATE bom_headers SET payload=$2::jsonb WHERE bom_number=$1', [number, JSON.stringify(supersededPayload)]);

    const nextNumber = await bomNumber(client);
    payload.id = nextNumber;
    payload.bomNumber = nextNumber;
    payload.status = 'Active';
    payload.supersedes = number;
    payload.history = [...((source.rows[0].payload || {}).history || []), historyEntry(req, 'BOM revision created', `Supersedes ${number} (v${source.rows[0].version})`)];
    await insertBom(client, req, payload, nextNumber);
    await writeAudit(client, req, { table: 'bom_audit', idColumn: 'bom_number', id: number, action: 'SUPERSEDE', before, after: supersededPayload, module: 'bom' });
    await writeAudit(client, req, { table: 'bom_audit', idColumn: 'bom_number', id: nextNumber, action: 'NEW_VERSION', after: payload, reason: `Supersedes ${number}`, module: 'bom' });
    await client.query('COMMIT');
    res.json({
      record: {
        ...payload,
        bomNumber: nextNumber,
        version: payload.version,
        status: 'Active',
        updatedAt: new Date().toISOString(),
        items: payload.items
      },
      supersedes: number
    });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.delete('/:number', requireAdmin, async (req, res) => {
  const number = String(req.params.number || '');
  const version = readVersion(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await findExisting(client, number);
    if (!current.rowCount || current.rows[0].deleted_at) throw notFound('BOM not found.');
    assertVersion(current.rows[0], version, 'BOM');
    const before = view(current.rows[0]);
    await client.query(
      "UPDATE bom_headers SET deleted_at=now(),deleted_by=$2,delete_reason=$3,status='Deleted',version=version+1,updated_at=now(),updated_by=$2 WHERE bom_number=$1 AND version=$4",
      [number, req.user?.email || '', reason, version]
    );
    await writeAudit(client, req, { table: 'bom_audit', idColumn: 'bom_number', id: number, action: 'SOFT_DELETE', before, reason, module: 'bom' });
    await client.query('COMMIT');
    res.json({ deleted: number });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/:number/restore', requireAdmin, async (req, res) => {
  const number = String(req.params.number || '');
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A restore reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await findExisting(client, number);
    if (!current.rowCount || !current.rows[0].deleted_at) throw conflict('Only a deleted BOM can be restored.');
    const payload = { ...(current.rows[0].payload || {}), status: 'Active',
      history: [...((current.rows[0].payload || {}).history || []), historyEntry(req, 'BOM restored', reason)] };
    await client.query(
      `UPDATE bom_headers SET deleted_at=NULL,deleted_by=NULL,delete_reason='',status='Active',payload=$2::jsonb,
       version=version+1,updated_at=now(),updated_by=$3 WHERE bom_number=$1`,
      [number, JSON.stringify(payload), req.user?.email || '']
    );
    await writeAudit(client, req, { table: 'bom_audit', idColumn: 'bom_number', id: number,
      action: 'RESTORE', after: payload, reason, module: 'bom' });
    await client.query('COMMIT');
    res.json({ record: view({ ...current.rows[0], deleted_at: null, status: 'Active', payload,
      version: Number(current.rows[0].version) + 1 }) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

export default router;
