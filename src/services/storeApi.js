import { authHeaders } from '../utils/auth.js';
import { listJobCards } from './productionApi.js';
const base = () => typeof window !== 'undefined' && window.location ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api') : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
const request = async (path, options = {}) => {
  const response = await fetch(`${base()}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `Store request failed (${response.status})`); error.status = response.status; error.current = body.current; throw error; }
  return body;
};
const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });

export const getMaterialRequests = async () => (await request('/store/requests')).records || [];
export const createMaterialRequest = async (data) => (await request('/store/requests', json('POST', { data }))).record;
export const updateMaterialRequest = async (mrNumber, data, version) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}`, json('PUT', { data, version }))).record;
export const deleteMaterialRequestRecord = async (mrNumber, version, reason) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}`, json('DELETE', { version, reason }))).record;
export const submitMaterialRequest = async (mrNumber, version) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}/submit`, json('POST', { version }))).record;
export const approveMaterialRequest = async (mrNumber, version, reason) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}/approve`, json('POST', { version, reason }))).record;
export const rejectMaterialRequest = async (mrNumber, version, reason) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}/reject`, json('POST', { version, reason }))).record;
/* The Store workflow transitions below reuse the versioned request update
   route — no new server endpoint is introduced. */
export const markRequestPendingStore = async (mrNumber, version) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}`, json('PUT', { data: { status: 'Pending Store' }, version }))).record;
export const closeMaterialRequest = async (mrNumber, version, closedAt) => (await request(`/store/requests/${encodeURIComponent(mrNumber)}`, json('PUT', { data: { status: 'Closed', closedAt }, version }))).record;

export const getStoreIssues = async () => (await request('/store/issues')).records || [];
export const getStoreIssue = async (issueNumber) => (await request(`/store/issues/${encodeURIComponent(issueNumber)}`)).record;
export const issueMaterial = async (payload) => {
  const result = await request('/store/issue', json('POST', payload));
  await listJobCards();
  return result.record;
};
export const acknowledgeStoreIssue = async (issueNumber, payload) => (await request(`/store/issues/${encodeURIComponent(issueNumber)}/acknowledge`, json('POST', payload))).record;
export const cancelStoreIssue = async (issueNumber, payload) => (await request(`/store/issues/${encodeURIComponent(issueNumber)}/cancel`, json('POST', payload))).record;

export const returnMaterial = async (payload) => (await request('/store/returns', json('POST', payload))).record;
export const getMaterialReturns = async () => (await request('/store/returns')).records || [];
export const getStoreAudit = async (issueNumber, limit = 500) => {
  const query = new URLSearchParams({ ...(issueNumber ? { issueNumber } : {}), limit: String(limit) });
  return (await request(`/store/audit?${query.toString()}`)).records || [];
};
export const appendStoreAudit = async (entry) => (await request('/store/audit', json('POST', entry))).record;
export const nextStoreNumber = async (prefix, key) => (await request('/store/sequences/next', json('POST', { prefix, key }))).nextNumber;
