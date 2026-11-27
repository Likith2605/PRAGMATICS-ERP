import { authHeaders } from '../utils/auth.js';
import { listModuleRecords } from './moduleRecordsApi.js';

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
    const error = new Error(body.error || `Availability check request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

export const listAvailabilityChecks = () => listModuleRecords('soMaterialAvailabilityChecks');
export const saveAvailabilityCheck = async (soNumber, remarks, version = 0) => {
  const body = await request(`/availability-checks/${encodeURIComponent(soNumber)}`, {
    method: 'PUT',
    body: JSON.stringify({ remarks, version })
  });
  return body.record;
};
export const markAvailabilityProductionNotified = async (soNumber, version) => {
  const body = await request(`/availability-checks/${encodeURIComponent(soNumber)}/production-notified`, {
    method: 'POST',
    body: JSON.stringify({ version })
  });
  return body.record;
};
export const previewLegacyAvailabilityChecks = () => request('/availability-checks/migration-preview');
export const importLegacyAvailabilityChecks = (soNumbers) => request('/availability-checks/migration-preview/import', {
  method: 'POST',
  body: JSON.stringify({ soNumbers })
});
