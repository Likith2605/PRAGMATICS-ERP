import { authHeaders } from '../utils/auth.js';

const apiBase = () => {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.port === '5173'
      ? `http://${window.location.hostname || 'localhost'}:3001/api`
      : '/api';
  }
  return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Enquiry request failed (${response.status})`);
    error.status = response.status;
    error.current = payload.current;
    throw error;
  }
  return payload;
};

export const listEnquiries = async () => (await request('/enquiries')).records || [];
export const getEnquiry = async (id) => (await request(`/enquiries/${encodeURIComponent(id)}`)).record;
export const getEnquiryMigrationPreview = () => request('/enquiries/migration-preview');
export const importMissingEnquiries = (records) => request('/enquiries/migration-preview/import-missing', {
  method: 'POST', body: JSON.stringify({ records })
});
export const createEnquiry = (data, { createToken, sequenceHint = 0 } = {}) => request('/enquiries', {
  method: 'POST', body: JSON.stringify({ data, createToken, sequenceHint })
});
export const updateEnquiry = (id, data, version) => request(`/enquiries/${encodeURIComponent(id)}`, {
  method: 'PUT', body: JSON.stringify({ data, version })
});
export const deleteEnquiry = (id, version, reason) => request(`/enquiries/${encodeURIComponent(id)}`, {
  method: 'DELETE', body: JSON.stringify({ version, reason })
});

