import { authHeaders } from '../utils/auth.js';

const apiBase = () => '/api';

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase()}/customer-purchase-orders${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Customer PO request failed (${response.status}).`);
  return body;
};

export const getCustomerPurchaseOrders = async () => (await request('')).records || [];
export const getCustomerPurchaseOrder = async (poNumber) => (await request(`/${encodeURIComponent(poNumber)}`)).record;
export const importCustomerPurchaseOrders = async (records) => request('/import', {
  method: 'POST', body: JSON.stringify({ records })
});
export const createCustomerPurchaseOrder = async (record) => (await request('', {
  method: 'POST', body: JSON.stringify({ record })
})).record;
