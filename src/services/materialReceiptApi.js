import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
const key = 'materialReceipts';
let receiptInspectionCache = [];
const request = async (path, options = {}) => {
  const response = await fetch(`${base()}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Material Receipt request failed (${response.status})`);
    error.status = response.status; error.current = body.current; throw error;
  }
  return body;
};
const setCache = (records) => { if (typeof localStorage !== 'undefined') { try { localStorage.setItem(key, JSON.stringify(records)); } catch { /* cache only */ } } };
export const cacheConfirmedMaterialReceipt = (record) => updateCache(record);
export const getReceiptInspectionCache = () => receiptInspectionCache;
/** Local-only upsert used when no server round-trip is possible (non-browser
 *  runtimes such as the workflow regression suite). Browsers always persist a
 *  receipt inspection through saveMaterialReceiptQualityCheckApi above, so the
 *  PostgreSQL copy stays authoritative in the UI. */
export const cacheLocalReceiptInspection = (record) => {
  if (!record?.qcNumber) return;
  receiptInspectionCache = [record, ...receiptInspectionCache.filter((row) => String(row.qcNumber) !== String(record.qcNumber))];
};
/** Drops a local-only inspection copy (used when a receipt is unlinked). */
export const removeLocalReceiptInspection = (qcNumber) => {
  if (!qcNumber) return;
  receiptInspectionCache = receiptInspectionCache.filter((row) => String(row.qcNumber) !== String(qcNumber));
};
const updateCache = (record) => {
  if (typeof localStorage === 'undefined' || !record) return;
  let rows = []; try { rows = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* replace corrupt cache from confirmed record */ }
  setCache([record, ...(Array.isArray(rows) ? rows.filter((row) => String(row.receiptNumber) !== String(record.receiptNumber)) : [])]);
};
export const listMaterialReceiptsApi = async () => { const records = (await request('/material-receipts')).records || []; setCache(records); return records; };
export const getMaterialReceiptApi = async (id) => (await request(`/material-receipts/${encodeURIComponent(id)}`)).record;
export const reserveMaterialReceiptNumberApi = async (replacement = false) => (await request(`/material-receipts/sequences/next${replacement ? '?replacement=true' : ''}`)).number;
export const createMaterialReceiptApi = async (data, createToken) => { const result = await request('/material-receipts', { method: 'POST', body: JSON.stringify({ data, createToken }) }); updateCache(result.record); return result; };
export const updateMaterialReceiptApi = async (id, data, version) => { const result = await request(`/material-receipts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ data, version }) }); updateCache(result.record); return result; };
export const deleteMaterialReceiptApi = async (id, version, reason = '') => {
  const result = await request(`/material-receipts/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
  if (typeof localStorage !== 'undefined') {
    try { const rows = JSON.parse(localStorage.getItem(key) || '[]'); setCache(Array.isArray(rows) ? rows.filter((row) => String(row.receiptNumber) !== String(id)) : []); } catch { /* cache is not persistence proof */ }
  }
  return result;
};
export const getMaterialReceiptMigrationPreviewApi = () => request('/material-receipts/migration-preview');
export const importMaterialReceiptsApi = async (records) => {
  const result = await request('/material-receipts/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records }) });
  const authoritative = await listMaterialReceiptsApi();
  return { ...result, records: authoritative };
};
export const listMaterialReceiptQualityChecksApi = async () => {
  const result = await request('/material-receipt-quality-checks');
  receiptInspectionCache = result.records || [];
  return receiptInspectionCache;
};
export const saveMaterialReceiptQualityCheckApi = async (record, version = 0) => {
  const result = await request(`/material-receipts/${encodeURIComponent(record.receiptNumber)}/quality-check`, { method: 'PUT', body: JSON.stringify({ data: record, version }) });
  receiptInspectionCache = [result.record, ...receiptInspectionCache.filter((row) => String(row.qcNumber) !== String(result.record.qcNumber))];
  updateCache(result.receipt);
  return result;
};
export const postMaterialReceiptStockApi = async (qcNumber) => {
  const result = await request(`/material-receipt-quality-checks/${encodeURIComponent(qcNumber)}/post-stock`, { method: 'POST', body: '{}' });
  receiptInspectionCache = [result.record, ...receiptInspectionCache.filter((row) => String(row.qcNumber) !== String(result.record.qcNumber))];
  updateCache(result.receipt);
  return result;
};
