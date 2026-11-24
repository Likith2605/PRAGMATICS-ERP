import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getPool, closeDatabase } from '../server/database.js';

const port = 3349;
const base = `http://127.0.0.1:${port}/api`;
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), QC_PULL_ENABLED: '0' }, stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let adminToken = '';
let originalDirectory = null;
let originalQuotations = null;
let directoryFixtureWritten = false;
let quotationFixtureWritten = false;

const request = async (path, { token = adminToken, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await pause(250);
  }
  assert.ok(ready, 'test Express API starts from the current server source');
  const login = await request('/auth/login', { token: '', method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(login.status, 200, 'Admin can authenticate');
  adminToken = login.data.token;

  const directoryResponse = await request('/state/customerDirectory');
  assert.equal(directoryResponse.status, 200);
  originalDirectory = directoryResponse.data.data || [];
  const quotationsResponse = await request('/state/quotationHistory');
  assert.equal(quotationsResponse.status, 200);
  originalQuotations = quotationsResponse.data.data || [];

  const linkedId = `qa-delete-linked-${Date.now()}`;
  const unlinkedId = `qa-delete-unlinked-${Date.now()}`;
  const linkedName = `QA delete protection ${Date.now()}`;
  const unlinkedName = `QA delete success ${Date.now()}`;
  const linked = { id: linkedId, companyName: linkedName, customerName: linkedName, createdAt: new Date().toISOString() };
  const unlinked = { id: unlinkedId, companyName: unlinkedName, customerName: unlinkedName, createdAt: new Date().toISOString() };
  const seedDirectory = await request('/state/customerDirectory', { method: 'PUT', body: JSON.stringify({ data: [...originalDirectory, linked, unlinked] }) });
  assert.equal(seedDirectory.status, 200, `test customers seeded: ${seedDirectory.data.error || ''}`);
  directoryFixtureWritten = true;

  const transactionFixture = { id: `qa-delete-quotation-${Date.now()}`, quotationNumber: `QA-DELETE-${Date.now()}`, company: linkedName };
  const seedTransaction = await request('/state/quotationHistory', { method: 'PUT', body: JSON.stringify({ data: [...originalQuotations, transactionFixture] }) });
  assert.equal(seedTransaction.status, 200, `linked transaction fixture seeded: ${seedTransaction.data.error || ''}`);
  quotationFixtureWritten = true;

  const deniedToken = await (async () => {
    const employees = await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'");
    const employee = (employees.rows[0]?.data || []).find((entry) => entry?.active !== false && entry?.email && entry?.password && String(entry.roleKey || '').toLowerCase() !== 'admin' && String(entry.role || '').toLowerCase() !== 'administrator');
    assert.ok(employee, 'a non-Admin account is available for authorization testing');
    const response = await request('/auth/login', { token: '', method: 'POST', body: JSON.stringify({ email: employee.email, password: employee.password, portal: 'employee' }) });
    assert.equal(response.status, 200, 'employee can authenticate');
    return response.data.token;
  })();
  const nonAdminDelete = await request(`/state/customerDirectory/${unlinkedId}`, { token: deniedToken, method: 'DELETE' });
  assert.equal(nonAdminDelete.status, 403, 'non-Admin cannot delete a customer through the backend API');

  const linkedDelete = await request(`/state/customerDirectory/${linkedId}`, { method: 'DELETE' });
  assert.equal(linkedDelete.status, 409, 'customer with quotation history cannot be deleted');
  assert.match(linkedDelete.data.error, /history|referenced|deactivate/i);
  const linkedStillThere = await request('/state/customerDirectory');
  assert.ok(linkedStillThere.data.data.some((record) => record.id === linkedId), 'linked customer remains after rejection');

  const deleteResult = await request(`/state/customerDirectory/${unlinkedId}`, { method: 'DELETE' });
  assert.equal(deleteResult.status, 200, `Admin can delete an unlinked customer by ID: ${deleteResult.data.error || ''}`);
  const afterDelete = await request('/state/customerDirectory');
  assert.ok(!afterDelete.data.data.some((record) => record.id === unlinkedId), 'deleted customer is absent from the PostgreSQL-backed directory');
  const repeatDelete = await request(`/state/customerDirectory/${unlinkedId}`, { method: 'DELETE' });
  assert.equal(repeatDelete.status, 404, 'a repeated delete cannot remove another record');
  console.log('Customer delete API checks passed: Admin authorization, transaction protection, ID-based persistence, and repeated-delete safety.');
} finally {
  if (adminToken && quotationFixtureWritten && originalQuotations) {
    await request('/state/quotationHistory', { method: 'PUT', body: JSON.stringify({ data: originalQuotations, reasons: { quotationHistory: 'Restore temporary customer deletion test fixture.' } }) }).catch(() => {});
  }
  if (adminToken && directoryFixtureWritten && originalDirectory) {
    await request('/state/customerDirectory', { method: 'PUT', body: JSON.stringify({ data: originalDirectory, reasons: { customerDirectory: 'Restore temporary customer deletion test fixture.' } }) }).catch(() => {});
  }
  server.kill();
  await closeDatabase().catch(() => {});
}
