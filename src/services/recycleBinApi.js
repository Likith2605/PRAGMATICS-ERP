import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Recycle Bin request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });

export const listRecycleBin = async (filters = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value !== null && value !== undefined)).toString();
  return request(`/recycle-bin${query ? `?${query}` : ''}`);
};

export const getRecycleBinEntry = async (entity, recordId) =>
  request(`/recycle-bin/${encodeURIComponent(entity)}/${encodeURIComponent(recordId)}`);

export const restoreRecycleBinEntry = async (entity, recordId, reason) =>
  request(`/recycle-bin/${encodeURIComponent(entity)}/${encodeURIComponent(recordId)}/restore`, json('POST', { reason }));

export const purgeRecycleBinEntry = async (entity, recordId, reason, confirm) =>
  request(`/recycle-bin/${encodeURIComponent(entity)}/${encodeURIComponent(recordId)}`, json('DELETE', { reason, confirm }));
