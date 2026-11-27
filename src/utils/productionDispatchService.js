import { hasPermission, getCurrentUserInfo } from './permissions.js';
import { appendAuditLog, pushNotification } from './storeService.js';
import {
  listDispatchRequests,
  getJobCard,
  requestJobCardDispatch,
  linkDispatchRequestToChallan as linkDispatchRequestApi,
  markDispatchRequestDispatched as markDispatchRequestApi,
  releaseDispatchRequestChallan as releaseDispatchRequestApi
} from '../services/productionApi.js';

export const PRODUCTION_DISPATCH_KEY = 'productionDispatchRequests';

const readRequests = () => {
  try {
    const rows = JSON.parse(localStorage.getItem(PRODUCTION_DISPATCH_KEY) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};

const writeRequests = (rows) => localStorage.setItem(PRODUCTION_DISPATCH_KEY, JSON.stringify(rows));
const cleanText = (value) => String(value || '').trim();
const dateTime = () => new Date().toISOString();
const userInfo = () => {
  const info = getCurrentUserInfo();
  return {
    name: info.employee?.name || info.auth?.username || 'Production User',
    employeeId: info.employee?.employeeId || info.auth?.employeeId || '',
    department: info.employee?.department || 'Production Department'
  };
};

export const getProductionDispatchRequests = () => readRequests();

export const refreshProductionDispatchRequests = async() => {
  const records = await listDispatchRequests();
  writeRequests(records);
  return records;
};

const requestIdFor = (jobCardNumber) => `dispatch-${String(jobCardNumber).replace(/[^A-Za-z0-9._:-]/g, '-')}`;

export const requestProductionDispatch = async(jobCardNumber) => {
  if (!hasPermission('job_card.dispatch_request'))
    throw new Error('Permission denied: only Production users can request Job Card dispatch.');
  const jc = await getJobCard(jobCardNumber);
  const result = await requestJobCardDispatch(jobCardNumber, Number(jc.version) || 1);
  if (result.duplicate) throw new Error(`A dispatch request already exists for Job Card ${jobCardNumber}.`);
  const request = result.request || result.record;
  if (!request) throw new Error('PostgreSQL did not return the created dispatch request.');
  const eligibleQuantity = Number(request.eligibleQuantity || request.productionQuantity || 0);
  const projectId = cleanText(request.projectId);
  const salesOrderNo = cleanText(request.salesOrderNo);
  writeRequests([request, ...readRequests().filter((row) => String(row.id) !== String(request.id))]);
  appendAuditLog({ action: 'PRODUCTION DISPATCH REQUESTED', reference: jc.jobCardNumber, details: `${eligibleQuantity} ${jc.partName || 'unit(s)'} | ${salesOrderNo} | ${projectId}` });
  pushNotification({
    title: 'Production dispatch ready',
    message: `${jc.jobCardNumber} is QC approved and ready for a Delivery Challan (${eligibleQuantity} unit(s)).`,
    type: 'success',
    reference: jc.jobCardNumber,
    targetDept: 'Sales Department',
    link: '/delivery-challan'
  });
  return request;
};

export const linkDispatchRequestToChallan = async({ requestId, challanNumber, quantity }) => {
  if (!hasPermission('delivery.create'))
    throw new Error('Permission denied: only Sales users can create a Delivery Challan from a dispatch request.');
  const current = readRequests().find((row) => String(row.id) === String(requestId));
  if (!current) throw new Error('Dispatch request not found in the latest PostgreSQL data.');
  const updated = (await linkDispatchRequestApi(requestId, Number(current.version) || 1, cleanText(challanNumber), Number(quantity))).record;
  writeRequests([updated, ...readRequests().filter((row) => String(row.id) !== String(requestId))]);
  appendAuditLog({ action: 'DELIVERY CHALLAN CREATED FROM DISPATCH REQUEST', reference: challanNumber, details: `${updated.jobCardNumber} | ${quantity} unit(s)` });
  return updated;
};

export const markDispatchRequestDispatched = async({ requestId, challanNumber }) => {
  if (!hasPermission('delivery.create'))
    throw new Error('Permission denied: only Sales users can confirm dispatch.');
  const current = readRequests().find((row) => String(row.id) === String(requestId));
  if (!current) throw new Error('Dispatch request not found in the latest PostgreSQL data.');
  const updated = (await markDispatchRequestApi(requestId, Number(current.version) || 1, cleanText(challanNumber))).record;
  writeRequests([updated, ...readRequests().filter((row) => String(row.id) !== String(requestId))]);
  appendAuditLog({ action: 'PRODUCTION DISPATCH CONFIRMED', reference: updated.jobCardNumber, details: `Dispatched under ${challanNumber}` });
  return updated;
};

export const releaseDispatchRequestChallan = async({ requestId, challanNumber }) => {
  if (!hasPermission('delivery.create'))
    throw new Error('Permission denied: only Sales users can manage a Delivery Challan from a dispatch request.');
  const current = readRequests().find((row) => String(row.id) === String(requestId));
  if (!current) throw new Error('Dispatch request not found in the latest PostgreSQL data.');
  const updated = (await releaseDispatchRequestApi(requestId, Number(current.version) || 1, cleanText(challanNumber))).record;
  writeRequests([updated, ...readRequests().filter((row) => String(row.id) !== String(requestId))]);
  return updated;
};
