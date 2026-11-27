import { authHeaders } from '../utils/auth.js';

/**
 * PostgreSQL-backed business master data client.
 *
 * The list/create/update calls below are the only authority for permanent
 * master records. Customer, vendor, machine and company data stay in memory;
 * their legacy browser keys are preserved only for explicit Admin migration.
 * Material and UOM compatibility caches are populated only by confirmed reads.
 */
const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/masters${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Master data request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    error.rejected = body.rejected;
    throw error;
  }
  return body;
};

// These keys are write-only mirrors of confirmed PostgreSQL responses. Legacy
// business-module keys are deliberately NOT overwritten by master reads: a
// master page must never make localStorage authoritative for permanent data.
const CACHE_KEYS = {
  materials: 'masterMaterialCache',
  uoms: 'masterUomCache'
};

const masterCache = new Map();
let companySettingsCache = null;

const notifyCompanySettingsChanged = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('company-branding-updated'));
};

export const getCachedMasters = (kind) => masterCache.get(kind) || [];
export const getCachedCompanySettings = () => companySettingsCache || {};
export const clearMasterCaches = () => {
  masterCache.clear();
  companySettingsCache = null;
  notifyCompanySettingsChanged();
};

const writeCache = (key, value) => {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* cache is never proof of persistence */ }
};
const readCache = (key) => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
const identity = (item) => String(item?.id ?? item?.machineId ?? item?.itemCode ?? item?.seq ?? item?.code ?? '');
const cacheRecord = (kind, record) => {
  const key = CACHE_KEYS[kind];
  if (!record) return;
  if (kind === 'company-settings') {
    companySettingsCache = record;
    if (key) writeCache(key, record);
    notifyCompanySettingsChanged();
    return;
  }
  const next = [record, ...getCachedMasters(kind).filter((item) => identity(item) !== identity(record))];
  masterCache.set(kind, next);
  if (!key) return;
  const cached = [record, ...readCache(key).filter((item) => identity(item) !== identity(record))];
  writeCache(key, cached);
};
const uncacheRecord = (kind, id) => {
  const key = CACHE_KEYS[kind];
  if (kind === 'company-settings') return;
  const next = getCachedMasters(kind).filter((item) => identity(item) !== String(id));
  masterCache.set(kind, next);
  if (key) writeCache(key, readCache(key).filter((item) => identity(item) !== String(id)));
};
const cacheList = (kind, records) => {
  const key = CACHE_KEYS[kind];
  if (!Array.isArray(records)) return;
  if (kind === 'company-settings') {
    companySettingsCache = records[0] || null;
    if (key && records[0]) writeCache(key, records[0]);
    notifyCompanySettingsChanged();
    return;
  }
  masterCache.set(kind, records);
  if (key) writeCache(key, records);
};

export const newMasterToken = (prefix = 'master') => {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
};

export const listMasters = async (kind, { includeDeleted = false } = {}) => {
  try {
    const body = await request(`/${encodeURIComponent(kind)}${includeDeleted ? '?includeDeleted=1' : ''}`);
    const records = Array.isArray(body.records) ? body.records : [];
    cacheList(kind, records);
    return records;
  } catch (error) {
    masterCache.delete(kind);
    throw error;
  }
};
export const getMaster = async (kind, id) => {
  const body = await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  if (body.record) cacheRecord(kind, body.record);
  return body.record;
};
export const createMaster = async (kind, data, token = newMasterToken()) => {
  const body = await request(`/${encodeURIComponent(kind)}`, { method: 'POST', body: JSON.stringify({ data, createToken: token }) });
  if (body.record) cacheRecord(kind, body.record);
  return body;
};
export const updateMaster = async (kind, id, data, version, token = newMasterToken()) => {
  const body = await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify({ data, version, idempotencyToken: token })
  });
  if (body.record) cacheRecord(kind, body.record);
  return body;
};
export const deleteMaster = async (kind, id, version, reason, token = newMasterToken()) => {
  const body = await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
    method: 'DELETE', body: JSON.stringify({ version, reason, idempotencyToken: token })
  });
  uncacheRecord(kind, id);
  return body;
};
export const getCompanySettings = async () => {
  companySettingsCache = null;
  notifyCompanySettingsChanged();
  const body = await request('/company-settings');
  const record = body.record || body.records?.[0] || null;
  companySettingsCache = record;
  if (record) writeCache(CACHE_KEYS['company-settings'], record);
  notifyCompanySettingsChanged();
  return record;
};
export const saveCompanySettings = async (data, version, token = newMasterToken('company')) => {
  const record = await updateMaster('company-settings', 'primary', data, version, token);
  writeCache(CACHE_KEYS['company-settings'], record.record || record);
  return record.record || record;
};
export const getMasterHistory = async (kind, id) => (await request(`/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/history`)).entries || [];
export const getMasterModuleHistory = async (kind) => (await request(`/${encodeURIComponent(kind)}/history`)).entries || [];
export const getLegacyMasterPreview = async (kind) => (await request(`/${encodeURIComponent(kind)}/legacy/preview`)).entries || [];
export const importSelectedMasters = async (kind, selected, token = newMasterToken('import')) => request(`/${encodeURIComponent(kind)}/legacy/import`, {
  method: 'POST', body: JSON.stringify({ selected, idempotencyToken: token })
});
export const getMasterReferences = async () => request('/references');
export const searchMaster = async (kind, query = '', { productFilter = '' } = {}) => {
  const records = await listMasters(kind);
  const q = String(query || '').trim().toLowerCase();
  return records.filter((record) => {
    if (productFilter && String(record.product || record.category || '').trim().toLowerCase() !== String(productFilter).trim().toLowerCase()) return false;
    if (!q) return true;
    return [record.name, record.companyName, record.customerName, record.product, record.category, record.itemName, record.itemCode, record.phone]
      .some((value) => String(value || '').toLowerCase().includes(q));
  });
};
