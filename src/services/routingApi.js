import { authHeaders } from '../utils/auth.js';

const base = () => {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.port === '5173'
      ? `http://${window.location.hostname || 'localhost'}:3001/api`
      : '/api';
  }
  return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/routing${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Routing request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

const mutation = (path, method, body) => request(path, { method, body });
const card = (number) => `/job-cards/${encodeURIComponent(number)}`;

export const listOperations = async (number) => (await request(`${card(number)}/operations`)).operations || [];
export const getOperation = async (id) => (await request(`/operations/${encodeURIComponent(id)}`)).operation;
export const addOperation = (number, version, operation) => mutation(`${card(number)}/operations`, 'POST', { version, operation });
export const updateOperation = (id, version, operation) => mutation(`/operations/${encodeURIComponent(id)}`, 'PUT', { version, operation });
export const startOperation = (id, version, data = {}) => mutation(`/operations/${encodeURIComponent(id)}/start`, 'POST', { version, ...data });
export const completeOperation = (id, version, data = {}) => mutation(`/operations/${encodeURIComponent(id)}/complete`, 'POST', { version, ...data });
export const deleteOperation = (id, version) => mutation(`/operations/${encodeURIComponent(id)}`, 'DELETE', { version });
export const listOperationEntries = async (id) => (await request(`/operations/${encodeURIComponent(id)}/entries`)).entries || [];
export const addOperationEntry = (id, version, entry) => mutation(`/operations/${encodeURIComponent(id)}/entries`, 'POST', { version, entry });
export const listJobCardEntries = async (number) => (await request(`${card(number)}/entries`)).entries || [];
export const getRoutingAudit = async (number) => (await request(`${card(number)}/audit`)).entries || [];
