import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/commercial-returns${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Return request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

export const commercialReturnCreateToken = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `return-${crypto.randomUUID()}`;
  return `return-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const listSalesReturns = async () => (await request('/sales')).records || [];
export const listPurchaseReturns = async () => (await request('/purchase')).records || [];
export const createSalesReturn = async (data, createToken = commercialReturnCreateToken()) =>
  request('/sales', { method: 'POST', body: JSON.stringify({ data, createToken }) });
export const createPurchaseReturn = async (data, createToken = commercialReturnCreateToken()) =>
  request('/purchase', { method: 'POST', body: JSON.stringify({ data, createToken }) });
export const updateSalesReturn = (number, data, version) =>
  request(`/sales/${encodeURIComponent(number)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
export const updatePurchaseReturn = (number, data, version) =>
  request(`/purchase/${encodeURIComponent(number)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
export const deleteSalesReturn = (number, version, reason) =>
  request(`/sales/${encodeURIComponent(number)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
export const deletePurchaseReturn = (number, version, reason) =>
  request(`/purchase/${encodeURIComponent(number)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
export const submitSalesReturn = (number, version) =>
  request(`/sales/${encodeURIComponent(number)}/submit`, { method: 'POST', body: JSON.stringify({ version }) });
export const submitPurchaseReturn = (number, version) =>
  request(`/purchase/${encodeURIComponent(number)}/submit`, { method: 'POST', body: JSON.stringify({ version }) });
export const approveSalesReturn = (number, version, reason = '') =>
  request(`/sales/${encodeURIComponent(number)}/approve`, { method: 'POST', body: JSON.stringify({ version, reason }) });
export const approvePurchaseReturn = (number, version, reason = '') =>
  request(`/purchase/${encodeURIComponent(number)}/approve`, { method: 'POST', body: JSON.stringify({ version, reason }) });
export const rejectSalesReturn = (number, version, reason) =>
  request(`/sales/${encodeURIComponent(number)}/reject`, { method: 'POST', body: JSON.stringify({ version, reason }) });
export const rejectPurchaseReturn = (number, version, reason) =>
  request(`/purchase/${encodeURIComponent(number)}/reject`, { method: 'POST', body: JSON.stringify({ version, reason }) });
