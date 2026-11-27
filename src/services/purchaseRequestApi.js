import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/purchase-requests${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Purchase Request API failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

export const listPurchaseRequestsApi = async () => (await request('')).records || [];
export const createPurchaseRequestApi = (data, createToken) => request('', {
  method: 'POST',
  body: JSON.stringify({ data, createToken })
});
export const approvePurchaseRequestApi = (prNumber, version, reason = '') => request(`/${encodeURIComponent(prNumber)}/approve`, {
  method: 'POST',
  body: JSON.stringify({ version, reason })
});
export const rejectPurchaseRequestApi = (prNumber, version, reason) => request(`/${encodeURIComponent(prNumber)}/reject`, {
  method: 'POST',
  body: JSON.stringify({ version, reason })
});
export const getPurchaseRequestMigrationPreviewApi = () => request('/migration-preview');
export const importPurchaseRequestsApi = (records) => request('/migration-preview/import-selected', {
  method: 'POST',
  body: JSON.stringify({ records })
});
