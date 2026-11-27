import { authHeaders } from '../utils/auth.js';
import { cacheBoms, getCachedBoms } from './productionAuthorityCache.js';

const base = () => {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.port === '5173'
      ? `http://${window.location.hostname || 'localhost'}:3001/api`
      : '/api';
  }
  return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/bom${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `BOM request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

const mutation = (path, method, body) => request(path, { method, body });

export const listBoms = async () => cacheBoms((await request('/')).records || []);
export const getBom = async (number) => {
  const record = (await request(`/${encodeURIComponent(number)}`)).record;
  if (record) cacheBoms([record, ...getCachedBoms().filter((row) => (row.bomNumber || row.id) !== (record.bomNumber || record.id))]);
  return record;
};
export const getEffectiveBom = async (partCode, date) =>
  (await request(`/effective?partCode=${encodeURIComponent(partCode)}&date=${encodeURIComponent(date || '')}`)).record;
export const createBom = async (data, createToken) => {
  const result = await mutation('/', 'POST', { data, createToken });
  await listBoms();
  return result;
};
export const updateBom = async (number, version, data) => {
  const result = await mutation(`/${encodeURIComponent(number)}`, 'PUT', { version, data });
  await listBoms();
  return result;
};
export const deleteBom = async (number, version, reason) => {
  const result = await mutation(`/${encodeURIComponent(number)}`, 'DELETE', { version, reason });
  await listBoms();
  return result;
};
export const restoreBom = async (number, reason) => {
  const result = await mutation(`/${encodeURIComponent(number)}/restore`, 'POST', { reason });
  await listBoms();
  return result;
};
export const getBomAudit = async (number) => (await request(`/${encodeURIComponent(number)}/audit`)).entries || [];
export const bomMigrationPreview = async () => request('/migration-preview');
export const importBomMissing = (records) => mutation('/migration-preview/import-missing', 'POST', { records });
