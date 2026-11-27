import { authHeaders } from '../utils/auth.js';

const apiBase = () => '/api';

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase()}/customer-purchase-orders${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Customer PO request failed (${response.status}).`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

export const getCustomerPurchaseOrders = async () => (await request('')).records || [];
export const reserveNextCustomerPONumber = async () => (await request('/next-number', { method: 'POST', body: '{}' })).poNumber;
export const getCustomerPurchaseOrder = async (poNumber) => (await request(`/${encodeURIComponent(poNumber)}`)).record;
export const importCustomerPurchaseOrders = async (records) => request('/import', {
  method: 'POST', body: JSON.stringify({ records })
});
export const createCustomerPurchaseOrder = async (record, createToken) => (await request('', {
  method: 'POST', body: JSON.stringify({ record, createToken })
})).record;
export const updateCustomerPurchaseOrder = async (poNumber, record, version) => (await request(`/${encodeURIComponent(poNumber)}`, {
  method: 'PUT', body: JSON.stringify({ record, version })
})).record;
export const deleteCustomerPurchaseOrder = (poNumber, version, reason = '') => request(`/${encodeURIComponent(poNumber)}`, {
  method: 'DELETE', body: JSON.stringify({ version, reason })
});
