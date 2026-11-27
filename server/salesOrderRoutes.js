import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { money, convertToINR } from '../src/utils/currency.js';

const router = express.Router();
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const versionOf = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const validPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('Sales Order data is required.');
  const details = payload.soDetails || {};
  const customer = payload.customerDetails || {};
  const number = String(details.soNumber || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(number)) throw badRequest('A valid Sales Order number is required.');
  if (!String(customer.customerName || customer.companyName || '').trim()) throw badRequest('Customer name is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(details.soDate || ''))) throw badRequest('Sales Order date must use YYYY-MM-DD format.');
  if (!Array.isArray(payload.items) || payload.items.length === 0) throw badRequest('At least one Sales Order item is required.');
  if (Buffer.byteLength(JSON.stringify(payload)) > 5 * 1024 * 1024) throw Object.assign(new Error('Sales Order exceeds the record size limit.'), { status: 413 });
  return number;
};
const normalizeSalesOrderItems = (payload, itemRows = []) => {
  const payloadItems = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.orderItems)
      ? payload.orderItems
      : Array.isArray(payload?.lineItems)
        ? payload.lineItems
        : Array.isArray(payload?.soDetails?.items)
          ? payload.soDetails.items
          : Array.isArray(payload?.soDetails?.orderItems)
            ? payload.soDetails.orderItems
            : [];

  if (itemRows.length) {
    return itemRows.map((line, index) => {
      const payloadLine = payloadItems[index] && typeof payloadItems[index] === 'object' ? payloadItems[index] : {};
      const normalizedPayload = typeof line.payload === 'string'
        ? (() => { try { return JSON.parse(line.payload); } catch { return {}; } })()
        : (line.payload && typeof line.payload === 'object' ? line.payload : {});
      const merged = { ...payloadLine, ...normalizedPayload };
      const itemName = String(line.item_name || merged.itemName || merged.item_name || merged.name || '').trim();
      const quantity = finite(line.quantity) || finite(merged.quantity) || 0;
      const unitPrice = finite(line.unit_price) || finite(merged.unitPrice) || finite(merged.unit_price) || 0;
      const lineAmount = finite(line.line_amount) || finite(merged.amount) || finite(merged.lineAmount) || quantity * unitPrice;
      return {
        ...merged,
        lineNumber: Number(line.line_number) || index + 1,
        lineId: String(merged.lineId || merged.line_id || merged.id || '').trim(),
        itemCode: String(merged.itemCode || merged.item_code || merged.materialCode || '').trim(),
        itemName,
        drawingNo: String(merged.drawingNo || merged.drawingNumber || merged.drawing_no || '').trim(),
        quantity,
        unit: String(merged.unit || 'Nos').trim() || 'Nos',
        unitPrice,
        amount: lineAmount
      };
    });
  }

  return payloadItems.map((line, index) => {
    const merged = line && typeof line === 'object' ? line : {};
    const quantity = finite(merged.quantity) || 0;
    const unitPrice = finite(merged.unitPrice) || finite(merged.unit_price) || 0;
    return {
      ...merged,
      lineNumber: index + 1,
      lineId: String(merged.lineId || merged.line_id || merged.id || '').trim(),
      itemCode: String(merged.itemCode || merged.item_code || merged.materialCode || '').trim(),
      itemName: String(merged.itemName || merged.item_name || merged.name || '').trim(),
      drawingNo: String(merged.drawingNo || merged.drawingNumber || merged.drawing_no || '').trim(),
      quantity,
      unit: String(merged.unit || 'Nos').trim() || 'Nos',
      unitPrice,
      amount: finite(merged.amount) || finite(merged.lineAmount) || quantity * unitPrice
    };
  });
};
const view = (row, itemRows = []) => {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const currency = payload.soDetails?.currency || row.currency || 'INR';
  const items = normalizeSalesOrderItems(payload, itemRows);
  const customerName = String(payload.customerDetails?.companyName || payload.customerDetails?.customerName || row.customer_name || '').trim();
  const normalizedPayload = {
    ...payload,
    customerDetails: {
      ...(payload.customerDetails && typeof payload.customerDetails === 'object' ? payload.customerDetails : {}),
      customerName: String(payload.customerDetails?.customerName || customerName).trim(),
      companyName: String(payload.customerDetails?.companyName || customerName).trim()
    },
    soDetails: {
      ...(payload.soDetails && typeof payload.soDetails === 'object' ? payload.soDetails : {}),
      soNumber: String(payload.soDetails?.soNumber || row.so_number).trim(),
      soDate: String(payload.soDetails?.soDate || String(row.so_date).slice(0, 10)).trim(),
      projectId: String(payload.soDetails?.projectId || row.project_id || '').trim(),
      currency
    },
    items
  };
  return {
    date: String(row.so_date).slice(0, 10), reference: row.so_number,
    quotationRef: row.quotation_ref || '-', company: payload.customerDetails?.companyName || row.customer_name,
    total: money(finite(row.grand_total), currency), currency, amountINR: finite(row.amount_inr),
    status: row.status, version: Number(row.version), payload: { ...normalizedPayload, recordVersion: Number(row.version) }
  };
};
const audit = (client, req, { number, action, before = null, after = null, reason = '' }) => client.query(
  `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES ($1,$2,$3,'salesOrders',$4,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [req.user.id, req.user.email, req.user.role, number, action, reason,
    before == null ? null : JSON.stringify(safeAuditValues(before)),
    after == null ? null : JSON.stringify(safeAuditValues(after))]
);
const insertItems = async (client, number, items) => {
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO sales_order_items (so_number,line_number,item_name,quantity,unit_price,line_amount,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [number, index + 1, String(item?.itemName || ''), finite(item?.quantity), finite(item?.unitPrice), finite(item?.amount), JSON.stringify(item)]
    );
  }
};
const linkedStatus = async (client, req, payload, soNumber) => {
  const quotationRef = String(payload.soDetails?.quotationRef || '').trim();
  const poNumber = String(payload.soDetails?.customerPoNumber || '').trim();
  if (quotationRef) {
    const quote = await client.query('SELECT * FROM quotations WHERE lower(quotation_number)=lower($1) AND deleted_at IS NULL FOR UPDATE', [quotationRef]);
    if (!quote.rowCount) throw conflict(`Quotation ${quotationRef} is not available in PostgreSQL. Review/import it before conversion.`);
    if (/^(converted|invoiced)/i.test(String(quote.rows[0].balance_status || ''))) throw conflict(`Quotation ${quotationRef} is already converted or invoiced.`);
    const status = `Converted (${soNumber})`;
    const payloadAfter = { ...quote.rows[0].payload, balanceStatus: status };
    await client.query('UPDATE quotations SET balance_status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE quotation_number=$1', [quote.rows[0].quotation_number, status, JSON.stringify(payloadAfter), req.user.email]);
    await audit(client, req, { number: quotationRef, action: 'CONVERT_TO_SALES_ORDER', before: quote.rows[0].payload, after: payloadAfter, reason: soNumber });
  }
  if (poNumber) {
    const po = await client.query('SELECT * FROM customer_purchase_orders WHERE lower(po_number)=lower($1) AND deleted_at IS NULL FOR UPDATE', [poNumber]);
    if (!po.rowCount) throw conflict(`Customer PO ${poNumber} is not available in PostgreSQL. Review/import it before conversion.`);
    if (/^Converted/i.test(String(po.rows[0].status || ''))) throw conflict(`Customer PO ${poNumber} has already been converted.`);
    const status = `Converted (${soNumber})`;
    await client.query(
      `UPDATE customer_purchase_orders SET status=$2,
       header_data=jsonb_set(header_data,'{poDetails,poStatus}',to_jsonb($2::text),true),
       version=version+1,updated_at=now() WHERE id=$1`, [po.rows[0].id, status]
    );
    await audit(client, req, { number: poNumber, action: 'CONVERT_TO_SALES_ORDER', before: po.rows[0].header_data, after: { ...po.rows[0].header_data, status }, reason: soNumber });
  }
};

router.get('/', async (_req, res) => {
  const result = await getPool().query('SELECT * FROM sales_orders WHERE deleted_at IS NULL ORDER BY so_date DESC,so_number DESC');
  const records = [];
  for (const row of result.rows) {
    const itemRows = await getPool().query(
      'SELECT * FROM sales_order_items WHERE so_number=$1 ORDER BY line_number',
      [row.so_number]
    );
    records.push(view(row, itemRows.rows));
  }
  res.json({ records });
});
router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const pool = getPool();
  const [legacy, current] = await Promise.all([
    pool.query("SELECT data FROM erp_state WHERE storage_key='salesOrderHistory'"),
    pool.query('SELECT so_number,payload,deleted_at FROM sales_orders')
  ]);
  const records = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
  const byId = new Map(current.rows.map((row) => [row.so_number.toLowerCase(), row]));
  const eligible = [], existing = [], conflicts = [], deleted = [], seen = new Set();
  for (const item of records) {
    const payload = item?.payload;
    const number = String(payload?.soDetails?.soNumber || item?.reference || '').trim();
    if (!number || seen.has(number.toLowerCase())) { if (number) conflicts.push({ number, reason: 'Duplicate legacy ID' }); continue; }
    seen.add(number.toLowerCase());
    const currentRow = byId.get(number.toLowerCase());
    if (currentRow?.deleted_at) deleted.push({ number });
    else if (currentRow) {
      const server = typeof currentRow.payload === 'string' ? JSON.parse(currentRow.payload) : currentRow.payload;
      (JSON.stringify(server) === JSON.stringify(payload) ? existing : conflicts).push({ number });
    } else {
      try { validPayload(payload); eligible.push({ number, payload }); }
      catch (error) { conflicts.push({ number, reason: error.message }); }
    }
  }
  res.json({ eligible, existing, conflicts, deleted, counts: { eligible: eligible.length, existing: existing.length, conflicts: conflicts.length, deleted: deleted.length } });
});
router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 1000) throw badRequest('Select between 1 and 1000 Sales Orders to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const imported = [], conflicts = [];
    for (const payload of records) {
      const number = validPayload(payload);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sales-order:' || $1))", [number]);
      const exists = await client.query('SELECT deleted_at FROM sales_orders WHERE so_number=$1 FOR UPDATE', [number]);
      if (exists.rowCount) { conflicts.push({ number, reason: exists.rows[0].deleted_at ? 'Deleted ID is protected' : 'Record already exists' }); continue; }
      const details = payload.soDetails || {}, customer = payload.customerDetails || {};
      const currency = String(details.currency || 'INR');
      const total = finite(payload.totals?.grandTotal);
      const amountINR = convertToINR(total, currency, details.exchangeRate);
      await client.query(
        `INSERT INTO sales_orders (so_number,so_date,customer_name,project_id,quotation_ref,customer_po_number,status,currency,grand_total,amount_inr,payload,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12)`,
        [number, details.soDate, customer.customerName || customer.companyName, details.projectId || '', details.quotationRef || '', details.customerPoNumber || '', details.orderStatus || 'Confirmed', currency, total, amountINR, JSON.stringify(payload), req.user.email]
      );
      await insertItems(client, number, payload.items);
      await audit(client, req, { number, action: 'IMPORT', after: payload, reason: 'Admin-confirmed legacy Sales Order import' });
      imported.push(number);
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});
router.get('/:number', async (req, res) => {
  const result = await getPool().query('SELECT * FROM sales_orders WHERE so_number=$1 AND deleted_at IS NULL', [String(req.params.number || '')]);
  if (!result.rowCount) return res.status(404).json({ error: 'Sales Order not found.' });
  const itemRows = await getPool().query(
    'SELECT * FROM sales_order_items WHERE so_number=$1 ORDER BY line_number',
    [result.rows[0].so_number]
  );
  res.json({ record: view(result.rows[0], itemRows.rows) });
});
router.post('/', async (req, res) => {
  const payload = req.body?.data;
  const number = validPayload(payload);
  const token = String(req.body?.createToken || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw badRequest('A valid idempotency token is required.');
  const details = payload.soDetails, customer = payload.customerDetails;
  const currency = String(details.currency || 'INR');
  const total = finite(payload.totals?.grandTotal);
  const amountINR = convertToINR(total, currency, details.exchangeRate);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT * FROM sales_orders WHERE create_token=$1 FOR UPDATE', [token]);
    if (prior.rowCount) {
      if (prior.rows[0].deleted_at) throw conflict('This idempotent Sales Order request was deleted and cannot be replayed.');
      await client.query('COMMIT');
      return res.json({ record: view(prior.rows[0]), duplicate: true });
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sales-order:' || $1))", [number]);
    const exists = await client.query('SELECT deleted_at FROM sales_orders WHERE so_number=$1 FOR UPDATE', [number]);
    if (exists.rowCount) throw conflict('Sales Order number already exists or is protected by a deletion.');
    await linkedStatus(client, req, payload, number);
    const result = await client.query(
      `INSERT INTO sales_orders (so_number,so_date,customer_name,project_id,quotation_ref,customer_po_number,status,currency,grand_total,amount_inr,payload,create_token,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$13) RETURNING *`,
      [number, details.soDate, customer.customerName || customer.companyName, details.projectId || '', details.quotationRef || '', details.customerPoNumber || '', details.orderStatus || 'Confirmed', currency, total, amountINR, JSON.stringify(payload), token, req.user.email]
    );
    await insertItems(client, number, payload.items);
    await audit(client, req, { number, action: 'CREATE', after: payload });
    await client.query('COMMIT');
    res.status(201).json({ record: view(result.rows[0]), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});
router.put('/:number', async (req, res) => {
  const number = String(req.params.number || '');
  const payload = req.body?.data;
  if (validPayload(payload) !== number) throw badRequest('Sales Order number cannot change during edit.');
  const version = versionOf(req.body?.version);
  if (!version) throw badRequest('The PostgreSQL version last read is required.');
  const details = payload.soDetails, customer = payload.customerDetails;
  const currency = String(details.currency || 'INR'), total = finite(payload.totals?.grandTotal);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM sales_orders WHERE so_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Sales Order not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Sales Order changed on the server. Reload before editing.', view(current.rows[0]));
    if (String(current.rows[0].quotation_ref) !== String(details.quotationRef || '') || String(current.rows[0].customer_po_number) !== String(details.customerPoNumber || '')) throw badRequest('Linked Quotation and Customer PO references cannot be changed after Sales Order creation.');
    const result = await client.query(
      `UPDATE sales_orders SET so_date=$2,customer_name=$3,project_id=$4,status=$5,currency=$6,grand_total=$7,amount_inr=$8,payload=$9::jsonb,version=version+1,updated_at=now(),updated_by=$10
       WHERE so_number=$1 AND version=$11 RETURNING *`,
      [number, details.soDate, customer.customerName || customer.companyName, details.projectId || '', details.orderStatus || 'Confirmed', currency, total, convertToINR(total, currency, details.exchangeRate), JSON.stringify(payload), req.user.email, version]
    );
    await client.query('DELETE FROM sales_order_items WHERE so_number=$1', [number]);
    await insertItems(client, number, payload.items);
    await audit(client, req, { number, action: 'UPDATE', before: current.rows[0].payload, after: payload });
    await client.query('COMMIT');
    res.json({ record: view(result.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});
router.delete('/:number', requireAdmin, async (req, res) => {
  const number = String(req.params.number || '');
  const version = versionOf(req.body?.version);
  if (!version) throw badRequest('The PostgreSQL version last read is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM sales_orders WHERE so_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw Object.assign(new Error('Sales Order not found.'), { status: 404 });
    if (Number(current.rows[0].version) !== version) throw conflict('Sales Order changed on the server. Reload before deleting.', view(current.rows[0]));
    const [linked, linkedModuleRecords] = await Promise.all([
      client.query("SELECT storage_key,data FROM erp_state WHERE storage_key=ANY($1::text[])", [['deliveryChallanHistory','customerInvoiceHistory','exportInvoiceHistory','productionJobCards']]),
      client.query('SELECT data FROM module_records')
    ]);
    const needle = number.toLowerCase();
    const hasRef = (value) => typeof value === 'string' ? value.trim().toLowerCase() === needle : Array.isArray(value) ? value.some(hasRef) : value && typeof value === 'object' ? Object.values(value).some(hasRef) : false;
    if (linked.rows.some((row) => hasRef(row.data)) || linkedModuleRecords.rows.some((row) => hasRef(row.data))) throw conflict('Sales Order is referenced by a delivery, invoice, or production record and cannot be moved to the Recycle Bin.');
    const reason = String(req.body?.reason || '').trim();
    await client.query('UPDATE sales_orders SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE so_number=$1', [number, req.user.email, reason]);
    await audit(client, req, { number, action: 'SOFT_DELETE', before: current.rows[0].payload, reason });
    await client.query('COMMIT');
    res.json({ deleted: number, version: version + 1 });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

export default router;
