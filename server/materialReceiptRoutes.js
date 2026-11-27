import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from './database.js';
import { hasPermissionForRole } from './departmentAccess.js';
import { safeAuditValues } from './auth.js';
import { reconcilePurchaseOrderProgress } from './purchaseOrderReconciliation.js';
import { postStockMovement } from './stockLedger.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const forbidden = () => Object.assign(new Error('Your selected department role does not allow this operation.'), { status: 403 });
const admin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const authorize = (req, permission) => { if (!admin(req) && !hasPermissionForRole(req.user?.roleKey, [permission], req.user?.rolePermissions)) throw forbidden(); };
const authorizeAny = (req, permissions) => { if (!admin(req) && !hasPermissionForRole(req.user?.roleKey, permissions, req.user?.rolePermissions)) throw forbidden(); };
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const view = (row) => ({ ...row.payload, version: Number(row.version), recordVersion: Number(row.version), updatedAt: row.updated_at?.toISOString?.() || row.payload.updatedAt });
const comparable = (record) => {
  if (!record || typeof record !== 'object') return record;
  const copy = { ...record };
  delete copy.version; delete copy.recordVersion;
  return copy;
};
/**
 * Content signature of a receipt inspection. An idempotent retry may only be
 * answered with `duplicate` when the incoming payload is byte-for-byte the
 * business content that is already stored; a changed payload arriving with a
 * stale version must fall through to the optimistic-concurrency conflict.
 */
const inspectionSignature = (value) => {
  if (!value || typeof value !== 'object') return '';
  const copy = { ...value };
  delete copy.version; delete copy.recordVersion; delete copy.updatedAt;
  return canonical(comparable(copy));
};
const addHistory = (record, action, details, req) => ({
  ...record,
  history: [...(record.history || []), { action, details, at: new Date().toISOString(), by: req.user?.name || req.user?.email || 'ERP user' }],
  updatedAt: new Date().toISOString()
});
const audit = (client, req, id, action, before, after, reason = '') => client.query(
  `INSERT INTO material_receipt_audit(receipt_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [id, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const persistReceiptItems = async (client, receiptNumber, items) => {
  await client.query('DELETE FROM material_receipt_items WHERE receipt_number=$1', [receiptNumber]);
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO material_receipt_items(receipt_number,line_number,material_code,material_name,unit,ordered_qty,received_qty,accepted_qty,rejected_qty,batch_number,internal_batch_id,lot_number,mfg_date,expiry_date,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [receiptNumber, index + 1, String(item.materialCode || item.itemCode || ''), String(item.materialName || item.itemName || ''), String(item.unit || 'Nos'), Number(item.orderedQty || 0), Number(item.receivedQty), Number(item.acceptedQty || 0), Number(item.rejectedQty || 0), String(item.batchNumber || ''), String(item.internalBatchId || ''), String(item.lotNumber || ''), String(item.mfgDate || ''), String(item.expiryDate || ''), JSON.stringify(item)]
    );
  }
};
const inspectionView = (row) => ({ ...row.payload, version: Number(row.version), recordVersion: Number(row.version), postedToInventory: Boolean(row.posted_at), postedAt: row.posted_at?.toISOString?.() || row.payload.postedAt || '', postedBy: row.posted_by || row.payload.postedBy || '', inventoryPostedQty: Number(row.posted_qty || 0) });
const inspectionAudit = (client, req, qc, receipt, action, before, after, reason = '') => client.query(
  `INSERT INTO material_receipt_inspection_audit(qc_number,receipt_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
  [qc, receipt, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
/**
 * Linked Quality Checks and Rejection Reports are authoritative per-record rows
 * in module_records. Preserved erp_state arrays are read-only migration sources:
 * they may satisfy a legacy validation read, but can never be written as the
 * live authority nor silently promoted into one.
 */
const readLinkedRecord = async (client, key, idField, id, column = 'record_id') => {
  const authoritative = await client.query(
    `SELECT record_id,data,version FROM module_records WHERE storage_key=$1 AND ${column}=$2 FOR UPDATE`, [key, id]
  );
  if (authoritative.rowCount) {
    const row = authoritative.rows[0];
    return { recordId: row.record_id, data: row.data, version: Number(row.version) };
  }
  const legacy = await client.query('SELECT data FROM erp_state WHERE storage_key=$1 FOR SHARE', [key]);
  const found = (Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [])
    .find((entry) => String(entry?.[idField]) === String(id));
  return found ? { recordId: String(id), data: found, version: 0, legacy: true } : null;
};
const writeLinkedRecord = async (client, req, key, recordId, version, before, after) => {
  if (!version) throw conflict(`${key} ${recordId} exists only in preserved legacy state; import it through Admin reconciliation before linking it to a PostgreSQL receipt.`);
  const saved = await client.query(
    'UPDATE module_records SET data=$1::jsonb,version=version+1,updated_at=now(),updated_by=$2 WHERE storage_key=$3 AND record_id=$4 AND version=$5 RETURNING version',
    [JSON.stringify(after), req.user?.email || 'System', key, recordId, version]
  );
  if (!saved.rowCount) throw conflict(`${key} ${recordId} changed on the server. Reload before retrying.`);
  return Number(saved.rows[0].version);
};
const auditLinkedRecord = (client, req, key, recordId, receipt, action, before, after) => {
  const values = [recordId, action, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '',
    '', before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))];
  if (key === 'qualityChecks') return inspectionAudit(client, req, recordId, receipt, action, before, after);
  return client.query(
    `INSERT INTO erp_audit_log(record_id,module,action,user_id,email,role,reason,before_values,after_values)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [recordId, key, action, ...values.slice(2)]
  );
};
const applyReplacementReceipt = async (client, req, record, previousItems = [], action = 'Replacement receipt received in Store') => {
  if (!record?.isReplacement || !record.rejectionNumber) return;
  const linked = await readLinkedRecord(client, 'rejectionReports', 'rejectionNumber', record.rejectionNumber);
  if (!linked || String(linked.data?.poNumber) !== String(record.poNumber)) throw conflict(`Replacement receipt no longer matches PostgreSQL Rejection Report ${record.rejectionNumber}.`);
  const before = linked.data;
  const report = { ...before };
  const key = (line) => lineKey(line);
  const oldByKey = new Map((previousItems || []).map((line) => [key(line), Number(line.receivedQty || 0)]));
  const newByKey = new Map((record.items || []).map((line) => [key(line), Number(line.receivedQty || 0)]));
  report.items = (report.items || []).map((line) => {
    const delta = (newByKey.get(key(line)) || 0) - (oldByKey.get(key(line)) || 0);
    if (!delta) return line;
    const replacementQty = Math.max(0, Number(line.replacementQty || 0) + delta);
    return { ...line, replacementQty, pendingReplacementQty: Math.max(0, Number(line.rejectedQty || 0) - replacementQty) };
  });
  report.replacementQty = report.items.reduce((sum, line) => sum + Number(line.replacementQty || 0), 0);
  report.pendingReplacementQty = report.items.reduce((sum, line) => sum + Math.max(0, Number(line.rejectedQty || 0) - Number(line.replacementQty || 0)), 0);
  report.replacementReceiptNumber = record.receiptNumber;
  report.replacementArrivedAt = new Date().toISOString();
  report.history = [...(report.history || []), { action, details: `${record.receiptNumber} | ${record.items?.length || 0} line(s)`, at: new Date().toISOString(), by: req.user?.name || req.user?.email || 'ERP user' }];
  await writeLinkedRecord(client, req, 'rejectionReports', linked.recordId, linked.version, before, report);
  await auditLinkedRecord(client, req, 'rejectionReports', linked.recordId, record.receiptNumber, 'REPLACEMENT_RECEIPT', before, report);
};
const ref = (value) => { const s = String(value || '').trim(); return ['', '-', '—'].includes(s) ? '' : s; };
const lineKey = (line) => String(line?.materialCode || line?.itemCode || line?.materialName || line?.itemName || '').trim().toLowerCase();
const validateReceipt = (record) => {
  const id = ref(record?.receiptNumber); const po = ref(record?.poNumber); const invoice = ref(record?.invoiceNumber);
  if (!record || typeof record !== 'object' || !id || !/^[A-Za-z0-9._/-]{1,100}$/.test(id)) throw bad('A valid receipt number is required.');
  if (!po || !invoice || !String(record.invoiceDate || '').trim()) throw bad('Purchase Order, supplier invoice number and invoice date are required.');
  if (!Array.isArray(record.items) || !record.items.length) throw bad('A Material Receipt must contain at least one material line.');
  if (record.items.some((line) => !lineKey(line) || !(Number(line.receivedQty) > 0) || !Number.isFinite(Number(line.receivedQty)))) throw bad('Each receipt line needs a material and a positive received quantity.');
  if (record.items.some((line) => Number(line.acceptedQty || 0) < 0 || Number(line.rejectedQty || 0) < 0 || Number(line.acceptedQty || 0) + Number(line.rejectedQty || 0) > Number(line.receivedQty))) throw bad('Accepted and rejected quantities cannot be negative or exceed the received quantity.');
  if (Buffer.byteLength(JSON.stringify(record)) > 8 * 1024 * 1024) throw Object.assign(new Error('Receipt exceeds the 8 MB limit.'), { status: 413 });
  return { id, po, invoice };
};
const getPurchaseOrder = async (client, poNumber) => {
  const db = await client.query('SELECT payload,status FROM purchase_orders WHERE po_number=$1 AND deleted_at IS NULL FOR UPDATE', [poNumber]);
  if (db.rowCount) return { record: db.rows[0].payload, status: db.rows[0].status, database: true };
  const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='supplierPOHistory' FOR SHARE");
  const list = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const po = list.find((item) => String(item?.reference || item?.payload?.poDetails?.poNumber || '') === poNumber);
  return po ? { record: po, status: po.status || po.payload?.poDetails?.poStatus, database: false } : null;
};
const receiptRows = async (client, poNumber, excludeId = '') => {
  const [db, legacy] = await Promise.all([
    client.query("SELECT receipt_number,payload FROM material_receipts WHERE po_number=$1 AND deleted_at IS NULL AND receipt_number<>$2", [poNumber, excludeId]),
    client.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts' FOR SHARE")
  ]);
  const normalizedIds = new Set(db.rows.map((row) => String(row.receipt_number)));
  const old = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data.filter((r) => String(r?.poNumber) === poNumber && String(r?.receiptNumber) !== excludeId && !normalizedIds.has(String(r?.receiptNumber))) : [];
  return [...db.rows.map((r) => r.payload), ...old];
};
const validateQuantities = async (client, poNumber, record, excludeId = '') => {
  const po = await getPurchaseOrder(client, poNumber);
  if (!po) throw conflict(`Purchase Order ${poNumber} is not present in PostgreSQL or the preserved legacy snapshot.`);
  if (String(po.status || '').toLowerCase() === 'cancelled') throw conflict(`Purchase Order ${poNumber} is cancelled.`);
  const poItems = po.record?.payload?.items || po.record?.items || [];
  if (!Array.isArray(poItems) || !poItems.length) throw conflict(`Purchase Order ${poNumber} has no readable material lines.`);
  const previous = await receiptRows(client, poNumber, excludeId);
  const totals = new Map();
  for (const receipt of previous) {
    if (receipt.isReplacement) continue;
    for (const line of receipt.items || []) totals.set(lineKey(line), (totals.get(lineKey(line)) || 0) + Number(line.receivedQty || 0));
  }
  const submitted = new Map();
  for (const line of record.items) {
    const key = lineKey(line);
    submitted.set(key, (submitted.get(key) || 0) + Number(line.receivedQty));
  }
  for (const [key, received] of submitted) {
    const line = record.items.find((item) => lineKey(item) === key);
    const ordered = poItems.find((item) => lineKey(item) === key);
    if (!ordered) throw conflict(`Material '${line.materialName || line.itemName || line.materialCode}' is not on PO ${poNumber}.`);
    const orderedQty = Number(ordered.quantity ?? ordered.orderedQty ?? ordered.qty ?? 0);
    const before = totals.get(key) || 0;
    if (record.isReplacement) {
      const linkedReport = await readLinkedRecord(client, 'rejectionReports', 'rejectionNumber', record.rejectionNumber);
      const report = linkedReport?.data;
      if (!report || String(report.poNumber) !== poNumber) throw conflict(`Replacement receipt must reference an open Rejection Report for PO ${poNumber}.`);
      const rejectedLine = (report.items || []).find((entry) => lineKey(entry) === key);
      if (!rejectedLine) throw conflict(`Replacement material ${line.materialName || line.materialCode} is not part of Rejection Report ${record.rejectionNumber}.`);
      const pending = Math.max(0, Number(rejectedLine.rejectedQty || 0) - Number(rejectedLine.replacementQty || 0));
      let own = 0;
      if (excludeId) {
        const oldReceipt = await client.query('SELECT payload FROM material_receipts WHERE receipt_number=$1', [excludeId]);
        own = (oldReceipt.rows[0]?.payload?.items || []).filter((item) => lineKey(item) === key).reduce((sum, item) => sum + Number(item.receivedQty || 0), 0);
      }
      if (received > pending + own + 1e-9) throw conflict(`Replacement quantity ${received} exceeds the outstanding rejected quantity ${pending + own} for ${line.materialName || line.materialCode}.`);
      continue;
    }
    if (!(orderedQty > 0) || before + received > orderedQty + 1e-9) throw conflict(`Received quantity ${before + received} exceeds ordered quantity ${orderedQty} for ${line.materialName || line.itemName || line.materialCode}.`);
    const qcNumber = ref(record.qcNumber);
    if (qcNumber) {
      const linkedQC = await readLinkedRecord(client, 'qualityChecks', 'qcNumber', qcNumber);
      const qc = linkedQC?.data;
      const qcLine = (qc?.items || []).find((item) => lineKey(item) === key);
      if (!qc || !['Approved', 'Partially Approved', 'Rejected'].includes(qc.status) || !qcLine) throw conflict(`Quality Check ${qcNumber} is missing or does not cover this PO line.`);
      if (received > Number(qcLine.acceptedQty || 0)) throw conflict(`Invoiced/received quantity cannot exceed QC accepted quantity for ${line.materialName || line.itemName || key}.`);
    }
  }
};

router.get('/material-receipts/sequences/next', async (req, res) => {
  authorize(req, 'receipt.create');
  const replacement = String(req.query.replacement || '') === 'true';
  const key = replacement ? 'replacementReceipt' : 'materialReceipt';
  const seqKey = replacement ? 'replacementReceiptSequence' : 'materialReceiptSequence';
  const prefix = replacement ? 'RR' : 'REC';
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material-receipt-sequence:${key}`]);
    const [sequence, rows, legacy, oldCounter] = await Promise.all([
      client.query('SELECT last_number FROM procurement_sequences WHERE sequence_key=$1 FOR UPDATE', [key]),
      client.query("SELECT COALESCE(max((regexp_match(receipt_number,'([0-9]+)$'))[1]::bigint),0) AS n FROM material_receipts WHERE receipt_number LIKE $1", [`${prefix}-%`]),
      client.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts'"),
      client.query('SELECT data FROM erp_state WHERE storage_key=$1', [seqKey])
    ]);
    let max = Math.max(Number(sequence.rows[0]?.last_number || 0), Number(rows.rows[0]?.n || 0), Number(oldCounter.rows[0]?.data || 0));
    for (const record of Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : []) {
      if (replacement !== Boolean(record?.isReplacement)) continue;
      const match = String(record?.receiptNumber || '').match(/(\d+)$/); if (match) max = Math.max(max, Number(match[1]));
    }
    const next = max + 1;
    await client.query('INSERT INTO procurement_sequences(sequence_key,last_number,updated_at) VALUES($1,$2,now()) ON CONFLICT(sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()', [key, next]);
    await client.query('COMMIT');
    res.json({ number: `${prefix}-${String(next).padStart(6, '0')}` });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.get('/material-receipts', async (req, res) => {
  authorize(req, 'receipt.view');
  const result = await getPool().query('SELECT * FROM material_receipts WHERE deleted_at IS NULL ORDER BY created_at DESC,receipt_number');
  res.json({ records: result.rows.map(view) });
});
router.get('/material-receipt-quality-checks', async (req, res) => {
  authorizeAny(req, ['production.qc.view', 'receipt.view']);
  const result = await getPool().query('SELECT * FROM material_receipt_inspections ORDER BY updated_at DESC,qc_number');
  res.json({ records: result.rows.map(inspectionView) });
});
router.put('/material-receipts/:id/quality-check', async (req, res) => {
  authorize(req, 'production.qc.manage');
  const input = req.body?.data;
  const expected = Number(req.body?.version || 0);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !String(input.qcNumber || '').trim()) throw bad('A complete receipt Quality Check is required.');
  if (!Number.isInteger(expected) || expected < 0) throw bad('A valid PostgreSQL Quality Check version is required.');
  if (String(input.receiptNumber || '') !== String(req.params.id)) throw bad('Quality Check receipt reference does not match the selected receipt.');
  if (!Array.isArray(input.items) || !input.items.length) throw bad('A Quality Check must contain inspected receipt lines.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const receiptResult = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
    const receipt = receiptResult.rows[0];
    if (!receipt) throw Object.assign(new Error('Material Receipt not found.'), { status: 404 });
    const inspectionResult = await client.query('SELECT * FROM material_receipt_inspections WHERE receipt_number=$1 FOR UPDATE', [req.params.id]);
    const current = inspectionResult.rows[0];
    const token = `receipt-inspection:${req.params.id}:${input.qcNumber}`;
    if (current && expected === 0 && current.qc_number === String(input.qcNumber) && current.create_token === token
      && inspectionSignature(current.payload) === inspectionSignature(input)) {
      const linkedReceipt = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1', [req.params.id]);
      await client.query('COMMIT');
      return res.json({ record: inspectionView(current), receipt: linkedReceipt.rowCount ? view(linkedReceipt.rows[0]) : null, duplicate: true });
    }
    if (current?.posted_at) throw conflict('This inspection has already posted accepted stock and can no longer be edited.', inspectionView(current));
    if (current && Number(current.version) !== expected) throw conflict('Quality Check changed in PostgreSQL. Reload before editing.', inspectionView(current));
    if (!current && expected !== 0) throw conflict('Quality Check no longer exists in PostgreSQL. Reload before saving.');
    if (current && current.qc_number !== String(input.qcNumber)) throw conflict(`Receipt ${req.params.id} already has Quality Check ${current.qc_number}.`);
    const receiptItems = await client.query('SELECT * FROM material_receipt_items WHERE receipt_number=$1 ORDER BY line_number FOR SHARE', [req.params.id]);
    const usedLines = new Set();
    const qcItems = [];
    for (const [index, line] of input.items.entries()) {
      const qty = Number(line.receivedQty); const accepted = Number(line.acceptedQty); const rejected = Number(line.rejectedQty); const rework = Number(line.reworkQty || 0);
      if (![qty, accepted, rejected, rework].every(Number.isFinite) || qty <= 0 || accepted < 0 || rejected < 0 || rework < 0 || accepted + rejected !== qty || rework > rejected) throw bad(`Invalid received, accepted, rejected, or rework quantity for ${line.materialName || line.materialCode || 'receipt line'}.`);
      const matches = receiptItems.rows.filter((candidate) => lineKey(candidate.payload || candidate) === lineKey(line) && !usedLines.has(Number(candidate.line_number)));
      let sourceLine = matches.find((candidate) => String(candidate.batch_number || '') === String(line.batchNumber || '') && String(candidate.lot_number || '') === String(line.lotNumber || ''));
      if (!sourceLine && matches.length === 1) sourceLine = matches[0];
      if (!sourceLine) throw conflict(`Quality Check line ${line.materialName || line.materialCode} does not identify exactly one line on receipt ${req.params.id}.`);
      if (qty > Number(sourceLine.received_qty) + 1e-9) throw conflict(`Inspected quantity exceeds the received quantity for ${line.materialName || line.materialCode}.`);
      usedLines.add(Number(sourceLine.line_number));
      qcItems.push({ ...line, receivedQty: qty, acceptedQty: accepted, rejectedQty: rejected, reworkQty: rework, receiptLineNumber: Number(sourceLine.line_number) });
    }
    const totalReceived = qcItems.reduce((sum, line) => sum + line.receivedQty, 0);
    const totalAccepted = qcItems.reduce((sum, line) => sum + line.acceptedQty, 0);
    const totalRejected = qcItems.reduce((sum, line) => sum + line.rejectedQty, 0);
    const status = totalAccepted === totalReceived ? 'Approved' : totalAccepted > 0 ? 'Partially Approved' : 'Rejected';
    if (String(input.status) !== status) throw bad(`Quality Check status must match inspected quantities (${status}).`);
    const now = new Date().toISOString();
    const payload = { ...input, status, items: qcItems.map(({ receiptLineNumber, ...line }) => line), updatedAt: now, version: current ? Number(current.version) + 1 : 1 };
    let saved;
    if (current) {
      const result = await client.query('UPDATE material_receipt_inspections SET status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE qc_number=$1 RETURNING *', [current.qc_number, status, JSON.stringify(payload), req.user.email]);
      saved = result.rows[0];
      await client.query('DELETE FROM material_receipt_inspection_items WHERE qc_number=$1', [current.qc_number]);
    } else {
      const result = await client.query('INSERT INTO material_receipt_inspections(qc_number,receipt_number,status,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$6) RETURNING *', [input.qcNumber, req.params.id, status, JSON.stringify(payload), token, req.user.email]);
      saved = result.rows[0];
    }
    for (const [index, line] of qcItems.entries()) await client.query(
      `INSERT INTO material_receipt_inspection_items(qc_number,receipt_number,line_number,receipt_line_number,material_code,material_name,unit,received_qty,accepted_qty,rejected_qty,rework_qty,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [input.qcNumber, req.params.id, index + 1, line.receiptLineNumber, String(line.materialCode || ''), String(line.materialName || ''), String(line.unit || 'Nos'), line.receivedQty, line.acceptedQty, line.rejectedQty, line.reworkQty, JSON.stringify(line)]
    );
    const receiptPayload = { ...receipt.payload, qcNumber: input.qcNumber, qcStatus: status, inspectionUpdatedAt: now };
    const receiptUpdated = await client.query('UPDATE material_receipts SET status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE receipt_number=$1 RETURNING *', [req.params.id, String(receipt.status), JSON.stringify(receiptPayload), req.user.email]);
    await audit(client, req, req.params.id, 'QUALITY_INSPECTION_UPDATED', receipt.payload, receiptPayload);
    await inspectionAudit(client, req, input.qcNumber, req.params.id, current ? 'UPDATE' : 'CREATE', current?.payload || null, payload);
    await reconcilePurchaseOrderProgress(client, req, receipt.po_number, `Quality Check ${input.qcNumber}`);
    await client.query('COMMIT');
    res.status(current ? 200 : 201).json({ record: inspectionView(saved), receipt: view(receiptUpdated.rows[0]), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.post('/material-receipt-quality-checks/:qcNumber/post-stock', async (req, res) => {
  authorize(req, 'receipt.create');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const inspectionResult = await client.query('SELECT * FROM material_receipt_inspections WHERE qc_number=$1 FOR UPDATE', [req.params.qcNumber]);
    const inspection = inspectionResult.rows[0];
    if (!inspection) throw Object.assign(new Error('PostgreSQL Quality Check not found; stock cannot be posted.'), { status: 404 });
    if (inspection.posted_at) { await client.query('COMMIT'); return res.json({ record: inspectionView(inspection), duplicate: true, movements: [] }); }
    if (!['Approved', 'Partially Approved'].includes(inspection.status)) throw conflict(`Only approved inspection quantity may enter stock (current: ${inspection.status}).`);
    const receiptResult = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1 AND deleted_at IS NULL FOR UPDATE', [inspection.receipt_number]);
    const receipt = receiptResult.rows[0];
    if (!receipt) throw conflict('Receipt was deleted or is unavailable; stock posting is blocked.');
    const linesResult = await client.query('SELECT * FROM material_receipt_inspection_items WHERE qc_number=$1 ORDER BY line_number FOR UPDATE', [inspection.qc_number]);
    const acceptedLines = linesResult.rows.filter((line) => Number(line.accepted_qty) > 0);
    if (!acceptedLines.length) throw conflict('No accepted quantity is available to post.');
    const existingMovements = await client.query('SELECT id FROM receipt_stock_movements WHERE qc_number=$1', [inspection.qc_number]);
    if (existingMovements.rowCount) throw conflict('Stock movement rows already exist for this inspection; reload and reconcile before retrying.');
    const movements = [];
    for (const line of acceptedLines) {
      const key = String(line.material_code || line.material_name).trim().toLowerCase();
      if (!key) throw bad('Accepted stock line has no material identity.');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inventory-stock:${key}`]);
      const matcher = line.material_code ? `lower(COALESCE(data->>'itemCode',data->>'code',''))=lower($1)` : `lower(COALESCE(data->>'itemName',data->>'name',''))=lower($1)`;
      const found = await client.query(`SELECT record_id,data,version FROM module_records WHERE storage_key='inventoryItems' AND ${matcher} FOR UPDATE`, [line.material_code || line.material_name]);
      if (found.rowCount > 1) throw conflict(`Inventory master contains multiple matching rows for ${line.material_name || line.material_code}; stock posting is ambiguous.`);
      const before = found.rows[0]?.data || { id: `stock-${createHash('sha256').update(key).digest('hex').slice(0,20)}`, itemCode: line.material_code || `MAT-${createHash('sha256').update(key).digest('hex').slice(0,10).toUpperCase()}`, itemName: line.material_name, unit: line.unit || 'Nos', currentQty: 0, reservedQty: 0, category: 'Raw Material', location: 'Main Store', warehouse: 'Main Store' };
      const balanceBefore = Number(before.currentQty || 0); const quantity = Number(line.accepted_qty); const balanceAfter = balanceBefore + quantity;
      const after = { ...before, currentQty: balanceAfter, unit: before.unit || line.unit || 'Nos' };
      const actor = req.user?.name || req.user?.email || 'ERP user';
      if (found.rowCount) await client.query('UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key=\'inventoryItems\' AND record_id=$1 AND version=$2', [found.rows[0].record_id, found.rows[0].version, JSON.stringify(after), req.user.email]);
      else await client.query('INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES(\'inventoryItems\',$1,$2::jsonb,1,now(),$3)', [after.id, JSON.stringify(after), req.user.email]);
      /* The central ledger is authoritative for every stock movement. The
       * legacy module_records copy above is retained only for compatibility;
       * both are committed in this same transaction. */
      await postStockMovement(client, req, {
        ledgerId: `receipt-stock-${inspection.qc_number}-${line.line_number}`,
        itemCode: line.material_code || before.itemCode,
        materialName: line.material_name,
        movementType: 'IN',
        quantity,
        unit: line.unit || before.unit || 'Nos',
        unitCost: Number(before.unitPrice || before.unit_price || 0),
        entryDate: new Date().toISOString().slice(0, 10),
        sourceDocType: 'Quality Accepted Receipt',
        sourceDocRef: inspection.receipt_number,
        batchNo: line.payload?.batchNumber || '',
        batchId: line.payload?.internalBatchId || '',
        batchInitialQty: quantity,
        lotNumber: line.payload?.lotNumber || '',
        reason: 'Quality accepted receipt posting',
        batchMetadata: {
          ...line.payload,
          receiptNumber: inspection.receipt_number,
          qcNumber: inspection.qc_number,
          supplier: receipt.payload?.supplier || receipt.payload?.vendorName || '',
          grnNumber: inspection.receipt_number,
          receivedQty: Number(line.received_qty),
          acceptedQty: Number(line.accepted_qty),
          rejectedQty: Number(line.rejected_qty)
        },
        payload: { receiptNumber: inspection.receipt_number, qcNumber: inspection.qc_number, lineNumber: line.line_number }
      });
      const movement = await client.query(
        `INSERT INTO receipt_stock_movements(receipt_number,qc_number,line_number,material_key,material_code,material_name,unit,quantity,balance_before,balance_after,batch_number,lot_number,actor_id,actor_email)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [inspection.receipt_number, inspection.qc_number, line.line_number, key, line.material_code, line.material_name, line.unit, quantity, balanceBefore, balanceAfter, line.payload?.batchNumber || '', line.payload?.lotNumber || '', req.user.id || null, req.user.email]
      );
      const movementData = { id: `receipt-stock-${inspection.qc_number}-${line.line_number}`, date: new Date().toISOString().slice(0,10), itemCode: line.material_code || after.itemCode, itemName: line.material_name, unit: line.unit, type: 'IN', quantity, acceptedQty: quantity, rejectedQty: Number(line.rejected_qty), balanceAfter, reason: 'Purchase Inward (Quality Approved Material)', source: 'Quality Approved Material', reference: inspection.receipt_number, transactionNumber: inspection.receipt_number, poNumber: receipt.po_number, receiptNumber: inspection.receipt_number, qcNumber: inspection.qc_number, batchNo: line.payload?.batchNumber || '', lotNumber: line.payload?.lotNumber || '', receivedBy: actor, postedAt: new Date().toISOString() };
      await client.query('INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES(\'stockTransactions\',$1,$2::jsonb,1,now(),$3) ON CONFLICT(storage_key,record_id) DO NOTHING', [movementData.id, JSON.stringify(movementData), req.user.email]);
      await client.query('INSERT INTO receipt_stock_movement_audit(movement_id,actor_id,actor_email,actor_role,action,before_values,after_values) VALUES($1,$2,$3,$4,\'POST\',$5::jsonb,$6::jsonb)', [movement.rows[0].id, req.user.id || null, req.user.email, req.user.role || '', JSON.stringify({ balanceBefore }), JSON.stringify(movement.rows[0])]);
      movements.push({ ...movement.rows[0], inventoryItem: after, transaction: movementData });
    }
    const postedQty = acceptedLines.reduce((sum, line) => sum + Number(line.accepted_qty), 0);
    const now = new Date().toISOString();
    const qcPayload = { ...inspection.payload, postedToInventory: true, postedAt: now, postedBy: req.user.name || req.user.email, inventoryPostedQty: postedQty, history: [...(inspection.payload.history || []), { action: 'Accepted material added to PostgreSQL inventory', details: `${acceptedLines.length} line(s) | ${postedQty} unit(s)`, at: now, by: req.user.name || req.user.email }] };
    const qcUpdated = await client.query('UPDATE material_receipt_inspections SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3,posted_at=now(),posted_by=$3,posted_qty=$4 WHERE qc_number=$1 RETURNING *', [inspection.qc_number, JSON.stringify(qcPayload), req.user.email, postedQty]);
    const receiptPayload = { ...receipt.payload, postedToInventory: true, inventoryPosted: true, inventoryPostedAt: now, inventoryPostedBy: req.user.name || req.user.email };
    const receiptUpdated = await client.query('UPDATE material_receipts SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE receipt_number=$1 RETURNING *', [inspection.receipt_number, JSON.stringify(receiptPayload), req.user.email]);
    await inspectionAudit(client, req, inspection.qc_number, inspection.receipt_number, 'POST_STOCK', inspection.payload, qcPayload);
    await audit(client, req, inspection.receipt_number, 'STOCK_POSTED', receipt.payload, receiptPayload);
    await reconcilePurchaseOrderProgress(client, req, receipt.po_number, `Stock posted for ${inspection.qc_number}`);
    await client.query('COMMIT');
    res.json({ record: inspectionView(qcUpdated.rows[0]), receipt: view(receiptUpdated.rows[0]), movements, inventoryItems: movements.map((movement) => movement.inventoryItem), stockTransactions: movements.map((movement) => movement.transaction), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.get('/material-receipts/migration-preview', (req, res, next) => {
  if (!admin(req)) return res.status(403).json({ error: 'Administrator access is required.' });
  next();
}, async (req, res) => {
  const [legacy, current] = await Promise.all([
    getPool().query("SELECT data FROM erp_state WHERE storage_key='materialReceipts'"),
    getPool().query('SELECT receipt_number,payload FROM material_receipts')
  ]);
  const rows = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byId = new Map(current.rows.map((row) => [row.receipt_number, row.payload]));
  const invoiceOwners = new Map(current.rows.map((row) => [String(row.payload?.invoiceNumber || '').trim().toLowerCase(), row.receipt_number]).filter(([invoice]) => invoice));
  const result = { eligible: [], existing: [], conflicts: [], invalid: [] };
  for (const record of rows) {
    const id = ref(record?.receiptNumber);
    try { validateReceipt(record); }
    catch (error) { result.invalid.push({ record, reason: error.message }); continue; }
    if (!Array.isArray(record.items) || !record.items.length) { result.invalid.push({ record, reason: 'At least one receipt item line is required.' }); continue; }
    if (!byId.has(id)) {
      const invoice = String(record.invoiceNumber).trim().toLowerCase();
      const owner = invoiceOwners.get(invoice);
      if (owner && owner !== id) result.conflicts.push({ record, reason: `Invoice ${record.invoiceNumber} is already assigned to receipt ${owner}.` });
      else { result.eligible.push(record); invoiceOwners.set(invoice, id); }
    } else if (canonical(comparable(byId.get(id))) === canonical(comparable(record))) result.existing.push(record);
    else result.conflicts.push({ record, databaseRecord: byId.get(id), reason: 'The receipt number exists in PostgreSQL with different content.' });
  }
  res.json({ counts: Object.fromEntries(Object.entries(result).map(([key, rows]) => [key, rows.length])), ...result });
});
router.get('/material-receipts/:id', async (req, res) => {
  authorize(req, 'receipt.view');
  const result = await getPool().query('SELECT * FROM material_receipts WHERE receipt_number=$1 AND deleted_at IS NULL', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Material Receipt not found.' });
  res.json({ record: view(result.rows[0]) });
});
router.post('/material-receipts/migration-preview/import-missing', async (req, res) => {
  if (!admin(req)) return res.status(403).json({ error: 'Administrator access is required.' });
  const ids = req.body?.records;
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw bad('Select Material Receipts from the Admin migration preview.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const source = await client.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts' FOR SHARE");
    const legacy = Array.isArray(source.rows[0]?.data) ? source.rows[0].data : [];
    const imported = []; const conflicts = []; const skipped = [];
    for (const id of [...new Set(ids.map(String))]) {
      const record = legacy.find((row) => String(row?.receiptNumber) === id);
      if (!record) { skipped.push({ receiptNumber: id, reason: 'Receipt is no longer present in the preserved legacy snapshot.' }); continue; }
      const existing = await client.query('SELECT payload FROM material_receipts WHERE receipt_number=$1 FOR UPDATE', [id]);
      if (existing.rowCount) {
        if (canonical(comparable(existing.rows[0].payload)) === canonical(comparable(record))) skipped.push({ receiptNumber: id, reason: 'Already exists identically in PostgreSQL.' });
        else conflicts.push({ receiptNumber: id, reason: 'Existing PostgreSQL receipt differs; left unchanged.' });
        continue;
      }
      const { po, invoice } = validateReceipt(record);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material-receipt-po:${po}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material-receipt-invoice:${invoice.toLowerCase()}`]);
      const invoiceExists = await client.query('SELECT receipt_number FROM material_receipts WHERE lower(invoice_number)=lower($1) AND deleted_at IS NULL', [invoice]);
      if (invoiceExists.rowCount) { conflicts.push({ receiptNumber: id, reason: `Invoice ${invoice} is already on receipt ${invoiceExists.rows[0].receipt_number}.` }); continue; }
      if ((Array.isArray(legacy) ? legacy : []).some((row) => String(row?.receiptNumber) !== id && String(row?.invoiceNumber || '').trim().toLowerCase() === invoice.toLowerCase())) { conflicts.push({ receiptNumber: id, reason: `Invoice ${invoice} is duplicated in preserved legacy receipt data.` }); continue; }
      await validateQuantities(client, po, record, id);
      const vendor = String(record.vendor || '-');
      const token = `legacy-receipt:${createHash('sha256').update(id).digest('hex')}`;
      const inserted = await client.query('INSERT INTO material_receipts(receipt_number,po_number,invoice_number,vendor_name,status,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *', [id, po, invoice, vendor, String(record.status || 'Received'), JSON.stringify({ ...record, version: 1 }), token, req.user.email]);
      await persistReceiptItems(client, id, record.items);
      await audit(client, req, id, 'LEGACY_IMPORT', null, inserted.rows[0].payload, 'Explicit Admin import from migration preview');
      imported.push(view(inserted.rows[0]));
    }
    for (const receipt of imported) {
      await reconcilePurchaseOrderProgress(client, req, receipt.poNumber, `Legacy Material Receipt ${receipt.receiptNumber} imported`);
    }
    await client.query('COMMIT'); res.json({ imported, conflicts, skipped });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.post('/material-receipts', async (req, res) => {
  authorize(req, 'receipt.create');
  const record = req.body?.data; const { id, po, invoice } = validateReceipt(record);
  const token = String(req.body?.createToken || '').trim();
  if (!token || token.length > 200) throw bad('A Material Receipt idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material-receipt-po:${po}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material-receipt-invoice:${invoice.toLowerCase()}`]);
    const retry = await client.query('SELECT * FROM material_receipts WHERE create_token=$1 FOR UPDATE', [token]);
    if (retry.rowCount) {
      if (retry.rows[0].deleted_at) throw conflict('This idempotency token belongs to a deleted receipt. Its identifier cannot be recreated.');
      if (retry.rows[0].po_number !== po || retry.rows[0].invoice_number.toLowerCase() !== invoice.toLowerCase()) throw conflict('This idempotency token was already used for a different Purchase Order or invoice.');
      await client.query('COMMIT'); return res.json({ record: view(retry.rows[0]), duplicate: true });
    }
    const duplicate = await client.query('SELECT receipt_number FROM material_receipts WHERE lower(invoice_number)=lower($1) AND deleted_at IS NULL', [invoice]);
    if (duplicate.rowCount) throw conflict(`Invoice ${invoice} already exists on Material Receipt ${duplicate.rows[0].receipt_number}.`);
    const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts' FOR SHARE");
    if ((Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : []).some((r) => String(r?.invoiceNumber || '').trim().toLowerCase() === invoice.toLowerCase())) throw conflict(`Invoice ${invoice} already exists in preserved legacy receipt history.`);
    await validateQuantities(client, po, record);
    const vendor = String(record.vendor || '-');
    const inserted = await client.query('INSERT INTO material_receipts(receipt_number,po_number,invoice_number,vendor_name,status,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *', [id, po, invoice, vendor, String(record.status || 'Received'), JSON.stringify({ ...record, version: 1 }), token, req.user.email]);
    await persistReceiptItems(client, id, record.items);
    if (record.qcNumber) {
      const linkedQC = await readLinkedRecord(client, 'qualityChecks', 'qcNumber', record.qcNumber);
      if (!linkedQC || (linkedQC.data?.receiptNumber && String(linkedQC.data.receiptNumber) !== id)) throw conflict(`Quality Check ${record.qcNumber} is no longer available for this receipt.`);
      const before = linkedQC.data;
      const updatedQC = {
        ...before,
        receiptNumber: id,
        history: [...(before.history || []), { action: 'Tax invoice recorded', details: `${id} | invoice ${invoice}`, at: new Date().toISOString(), by: req.user?.name || req.user?.email || 'ERP user' }]
      };
      await writeLinkedRecord(client, req, 'qualityChecks', linkedQC.recordId, linkedQC.version, before, updatedQC);
      await auditLinkedRecord(client, req, 'qualityChecks', linkedQC.recordId, id, 'RECEIPT_LINKED', before, updatedQC);
    }
    await applyReplacementReceipt(client, req, record);
    await audit(client, req, id, 'CREATE', null, record);
    await reconcilePurchaseOrderProgress(client, req, po, `Material Receipt ${id}`);
    await client.query('COMMIT'); res.status(201).json({ record: view(inserted.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.put('/material-receipts/:id', async (req, res) => {
  authorize(req, 'receipt.create');
  const expected = Number(req.body?.version); const patch = req.body?.data;
  if (!Number.isInteger(expected) || expected < 1 || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Current PostgreSQL receipt version and updated receipt are required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1 FOR UPDATE', [req.params.id]); const old = found.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Material Receipt not found.'), { status: 404 });
    if (Number(old.version) !== expected) throw conflict('Material Receipt changed in PostgreSQL. Reload before editing.', view(old));
    if (old.payload.postedToInventory || old.payload.inventoryPosted) throw conflict('Receipt has already posted to inventory and can no longer be edited.');
    const merged = { ...old.payload, ...patch, receiptNumber: req.params.id, poNumber: old.po_number, vendor: old.vendor_name, version: undefined };
    const { po, invoice } = validateReceipt(merged);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`material-receipt-po:${po}`]);
    if (po !== old.po_number) throw bad('A receipt cannot be moved to another Purchase Order.');
    const duplicate = await client.query('SELECT 1 FROM material_receipts WHERE lower(invoice_number)=lower($1) AND receipt_number<>$2 AND deleted_at IS NULL', [invoice, req.params.id]);
    if (duplicate.rowCount) throw conflict(`Invoice ${invoice} is already on another receipt.`);
    const [legacy, linkedInvoice] = await Promise.all([
      client.query("SELECT data FROM erp_state WHERE storage_key='materialReceipts' FOR SHARE"),
      client.query('SELECT 1 FROM supplier_invoices WHERE receipt_number=$1 AND deleted_at IS NULL', [req.params.id])
    ]);
    if ((Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : []).some((r) => String(r?.receiptNumber) !== req.params.id && String(r?.invoiceNumber || '').trim().toLowerCase() === invoice.toLowerCase())) throw conflict(`Invoice ${invoice} exists in preserved legacy receipt history.`);
    if (linkedInvoice.rowCount && invoice !== old.invoice_number) throw conflict('A Supplier Invoice is linked; the vendor invoice number cannot be changed.');
    await validateQuantities(client, po, merged, req.params.id);
    const updated = await client.query('UPDATE material_receipts SET invoice_number=$2,status=$3,payload=$4::jsonb,version=version+1,updated_at=now(),updated_by=$5 WHERE receipt_number=$1 RETURNING *', [req.params.id, invoice, String(merged.status || old.status), JSON.stringify(merged), req.user.email]);
    await persistReceiptItems(client, req.params.id, merged.items);
    await applyReplacementReceipt(client, req, { ...merged, receiptNumber: req.params.id, poNumber: old.po_number }, old.payload.items || [], 'Replacement receipt edited');
    await audit(client, req, req.params.id, 'UPDATE', old.payload, merged);
    await reconcilePurchaseOrderProgress(client, req, po, `Material Receipt ${req.params.id} edited`);
    await client.query('COMMIT'); res.json({ record: view(updated.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.delete('/material-receipts/:id', async (req, res) => {
  authorize(req, 'receipt.create');
  const expected = Number(req.body?.version); const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(expected) || expected < 1) throw bad('Current PostgreSQL receipt version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1 FOR UPDATE', [req.params.id]); const old = found.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Material Receipt not found.'), { status: 404 });
    if (Number(old.version) !== expected) throw conflict('Material Receipt changed in PostgreSQL. Reload before deleting.', view(old));
    if (old.payload.postedToInventory || old.payload.inventoryPosted) throw conflict('Receipt has already been posted to inventory and cannot be deleted.');
    const [invoice, debitNotes] = await Promise.all([
      client.query('SELECT invoice_number FROM supplier_invoices WHERE receipt_number=$1 AND deleted_at IS NULL LIMIT 1', [req.params.id]),
      client.query("SELECT data FROM erp_state WHERE storage_key='debitNotes' FOR SHARE")
    ]);
    if (invoice.rowCount || old.payload.supplierInvoiceNumber) throw conflict('A Supplier Invoice is linked to this receipt; void it with Purchase first.');
    const notes = Array.isArray(debitNotes.rows[0]?.data) ? debitNotes.rows[0].data : [];
    if (notes.some((row) => String(row?.receiptNumber) === req.params.id && !['Cancelled', 'Voided'].includes(row.status))) throw conflict('An active Debit Note depends on this receipt.');
    if (old.payload.postedToInventory || old.payload.inventoryPosted) throw conflict('Receipt is already posted to inventory.');
    const linkedQC = await readLinkedRecord(client, 'qualityChecks', 'qcNumber', req.params.id, "data->>'receiptNumber'");
    if (linkedQC?.data?.postedToInventory) throw conflict(`Quality Check ${linkedQC.data.qcNumber} is posted to inventory; the receipt cannot be deleted.`);
    if (linkedQC && !linkedQC.legacy) {
      const before = linkedQC.data;
      const updatedQC = {
        ...before,
        receiptNumber: '',
        history: [...(before.history || []), { action: 'Tax invoice removed', details: `${req.params.id} soft-deleted${reason ? ` — ${reason}` : ''}`, at: new Date().toISOString() }]
      };
      await writeLinkedRecord(client, req, 'qualityChecks', linkedQC.recordId, linkedQC.version, before, updatedQC);
      await auditLinkedRecord(client, req, 'qualityChecks', linkedQC.recordId, req.params.id, 'RECEIPT_UNLINKED', before, updatedQC);
    }
    if (old.payload.isReplacement && old.payload.rejectionNumber) {
      const linkedReport = await readLinkedRecord(client, 'rejectionReports', 'rejectionNumber', old.payload.rejectionNumber);
      if (linkedReport && !linkedReport.legacy) {
        const before = linkedReport.data;
        const report = { ...before };
        const own = new Map((old.payload.items || []).map((line) => [lineKey(line), Number(line.receivedQty || 0)]));
        report.items = (report.items || []).map((line) => { const qty = own.get(lineKey(line)) || 0; const replacementQty = Math.max(0, Number(line.replacementQty || 0) - qty); return qty ? { ...line, replacementQty, pendingReplacementQty: Math.max(0, Number(line.rejectedQty || 0) - replacementQty) } : line; });
        if (String(report.replacementReceiptNumber || '') === req.params.id) { report.replacementReceiptNumber = ''; report.replacementArrivedAt = ''; }
        report.history = [...(report.history || []), { action: 'Replacement receipt deleted', details: req.params.id, at: new Date().toISOString() }];
        await writeLinkedRecord(client, req, 'rejectionReports', linkedReport.recordId, linkedReport.version, before, report);
        await auditLinkedRecord(client, req, 'rejectionReports', linkedReport.recordId, req.params.id, 'REPLACEMENT_RECEIPT_DELETED', before, report);
      }
    }
    await client.query('UPDATE material_receipts SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE receipt_number=$1', [req.params.id, req.user.email, reason]);
    await audit(client, req, req.params.id, 'SOFT_DELETE', old.payload, null, reason);
    await reconcilePurchaseOrderProgress(client, req, old.po_number, `Material Receipt ${req.params.id} deleted`);
    await client.query('COMMIT'); res.json({ deleted: req.params.id });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

export default router;
