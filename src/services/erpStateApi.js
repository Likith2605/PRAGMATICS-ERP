import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

export const getERPStateRecord = async (key) => {
  const response = await fetch(`${base()}/state/${encodeURIComponent(key)}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `ERP state request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body.data;
};
