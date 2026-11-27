import { authHeaders } from '../utils/auth.js';
import { cacheJobCards, getCachedJobCards, cacheRequirements } from './productionAuthorityCache.js';

const base = () => {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.port === '5173'
      ? `http://${window.location.hostname || 'localhost'}:3001/api`
      : '/api';
  }
  return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const request = async (path, options = {}) => {
  const response = await fetch(`${base()}/production${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Production request failed (${response.status})`);
    error.status = response.status;
    error.current = body.current;
    throw error;
  }
  return body;
};

const mutation = (path, method, body) => request(path, { method, body });

/* Job Cards */
export const listJobCards = async () => cacheJobCards((await request('/job-cards')).records || []);
export const getJobCard = async (number) => {
  const record = (await request(`/job-cards/${encodeURIComponent(number)}`)).record;
  if (record) cacheJobCards([record, ...getCachedJobCards().filter((row) => row.jobCardNumber !== record.jobCardNumber)]);
  return record;
};
export const createJobCard = async (data, createToken) => {
  const result = await mutation('/job-cards', 'POST', { data, createToken });
  if (result.record) await listJobCards();
  return result;
};
export const updateJobCard = async (number, version, data) => {
  const result = await mutation(`/job-cards/${encodeURIComponent(number)}`, 'PUT', { version, data });
  if (result.record) await listJobCards();
  return result;
};
export const deleteJobCard = async (number, version, reason) => {
  const result = await mutation(`/job-cards/${encodeURIComponent(number)}`, 'DELETE', { version, reason });
  await listJobCards();
  return result;
};
export const restoreJobCard = async (number, reason) => {
  const result = await mutation(`/job-cards/${encodeURIComponent(number)}/restore`, 'POST', { reason });
  await listJobCards();
  return result;
};
export const issueJobCard = async (number, version, bomNumber, bomVersion) => {
  const result = await mutation(`/job-cards/${encodeURIComponent(number)}/issue`, 'POST', { version, bomNumber, bomVersion });
  await listJobCards();
  return result;
};
export const completeJobCard = async (number, version) => {
  const result = await mutation(`/job-cards/${encodeURIComponent(number)}/complete`, 'POST', { version });
  await listJobCards();
  return result;
};
export const requestJobCardDispatch = (number, version) => mutation(`/job-cards/${encodeURIComponent(number)}/dispatch-request`, 'POST', { version });
export const getJobCardItems = async (number) => (await request(`/job-cards/${encodeURIComponent(number)}/items`)).items || [];
export const getJobCardAudit = async (number) => (await request(`/job-cards/${encodeURIComponent(number)}/audit`)).entries || [];

/* Production requirements */
export const listRequirements = async () => cacheRequirements((await request('/requirements')).records || []);
export const getRequirement = async (number) => {
  const record = (await request(`/requirements/${encodeURIComponent(number)}`)).record;
  if (record) {
    const current = await listRequirements();
    cacheRequirements([record, ...current.filter((row) => row.requirementNumber !== record.requirementNumber)]);
  }
  return record;
};
export const createRequirement = async (data, createToken) => {
  const result = await mutation('/requirements', 'POST', { data, createToken });
  await listRequirements();
  return result;
};
export const updateRequirement = async (number, version, data) => {
  const result = await mutation(`/requirements/${encodeURIComponent(number)}`, 'PUT', { version, data });
  await listRequirements();
  return result;
};
export const deleteRequirement = async (number, version, reason) => {
  const result = await mutation(`/requirements/${encodeURIComponent(number)}`, 'DELETE', { version, reason });
  await listRequirements();
  return result;
};
export const restoreRequirement = async (number, reason) => {
  const result = await mutation(`/requirements/${encodeURIComponent(number)}/restore`, 'POST', { reason });
  await listRequirements();
  return result;
};
export const requirementAction = async (number, action, version, extra = {}) => {
  const result = await mutation(`/requirements/${encodeURIComponent(number)}/${action}`, 'POST', { version, ...extra });
  await listRequirements();
  return result;
};
export const getRequirementAudit = async (number) => (await request(`/requirements/${encodeURIComponent(number)}/audit`)).entries || [];

/* HT outsource */
export const listHtOutsource = async () => (await request('/ht-outsource')).records || [];
export const getHtOutsource = async (number) => (await request(`/ht-outsource/${encodeURIComponent(number)}`)).record;
export const createHtOutsource = (data, createToken) => mutation('/ht-outsource', 'POST', { data, createToken });
export const updateHtOutsource = (number, version, data) => mutation(`/ht-outsource/${encodeURIComponent(number)}`, 'PUT', { version, data });
export const assignHtVendor = (number, version, data) => mutation(`/ht-outsource/${encodeURIComponent(number)}/assign-vendor`, 'POST', { version, ...data });
export const issueHt = async (number, version, data) => {
  const result = await mutation(`/ht-outsource/${encodeURIComponent(number)}/issue`, 'POST', { version, ...data });
  await listJobCards();
  return result;
};
export const receiveHt = async (number, version, data) => {
  const result = await mutation(`/ht-outsource/${encodeURIComponent(number)}/receive`, 'POST', { version, ...data });
  await listJobCards();
  return result;
};
export const completeHt = async (number, version, data) => {
  const result = await mutation(`/ht-outsource/${encodeURIComponent(number)}/complete`, 'POST', { version, ...data });
  await listJobCards();
  return result;
};
export const rejectHt = (number, version, data) => mutation(`/ht-outsource/${encodeURIComponent(number)}/reject`, 'POST', { version, ...data });
export const cancelHt = (number, version, reason) => mutation(`/ht-outsource/${encodeURIComponent(number)}/cancel`, 'POST', { version, reason });
export const deleteHtOutsource = (number, version, reason) => mutation(`/ht-outsource/${encodeURIComponent(number)}`, 'DELETE', { version, reason });
export const getHtAudit = async (number) => (await request(`/ht-outsource/${encodeURIComponent(number)}/audit`)).entries || [];

/* Shared dispatch requests */
export const listDispatchRequests = async () => (await request('/dispatch-requests')).records || [];
export const linkDispatchRequestToChallan = (id, version, challanNumber, quantity) =>
  mutation(`/dispatch-requests/${encodeURIComponent(id)}/link`, 'POST', { version, challanNumber, quantity });
export const markDispatchRequestDispatched = (id, version, challanNumber) =>
  mutation(`/dispatch-requests/${encodeURIComponent(id)}/dispatched`, 'POST', { version, challanNumber });
export const releaseDispatchRequestChallan = (id, version, challanNumber) =>
  mutation(`/dispatch-requests/${encodeURIComponent(id)}/release`, 'POST', { version, challanNumber });

/* Admin migration tools */
export const productionMigrationPreview = async () => request('/migration-preview');
export const importProductionMissing = (kind, records) => mutation('/migration-preview/import-missing', 'POST', { kind, records });
