import { authHeaders } from '../utils/auth.js';

const apiBase = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Quotation request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

export const listQuotations = async () => (await request('/quotations')).records || [];
export const reserveNextQuotationNumber = async () => (await request('/quotations/next-number', { method: 'POST', body: '{}' })).quotationNumber;
export const getQuotation = async (number) => (await request(`/quotations/${encodeURIComponent(number)}`)).record;
export const getQuotationMigrationPreview = () => request('/quotations/migration-preview');
export const importMissingQuotations = (records) => request('/quotations/migration-preview/import-missing', {
  method: 'POST', body: JSON.stringify({ records })
});
export const createQuotation = (data, createToken) => request('/quotations', {
  method: 'POST', body: JSON.stringify({ data, createToken })
});
export const updateQuotation = (number, data, version) => request(`/quotations/${encodeURIComponent(number)}`, {
  method: 'PUT', body: JSON.stringify({ data, version })
});
export const markQuotationInvoiced = (number, invoiceNumber, version) => request(`/quotations/${encodeURIComponent(number)}/mark-invoiced`, {
  method: 'POST', body: JSON.stringify({ invoiceNumber, version })
});
export const deleteQuotation = (number, version, reason = '') => request(`/quotations/${encodeURIComponent(number)}`, {
  method: 'DELETE', body: JSON.stringify({ version, reason })
});
