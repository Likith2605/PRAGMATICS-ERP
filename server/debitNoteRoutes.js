/**
 * Debit Notes API (Phase 3).
 *
 * Mounted by server.js at /api/debit-notes. Every route is authenticated, every
 * mutation runs in a transaction with FOR UPDATE row locks and optimistic
 * version checks, and every state change writes a debit_note_audit row.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { authenticateRequest, requireAdmin, requireDepartmentPermission } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';
import {
  DN_STATUS,
  allRejectionReports,
  auditDebitNote,
  bad,
  buildDebitNoteContext,
  conflict,
  findRejectionReport,
  insertDebitNoteItems,
  isActiveStatus,
  isValidDate,
  isValidNumber,
  nextDebitNoteNumber,
  notFound,
  num,
  rememberDebitNoteNumber,
  replacementProgress,
  stampHistory,
  validateAndBuildDebitNote,
  viewDebitNote
} from './debitNoteSource.js';

const router = express.Router();
const admin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const forbidden = () => Object.assign(new Error('Your selected department role does not allow this operation.'), { status: 403 });
const authorize = (req, permissions) => {
  if (admin(req)) return;
  if (!hasPermissionForRole(req.user?.roleKey, Array.isArray(permissions) ? permissions : [permissions], req.user?.rolePermissions)) throw forbidden();
};
const requireWriteAccess = (req, res, next) => {
  if (admin(req)) return next();
  if (!hasPermissionForRole(req.user?.roleKey, ['debitnote.create', 'debitnote.record'], req.user?.rolePermissions)) {
    return res.status(403).json({ error: 'Your selected department role does not allow this operation.' });
  }
  return next();
};
const versionOf = (value) => {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  return version;
};
const createTokenOf = (value) => {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid idempotency token is required.');
  return token;
};
const itemFingerprint = (input) => (Array.isArray(input?.items) ? input.items : [])
  .map((item) => [String(item?.materialCode || item?.materialName || ''), Number(item?.debitQty) || 0])
  .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
const signatureOf = (input) => createHash('sha256').update(JSON.stringify({
  rejectionNumber: String(input?.rejectionNumber || '').trim(),
  debitNoteDate: String(input?.debitNoteDate || '').trim(),
  remarks: String(input?.remarks || ''),
  items: itemFingerprint(input)
})).digest('hex');
/** Quantity-only fingerprint: the same rejected stock cannot be claimed twice. */
const claimSignatureOf = (input) => createHash('sha256').update(JSON.stringify({
  rejectionNumber: String(input?.rejectionNumber || '').trim(),
  items: itemFingerprint(input)
})).digest('hex');

/** Self-contained auth: safe when mounted before or after the global /api auth. */
router.use(authenticateRequest);

const transaction = async (work) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const lockNote = async (client, number) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('debit-note:' || $1))", [number]);
  const result = await client.query('SELECT * FROM debit_notes WHERE debit_note_number=$1 FOR UPDATE', [number]);
  if (!result.rowCount || result.rows[0].deleted_at) throw notFound('Debit Note not found.');
  return result.rows[0];
};

const lockSource = async (client, rejectionNumber) =>
  client.query("SELECT pg_advisory_xact_lock(hashtext('debit-note-source:' || $1))", [String(rejectionNumber || '')]);

const assertNoDuplicateClaim = async (client, rejectionNumber, claimSignature, excludeNumber = '') => {
  const existing = await client.query(
    `SELECT debit_note_number FROM debit_notes
      WHERE rejection_number=$1 AND deleted_at IS NULL AND status <> ALL($3::text[])
        AND payload->>'claimSignature'=$2 AND debit_note_number <> $4
      FOR UPDATE`,
    [rejectionNumber, claimSignature, [DN_STATUS.CANCELLED, DN_STATUS.REJECTED], excludeNumber || '__none__']
  );
  if (existing.rowCount) {
    throw conflict(`A Debit Note already claims this exact rejected quantity on Rejection Report ${rejectionNumber} (${existing.rows[0].debit_note_number}).`);
  }
};

const insertNote = async (client, number, note, actor, status = DN_STATUS.DRAFT, token = '') => {
  const result = await client.query(
    `INSERT INTO debit_notes(debit_note_number,debit_note_date,rejection_number,po_number,invoice_number,vendor_id,vendor_name,
       subtotal,total_gst,grand_total,status,remarks,created_by,updated_by,version,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15::jsonb) RETURNING *`,
    [number, note.debitNoteDate, note.rejectionNumber, note.poNumber, note.invoiceNumber, '', note.vendor,
      note.subtotal, note.totalGST, note.grandTotal, status, note.remarks, actor || '', actor || '', JSON.stringify(note)]
  );
  return result.rows[0];
};

const historyNote = (note, action, details, req) => stampHistory(note, action, details, req.user);

router.get('/', requireDepartmentPermission('debitnote.view'), async (_req, res) => {
  const result = await getPool().query(
    'SELECT * FROM debit_notes WHERE deleted_at IS NULL ORDER BY debit_note_date DESC,debit_note_number DESC'
  );
  res.json({ records: result.rows.map(viewDebitNote) });
});

router.get('/candidates', requireDepartmentPermission('debitnote.view'), async (_req, res) => {
  const reports = await allRejectionReports(getPool());
  const candidates = [];
  for (const report of reports) {
    try {
      const context = await buildDebitNoteContext(getPool(), String(report.rejectionNumber || ''), {
        requireSource: false,
        requirePO: false
      });
      if (context.totalRemainingQty > 0) {
        candidates.push({
          rejectionNumber: context.rejectionNumber,
          rejectionDate: context.rejectionDate,
          qcNumber: context.qcNumber,
          receiptNumber: context.receiptNumber,
          poNumber: context.poNumber,
          vendor: context.vendor,
          totalRejectedQty: context.totalRejectedQty,
          totalDebitedQty: context.totalDebitedQty,
          totalRemainingQty: context.totalRemainingQty,
          hasSource: context.hasSource,
          rejection: report,
          lines: context.lines
        });
      }
    } catch {
      /* Incomplete legacy reports stay off the candidate list until repaired. */
    }
  }
  candidates.sort((left, right) => String(right.rejectionNumber).localeCompare(String(left.rejectionNumber)));
  res.json({ candidates });
});

router.get('/context/:rejectionNumber', requireDepartmentPermission('debitnote.view'), async (req, res) => {
  const context = await buildDebitNoteContext(getPool(), req.params.rejectionNumber, {
    requireSource: false,
    requirePO: false
  });
  res.json({ context });
});

router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const [legacyState, legacyRecords, current] = await Promise.all([
    getPool().query("SELECT data FROM erp_state WHERE storage_key='debitNotes'"),
    getPool().query("SELECT data FROM module_records WHERE storage_key='debitNotes'"),
    getPool().query('SELECT debit_note_number,payload,deleted_at FROM debit_notes')
  ]);
  const seen = new Set();
  const eligible = [];
  const existing = [];
  const conflicts = [];
  const deleted = [];
  for (const row of [...legacyRecords.rows, ...legacyState.rows]) {
    const entries = Array.isArray(row.data)
      ? row.data
      : (row.data && typeof row.data === 'object' ? [row.data] : []);
    for (const entry of entries) {
      const legacy = entry?.payload && typeof entry.payload === 'object' ? entry.payload : entry;
      const number = String(legacy?.debitNoteNumber || legacy?.reference || entry?.reference || '').trim();
      if (!number) continue;
      if (seen.has(number.toLowerCase())) {
        conflicts.push({ number, reason: 'Duplicate legacy ID' });
        continue;
      }
      seen.add(number.toLowerCase());
      const stored = current.rows.find((candidate) => candidate.debit_note_number.toLowerCase() === number.toLowerCase());
      if (stored?.deleted_at) deleted.push({ number });
      else if (stored) existing.push({ number, reason: 'Already imported' });
      else if (!isValidNumber(number) || !isValidDate(legacy?.debitNoteDate) ||
        !String(legacy?.rejectionNumber || '').trim() || !Array.isArray(legacy?.items) || !legacy.items.some((item) => num(item?.debitQty) > 0)) {
        conflicts.push({ number, reason: 'Legacy record is missing a date, rejection link, or debit quantity.' });
      } else {
        eligible.push({ number, payload: legacy });
      }
    }
  }
  res.json({
    eligible,
    existing,
    conflicts,
    deleted,
    counts: { eligible: eligible.length, existing: existing.length, conflicts: conflicts.length, deleted: deleted.length }
  });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) throw bad('Select between 1 and 1000 Debit Notes to import.');
  return transaction(async (client) => {
    const imported = [];
    const conflicts = [];
    for (const entry of records) {
      const legacy = entry?.payload && typeof entry.payload === 'object' ? entry.payload : entry;
      const number = String(legacy?.debitNoteNumber || legacy?.reference || entry?.number || '').trim();
      if (!isValidNumber(number)) {
        conflicts.push({ number, reason: 'A valid legacy Debit Note number is required.' });
        continue;
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext('debit-note-import:' || $1))", [number]);
      const exists = await client.query('SELECT deleted_at FROM debit_notes WHERE debit_note_number=$1 FOR UPDATE', [number]);
      if (exists.rowCount) {
        conflicts.push({ number, reason: exists.rows[0].deleted_at ? 'Deleted record is protected' : 'Record already exists' });
        continue;
      }
      try {
        if (!isValidDate(legacy?.debitNoteDate) || !String(legacy?.rejectionNumber || '').trim() || !Array.isArray(legacy?.items)) {
          throw bad('Legacy record is missing a date, rejection link, or items.');
        }
        await lockSource(client, legacy.rejectionNumber);
        const note = await validateAndBuildDebitNote(client, {
          rejectionNumber: legacy.rejectionNumber,
          debitNoteDate: legacy.debitNoteDate,
          remarks: legacy.remarks || '',
          items: legacy.items
        }, req.user);
        note.createToken = `legacy-import:${number}`;
        note.createSignature = signatureOf({ rejectionNumber: note.rejectionNumber, debitNoteDate: note.debitNoteDate, items: legacy.items });
        note.claimSignature = claimSignatureOf({ rejectionNumber: note.rejectionNumber, items: legacy.items });
        note.migratedFrom = 'legacy';
        note.history = [{ action: 'Debit note imported', details: `Legacy record ${number}`, at: new Date().toISOString(), by: req.user.email }];
        await insertNote(client, number, note, req.user.email, DN_STATUS.DRAFT, note.createToken);
        await insertDebitNoteItems(client, number, note.items);
        await rememberDebitNoteNumber(client, number);
        await auditDebitNote(client, req, number, 'IMPORT', null, note, 'Admin-confirmed legacy migration');
        imported.push(number);
      } catch (error) {
        conflicts.push({ number, reason: error.message });
      }
    }
    return { imported, conflicts };
  }).then((result) => res.json(result));
});

router.post('/', requireWriteAccess, async (req, res) => {
  authorize(req, 'debitnote.create');
  const input = {
    rejectionNumber: String(req.body?.data?.rejectionNumber || '').trim(),
    debitNoteDate: String(req.body?.data?.debitNoteDate || '').trim(),
    remarks: String(req.body?.data?.remarks || ''),
    items: Array.isArray(req.body?.data?.items) ? req.body.data.items : [],
    documents: Array.isArray(req.body?.data?.documents) ? req.body.data.documents : []
  };
  if (!input.rejectionNumber) throw bad('Select the Rejection Report this Debit Note belongs to.');
  const token = createTokenOf(req.body?.createToken || req.body?.data?.createToken);
  const signature = signatureOf(input);
  const claimSignature = claimSignatureOf(input);

  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('debit-note-token:' || $1))", [token]);
    const prior = await client.query("SELECT * FROM debit_notes WHERE payload->>'createToken'=$1 FOR UPDATE", [token]);
    if (prior.rowCount) {
      const existing = prior.rows[0];
      if (existing.deleted_at) throw conflict('Deleted Debit Note cannot be recreated by retry.');
      if (String(existing.payload?.createSignature || '') !== signature) {
        throw conflict('This create token was already used for a different Debit Note.');
      }
      return { record: viewDebitNote(existing), duplicate: true };
    }

    await lockSource(client, input.rejectionNumber);
    await assertNoDuplicateClaim(client, input.rejectionNumber, claimSignature);
    const note = await validateAndBuildDebitNote(client, input, req.user);
    const number = await nextDebitNoteNumber(client);
    note.debitNoteNumber = number;
    note.createToken = token;
    note.createSignature = signature;
    note.claimSignature = claimSignature;
    note.history = [{ action: 'Debit note drafted', details: `${note.items.length} material(s), ${note.grandTotal}`, at: new Date().toISOString(), by: req.user.email, dept: req.user.department || '' }];
    const saved = await insertNote(client, number, note, req.user.email, DN_STATUS.DRAFT, token);
    await insertDebitNoteItems(client, number, note.items);
    await auditDebitNote(client, req, number, 'CREATE', null, note);
    return { record: viewDebitNote(saved), duplicate: false };
  }).then((result) => res.status(result.duplicate ? 200 : 201).json(result));
});

router.get('/:number', requireDepartmentPermission('debitnote.view'), async (req, res) => {
  const result = await getPool().query('SELECT * FROM debit_notes WHERE debit_note_number=$1 AND deleted_at IS NULL', [req.params.number]);
  if (!result.rowCount) throw notFound('Debit Note not found.');
  const report = result.rows[0].rejection_number
    ? await findRejectionReport(getPool(), result.rows[0].rejection_number)
    : null;
  res.json({ record: viewDebitNote(result.rows[0]), replacementProgress: replacementProgress(report) });
});

router.put('/:number', requireWriteAccess, async (req, res) => {
  authorize(req, 'debitnote.create');
  const number = String(req.params.number);
  const version = versionOf(req.body?.version);
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('A complete Debit Note is required.');
  if (String(data.rejectionNumber || '') && String(data.rejectionNumber) !== number && !String(data.rejectionNumber).startsWith('RRN')) {
    throw bad('The Rejection Report link cannot be changed.');
  }

  return transaction(async (client) => {
    const current = await lockNote(client, number);
    if (Number(current.version) !== version) throw conflict('Debit Note changed on the server. Reload before editing.', viewDebitNote(current));
    if (current.status !== DN_STATUS.DRAFT) throw conflict('Only a Draft Debit Note can be edited.');

    await lockSource(client, current.rejection_number);
    const proposed = {
      rejectionNumber: current.rejection_number,
      debitNoteDate: data.debitNoteDate ?? current.payload?.debitNoteDate,
      remarks: data.remarks ?? current.remarks,
      items: data.items ?? current.payload?.items
    };
    const signature = signatureOf(proposed);
    const claimSignature = claimSignatureOf(proposed);
    await assertNoDuplicateClaim(client, current.rejection_number, claimSignature, number);
    const note = await validateAndBuildDebitNote(client, {
      rejectionNumber: current.rejection_number,
      debitNoteDate: data.debitNoteDate ?? current.payload?.debitNoteDate,
      remarks: data.remarks ?? current.remarks,
      items: proposed.items,
      documents: data.documents ?? current.payload?.documents
    }, req.user, { excludeNumber: number });

    note.debitNoteNumber = number;
    note.createToken = current.payload?.createToken || '';
    note.createSignature = current.payload?.createSignature || signature;
    note.sourceStamp = current.payload?.sourceStamp || note.sourceStamp;
    note.claimSignature = claimSignature;
    note.createdBy = current.created_by || note.createdBy;
    note.createdAt = current.payload?.createdAt || note.createdAt;
    note.history = historyNote(current.payload || {}, 'Debit note updated', `${note.items.length} material(s), ${note.grandTotal}`, req).history;

    const saved = await client.query(
      `UPDATE debit_notes SET debit_note_date=$2,rejection_number=$3,po_number=$4,invoice_number=$5,vendor_name=$6,
         subtotal=$7,total_gst=$8,grand_total=$9,remarks=$10,payload=$11::jsonb,version=version+1,updated_by=$12,updated_at=now()
       WHERE debit_note_number=$1 AND version=$13 RETURNING *`,
      [number, note.debitNoteDate, note.rejectionNumber, note.poNumber, note.invoiceNumber, note.vendor,
        note.subtotal, note.totalGST, note.grandTotal, note.remarks, JSON.stringify(note), req.user.email, version]
    );
    if (!saved.rowCount) throw conflict('Debit Note changed on the server. Reload before editing.');
    await insertDebitNoteItems(client, number, note.items);
    await auditDebitNote(client, req, number, 'UPDATE', current.payload, note);
    return { record: viewDebitNote(saved.rows[0]) };
  }).then((result) => res.json(result));
});

/** Forward workflow transitions. The Audit approval step always requires Admin. */
const TRANSITIONS = Object.freeze({
  submit: { from: [DN_STATUS.DRAFT], to: DN_STATUS.ADMIN_REVIEW, action: 'SUBMIT', permission: 'debitnote.create', stamp: 'requestedBy', at: 'requestedAt', message: 'Debit Note request raised' },
  review: { from: [DN_STATUS.REQUESTED], to: DN_STATUS.PURCHASE_REVIEW, action: 'REVIEW', permission: 'debitnote.record', stamp: 'reviewedBy', at: 'reviewedAt', message: 'Purchase review started' },
  authorise: { from: [DN_STATUS.PURCHASE_REVIEW], to: DN_STATUS.ADMIN_REVIEW, action: 'AUTHORISE', permission: 'debitnote.record', stamp: 'purchaseAuthorizedBy', at: 'purchaseAuthorizedAt', message: 'Purchase authorised the Debit Note' },
  approve: { from: [DN_STATUS.ADMIN_REVIEW], to: DN_STATUS.APPROVED, action: 'APPROVE', permission: 'admin', stamp: 'adminApprovedBy', at: 'adminApprovedAt', message: 'Debit note approved by Admin' },
  issue: { from: [DN_STATUS.APPROVED], to: DN_STATUS.ISSUED, action: 'ISSUE', permission: 'debitnote.record', stamp: 'issuedBy', at: 'issuedAt', message: 'Debit note issued to vendor' },
  send: { from: [DN_STATUS.ISSUED, DN_STATUS.CREATED, DN_STATUS.SENT], to: DN_STATUS.SENT_VENDOR, action: 'SEND_VENDOR', permission: 'debitnote.record', stamp: 'sentToVendorBy', at: 'sentToVendorAt', message: 'Debit note sent to vendor with rejection reasons' },
  close: { from: [DN_STATUS.SENT_VENDOR, DN_STATUS.RECORDED], to: DN_STATUS.CLOSED, action: 'CLOSE', permission: 'debitnote.record', stamp: 'closedBy', at: 'closedAt', message: 'Debit note closed' }
});

const transitionHandler = (explicit) => async (req, res) => {
  authorize(req, explicit ? TRANSITIONS[explicit].permission : 'debitnote.create');
  const number = String(req.params.number);
  const version = versionOf(req.body?.version);
  const requested = explicit || String(req.body?.transition || '');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await lockNote(client, number);
    if (Number(current.version) !== version) throw conflict('Debit Note changed on the server. Reload before continuing.', viewDebitNote(current));

    const transition = explicit ? TRANSITIONS[explicit] : Object.values(TRANSITIONS).find((entry) => entry.from.includes(current.status));
    if (!transition || !transition.from.includes(current.status)) {
      throw conflict(`Debit Note ${number} is "${current.status}" and cannot make that transition.`);
    }
    authorize(req, transition.permission);
    await lockSource(client, current.rejection_number);

    const note = await validateAndBuildDebitNote(client, {
      rejectionNumber: current.rejection_number,
      debitNoteDate: current.payload?.debitNoteDate,
      remarks: current.payload?.remarks,
      items: current.payload?.items,
      documents: current.payload?.documents
    }, req.user, { excludeNumber: number });
    if (transition.action === 'CLOSE') {
      const report = await findRejectionReport(client, current.rejection_number);
      const pending = replacementProgress(report).pendingQty;
      if (pending > 0) throw conflict(`Debit Note ${number} cannot close yet: ${pending} replacement unit(s) have not passed Quality Check.`);
    }

    note.debitNoteNumber = number;
    note.createToken = current.payload?.createToken || '';
    note.createSignature = current.payload?.createSignature || note.claimSignature;
    note.claimSignature = current.payload?.claimSignature || note.claimSignature;
    note.sourceStamp = current.payload?.sourceStamp || note.sourceStamp;
    note.createdBy = current.created_by || note.createdBy;
    note.createdAt = current.payload?.createdAt || note.createdAt;
    note.status = transition.to;
    note[transition.at] = new Date().toISOString();
    note[transition.stamp] = req.user.name || req.user.email;
    note.history = historyNote(current.payload || {}, transition.message, `${note.items.length} material(s), ${note.grandTotal}`, req).history;

    const saved = await client.query(
      `UPDATE debit_notes SET status=$2,payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now()
        WHERE debit_note_number=$1 AND version=$5 RETURNING *`,
      [number, note.status, JSON.stringify(note), req.user.email, version]
    );
    if (!saved.rowCount) throw conflict('Debit Note changed on the server. Reload before continuing.');
    await insertDebitNoteItems(client, number, note.items);
    await auditDebitNote(client, req, number, transition.action, current.payload, note);
    await client.query('COMMIT');
    res.json({ record: viewDebitNote(saved.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const terminalHandler = (action) => async (req, res) => {
  authorize(req, action === 'REJECT' ? ['debitnote.record', 'debitnote.create'] : ['debitnote.create', 'debitnote.record']);
  const number = String(req.params.number);
  const version = versionOf(req.body?.version);
  const reason = String(req.body?.reason || '').trim();
  if (action === 'REJECT' && !reason) throw bad('A rejection reason is required.');

  return transaction(async (client) => {
    const current = await lockNote(client, number);
    if (Number(current.version) !== version) throw conflict('Debit Note changed on the server. Reload before continuing.', viewDebitNote(current));
    if (!isActiveStatus(current.status) || current.status === DN_STATUS.CLOSED) {
      throw conflict(`Debit Note ${number} is "${current.status}" and cannot be ${action === 'REJECT' ? 'rejected' : 'cancelled'}.`);
    }
    const status = action === 'REJECT' ? DN_STATUS.REJECTED : DN_STATUS.CANCELLED;
    const note = {
      ...(current.payload || {}),
      status,
      [`${action === 'REJECT' ? 'rejected' : 'cancelled'}At`]: new Date().toISOString(),
      [`${action === 'REJECT' ? 'rejected' : 'cancelled'}By`]: req.user.name || req.user.email,
      cancelReason: reason,
      updatedAt: new Date().toISOString()
    };
    note.history = historyNote(note, action === 'REJECT' ? 'Debit note rejected' : 'Debit note cancelled', reason || 'No reason recorded', req).history;
    const saved = await client.query(
      `UPDATE debit_notes SET status=$2,payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now()
        WHERE debit_note_number=$1 AND version=$5 RETURNING *`,
      [number, status, JSON.stringify(note), req.user.email, version]
    );
    if (!saved.rowCount) throw conflict('Debit Note changed on the server. Reload before continuing.');
    await auditDebitNote(client, req, number, action, current.payload, note, reason);
    return { record: viewDebitNote(saved.rows[0]) };
  }).then((result) => res.json(result));
};

router.post('/:number/approve', requireWriteAccess, transitionHandler(null));
for (const [name] of Object.entries(TRANSITIONS)) {
  if (name === 'approve') continue;
  router.post(`/:number/${name}`, requireWriteAccess, transitionHandler(name));
}
router.post('/:number/reject', requireWriteAccess, terminalHandler('REJECT'));
router.post('/:number/cancel', requireWriteAccess, terminalHandler('CANCEL'));

router.post('/:number/restore', requireAdmin, async (req, res) => {
  const number = String(req.params.number);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw bad('A restore reason is required.');
  const version = versionOf(req.body?.version);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('debit-note:' || $1))", [number]);
    const current = await client.query(
      'SELECT * FROM debit_notes WHERE debit_note_number=$1 AND deleted_at IS NOT NULL FOR UPDATE',
      [number]
    );
    if (!current.rowCount) throw conflict('Only a soft-deleted Debit Note can be restored.');
    if (Number(current.rows[0].version) !== version) {
      throw conflict('Debit Note changed on the server. Reload before restoring.', viewDebitNote(current.rows[0]));
    }
    const note = {
      ...(current.rows[0].payload || {}),
      status: DN_STATUS.CANCELLED,
      restoredAt: new Date().toISOString(),
      restoredBy: req.user.email,
      history: [
        ...((current.rows[0].payload?.history) || []),
        { action: 'Debit note restored', details: reason, at: new Date().toISOString(), by: req.user.email }
      ]
    };
    const restored = await client.query(
      `UPDATE debit_notes SET deleted_at=NULL,deleted_by=NULL,delete_reason='',status=$2,payload=$3::jsonb,
       version=version+1,updated_by=$4,updated_at=now() WHERE debit_note_number=$1 AND version=$5 RETURNING *`,
      [number, DN_STATUS.CANCELLED, JSON.stringify(note), req.user.email, version]
    );
    await auditDebitNote(client, req, number, 'RESTORE', current.payload, note, reason);
    return { record: viewDebitNote(restored.rows[0]) };
  }).then((result) => res.json(result));
});

router.delete('/:number', requireAdmin, async (req, res) => {
  const number = String(req.params.number);
  const version = versionOf(req.body?.version);
  const reason = String(req.body?.reason || '').trim();
  return transaction(async (client) => {
    const current = await lockNote(client, number);
    if (Number(current.version) !== version) throw conflict('Debit Note changed on the server. Reload before deleting.', viewDebitNote(current));
    const saved = await client.query(
      `UPDATE debit_notes SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_by=$2,updated_at=now()
        WHERE debit_note_number=$1 AND version=$4 RETURNING *`,
      [number, req.user.email, reason, version]
    );
    if (!saved.rowCount) throw conflict('Debit Note changed on the server. Reload before deleting.');
    await auditDebitNote(client, req, number, 'SOFT_DELETE', current.payload, null, reason);
    return { deleted: number };
  }).then((result) => res.json(result));
});

router.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
  if (status === 500) console.error('Debit Notes API error:', error);
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : error.message,
    ...(error.current ? { current: error.current } : {})
  });
});

export default router;
