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
    const error = new Error(body.error || `Advance request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

const pathFor = (kind) => {
  if (!['customer', 'supplier'].includes(kind)) throw new Error('Advance type must be customer or supplier.');
  return `/advances/${kind}`;
};

export const listAdvances = async (kind) => (await request(pathFor(kind))).records || [];
export const createAdvance = (kind, data, createToken) => request(pathFor(kind), {
  method: 'POST',
  body: JSON.stringify({ data, createToken })
});
export const updateAdvance = (kind, number, data, version) => request(`${pathFor(kind)}/${encodeURIComponent(number)}`, {
  method: 'PUT',
  body: JSON.stringify({ data, version })
});
export const deleteAdvance = (kind, number, version, reason) => request(`${pathFor(kind)}/${encodeURIComponent(number)}`, {
  method: 'DELETE',
  body: JSON.stringify({ version, reason })
});
export const listAdvanceAdjustments = (kind, number) => request(`${pathFor(kind)}/${encodeURIComponent(number)}/adjustments`);
export const listAdvanceAudit = (kind, number) => request(`${pathFor(kind)}/${encodeURIComponent(number)}/audit`);
export const createAdvanceAdjustment = (kind, number, adjustment) => request(`${pathFor(kind)}/${encodeURIComponent(number)}/adjustments`, {
  method: 'POST',
  body: JSON.stringify(adjustment)
});
export const reverseAdvanceAdjustment = (kind, number, adjustmentId, version, reason) => request(
  `${pathFor(kind)}/${encodeURIComponent(number)}/adjustments/${encodeURIComponent(adjustmentId)}`,
  { method: 'DELETE', body: JSON.stringify({ version, reason }) }
);
export const previewLegacyAdvances = (kind) => request(`${pathFor(kind)}/migration-preview`);
export const importLegacyAdvances = (kind, numbers) => request(`${pathFor(kind)}/migration-preview/import`, {
  method: 'POST',
  body: JSON.stringify({ numbers })
});
