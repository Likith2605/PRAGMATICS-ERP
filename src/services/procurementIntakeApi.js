import { authHeaders } from '../utils/auth.js';
import { cacheConfirmedMaterialReceipt } from './materialReceiptApi.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/procurement${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Procurement request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

const LEGACY_KEYS = { purchaseIndent: 'purchaseIndents', vendorEnquiry: 'vendorEnquiries', vendorQuotation: 'vendorQuotations' };
// Compatibility cache is refreshed only from a database response. Never use
// these helpers to create a record or treat the cached value as save evidence.
export const cacheConfirmedProcurementRecords = (kind, records) => {
  const key = LEGACY_KEYS[kind];
  if (!key || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, JSON.stringify(records)); } catch { /* cache is never proof of persistence */ }
};
export const cacheConfirmedProcurementRecord = (kind, record) => {
  const key = LEGACY_KEYS[kind];
  if (!key || typeof localStorage === 'undefined' || !record) return;
  let records = [];
  try { records = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* replace malformed compatibility cache */ }
  const idField = { purchaseIndent: 'indentNumber', vendorEnquiry: 'enquiryNumber', vendorQuotation: 'quotationNumber' }[kind];
  const next = records.filter((item) => String(item?.[idField]) !== String(record[idField]));
  next.unshift(record);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* cache is never proof of persistence */ }
};

export const listProcurementRecords = async (kind) => {
  const records = (await request(`/${encodeURIComponent(kind)}`)).records || [];
  cacheConfirmedProcurementRecords(kind, records);
  return records;
};
export const getProcurementRecord = async (kind, id) => (await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`)).record;
export const reserveProcurementNumber = async (kind) => (await request(`/sequences/${encodeURIComponent(kind)}/next`)).number;
export const createProcurementRecord = async (kind, data, createToken) => {
  const result = await request(`/${encodeURIComponent(kind)}`, { method: 'POST', body: JSON.stringify({ data, createToken }) });
  cacheConfirmedProcurementRecord(kind, result.record);
  return result;
};
export const updateProcurementRecord = async (kind, id, data, version) => {
  const result = await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
  cacheConfirmedProcurementRecord(kind, result.record);
  return result;
};
export const deleteProcurementRecord = async (kind, id, version, reason) => {
  const result = await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
  const key = LEGACY_KEYS[kind]; const idField = { purchaseIndent: 'indentNumber', vendorEnquiry: 'enquiryNumber', vendorQuotation: 'quotationNumber' }[kind];
  if (key && typeof localStorage !== 'undefined') {
    let rows = []; try { rows = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* preserve server-confirmed delete */ }
    localStorage.setItem(key, JSON.stringify(rows.filter((row) => String(row?.[idField]) !== String(id))));
  }
  return result;
};
export const getProcurementMigrationPreview = (kind) => request(`/${encodeURIComponent(kind)}/migration-preview`);
export const importMissingProcurementRecords = (kind, records) => request(`/${encodeURIComponent(kind)}/migration-preview/import-missing`, {
  method: 'POST', body: JSON.stringify({ records })
});

const cacheConfirmedPurchaseOrders = (records) => {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem('supplierPOHistory', JSON.stringify(records)); } catch { /* PostgreSQL already confirmed the write */ }
};
export const listPurchaseOrders = async () => {
  const records = (await request('/purchase-orders')).records || [];
  cacheConfirmedPurchaseOrders(records);
  return records;
};
export const getPurchaseOrder = async (id) => (await request(`/purchase-orders/${encodeURIComponent(id)}`)).record;
/** Spreadsheet import: rows are validated and inserted by PostgreSQL. An
 *  existing row is preserved (conflict) instead of overwritten. */
export const importPurchaseOrdersApi = (records) => request('/purchase-orders/import', {
  method: 'POST', body: JSON.stringify({ records })
});
export const reservePurchaseOrderNumber = async () => (await request('/purchase-orders/sequences/next')).number;
const readConfirmedPurchaseOrders = () => {
  if (typeof localStorage === 'undefined') return [];
  try { const rows = JSON.parse(localStorage.getItem('supplierPOHistory') || '[]'); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
};
export const createPurchaseOrderFromQuotationApi = async (data, createToken) => {
  const result = await request('/purchase-orders/from-quotation', { method: 'POST', body: JSON.stringify({ data, createToken }) });
  const record = result.record;
  if (record) {
    const current = readConfirmedPurchaseOrders();
    cacheConfirmedPurchaseOrders([record, ...current.filter((item) => String(item?.reference) !== String(record.reference))]);
  }
  if (result.quotation) cacheConfirmedProcurementRecord('vendorQuotation', result.quotation);
  if (result.enquiry) cacheConfirmedProcurementRecord('vendorEnquiry', result.enquiry);
  if (result.indent) cacheConfirmedProcurementRecord('purchaseIndent', result.indent);
  return result;
};
export const updatePurchaseOrderApi = async (id, data, version) => {
  const result = await request(`/purchase-orders/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
  const current = readConfirmedPurchaseOrders();
  cacheConfirmedPurchaseOrders([result.record, ...current.filter((item) => String(item?.reference) !== String(id))]);
  return result;
};
export const deletePurchaseOrderApi = (id, version, reason) => request(`/purchase-orders/${encodeURIComponent(id)}`, {
  method: 'DELETE', body: JSON.stringify({ version, reason })
});
/** Short-close the unreceived balance. The PostgreSQL route re-measures the PO
 *  inside the same transaction and only a confirmed response updates the cache. */
export const shortClosePurchaseOrderApi = async (id, version, reason, remarks) => {
  const result = await request(`/purchase-orders/${encodeURIComponent(id)}/short-close`, {
    method: 'POST', body: JSON.stringify({ version, reason, remarks })
  });
  if (result.record) {
    const current = readConfirmedPurchaseOrders();
    cacheConfirmedPurchaseOrders([result.record, ...current.filter((item) => String(item?.reference) !== String(result.record.reference))]);
  }
  return result;
};
export const savePurchaseIndentQualityCheck = async (record, indentVersion) => {
  const result = await request('/purchase-indent-quality-checks', { method: 'POST', body: JSON.stringify({ data: record, indentVersion, qcVersion: Number(record.version || record.recordVersion || 0) }) });
  if (typeof localStorage !== 'undefined') {
    try {
      const rows = JSON.parse(localStorage.getItem('qualityChecks') || '[]');
      const current = Array.isArray(rows) ? rows : [];
      localStorage.setItem('qualityChecks', JSON.stringify([result.record, ...current.filter((item) => String(item?.qcNumber) !== String(result.record.qcNumber))]));
    } catch { /* cache refresh is best-effort after the authoritative response */ }
  }
  cacheConfirmedProcurementRecord('purchaseIndent', result.indent);
  return result;
};
export const listPurchaseIndentQualityChecks = async () => {
  const records = (await request('/purchase-indent-quality-checks')).records || [];
  if (typeof localStorage !== 'undefined') {
    try {
      const current = JSON.parse(localStorage.getItem('qualityChecks') || '[]');
      localStorage.setItem('qualityChecks', JSON.stringify([...(Array.isArray(current) ? current.filter((item) => !item?.indentNumber) : []), ...records]));
    } catch { /* server remains authoritative if the display cache cannot be written */ }
  }
  return records;
};

const cacheSupplierInvoices = (records) => {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem('supplierInvoiceHistory', JSON.stringify(records)); } catch { /* compatibility cache only */ }
};
export const listSupplierInvoicesApi = async () => {
  const records = (await request('/supplier-invoices')).records || [];
  cacheSupplierInvoices(records);
  return records;
};
export const listSupplierInvoicesFromPostgres = async () => (
  (await request('/supplier-invoices')).records || []
);
export const getSupplierInvoiceApi = async (id) => (await request(`/supplier-invoices/${encodeURIComponent(id)}`)).record;
export const createSupplierInvoiceApi = async (data, createToken) => {
  const result = await request('/supplier-invoices', { method: 'POST', body: JSON.stringify({ data, createToken }) });
  const current = typeof localStorage === 'undefined' ? [] : (() => { try { return JSON.parse(localStorage.getItem('supplierInvoiceHistory') || '[]'); } catch { return []; } })();
  cacheSupplierInvoices([result.record, ...current.filter((item) => String(item?.reference) !== String(result.record.reference))]);
  if (result.purchaseOrder) {
    const orders = readConfirmedPurchaseOrders();
    cacheConfirmedPurchaseOrders([result.purchaseOrder, ...orders.filter((item) => String(item?.reference) !== String(result.purchaseOrder.reference))]);
  }
  if (result.receipt) cacheConfirmedMaterialReceipt(result.receipt);
  return result;
};
export const updateSupplierInvoiceApi = async (id, data, version) => {
  const result = await request(`/supplier-invoices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
  const current = typeof localStorage === 'undefined' ? [] : (() => { try { return JSON.parse(localStorage.getItem('supplierInvoiceHistory') || '[]'); } catch { return []; } })();
  cacheSupplierInvoices([result.record, ...current.filter((item) => String(item?.reference) !== String(id))]);
  return result;
};
export const deleteSupplierInvoiceApi = async (id, version, reason) => {
  const result = await request(`/supplier-invoices/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
  const current = typeof localStorage === 'undefined' ? [] : (() => { try { return JSON.parse(localStorage.getItem('supplierInvoiceHistory') || '[]'); } catch { return []; } })();
  cacheSupplierInvoices(current.filter((item) => String(item?.reference) !== String(id)));
  return result;
};
export const getSupplierInvoiceMigrationPreviewApi = () => request('/supplier-invoices/migration-preview');
export const importSupplierInvoicesApi = async (records) => {
  const result = await request('/supplier-invoices/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records }) });
  const rows = await listSupplierInvoicesApi();
  return { ...result, records: rows };
};
