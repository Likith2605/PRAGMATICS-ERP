import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { money, convertToINR } from '../src/utils/currency.js';

const router = express.Router();
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const validRecord = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('Quotation data is required.');
  const details = payload.quotationDetails || {};
  const customer = payload.customerDetails || {};
  const number = String(details.quotationNumber || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(number)) throw badRequest('A valid quotation number is required.');
  if (!String(customer.customerName || customer.companyName || '').trim()) throw badRequest('Customer name is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(details.quotationDate || ''))) throw badRequest('Quotation date must use YYYY-MM-DD format.');
  if (!Array.isArray(payload.items) || payload.items.length === 0) throw badRequest('At least one quotation item is required.');
  if (Buffer.byteLength(JSON.stringify(payload)) > 5 * 1024 * 1024) throw Object.assign(new Error('Quotation exceeds the record size limit.'), { status: 413 });
  return number;
};
const versionOf = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const sum = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const makeHistory = (row) => {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return {
    date: String(row.quotation_date).slice(0, 10),
    reference: row.quotation_number,
    projectId: row.project_id,
    company: row.company_name || row.customer_name || '-',
    total: money(sum(row.grand_total), row.currency),
    currency: row.currency,
    amountINR: convertToINR(sum(row.grand_total), row.currency, payload.quotationDetails?.exchangeRate),
    balanceStatus: row.balance_status,
    version: Number(row.version),
    payload: { ...payload, recordVersion: Number(row.version) }
  };
};
const audit = (client, req, { number, action, before = null, after = null, reason = '' }) => client.query(
  `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES ($1,$2,$3,'quotations',$4,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [req.user.id, req.user.email, req.user.role, number, action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const insertItems = async (client, number, items) => {
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO quotation_items (quotation_number,line_number,item_name,quantity,unit_price,line_amount,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [number, index + 1, String(item?.itemName || item?.description || ''), sum(item?.quantity),
        sum(item?.unitPrice), sum(item?.amount ?? item?.lineAmount), JSON.stringify(item)]
    );
  }
};
const saveColumns = (payload, user) => {
  const details = payload.quotationDetails || {};
  const customer = payload.customerDetails || {};
  return [String(details.projectId || ''), String(customer.customerName || customer.companyName),
    String(customer.companyName || ''), String(details.quotationDate), String(details.currency || 'INR'),
    sum(payload.totals?.grandTotal), String(payload.balanceStatus || 'Pending'), JSON.stringify(payload), user];
};

router.post('/next-number', async (_req, res) => {
  const year = new Date().getFullYear();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('quotation-sequence:' || $1))", [String(year)]);
    const stored = await client.query('SELECT last_number FROM quotation_sequences WHERE sequence_year=$1 FOR UPDATE', [year]);
    const pattern = `QT${year}%`;
    const existing = await client.query(
      `SELECT COALESCE(max(substring(quotation_number from 7)::bigint),0) AS maximum
       FROM quotations WHERE quotation_number LIKE $1 AND quotation_number ~ $2`,
      [pattern, `^QT${year}[0-9]+$`]
    );
    const next = Math.max(Number(stored.rows[0]?.last_number || 0), Number(existing.rows[0]?.maximum || 0)) + 1;
    await client.query(
      `INSERT INTO quotation_sequences (sequence_year,last_number,updated_at) VALUES ($1,$2,now())
       ON CONFLICT (sequence_year) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`, [year, next]
    );
    await client.query('COMMIT');
    res.json({ quotationNumber: `QT${year}${String(next).padStart(2, '0')}` });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

router.get('/', async (_req, res) => {
  const result = await getPool().query('SELECT * FROM quotations WHERE deleted_at IS NULL ORDER BY quotation_date DESC, quotation_number DESC');
  res.json({ records: result.rows.map(makeHistory) });
});
// Read-only comparison; migration is never automatic and only Admin can see
// legacy customer data in this preview.
router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const pool = getPool();
  const [legacy, current] = await Promise.all([
    pool.query("SELECT data FROM erp_state WHERE storage_key='quotationHistory'"),
    pool.query('SELECT quotation_number,payload,deleted_at FROM quotations')
  ]);
  const old = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byNumber = new Map(current.rows.map((row) => [row.quotation_number, row]));
  const eligible = [];
  const existing = [];
  const conflicts = [];
  const deleted = [];
  const seen = new Set();
  for (const entry of old) {
    const payload = entry?.payload;
    const number = String(payload?.quotationDetails?.quotationNumber || entry?.reference || '').trim();
    if (!number || seen.has(number)) { if (number) conflicts.push({ quotationNumber: number, reason: 'Duplicate legacy ID' }); continue; }
    seen.add(number);
    const row = byNumber.get(number);
    if (row?.deleted_at) deleted.push({ quotationNumber: number });
    else if (row) {
      const server = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      (JSON.stringify(server) === JSON.stringify(payload) ? existing : conflicts).push({ quotationNumber: number });
    } else {
      try { validRecord(payload); eligible.push({ quotationNumber: number, payload }); }
      catch (error) { conflicts.push({ quotationNumber: number, reason: error.message }); }
    }
  }
  res.json({ eligible, existing, conflicts, deleted, counts: { eligible: eligible.length, existing: existing.length, conflicts: conflicts.length, deleted: deleted.length } });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) throw badRequest('Select between 1 and 1000 previewed quotations to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const imported = [];
    const conflicts = [];
    for (const payload of records) {
      const number = validRecord(payload);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('quotation:' || $1))", [number]);
      const current = await client.query('SELECT quotation_number,deleted_at FROM quotations WHERE quotation_number=$1 FOR UPDATE', [number]);
      if (current.rowCount) { conflicts.push({ quotationNumber: number, reason: current.rows[0].deleted_at ? 'Deleted record is protected' : 'Record already exists' }); continue; }
      const values = saveColumns(payload, req.user.email);
      const saved = await client.query(
        `INSERT INTO quotations (quotation_number,project_id,customer_name,company_name,quotation_date,currency,grand_total,balance_status,payload,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10) RETURNING *`,
        [number, ...values.slice(0, 8), req.user.email]
      );
      await insertItems(client, number, payload.items);
      await audit(client, req, { number, action: 'IMPORT', after: payload, reason: 'Admin-confirmed legacy quotation migration' });
      imported.push(number);
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

router.get('/:number', async (req, res) => {
  const result = await getPool().query('SELECT * FROM quotations WHERE quotation_number=$1 AND deleted_at IS NULL', [String(req.params.number || '')]);
  if (!result.rowCount) return res.status(404).json({ error: 'Quotation not found.' });
  res.json({ record: makeHistory(result.rows[0]) });
});

router.post('/', async (req, res) => {
  const payload = req.body?.data;
  const number = validRecord(payload);
  const token = String(req.body?.createToken || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw badRequest('A valid idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const priorToken = await client.query('SELECT * FROM quotations WHERE create_token=$1 FOR UPDATE', [token]);
    if (priorToken.rowCount) { await client.query('COMMIT'); return res.json({ record: makeHistory(priorToken.rows[0]), duplicate: true }); }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('quotation:' || $1))", [number]);
    const exists = await client.query('SELECT * FROM quotations WHERE quotation_number=$1 FOR UPDATE', [number]);
    if (exists.rowCount) throw conflict(exists.rows[0].deleted_at ? 'This quotation number belongs to a deleted record and cannot be reused.' : 'This quotation number already exists.', makeHistory(exists.rows[0]));
    const [project, customer, company, date, currency, total, status, json, email] = saveColumns(payload, req.user.email);
    const result = await client.query(
      `INSERT INTO quotations (quotation_number,project_id,customer_name,company_name,quotation_date,currency,grand_total,balance_status,payload,create_token,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$11) RETURNING *`,
      [number, project, customer, company, date, currency, total, status, json, token, email]
    );
    await insertItems(client, number, payload.items);
    await audit(client, req, { number, action: 'CREATE', after: payload });
    await client.query('COMMIT');
    res.status(201).json({ record: makeHistory(result.rows[0]), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

router.put('/:number', requireAdmin, async (req, res) => {
  const number = String(req.params.number || '');
  const payload = req.body?.data;
  if (validRecord(payload) !== number) throw badRequest('Quotation number cannot be changed during edit.');
  const version = versionOf(req.body?.version);
  if (!version) throw badRequest('The version last read from PostgreSQL is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM quotations WHERE quotation_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Quotation not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Quotation changed on the server. Reload it before editing.', makeHistory(current.rows[0]));
    const [project, customer, company, date, currency, total, status, json] = saveColumns(payload, req.user.email);
    const result = await client.query(
      `UPDATE quotations SET project_id=$2,customer_name=$3,company_name=$4,quotation_date=$5,currency=$6,grand_total=$7,balance_status=$8,payload=$9::jsonb,version=version+1,updated_by=$10,updated_at=now()
       WHERE quotation_number=$1 AND version=$11 RETURNING *`,
      [number, project, customer, company, date, currency, total, status, json, req.user.email, version]
    );
    await client.query('DELETE FROM quotation_items WHERE quotation_number=$1', [number]);
    await insertItems(client, number, payload.items);
    await audit(client, req, { number, action: 'UPDATE', before: current.rows[0].payload, after: payload });
    await client.query('COMMIT');
    res.json({ record: makeHistory(result.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

router.post('/:number/mark-invoiced', async (req, res) => {
  const number = String(req.params.number || '');
  const version = versionOf(req.body?.version);
  const invoiceNumber = String(req.body?.invoiceNumber || '').trim();
  if (!version || !/^[A-Za-z0-9._/-]{1,80}$/.test(invoiceNumber)) throw badRequest('A current quotation version and valid invoice number are required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM quotations WHERE quotation_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Quotation not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Quotation changed on the server. Reload before marking invoiced.', makeHistory(current.rows[0]));
    const before = current.rows[0].payload;
    const payload = { ...before, balanceStatus: `Invoiced (${invoiceNumber})` };
    const result = await client.query(
      `UPDATE quotations SET balance_status=$2,payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now()
       WHERE quotation_number=$1 AND version=$5 RETURNING *`,
      [number, payload.balanceStatus, JSON.stringify(payload), req.user.email, version]
    );
    await audit(client, req, { number, action: 'MARK_INVOICED', before, after: payload, reason: invoiceNumber });
    await client.query('COMMIT');
    res.json({ record: makeHistory(result.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

router.delete('/:number', requireAdmin, async (req, res) => {
  const number = String(req.params.number || '');
  const version = versionOf(req.body?.version);
  if (!version) throw badRequest('The version last read from PostgreSQL is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM quotations WHERE quotation_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Quotation not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Quotation changed on the server. Reload before deleting.', makeHistory(current.rows[0]));
    const reason = String(req.body?.reason || '').trim();
    const result = await client.query(
      `UPDATE quotations SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE quotation_number=$1 RETURNING *`,
      [number, req.user.email, reason]
    );
    await audit(client, req, { number, action: 'SOFT_DELETE', before: current.rows[0].payload, reason });
    await client.query('COMMIT');
    res.json({ deleted: number, version: Number(result.rows[0].version) });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

export default router;
