import assert from 'node:assert/strict';

const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(String(key)) ?? null,
  setItem: (key, value) => local.set(String(key), String(value)),
  removeItem: (key) => local.delete(String(key)),
  clear: () => local.clear(),
  key: (index) => [...local.keys()][index] ?? null,
  get length() { return local.size; }
};
globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.window = {
  location: { port: '5173', hostname: 'localhost' },
  setTimeout,
  clearTimeout,
  dispatchEvent() {},
  addEventListener() {},
  removeEventListener() {}
};

const server = new Map();
const jobCards = new Map();
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; }
});
globalThis.fetch = async(url, options = {}) => {
  const parsed = new URL(url);
  const dispatchAction = parsed.pathname.match(/\/api\/production\/dispatch-requests\/([^/]+)\/(link|dispatched|release)$/);
  if (dispatchAction) {
    const id = decodeURIComponent(dispatchAction[1]);
    const action = dispatchAction[2];
    const body = JSON.parse(options.body || '{}');
    const current = server.get('productionDispatchRequests').get(id);
    if (!current) return jsonResponse({ error: 'Dispatch request not found.' }, 404);
    if (Number(body.version) !== current.version) return jsonResponse({ error: 'Dispatch request changed.', current }, 409);
    if (action === 'link') {
      if (current.data.status !== 'Pending' || current.data.challanNumber) return jsonResponse({ error: 'Dispatch request already has a Delivery Challan.' }, 409);
      if (Number(body.quantity) <= 0 || Number(body.quantity) > Number(current.data.eligibleQuantity))
        return jsonResponse({ error: `Dispatch quantity must be greater than zero and no more than ${current.data.eligibleQuantity}.` }, 400);
      const next = { ...current.data, status: 'Challan Created', challanNumber: body.challanNumber, challanQuantity: Number(body.quantity), audit: [...(current.data.audit || []), { action: 'Delivery Challan created' }] };
      server.get('productionDispatchRequests').set(id, { ...current, data: next, version: current.version + 1 });
    } else if (action === 'dispatched') {
      const next = { ...current.data, status: 'Dispatched', dispatchedAt: new Date().toISOString(), audit: [...(current.data.audit || []), { action: 'Dispatch confirmed' }] };
      server.get('productionDispatchRequests').set(id, { ...current, data: next, version: current.version + 1 });
    } else {
      const { challanNumber, challanQuantity, ...rest } = current.data;
      const next = { ...rest, status: 'Pending', audit: [...(current.data.audit || []), { action: 'Challan creation rolled back' }] };
      server.get('productionDispatchRequests').set(id, { ...current, data: next, version: current.version + 1 });
    }
    const saved = server.get('productionDispatchRequests').get(id);
    return jsonResponse({ record: { ...saved.data, id, version: saved.version } });
  }
  if (parsed.pathname === '/api/production/dispatch-requests' && (!options.method || options.method === 'GET')) {
    return jsonResponse({ records: [...server.get('productionDispatchRequests').values()].map((row) => ({ ...row.data, id: row.id, version: row.version })) });
  }
  const dispatchMatch = parsed.pathname.match(/\/api\/production\/job-cards\/([^/]+)\/dispatch-request$/);
  if (dispatchMatch) {
    const number = decodeURIComponent(dispatchMatch[1]);
    const row = jobCards.get(number);
    if (!row) return jsonResponse({ error: 'Job Card not found.' }, 404);
    if (row.failure) return jsonResponse({ error: row.failure }, row.status || 503);
    if (String(row.status).toLowerCase() !== 'completed') return jsonResponse({ error: `Job Card ${number} is not completed.` }, 400);
    if (String(row.qualityControl?.finalQC?.disposition || '').toLowerCase() !== 'pass') return jsonResponse({ error: `Job Card ${number} final QC must PASS before dispatch.` }, 400);
    const eligible = Math.min(Number(row.orderQuantity), Number(row.qualityControl.finalQC.acceptedQty));
    if (eligible <= 0) return jsonResponse({ error: `Job Card ${number} has no QC-approved quantity eligible for dispatch.` }, 400);
    const id = `dispatch-${number.replace(/[^A-Za-z0-9._:-]/g, '-')}`;
    if (!server.has('productionDispatchRequests')) server.set('productionDispatchRequests', new Map());
    const existing = server.get('productionDispatchRequests').get(id);
    if (existing) return jsonResponse({ record: { ...existing.data, id, version: existing.version }, duplicate: true });
    const body = JSON.parse(options.body || '{}');
    if (Number(body.version) !== 1) return jsonResponse({ error: 'Job Card version changed.' }, 409);
    const at = new Date().toISOString();
    const request = { id, version: 1, jobCardNumber: number, projectId: row.projectId, salesOrderNo: row.salesOrderRef, customerName: row.customerName,
      partName: row.partName, drawingNumber: row.drawingNumber, productionQuantity: eligible, eligibleQuantity: eligible, qcStatus: 'PASS',
      status: 'Pending', requestedAt: at, createdAt: at, audit: [{ action: 'Dispatch request created', at }] };
    server.get('productionDispatchRequests').set(id, { id, data: request, version: 1 });
    return jsonResponse({ record: request, request, duplicate: false }, 201);
  }
  const jobCardMatch = parsed.pathname.match(/\/api\/production\/job-cards\/([^/]+)$/);
  if (jobCardMatch) {
    const number = decodeURIComponent(jobCardMatch[1]);
    const row = jobCards.get(number);
    if (row?.failure) return jsonResponse({ error: row.failure }, row.status || 503);
    return row
      ? jsonResponse({ record: { ...row } })
      : jsonResponse({ error: 'Job Card not found.' }, 404);
  }
  const match = parsed.pathname.match(/\/api\/records\/([^/]+)$/);
  if (!match) return jsonResponse({ error: `Unexpected request ${parsed.pathname}` }, 404);
  const key = decodeURIComponent(match[1]);
  if (!server.has(key)) server.set(key, new Map());
  const rows = server.get(key);
  if (!options.method || options.method === 'GET') {
    return jsonResponse({ key, records: [...rows.values()].map((row) => ({ ...row })) });
  }
  const body = JSON.parse(options.body || '{}');
  const saved = [];
  const conflicts = [];
  for (const record of body.records || []) {
    const id = String(record.id);
    const current = rows.get(id);
    if (!current) {
      rows.set(id, { id, data: record.data, version: Number(record.version || 0) + 1, updatedBy: body.updatedBy });
      saved.push({ id, version: Number(record.version || 0) + 1 });
    } else if (Number(record.version) !== current.version) {
      conflicts.push({ ...current });
    } else {
      const next = { id, data: record.data, version: current.version + 1, updatedBy: body.updatedBy };
      rows.set(id, next);
      saved.push({ id, version: next.version });
    }
  }
  return jsonResponse({ key, saved, conflicts, deleted: [] });
};

const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const loginAs = (department, roleKey, username) => save('erp_auth', {
  isLoggedIn: true, department, roleKey, username, email: `${username}@test.invalid`
});
const jc = (overrides = {}) => ({
  jobCardNumber: 'JC-DISPATCH-001',
  status: 'Completed',
  projectId: 'PE-TEST-01',
  salesOrderRef: 'SO-TEST-01',
  customerName: 'Test Customer',
  partName: 'Test Component',
  drawingNumber: 'DWG-001',
  orderQuantity: 12,
  qualityControl: { finalQC: { disposition: 'Pass', acceptedQty: 10 } },
  ...overrides
});

jobCards.set('JC-DISPATCH-001', jc());
jobCards.set('JC-INCOMPLETE', jc({ jobCardNumber: 'JC-INCOMPLETE', status: 'In Production' }));
jobCards.set('JC-QC-FAIL', jc({ jobCardNumber: 'JC-QC-FAIL', qualityControl: { finalQC: { disposition: 'Fail', acceptedQty: 12 } } }));
jobCards.set('JC-API-ERROR', { failure: 'PostgreSQL Job Card service unavailable.', status: 503 });
const staleJobCards = [jc({
  customerName: 'Stale Browser Customer',
  qualityControl: { finalQC: { disposition: 'Fail', acceptedQty: 12 } }
}), jc({ jobCardNumber: 'JC-INCOMPLETE', status: 'Completed' }),
  jc({ jobCardNumber: 'JC-QC-FAIL', qualityControl: { finalQC: { disposition: 'Pass', acceptedQty: 12 } } })];
save('productionJobCards', staleJobCards);

const dispatch = await import('../src/utils/productionDispatchService.js');
const recordsSync = await import('../src/services/recordsSync.js');

loginAs('Production Department', 'production_manager', 'Prod Manager');
await assert.rejects(() => dispatch.requestProductionDispatch('JC-INCOMPLETE'), /not completed/);
await assert.rejects(() => dispatch.requestProductionDispatch('JC-QC-FAIL'), /final QC must PASS/);
await assert.rejects(() => dispatch.requestProductionDispatch('JC-API-ERROR'), /PostgreSQL Job Card service unavailable/);

const request = await dispatch.requestProductionDispatch('JC-DISPATCH-001');
assert.equal(request.status, 'Pending');
assert.equal(request.productionQuantity, 10, 'eligible quantity comes from QC accepted output and is capped by Job Card quantity');
assert.equal(request.jobCardNumber, 'JC-DISPATCH-001');
assert.equal(request.projectId, 'PE-TEST-01');
assert.equal(request.salesOrderNo, 'SO-TEST-01');
assert.equal(request.customerName, 'Test Customer');
assert.deepEqual(JSON.parse(localStorage.getItem('productionJobCards')), staleJobCards,
  'dispatch eligibility uses PostgreSQL and never replaces or trusts the stale browser Job Card snapshot');
assert.equal(server.get('productionDispatchRequests').size, 1, 'dispatch request is committed to the shared backend record store');
assert.equal(JSON.parse(localStorage.getItem('notifications')).filter((item) => item.targetDept === 'Sales Department').length, 1);
await assert.rejects(() => dispatch.requestProductionDispatch('JC-DISPATCH-001'), /already exists/);
assert.equal(server.get('productionDispatchRequests').size, 1, 'duplicate request does not create a second backend record');

// Simulate a second computer/login with an empty local request cache.
save('productionDispatchRequests', []);
loginAs('Sales Department', 'sales_employee', 'Sales User');
const visibleToSales = await dispatch.refreshProductionDispatchRequests();
assert.equal(visibleToSales.length, 1, 'Sales pulls the pending request from the backend after login');
assert.equal(visibleToSales[0].status, 'Pending');
await assert.rejects(() => dispatch.requestProductionDispatch('JC-DISPATCH-001'), /only Production users/);
loginAs('Store Department', 'store_manager', 'Store User');
await assert.rejects(() => dispatch.linkDispatchRequestToChallan({ requestId: request.id, challanNumber: 'DC-STORE', quantity: 8 }), /only Sales users/);
loginAs('Sales Department', 'sales_employee', 'Sales User');
await assert.rejects(() => dispatch.linkDispatchRequestToChallan({ requestId: request.id, challanNumber: 'DC-OVER', quantity: 11 }), /no more than 10/);

await dispatch.linkDispatchRequestToChallan({ requestId: request.id, challanNumber: 'DC-DISPATCH-001', quantity: 8 });
let linked = dispatch.getProductionDispatchRequests()[0];
assert.equal(linked.status, 'Challan Created');
assert.equal(linked.challanNumber, 'DC-DISPATCH-001');
assert.equal(linked.challanQuantity, 8);
await assert.rejects(() => dispatch.linkDispatchRequestToChallan({ requestId: request.id, challanNumber: 'DC-DUP', quantity: 2 }), /already has a Delivery Challan/);
await dispatch.markDispatchRequestDispatched({ requestId: request.id, challanNumber: 'DC-DISPATCH-001' });
linked = dispatch.getProductionDispatchRequests()[0];
assert.equal(linked.status, 'Dispatched');
assert.ok(linked.dispatchedAt);
assert.ok(linked.audit.some((entry) => entry.action === 'Delivery Challan created'));
assert.ok(linked.audit.some((entry) => entry.action === 'Dispatch confirmed'));

// Stale same-record writes cannot silently overwrite a status updated elsewhere.
const current = server.get('productionDispatchRequests').get(request.id);
const stale = await fetch('http://localhost:3001/api/records/productionDispatchRequests', {
  method: 'PUT', body: JSON.stringify({ records: [{ id: request.id, data: { ...current.data, status: 'Pending' }, version: 1 }] })
});
const stalePayload = await stale.json();
assert.equal(stalePayload.saved.length, 0);
assert.equal(stalePayload.conflicts.length, 1);
assert.equal(server.get('productionDispatchRequests').get(request.id).data.status, 'Dispatched');

assert.deepEqual(recordsSync.getModuleRecordKeys().includes('productionDispatchRequests'), true);
console.log('Production dispatch request workflow checks passed.');
