import { authHeaders } from '../utils/auth.js';
const base = () => typeof window !== 'undefined' && window.location ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api') : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
const request = async (path, options = {}) => {
  const response = await fetch(`${base()}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || `Inventory request failed (${response.status})`); error.status = response.status; error.current = body.current; throw error; }
  return body;
};
const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });

export const normalizeStockLedgerRecord = (row, itemNames = new Map()) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const itemCode = String(row?.item_code || row?.itemCode || '');
  const movementType = String(row?.movement_type || row?.movementType || '').toUpperCase();
  const outbound = ['OUT', 'ISSUE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT'].includes(movementType);
  const sourceRef = String(row?.source_doc_ref || row?.sourceDocRef || '');
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    id: String(row?.id || sourceRef),
    date: row?.entry_date || row?.entryDate || '',
    dateTime: row?.entry_time || row?.entryTime || row?.entry_date || row?.entryDate || '',
    itemCode,
    itemName: payload.materialName || payload.itemName || itemNames.get(itemCode) || itemCode,
    type: outbound ? 'OUT' : 'IN',
    movementType,
    quantity: number(row?.quantity),
    unit: row?.unit || payload.unit || '',
    balanceAfter: number(row?.balance_after ?? row?.balanceAfter),
    reference: payload.reference || sourceRef,
    transactionNumber: payload.transactionNumber || sourceRef,
    batchNo: row?.batch_no || row?.batchNo || payload.batchNo || '',
    lotNumber: row?.lot_number || row?.lotNumber || payload.lotNumber || '',
    projectId: payload.projectId || payload.project_id || '',
    issuedTo: payload.issuedTo || '',
    issuedToId: payload.issuedToId || '',
    returnedBy: payload.returnedBy || '',
    issuedBy: payload.issuedBy || row?.created_by || row?.createdBy || '',
    reason: row?.reason || payload.reason || movementType
  };
};

export const listInventoryItems = async (search = '') => (await request(`/inventory/items${search ? `?search=${encodeURIComponent(search)}` : ''}`)).records || [];
export const getInventoryItem = async (itemCode) => (await request(`/inventory/items/${encodeURIComponent(itemCode)}`)).record;
export const saveInventoryItem = async (data, version) => (await request('/inventory/items', json('POST', { data, version }))).record;
export const deleteInventoryItem = async (itemCode, version, reason) => (await request(`/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', { version, reason }))).record;
export const postOpeningStock = async (payload) => request('/inventory/opening-stock', json('POST', payload));
export const postInventoryAdjustment = async (payload) => request('/inventory/adjustments', json('POST', payload));
export const postInventoryTransfer = async (payload) => request('/inventory/transfers', json('POST', payload));
export const listStockLedger = async (filters = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return (await request(`/inventory/ledger${query ? `?${query}` : ''}`)).records || [];
};
export const listAllStockLedger = async (filters = {}) => {
  const pageSize = 2000;
  const records = [];
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      limit: String(pageSize),
      offset: String(offset)
    });
    const page = await request(`/inventory/ledger?${query.toString()}`);
    const pageRecords = Array.isArray(page.records) ? page.records : [];
    records.push(...pageRecords);
    if (records.length >= Number(page.total ?? records.length) || pageRecords.length < pageSize) return records;
    offset += pageRecords.length;
  }
};
export const listInventoryValuation = async () => (await request('/inventory/valuation')).records || [];
export const listInventoryLots = async (filters = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return (await request(`/inventory/lots${query ? `?${query}` : ''}`)).records || [];
};
export const listInventoryLocationBalances = async (filters = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return (await request(`/inventory/location-balances${query ? `?${query}` : ''}`)).records || [];
};
export const listInventoryLocationBatchBalances = async (filters = {}) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  return (await request(`/inventory/location-batch-balances${query ? `?${query}` : ''}`)).records || [];
};
export const listStockTransfers = async (status = '') => {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return (await request(`/inventory/transfer-documents${query}`)).records || [];
};
export const getStockTransfer = async (transferNumber) => (await request(`/inventory/transfer-documents/${encodeURIComponent(transferNumber)}`)).record;
export const createStockTransfer = async (data, idempotencyKey) =>
  request('/inventory/transfer-documents', json('POST', { data, idempotencyKey }));
export const resolveStockTransfer = async (transferNumber, action, payload) =>
  request(`/inventory/transfer-documents/${encodeURIComponent(transferNumber)}/${action}`, json('POST', payload));
export const listStockVerifications = async (status = '') => {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return (await request(`/inventory/verifications${query}`)).records || [];
};
export const getStockVerification = async (verificationNumber) =>
  (await request(`/inventory/verifications/${encodeURIComponent(verificationNumber)}`)).record;
export const createStockVerification = async (data, idempotencyKey) =>
  request('/inventory/verifications', json('POST', { data, idempotencyKey }));
export const resolveStockVerification = async (verificationNumber, action, payload) =>
  request(`/inventory/verifications/${encodeURIComponent(verificationNumber)}/${action}`, json('POST', payload));
