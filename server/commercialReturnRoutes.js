import express from 'express';
import { getPool } from './database.js';
import { requireDepartmentPermission, safeAuditValues } from './auth.js';
import { postStockMovement } from './stockLedger.js';

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const numValue = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value) => String(value ?? '').trim();
const validDate = (value) => {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};
const dateOnly = (value) => value instanceof Date
  ? value.toISOString().slice(0, 10)
  : String(value || '').slice(0, 10);
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.roleKey === 'administrator' || req.user?.role === 'Administrator';

const settings = {
  sales: {
    prefix: 'SRTN', invoiceTable: 'customer_invoices', invoiceColumn: 'customer_invoice_number',
    module: 'salesReturns', partyColumn: 'customer_name'
  },
  purchase: {
    prefix: 'PRTN', invoiceTable: 'supplier_invoices', invoiceColumn: 'supplier_invoice_number',
    module: 'purchaseReturns', partyColumn: 'vendor_name'
  }
};

const itemView = (row, returnType) => ({
  sourceLineNumber: Number(row.source_line_number),
  itemCode: row.item_code,
  itemName: row.item_name,
  drawingNo: row.drawing_no,
  unit: row.unit,
  ...(returnType === 'sales'
    ? { invoicedQty: numValue(row.source_quantity) }
    : { billedQty: numValue(row.source_quantity) }),
  returnQty: numValue(row.quantity),
  unitPrice: numValue(row.unit_price),
  amount: numValue(row.line_amount),
  reason: row.reason
});

const recordView = (row, items) => ({
  returnNumber: row.return_number,
  returnType: row.return_type,
  date: dateOnly(row.return_date),
  ...(row.return_type === 'sales'
    ? { invRef: row.source_invoice_number, customer: row.party_name, returnedBy: row.counterparty_contact }
    : { billRef: row.source_invoice_number, supplier: row.party_name, returnedTo: row.counterparty_contact }),
  items: items.map((item) => itemView(item, row.return_type)),
  totalValue: numValue(row.total_value),
  remarks: row.remarks,
  status: row.status || 'Draft',
  submittedAt: row.submitted_at,
  approvedAt: row.approved_at,
  approvedBy: row.approved_by,
  rejectedAt: row.rejected_at,
  rejectedBy: row.rejected_by,
  rejectionReason: row.rejection_reason,
  stockPostedAt: row.stock_posted_at,
  accountingPostedAt: row.accounting_posted_at,
  accountingReference: row.accounting_reference,
  accountingEntryType: row.accounting_entry_type,
  version: Number(row.version),
  createdBy: row.created_by,
  createdAt: row.created_at
});

const listRecords = async (type, returnNumber = '') => {
  const params = [type];
  let filter = 'r.return_type=$1 AND r.deleted_at IS NULL';
  if (returnNumber) {
    params.push(returnNumber);
    filter += ' AND r.return_number=$2';
  }
  const headers = await getPool().query(
    `SELECT r.* FROM commercial_returns r WHERE ${filter}
     ORDER BY r.return_date DESC,r.return_number DESC`,
    params
  );
  if (returnNumber && !headers.rowCount) throw notFound(`${type === 'sales' ? 'Sales' : 'Purchase'} Return not found.`);
  const ids = headers.rows.map((row) => row.return_number);
  const lines = ids.length
    ? await getPool().query(
      'SELECT * FROM commercial_return_items WHERE return_number=ANY($1::text[]) ORDER BY return_number,line_number',
      [ids]
    )
    : { rows: [] };
  const byReturn = new Map();
  for (const line of lines.rows) {
    const rows = byReturn.get(line.return_number) || [];
    rows.push(line);
    byReturn.set(line.return_number, rows);
  }
  return headers.rows.map((row) => recordView(row, byReturn.get(row.return_number) || []));
};

const sourceItems = async (client, type, invoice) => {
  if (type === 'sales') {
    const result = await client.query(
      'SELECT line_number,quantity,unit_price,payload FROM customer_invoice_items WHERE invoice_number=$1 ORDER BY line_number',
      [invoice.invoice_number]
    );
    return result.rows.map((row) => ({
      sourceLineNumber: Number(row.line_number),
      sourceQuantity: numValue(row.quantity),
      unitPrice: numValue(row.unit_price),
      item: row.payload || {}
    }));
  }
  const items = invoice.payload?.payload?.items || invoice.payload?.items;
  if (!Array.isArray(items)) throw conflict('Supplier Invoice does not contain persisted item lines.');
  return items.map((item, index) => ({
    sourceLineNumber: index + 1,
    sourceQuantity: numValue(item.quantity),
    unitPrice: numValue(item.unitPrice),
    item: item || {}
  }));
};

const auditReturn = (client, req, type, row, action, before, after, reason = '') =>
  client.query(
    `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [req.user?.id || '', req.user?.email || '', req.user?.role || req.user?.roleKey || '',
      type === 'sales' ? 'salesReturns' : 'purchaseReturns',
      row.return_number, row.return_number, action, text(reason),
      before ? JSON.stringify(safeAuditValues(before)) : null,
      after ? JSON.stringify(safeAuditValues(after)) : null]
  );

const lockReturn = async (client, type, returnNumber) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('commercial-return:' || $1))", [returnNumber]);
  const result = await client.query(
    'SELECT * FROM commercial_returns WHERE return_number=$1 AND return_type=$2 AND deleted_at IS NULL FOR UPDATE',
    [returnNumber, type]
  );
  if (!result.rowCount) throw notFound(`${type === 'sales' ? 'Sales' : 'Purchase'} Return not found.`);
  return result.rows[0];
};

const loadLines = (client, returnNumber) =>
  client.query('SELECT * FROM commercial_return_items WHERE return_number=$1 ORDER BY line_number', [returnNumber]);

const authorizeLifecycle = (req, type) => {
  if (isAdmin(req)) return;
  const roleKey = String(req.user?.roleKey || '').toLowerCase();
  const allowed = type === 'sales' ? roleKey.startsWith('sales') : roleKey.startsWith('purchase');
  if (!allowed) throw Object.assign(new Error(`Only ${type === 'sales' ? 'Sales' : 'Purchase'} department management or an Administrator can perform this action.`), { status: 403 });
};

const prepareLines = (requestedItems, sourceByLine) => {
  if (!Array.isArray(requestedItems) || !requestedItems.length) throw bad('At least one return line is required.');
  const seen = new Set();
  let totalValue = 0;
  const prepared = requestedItems.map((requested) => {
    const sourceLineNumber = Number(requested.sourceLineNumber);
    if (!Number.isInteger(sourceLineNumber) || sourceLineNumber < 1 || seen.has(sourceLineNumber)) {
      throw bad('Return lines must reference each source invoice line exactly once.');
    }
    seen.add(sourceLineNumber);
    const source = sourceByLine.get(sourceLineNumber);
    if (!source) throw conflict(`Source invoice line ${sourceLineNumber} no longer exists.`);
    const quantity = Number(requested.returnQty);
    if (!Number.isFinite(quantity) || quantity <= 0) throw bad('Return quantities must be positive numbers.');
    if (quantity > source.sourceQuantity + 0.00005) throw conflict(`Return quantity exceeds source invoice quantity for line ${sourceLineNumber}.`);
    const amount = quantity * source.unitPrice;
    totalValue += amount;
    return {
      sourceLineNumber,
      sourceQuantity: source.sourceQuantity,
      itemCode: text(source.item.itemCode),
      itemName: text(source.item.itemName || source.item.name),
      drawingNo: text(source.item.drawingNo),
      unit: text(source.item.unit || 'Nos'),
      quantity,
      unitPrice: source.unitPrice,
      amount,
      reason: text(requested.reason),
      payload: source.item
    };
  });
  return { prepared, totalValue };
};

const insertLines = async (client, returnNumber, prepared) => {
  await client.query('DELETE FROM commercial_return_items WHERE return_number=$1', [returnNumber]);
  for (const [index, item] of prepared.entries()) {
    await client.query(
      `INSERT INTO commercial_return_items
        (return_number,line_number,source_line_number,item_code,item_name,drawing_no,unit,source_quantity,quantity,unit_price,line_amount,reason,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [returnNumber, index + 1, item.sourceLineNumber, item.itemCode, item.itemName, item.drawingNo, item.unit,
        item.sourceQuantity, item.quantity, item.unitPrice, item.amount, item.reason, JSON.stringify(item.payload)]
    );
  }
};

const createReturn = async (req, res, type) => {
  const input = req.body?.data;
  const token = text(req.body?.createToken);
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid idempotency token is required.');
  const sourceInvoiceNumber = text(input?.sourceInvoiceNumber || input?.invRef || input?.billRef);
  const counterparty = text(type === 'sales' ? input?.returnedBy : input?.returnedTo);
  const date = text(input?.date);
  if (!sourceInvoiceNumber) throw bad('A source invoice is required.');
  if (!counterparty) throw bad(type === 'sales' ? 'Returned By is required.' : 'Returning To Supplier is required.');
  if (!validDate(date)) throw bad('Return date must use YYYY-MM-DD format.');

  const config = settings[type];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('commercial-return-token:' || $1))", [token]);
    const retry = await client.query('SELECT * FROM commercial_returns WHERE create_token=$1 FOR UPDATE', [token]);
    if (retry.rowCount) {
      if (retry.rows[0].return_type !== type) throw conflict('The idempotency token was already used for a different return type.');
      await client.query('COMMIT');
      const record = (await listRecords(type, retry.rows[0].return_number))[0];
      return res.status(200).json({ record, duplicate: true });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext('commercial-return-source:' || $1 || ':' || $2))", [type, sourceInvoiceNumber]);
    const source = await client.query(
      `SELECT * FROM ${config.invoiceTable} WHERE invoice_number=$1 AND deleted_at IS NULL FOR UPDATE`,
      [sourceInvoiceNumber]
    );
    if (!source.rowCount) throw notFound(`${type === 'sales' ? 'Customer' : 'Supplier'} Invoice not found in PostgreSQL.`);
    const invoice = source.rows[0];
    const sourceLines = await sourceItems(client, type, invoice);
    const sourceByLine = new Map(sourceLines.map((line) => [line.sourceLineNumber, line]));

    const prior = await client.query(
      `SELECT i.source_line_number,COALESCE(sum(i.quantity),0) AS quantity
         FROM commercial_return_items i JOIN commercial_returns r ON r.return_number=i.return_number
        WHERE r.return_type=$1 AND r.source_invoice_number=$2 AND r.deleted_at IS NULL
        GROUP BY i.source_line_number`,
      [type, sourceInvoiceNumber]
    );
    const already = new Map(prior.rows.map((row) => [Number(row.source_line_number), numValue(row.quantity)]));
    for (const requested of input.items || []) {
      const line = Number(requested.sourceLineNumber);
      const sourceLine = sourceByLine.get(line);
      if (sourceLine && numValue(requested.returnQty) + (already.get(line) || 0) > sourceLine.sourceQuantity + 0.00005) {
        throw conflict(`Return quantity exceeds the remaining source quantity for line ${line}.`);
      }
    }

    const { prepared, totalValue } = prepareLines(input.items, sourceByLine);
    for (const item of prepared) {
      if (item.quantity + (already.get(item.sourceLineNumber) || 0) > item.sourceQuantity + 0.00005) {
        throw conflict(`Return quantity exceeds the remaining source quantity for line ${item.sourceLineNumber}.`);
      }
    }

    const year = date.slice(2, 4);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('commercial-return-number:' || $1 || ':' || $2))", [type, year]);
    const prefix = `${config.prefix}-${year}`;
    const sequence = await client.query(
      `SELECT COALESCE(max((regexp_match(return_number,'([0-9]+)$'))[1]::bigint),0) AS last_number
         FROM commercial_returns WHERE return_type=$1 AND return_number LIKE $2`,
      [type, `${prefix}%`]
    );
    const returnNumber = `${prefix}${String(Number(sequence.rows[0].last_number) + 1).padStart(4, '0')}`;
    const partyName = text(invoice[config.partyColumn]);
    const header = await client.query(
      `INSERT INTO commercial_returns
        (return_number,return_type,source_invoice_number,${config.invoiceColumn},return_date,party_name,counterparty_contact,remarks,total_value,status,create_token,created_by,updated_by)
       VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,'Draft',$9,$10,$10) RETURNING *`,
      [returnNumber, type, sourceInvoiceNumber, date, partyName, counterparty, text(input.remarks), totalValue, token, req.user.email]
    );
    await insertLines(client, returnNumber, prepared);
    const view = recordView(header.rows[0], prepared.map((item, index) => ({
      return_number: returnNumber,
      line_number: index + 1,
      source_line_number: item.sourceLineNumber,
      item_code: item.itemCode,
      item_name: item.itemName,
      drawing_no: item.drawingNo,
      unit: item.unit,
      source_quantity: item.sourceQuantity,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      line_amount: item.amount,
      reason: item.reason
    })));
    await auditReturn(client, req, type, header.rows[0], 'CREATE', null, view, text(input.remarks));
    await client.query('COMMIT');
    res.status(201).json({ record: view, duplicate: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const updateReturn = async (req, res, type) => {
  const number = text(req.params.number);
  const input = req.body?.data;
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await lockReturn(client, type, number);
    if (Number(row.version) !== version) throw conflict('Commercial Return changed on the server. Reload before editing.');
    if (!['Draft', 'Rejected'].includes(row.status || 'Draft')) throw conflict(`Commercial Return cannot be edited from ${row.status}.`);
    const beforeLines = await loadLines(client, number);
    const before = recordView(row, beforeLines.rows);
    const config = settings[type];
    const invoice = (await client.query(
      `SELECT * FROM ${config.invoiceTable} WHERE invoice_number=$1 AND deleted_at IS NULL`,
      [row.source_invoice_number]
    )).rows[0];
    if (!invoice) throw notFound('The source invoice is no longer available.');
    const sourceLines = await sourceItems(client, type, invoice);
    const sourceByLine = new Map(sourceLines.map((line) => [line.sourceLineNumber, line]));
    const { prepared, totalValue } = prepareLines(input?.items, sourceByLine);
    const counterparty = text(type === 'sales' ? input?.returnedBy : input?.returnedTo);
    const date = text(input?.date || dateOnly(row.return_date));
    if (!counterparty) throw bad(type === 'sales' ? 'Returned By is required.' : 'Returning To Supplier is required.');
    if (!validDate(date)) throw bad('Return date must use YYYY-MM-DD format.');

    const updated = await client.query(
      `UPDATE commercial_returns
         SET return_date=$2,party_name=$3,counterparty_contact=$4,remarks=$5,total_value=$6,status='Draft',
             submitted_at=NULL,approved_at=NULL,approved_by='',rejected_at=NULL,rejected_by='',rejection_reason='',
             stock_posted_at=NULL,accounting_posted_at=NULL,accounting_reference='',accounting_entry_type='',
             version=version+1,updated_at=now(),updated_by=$7
       WHERE return_number=$1 RETURNING *`,
      [number, date, text(invoice[config.partyColumn]), counterparty, text(input?.remarks), totalValue, req.user.email]
    );
    await insertLines(client, number, prepared);
    const afterLines = await loadLines(client, number);
    const after = recordView(updated.rows[0], afterLines.rows);
    await auditReturn(client, req, type, updated.rows[0], 'UPDATE', before, after);
    await client.query('COMMIT');
    res.json({ record: after });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const deleteReturn = async (req, res, type) => {
  const number = text(req.params.number);
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A deletion reason is required.');
  if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await lockReturn(client, type, number);
    if (Number(row.version) !== version) throw conflict('Commercial Return changed on the server. Reload before deleting.');
    if (!['Draft', 'Rejected'].includes(row.status || 'Draft')) throw conflict(`Commercial Return cannot be deleted from ${row.status}.`);
    const lines = await loadLines(client, number);
    const before = recordView(row, lines.rows);
    await client.query(
      'UPDATE commercial_returns SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE return_number=$1',
      [number, req.user.email, reason]
    );
    await auditReturn(client, req, type, row, 'SOFT_DELETE', before, null, reason);
    await client.query('COMMIT');
    res.json({ deleted: number });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const submitReturn = async (req, res, type) => {
  const number = text(req.params.number);
  const version = Number(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await lockReturn(client, type, number);
    if (Number(row.version) !== version) throw conflict('Commercial Return changed on the server. Reload before submitting.');
    if (!['Draft', 'Rejected'].includes(row.status || 'Draft')) throw conflict(`Commercial Return is already ${row.status}.`);
    const beforeLines = await loadLines(client, number);
    const before = recordView(row, beforeLines.rows);
    const updated = await client.query(
      `UPDATE commercial_returns SET status='Submitted',submitted_at=now(),rejected_at=NULL,rejected_by='',rejection_reason='',
         version=version+1,updated_at=now(),updated_by=$2 WHERE return_number=$1 RETURNING *`,
      [number, req.user.email]
    );
    const after = recordView(updated.rows[0], beforeLines.rows);
    await auditReturn(client, req, type, updated.rows[0], 'SUBMIT', before, after);
    await client.query('COMMIT');
    res.json({ record: after });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const rejectReturn = async (req, res, type) => {
  authorizeLifecycle(req, type);
  const number = text(req.params.number);
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A rejection reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await lockReturn(client, type, number);
    if (Number(row.version) !== version) throw conflict('Commercial Return changed on the server. Reload before rejecting.');
    if (!['Submitted', 'Draft'].includes(row.status || 'Draft')) throw conflict(`Commercial Return cannot be rejected from ${row.status}.`);
    const beforeLines = await loadLines(client, number);
    const before = recordView(row, beforeLines.rows);
    const updated = await client.query(
      `UPDATE commercial_returns SET status='Rejected',rejected_at=now(),rejected_by=$2,rejection_reason=$3,
         version=version+1,updated_at=now(),updated_by=$2 WHERE return_number=$1 RETURNING *`,
      [number, req.user.email, reason]
    );
    const after = recordView(updated.rows[0], beforeLines.rows);
    await auditReturn(client, req, type, updated.rows[0], 'REJECT', before, after, reason);
    await client.query('COMMIT');
    res.json({ record: after });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const approveReturn = async (req, res, type) => {
  authorizeLifecycle(req, type);
  const number = text(req.params.number);
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await lockReturn(client, type, number);
    if (Number(row.version) !== version) throw conflict('Commercial Return changed on the server. Reload before approving.');
    if (!['Submitted', 'Draft'].includes(row.status || 'Draft')) throw conflict(`Commercial Return cannot be approved from ${row.status}.`);
    if (row.stock_posted_at || row.accounting_posted_at) throw conflict('This return has already been posted.');

    const lineResult = await loadLines(client, number);
    const before = recordView(row, lineResult.rows);
    let accountingReference = '';
    let accountingEntryType = '';

    for (const line of lineResult.rows) {
      await postStockMovement(client, req, {
        ledgerId: `${type === 'sales' ? 'sales-return' : 'purchase-return'}-${number}-${line.line_number}`,
        itemCode: line.item_code,
        materialName: line.item_name,
        movementType: type === 'sales' ? 'RETURN' : 'RETURN_OUT',
        quantity: numValue(line.quantity),
        unit: line.unit || 'Nos',
        unitCost: numValue(line.unit_price),
        entryDate: dateOnly(row.return_date),
        sourceDocType: `${type === 'sales' ? 'Sales' : 'Purchase'} Return`,
        sourceDocRef: number,
        reason: text(line.reason, `${type === 'sales' ? 'Customer' : 'Supplier'} commercial return`)
      });
    }

    if (type === 'sales') {
      accountingEntryType = 'CREDIT_NOTE';
      accountingReference = `CN-${number}`;
      const invoice = (await client.query(
        'SELECT * FROM customer_invoices WHERE invoice_number=$1 AND deleted_at IS NULL FOR UPDATE',
        [row.source_invoice_number]
      )).rows[0];
      if (!invoice) throw conflict('The source Customer Invoice no longer exists.');
      const grandTotal = Math.max(0, numValue(invoice.grand_total) - numValue(row.total_value));
      const balanceDue = Math.max(0, grandTotal - numValue(invoice.amount_received));
      const paymentStatus = balanceDue <= 0.00005 ? 'Paid' : numValue(invoice.amount_received) > 0 ? 'Partial' : 'Pending';
      const beforePayload = invoice.payload || {};
      const afterPayload = {
        ...beforePayload,
        totals: { ...(beforePayload.totals || {}), grandTotal },
        creditNoteDetails: {
          ...(beforePayload.creditNoteDetails || {}),
          creditNoteNumber: accountingReference,
          creditNoteDate: new Date().toISOString().slice(0, 10),
          amount: String(numValue(row.total_value)),
          reason: text(reason, 'Commercial sales return'),
          originalInvoiceRef: row.source_invoice_number
        }
      };
      await client.query(
        `UPDATE customer_invoices SET grand_total=$2,balance_due=$3,payment_status=$4,payload=$5::jsonb,
           balance_inr=$6,version=version+1,updated_at=now(),updated_by=$7
         WHERE invoice_number=$1`,
        [row.source_invoice_number, grandTotal, balanceDue, paymentStatus, JSON.stringify(afterPayload),
          Math.max(0, numValue(invoice.amount_inr) - numValue(row.total_value)), req.user.email]
      );
      await client.query(
        `INSERT INTO customer_invoice_audit(invoice_number,user_id,email,role,action,reason,before_values,after_values)
         VALUES($1,$2,$3,$4,'SALES_RETURN_APPROVED',$5,$6::jsonb,$7::jsonb)`,
        [row.source_invoice_number, req.user.id, req.user.email, req.user.role,
          text(reason, `Sales Return ${number} approved`),
          JSON.stringify(safeAuditValues(beforePayload)), JSON.stringify(safeAuditValues(afterPayload))]
      );
    } else {
      accountingEntryType = 'DEBIT_NOTE';
      accountingReference = `DN-${number}`;
      const invoice = (await client.query(
        'SELECT * FROM supplier_invoices WHERE invoice_number=$1 AND deleted_at IS NULL FOR UPDATE',
        [row.source_invoice_number]
      )).rows[0];
      if (!invoice) throw conflict('The source Supplier Invoice no longer exists.');
      const payload = invoice.payload || {};
      await client.query(
        `INSERT INTO debit_notes(debit_note_number,debit_note_date,rejection_number,po_number,invoice_number,vendor_id,vendor_name,
           subtotal,total_gst,grand_total,status,remarks,created_by,updated_by,version,payload)
         VALUES($1,$2,NULL,$3,$4,'',$5,$6,0,$6,'Approved',$7,$8,$8,1,$9::jsonb)
         ON CONFLICT(debit_note_number) DO NOTHING`,
        [accountingReference, new Date().toISOString().slice(0, 10), invoice.po_number || '', row.source_invoice_number,
          row.party_name, numValue(row.total_value), text(reason, `Purchase Return ${number} approved`),
          req.user.email, JSON.stringify({
            debitNoteNumber: accountingReference,
            commercialReturnNumber: number,
            originalInvoiceRef: row.source_invoice_number,
            amount: numValue(row.total_value),
            grandTotal: numValue(row.total_value),
            vendorDetails: payload.vendorDetails || {},
            items: lineResult.rows.map((line) => ({
              materialCode: line.item_code,
              materialName: line.item_name,
              debitQty: numValue(line.quantity),
              unitPrice: numValue(line.unit_price),
              totalAmount: numValue(line.line_amount)
            })),
            reason: text(reason, 'Commercial purchase return')
          })]
      );
      await client.query(
        `INSERT INTO debit_note_items(debit_note_number,line_number,material_code,material_name,debit_qty,unit_price,taxable_amount,gst_rate,gst_amount,total_amount,unit,payload)
         SELECT $1,line_number,item_code,item_name,quantity,unit_price,line_amount,0,0,line_amount,unit,payload
           FROM commercial_return_items WHERE return_number=$2
           ON CONFLICT DO NOTHING`,
        [accountingReference, number]
      );
      const afterPayload = {
        ...payload,
        debitNotes: [...(Array.isArray(payload.debitNotes) ? payload.debitNotes : []), accountingReference],
        commercialReturnCredits: [
          ...(Array.isArray(payload.commercialReturnCredits) ? payload.commercialReturnCredits : []),
          { returnNumber: number, debitNoteNumber: accountingReference, amount: numValue(row.total_value) }
        ]
      };
      await client.query(
        'UPDATE supplier_invoices SET payload=$2::jsonb,status=$3,version=version+1,updated_at=now(),updated_by=$4 WHERE invoice_number=$1',
        [row.source_invoice_number, JSON.stringify(afterPayload),
          'Partially Returned', req.user.email]
      );
      await client.query(
        `INSERT INTO supplier_invoice_audit(invoice_number,actor_id,actor_email,actor_role,action,reason,before_values,after_values)
         VALUES($1,$2,$3,$4,'PURCHASE_RETURN_APPROVED',$5,$6::jsonb,$7::jsonb)`,
        [row.source_invoice_number, req.user.id, req.user.email, req.user.role,
          text(reason, `Purchase Return ${number} approved`),
          JSON.stringify(safeAuditValues(payload)), JSON.stringify(safeAuditValues(afterPayload))]
      );
    }

    const now = new Date().toISOString();
    const updated = await client.query(
      `UPDATE commercial_returns SET status='Approved',approved_at=$2,approved_by=$3,stock_posted_at=$2,
         accounting_posted_at=$2,accounting_reference=$4,accounting_entry_type=$5,
         version=version+1,updated_at=now(),updated_by=$3 WHERE return_number=$1 RETURNING *`,
      [number, now, req.user.email, accountingReference, accountingEntryType]
    );
    const after = recordView(updated.rows[0], lineResult.rows);
    await auditReturn(client, req, type, updated.rows[0], 'APPROVE', before, after, reason);
    await client.query('COMMIT');
    res.json({ record: after });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

for (const type of Object.keys(settings)) {
  router.get(`/${type}`, requireDepartmentPermission('material_return.view'), async (_req, res) => {
    res.json({ records: await listRecords(type) });
  });
  router.get(`/${type}/:number`, requireDepartmentPermission('material_return.view'), async (req, res) => {
    res.json({ record: (await listRecords(type, req.params.number))[0] });
  });
  router.post(`/${type}`, requireDepartmentPermission('material_return.create'), async (req, res) => {
    await createReturn(req, res, type);
  });
  router.put(`/${type}/:number`, requireDepartmentPermission('material_return.create'), async (req, res) => {
    await updateReturn(req, res, type);
  });
  router.delete(`/${type}/:number`, requireDepartmentPermission('material_return.create'), async (req, res) => {
    await deleteReturn(req, res, type);
  });
  router.post(`/${type}/:number/submit`, requireDepartmentPermission('material_return.create'), async (req, res) => {
    await submitReturn(req, res, type);
  });
  router.post(`/${type}/:number/approve`, requireDepartmentPermission('material_return.view'), async (req, res) => {
    await approveReturn(req, res, type);
  });
  router.post(`/${type}/:number/reject`, requireDepartmentPermission('material_return.view'), async (req, res) => {
    await rejectReturn(req, res, type);
  });
}

export default router;
