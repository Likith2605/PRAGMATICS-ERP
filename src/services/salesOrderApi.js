import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location?.port === '5173'
  ? `http://${window.location.hostname || 'localhost'}:3001/api`
  : '/api';
const request = async (path, options = {}) => {
  const response = await fetch(`${base()}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Sales Order request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const normalizeSalesOrderItemLines = (record = {}) => {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : record;
  const candidates = [
    payload?.items,
    payload?.orderItems,
    payload?.lineItems,
    payload?.soDetails?.items,
    payload?.soDetails?.orderItems
  ];
  const items = candidates.find((value) => Array.isArray(value) && value.length) || [];
  return items.map((line, index) => {
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

export const normalizeSalesOrderRecord = (record = {}) => {
  if (!record || typeof record !== 'object') return record;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  return {
    ...record,
    payload: {
      ...payload,
      items: normalizeSalesOrderItemLines(record)
    }
  };
};

export const listSalesOrders = async () =>
  ((await request('/sales-orders')).records || []).map(normalizeSalesOrderRecord);
export const getSalesOrder = async (number) =>
  normalizeSalesOrderRecord((await request(`/sales-orders/${encodeURIComponent(number)}`)).record);
export const createSalesOrder = (data, createToken) => request('/sales-orders', { method: 'POST', body: JSON.stringify({ data, createToken }) });
export const updateSalesOrder = (number, data, version) => request(`/sales-orders/${encodeURIComponent(number)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
export const deleteSalesOrder = (number, version, reason = '') => request(`/sales-orders/${encodeURIComponent(number)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
export const getSalesOrderMigrationPreview = () => request('/sales-orders/migration-preview');
export const importMissingSalesOrders = (records) => request('/sales-orders/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records }) });
