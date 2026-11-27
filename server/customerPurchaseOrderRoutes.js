import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { getFinancialYearInfo } from '../src/utils/financialYear.js';

const router = express.Router();
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const dateString = (value) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value || '').slice(0, 10);
const isoDate = (value) => {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};
const financialYear = (date) => getFinancialYearInfo(date);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const validateRecord = (record) => {
  const errors = [];
  if (!String(record?.poNumber || '').trim()) errors.push('PO No is required.');
  if (!isoDate(record?.poDate)) errors.push('PO Date must be a valid YYYY-MM-DD date.');
  if (!String(record?.customerName || '').trim()) errors.push('Customer Name is required.');
  if (!Array.isArray(record?.items) || record.items.length === 0) errors.push('At least one PO item is required.');
  (record?.items || []).forEach((item, index) => {
    const label = `Item ${index + 1}`;
    if (!String(item?.description || '').trim()) errors.push(`${label}: Description of Goods is required.`);
    if (!finite(item?.quantity) || item.quantity <= 0) errors.push(`${label}: Quantity must be greater than zero.`);
    if (!finite(item?.deliveredQuantity) || item.deliveredQuantity < 0 || item.deliveredQuantity > item.quantity) errors.push(`${label}: Delivered Quantity must be between zero and Quantity.`);
    if (!finite(item?.balanceQuantity) || item.balanceQuantity < 0) errors.push(`${label}: Balance Quantity must be a non-negative number.`);
    if (!finite(item?.unitPrice) || item.unitPrice < 0) errors.push(`${label}: Price must be a non-negative number.`);
    if (!finite(item?.amount) || item.amount < 0) errors.push(`${label}: Amount must be a non-negative number.`);
    if (item?.poBalanceQuantityPrice != null && (!finite(item.poBalanceQuantityPrice) || item.poBalanceQuantityPrice < 0)) errors.push(`${label}: PO Balance Quantity Price must be non-negative.`);
  });
  if (record?.poBalanceValue != null && (!finite(record.poBalanceValue) || record.poBalanceValue < 0)) errors.push('PO Balance Quantity Price must be non-negative.');
  return errors;
};
const sumAmount = (items) => items.reduce((sum, item) => sum + item.amount, 0);
const containsExactReference = (value, target) => {
  if (typeof value === 'string') return value.trim().toLowerCase() === target.trim().toLowerCase();
  if (Array.isArray(value)) return value.some((item) => containsExactReference(item, target));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsExactReference(item, target));
  return false;
};
const toHistoricalPayload = (record, fy) => {
  const items = record.items.map((item) => ({
    serialNumber: item.serialNumber || '',
    itemName: item.description,
    itemDescription: item.description,
    quantity: item.quantity,
    deliveredQty: item.deliveredQuantity,
    balanceQty: item.balanceQuantity,
    unitPrice: item.unitPrice,
    amount: item.amount,
    poBalanceQuantityPrice: item.poBalanceQuantityPrice,
    unit: '-',
    gst: null
  }));
  const total = sumAmount(record.items);
  return {
    isLegacy: true,
    isHistorical: true,
    recordType: 'Historical',
    status: 'Archived (Pre-ERP)',
    dataSource: 'Excel Import',
    fyLabel: fy.fyLabel,
    fyCode: fy.fyCode,
    poDetails: {
      customerPoNumber: record.poNumber,
      customerPoDate: record.poDate,
      poStatus: 'Archived (Pre-ERP)',
      recordType: 'Historical',
      dataSource: 'Excel Import',
      poBalanceValue: record.poBalanceValue
    },
    customerDetails: { customerName: record.customerName, companyName: record.customerName },
    companyDetails: {},
    items,
    totals: { subtotal: total, taxableAmount: total, grandTotal: total, totalGST: null },
    amountInWords: record.amountInWords || '',
    amountINR: total,
    currency: 'INR'
  };
};
const toLivePayload = (payload) => ({
  ...payload,
  recordType: 'Live',
  dataSource: 'ERP',
  isLegacy: false,
  isHistorical: false
});
const headerValues = (record, payload, user, createToken = null) => {
  const poDate = payload.poDetails?.customerPoDate || record.poDate || record.date;
  const fy = financialYear(poDate);
  return [
    String(payload.poDetails?.customerPoNumber || record.poNumber || record.reference).trim(),
    poDate,
    String(payload.customerDetails?.customerName || payload.customerDetails?.companyName || record.customerName || record.company || 'Unknown Customer').trim(),
    payload.recordType || 'Live',
    payload.poDetails?.poStatus || record.status || 'Received',
    payload.dataSource || 'ERP',
    payload.fyLabel || fy.fyLabel,
    payload.fyCode || fy.fyCode,
    JSON.stringify({ ...payload, items: undefined }),
    String(user?.id || user?.email || ''), createToken
  ];
};
const insertHeaderAndItems = async (client, { record, payload, user, createToken = null }) => {
  const values = headerValues(record, payload, user, createToken);
  const result = await client.query(
    `INSERT INTO customer_purchase_orders
       (po_number,po_date,customer_name,record_type,status,data_source,fy_label,fy_code,header_data,created_by,create_token)
     VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     RETURNING id`, values
  );
  const poId = result.rows[0].id;
  for (let index = 0; index < record.items.length; index += 1) {
    const item = record.items[index];
    const itemData = payload.items[index];
    await client.query(
      `INSERT INTO customer_purchase_order_items
         (customer_po_id,line_number,item_data,serial_number,description,quantity,delivered_quantity,balance_quantity,unit_price,amount,po_balance_quantity_price)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [poId, index + 1, JSON.stringify(itemData), item.serialNumber || '', item.description,
        item.quantity, item.deliveredQuantity, item.balanceQuantity, item.unitPrice, item.amount,
        item.poBalanceQuantityPrice ?? null]
    );
  }
  await client.query(
    `INSERT INTO erp_audit_log
       (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES ($1,$2,$3,'Customer Purchase Orders',$4,$4,$5,$6,NULL,$7::jsonb)`,
    [user?.id || 'unknown', user?.email || '', user?.role || '', values[0],
      payload.recordType === 'Historical' ? 'CUSTOMER PURCHASE ORDER HISTORICAL EXCEL IMPORTED' : 'CUSTOMER PURCHASE ORDER CREATED',
      payload.dataSource || 'ERP', JSON.stringify(safeAuditValues(payload))]
  );
  return poId;
};
const normalizeText = (value) => String(value ?? '').trim().toLocaleLowerCase();
const normalizeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(8) : '';
};
const sameItem = (stored, incoming) => normalizeText(stored?.description || stored?.itemName || stored?.itemDescription) === normalizeText(incoming.description) &&
  normalizeNumber(stored?.quantity) === normalizeNumber(incoming.quantity) &&
  normalizeNumber(stored?.deliveredQuantity ?? stored?.deliveredQty) === normalizeNumber(incoming.deliveredQuantity) &&
  normalizeNumber(stored?.balanceQuantity ?? stored?.balanceQty) === normalizeNumber(incoming.balanceQuantity) &&
  normalizeNumber(stored?.unitPrice) === normalizeNumber(incoming.unitPrice) &&
  normalizeNumber(stored?.amount) === normalizeNumber(incoming.amount);
const insertItem = async (client, { poId, lineNumber, item, itemData }) => {
  await client.query(
    `INSERT INTO customer_purchase_order_items
       (customer_po_id,line_number,item_data,serial_number,description,quantity,delivered_quantity,balance_quantity,unit_price,amount,po_balance_quantity_price)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [poId, lineNumber, JSON.stringify(itemData), item.serialNumber || '', item.description,
      item.quantity, item.deliveredQuantity, item.balanceQuantity, item.unitPrice, item.amount,
      item.poBalanceQuantityPrice ?? null]
  );
};
const getRecord = async (queryable, poNumber) => {
  const header = await queryable.query('SELECT * FROM customer_purchase_orders WHERE lower(po_number)=lower($1) AND deleted_at IS NULL', [poNumber]);
  if (!header.rowCount) return null;
  const row = header.rows[0];
  const items = await queryable.query('SELECT item_data FROM customer_purchase_order_items WHERE customer_po_id=$1 ORDER BY line_number', [row.id]);
  const payload = { ...row.header_data, items: items.rows.map((item) => item.item_data) };
  const total = Number(payload.totals?.grandTotal ?? payload.totals?.subtotal ?? 0);
  return {
    id: row.id,
    version: Number(row.version || 1),
    date: dateString(row.po_date),
    reference: row.po_number,
    poNumber: row.po_number,
    customerName: row.customer_name,
    projectId: payload.poDetails?.projectId || '-',
    quotationRef: payload.poDetails?.quotationRef || '-',
    company: payload.customerDetails?.companyName || row.customer_name,
    dueDate: payload.poDetails?.deliveryDueDate || '-',
    total: `${payload.currency || 'INR'} ${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    amountINR: payload.amountINR ?? total,
    status: row.status,
    recordType: row.record_type,
    dataSource: row.data_source,
    isLegacy: row.record_type === 'Historical',
    fyLabel: row.fy_label,
    fyCode: row.fy_code,
    payload
  };
};
const getAllRecords = async () => {
  const result = await getPool().query(
    `SELECT header.*,
            COALESCE(jsonb_agg(item.item_data ORDER BY item.line_number) FILTER (WHERE item.id IS NOT NULL), '[]'::jsonb) AS items
     FROM customer_purchase_orders header
     LEFT JOIN customer_purchase_order_items item ON item.customer_po_id=header.id
     WHERE header.deleted_at IS NULL
     GROUP BY header.id ORDER BY header.po_date DESC,header.id DESC`
  );
  return result.rows.map((row) => {
    const payload = { ...row.header_data, items: row.items };
    const total = Number(payload.totals?.grandTotal ?? payload.totals?.subtotal ?? 0);
    return {
      id: row.id, version: Number(row.version || 1), date: dateString(row.po_date), reference: row.po_number, poNumber: row.po_number,
      customerName: row.customer_name, projectId: payload.poDetails?.projectId || '-',
      quotationRef: payload.poDetails?.quotationRef || '-',
      company: payload.customerDetails?.companyName || row.customer_name,
      dueDate: payload.poDetails?.deliveryDueDate || '-',
      total: `${payload.currency || 'INR'} ${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      amountINR: payload.amountINR ?? total, status: row.status, recordType: row.record_type,
      dataSource: row.data_source, isLegacy: row.record_type === 'Historical',
      fyLabel: row.fy_label, fyCode: row.fy_code, payload
    };
  });
};

router.get('/', async (_req, res, next) => {
  try {
    res.json({ records: await getAllRecords() });
  } catch (error) { next(error); }
});

router.post('/next-number', async (_req, res, next) => {
  const now = new Date();
  const fy = financialYear(now);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('customer-po-sequence:' || $1))", [String(fy.startYear)]);
    const current = await client.query('SELECT last_number FROM customer_po_sequences WHERE fy_start_year=$1 FOR UPDATE', [fy.startYear]);
    const existing = await client.query(
      `SELECT COALESCE(max(substring(po_number from $2)::bigint),0) AS maximum
       FROM customer_purchase_orders WHERE po_number ~ $1`,
      [`^CPO-${fy.fyCompact}-[0-9]+$`, `CPO-${fy.fyCompact}-`.length + 1]
    );
    const next = Math.max(Number(current.rows[0]?.last_number || 0), Number(existing.rows[0]?.maximum || 0)) + 1;
    await client.query(
      `INSERT INTO customer_po_sequences (fy_start_year,last_number,updated_at) VALUES ($1,$2,now())
       ON CONFLICT (fy_start_year) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`, [fy.startYear, next]
    );
    await client.query('COMMIT');
    res.json({ poNumber: `CPO-${fy.fyCompact}-${String(next).padStart(4, '0')}` });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.get('/:poNumber', async (req, res, next) => {
  try {
    const record = await getRecord(getPool(), req.params.poNumber);
    if (!record) return res.status(404).json({ error: 'Customer PO not found.' });
    res.json({ record });
  } catch (error) { next(error); }
});

router.post('/import', async (req, res, next) => {
  const records = req.body?.records;
  if (!Array.isArray(records) || records.length === 0) return res.status(400).json({ error: 'At least one grouped Customer PO is required.' });
  if (records.length > 5000) return res.status(413).json({ error: 'Imports are limited to 5,000 PO records.' });
  const pool = getPool();
  const outcomes = [];
  const encountered = new Set();
  for (const record of records) {
    const poNumber = String(record?.poNumber || '').trim();
    const key = poNumber.toLocaleLowerCase();
    if (key && encountered.has(key)) {
      outcomes.push({ poNumber, status: 'duplicate', errors: ['Duplicate PO No in this import request.'] });
      continue;
    }
    if (key) encountered.add(key);
    const errors = validateRecord(record);
    if (errors.length) {
      outcomes.push({ poNumber, status: 'invalid', errors });
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fy = financialYear(record.poDate);
      const payload = toHistoricalPayload(record, fy);
      const existingResult = await client.query(
        'SELECT * FROM customer_purchase_orders WHERE lower(po_number)=lower($1) FOR UPDATE', [poNumber]
      );
      if (existingResult.rowCount) {
        const existingHeader = existingResult.rows[0];
        if (existingHeader.deleted_at) {
          await client.query('ROLLBACK');
          outcomes.push({ poNumber, status: 'review', errors: ['This PO number belongs to a deleted record and is protected from import.'], newItems: 0, skippedItems: 0 });
          continue;
        }
        const headerConflicts = [];
        if (String(existingHeader.customer_name || '').trim().toLocaleLowerCase() !== String(record.customerName || '').trim().toLocaleLowerCase()) {
          headerConflicts.push(`Customer Name differs from existing PO header (${existingHeader.customer_name}).`);
        }
        if (dateString(existingHeader.po_date) !== record.poDate) {
          headerConflicts.push(`PO Date differs from existing PO header (${dateString(existingHeader.po_date)}).`);
        }
        if (headerConflicts.length) {
          await client.query('ROLLBACK');
          outcomes.push({ poNumber, status: 'review', errors: headerConflicts, newItems: 0, skippedItems: 0 });
          continue;
        }

        const existingItemsResult = await client.query(
          'SELECT item_data, line_number FROM customer_purchase_order_items WHERE customer_po_id=$1 ORDER BY line_number FOR UPDATE',
          [existingHeader.id]
        );
        const existingItems = existingItemsResult.rows.map((row) => row.item_data || {});
        let nextLineNumber = existingItemsResult.rows.reduce((next, row) => Math.max(next, Number(row.line_number) + 1), 1);
        const newItems = [];
        let skippedItems = 0;
        for (let index = 0; index < record.items.length; index += 1) {
          const incomingItem = record.items[index];
          if (existingItems.some((item) => sameItem(item, incomingItem)) || newItems.some((item) => sameItem(item.record, incomingItem))) {
            skippedItems += 1;
            continue;
          }
          newItems.push({ record: incomingItem, payload: payload.items[index] });
        }
        for (const item of newItems) {
          await insertItem(client, { poId: existingHeader.id, lineNumber: nextLineNumber++, item: item.record, itemData: item.payload });
        }
        if (newItems.length) {
          const oldHeaderData = existingHeader.header_data || {};
          const oldTotals = oldHeaderData.totals || {};
          const addedAmount = newItems.reduce((total, item) => total + item.record.amount, 0);
          const previousItemAmount = existingItems.reduce((total, item) => total + Number(item.amount || 0), 0);
          const updatedHeaderData = {
            ...oldHeaderData,
            totals: {
              ...oldTotals,
              subtotal: Number(oldTotals.subtotal ?? previousItemAmount) + addedAmount,
              taxableAmount: Number(oldTotals.taxableAmount ?? oldTotals.subtotal ?? previousItemAmount) + addedAmount,
              grandTotal: Number(oldTotals.grandTotal ?? oldTotals.subtotal ?? previousItemAmount) + addedAmount
            },
            amountINR: Number(oldHeaderData.amountINR ?? oldTotals.grandTotal ?? oldTotals.subtotal ?? previousItemAmount) + addedAmount
          };
          await client.query('UPDATE customer_purchase_orders SET header_data=$2::jsonb,updated_at=now() WHERE id=$1', [existingHeader.id, JSON.stringify(updatedHeaderData)]);
          await client.query(
            `INSERT INTO erp_audit_log
               (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
             VALUES ($1,$2,$3,'Customer Purchase Orders',$4,$4,$5,$6,$7::jsonb,$8::jsonb)`,
            [req.user?.id || 'unknown', req.user?.email || '', req.user?.role || '', existingHeader.po_number,
              'CUSTOMER PURCHASE ORDER ITEMS ADDED BY HISTORICAL EXCEL IMPORT',
              `Added ${newItems.length} item row(s); skipped ${skippedItems} identical item row(s).`,
              JSON.stringify(safeAuditValues({ customerName: existingHeader.customer_name, poDate: dateString(existingHeader.po_date) })),
              JSON.stringify(safeAuditValues(newItems.map((item) => item.payload)))]
          );
        }
        await client.query('COMMIT');
        outcomes.push({ poNumber, status: newItems.length ? 'existing_updated' : 'existing_unchanged', newItems: newItems.length, skippedItems,
          message: newItems.length ? `Added ${newItems.length} new item row(s); skipped ${skippedItems} identical item row(s).` : `Skipped ${skippedItems} item row(s) because identical items already exist.` });
      } else {
        const uniqueRecordItems = [];
        const uniquePayloadItems = [];
        let skippedItems = 0;
        for (let index = 0; index < record.items.length; index += 1) {
          if (uniqueRecordItems.some((item) => sameItem(item, record.items[index]))) {
            skippedItems += 1;
            continue;
          }
          uniqueRecordItems.push(record.items[index]);
          uniquePayloadItems.push(payload.items[index]);
        }
        const uniqueRecord = { ...record, items: uniqueRecordItems };
        const uniquePayload = { ...payload, items: uniquePayloadItems };
        const total = sumAmount(uniqueRecordItems);
        uniquePayload.totals = { ...uniquePayload.totals, subtotal: total, taxableAmount: total, grandTotal: total };
        uniquePayload.amountINR = total;
        await insertHeaderAndItems(client, { record: uniqueRecord, payload: uniquePayload, user: req.user });
        await client.query('COMMIT');
        outcomes.push({ poNumber, status: 'imported', newItems: uniqueRecordItems.length, skippedItems,
          message: skippedItems ? `Skipped ${skippedItems} identical item row(s) in the uploaded PO.` : undefined });
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep the original database error */ }
      if (error.code === '23505') outcomes.push({ poNumber, status: 'duplicate', errors: ['PO No already exists in PostgreSQL.'] });
      else outcomes.push({ poNumber, status: 'failed', errors: ['Database rejected this PO; its header and item rows were rolled back.'] });
    } finally { client.release(); }
  }
  res.json({ outcomes,
    imported: outcomes.filter((item) => item.status === 'imported').length,
    newHeaders: outcomes.filter((item) => item.status === 'imported').length,
    existingHeaders: outcomes.filter((item) => item.status === 'existing_updated').length,
    newItems: outcomes.reduce((total, item) => total + Number(item.newItems || 0), 0),
    skippedItems: outcomes.reduce((total, item) => total + Number(item.skippedItems || 0), 0),
    conflicts: outcomes.filter((item) => item.status === 'review').length,
    invalid: outcomes.filter((item) => item.status === 'invalid').length,
    duplicates: outcomes.filter((item) => item.status === 'duplicate').length,
    failed: outcomes.filter((item) => ['invalid', 'failed', 'review'].includes(item.status)).length });
});

router.post('/', async (req, res, next) => {
  const record = req.body?.record;
  const payload = toLivePayload(record?.payload || {});
  const items = Array.isArray(payload.items) ? payload.items : [];
  const normalized = {
    poNumber: record?.reference || payload.poDetails?.customerPoNumber,
    poDate: payload.poDetails?.customerPoDate || record?.date,
    customerName: payload.customerDetails?.customerName || payload.customerDetails?.companyName || record?.company,
    items: items.map((item) => ({
      serialNumber: item.serialNumber || '', description: item.itemName || item.itemDescription || '',
      quantity: Number(item.quantity), deliveredQuantity: Number(item.deliveredQty || 0),
      balanceQuantity: Number(item.balanceQty ?? Math.max(0, Number(item.quantity) - Number(item.deliveredQty || 0))),
      unitPrice: Number(item.unitPrice), amount: Number(item.amount),
      poBalanceQuantityPrice: item.poBalanceQuantityPrice == null ? null : Number(item.poBalanceQuantityPrice)
    }))
  };
  const errors = validateRecord(normalized);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const createToken = String(req.body?.createToken || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(createToken)) return res.status(400).json({ error: 'A valid idempotency token is required.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const priorToken = await client.query('SELECT po_number,deleted_at FROM customer_purchase_orders WHERE create_token=$1 FOR UPDATE', [createToken]);
    if (priorToken.rowCount) {
      if (priorToken.rows[0].deleted_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This create request belongs to a deleted Customer PO.' }); }
      const existing = await getRecord(client, priorToken.rows[0].po_number);
      await client.query('COMMIT');
      return res.json({ record: existing, duplicate: true });
    }
    const livePayload = { ...payload, items: payload.items };
    const id = await insertHeaderAndItems(client, { record: normalized, payload: livePayload, user: req.user, createToken });
    await client.query('COMMIT');
    const created = await getRecord(getPool(), normalized.poNumber);
    res.status(201).json({ record: created, id, duplicate: false });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: `Customer PO ${normalized.poNumber} already exists.` });
    next(error);
  } finally { client.release(); }
});

router.put('/:poNumber', async (req, res, next) => {
  const record = req.body?.record || {};
  const payload = toLivePayload(record?.payload || {});
  const poNumber = String(record?.reference || payload.poDetails?.customerPoNumber || '').trim();
  if (poNumber.toLowerCase() !== String(req.params.poNumber || '').trim().toLowerCase()) return res.status(400).json({ error: 'Customer PO number cannot be changed during edit.' });
  const items = Array.isArray(payload.items) ? payload.items : [];
  const normalized = {
    poNumber, poDate: payload.poDetails?.customerPoDate || record?.date,
    customerName: payload.customerDetails?.customerName || payload.customerDetails?.companyName || record?.company,
    items: items.map((item) => ({
      serialNumber: item.serialNumber || '', description: item.itemName || item.itemDescription || '',
      quantity: Number(item.quantity), deliveredQuantity: Number(item.deliveredQty || 0),
      balanceQuantity: Number(item.balanceQty ?? Math.max(0, Number(item.quantity) - Number(item.deliveredQty || 0))),
      unitPrice: Number(item.unitPrice), amount: Number(item.amount),
      poBalanceQuantityPrice: item.poBalanceQuantityPrice == null ? null : Number(item.poBalanceQuantityPrice)
    }))
  };
  const errors = validateRecord(normalized);
  const version = Number(req.body?.version);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'The PostgreSQL version last read is required.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM customer_purchase_orders WHERE lower(po_number)=lower($1) AND deleted_at IS NULL FOR UPDATE', [poNumber]);
    if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer PO not found.' }); }
    if (Number(current.rows[0].version) !== version) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Customer PO changed on the server. Reload before editing.', current: await getRecord(getPool(), poNumber) }); }
    const values = headerValues(normalized, payload, req.user);
    await client.query(
      `UPDATE customer_purchase_orders SET po_date=$2::date,customer_name=$3,record_type=$4,status=$5,data_source=$6,fy_label=$7,fy_code=$8,header_data=$9::jsonb,version=version+1,updated_at=now()
       WHERE id=$1 AND version=$10`,
      [current.rows[0].id, values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8], version]
    );
    await client.query('DELETE FROM customer_purchase_order_items WHERE customer_po_id=$1', [current.rows[0].id]);
    for (let index = 0; index < normalized.items.length; index += 1) {
      await insertItem(client, { poId: current.rows[0].id, lineNumber: index + 1, item: normalized.items[index], itemData: payload.items[index] });
    }
    await client.query(
      `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,before_values,after_values)
       VALUES ($1,$2,$3,'Customer Purchase Orders',$4,$4,'UPDATE',$5::jsonb,$6::jsonb)`,
      [req.user.id, req.user.email, req.user.role, poNumber, JSON.stringify(safeAuditValues(current.rows[0].header_data)), JSON.stringify(safeAuditValues(payload))]
    );
    await client.query('COMMIT');
    res.json({ record: await getRecord(getPool(), poNumber) });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.delete('/:poNumber', requireAdmin, async (req, res, next) => {
    const poNumber = String(req.params.poNumber || '').trim();
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'The PostgreSQL version last read is required.' });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM customer_purchase_orders WHERE lower(po_number)=lower($1) AND deleted_at IS NULL FOR UPDATE', [poNumber]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Customer PO not found.' }); }
      if (Number(current.rows[0].version) !== version) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Customer PO changed on the server. Reload before deleting.' }); }
      const [linkedState, linkedRecords] = await Promise.all([
        client.query("SELECT storage_key,data FROM erp_state WHERE storage_key=ANY($1::text[])", [['salesOrderHistory', 'deliveryChallanHistory', 'customerInvoiceHistory', 'productionJobCards']]),
        client.query('SELECT data FROM module_records')
      ]);
      const isReferenced = linkedState.rows.some((row) => containsExactReference(row.data, poNumber)) || linkedRecords.rows.some((row) => containsExactReference(row.data, poNumber));
      if (isReferenced) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Customer PO is referenced by another ERP record and cannot be moved to the Recycle Bin.' }); }
      const reason = String(req.body?.reason || '').trim();
      await client.query('UPDATE customer_purchase_orders SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now() WHERE id=$1', [current.rows[0].id, req.user.email, reason]);
      await client.query(
        `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values)
         VALUES ($1,$2,$3,'Customer Purchase Orders',$4,$4,'SOFT_DELETE',$5,$6::jsonb)`,
        [req.user.id, req.user.email, req.user.role, poNumber, reason, JSON.stringify(safeAuditValues(current.rows[0].header_data))]
      );
      await client.query('COMMIT');
      res.json({ deleted: poNumber, version: version + 1 });
    } catch (error) { await client.query('ROLLBACK'); next(error); }
    finally { client.release(); }
});

export default router;
