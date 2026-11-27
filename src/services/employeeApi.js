import { authHeaders } from '../utils/auth.js';

const base = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/employees${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Employee request failed (${response.status})`);
    error.status = response.status;
    error.current = payload.current;
    throw error;
  }
  return payload;
};

const token = (prefix) => {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
};

export const listEmployees = async ({ includeDeleted = false } = {}) => {
  const result = await request(includeDeleted ? '?includeDeleted=1' : '');
  return Array.isArray(result.records) ? result.records : [];
};

export const getEmployeeDirectory = async () => {
  const result = await request('/directory');
  return Array.isArray(result.employees) ? result.employees : [];
};

export const createEmployee = (data, idempotencyToken = token('employee-create')) => request('', {
  method: 'POST',
  body: JSON.stringify({ data, createToken: idempotencyToken })
});

export const updateEmployee = (id, data, version, idempotencyToken = token('employee-update')) => request(`/${encodeURIComponent(id)}`, {
  method: 'PUT',
  body: JSON.stringify({ data, version, idempotencyToken })
});

export const deleteEmployee = (id, version, reason, idempotencyToken = token('employee-delete')) => request(`/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  body: JSON.stringify({ version, reason, idempotencyToken })
});

export const restoreEmployee = (id, version, reason, idempotencyToken = token('employee-restore')) => request(`/${encodeURIComponent(id)}/restore`, {
  method: 'POST',
  body: JSON.stringify({ version, reason, idempotencyToken })
});

export const getLegacyEmployeesPreview = async () => (await request('/legacy/preview')).entries || [];

export const importLegacyEmployees = (selected, idempotencyToken = token('employee-import')) => request('/legacy/import', {
  method: 'POST',
  body: JSON.stringify({ selected, idempotencyToken })
});
