import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

export const listModuleRecords = async (key) => {
  const response = await fetch(`${base()}/records/${encodeURIComponent(key)}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Module record request failed (${response.status})`);
  return (Array.isArray(body.records) ? body.records : []).map((record) => ({
    ...(record.data || {}),
    id: record.id,
    recordVersion: record.version,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy
  }));
};
