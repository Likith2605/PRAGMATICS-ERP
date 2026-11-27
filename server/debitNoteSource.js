/**
 * Debit Note domain helpers.
 *
 * The business rules here mirror src/utils/workflowService.js (section 14A):
 * a Debit Note is a financial claim against rejected material, priced ONLY from
 * the original Purchase Order, anchored on a Material Arrival or Material
 * Receipt, and able to claim any still-unclaimed part of a rejected line.
 * Legacy rejection/arrival/PO records are read-only: this file never writes them.
 */
import { numberToWords } from '../src/utils/numberToWords.js';
import { safeAuditValues } from './auth.js';

export const DN_STATUS = Object.freeze({
  DRAFT: 'Draft',
  REQUESTED: 'Requested',
  PURCHASE_REVIEW: 'Purchase Review',
  ADMIN_REVIEW: 'Admin Approval',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  SENT_VENDOR: 'Sent to Vendor',
  CLOSED: 'Closed',
  CREATED: 'Created',
  SENT: 'Sent to Purchase',
  RECORDED: 'Recorded by Purchase',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled'
});

/** Mirrors DEBIT_NOTE_COMMITTED_STATUSES in workflowService.js. */
export const COMMITTED_STATUSES = Object.freeze([
  DN_STATUS.REQUESTED,
  DN_STATUS.PURCHASE_REVIEW,
  DN_STATUS.ADMIN_REVIEW,
  DN_STATUS.APPROVED,
  DN_STATUS.ISSUED,
  DN_STATUS.SENT_VENDOR,
  DN_STATUS.CLOSED,
  DN_STATUS.CREATED,
  DN_STATUS.SENT,
  DN_STATUS.RECORDED
]);

const TERMINAL_STATUSES = Object.freeze([DN_STATUS.CANCELLED, DN_STATUS.REJECTED]);
const VALID_NUMBER = /^[A-Za-z0-9._/-]{1,100}$/;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const bad = (message) => Object.assign(new Error(message), { status: 400 });
export const notFound = (message) => Object.assign(new Error(message), { status: 404 });
export const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });

export const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const round2 = (value) => Number((Number(value) || 0).toFixed(2));
export const lineKey = (line) => String(line?.materialCode || line?.itemCode || line?.materialName || line?.itemName || '').trim().toLowerCase();

/** Reads a field from either a flat record, a legacy {payload} record, or a DB row. */
const deep = (record, field, depth = 4) => {
  let current = record;
  for (let step = 0; step < depth && current; step += 1) {
    if (current[field] !== undefined && current[field] !== null) return current[field];
    current = current.payload || current.data;
    if (current && typeof current !== 'object') return undefined;
  }
  return undefined;
};
const asList = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();
const identity = (record) => text(deep(record, 'rejectionNumber') || deep(record, 'debitNoteNumber') || deep(record, 'reference') || record?.__recordId);

const stateList = async (executor, key, lock = 'FOR SHARE') => {
  const result = await executor.query(`SELECT data FROM erp_state WHERE storage_key=$1 ${lock}`, [key]);
  return asList(result.rows[0]?.data);
};

const moduleRows = async (executor, key, lock = 'FOR SHARE') => {
  const result = await executor.query(`SELECT record_id,data FROM module_records WHERE storage_key=$1 ${lock}`, [key]);
  return result.rows.map((row) => ({
    ...(row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : { data: row.data }),
    __recordId: row.record_id,
    __moduleData: row.data
  }));
};

const uniqueBy = (records, keyOf) => {
  const seen = new Set();
  return records.filter((record) => {
    const key = keyOf(record);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const findByNumber = (records, number, fields) => {
  const target = text(number).toLowerCase();
  if (!target) return null;
  return records.find((record) => fields.some((field) => text(deep(record, field) || record?.[field]).toLowerCase() === target)) || null;
};

export const allRejectionReports = async (executor) => {
  const [state, records] = await Promise.all([
    stateList(executor, 'rejectionReports'),
    moduleRows(executor, 'rejectionReports')
  ]);
  return uniqueBy([...records, ...state], (report) => text(deep(report, 'rejectionNumber')).toLowerCase());
};

export const findRejectionReport = async (executor, rejectionNumber) =>
  findByNumber(await allRejectionReports(executor), rejectionNumber, ['rejectionNumber', 'reference']);

const findPurchaseOrder = async (executor, poNumber) => {
  const target = text(poNumber);
  if (!target) return null;
  const db = await executor.query('SELECT po_number,payload,status FROM purchase_orders WHERE po_number=$1 AND deleted_at IS NULL FOR SHARE', [target]);
  if (db.rowCount) return { record: db.rows[0].payload, status: db.rows[0].status, source: 'purchase_orders' };
  const [state, records] = await Promise.all([
    stateList(executor, 'supplierPOHistory'),
    moduleRows(executor, 'supplierPOHistory')
  ]);
  const legacy = findByNumber([...records, ...state], target, ['poNumber', 'reference', 'po_number']);
  if (!legacy) return null;
  return {
    record: legacy.__moduleData || legacy,
    status: text(deep(legacy, 'status') || deep(legacy, 'poStatus')),
    source: legacy.__recordId ? 'module_records' : 'erp_state'
  };
};

const findReceipt = async (executor, receiptNumber) => {
  const target = text(receiptNumber);
  if (!target) return null;
  const db = await executor.query('SELECT receipt_number,payload FROM material_receipts WHERE receipt_number=$1 AND deleted_at IS NULL FOR SHARE', [target]);
  if (db.rowCount) return db.rows[0].payload;
  const [state, records] = await Promise.all([
    stateList(executor, 'materialReceipts'),
    moduleRows(executor, 'materialReceipts')
  ]);
  return findByNumber([...records, ...state], target, ['receiptNumber', 'reference', 'receipt_number']);
};

const findArrival = async (executor, arrivalNumber) => {
  const target = text(arrivalNumber);
  if (!target) return null;
  const [state, records] = await Promise.all([
    stateList(executor, 'materialArrivals'),
    moduleRows(executor, 'materialArrivals')
  ]);
  return findByNumber([...records, ...state], target, ['arrivalNumber', 'reference']);
};

const findQualityCheck = async (executor, qcNumber) => {
  const target = text(qcNumber);
  if (!target) return null;
  const db = await executor.query('SELECT qc_number,payload FROM material_receipt_inspections WHERE qc_number=$1 FOR SHARE', [target]);
  if (db.rowCount) return db.rows[0].payload;
  const [state, records] = await Promise.all([
    stateList(executor, 'qualityChecks'),
    moduleRows(executor, 'qualityChecks')
  ]);
  return findByNumber([...records, ...state], target, ['qcNumber', 'reference']);
};

const findPOItem = (poItems, line) => {
  const code = text(line.materialCode || line.itemCode).toLowerCase();
  return poItems.find((item) => code && text(item.itemCode || item.materialCode).toLowerCase() === code) ||
    poItems.find((item) => text(item.itemName || item.materialName).toLowerCase() === text(line.materialName || line.itemName).toLowerCase()) ||
    null;
};

/** Quantities already claimed by committed Debit Notes, excluding one note being edited. */
const debitedQuantities = async (executor, rejectionNumber, excludeNumber = '') => {
  const result = await executor.query(
    `SELECT i.payload,i.debit_qty
       FROM debit_note_items i
       JOIN debit_notes n ON n.debit_note_number=i.debit_note_number
      WHERE n.rejection_number=$1 AND n.deleted_at IS NULL
        AND n.status = ANY($2::text[]) AND n.debit_note_number <> $3
      FOR SHARE OF i,n`,
    [rejectionNumber, [...COMMITTED_STATUSES], excludeNumber || '__none__']
  );
  const claimed = new Map();
  for (const row of result.rows) {
    const key = lineKey(row.payload || {});
    claimed.set(key, num(claimed.get(key)) + num(row.debit_qty));
  }
  return claimed;
};

/**
 * Build the exact form context the Debit Notes page needs, resolved from
 * PostgreSQL. `requireSource` / `requirePO` are relaxed for read-only candidate
 * and migration screens so incomplete legacy records remain visible there.
 */
export const buildDebitNoteContext = async (executor, rejectionNumber, {
  excludeNumber = '',
  requireSource = true,
  requirePO = true
} = {}) => {
  const report = await findRejectionReport(executor, rejectionNumber);
  if (!report) throw notFound(`Rejection Report ${rejectionNumber} not found.`);

  const [arrival, receipt, qc, claimed] = await Promise.all([
    report.arrivalNumber ? findArrival(executor, report.arrivalNumber) : Promise.resolve(null),
    report.receiptNumber ? findReceipt(executor, report.receiptNumber) : Promise.resolve(null),
    report.qcNumber ? findQualityCheck(executor, report.qcNumber) : Promise.resolve(null),
    debitedQuantities(executor, text(deep(report, 'rejectionNumber')), excludeNumber)
  ]);
  if (requireSource && !arrival && !receipt) {
    throw conflict(
      `Rejection Report ${rejectionNumber} is not linked to a Material Arrival. Record the arrival that delivered the rejected material before raising a Debit Note.`
    );
  }

  const poNumber = text(deep(report, 'poNumber'));
  const po = poNumber ? await findPurchaseOrder(executor, poNumber) : null;
  if (requirePO && !po) throw conflict(`Purchase Order ${poNumber || '(not linked)'} not found — original PO pricing is required.`);

  const poItems = asList(deep(po?.record, 'items'));
  const lines = asList(deep(report, 'items'))
    .map((line) => {
      const rejectedQty = num(deep(line, 'rejectedQty') ?? line.rejectedQty);
      const key = lineKey(line);
      const debitedQty = num(claimed.get(key));
      const poItem = findPOItem(poItems, line);
      const rawPrice = poItem ? (poItem.unitPrice ?? poItem.rate ?? poItem.price) : undefined;
      const rawGst = poItem ? (poItem.gst ?? poItem.gstRate ?? poItem.gstPercent) : undefined;
      const vendorDetails = deep(po?.record, 'vendorDetails') || {};
      return {
        materialCode: text(deep(line, 'materialCode') || poItem?.itemCode || poItem?.materialCode),
        materialName: text(deep(line, 'materialName') || poItem?.itemName || poItem?.materialName),
        unit: text(deep(line, 'unit') || poItem?.unit || 'Nos'),
        hsnSac: text(poItem?.hsnSac || poItem?.hsn || ''),
        reason: text(deep(line, 'reason') || deep(line, 'rejectionReason')),
        rejectedQty,
        debitedQty,
        remainingQty: Math.max(0, round2(rejectedQty - debitedQty)),
        unitPrice: num(rawPrice),
        gstPercent: num(rawGst),
        priceMissing: !poItem || rawPrice === '' || rawPrice === null || rawPrice === undefined,
        gstMissing: !poItem || rawGst === '' || rawGst === null || rawGst === undefined,
        vendorGstNumber: text(vendorDetails.gstNumber || deep(arrival, 'vendorGstNumber') || deep(receipt, 'vendorGstNumber'))
      };
    })
    .filter((line) => line.rejectedQty > 0);

  const vendorDetails = deep(po?.record, 'vendorDetails') || {};
  const vendor = text(
    deep(report, 'vendor') || deep(arrival, 'vendor') || deep(receipt, 'vendor') ||
    vendorDetails.companyName || vendorDetails.vendorName
  );
  const invoiceNumber = text(
    deep(report, 'invoiceNumber') || deep(receipt, 'invoiceNumber') ||
    deep(arrival, 'invoiceNumber') || deep(qc, 'invoiceNumber')
  );

  return {
    rejection: report,
    rejectionNumber: text(deep(report, 'rejectionNumber')),
    rejectionDate: text(deep(report, 'rejectionDate')),
    qc,
    qcNumber: text(deep(report, 'qcNumber')),
    arrival,
    arrivalNumber: text(deep(report, 'arrivalNumber')),
    receipt,
    receiptNumber: text(deep(report, 'receiptNumber') || deep(receipt, 'receiptNumber')),
    hasArrival: Boolean(arrival),
    hasReceipt: Boolean(receipt),
    hasSource: Boolean(arrival || receipt),
    po: po?.record || null,
    poNumber,
    vendor,
    vendorDetails: {
      name: vendor,
      gstNumber: text(vendorDetails.gstNumber || deep(arrival, 'vendorGstNumber') || deep(receipt, 'vendorGstNumber')),
      address: text(vendorDetails.address || deep(arrival, 'vendorAddress') || deep(receipt, 'vendorAddress'))
    },
    invoiceNumber,
    invoiceDate: text(deep(receipt, 'invoiceDate')),
    lines,
    totalRejectedQty: round2(lines.reduce((sum, line) => sum + line.rejectedQty, 0)),
    totalDebitedQty: round2(lines.reduce((sum, line) => sum + line.debitedQty, 0)),
    totalRemainingQty: round2(lines.reduce((sum, line) => sum + line.remainingQty, 0)),
    fullyDebited: lines.length > 0 && lines.every((line) => line.remainingQty <= 0)
  };
};

export const replacementProgress = (report) => {
  const lines = asList(deep(report, 'items'));
  const rejectedQty = num(deep(report, 'rejectedTotal') ?? lines.reduce((sum, line) => sum + num(deep(line, 'rejectedQty')), 0));
  const replacementQty = num(deep(report, 'replacementQty') ?? lines.reduce((sum, line) => sum + num(deep(line, 'replacementQty')), 0));
  const pendingQty = Math.max(0, num(
    deep(report, 'pendingReplacementQty') ??
    lines.reduce((sum, line) => sum + Math.max(0, num(deep(line, 'rejectedQty')) - num(deep(line, 'replacementQty'))), 0)
  ));
  return { rejectedQty, replacementQty, pendingQty };
};

/**
 * Validate and price a proposed note. All derived amounts are recomputed here;
 * client supplied amounts are deliberately ignored.
 */
export const validateAndBuildDebitNote = async (executor, input, actor = {}, options = {}) => {
  const rejectionNumber = text(input?.rejectionNumber);
  if (!rejectionNumber) throw bad('Select the Rejection Report this Debit Note belongs to.');
  const debitNoteDate = text(input?.debitNoteDate);
  if (!VALID_DATE.test(debitNoteDate)) throw bad('Debit Note date must use YYYY-MM-DD format.');

  const context = await buildDebitNoteContext(executor, rejectionNumber, options);
  if (!context.lines.length) throw bad(`Rejection Report ${rejectionNumber} has no rejected quantity.`);

  const requested = asList(input?.items).filter((item) => num(item?.debitQty) > 0);
  if (!requested.length) throw bad('Enter a debit quantity for at least one material.');

  const seen = new Set();
  const items = requested.map((requestedItem) => {
    const key = lineKey(requestedItem);
    const line = context.lines.find((candidate) => lineKey(candidate) === key);
    if (!line) throw bad(`"${text(requestedItem.materialName || requestedItem.materialCode) || key}" is not a rejected line on Rejection Report ${rejectionNumber}.`);
    if (seen.has(key)) throw bad(`"${line.materialName}" is listed twice on the Debit Note.`);
    seen.add(key);

    const debitQty = num(requestedItem.debitQty);
    if (!Number.isFinite(debitQty) || debitQty <= 0) throw bad(`Debit quantity for "${line.materialName}" must be greater than zero.`);
    if (debitQty > line.remainingQty + 1e-9) {
      throw bad(`Debit quantity for "${line.materialName}" is ${debitQty} but only ${line.remainingQty} ${line.unit} of the ${line.rejectedQty} rejected is still unclaimed.`);
    }
    if (line.priceMissing) throw bad(`Purchase Order ${context.poNumber} has no rate for "${line.materialName}". Add the PO rate before raising a Debit Note.`);
    if (line.gstMissing) throw bad(`Purchase Order ${context.poNumber} has no GST rate for "${line.materialName}". Add the GST rate before raising a Debit Note — it cannot be assumed.`);

    const amount = round2(debitQty * line.unitPrice);
    const gstAmount = round2((amount * line.gstPercent) / 100);
    return {
      materialCode: line.materialCode,
      materialName: line.materialName,
      unit: line.unit,
      hsnSac: line.hsnSac,
      reason: line.reason,
      rejectedQty: line.rejectedQty,
      previouslyDebitedQty: line.debitedQty,
      remainingBeforeThisNote: line.remainingQty,
      debitQty,
      unitPrice: line.unitPrice,
      gstPercent: line.gstPercent,
      amount,
      gstAmount,
      cgstAmount: round2(gstAmount / 2),
      sgstAmount: round2(gstAmount / 2),
      lineTotal: round2(amount + gstAmount)
    };
  });

  const subtotal = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const totalGST = round2(items.reduce((sum, item) => sum + item.gstAmount, 0));
  const cgst = round2(totalGST / 2);
  const grandTotal = round2(subtotal + totalGST);
  const claimSignature = items
    .map((item) => `${lineKey(item)}:${Number(item.debitQty.toFixed(4))}`)
    .sort()
    .join('|');
  const poDate = text(deep(context.po, 'date') || deep(context.po, 'poDate') || deep(context.po, 'createdAt'));

  return {
    debitNoteDate,
    status: DN_STATUS.DRAFT,
    rejectionNumber: context.rejectionNumber,
    rejectionDate: context.rejectionDate,
    qcNumber: context.qcNumber,
    qcDate: text(deep(context.qc, 'inspectionDate')),
    inspector: text(deep(deep(context.report || {}, 'inspector') || context.qc?.inspector)),
    receiptNumber: context.receiptNumber,
    receiptDate: text(deep(context.receipt, 'createdAt')),
    invoiceNumber: context.invoiceNumber,
    invoiceDate: context.invoiceDate,
    poNumber: context.poNumber,
    poDate,
    indentNumber: text(deep(context.rejection, 'indentNumber')),
    soNumber: text(deep(context.rejection, 'soNumber')),
    projectId: text(deep(context.rejection, 'projectId')),
    vendor: context.vendor,
    vendorGstNumber: context.vendorDetails.gstNumber,
    vendorAddress: context.vendorDetails.address,
    qualityRemarks: text(deep(context.rejection, 'qualityRemarks')),
    rejectionRemarks: text(deep(context.rejection, 'forwardRemarks') || deep(context.rejection, 'vendorRemarks')),
    remarks: text(input?.remarks),
    documents: asList(input?.documents),
    items,
    subtotal,
    taxableAmount: subtotal,
    totalGST,
    cgst,
    sgst: round2(totalGST - cgst),
    grandTotal,
    totalDebitQty: round2(items.reduce((sum, item) => sum + item.debitQty, 0)),
    amountInWords: `${numberToWords(grandTotal)} only`,
    claimSignature,
    sourceStamp: {
      rejectionNumber: context.rejectionNumber,
      rejectionDate: context.rejectionDate,
      poNumber: context.poNumber,
      qcNumber: context.qcNumber,
      receiptNumber: context.receiptNumber,
      vendor: context.vendor,
      stampedAt: new Date().toISOString(),
      stampedBy: text(actor.email || actor.name || 'ERP user')
    },
    createdBy: text(actor.name || actor.email || 'ERP user'),
    createdByDept: text(actor.department || ''),
    updatedAt: new Date().toISOString(),
    history: []
  };
};

/** Next DN-000001 style number, compatible with the legacy browser sequencer. */
export const nextDebitNoteNumber = async (executor) => {
  await executor.query("SELECT pg_advisory_xact_lock(hashtext('debit-note-sequence'))");
  const [sequence, db, counter, legacyCounter, legacyNotes, moduleNotes] = await Promise.all([
    executor.query("SELECT last_number FROM procurement_sequences WHERE sequence_key='debitNote' FOR UPDATE"),
    executor.query("SELECT COALESCE(max((regexp_match(debit_note_number,'([0-9]+)$'))[1]::bigint),0) AS n FROM debit_notes"),
    executor.query("SELECT data FROM erp_state WHERE storage_key='debitNoteSequence' FOR UPDATE"),
    executor.query("SELECT data FROM module_records WHERE storage_key='debitNoteSequence' FOR UPDATE"),
    executor.query("SELECT data FROM erp_state WHERE storage_key='debitNotes' FOR SHARE"),
    executor.query("SELECT data FROM module_records WHERE storage_key='debitNotes' FOR SHARE")
  ]);
  let max = Math.max(num(sequence.rows[0]?.last_number), num(db.rows[0]?.n));
  const counters = [counter.rows[0]?.data, ...moduleNotes.rows.map((row) => row?.data)];
  for (const value of counters) {
    const match = String(value ?? '').match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const suffix = (value) => {
    const match = String(value ?? '').match(/(\d+)\s*$/);
    return match ? Number(match[1]) : 0;
  };
  for (const row of legacyNotes.rows) {
    for (const note of asList(row?.data)) max = Math.max(max, suffix(note?.debitNoteNumber || note?.reference || note?.payload?.debitNoteNumber));
  }
  for (const row of moduleNotes.rows) {
    for (const note of asList(row?.data)) max = Math.max(max, suffix(note?.debitNoteNumber || note?.reference || note?.payload?.debitNoteNumber));
  }
  const next = max + 1;
  await executor.query(
    `INSERT INTO procurement_sequences(sequence_key,last_number,updated_at) VALUES('debitNote',$1,now())
     ON CONFLICT(sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`,
    [next]
  );
  return `DN-${String(next).padStart(6, '0')}`;
};

export const rememberDebitNoteNumber = async (executor, number) => {
  /* Only reserve canonical DN-000001 style numbers. Arbitrary legacy IDs may
   * end in hex digits (e.g. DN-LEGACY-9ca40fe5) and must not jump the sequence. */
  const suffix = String(number || '').trim().match(/^DN[-_](\d{4,})$/i)?.[1];
  if (!suffix) return;
  await executor.query(
    `INSERT INTO procurement_sequences(sequence_key,last_number,updated_at) VALUES('debitNote',$1,now())
     ON CONFLICT(sequence_key) DO UPDATE SET last_number=GREATEST(procurement_sequences.last_number,EXCLUDED.last_number),updated_at=now()`,
    [Number(suffix)]
  );
};

export const insertDebitNoteItems = async (executor, number, items) => {
  await executor.query('DELETE FROM debit_note_items WHERE debit_note_number=$1', [number]);
  for (const [index, item] of asList(items).entries()) {
    await executor.query(
      `INSERT INTO debit_note_items(debit_note_number,line_number,material_code,material_name,debit_qty,unit_price,taxable_amount,gst_rate,gst_amount,total_amount,unit,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [number, index + 1, text(item.materialCode), text(item.materialName), num(item.debitQty), num(item.unitPrice),
        num(item.amount), num(item.gstPercent), num(item.gstAmount), num(item.lineTotal), text(item.unit) || 'Nos', JSON.stringify(item)]
    );
  }
};

export const auditDebitNote = (executor, req, number, action, before, after, reason = '') => executor.query(
  `INSERT INTO debit_note_audit(debit_note_number,action,actor_id,actor_email,actor_role,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [number, action, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', text(reason),
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);

export const viewDebitNote = (row) => {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const dateValue = row.debit_note_date;
  const dateText = dateValue instanceof Date
    ? `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}-${String(dateValue.getDate()).padStart(2, '0')}`
    : String(dateValue || '').slice(0, 10);
  return {
    ...payload,
    debitNoteNumber: row.debit_note_number,
    debitNoteDate: payload.debitNoteDate || dateText,
    rejectionNumber: row.rejection_number || '',
    poNumber: row.po_number || '',
    invoiceNumber: row.invoice_number || '',
    vendorId: row.vendor_id || '',
    vendorName: row.vendor_name || '',
    subtotal: Number(row.subtotal),
    taxableAmount: Number(row.subtotal),
    totalGST: Number(row.total_gst),
    grandTotal: Number(row.grand_total),
    status: row.status,
    remarks: row.remarks || '',
    createdBy: row.created_by || payload.createdBy || '',
    updatedBy: row.updated_by || '',
    version: Number(row.version),
    recordVersion: Number(row.version),
    createdAt: row.created_at?.toISOString?.() || payload.createdAt || '',
    updatedAt: row.updated_at?.toISOString?.() || payload.updatedAt || '',
    deletedAt: row.deleted_at?.toISOString?.() || null,
    deletedBy: row.deleted_by || null,
    deleteReason: row.delete_reason || '',
    items: asList(payload.items)
  };
};

export const isActiveStatus = (status) => !TERMINAL_STATUSES.includes(status);
export const isValidNumber = (value) => VALID_NUMBER.test(text(value));
export const isValidDate = (value) => VALID_DATE.test(text(value));
export const stampHistory = (note, action, details, actor) => ({
  ...note,
  history: [...asList(note.history), {
    action,
    details,
    at: new Date().toISOString(),
    by: text(actor?.name || actor?.email || 'ERP user'),
    dept: text(actor?.department || '')
  }],
  updatedAt: new Date().toISOString()
});
