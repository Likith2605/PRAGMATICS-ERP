import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const roundMoney = (value) => Math.round((numeric(value) + Number.EPSILON) * 10000) / 10000;
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const safeToken = (value) => /^[A-Za-z0-9._:-]{8,200}$/.test(String(value || ''));

const TYPES = Object.freeze({
  customer: {
    table: 'customer_advances',
    adjustments: 'customer_advance_adjustments',
    audit: 'customer_advance_audit',
    invoiceTable: 'customer_invoices',
    invoiceAudit: 'customer_invoice_audit',
    legacyKey: 'customerAdvanceHistory',
    partyColumn: 'customer_name',
    masterTable: 'customers',
    masterName: 'company_name',
    masterId: 'customer_id',
    invoicePermission: 'invoice.view',
    prefix: 'CAR'
  },
  supplier: {
    table: 'supplier_advances',
    adjustments: 'supplier_advance_adjustments',
    audit: 'supplier_advance_audit',
    invoiceTable: 'supplier_invoices',
    invoiceAudit: 'supplier_invoice_audit',
    legacyKey: 'supplierAdvanceHistory',
    partyColumn: 'vendor_name',
    masterTable: 'vendors',
    masterName: 'name',
    masterId: 'vendor_id',
    invoicePermission: 'purchase.supplier_invoice',
    prefix: 'SAP'
  }
});

const typeConfig = (raw) => {
  const config = TYPES[String(raw || '').toLowerCase()];
  if (!config) throw bad('Advance type must be customer or supplier.');
  return config;
};
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.roleKey === 'administrator' || req.user?.role === 'Administrator';
const authorize = (req, config) => {
  if (isAdmin(req) || hasPermissionForRole(req.user?.roleKey, config.invoicePermission, req.user?.rolePermissions)) return;
  throw Object.assign(new Error('Your selected department role does not allow this advance operation.'), { status: 403 });
};
const recordView = (row) => ({
  advanceNumber: row.advance_number,
  date: dateValue(row.advance_date),
  party: row.customer_name || row.vendor_name,
  partyId: row.customer_id || row.vendor_id || '',
  amount: numeric(row.amount),
  currency: row.currency,
  exchangeRateToINR: numeric(row.exchange_rate_to_inr),
  amountINR: numeric(row.amount_inr),
  mode: row.payment_mode,
  reference: row.payment_reference,
  againstRef: row.against_reference,
  remarks: row.remarks,
  appliedAmount: numeric(row.applied_amount),
  appliedAmountINR: numeric(row.applied_amount_inr),
  balanceAmount: roundMoney(numeric(row.amount) - numeric(row.applied_amount)),
  balanceAmountINR: roundMoney(numeric(row.amount_inr) - numeric(row.applied_amount_inr)),
  version: Number(row.version),
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: row.created_at?.toISOString?.() || row.created_at,
  updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  deletedAt: row.deleted_at?.toISOString?.() || row.deleted_at || null,
  deleteReason: row.delete_reason || ''
});
const listQuery = (config) => `
  SELECT a.*,
    COALESCE(x.applied_amount, 0) AS applied_amount,
    COALESCE(x.applied_amount_inr, 0) AS applied_amount_inr
  FROM ${config.table} a
  LEFT JOIN (
    SELECT advance_number, SUM(amount) AS applied_amount, SUM(amount_inr) AS applied_amount_inr
    FROM ${config.adjustments}
    WHERE voided_at IS NULL
    GROUP BY advance_number
  ) x ON x.advance_number = a.advance_number
`;
const loadLegacyRows = async (executor, config, lock = false) => {
  const result = await executor.query(
    `SELECT data FROM erp_state WHERE storage_key=$1${lock ? ' FOR SHARE' : ''}`,
    [config.legacyKey]
  );
  return Array.isArray(result.rows[0]?.data) ? result.rows[0].data : [];
};
const validateLegacy = (record) => {
  const number = String(record?.advanceNumber || '').trim();
  const party = String(record?.party || '').trim();
  const amount = numeric(record?.amount);
  const currency = String(record?.currency || 'INR').trim().toUpperCase();
  const rate = numeric(record?.exchangeRateToINR ?? record?.exchangeRate ?? 1);
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(number)) throw bad('Advance number is missing or invalid.');
  if (!party) throw bad('Party name is required.');
  if (!isDate(record?.date)) throw bad('Advance date must use YYYY-MM-DD format.');
  if (!(amount > 0) || !/^[A-Z]{3}$/.test(currency) || !(rate > 0)) throw bad('Advance amount or currency details are invalid.');
  return { number, party, amount: roundMoney(amount), currency, rate };
};
const validateInput = (input) => {
  const party = String(input?.party || '').trim();
  const date = String(input?.date || '').trim();
  const amount = numeric(input?.amount);
  const currency = String(input?.currency || 'INR').trim().toUpperCase();
  const rate = numeric(input?.exchangeRateToINR ?? (currency === 'INR' ? 1 : 0));
  if (!party) throw bad('Party name is required.');
  if (!isDate(date)) throw bad('Advance date must use YYYY-MM-DD format.');
  if (!(amount > 0) || !/^[A-Z]{3}$/.test(currency)) throw bad('A valid advance amount and ISO currency code are required.');
  if (!(rate > 0)) throw bad('A positive INR exchange rate is required.');
  if (currency === 'INR' && rate !== 1) throw bad('INR advances must use an exchange rate of 1.');
  const roundedAmount = roundMoney(amount);
  const amountINR = roundMoney(roundedAmount * rate);
  if (!(roundedAmount > 0) || !(amountINR > 0)) throw bad('Advance amount must be positive at the supported precision.');
  return {
    party, date, amount: roundedAmount, currency, rate,
    amountINR,
    mode: String(input?.mode || '').trim().slice(0, 100),
    reference: String(input?.reference || '').trim().slice(0, 120),
    againstRef: String(input?.againstRef || '').trim().slice(0, 120),
    remarks: String(input?.remarks || '').trim().slice(0, 2000)
  };
};
const auditAdvance = (client, req, config, number, action, before, after, reason = '') => client.query(
  `INSERT INTO ${config.audit}(advance_number,user_id,email,role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [number, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const findMaster = async (client, config, name) => {
  const result = await client.query(
    `SELECT id FROM ${config.masterTable} WHERE lower(${config.masterName})=lower($1) AND deleted_at IS NULL ORDER BY id LIMIT 2`,
    [name]
  );
  if (result.rowCount > 1) throw conflict(`More than one active master record matches ${name}. Resolve the duplicate master records before saving this advance.`);
  return result.rows[0]?.id || null;
};
const reserveAdvanceNumber = async (client, config, kind, date) => {
  const yearSuffix = Number(String(date).slice(2, 4));
  const result = await client.query(
    `INSERT INTO advance_sequences(advance_type,year_suffix,last_number)
     VALUES($1,$2,1)
     ON CONFLICT(advance_type,year_suffix)
     DO UPDATE SET last_number=advance_sequences.last_number+1
     RETURNING last_number`,
    [kind, yearSuffix]
  );
  return `${config.prefix}-${String(yearSuffix).padStart(2, '0')}${String(result.rows[0].last_number).padStart(4, '0')}`;
};
const dateValue = (value) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10);
const matchesCreateIntent = (row, config, values) =>
  String(row[config.partyColumn]).trim().toLowerCase() === values.party.trim().toLowerCase() &&
  dateValue(row.advance_date) === values.date &&
  numeric(row.amount) === values.amount &&
  String(row.currency).toUpperCase() === values.currency &&
  numeric(row.exchange_rate_to_inr) === values.rate &&
  String(row.payment_mode || '') === values.mode &&
  String(row.payment_reference || '') === values.reference &&
  String(row.against_reference || '') === values.againstRef &&
  String(row.remarks || '') === values.remarks;
const advanceSummary = async (executor, config, number) => {
  const result = await executor.query(
    `SELECT COALESCE(SUM(amount),0) AS applied_amount,COALESCE(SUM(amount_inr),0) AS applied_amount_inr
     FROM ${config.adjustments} WHERE advance_number=$1 AND voided_at IS NULL`,
    [number]
  );
  return result.rows[0];
};
const insertAdvance = async (client, req, config, kind, number, input, createToken, legacyPayload = null) => {
  const values = validateInput(input);
  const partyId = await findMaster(client, config, values.party);
  const result = await client.query(
    `INSERT INTO ${config.table}
      (advance_number,${config.partyColumn},${config.masterId},advance_date,amount,currency,exchange_rate_to_inr,amount_inr,
       payment_mode,payment_reference,against_reference,remarks,legacy_payload,create_token,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$15)
     RETURNING *`,
    [number, values.party, partyId, values.date, values.amount, values.currency, values.rate, values.amountINR,
      values.mode, values.reference, values.againstRef, values.remarks,
      legacyPayload == null ? null : JSON.stringify(legacyPayload), createToken, req.user.email]
  );
  const record = recordView({ ...result.rows[0], applied_amount: 0, applied_amount_inr: 0 });
  await auditAdvance(client, req, config, number, legacyPayload ? 'LEGACY_IMPORT' : 'CREATE', null, record,
    legacyPayload ? 'Explicit Admin import from migration preview' : '');
  return result.rows[0];
};
const readInvoiceValues = (config, row) => {
  if (config.invoiceTable === 'customer_invoices') {
    return {
      number: row.invoice_number,
      version: Number(row.version),
      party: row.customer_name,
      currency: row.currency || 'INR',
      total: numeric(row.grand_total),
      paid: numeric(row.amount_received),
      advanceAdjusted: numeric(row.advance_adjusted),
      advanceAdjustedINR: numeric(row.advance_adjusted_inr),
      totalINR: numeric(row.amount_inr),
      paidINR: numeric(row.received_inr)
    };
  }
  const record = row.payload || {};
  const payload = record.payload || {};
  const details = payload.invoiceDetails || {};
  const total = numeric(payload.totals?.grandTotal);
  const paid = numeric(details.amountPaid);
  return {
    number: row.invoice_number,
    version: Number(row.version),
    party: row.vendor_name,
    currency: String(payload.currency || details.currency || 'INR').toUpperCase(),
    total,
    paid,
    advanceAdjusted: numeric(row.advance_adjusted),
    advanceAdjustedINR: numeric(row.advance_adjusted_inr),
    totalINR: numeric(payload.amountINR ?? total),
    paidINR: numeric(payload.receivedINR ?? paid)
  };
};
const invoiceStatus = (total, paid, adjusted) => {
  const due = Math.max(0, roundMoney(total - paid - adjusted));
  return { due, status: due <= 0.00005 ? 'Paid' : paid + adjusted > 0 ? 'Partial' : 'Pending' };
};
const updateInvoiceBalance = async (client, req, config, row, adjustment, adjustmentINR, direction, reason) => {
  const before = readInvoiceValues(config, row);
  const afterAdjusted = roundMoney(before.advanceAdjusted + adjustment * direction);
  const afterAdjustedINR = roundMoney(before.advanceAdjustedINR + adjustmentINR * direction);
  if (afterAdjusted < -0.00005 || afterAdjustedINR < -0.00005) throw conflict('Invoice advance allocation is inconsistent; reload the invoice before changing it.');
  const { due, status } = invoiceStatus(before.total, before.paid, afterAdjusted);
  const dueINR = Math.max(0, roundMoney(before.totalINR - before.paidINR - afterAdjustedINR));
  let updatedRow;
  if (config.invoiceTable === 'customer_invoices') {
    const payload = {
      ...row.payload,
      invoiceDetails: {
        ...row.payload?.invoiceDetails,
        advanceAdjusted: afterAdjusted,
        advanceAdjustedINR: afterAdjustedINR,
        balanceDue: due,
        paymentStatus: status
      },
      advanceAdjustedINR: afterAdjustedINR,
      balanceINR: dueINR
    };
    const result = await client.query(
      `UPDATE customer_invoices
       SET advance_adjusted=$2,advance_adjusted_inr=$3,balance_due=$4,balance_inr=$5,payment_status=$6,
           payload=$7::jsonb,version=version+1,updated_at=now(),updated_by=$8
       WHERE invoice_number=$1 RETURNING *`,
      [row.invoice_number, afterAdjusted, afterAdjustedINR, due, dueINR, status, JSON.stringify(payload), req.user.email]
    );
    updatedRow = result.rows[0];
    await client.query(
      `INSERT INTO customer_invoice_audit(invoice_number,user_id,email,role,action,reason,before_values,after_values)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [row.invoice_number, req.user?.id || null, req.user.email, req.user.role || req.user.roleKey || '',
        direction > 0 ? 'ADVANCE_ADJUSTMENT' : 'ADVANCE_ADJUSTMENT_REVERSED', reason,
        JSON.stringify(safeAuditValues(row.payload)), JSON.stringify(safeAuditValues(payload))]
    );
  } else {
    const oldRecord = row.payload || {};
    const oldPayload = oldRecord.payload || {};
    const newPayload = {
      ...oldPayload,
      invoiceDetails: {
        ...oldPayload.invoiceDetails,
        advanceAdjusted: afterAdjusted,
        advanceAdjustedINR: afterAdjustedINR,
        balanceDue: due,
        paymentStatus: status
      },
      advanceAdjustedINR: afterAdjustedINR,
      balanceINR: dueINR
    };
    const updatedRecord = {
      ...oldRecord,
      status,
      advanceAdjusted: afterAdjusted,
      advanceAdjustedINR: afterAdjustedINR,
      balanceDue: `₹ ${due.toFixed(2)}`,
      payload: newPayload
    };
    const result = await client.query(
      `UPDATE supplier_invoices
       SET advance_adjusted=$2,advance_adjusted_inr=$3,status=$4,payload=$5::jsonb,
           version=version+1,updated_at=now(),updated_by=$6
       WHERE invoice_number=$1 RETURNING *`,
      [row.invoice_number, afterAdjusted, afterAdjustedINR, status, JSON.stringify(updatedRecord), req.user.email]
    );
    updatedRow = result.rows[0];
    await client.query(
      `INSERT INTO supplier_invoice_audit(invoice_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [row.invoice_number, req.user?.id || null, req.user.email, req.user.role || req.user.roleKey || '',
        direction > 0 ? 'ADVANCE_ADJUSTMENT' : 'ADVANCE_ADJUSTMENT_REVERSED', reason,
        JSON.stringify(safeAuditValues(oldRecord)), JSON.stringify(safeAuditValues(updatedRecord))]
    );
  }
  return {
    before,
    after: {
      ...readInvoiceValues(config, updatedRow),
      due,
      dueINR,
      status
    }
  };
};
const adjustmentView = (row) => ({
  id: row.adjustment_id,
  advanceNumber: row.advance_number,
  invoiceNumber: row.invoice_number,
  amount: numeric(row.amount),
  amountINR: numeric(row.amount_inr),
  currency: row.currency,
  createdBy: row.created_by,
  createdAt: row.created_at?.toISOString?.() || row.created_at,
  voidedAt: row.voided_at?.toISOString?.() || row.voided_at || null,
  voidedBy: row.voided_by || null,
  voidReason: row.void_reason || ''
});

router.get('/:kind/migration-preview', requireAdmin, async (req, res) => {
  const config = typeConfig(req.params.kind);
  const legacyRows = await loadLegacyRows(getPool(), config);
  const current = await getPool().query(`SELECT advance_number,legacy_payload FROM ${config.table}`);
  const byId = new Map(current.rows.map((row) => [row.advance_number.toLowerCase(), row]));
  const preview = { eligible: [], existing: [], conflicts: [] };
  const seen = new Set();
  for (const payload of legacyRows) {
    let normalized;
    try { normalized = validateLegacy(payload); }
    catch (error) { preview.conflicts.push({ number: payload?.advanceNumber || '', reason: error.message }); continue; }
    const key = normalized.number.toLowerCase();
    if (seen.has(key)) { preview.conflicts.push({ number: normalized.number, reason: 'Duplicate advance number in the legacy snapshot.' }); continue; }
    seen.add(key);
    const existing = byId.get(key);
    if (!existing) preview.eligible.push({ number: normalized.number, payload });
    else if (JSON.stringify(existing.legacy_payload) === JSON.stringify(payload)) preview.existing.push({ number: normalized.number });
    else preview.conflicts.push({ number: normalized.number, reason: 'A PostgreSQL advance already uses this number.' });
  }
  res.json({ ...preview, counts: Object.fromEntries(Object.entries(preview).map(([key, rows]) => [key, rows.length])) });
});

router.post('/:kind/migration-preview/import', requireAdmin, async (req, res) => {
  const config = typeConfig(req.params.kind);
  const requested = req.body?.numbers;
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000) throw bad('Select between 1 and 1000 advances to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const source = await loadLegacyRows(client, config, true);
    const selected = new Set(requested.map((value) => String(value)));
    const byNumber = new Map(source.map((row) => [String(row?.advanceNumber || ''), row]));
    const imported = [];
    const conflicts = [];
    for (const number of selected) {
      const payload = byNumber.get(number);
      if (!payload) { conflicts.push({ number, reason: 'Advance is no longer present in the preserved legacy snapshot.' }); continue; }
      let normalized;
      try { normalized = validateLegacy(payload); }
      catch (error) { conflicts.push({ number, reason: error.message }); continue; }
      const found = await client.query(`SELECT advance_number FROM ${config.table} WHERE lower(advance_number)=lower($1) FOR UPDATE`, [number]);
      if (found.rowCount) { conflicts.push({ number, reason: 'A PostgreSQL advance already uses this number.' }); continue; }
      const token = `legacy-advance-${createHash('sha256').update(`${req.params.kind}:${number}`).digest('hex')}`;
      const suffix = normalized.number.match(/^[A-Z]+-\d{2}(\d+)$/i);
      if (suffix) {
        await client.query(
          `INSERT INTO advance_sequences(advance_type,year_suffix,last_number) VALUES($1,$2,$3)
           ON CONFLICT(advance_type,year_suffix) DO UPDATE SET last_number=GREATEST(advance_sequences.last_number,EXCLUDED.last_number)`,
          [req.params.kind, Number(normalized.number.slice(normalized.number.indexOf('-') + 1, normalized.number.indexOf('-') + 3)), Number(suffix[1])]
        );
      }
      await insertAdvance(client, req, config, req.params.kind, normalized.number, {
        party: normalized.party,
        date: payload.date,
        amount: normalized.amount,
        currency: normalized.currency,
        exchangeRateToINR: normalized.rate,
        mode: payload.mode,
        reference: payload.reference,
        againstRef: payload.againstRef,
        remarks: payload.remarks
      }, token, payload);
      imported.push(number);
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.get('/:kind', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const result = await getPool().query(`${listQuery(config)} WHERE a.deleted_at IS NULL ORDER BY a.advance_date DESC,a.advance_number DESC`);
  res.json({ records: result.rows.map(recordView) });
});

router.post('/:kind', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const values = validateInput(req.body?.data);
  const token = String(req.body?.createToken || '');
  if (!safeToken(token)) throw bad('A valid advance idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('advance-create:' || $1))", [token]);
    const retry = await client.query(`SELECT * FROM ${config.table} WHERE create_token=$1 FOR UPDATE`, [token]);
    if (retry.rowCount) {
      if (!matchesCreateIntent(retry.rows[0], config, values)) {
        throw conflict('This idempotency token was already used for a different advance.');
      }
      const summary = await advanceSummary(client, config, retry.rows[0].advance_number);
      await client.query('COMMIT');
      return res.json({ record: recordView({ ...retry.rows[0], ...summary }), duplicate: true });
    }
    const number = await reserveAdvanceNumber(client, config, req.params.kind, values.date);
    const row = await insertAdvance(client, req, config, req.params.kind, number, req.body.data, token);
    await client.query('COMMIT');
    res.status(201).json({ record: recordView({ ...row, applied_amount: 0, applied_amount_inr: 0 }), duplicate: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.put('/:kind/:number', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const expected = Number(req.body?.version);
  if (!Number.isInteger(expected) || expected < 1) throw bad('The current PostgreSQL advance version is required.');
  const values = validateInput(req.body?.data);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT * FROM ${config.table} WHERE advance_number=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.number]);
    if (!result.rowCount) throw Object.assign(new Error('Advance not found.'), { status: 404 });
    const old = result.rows[0];
    if (Number(old.version) !== expected) throw conflict('Advance changed in PostgreSQL. Reload before editing.', recordView(old));
    const applied = await advanceSummary(client, config, req.params.number);
    if (numeric(applied.applied_amount) > 0 &&
      (values.party.toLowerCase() !== String(old[config.partyColumn]).toLowerCase() ||
       values.currency !== old.currency || values.amount < numeric(applied.applied_amount) ||
       values.rate !== numeric(old.exchange_rate_to_inr))) {
      throw conflict('Party, currency and exchange rate cannot change; the amount cannot be reduced below its applied balance.');
    }
    const partyId = await findMaster(client, config, values.party);
    const updated = await client.query(
      `UPDATE ${config.table} SET ${config.partyColumn}=$2,${config.masterId}=$3,advance_date=$4,amount=$5,currency=$6,
       exchange_rate_to_inr=$7,amount_inr=$8,payment_mode=$9,payment_reference=$10,against_reference=$11,remarks=$12,
       version=version+1,updated_at=now(),updated_by=$13 WHERE advance_number=$1 RETURNING *`,
      [req.params.number, values.party, partyId, values.date, values.amount, values.currency, values.rate, values.amountINR,
        values.mode, values.reference, values.againstRef, values.remarks, req.user.email]
    );
    const view = recordView({ ...updated.rows[0], ...applied });
    await auditAdvance(client, req, config, req.params.number, 'UPDATE', recordView(old), view);
    await client.query('COMMIT');
    res.json({ record: view });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.delete('/:kind/:number', requireAdmin, async (req, res) => {
  const config = typeConfig(req.params.kind);
  const expected = Number(req.body?.version);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(expected) || expected < 1 || !reason) throw bad('Admin deletion requires the current version and a reason.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT * FROM ${config.table} WHERE advance_number=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.number]);
    if (!result.rowCount) throw Object.assign(new Error('Advance not found.'), { status: 404 });
    const old = result.rows[0];
    if (Number(old.version) !== expected) throw conflict('Advance changed in PostgreSQL. Reload before deleting.', recordView(old));
    const applied = await client.query(`SELECT 1 FROM ${config.adjustments} WHERE advance_number=$1 AND voided_at IS NULL LIMIT 1`, [req.params.number]);
    if (applied.rowCount) throw conflict('An advance with active invoice adjustments cannot be deleted. Reverse the adjustments first.');
    await client.query(
      `UPDATE ${config.table} SET deleted_at=now(),deleted_by=$2,delete_reason=$3,updated_at=now(),updated_by=$2,version=version+1 WHERE advance_number=$1`,
      [req.params.number, req.user.email, reason]
    );
    await auditAdvance(client, req, config, req.params.number, 'SOFT_DELETE', recordView(old), null, reason);
    await client.query('COMMIT');
    res.json({ deleted: req.params.number });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.get('/:kind/:number/adjustments', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const result = await getPool().query(
    `SELECT * FROM ${config.adjustments} WHERE advance_number=$1 ORDER BY created_at DESC,adjustment_id`,
    [req.params.number]
  );
  res.json({ adjustments: result.rows.map(adjustmentView) });
});

router.get('/:kind/:number/audit', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const result = await getPool().query(
    `SELECT action,reason,email,role,created_at,before_values,after_values
     FROM ${config.audit} WHERE advance_number=$1 ORDER BY created_at DESC,id DESC`,
    [req.params.number]
  );
  res.json({ events: result.rows.map((row) => ({
    action: row.action,
    reason: row.reason,
    actor: row.email,
    role: row.role,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    before: row.before_values,
    after: row.after_values
  })) });
});

router.post('/:kind/:number/adjustments', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const invoiceNumber = String(req.body?.invoiceNumber || '').trim();
  const amount = roundMoney(req.body?.amount);
  const advanceVersion = Number(req.body?.version);
  const invoiceVersion = Number(req.body?.invoiceVersion);
  const token = String(req.body?.idempotencyToken || '');
  if (!invoiceNumber || !(amount > 0) || !Number.isInteger(advanceVersion) || advanceVersion < 1 ||
      !Number.isInteger(invoiceVersion) || invoiceVersion < 1 || !safeToken(token)) {
    throw bad('Invoice, positive adjustment amount, current record versions and an idempotency token are required.');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('advance-adjustment:' || $1))", [token]);
    const duplicate = await client.query(`SELECT * FROM ${config.adjustments} WHERE idempotency_token=$1`, [token]);
    if (duplicate.rowCount) {
      if (duplicate.rows[0].advance_number !== req.params.number) throw conflict('This idempotency token belongs to a different advance adjustment.');
      await client.query('COMMIT');
      return res.json({ adjustment: adjustmentView(duplicate.rows[0]), duplicate: true });
    }
    const advanceResult = await client.query(`SELECT * FROM ${config.table} WHERE advance_number=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.number]);
    if (!advanceResult.rowCount) throw Object.assign(new Error('Advance not found.'), { status: 404 });
    const advance = advanceResult.rows[0];
    if (Number(advance.version) !== advanceVersion) throw conflict('Advance changed in PostgreSQL. Reload before adjusting it.', recordView(advance));
    const invoiceResult = await client.query(`SELECT * FROM ${config.invoiceTable} WHERE invoice_number=$1 AND deleted_at IS NULL FOR UPDATE`, [invoiceNumber]);
    if (!invoiceResult.rowCount) throw conflict(`Invoice ${invoiceNumber} is not available in PostgreSQL.`);
    const invoice = invoiceResult.rows[0];
    const invoiceData = readInvoiceValues(config, invoice);
    if (invoiceData.version !== invoiceVersion) throw conflict('Invoice changed in PostgreSQL. Reload before adjusting the advance.');
    if (String(advance[config.partyColumn]).trim().toLowerCase() !== String(invoiceData.party).trim().toLowerCase()) {
      throw conflict('Advance party does not match the selected invoice party.');
    }
    if (String(advance.currency).toUpperCase() !== String(invoiceData.currency).toUpperCase()) {
      throw conflict(`Advance currency ${advance.currency} does not match invoice currency ${invoiceData.currency}.`);
    }
    const [advanceApplied, invoiceAvailable] = await Promise.all([
      client.query(`SELECT COALESCE(SUM(amount),0) AS amount,COALESCE(SUM(amount_inr),0) AS amount_inr FROM ${config.adjustments} WHERE advance_number=$1 AND voided_at IS NULL`, [req.params.number]),
      client.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM ${config.adjustments} WHERE invoice_number=$1 AND voided_at IS NULL`, [invoiceNumber])
    ]);
    const remaining = numeric(advance.amount) - numeric(advanceApplied.rows[0].amount);
    const invoiceDue = numeric(invoiceData.total) - numeric(invoiceData.paid) - numeric(invoiceAvailable.rows[0].amount);
    if (amount > remaining + 0.00005) throw conflict('Adjustment exceeds the unallocated advance balance.');
    if (amount > invoiceDue + 0.00005) throw conflict('Adjustment exceeds the invoice outstanding balance.');
    const amountINR = roundMoney(amount * numeric(advance.exchange_rate_to_inr));
    const adjustmentId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO ${config.adjustments}(adjustment_id,advance_number,invoice_number,amount,amount_inr,currency,idempotency_token,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [adjustmentId, req.params.number, invoiceNumber, amount, amountINR, advance.currency, token, req.user.email]
    );
    const nextAdvance = await client.query(
      `UPDATE ${config.table} SET version=version+1,updated_at=now(),updated_by=$2 WHERE advance_number=$1 RETURNING *`,
      [req.params.number, req.user.email]
    );
    const invoiceChange = await updateInvoiceBalance(client, req, config, invoice, amount, amountINR, 1, 'Advance adjusted against invoice');
    const beforeAdvance = recordView({ ...advance, applied_amount: advanceApplied.rows[0].amount, applied_amount_inr: advanceApplied.rows[0].amount_inr });
    const advanceRecord = recordView({ ...nextAdvance.rows[0], applied_amount: numeric(advanceApplied.rows[0].amount) + amount, applied_amount_inr: numeric(advanceApplied.rows[0].amount_inr) + amountINR });
    await auditAdvance(client, req, config, req.params.number, 'ADJUST', beforeAdvance, advanceRecord, `Applied ${amount} ${advance.currency} to invoice ${invoiceNumber}`);
    await client.query('COMMIT');
    res.status(201).json({ adjustment: adjustmentView(inserted.rows[0]), advance: advanceRecord, invoice: invoiceChange.after, duplicate: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

router.delete('/:kind/:number/adjustments/:adjustmentId', async (req, res) => {
  const config = typeConfig(req.params.kind);
  authorize(req, config);
  const version = Number(req.body?.version);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(version) || version < 1 || !reason) throw bad('Current advance version and a reversal reason are required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const advanceResult = await client.query(`SELECT * FROM ${config.table} WHERE advance_number=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.number]);
    if (!advanceResult.rowCount) throw Object.assign(new Error('Advance not found.'), { status: 404 });
    const advance = advanceResult.rows[0];
    if (Number(advance.version) !== version) throw conflict('Advance changed in PostgreSQL. Reload before reversing the adjustment.', recordView(advance));
    const adjustmentResult = await client.query(
      `SELECT * FROM ${config.adjustments} WHERE adjustment_id=$1 AND advance_number=$2 FOR UPDATE`,
      [req.params.adjustmentId, req.params.number]
    );
    if (!adjustmentResult.rowCount || adjustmentResult.rows[0].voided_at) throw Object.assign(new Error('Active advance adjustment not found.'), { status: 404 });
    const adjustment = adjustmentResult.rows[0];
    const invoiceResult = await client.query(`SELECT * FROM ${config.invoiceTable} WHERE invoice_number=$1 FOR UPDATE`, [adjustment.invoice_number]);
    if (!invoiceResult.rowCount) throw conflict('The linked invoice no longer exists; adjustment reversal was not applied.');
    await client.query(
      `UPDATE ${config.adjustments} SET voided_at=now(),voided_by=$2,void_reason=$3 WHERE adjustment_id=$1`,
      [adjustment.adjustment_id, req.user.email, reason]
    );
    await client.query(
      `UPDATE ${config.table} SET version=version+1,updated_at=now(),updated_by=$2 WHERE advance_number=$1`,
      [req.params.number, req.user.email]
    );
    const invoiceChange = await updateInvoiceBalance(client, req, config, invoiceResult.rows[0], numeric(adjustment.amount), numeric(adjustment.amount_inr), -1, reason);
    const active = await client.query(`SELECT COALESCE(SUM(amount),0) AS amount,COALESCE(SUM(amount_inr),0) AS amount_inr FROM ${config.adjustments} WHERE advance_number=$1 AND voided_at IS NULL`, [req.params.number]);
    const latestAdvance = await client.query(`SELECT * FROM ${config.table} WHERE advance_number=$1`, [req.params.number]);
    const advanceRecord = recordView({ ...latestAdvance.rows[0], applied_amount: active.rows[0].amount, applied_amount_inr: active.rows[0].amount_inr });
    await auditAdvance(client, req, config, req.params.number, 'ADJUSTMENT_REVERSED', recordView({ ...advance, applied_amount: numeric(active.rows[0].amount) + numeric(adjustment.amount), applied_amount_inr: numeric(active.rows[0].amount_inr) + numeric(adjustment.amount_inr) }), advanceRecord, reason);
    await client.query('COMMIT');
    res.json({ reversed: adjustment.adjustment_id, advance: advanceRecord, invoice: invoiceChange.after });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

export default router;
