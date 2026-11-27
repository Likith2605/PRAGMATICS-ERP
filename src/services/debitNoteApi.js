import { authHeaders } from '../utils/auth.js';

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
    const error = new Error(body.error || `Debit Note request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

/** Stable per-screen token so a double-click or retry cannot create two notes. */
export const debitNoteCreateToken = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `dn-${crypto.randomUUID()}`;
  return `dn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const listDebitNotes = async () => (await request('/debit-notes')).records || [];
export const getDebitNoteDetail = async (number) => request(`/debit-notes/${encodeURIComponent(number)}`);
export const getDebitNote = async (number) => (await getDebitNoteDetail(number)).record;
export const getDebitNoteCandidates = async () => (await request('/debit-notes/candidates')).candidates || [];
export const getDebitNoteContext = async (rejectionNumber) =>
  (await request(`/debit-notes/context/${encodeURIComponent(rejectionNumber)}`)).context;

export const createDebitNote = (data, createToken = debitNoteCreateToken()) =>
  request('/debit-notes', { method: 'POST', body: JSON.stringify({ data, createToken }) });
export const updateDebitNote = (number, version, data) =>
  request(`/debit-notes/${encodeURIComponent(number)}`, { method: 'PUT', body: JSON.stringify({ version, data }) });
export const transitionDebitNote = (number, transition, version) =>
  request(`/debit-notes/${encodeURIComponent(number)}/${transition}`, { method: 'POST', body: JSON.stringify({ version }) });
export const approveDebitNote = (number, version) =>
  request(`/debit-notes/${encodeURIComponent(number)}/approve`, { method: 'POST', body: JSON.stringify({ version }) });
export const rejectDebitNote = (number, version, reason) =>
  request(`/debit-notes/${encodeURIComponent(number)}/reject`, { method: 'POST', body: JSON.stringify({ version, reason }) });
export const cancelDebitNote = (number, version, reason = '') =>
  request(`/debit-notes/${encodeURIComponent(number)}/cancel`, { method: 'POST', body: JSON.stringify({ version, reason }) });
export const deleteDebitNote = (number, version, reason = '') =>
  request(`/debit-notes/${encodeURIComponent(number)}`, { method: 'DELETE', body: JSON.stringify({ version, reason }) });
export const restoreDebitNote = (number, version, reason) =>
  request(`/debit-notes/${encodeURIComponent(number)}/restore`, { method: 'POST', body: JSON.stringify({ version, reason }) });

export const getDebitNoteMigrationPreview = () => request('/debit-notes/migration-preview');
export const importMissingDebitNotes = (records) =>
  request('/debit-notes/migration-preview/import-missing', { method: 'POST', body: JSON.stringify({ records }) });
