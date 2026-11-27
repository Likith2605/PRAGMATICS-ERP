import { authHeaders } from '../utils/auth.js';
const base = () => typeof window !== 'undefined' && window.location ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api') : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
const request = async (path, options = {}) => {
  const response = await fetch(`${base()}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `Delivery Challan request failed (${response.status})`); error.status = response.status; error.current = body.current; throw error; }
  return body;
};
export const listDeliveryChallans = async () => (await request('/delivery-challans')).records || [];
export const getDeliveryChallan = async (number) => (await request(`/delivery-challans/${encodeURIComponent(number)}`)).record;
export const createDeliveryChallan = (data, createToken) => request('/delivery-challans', { method: 'POST', body: JSON.stringify({ data, createToken }) });
export const updateDeliveryChallan = (number, data, version) => request(`/delivery-challans/${encodeURIComponent(number)}`, { method: 'PUT', body: JSON.stringify({ data, version }) });
export const confirmDeliveryChallanDispatch = (number, version) => request(`/delivery-challans/${encodeURIComponent(number)}/confirm-dispatch`, { method: 'POST', body: JSON.stringify({ version }) });
export const deleteDeliveryChallan = (number, version, reason = '') => request(`/delivery-challans/${encodeURIComponent(number)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
export const getDeliveryChallanMigrationPreview = () => request('/delivery-challans/migration-preview');
export const importMissingDeliveryChallans = (records) => request('/delivery-challans/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records }) });
