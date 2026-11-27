import express from 'express';
import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { hasPermissionForRole } from './departmentAccess.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { reconcilePurchaseOrderProgress } from './purchaseOrderReconciliation.js';
import { writeAudit } from './productionSupport.js';

const router = express.Router();
const definitions = {
  purchaseIndent: { table: 'purchase_indents', id: 'indent_number', legacy: 'purchaseIndents', key: 'indentNumber', sequence: 'purchaseIndent', prefix: 'IND', permissions: ['indent.view', 'indent.create', 'indent.edit', 'indent.submit', 'indent.review', 'indent.admin_approve'] },
  vendorEnquiry: { table: 'vendor_enquiries', id: 'enquiry_number', legacy: 'vendorEnquiries', key: 'enquiryNumber', sequence: 'vendorEnquiry', prefix: 'VE', permissions: ['purchase_request.view', 'purchase_request.create', 'purchase_request.approve'] },
  vendorQuotation: { table: 'vendor_quotations', id: 'quotation_number', legacy: 'vendorQuotations', key: 'quotationNumber', sequence: 'vendorQuotation', prefix: 'VQ', permissions: ['purchase_request.view', 'purchase_request.create', 'purchase_request.approve'] }
};
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const authorize = (req, permissions) => {
  if (!isAdmin(req) && !hasPermissionForRole(req.user?.roleKey, permissions, req.user?.rolePermissions)) {
    throw Object.assign(new Error('Your selected department role does not allow this operation.'), { status: 403 });
  }
};
const definition = (kind) => {
  const value = definitions[kind];
  if (!value) throw Object.assign(new Error('Unknown procurement record type.'), { status: 404 });
  return value;
};
const idOf = (d, payload) => String(payload?.[d.key] || '').trim();
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const validate = (kind, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bad(`${kind} data is required.`);
  const d = definition(kind); const id = idOf(d, payload);
  if (!id || id.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(id)) throw bad(`A valid ${d.key} is required.`);
  if (Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024) throw Object.assign(new Error('Record exceeds the 8 MB limit.'), { status: 413 });
  if (kind === 'purchaseIndent') {
    if (!Array.isArray(payload.items) || !payload.items.length) throw bad('A Purchase Indent must contain at least one material.');
    if (payload.items.some((item) => !String(item?.materialName || '').trim() || !(Number(item?.purchaseQty) > 0))) throw bad('Every Purchase Indent line must have a material name and positive purchase quantity.');
  }
  if (kind === 'vendorEnquiry' && (!Array.isArray(payload.items) || !payload.items.length || !String(payload.prNumber || payload.indentNumber || '').trim())) throw bad('Vendor Enquiry must reference an indent or purchase request and contain material lines.');
  if (kind === 'vendorQuotation' && (!String(payload.enquiryNumber || '').trim() || !String(payload.vendorName || '').trim() || !Array.isArray(payload.items) || !payload.items.length)) throw bad('Vendor Quotation requires an enquiry, vendor and item lines.');
  return id;
};
const view = (row, d) => ({ ...row.payload, recordVersion: Number(row.version), version: Number(row.version), updatedAt: row.updated_at?.toISOString?.() || row.payload.updatedAt });
const readRecord = async (db, d, id, lock = false) => {
  const result = await db.query(`SELECT * FROM ${d.table} WHERE ${d.id}=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return result.rows[0] || null;
};
const audit = (client, req, kind, id, action, before, after, reason = '') => client.query(
  `INSERT INTO procurement_record_audit(entity_type,record_id,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
  [kind, id, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const linkProductionRequirementIndent = async (client, req, indent) => {
  if (indent.sourceType !== 'productionRequirement') return;
  const requirementNumber = String(indent.requirementNumber || '').trim();
  if (!requirementNumber) throw bad('A Production Requirement reference is required for this Purchase Indent.');

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`production-requirement-indent:${requirementNumber}`]);
  const result = await client.query(
    'SELECT * FROM production_requirements WHERE requirement_number=$1 AND deleted_at IS NULL FOR UPDATE',
    [requirementNumber]
  );
  const current = result.rows[0];
  if (!current) throw conflict(`Production Requirement ${requirementNumber} is unavailable in PostgreSQL.`);
  if (!['Shortage Identified', 'Purchase Required'].includes(String(current.status))) {
    throw conflict(`Production Requirement ${requirementNumber} must have an approved Store shortage review before raising an indent.`);
  }

  const currentPayload = current.payload || {};
  const lineRows = await client.query(
    'SELECT payload FROM production_requirement_items WHERE requirement_number=$1 ORDER BY line_number',
    [requirementNumber]
  );
  const requirementLines = new Map(lineRows.rows.map((row) => {
    const line = row.payload?.payload || row.payload || {};
    return [String(line.lineId || ''), line];
  }).filter(([lineId]) => lineId));
  const reviewLines = currentPayload.storeReview?.lines || {};
  const existingIndents = await client.query(
    `SELECT status,payload FROM purchase_indents
     WHERE deleted_at IS NULL AND payload->>'sourceType'='productionRequirement'
       AND payload->>'requirementNumber'=$1 AND indent_number<>$2 FOR UPDATE`,
    [requirementNumber, String(indent.indentNumber)]
  );
  const indentedByLine = new Map();
  const lineIdFor = (line) => {
    if (line.lineId && requirementLines.has(String(line.lineId))) return String(line.lineId);
    const code = String(line.materialCode || line.itemCode || '').trim().toLowerCase();
    if (!code) return '';
    for (const [lineId, item] of requirementLines) {
      if (String(item.itemCode || item.materialCode || '').trim().toLowerCase() === code) return lineId;
    }
    return '';
  };
  for (const row of existingIndents.rows) {
    if (String(row.status).toLowerCase() === 'cancelled') continue;
    for (const line of row.payload?.items || []) {
      const lineId = lineIdFor(line);
      if (lineId) indentedByLine.set(lineId, (indentedByLine.get(lineId) || 0) + Number(line.purchaseQty || 0));
    }
  }

  const requestedLines = new Set();
  for (const line of indent.items || []) {
    const lineId = String(line.lineId || '');
    const requirementLine = requirementLines.get(lineId);
    const shortage = Number(reviewLines[lineId]?.shortageQty);
    const requested = Number(line.purchaseQty);
    if (!requirementLine || !Number.isFinite(shortage) || shortage <= 0 || !Number.isFinite(requested) || requested <= 0) {
      throw conflict('Purchase Indent lines must reference a reviewed Production Requirement shortage.');
    }
    if (requestedLines.has(lineId)) throw conflict('A Production Requirement line can appear only once in a Purchase Indent.');
    requestedLines.add(lineId);
    if ((indentedByLine.get(lineId) || 0) + requested > shortage + 0.00005) {
      throw conflict(`Purchase Indent quantity exceeds the remaining shortage for line ${lineId}.`);
    }
  }
  if (!requestedLines.size) throw bad('A Production Requirement Purchase Indent must contain reviewed shortage lines.');

  const now = new Date().toISOString();
  const nextPayload = {
    ...currentPayload,
    indentNumbers: Array.from(new Set([...(currentPayload.indentNumbers || []), String(indent.indentNumber)])),
    status: 'Purchase Required',
    updatedAt: now,
    history: [
      ...(currentPayload.history || []),
      { action: 'Purchase Indent created', details: `Indent ${indent.indentNumber}`, user: String(req.user?.email || ''), at: now }
    ]
  };
  await client.query(
    `UPDATE production_requirements
     SET status='Purchase Required',payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3
     WHERE requirement_number=$1`,
    [requirementNumber, JSON.stringify(nextPayload), String(req.user?.email || '')]
  );
  await writeAudit(client, req, {
    table: 'erp_audit_log',
    idColumn: 'record_id',
    id: requirementNumber,
    action: 'PURCHASE_INDENT_CREATED',
    before: currentPayload,
    after: nextPayload,
    module: 'production_requirements'
  });
};
const authorizePurchaseOrder = (req) => authorize(req, ['purchase.order']);
const poView = (row) => ({
  ...row.payload,
  version: Number(row.version),
  recordVersion: Number(row.version),
  updatedAt: row.updated_at?.toISOString?.() || row.payload.updatedAt
});
const poAudit = (client, req, poNumber, action, before, after, reason = '') => client.query(
  `INSERT INTO purchase_order_audit(po_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [poNumber, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const supplierInvoiceSettled = (record, advanceAdjusted = 0, advanceAdjustedINR = 0) => {
  const payload = record?.payload || {};
  const details = payload.invoiceDetails || {};
  const total = Number(payload.totals?.grandTotal) || 0;
  const paid = Number(details.amountPaid) || 0;
  if (paid + advanceAdjusted > total + 0.00005) throw bad('Payments and advance allocations cannot exceed the Supplier Invoice total.');
  const balanceDue = Math.max(0, total - paid - advanceAdjusted);
  const status = balanceDue <= 0.00005 ? 'Paid' : paid + advanceAdjusted > 0 ? 'Partial' : 'Pending';
  return {
    ...record,
    status,
    advanceAdjusted,
    advanceAdjustedINR,
    balanceDue: `₹ ${balanceDue.toFixed(2)}`,
    payload: {
      ...payload,
      invoiceDetails: { ...details, advanceAdjusted, advanceAdjustedINR, balanceDue, paymentStatus: status },
      advanceAdjustedINR,
      balanceINR: Math.max(0, (Number(payload.amountINR) || total) - (Number(payload.receivedINR) || paid) - advanceAdjustedINR)
    }
  };
};
const supplierInvoiceView = (row) => ({
  ...supplierInvoiceSettled(row.payload, Number(row.advance_adjusted) || 0, Number(row.advance_adjusted_inr) || 0),
  version: Number(row.version),
  recordVersion: Number(row.version),
  updatedAt: row.updated_at?.toISOString?.() || row.payload.updatedAt
});
const supplierInvoiceComparable = (value) => {
  const {
    version, recordVersion, advanceAdjusted, advanceAdjustedINR, balanceDue, ...stable
  } = value || {};
  const payload = { ...(stable.payload || {}) };
  delete payload.advanceAdjustedINR;
  delete payload.balanceINR;
  const invoiceDetails = { ...(payload.invoiceDetails || {}) };
  delete invoiceDetails.advanceAdjusted;
  delete invoiceDetails.advanceAdjustedINR;
  delete invoiceDetails.balanceDue;
  delete invoiceDetails.paymentStatus;
  return canonical({ ...stable, payload: { ...payload, invoiceDetails } });
};
const optionalReference = (value) => {
  const text = String(value || '').trim();
  return ['', '-', '—'].includes(text) ? '' : text;
};
const supplierInvoiceAudit = (client, req, number, action, before, after, reason = '') => client.query(
  `INSERT INTO supplier_invoice_audit(invoice_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [number, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const validateSupplierInvoice = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !String(record.reference || '').trim() || !record.payload?.invoiceDetails || !record.payload?.vendorDetails) throw bad('Supplier Invoice number, invoice details and supplier details are required.');
  if (!String(record.payload.invoiceDetails.supplierInvoiceNumber || '').trim()) throw bad('Supplier Bill Number is required.');
  if (!String(record.vendor || record.payload.vendorDetails.companyName || record.payload.vendorDetails.vendorName || '').trim()) throw bad('Supplier name is required.');
  if (!Array.isArray(record.payload.items) || !record.payload.items.length) throw bad('Supplier Invoice must contain at least one item.');
  if (record.payload.items.some((item) => !(Number(item.quantity) > 0) || !(Number(item.unitPrice) >= 0))) throw bad('Supplier Invoice item quantities and prices are invalid.');
  if (Number(record.payload.invoiceDetails.amountPaid || 0) < 0 || Number(record.payload.invoiceDetails.amountPaid || 0) > Number(record.payload.totals?.grandTotal || 0) + 0.00005) throw bad('Supplier Invoice payments cannot exceed its total.');
  return String(record.reference).trim();
};

router.get('/supplier-invoices/migration-preview', requireAdmin, async (req, res) => {
  const legacy = await getPool().query("SELECT data FROM erp_state WHERE storage_key='supplierInvoiceHistory'");
  const rows = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const current = await getPool().query('SELECT invoice_number,payload FROM supplier_invoices');
  const byId = new Map(current.rows.map((row) => [row.invoice_number, row.payload]));
  const result = { eligible: [], existing: [], conflicts: [], invalid: [] };
  for (const row of rows) {
    const id = String(row?.reference || '').trim();
    if (!id || !row?.payload || !Array.isArray(row.payload.items)) { result.invalid.push({ record: row, reason: 'Missing invoice number or required payload.' }); continue; }
    if (!byId.has(id)) { result.eligible.push(row); continue; }
    if (supplierInvoiceComparable(byId.get(id)) === supplierInvoiceComparable(row)) result.existing.push(row);
    else result.conflicts.push({ record: row, databaseRecord: byId.get(id) });
  }
  res.json({ counts: Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])), ...result });
});
router.post('/supplier-invoices/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const requested = req.body?.records;
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000) throw bad('Select one or more Supplier Invoice records from the preview to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='supplierInvoiceHistory' FOR SHARE");
    const source = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    const approved = new Map(source.filter((row) => requested.includes(String(row?.reference || ''))).map((row) => [String(row.reference), row]));
    const imported = []; const conflicts = []; const skipped = [];
    for (const id of [...new Set(requested.map(String))]) {
      const record = approved.get(id);
      if (!record) { skipped.push({ reference: id, reason: 'Record is no longer present in the legacy snapshot.' }); continue; }
      const current = await client.query('SELECT payload FROM supplier_invoices WHERE invoice_number=$1 FOR UPDATE', [id]);
      if (current.rowCount) {
        if (supplierInvoiceComparable(current.rows[0].payload) === supplierInvoiceComparable(record)) skipped.push({ reference: id, reason: 'Already exists identically in PostgreSQL.' });
        else conflicts.push({ reference: id, reason: 'Existing PostgreSQL row differs; left unchanged.' });
        continue;
      }
      try { validateSupplierInvoice(record); }
      catch (error) { skipped.push({ reference: id, reason: error.message }); continue; }
      const po = optionalReference(record.poRef || record.payload.invoiceDetails?.poReference);
      let linkedPO = null;
      if (po) {
        const dbPO = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1 AND deleted_at IS NULL FOR UPDATE', [po]);
        linkedPO = dbPO.rows[0] || null;
        if (!linkedPO) {
          const legacyPO = await client.query("SELECT 1 FROM erp_state s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data) = 'array' THEN s.data ELSE '[]'::jsonb END) item WHERE s.storage_key='supplierPOHistory' AND COALESCE(item->>'reference', item->'payload'->'poDetails'->>'poNumber')=$1 LIMIT 1", [po]);
          if (!legacyPO.rowCount) { skipped.push({ reference: id, reason: `Referenced PO ${po} is not present in PostgreSQL or the preserved legacy PO snapshot.` }); continue; }
        } else if (String(linkedPO.vendor_name).trim().toLowerCase() !== String(record.vendor || record.payload.vendorDetails.companyName || record.payload.vendorDetails.vendorName).trim().toLowerCase()) {
          skipped.push({ reference: id, reason: `Supplier does not match PostgreSQL PO ${po}.` }); continue;
        }
      }
      const token = `legacy-supplier-invoice:${createHash('sha256').update(id).digest('hex')}`;
      const vendor = String(record.vendor || record.payload.vendorDetails.companyName || record.payload.vendorDetails.vendorName).trim();
      const settledRecord = supplierInvoiceSettled(record);
      const status = settledRecord.status;
      const inserted = await client.query('INSERT INTO supplier_invoices(invoice_number,po_number,receipt_number,vendor_name,status,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *', [id, po || null, record.receiptNumber || null, vendor, status, JSON.stringify({ ...settledRecord, version: 1 }), token, req.user.email]);
      await supplierInvoiceAudit(client, req, id, 'LEGACY_IMPORT', null, inserted.rows[0].payload, 'Explicit Admin import from migration preview');
      if (linkedPO) {
        const before = linkedPO.payload;
        const after = { ...before, billedInvoiceRef: id, billingStatus: 'Billed', updatedAt: new Date().toISOString() };
        await client.query('UPDATE purchase_orders SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE po_number=$1', [po, JSON.stringify(after), req.user.email]);
        await poAudit(client, req, po, 'SUPPLIER_INVOICE_LEGACY_IMPORT', before, after);
      }
      await reconcilePurchaseOrderProgress(client, req, po, `Legacy Supplier Invoice ${id} imported`);
      imported.push(supplierInvoiceView(inserted.rows[0]));
    }
    await client.query('COMMIT'); res.json({ imported, conflicts, skipped });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/supplier-invoices', async (req, res) => {
  authorize(req, ['purchase.supplier_invoice']);
  const result = await getPool().query('SELECT * FROM supplier_invoices WHERE deleted_at IS NULL ORDER BY created_at DESC,invoice_number');
  res.json({ records: result.rows.map(supplierInvoiceView) });
});
router.get('/supplier-invoices/:id', async (req, res) => {
  authorize(req, ['purchase.supplier_invoice']);
  const result = await getPool().query('SELECT * FROM supplier_invoices WHERE invoice_number=$1 AND deleted_at IS NULL', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Supplier Invoice not found.' });
  res.json({ record: supplierInvoiceView(result.rows[0]) });
});
router.post('/supplier-invoices', async (req, res) => {
  authorize(req, ['purchase.supplier_invoice']);
  const record = req.body?.data; const number = validateSupplierInvoice(record);
  const token = String(req.body?.createToken || '').trim();
  if (!token || token.length > 200) throw bad('A valid Supplier Invoice idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const retry = await client.query('SELECT * FROM supplier_invoices WHERE create_token=$1 FOR UPDATE', [token]);
    if (retry.rowCount) { await client.query('COMMIT'); return res.json({ record: supplierInvoiceView(retry.rows[0]), duplicate: true }); }
    const duplicate = await client.query('SELECT 1 FROM supplier_invoices WHERE invoice_number=$1', [number]);
    if (duplicate.rowCount) throw conflict(`Supplier Invoice ${number} already exists.`);
    const po = optionalReference(record.poRef || record.payload.invoiceDetails.poReference);
    let linkedPurchaseOrder = null;
    if (po) {
      const linkedPO = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1 AND deleted_at IS NULL FOR UPDATE', [po]);
      linkedPurchaseOrder = linkedPO.rows[0] || null;
      if (!linkedPurchaseOrder) {
        const legacyPO = await client.query("SELECT 1 FROM erp_state s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data) = 'array' THEN s.data ELSE '[]'::jsonb END) item WHERE s.storage_key='supplierPOHistory' AND COALESCE(item->>'reference', item->'payload'->'poDetails'->>'poNumber')=$1 LIMIT 1", [po]);
        if (!legacyPO.rowCount) throw conflict(`Purchase Order ${po} is not present in PostgreSQL or preserved legacy Purchase Orders.`);
      } else if (String(linkedPurchaseOrder.vendor_name).trim().toLowerCase() !== String(record.vendor || record.payload.vendorDetails.companyName || record.payload.vendorDetails.vendorName).trim().toLowerCase()) {
        throw conflict(`Supplier Invoice vendor does not match Purchase Order ${po}.`);
      }
    }
    const receiptNumber = optionalReference(record.receiptNumber);
    let linkedReceipt = null;
    if (receiptNumber) {
      const receiptResult = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1 AND deleted_at IS NULL FOR UPDATE', [receiptNumber]);
      linkedReceipt = receiptResult.rows[0] || null;
      if (!linkedReceipt) throw conflict(`Material Receipt ${receiptNumber} is not present in PostgreSQL.`);
      if (linkedReceipt.po_number !== po) throw conflict(`Material Receipt ${receiptNumber} is not linked to Purchase Order ${po}.`);
      if (String(linkedReceipt.vendor_name).trim().toLowerCase() !== String(record.vendor || record.payload.vendorDetails.companyName || record.payload.vendorDetails.vendorName).trim().toLowerCase()) throw conflict(`Supplier Invoice vendor does not match Material Receipt ${receiptNumber}.`);
      if (linkedReceipt.payload.supplierInvoiceNumber && linkedReceipt.payload.supplierInvoiceNumber !== number) throw conflict(`Material Receipt ${receiptNumber} already has Supplier Invoice ${linkedReceipt.payload.supplierInvoiceNumber}.`);
      const receiptOwner = await client.query('SELECT invoice_number FROM supplier_invoices WHERE receipt_number=$1 AND deleted_at IS NULL AND invoice_number<>$2', [receiptNumber, number]);
      if (receiptOwner.rowCount) throw conflict(`Material Receipt ${receiptNumber} is already billed by Supplier Invoice ${receiptOwner.rows[0].invoice_number}.`);
      const receiptItems = linkedReceipt.payload.items || [];
      for (const invoiceLine of record.payload.items || []) {
        const receiptLine = receiptItems.find((item) => String(item.materialCode || item.itemCode || '').toLowerCase() === String(invoiceLine.itemCode || invoiceLine.materialCode || '').toLowerCase() || String(item.materialName || item.itemName || '').toLowerCase() === String(invoiceLine.itemName || invoiceLine.materialName || '').toLowerCase());
        if (!receiptLine || Number(invoiceLine.quantity || 0) > Number(receiptLine.receivedQty || 0) + 1e-9) throw conflict(`Supplier Invoice quantity exceeds receipt quantity for ${invoiceLine.itemName || invoiceLine.materialName || 'an item'}.`);
      }
    }
    const billNumber = String(record.payload.invoiceDetails.supplierInvoiceNumber || '').trim();
    if (billNumber) {
      const duplicateBill = await client.query(
        "SELECT invoice_number FROM supplier_invoices WHERE deleted_at IS NULL AND lower(payload->'payload'->'invoiceDetails'->>'supplierInvoiceNumber')=lower($1) AND invoice_number<>$2",
        [billNumber, number]
      );
      if (duplicateBill.rowCount) throw conflict(`Supplier Bill ${billNumber} is already recorded on Supplier Invoice ${duplicateBill.rows[0].invoice_number}.`);
    }
    const vendor = String(record.vendor || record.payload.vendorDetails.companyName || record.payload.vendorDetails.vendorName).trim();
    const settledRecord = supplierInvoiceSettled({ ...record, receiptNumber });
    const status = settledRecord.status;
    const inserted = await client.query('INSERT INTO supplier_invoices(invoice_number,po_number,receipt_number,vendor_name,status,payload,create_token,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *', [number, po || null, receiptNumber || null, vendor, status, JSON.stringify({ ...settledRecord, version: 1 }), token, req.user.email]);
    await supplierInvoiceAudit(client, req, number, 'CREATE', null, settledRecord);
    let confirmedReceipt = null;
    if (linkedReceipt) {
      const before = linkedReceipt.payload;
      const after = { ...before, supplierInvoiceNumber: number, supplierInvoiceAt: new Date().toISOString(), supplierInvoiceBy: req.user.name || req.user.email, history: [...(before.history || []), { action: 'Recorded as Supplier Invoice', details: `Bill ${number} | PO ${po}`, at: new Date().toISOString() }] };
      const updatedReceipt = await client.query('UPDATE material_receipts SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE receipt_number=$1 RETURNING *', [receiptNumber, JSON.stringify(after), req.user.email]);
      await client.query(`INSERT INTO material_receipt_audit(receipt_number,actor_id,actor_email,actor_role,action,before_values,after_values) VALUES($1,$2,$3,$4,'SUPPLIER_INVOICE_LINK',$5::jsonb,$6::jsonb)`, [receiptNumber, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', JSON.stringify(safeAuditValues(before)), JSON.stringify(safeAuditValues(after))]);
      confirmedReceipt = { ...updatedReceipt.rows[0].payload, version: Number(updatedReceipt.rows[0].version), recordVersion: Number(updatedReceipt.rows[0].version), updatedAt: updatedReceipt.rows[0].updated_at?.toISOString?.() };
    }
    let confirmedPO = null;
    if (linkedPurchaseOrder) {
      const before = linkedPurchaseOrder.payload;
      const after = { ...before, billedInvoiceRef: number, billingStatus: 'Billed', updatedAt: new Date().toISOString() };
      await client.query('UPDATE purchase_orders SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE po_number=$1', [po, JSON.stringify(after), req.user.email]);
      await poAudit(client, req, po, 'SUPPLIER_INVOICE_RECORDED', before, after);
    }
    const reconciled = po ? await reconcilePurchaseOrderProgress(client, req, po, `Supplier Invoice ${number}`) : null;
    if (reconciled) confirmedPO = poView(reconciled.record);
    await client.query('COMMIT'); res.status(201).json({ record: supplierInvoiceView(inserted.rows[0]), purchaseOrder: confirmedPO, receipt: confirmedReceipt });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.put('/supplier-invoices/:id', async (req, res) => {
  authorize(req, ['purchase.supplier_invoice']);
  const expected = Number(req.body?.version); const patch = req.body?.data;
  if (!Number.isInteger(expected) || expected < 1 || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Current Supplier Invoice version and updated data are required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM supplier_invoices WHERE invoice_number=$1 FOR UPDATE', [req.params.id]); const old = result.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Supplier Invoice not found.'), { status: 404 });
    if (Number(old.version) !== expected) throw conflict('Supplier Invoice changed in PostgreSQL. Reload before editing.', supplierInvoiceView(old));
    const merged = { ...old.payload, ...patch, reference: req.params.id, updatedAt: new Date().toISOString() };
    if (String(merged.poRef || '') !== String(old.payload.poRef || '') || canonical(merged.payload?.items) !== canonical(old.payload.payload?.items) || canonical(merged.payload?.totals) !== canonical(old.payload.payload?.totals) || canonical(merged.vendor) !== canonical(old.payload.vendor)) throw bad('Supplier, PO relationship, items, quantities and totals cannot change after creation.');
    const settledRecord = supplierInvoiceSettled(merged, Number(old.advance_adjusted) || 0, Number(old.advance_adjusted_inr) || 0);
    const status = settledRecord.status;
    const updated = await client.query('UPDATE supplier_invoices SET status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE invoice_number=$1 RETURNING *', [req.params.id, status, JSON.stringify(settledRecord), req.user.email]);
    await supplierInvoiceAudit(client, req, req.params.id, 'UPDATE', old.payload, settledRecord);
    await client.query('COMMIT'); res.json({ record: supplierInvoiceView(updated.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.delete('/supplier-invoices/:id', requireAdmin, async (req, res) => {
  const version = Number(req.body?.version); const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(version) || version < 1 || !reason) throw bad('Admin deletion requires the current version and a reason.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const result = await client.query('SELECT * FROM supplier_invoices WHERE invoice_number=$1 FOR UPDATE', [req.params.id]); const old = result.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Supplier Invoice not found.'), { status: 404 });
    if (Number(old.version) !== version) throw conflict('Supplier Invoice changed in PostgreSQL. Reload before deleting.', supplierInvoiceView(old));
    const activeAdvance = await client.query('SELECT 1 FROM supplier_advance_adjustments WHERE invoice_number=$1 AND voided_at IS NULL LIMIT 1', [req.params.id]);
    if (activeAdvance.rowCount) throw conflict('Reverse active advance adjustments before deleting this Supplier Invoice.');
    let unlinkedReceipt = null;
    if (old.receipt_number) {
      const receiptResult = await client.query('SELECT * FROM material_receipts WHERE receipt_number=$1 FOR UPDATE', [old.receipt_number]);
      unlinkedReceipt = receiptResult.rows[0] || null;
      if (unlinkedReceipt && unlinkedReceipt.payload.supplierInvoiceNumber === req.params.id) {
        const before = unlinkedReceipt.payload;
        const after = { ...before, supplierInvoiceNumber: '', supplierInvoiceAt: '', supplierInvoiceBy: '', history: [...(before.history || []), { action: 'Supplier Invoice voided', details: req.params.id, at: new Date().toISOString() }] };
        await client.query('UPDATE material_receipts SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE receipt_number=$1', [old.receipt_number, JSON.stringify(after), req.user.email]);
        await client.query("INSERT INTO material_receipt_audit(receipt_number,actor_id,actor_email,actor_role,action,before_values,after_values) VALUES($1,$2,$3,$4,'SUPPLIER_INVOICE_UNLINK',$5::jsonb,$6::jsonb)", [old.receipt_number, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', JSON.stringify(safeAuditValues(before)), JSON.stringify(safeAuditValues(after))]);
      }
    }
    await client.query('UPDATE supplier_invoices SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE invoice_number=$1', [req.params.id, req.user.email, reason]);
    await supplierInvoiceAudit(client, req, req.params.id, 'SOFT_DELETE', old.payload, null, reason);
    await reconcilePurchaseOrderProgress(client, req, old.po_number, `Supplier Invoice ${req.params.id} voided`);
    await client.query('COMMIT'); res.json({ deleted: req.params.id });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
const indentQCAudit = (client, req, qcNumber, indentNumber, action, before, after) => client.query(
  `INSERT INTO purchase_indent_quality_audit(qc_number,indent_number,actor_id,actor_email,actor_role,action,before_values,after_values)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [qcNumber, indentNumber, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', action,
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const validatePurchaseOrderSnapshot = (value, quote) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Purchase Order data is required.');
  const payload = value.payload;
  const details = payload?.poDetails;
  if (!payload || !details || String(value.reference || '') !== String(details.poNumber || '')) throw bad('Purchase Order number is missing or inconsistent.');
  if (String(details.quotationRef || '') !== String(quote.quotation_number)) throw bad('Purchase Order quotation reference does not match the accepted Vendor Quotation.');
  if (String(details.enquiryRef || '') !== String(quote.enquiry_number)) throw bad('Purchase Order Vendor Enquiry reference does not match the accepted Vendor Quotation.');
  if (String(value.vendor || '').trim().toLowerCase() !== String(quote.vendor_name || '').trim().toLowerCase()) throw bad('Purchase Order vendor must match the accepted quotation.');
  const quotedItems = Array.isArray(quote.payload.items) ? quote.payload.items : [];
  const poItems = Array.isArray(payload.items) ? payload.items : [];
  if (!quotedItems.length || poItems.length !== quotedItems.length) throw bad('Purchase Order lines must match the accepted Vendor Quotation.');
  for (let index = 0; index < quotedItems.length; index += 1) {
    const q = quotedItems[index]; const p = poItems[index];
    if (String(p.itemCode || '') !== String(q.materialCode || '') || String(p.itemName || '') !== String(q.materialName || '') ||
      Number(p.quantity) !== Number(q.quotedQty) || Number(p.unitPrice) !== Number(q.unitPrice) || Number(p.gst ?? p.taxPct) !== Number(q.taxPct ?? 0)) {
      throw bad(`Purchase Order line ${index + 1} must preserve the accepted quotation's material, quantity, price, and tax.`);
    }
  }
  if (!String(value.reference || '').trim() || !String(value.date || '').trim()) throw bad('Purchase Order number and date are required.');
  return value;
};

router.get('/purchase-orders/sequences/next', async (req, res) => {
  authorizePurchaseOrder(req);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['procurement-sequence:purchaseOrder']);
    const [stored, maxPO, legacy] = await Promise.all([
      client.query("SELECT last_number FROM procurement_sequences WHERE sequence_key='purchaseOrder' FOR UPDATE"),
      client.query("SELECT COALESCE(max((regexp_match(po_number,'([0-9]+)$'))[1]::bigint),0) AS n FROM purchase_orders"),
      client.query("SELECT data FROM erp_state WHERE storage_key='supplierPOHistory'")
    ]);
    let max = Math.max(Number(stored.rows[0]?.last_number || 0), Number(maxPO.rows[0]?.n || 0));
    const old = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    for (const item of old) { const match = String(item?.reference || '').match(/(\d+)$/); if (match) max = Math.max(max, Number(match[1])); }
    const next = max + 1;
    await client.query("INSERT INTO procurement_sequences(sequence_key,last_number,updated_at) VALUES('purchaseOrder',$1,now()) ON CONFLICT(sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()", [next]);
    await client.query('COMMIT');
    res.json({ number: `PO-${String(next).padStart(6, '0')}` });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.get('/purchase-orders', async (req, res) => {
  authorizePurchaseOrder(req);
  const result = await getPool().query('SELECT * FROM purchase_orders WHERE deleted_at IS NULL ORDER BY created_at DESC,po_number');
  res.json({ records: result.rows.map(poView) });
});
/* Admin, read-only preview of preserved legacy Purchase Orders. Registered
 * before GET /purchase-orders/:id so the identifier is never treated as a PO. */
router.get('/purchase-orders/migration-preview', requireAdmin, async (req, res) => {
  const pool = getPool();
  const [legacy, current] = await Promise.all([
    pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='supplierPOHistory'"),
    pool.query('SELECT po_number,payload,deleted_at FROM purchase_orders')
  ]);
  const rows = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byId = new Map(current.rows.map((row) => [row.po_number, row]));
  const result = { eligible: [], existing: [], conflicts: [], invalid: [] };
  const seen = new Set();
  for (const record of rows) {
    const id = legacyPONumber(record);
    if (!id) { result.invalid.push({ record, reason: 'Missing Purchase Order number.' }); continue; }
    if (seen.has(id)) { result.conflicts.push({ record, reason: `Duplicate legacy Purchase Order number ${id}.` }); continue; }
    seen.add(id);
    try { validateLegacyPurchaseOrder(record); }
    catch (error) { result.invalid.push({ record, reason: error.message }); continue; }
    const db = byId.get(id);
    if (!db) { result.eligible.push(record); continue; }
    if (db.deleted_at) { result.conflicts.push({ record, databaseRecord: db.payload, reason: `Purchase Order ${id} is soft-deleted in PostgreSQL and is protected.` }); continue; }
    if (purchaseOrderComparable(db.payload) === purchaseOrderComparable(record)) result.existing.push(record);
    else result.conflicts.push({ record, databaseRecord: db.payload, reason: `Purchase Order ${id} exists in PostgreSQL with different content.` });
  }
  res.json({
    counts: Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])),
    ...result,
    legacyUpdatedAt: legacy.rows[0]?.updated_at || null
  });
});
router.get('/purchase-orders/:id', async (req, res) => {
  authorizePurchaseOrder(req);
  const result = await getPool().query('SELECT * FROM purchase_orders WHERE po_number=$1 AND deleted_at IS NULL', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Purchase Order not found.' });
  res.json({ record: poView(result.rows[0]) });
});
router.put('/purchase-orders/:id', async (req, res) => {
  authorizePurchaseOrder(req);
  const version = Number(req.body?.version); const patch = req.body?.data;
  if (!Number.isInteger(version) || version < 1 || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Purchase Order version and updated data are required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1 FOR UPDATE', [req.params.id]);
    const old = result.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Purchase Order not found.'), { status: 404 });
    if (Number(old.version) !== version) throw conflict('Purchase Order changed in PostgreSQL. Reload before editing.', poView(old));
    const merged = { ...old.payload, ...patch, reference: req.params.id, updatedAt: new Date().toISOString() };
    delete merged.version; delete merged.recordVersion;
    if (merged.date !== old.payload.date || merged.vendor !== old.payload.vendor || merged.status !== old.payload.status || merged.payload?.poDetails?.quotationRef !== old.payload.payload?.poDetails?.quotationRef ||
      canonical(merged.payload?.items) !== canonical(old.payload.payload?.items) || canonical(merged.payload?.totals) !== canonical(old.payload.payload?.totals) || canonical(merged.payload?.vendorDetails) !== canonical(old.payload.payload?.vendorDetails)) {
      throw bad('Purchase Order vendor, quotation, items, prices, quantities and totals are immutable after creation.');
    }
    const allowedDetails = new Set(['deliveryDueDate','deliveryAddress','billingAddress','transportTerms','notes','internalNotes','termsAndConditions','yourRefNo','yourRefDate','shipToName','shipToAddress','shipToMobile','packingCharges','freight']);
    const beforeDetails = old.payload.payload?.poDetails || {}; const nextDetails = merged.payload?.poDetails || {};
    for (const field of new Set([...Object.keys(beforeDetails), ...Object.keys(nextDetails)])) {
      if (!allowedDetails.has(field) && canonical(beforeDetails[field]) !== canonical(nextDetails[field])) throw bad(`Purchase Order field '${field}' cannot be changed after creation.`);
    }
    const updated = await client.query('UPDATE purchase_orders SET payload=$2::jsonb,status=$3,version=version+1,updated_at=now(),updated_by=$4 WHERE po_number=$1 RETURNING *', [req.params.id, JSON.stringify(merged), String(merged.status || old.status), req.user.email]);
    await poAudit(client, req, req.params.id, 'UPDATE', old.payload, merged);
    await client.query('COMMIT');
    res.json({ record: poView(updated.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
const PO_SHORT_CLOSE_REASONS = new Set([
  'Vendor unable to supply',
  'Customer order cancelled',
  'Material requirement reduced',
  'Alternative supplier selected',
  'Remaining quantity no longer required'
]);
/** Purchase Manager short-close of the unreceived balance. PostgreSQL re-measures
 *  the order in the same transaction; no browser/localStorage state can close a
 *  PG-owned order or change its original ordered quantity. */
router.post('/purchase-orders/:id/short-close', async (req, res) => {
  authorize(req, ['purchase.order.short_close']);
  const version = Number(req.body?.version);
  const reason = String(req.body?.reason || '').trim();
  const remarks = String(req.body?.remarks || '').trim();
  if (!Number.isInteger(version) || version < 1) throw bad('The current PostgreSQL Purchase Order version is required.');
  if (!PO_SHORT_CLOSE_REASONS.has(reason)) throw bad('Select a valid short-close reason.');
  if (!remarks) throw bad('Enter remarks explaining the short-close decision.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1 FOR UPDATE', [req.params.id]);
    const old = result.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Purchase Order not found.'), { status: 404 });
    if (Number(old.version) !== version) throw conflict('Purchase Order changed in PostgreSQL. Reload before short-closing.', poView(old));
    const stored = old.payload || {};
    const lockedStatus = String(stored.status || old.status || '');
    if (lockedStatus === 'Cancelled' || lockedStatus === 'Closed' || String(old.status) === 'Cancelled' || String(old.status) === 'Closed') throw conflict('This Purchase Order is already Cancelled or Closed.');
    if (lockedStatus === 'Draft' || String(old.status) === 'Draft') throw conflict('A draft Purchase Order cannot be short-closed.');
    if (stored.shortClose?.closedAt) throw conflict('This Purchase Order has already been short-closed.');
    const reconciled = await reconcilePurchaseOrderProgress(client, req, req.params.id, 'Short-close eligibility re-measurement');
    const current = reconciled?.record || old;
    const progress = reconciled?.progress || null;
    if (!progress) throw conflict('Purchase Order progress could not be measured from PostgreSQL.');
    const remaining = Number(progress.pending) || 0;
    if (remaining <= 0) throw conflict('This Purchase Order has no unreceived quantity to short-close.');
    if (Number(progress.qcPending) > 0 || Number(progress.pendingAccepted) > 0 || Number(progress.pendingInvoice) > 0 || Number(progress.openRejected) > 0 || Number(progress.pendingReplacement) > 0) {
      throw conflict('Receipts, inspection, inventory, invoice or rejection work is still open. Resolve it before short-closing.');
    }
    const user = req.user?.name || req.user?.email || 'system';
    const at = new Date().toISOString();
    const closure = {
      shortClosedQty: remaining,
      lines: (progress.lines || []).filter((line) => Number(line.pendingQty) > 0).map((line) => ({
        itemCode: String(line.materialCode || ''),
        itemName: String(line.materialName || ''),
        quantity: Number(line.pendingQty),
        unit: String(line.unit || '')
      })),
      reason,
      remarks,
      closedAt: at,
      closedBy: user,
      employeeId: req.user?.empId || null,
      department: req.user?.department || null,
      approvedBy: user,
      approvedByEmployeeId: req.user?.empId || null,
      approvedAt: at
    };
    const currentPayload = current.payload || {};
    const details = currentPayload.payload?.poDetails || currentPayload.poDetails || {};
    const closedProgress = { ...progress, status: 'Closed', fulfillmentStatus: 'Closed', updatedAt: at };
    const after = {
      ...currentPayload,
      status: 'Closed',
      shortClose: closure,
      shortCloseHistory: [...(currentPayload.shortCloseHistory || []), closure],
      closedAt: at,
      closedReason: reason,
      closedBy: user,
      progress: closedProgress,
      poDetails: { ...(currentPayload.poDetails || {}), poStatus: 'Closed', shortClose: closure },
      payload: { ...(currentPayload.payload || {}), poDetails: { ...details, poStatus: 'Closed', shortClose: closure } }
    };
    const updated = await client.query('UPDATE purchase_orders SET payload=$2::jsonb,status=$3,version=version+1,updated_at=now(),updated_by=$4 WHERE po_number=$1 RETURNING *', [req.params.id, JSON.stringify(after), 'Closed', req.user.email]);
    await poAudit(client, req, req.params.id, 'SHORT_CLOSED', currentPayload, after, `${reason} | ${remarks}`);
    await client.query('COMMIT');
    res.json({ record: poView(updated.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.delete('/purchase-orders/:id', requireAdmin, async (req, res) => {
  const reason = String(req.body?.reason || '').trim(); const version = Number(req.body?.version);
  if (!reason || !Number.isInteger(version) || version < 1) throw bad('Admin deletion requires a reason and the current PostgreSQL version.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1 FOR UPDATE', [req.params.id]);
    const old = result.rows[0];
    if (!old || old.deleted_at) throw Object.assign(new Error('Purchase Order not found.'), { status: 404 });
    if (Number(old.version) !== version) throw conflict('Purchase Order changed in PostgreSQL. Reload before deleting.', poView(old));
    const linkedIndent = await client.query("SELECT 1 FROM purchase_indents WHERE payload->>'poNumber'=$1 AND deleted_at IS NULL LIMIT 1", [req.params.id]);
    if (linkedIndent.rowCount) throw conflict('Purchase Order has a converted Purchase Indent history and must be retained.');
    const linked = await client.query("SELECT data FROM erp_state WHERE storage_key=ANY($1::text[])", [['materialReceipts','materialArrivals','qualityChecks','stockTransactions']]);
    const referencesPO = (value) => Array.isArray(value) ? value.some(referencesPO)
      : value && typeof value === 'object' ? Object.entries(value).some(([key, child]) => /po(number|ref)/i.test(key) && String(child) === req.params.id || referencesPO(child))
        : false;
    if (linked.rows.some((row) => referencesPO(row.data))) throw conflict('Purchase Order has receipt, arrival, quality or stock history and cannot be deleted.');
    const pgReceipts = await client.query('SELECT receipt_number FROM material_receipts WHERE po_number=$1 AND deleted_at IS NULL LIMIT 1', [req.params.id]);
    if (pgReceipts.rowCount) throw conflict(`Purchase Order has PostgreSQL Material Receipt ${pgReceipts.rows[0].receipt_number} and cannot be deleted.`);
    await client.query('UPDATE purchase_orders SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE po_number=$1', [req.params.id, req.user.email, reason]);
    await poAudit(client, req, req.params.id, 'SOFT_DELETE', old.payload, null, reason);
    await client.query('COMMIT');
    res.json({ deleted: req.params.id });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/* -------------------------------------------------------------------------- *
 * Legacy Purchase Order migration (Admin, explicit).
 *
 * Purchase Orders raised before the Vendor Quotation workflow carry no
 * quotation reference, so they are inserted with a NULL quotation_number and
 * are only ever added — an existing PostgreSQL row is never overwritten, and
 * the preserved erp_state snapshot is never rewritten.
 * -------------------------------------------------------------------------- */
const purchaseOrderComparable = (value) => {
  if (!value || typeof value !== 'object') return '';
  const copy = { ...value };
  delete copy.version; delete copy.recordVersion; delete copy.updatedAt; delete copy.progress; delete copy.legacyImport;
  if (copy.status) delete copy.status;
  if (copy.payload?.poDetails) {
    copy.payload = { ...copy.payload, poDetails: { ...copy.payload.poDetails } };
    delete copy.payload.poDetails.poStatus;
  }
  return canonical(copy);
};
const legacyPONumber = (row) => String(row?.reference || row?.payload?.poDetails?.poNumber || '').trim();
const legacyPOItems = (row) => (Array.isArray(row?.payload?.payload?.items) ? row.payload.payload.items
  : Array.isArray(row?.payload?.items) ? row.payload.items : []);
const legacyPOVendor = (row) => String(row?.vendor || row?.payload?.vendorDetails?.companyName || row?.payload?.vendorDetails?.vendorName || '').trim();
const validateLegacyPurchaseOrder = (row) => {
  const id = legacyPONumber(row);
  if (!id || id.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(id)) throw bad('A valid Purchase Order number is required.');
  const items = legacyPOItems(row);
  if (!items.length) throw bad('A Purchase Order must contain at least one material line.');
  if (items.some((item) => !String(item.itemName || item.materialName || '').trim() || !(Number(item.quantity ?? item.orderedQty ?? item.qty) > 0))) {
    throw bad('Every Purchase Order line needs a material and a positive quantity.');
  }
  if (!legacyPOVendor(row)) throw bad('Purchase Order vendor is required.');
  if (Buffer.byteLength(JSON.stringify(row)) > 8 * 1024 * 1024) throw Object.assign(new Error('Purchase Order exceeds the 8 MB limit.'), { status: 413 });
  return id;
};
const insertLegacyPurchaseOrder = async (client, req, record, id) => {
  const vendor = legacyPOVendor(record);
  const status = String(record.status || record.payload?.poDetails?.poStatus || 'Draft');
  const token = `legacy-purchase-order:${createHash('sha256').update(id).digest('hex')}`;
  const payload = { ...record, reference: id, legacyImport: true, version: 1, updatedAt: new Date().toISOString() };
  const inserted = await client.query(
    `INSERT INTO purchase_orders(po_number,quotation_number,indent_number,vendor_name,status,payload,create_token,created_by,updated_by)
     VALUES($1,NULL,NULL,$2,$3,$4::jsonb,$5,$6,$6) RETURNING *`,
    [id, vendor, status, JSON.stringify(payload), token, req.user.email]
  );
  await poAudit(client, req, id, 'LEGACY_IMPORT', null, payload, 'Explicit Admin import from migration preview');
  await reconcilePurchaseOrderProgress(client, req, id, 'Legacy Purchase Order import');
  const fresh = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1', [id]);
  return poView(fresh.rows[0] || inserted.rows[0]);
};
router.post('/purchase-orders/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const requested = req.body?.records;
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000) throw bad('Select Purchase Orders from the Admin migration preview.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const legacy = await client.query("SELECT data FROM erp_state WHERE storage_key='supplierPOHistory' FOR SHARE");
    const source = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    const approved = new Map();
    for (const row of source) { const id = legacyPONumber(row); if (id && !approved.has(id)) approved.set(id, row); }
    const imported = []; const conflicts = []; const skipped = [];
    for (const id of [...new Set(requested.map(String))]) {
      const record = approved.get(id);
      if (!record) { skipped.push({ id, reason: 'Record is no longer present in the preserved legacy snapshot.' }); continue; }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-order-import:${id}`]);
      const existing = await client.query('SELECT payload,deleted_at FROM purchase_orders WHERE po_number=$1 FOR UPDATE', [id]);
      if (existing.rowCount) {
        if (existing.rows[0].deleted_at) conflicts.push({ id, reason: 'The PostgreSQL Purchase Order is soft-deleted; left unchanged.' });
        else if (purchaseOrderComparable(existing.rows[0].payload) === purchaseOrderComparable(record)) skipped.push({ id, reason: 'Already exists identically in PostgreSQL.' });
        else conflicts.push({ id, reason: 'Existing PostgreSQL Purchase Order differs; left unchanged.' });
        continue;
      }
      try { validateLegacyPurchaseOrder(record); }
      catch (error) { skipped.push({ id, reason: error.message }); continue; }
      imported.push(await insertLegacyPurchaseOrder(client, req, record, id));
    }
    await client.query('COMMIT'); res.json({ imported, conflicts, skipped });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
/** Purchase Order Excel import: rows are inserted into PostgreSQL, never into a
 *  browser-only list, and an existing row is preserved instead of overwritten. */
router.post('/purchase-orders/import', async (req, res) => {
  authorizePurchaseOrder(req);
  const requested = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!requested.length || requested.length > 1000) throw bad('Import between 1 and 1000 Purchase Order rows.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const imported = []; const conflicts = []; const skipped = [];
    const seen = new Set();
    for (const record of requested) {
      let id;
      try { id = validateLegacyPurchaseOrder(record); }
      catch (error) { skipped.push({ id: legacyPONumber(record) || '', reason: error.message }); continue; }
      if (seen.has(id)) { skipped.push({ id, reason: 'Duplicate Purchase Order number in this import.' }); continue; }
      seen.add(id);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-order-import:${id}`]);
      const existing = await client.query('SELECT payload,deleted_at FROM purchase_orders WHERE po_number=$1 FOR UPDATE', [id]);
      if (existing.rowCount) {
        if (existing.rows[0].deleted_at) conflicts.push({ id, reason: 'A soft-deleted PostgreSQL Purchase Order already uses this number.' });
        else if (purchaseOrderComparable(existing.rows[0].payload) === purchaseOrderComparable(record)) skipped.push({ id, reason: 'Already present in PostgreSQL.' });
        else conflicts.push({ id, reason: 'Purchase Order number already exists in PostgreSQL with different content; left unchanged.' });
        continue;
      }
      const token = `excel-purchase-order:${createHash('sha256').update(`${id}:${JSON.stringify(record)}`).digest('hex')}`;
      const retry = await client.query('SELECT * FROM purchase_orders WHERE create_token=$1', [token]);
      if (retry.rowCount) { skipped.push({ id, reason: 'This import was already recorded.' }); continue; }
      const payload = { ...record, reference: id, legacyImport: true, version: 1, updatedAt: new Date().toISOString() };
      const status = String(record.status || record.payload?.poDetails?.poStatus || 'Draft');
      await client.query(
        `INSERT INTO purchase_orders(po_number,quotation_number,indent_number,vendor_name,status,payload,create_token,created_by,updated_by)
         VALUES($1,NULL,NULL,$2,$3,$4::jsonb,$5,$6,$6)`,
        [id, legacyPOVendor(record), status, JSON.stringify(payload), token, req.user.email]
      );
      await poAudit(client, req, id, 'EXCEL_IMPORT', null, payload, 'Purchase Order imported from spreadsheet');
      await reconcilePurchaseOrderProgress(client, req, id, 'Purchase Order spreadsheet import');
      const fresh = await client.query('SELECT * FROM purchase_orders WHERE po_number=$1', [id]);
      imported.push(poView(fresh.rows[0]));
    }
    await client.query('COMMIT'); res.json({ imported, conflicts, skipped });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.get('/purchase-indent-quality-checks', async (req, res) => {
  authorize(req, ['production.qc.view', 'production.qc.manage']);
  const result = await getPool().query('SELECT qc.payload,qc.version,qc.updated_at FROM purchase_indent_quality_checks qc ORDER BY qc.updated_at DESC');
  res.json({ records: result.rows.map((row) => ({ ...row.payload, version: Number(row.version), recordVersion: Number(row.version), updatedAt: row.updated_at?.toISOString?.() })) });
});
router.post('/purchase-indent-quality-checks', async (req, res) => {
  authorize(req, ['production.qc.manage']);
  const record = req.body?.data;
  const expectedIndentVersion = Number(req.body?.indentVersion);
  if (!record || typeof record !== 'object' || Array.isArray(record) || !String(record.qcNumber || '').trim() || !String(record.indentNumber || '').trim() || !Array.isArray(record.items) || !record.items.length) throw bad('A complete Purchase Indent Quality Check is required.');
  if (!Number.isInteger(expectedIndentVersion) || expectedIndentVersion < 1) throw bad('The current PostgreSQL Purchase Indent version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const indentResult = await client.query('SELECT * FROM purchase_indents WHERE indent_number=$1 AND deleted_at IS NULL FOR UPDATE', [record.indentNumber]);
    const indent = indentResult.rows[0];
    if (!indent) throw Object.assign(new Error('Purchase Indent not found.'), { status: 404 });
    if (Number(indent.version) !== expectedIndentVersion) throw conflict('Purchase Indent changed in PostgreSQL. Reload before saving Quality Check.', view(indent, definitions.purchaseIndent));
    if (!indent.payload.poNumber || indent.status === 'Cancelled') throw conflict('Only an active Indent linked to a Purchase Order can be inspected.');
    const currentResult = await client.query('SELECT * FROM purchase_indent_quality_checks WHERE indent_number=$1 FOR UPDATE', [record.indentNumber]);
    const current = currentResult.rows[0];
    if (current && current.qc_number !== record.qcNumber) throw conflict(`Purchase Indent ${record.indentNumber} already has Quality Check ${current.qc_number}.`);
    const expectedQCVersion = Number(req.body?.qcVersion || 0);
    if (current && expectedQCVersion !== Number(current.version)) throw conflict('Quality Check changed in PostgreSQL. Reload before editing.', { ...current.payload, version: Number(current.version) });
    if (!current && expectedQCVersion !== 0) throw conflict('Quality Check no longer exists in PostgreSQL. Reload before editing.');
    const qcPayload = { ...record, updatedAt: new Date().toISOString() };
    let qcRow;
    if (current) {
      const updated = await client.query('UPDATE purchase_indent_quality_checks SET status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE qc_number=$1 RETURNING *', [record.qcNumber, String(record.status || 'Pending'), JSON.stringify(qcPayload), req.user.email]);
      qcRow = updated.rows[0];
    } else {
      const inserted = await client.query('INSERT INTO purchase_indent_quality_checks(qc_number,indent_number,status,payload,created_by,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$5) RETURNING *', [record.qcNumber, record.indentNumber, String(record.status || 'Pending'), JSON.stringify(qcPayload), req.user.email]);
      qcRow = inserted.rows[0];
    }
    const indentAfter = { ...indent.payload, qcNumber: record.qcNumber, qcStatus: 'Inspected', qcResult: record.status, inspectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [...(indent.payload.history || []), { action: 'Quality Check completed', details: `${record.qcNumber} | ${record.status}`, by: req.user.email, at: new Date().toISOString() }] };
    await client.query("UPDATE purchase_indents SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE indent_number=$1", [record.indentNumber, JSON.stringify(indentAfter), req.user.email]);
    await audit(client, req, 'purchaseIndent', record.indentNumber, 'QUALITY_CHECK_COMPLETED', indent.payload, indentAfter);
    await indentQCAudit(client, req, record.qcNumber, record.indentNumber, current ? 'UPDATE' : 'CREATE', current?.payload || null, qcPayload);
    await client.query('COMMIT');
    res.status(current ? 200 : 201).json({ record: { ...qcRow.payload, version: Number(qcRow.version), recordVersion: Number(qcRow.version) }, indent: { ...indentAfter, version: Number(indent.version) + 1 } });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.post('/purchase-orders/from-quotation', async (req, res) => {
  authorizePurchaseOrder(req);
  const data = req.body?.data;
  const token = String(req.body?.createToken || '');
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid Purchase Order idempotency token is required.');
  if (Buffer.byteLength(JSON.stringify(data || {})) > 8 * 1024 * 1024) throw Object.assign(new Error('Purchase Order exceeds the 8 MB limit.'), { status: 413 });
  const quotationNumber = String(data?.payload?.poDetails?.quotationRef || '').trim();
  if (!quotationNumber) throw bad('An accepted Vendor Quotation is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-order-token:${token}`]);
    const retry = await client.query('SELECT * FROM purchase_orders WHERE create_token=$1 FOR UPDATE', [token]);
    if (retry.rowCount) {
      if (retry.rows[0].deleted_at) throw conflict('Deleted Purchase Order cannot be restored by retry.');
      if (String(retry.rows[0].quotation_number) !== String(data?.payload?.poDetails?.quotationRef || '')) throw conflict('This Purchase Order idempotency token is already bound to another quotation.');
      await client.query('COMMIT');
      return res.json({ record: poView(retry.rows[0]), duplicate: true });
    }
    const quoteResult = await client.query('SELECT * FROM vendor_quotations WHERE quotation_number=$1 AND deleted_at IS NULL FOR UPDATE', [quotationNumber]);
    const quote = quoteResult.rows[0];
    if (!quote) throw conflict('The Vendor Quotation must be accepted in PostgreSQL before creating a Purchase Order.');
    const alreadyCreated = await client.query('SELECT * FROM purchase_orders WHERE quotation_number=$1 AND deleted_at IS NULL FOR UPDATE', [quotationNumber]);
    if (alreadyCreated.rowCount) {
      await client.query('COMMIT');
      return res.json({ record: poView(alreadyCreated.rows[0]), duplicate: true });
    }
    if (!['Accepted', 'Approved'].includes(String(quote.status))) throw conflict('The Vendor Quotation must be accepted in PostgreSQL before creating a Purchase Order.');
    if (quote.payload.poNumber || quote.payload.purchaseOrderNumber || ['PO Created', 'Ordered'].includes(quote.status)) throw conflict('This Vendor Quotation already generated a Purchase Order.');
    validatePurchaseOrderSnapshot(data, quote);
    const poNumber = String(data.reference).trim();
    const indentNumber = String(data.payload.poDetails.indentRef || '').trim() || null;
    const enquiryResult = await client.query('SELECT * FROM vendor_enquiries WHERE enquiry_number=$1 AND deleted_at IS NULL FOR UPDATE', [quote.enquiry_number]);
    const enquiry = enquiryResult.rows[0];
    if (!enquiry) throw conflict('The Vendor Enquiry for this quotation is unavailable in PostgreSQL.');
    const prNumber = String(data.payload.poDetails.prRef || '').trim();
    if (String(enquiry.pr_number || '') !== prNumber) {
      throw bad('Purchase Order Purchase Request reference must match the Vendor Enquiry source.');
    }
    let purchaseRequest = null;
    if (prNumber) {
      const result = await client.query("SELECT * FROM purchase_requests WHERE pr_number=$1 AND deleted_at IS NULL FOR UPDATE", [prNumber]);
      purchaseRequest = result.rows[0];
      if (!purchaseRequest || purchaseRequest.status !== 'Approved') {
        throw conflict(`Purchase Request ${prNumber} must be active and Approved before Purchase Order conversion.`);
      }
      if (purchaseRequest.payload.poNumber && String(purchaseRequest.payload.poNumber) !== String(data.reference)) {
        throw conflict(`Purchase Request ${prNumber} is already linked to Purchase Order ${purchaseRequest.payload.poNumber}.`);
      }
    }
    if (String(data.payload.poDetails.indentRef || '') !== String(enquiry.indent_number || '')) throw bad('Purchase Order Indent reference does not match the Vendor Enquiry linked to the accepted quotation.');
    let indent = null;
    if (indentNumber) {
      const result = await client.query('SELECT * FROM purchase_indents WHERE indent_number=$1 AND deleted_at IS NULL FOR UPDATE', [indentNumber]);
      indent = result.rows[0];
      if (!indent) throw conflict('The referenced Purchase Indent is unavailable in PostgreSQL.');
      if (indent.status === 'Cancelled' || indent.status === 'Converted to PO') throw conflict(`Purchase Indent ${indentNumber} is ${indent.status} and cannot be converted again.`);
      if (!indent.payload.adminApprovedAt) throw conflict(`Purchase Indent ${indentNumber} requires Admin approval before conversion.`);
      if (indent.payload.poNumber && String(indent.payload.poNumber) !== poNumber) throw conflict(`Purchase Indent ${indentNumber} is already linked to PO ${indent.payload.poNumber}.`);
    }
    const inserted = await client.query(
      `INSERT INTO purchase_orders(po_number,quotation_number,indent_number,pr_number,vendor_name,status,payload,create_token,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9) RETURNING *`,
      [poNumber, quotationNumber, indentNumber, prNumber, quote.vendor_name, String(data.status || data.payload.poDetails.poStatus || 'Submitted'), JSON.stringify(data), token, req.user.email]
    );
    const quoteAfter = { ...quote.payload, status: 'PO Created', poNumber, purchaseOrderId: poNumber, purchaseOrderNumber: poNumber, poCreatedDate: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await client.query("UPDATE vendor_quotations SET status='PO Created',payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE quotation_number=$1", [quotationNumber, JSON.stringify(quoteAfter), req.user.email]);
    await audit(client, req, 'vendorQuotation', quotationNumber, 'PURCHASE_ORDER_CREATED', quote.payload, quoteAfter);
    const enquiryAfter = { ...enquiry.payload, status: 'Closed', poNumber, closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await client.query("UPDATE vendor_enquiries SET status='Closed',payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE enquiry_number=$1", [enquiry.enquiry_number, JSON.stringify(enquiryAfter), req.user.email]);
    await audit(client, req, 'vendorEnquiry', enquiry.enquiry_number, 'PURCHASE_ORDER_CREATED', enquiry.payload, enquiryAfter);
    if (indent) {
      const indentAfter = { ...indent.payload, status: 'Converted to PO', poNumber, convertedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [...(indent.payload.history || []), { action: 'Converted to Purchase Order', details: `PO ${poNumber}`, at: new Date().toISOString(), by: req.user.email }] };
      await client.query("UPDATE purchase_indents SET status='Converted to PO',payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE indent_number=$1", [indentNumber, JSON.stringify(indentAfter), req.user.email]);
      await audit(client, req, 'purchaseIndent', indentNumber, 'CONVERTED_TO_PO', indent.payload, indentAfter);
    }
    let purchaseRequestAfter = null;
    if (purchaseRequest) {
      purchaseRequestAfter = { ...purchaseRequest.payload, status: 'Converted to PO', poNumber, convertedAt: new Date().toISOString() };
      await client.query(
        "UPDATE purchase_requests SET status='Converted to PO',payload=$2::jsonb,version=version+1,updated_by=$3,updated_at=now() WHERE pr_number=$1",
        [prNumber, JSON.stringify(purchaseRequestAfter), req.user.email]
      );
      await client.query(
        `INSERT INTO purchase_request_audit(pr_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
         VALUES($1,$2,$3,$4,'CONVERTED_TO_PO',$5,$6::jsonb,$7::jsonb)`,
        [prNumber, req.user?.id || null, req.user.email, req.user?.role || req.user?.roleKey || '', `Converted to Purchase Order ${poNumber}`, JSON.stringify(safeAuditValues(purchaseRequest.payload)), JSON.stringify(safeAuditValues(purchaseRequestAfter))]
      );
    }
    await poAudit(client, req, poNumber, 'CREATE_FROM_ACCEPTED_QUOTATION', null, data);
    await client.query('COMMIT');
    res.status(201).json({ record: poView(inserted.rows[0]), quotation: { ...quoteAfter, version: Number(quote.version) + 1 }, enquiry: { ...enquiryAfter, version: Number(enquiry.version) + 1 }, indent: indent ? { ...indent.payload, status: 'Converted to PO', poNumber, convertedAt: new Date().toISOString(), version: Number(indent.version) + 1 } : null, purchaseRequest: purchaseRequest ? { ...purchaseRequestAfter, version: Number(purchaseRequest.version) + 1 } : null, duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
const writeRecord = async (client, req, kind, d, id, payload, token, existing = null) => {
  const status = String(payload.status || 'Draft');
  const common = [id, String(payload.soNumber || ''), String(payload.projectId || ''), status, JSON.stringify(payload), token || null, req.user.email];
  if (kind === 'purchaseIndent') {
    const row = await client.query(
      `INSERT INTO purchase_indents(indent_number,so_number,project_id,status,payload,create_token,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$7) RETURNING *`, common);
    return row.rows[0];
  }
  if (kind === 'vendorEnquiry') {
    const vals = [id, payload.indentNumber ? String(payload.indentNumber) : null, String(payload.prNumber || ''), status, JSON.stringify(payload), token || null, req.user.email];
    const row = await client.query(
      `INSERT INTO vendor_enquiries(enquiry_number,indent_number,pr_number,status,payload,create_token,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$7) RETURNING *`, vals);
    return row.rows[0];
  }
  const vals = [id, String(payload.enquiryNumber), String(payload.vendorId || ''), String(payload.vendorName).trim(), status, JSON.stringify(payload), token || null, req.user.email];
  const row = await client.query(
    `INSERT INTO vendor_quotations(quotation_number,enquiry_number,vendor_id,vendor_name,status,payload,create_token,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *`, vals);
  return row.rows[0];
};

router.get('/sequences/:kind/next', async (req, res) => {
  const d = definition(req.params.kind); authorize(req, d.permissions);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`procurement-sequence:${d.sequence}`]);
    const stored = await client.query('SELECT last_number FROM procurement_sequences WHERE sequence_key=$1 FOR UPDATE', [d.sequence]);
    const [maximum, legacy] = await Promise.all([
      client.query(`SELECT COALESCE(max((regexp_match(${d.id},'([0-9]+)$'))[1]::bigint),0) AS n FROM ${d.table}`),
      client.query('SELECT data FROM erp_state WHERE storage_key=$1', [d.legacy])
    ]);
    let max = Math.max(Number(stored.rows[0]?.last_number || 0), Number(maximum.rows[0]?.n || 0));
    const old = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    for (const item of old) { const match = String(item?.[d.key] || '').match(/(\d+)$/); if (match) max = Math.max(max, Number(match[1])); }
    const next = max + 1;
    await client.query(`INSERT INTO procurement_sequences(sequence_key,last_number,updated_at) VALUES($1,$2,now()) ON CONFLICT(sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`, [d.sequence, next]);
    await client.query('COMMIT');
    res.json({ number: `${d.prefix}-${String(next).padStart(6, '0')}` });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/:kind', async (req, res) => {
  const d = definition(req.params.kind); authorize(req, d.permissions);
  const result = await getPool().query(`SELECT * FROM ${d.table} WHERE deleted_at IS NULL ORDER BY updated_at DESC, ${d.id}`);
  res.json({ records: result.rows.map((row) => view(row, d)) });
});
router.get('/:kind/migration-preview', requireAdmin, async (req, res) => {
  const d = definition(req.params.kind); const pool = getPool();
  const [legacy, existing] = await Promise.all([
    pool.query('SELECT data,updated_at FROM erp_state WHERE storage_key=$1', [d.legacy]),
    pool.query(`SELECT ${d.id} AS id,payload,deleted_at FROM ${d.table}`)
  ]);
  const values = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byId = new Map(existing.rows.map((row) => [row.id, row]));
  const eligible = []; const present = []; const conflicts = []; const deleted = []; const seen = new Set();
  for (const payload of values) {
    const id = String(payload?.[d.key] || '').trim();
    if (!id) { conflicts.push({ id: '', reason: 'Missing record identifier' }); continue; }
    if (seen.has(id)) { conflicts.push({ id, reason: 'Duplicate legacy identifier' }); continue; }
    seen.add(id);
    const current = byId.get(id);
    if (current?.deleted_at) { deleted.push({ id, reason: 'Database record is soft-deleted' }); continue; }
    if (current) {
      const left = canonical(current.payload); const right = canonical(payload);
      (left === right ? present : conflicts).push({ id, reason: left === right ? 'Already present' : 'PostgreSQL record differs' });
      continue;
    }
    try { validate(req.params.kind, payload); eligible.push(payload); }
    catch (error) { conflicts.push({ id, reason: error.message }); }
  }
  res.json({ entity: req.params.kind, eligible, existing: present, conflicts, deleted, counts: { eligible: eligible.length, existing: present.length, conflicts: conflicts.length, deleted: deleted.length }, legacyUpdatedAt: legacy.rows[0]?.updated_at || null });
});
router.post('/:kind/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const kind = req.params.kind; const d = definition(kind); const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) throw bad('Select between 1 and 1000 records to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const imported = []; const conflicts = [];
    for (const payload of records) {
      const id = validate(kind, payload);
      const legacy = await client.query('SELECT data FROM erp_state WHERE storage_key=$1', [d.legacy]);
      const source = (Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : []).filter((item) => String(item?.[d.key] || '').trim() === id);
      if (source.length !== 1 || canonical(source[0]) !== canonical(payload)) {
        conflicts.push({ id, reason: source.length ? 'Selected record differs from the current legacy source or has a duplicate legacy identifier' : 'Record is no longer present in the legacy source' });
        continue;
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`procurement:${kind}:${id}`]);
      const current = await readRecord(client, d, id, true);
      if (current) { conflicts.push({ id, reason: current.deleted_at ? 'Deleted record is protected' : 'Record already exists' }); continue; }
      if (kind === 'vendorEnquiry' && payload.indentNumber && !(await readRecord(client, definitions.purchaseIndent, String(payload.indentNumber)))) { conflicts.push({ id, reason: 'Referenced Purchase Indent is not imported' }); continue; }
      if (kind === 'vendorEnquiry' && payload.prNumber) {
        const request = await client.query("SELECT status,deleted_at FROM purchase_requests WHERE pr_number=$1", [String(payload.prNumber)]);
        if (!request.rowCount || request.rows[0].deleted_at || request.rows[0].status !== 'Approved') {
          conflicts.push({ id, reason: `Referenced approved Purchase Request ${payload.prNumber} is not available in PostgreSQL.` });
          continue;
        }
      }
      if (kind === 'vendorQuotation' && !(await readRecord(client, definitions.vendorEnquiry, String(payload.enquiryNumber)))) { conflicts.push({ id, reason: 'Referenced Vendor Enquiry is not imported' }); continue; }
      const row = await writeRecord(client, req, kind, d, id, payload, null);
      await audit(client, req, kind, id, 'IMPORT', null, payload, 'Admin-confirmed legacy procurement migration'); imported.push(view(row, d));
    }
    await client.query('COMMIT'); res.json({ imported, conflicts });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.get('/:kind/:id', async (req, res) => {
  const d = definition(req.params.kind); authorize(req, d.permissions);
  const row = await readRecord(getPool(), d, req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Procurement record not found.' });
  res.json({ record: view(row, d) });
});
router.post('/:kind', async (req, res) => {
  const kind = req.params.kind; const d = definition(kind); authorize(req, d.permissions);
  const payload = req.body?.data; const id = validate(kind, payload); const token = String(req.body?.createToken || '');
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid idempotency token is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`procurement-create-token:${token}`]);
    const retry = await client.query(`SELECT * FROM ${d.table} WHERE create_token=$1 FOR UPDATE`, [token]);
    if (retry.rowCount) {
      if (retry.rows[0].deleted_at) throw conflict('Deleted record cannot be restored by retry.');
      const sameReplacementIntent = kind === 'purchaseIndent' && payload?.repurchaseFor && String(payload.repurchaseFor) === String(retry.rows[0].payload?.repurchaseFor || '');
      if (canonical(retry.rows[0].payload) !== canonical(payload) && !sameReplacementIntent) throw conflict('This idempotency token was already used for different record data.');
      await client.query('COMMIT'); return res.json({ record: view(retry.rows[0], d), duplicate: true });
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`procurement:${kind}:${id}`]);
    if (kind === 'purchaseIndent') {
      const sourceType = String(payload.sourceType || '');
      const sourceId = sourceType === 'materialRequest' ? String(payload.requirementNumber || '') : String(payload.repurchaseFor || '');
      if (sourceId) {
        const sourceKey = sourceType === 'materialRequest' ? 'materialRequest' : 'repurchase';
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-indent-source:${sourceKey}:${sourceId}`]);
        const duplicate = sourceKey === 'materialRequest'
          ? await client.query("SELECT indent_number FROM purchase_indents WHERE deleted_at IS NULL AND payload->>'sourceType'='materialRequest' AND payload->>'requirementNumber'=$1", [sourceId])
          : await client.query("SELECT indent_number FROM purchase_indents WHERE deleted_at IS NULL AND payload->>'repurchaseFor'=$1", [sourceId]);
        if (duplicate.rowCount) throw conflict(`This source already has Purchase Indent ${duplicate.rows[0].indent_number}.`);
      }
    }
    if (await readRecord(client, d, id, true)) throw conflict(`${d.key} already exists or is protected by deletion.`);
    if (kind === 'vendorEnquiry' && payload.indentNumber) {
      const indent = await readRecord(client, definitions.purchaseIndent, String(payload.indentNumber), true);
      if (!indent || indent.deleted_at) throw conflict('Referenced Purchase Indent does not exist in PostgreSQL.');
      if (!indent.payload.adminApprovedAt && !indent.payload.repurchaseFor) throw conflict('Purchase Indent must be Admin-approved before Vendor Enquiry.');
      if (indent.payload.sourceType === 'storeDirect') throw conflict('Historical direct indents cannot start new Vendor Enquiries.');
      const existingEnquiry = await client.query(
        'SELECT enquiry_number FROM vendor_enquiries WHERE indent_number=$1 AND deleted_at IS NULL LIMIT 1',
        [String(payload.indentNumber)]
      );
      if (existingEnquiry.rowCount) throw conflict(`Purchase Indent ${payload.indentNumber} already has Vendor Enquiry ${existingEnquiry.rows[0].enquiry_number}.`);
    }
    if (kind === 'vendorEnquiry' && payload.prNumber) {
      const request = await client.query("SELECT status,deleted_at FROM purchase_requests WHERE pr_number=$1 FOR UPDATE", [String(payload.prNumber)]);
      if (!request.rowCount || request.rows[0].deleted_at || request.rows[0].status !== 'Approved') {
        throw conflict(`Purchase Request ${payload.prNumber} must be present in PostgreSQL and Approved before creating a Vendor Enquiry.`);
      }
    }
    if (kind === 'vendorQuotation') {
      const enquiry = await readRecord(client, definitions.vendorEnquiry, String(payload.enquiryNumber), true);
      if (!enquiry || enquiry.deleted_at || enquiry.status === 'Cancelled') throw conflict('Referenced active Vendor Enquiry does not exist in PostgreSQL.');
      if (enquiry.payload.sourceType === 'Purchase Indent' && !(await readRecord(client, definitions.purchaseIndent, String(enquiry.indent_number)))) throw conflict('Referenced Purchase Indent is missing.');
      const vendorId = String(payload.vendorId || '').trim();
      const duplicate = vendorId
        ? await client.query('SELECT quotation_number FROM vendor_quotations WHERE enquiry_number=$1 AND deleted_at IS NULL AND (lower(vendor_id)=lower($2) OR lower(vendor_name)=lower($3))', [enquiry.enquiry_number, vendorId, String(payload.vendorName || '').trim()])
        : await client.query('SELECT quotation_number FROM vendor_quotations WHERE enquiry_number=$1 AND deleted_at IS NULL AND lower(vendor_name)=lower($2)', [enquiry.enquiry_number, String(payload.vendorName || '').trim()]);
      if (duplicate.rowCount) throw conflict(`A quotation from this vendor already exists for enquiry ${enquiry.enquiry_number}.`);
      const nextEnquiry = { ...enquiry.payload, quotationNumbers: [...(enquiry.payload.quotationNumbers || []), id], status: ['Closed', 'Cancelled'].includes(enquiry.status) ? enquiry.status : 'Quotation Received', updatedAt: new Date().toISOString() };
      await client.query('UPDATE vendor_enquiries SET status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE enquiry_number=$1', [enquiry.enquiry_number, nextEnquiry.status, JSON.stringify(nextEnquiry), req.user.email]);
      await audit(client, req, 'vendorEnquiry', enquiry.enquiry_number, 'QUOTATION_RECEIVED', enquiry.payload, nextEnquiry);
    }
    const row = await writeRecord(client, req, kind, d, id, payload, token);
    await audit(client, req, kind, id, 'CREATE', null, payload);
    if (kind === 'purchaseIndent') await linkProductionRequirementIndent(client, req, payload);
    await client.query('COMMIT'); res.status(201).json({ record: view(row, d), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.put('/:kind/:id', async (req, res) => {
  const kind = req.params.kind; const d = definition(kind); authorize(req, d.permissions);
  const version = Number(req.body?.version); if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const patch = req.body?.data; if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Updated record data is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const old = await readRecord(client, d, req.params.id, true);
    if (!old || old.deleted_at) throw Object.assign(new Error('Procurement record not found.'), { status: 404 });
    if (Number(old.version) !== version) throw conflict('Record changed in PostgreSQL. Reload before editing.', view(old, d));
    const merged = { ...old.payload, ...patch, [d.key]: req.params.id, updatedAt: new Date().toISOString() };
    delete merged.version; delete merged.recordVersion;
    validate(kind, merged);
    if (kind === 'vendorEnquiry' && (merged.indentNumber !== old.indent_number || merged.prNumber !== old.pr_number)) throw bad('A Vendor Enquiry source reference cannot be changed after creation.');
    if (kind === 'purchaseIndent' && merged.adminApprovedAt !== old.payload.adminApprovedAt && !isAdmin(req)) throw Object.assign(new Error('Only an Admin can approve a Purchase Indent.'), { status: 403 });
    if (kind === 'purchaseIndent' && merged.status !== old.status) {
      const permittedTransitions = {
        Submitted: { from: ['Draft'], permission: 'indent.submit' },
        'Under Purchase Review': { from: ['Submitted'], permission: 'indent.review' },
        Cancelled: { from: ['Draft', 'Submitted', 'Under Purchase Review', 'Awaiting Production'], admin: true },
        'Converted to PO': { systemOnly: true },
        Completed: { systemOnly: true },
        'Quotation Received': { systemOnly: true },
        'Quotation Accepted': { systemOnly: true },
        'PO Created': { systemOnly: true }
      };
      const rule = permittedTransitions[merged.status];
      if (!rule || rule.systemOnly || !rule.from.includes(old.status)) throw conflict(`Purchase Indent cannot transition from '${old.status}' to '${merged.status}' through this operation.`);
      if (rule.admin && !isAdmin(req)) throw Object.assign(new Error('Only an Admin can cancel a Purchase Indent.'), { status: 403 });
      if (rule.permission && !isAdmin(req)) authorize(req, [rule.permission]);
    }
    if (kind === 'vendorQuotation' && ['Accepted', 'Rejected', 'PO Created', 'Ordered'].includes(String(merged.status)) && !isAdmin(req)) {
      throw Object.assign(new Error('Only an Admin can approve, reject, or mark a Vendor Quotation as ordered.'), { status: 403 });
    }
    if (kind === 'vendorQuotation' && merged.enquiryNumber !== old.enquiry_number) throw bad('A Vendor Quotation cannot be moved to another enquiry.');
    if (kind === 'vendorQuotation') {
      const vendorId = String(merged.vendorId || '').trim();
      const duplicate = vendorId
        ? await client.query('SELECT quotation_number FROM vendor_quotations WHERE enquiry_number=$1 AND quotation_number<>$2 AND deleted_at IS NULL AND (lower(vendor_id)=lower($3) OR lower(vendor_name)=lower($4)) LIMIT 1', [old.enquiry_number, req.params.id, vendorId, String(merged.vendorName || '').trim()])
        : await client.query('SELECT quotation_number FROM vendor_quotations WHERE enquiry_number=$1 AND quotation_number<>$2 AND deleted_at IS NULL AND lower(vendor_name)=lower($3) LIMIT 1', [old.enquiry_number, req.params.id, String(merged.vendorName || '').trim()]);
      if (duplicate.rowCount) throw conflict('A quotation from this vendor already exists for this enquiry.');
    }
    if (kind === 'vendorQuotation' && merged.status === 'Accepted') {
      const problems = [];
      if (!String(merged.vendorName || '').trim()) problems.push('Vendor name is missing.');
      if (!Array.isArray(merged.items) || !merged.items.length) problems.push('Quotation has no items.');
      (merged.items || []).forEach((line, index) => {
        if (!(Number(line.quotedQty) > 0)) problems.push(`Item ${index + 1}: quantity must be greater than zero.`);
        if (line.unitPrice === '' || line.unitPrice == null || !(Number(line.unitPrice) >= 0)) problems.push(`Item ${index + 1}: unit price is missing.`);
        if (!(Number(line.taxPct) >= 0)) problems.push(`Item ${index + 1}: tax percentage is invalid.`);
      });
      if (problems.length) throw bad(`Quotation cannot be accepted: ${problems.join(' ')}`);
      if (['PO Created', 'Ordered'].includes(old.status)) throw conflict('A quotation already converted to a Purchase Order cannot be re-approved.');
    }
    const columns = kind === 'purchaseIndent'
      ? ['so_number=$2', 'project_id=$3']
      : kind === 'vendorEnquiry' ? ['indent_number=$2', 'pr_number=$3'] : ['enquiry_number=$2', 'vendor_id=$3', 'vendor_name=$4'];
    const params = kind === 'purchaseIndent'
      ? [req.params.id, String(merged.soNumber || ''), String(merged.projectId || ''), String(merged.status || ''), JSON.stringify(merged), req.user.email]
      : kind === 'vendorEnquiry'
        ? [req.params.id, String(merged.indentNumber || ''), String(merged.prNumber || ''), String(merged.status || ''), JSON.stringify(merged), req.user.email]
        : [req.params.id, String(merged.enquiryNumber || ''), String(merged.vendorId || ''), String(merged.vendorName || ''), String(merged.status || ''), JSON.stringify(merged), req.user.email];
    const sets = kind === 'purchaseIndent' ? 'so_number=$2,project_id=$3,status=$4,payload=$5::jsonb,version=version+1,updated_at=now(),updated_by=$6'
      : kind === 'vendorEnquiry' ? 'indent_number=$2,pr_number=$3,status=$4,payload=$5::jsonb,version=version+1,updated_at=now(),updated_by=$6'
        : 'enquiry_number=$2,vendor_id=$3,vendor_name=$4,status=$5,payload=$6::jsonb,version=version+1,updated_at=now(),updated_by=$7';
    const result = await client.query(`UPDATE ${d.table} SET ${sets} WHERE ${d.id}=$1 RETURNING *`, params);
    await audit(client, req, kind, req.params.id, 'UPDATE', old.payload, merged);
    if (kind === 'vendorQuotation' && merged.status === 'Accepted' && old.status !== 'Accepted') {
      const alternatives = await client.query("SELECT * FROM vendor_quotations WHERE enquiry_number=$1 AND quotation_number<>$2 AND deleted_at IS NULL AND status NOT IN ('PO Created','Ordered') FOR UPDATE", [old.enquiry_number, req.params.id]);
      for (const alternative of alternatives.rows) {
        const after = { ...alternative.payload, status: 'Rejected', updatedAt: new Date().toISOString() };
        await client.query("UPDATE vendor_quotations SET status='Rejected',payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE quotation_number=$1", [alternative.quotation_number, JSON.stringify(after), req.user.email]);
        await audit(client, req, kind, alternative.quotation_number, 'REJECTED_ON_ALTERNATE_ACCEPTANCE', alternative.payload, after);
      }
    }
    await client.query('COMMIT'); res.json({ record: view(result.rows[0], d) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
router.delete('/:kind/:id', requireAdmin, async (req, res) => {
  const kind = req.params.kind; const d = definition(kind); const reason = String(req.body?.reason || '').trim();
  if (!reason) throw bad('A deletion reason is required.');
  const version = Number(req.body?.version); if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); const old = await readRecord(client, d, req.params.id, true);
    if (!old || old.deleted_at) throw Object.assign(new Error('Procurement record not found.'), { status: 404 });
    if (Number(old.version) !== version) throw conflict('Record changed in PostgreSQL. Reload before deleting.', view(old, d));
    if (kind === 'vendorEnquiry') {
      const linked = await client.query('SELECT 1 FROM vendor_quotations WHERE enquiry_number=$1 AND deleted_at IS NULL LIMIT 1', [req.params.id]);
      if (linked.rowCount) throw conflict('This Vendor Enquiry has quotation history and cannot be deleted.');
    }
    if (kind === 'purchaseIndent') {
      const linked = await client.query('SELECT 1 FROM vendor_enquiries WHERE indent_number=$1 AND deleted_at IS NULL LIMIT 1', [req.params.id]);
      if (linked.rowCount || old.payload.adminApprovedAt || ['Converted to PO', 'Completed'].includes(old.status)) throw conflict('This Purchase Indent has approval or procurement history and cannot be deleted.');
    }
    const result = await client.query(`UPDATE ${d.table} SET deleted_at=now(),deleted_by=$2,delete_reason=$3,updated_at=now(),updated_by=$2,version=version+1 WHERE ${d.id}=$1 RETURNING ${d.id}`, [req.params.id, req.user.email, reason]);
    await audit(client, req, kind, req.params.id, 'SOFT_DELETE', old.payload, null, reason);
    await client.query('COMMIT'); res.json({ deleted: result.rows[0][d.id] });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

export default router;
