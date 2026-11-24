import { hasPermission, getCurrentUserInfo } from './permissions.js';
import { appendAuditLog, pushNotification } from './storeService.js';
import { createRecordOnServer, getRecordsStatus, pullRecordsFromServer, updateRecordOnServer } from '../services/recordsSync.js';

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
  await pullRecordsFromServer();
  const status = getRecordsStatus(PRODUCTION_DISPATCH_KEY);
  if (status.connected === false && status.lastError)
    throw new Error(`ERP backend sync failed: ${status.lastError}`);
  return readRequests();
};

const getJobCard = (jobCardNumber) => {
  try {
    const rows = JSON.parse(localStorage.getItem('productionJobCards') || '[]');
    return (Array.isArray(rows) ? rows : []).find((row) => String(row.jobCardNumber) === String(jobCardNumber)) || null;
  } catch {
    return null;
  }
};

const requestIdFor = (jobCardNumber) => `dispatch-${String(jobCardNumber).replace(/[^A-Za-z0-9._:-]/g, '-')}`;

export const requestProductionDispatch = async(jobCardNumber) => {
  if (!hasPermission('job_card.dispatch_request'))
    throw new Error('Permission denied: only Production users can request Job Card dispatch.');
  const jc = getJobCard(jobCardNumber);
  if (!jc) throw new Error(`Job Card ${jobCardNumber} was not found.`);
  if (String(jc.status || '').trim().toLowerCase() !== 'completed')
    throw new Error(`Job Card ${jobCardNumber} is not completed.`);
  const qc = jc.qualityControl?.finalQC || {};
  if (String(qc.disposition || '').trim().toLowerCase() !== 'pass')
    throw new Error(`Job Card ${jobCardNumber} final QC must PASS before dispatch.`);
  const orderQty = Number(jc.orderQuantity) || 0;
  const acceptedQty = Number(qc.acceptedQty);
  const eligibleQuantity = Math.min(orderQty, Number.isFinite(acceptedQty) ? acceptedQty : 0);
  if (eligibleQuantity <= 0)
    throw new Error(`Job Card ${jobCardNumber} has no QC-approved production quantity eligible for dispatch.`);

  const projectId = cleanText(jc.projectId);
  const salesOrderNo = cleanText(jc.salesOrderRef);
  const customerName = cleanText(jc.customerName || jc.customer);
  if (!projectId || !salesOrderNo || !customerName)
    throw new Error('The Job Card must have a Project ID, Sales Order and Customer before dispatch can be requested.');

  // Pull the authoritative shared record before checking, then rely on the
  // database's unique (storage_key, record_id) key for the cross-device guard.
  await pullRecordsFromServer();
  const id = requestIdFor(jc.jobCardNumber);
  if (readRequests().some((request) => String(request.id) === id))
    throw new Error(`A dispatch request already exists for Job Card ${jc.jobCardNumber}.`);

  const user = userInfo();
  const requestedAt = dateTime();
  const request = {
    id,
    jobCardNumber: cleanText(jc.jobCardNumber),
    projectId,
    salesOrderNo,
    customerName,
    partName: cleanText(jc.partName),
    drawingNumber: cleanText(jc.drawingNumber),
    productionQuantity: eligibleQuantity,
    eligibleQuantity,
    qcStatus: 'PASS',
    status: 'Pending',
    dispatchRequestedBy: user.name,
    dispatchRequestedByEmployeeId: user.employeeId,
    dispatchRequestedByDepartment: user.department,
    requestedAt,
    createdAt: requestedAt,
    audit: [{ action: 'Dispatch request created', user: user.name, employeeId: user.employeeId, at: requestedAt }]
  };
  await createRecordOnServer(PRODUCTION_DISPATCH_KEY, request);
  // Refresh merges the committed server row into this device's local copy.
  if (!readRequests().some((row) => String(row.id) === id)) writeRequests([request, ...readRequests()]);
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
  const qty = Number(quantity);
  const updated = await updateRecordOnServer(PRODUCTION_DISPATCH_KEY, requestId, (current) => {
    if (current.status !== 'Pending' || current.challanNumber)
      throw new Error(`Dispatch request ${current.jobCardNumber} already has a Delivery Challan.`);
    if (!Number.isFinite(qty) || qty <= 0 || qty > Number(current.eligibleQuantity))
      throw new Error(`Dispatch quantity must be greater than zero and no more than ${current.eligibleQuantity}.`);
    const user = userInfo();
    const at = dateTime();
    return {
      ...current,
      status: 'Challan Created',
      challanNumber: cleanText(challanNumber),
      challanQuantity: qty,
      audit: [...(current.audit || []), { action: 'Delivery Challan created', user: user.name, employeeId: user.employeeId, at, reference: challanNumber, quantity: qty }]
    };
  });
  appendAuditLog({ action: 'DELIVERY CHALLAN CREATED FROM DISPATCH REQUEST', reference: challanNumber, details: `${updated.jobCardNumber} | ${quantity} unit(s)` });
  return updated;
};

export const markDispatchRequestDispatched = async({ requestId, challanNumber }) => {
  if (!hasPermission('delivery.create'))
    throw new Error('Permission denied: only Sales users can confirm dispatch.');
  const updated = await updateRecordOnServer(PRODUCTION_DISPATCH_KEY, requestId, (current) => {
    if (current.status !== 'Challan Created' || String(current.challanNumber) !== String(challanNumber))
      throw new Error('This dispatch request does not have a matching pending Delivery Challan.');
    const user = userInfo();
    const at = dateTime();
    return {
      ...current,
      status: 'Dispatched',
      dispatchedAt: at,
      dispatchedBy: user.name,
      audit: [...(current.audit || []), { action: 'Dispatch confirmed', user: user.name, employeeId: user.employeeId, at, reference: challanNumber }]
    };
  });
  appendAuditLog({ action: 'PRODUCTION DISPATCH CONFIRMED', reference: updated.jobCardNumber, details: `Dispatched under ${challanNumber}` });
  return updated;
};

export const releaseDispatchRequestChallan = async({ requestId, challanNumber }) => {
  if (!hasPermission('delivery.create'))
    throw new Error('Permission denied: only Sales users can manage a Delivery Challan from a dispatch request.');
  return updateRecordOnServer(PRODUCTION_DISPATCH_KEY, requestId, (current) => {
    if (current.status !== 'Challan Created' || String(current.challanNumber) !== String(challanNumber))
      throw new Error('The dispatch request can no longer be released for this challan.');
    const user = userInfo();
    const at = dateTime();
    const { challanNumber: _challanNumber, challanQuantity: _challanQuantity, ...rest } = current;
    return { ...rest, status: 'Pending', audit: [...(current.audit || []), { action: 'Challan creation rolled back', user: user.name, employeeId: user.employeeId, at, reference: challanNumber }] };
  });
};
