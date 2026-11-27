/** Isolated PostgreSQL integration test for quotations. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing to use DATABASE_URL.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required in the test process environment.');
const parsed = new URL(databaseUrl);
if (decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== 'vyavastha_test') throw new Error('Refusing to run quotation tests outside vyavastha_test.');
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing quotation test writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_QUOTATION_TEST_PORT || 3381);
const base = `http://127.0.0.1:${port}`;
let child;
let token;
let assertions = 0;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
};
const api = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const start = async () => {
  const childEnv = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete childEnv.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env: childEnv, stdio: 'ignore' });
  for (let i = 0; i < 100; i += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((item) => item.version === '016_quotation_records')) return;
    } catch { /* server starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated quotation test server did not become ready.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};

try {
  await start();
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert(login.status === 200 && login.body.token, 'Admin authentication succeeds on isolated test server');
  token = login.body.token;

  const number = await api('/api/quotations/next-number', { method: 'POST', body: '{}' });
  assert(number.status === 200 && /^QT\d{6,}$/.test(number.body.quotationNumber), 'Database reserves a quotation number in the existing QTYYYY sequence format');
  const quotationNumber = number.body.quotationNumber;
  const createToken = randomUUID();
  const payload = {
    companyDetails: { companyName: 'Test Company' },
    customerDetails: { customerName: 'Isolated Test Customer', companyName: 'Test Company' },
    quotationDetails: { quotationNumber, quotationDate: new Date().toISOString().slice(0, 10), currency: 'INR', exchangeRate: 1, projectId: 'QTEST' },
    items: [{ itemName: 'Test item', quantity: 2, unitPrice: 10, amount: 20 }],
    totals: { grandTotal: 20 }
  };
  const created = await api('/api/quotations', { method: 'POST', body: JSON.stringify({ data: payload, createToken }) });
  assert(created.status === 201 && created.body.record.version === 1, 'Create returns database-confirmed quotation version 1');
  const duplicate = await api('/api/quotations', { method: 'POST', body: JSON.stringify({ data: payload, createToken }) });
  assert(duplicate.status === 200 && duplicate.body.duplicate, 'Retry with the same idempotency token returns the existing quotation');

  const list = await api('/api/quotations');
  assert(list.status === 200 && list.body.records.some((item) => item.reference === quotationNumber), 'List and refresh read the quotation from PostgreSQL');
  const detail = await api(`/api/quotations/${encodeURIComponent(quotationNumber)}`);
  assert(detail.status === 200 && detail.body.record.payload.items[0].itemName === 'Test item', 'Detail read returns persisted payload and items');

  const updateA = { ...payload, quotationDetails: { ...payload.quotationDetails, notes: 'Concurrent A' } };
  const updateB = { ...payload, quotationDetails: { ...payload.quotationDetails, notes: 'Concurrent B' } };
  const concurrent = await Promise.all([
    api(`/api/quotations/${encodeURIComponent(quotationNumber)}`, { method: 'PUT', body: JSON.stringify({ data: updateA, version: 1 }) }),
    api(`/api/quotations/${encodeURIComponent(quotationNumber)}`, { method: 'PUT', body: JSON.stringify({ data: updateB, version: 1 }) })
  ]);
  assert(concurrent.filter((item) => item.status === 200).length === 1 && concurrent.filter((item) => item.status === 409).length === 1, 'Concurrent edits allow one versioned update and reject the stale update');
  const stale = await api(`/api/quotations/${encodeURIComponent(quotationNumber)}`, { method: 'PUT', body: JSON.stringify({ data: payload, version: 1 }) });
  assert(stale.status === 409, 'Stale-version update is rejected');

  const persisted = await pool.query('SELECT version,deleted_at,payload FROM quotations WHERE quotation_number=$1', [quotationNumber]);
  assert(persisted.rowCount === 1 && Number(persisted.rows[0].version) === 2 && persisted.rows[0].payload.quotationDetails.notes?.startsWith('Concurrent'), 'Actual PostgreSQL row contains the winning concurrent edit');
  const deleted = await api(`/api/quotations/${encodeURIComponent(quotationNumber)}`, { method: 'DELETE', body: JSON.stringify({ version: 2, reason: 'Automated isolated API test' }) });
  assert(deleted.status === 200, 'Admin deletion is confirmed by the API');
  const tombstone = await pool.query('SELECT deleted_at,deleted_by,delete_reason FROM quotations WHERE quotation_number=$1', [quotationNumber]);
  assert(tombstone.rowCount === 1 && tombstone.rows[0].deleted_at && tombstone.rows[0].deleted_by, 'Delete is durable soft deletion with actor and reason in PostgreSQL');
  const audits = await pool.query("SELECT action FROM erp_audit_log WHERE module='quotations' AND record_id=$1 ORDER BY id", [quotationNumber]);
  assert(audits.rows.some((row) => row.action === 'CREATE') && audits.rows.some((row) => row.action === 'UPDATE') && audits.rows.some((row) => row.action === 'SOFT_DELETE'), 'Create, update, and deletion audit rows are preserved');
  assert((await api(`/api/quotations/${encodeURIComponent(quotationNumber)}`)).status === 404, 'Deleted quotation is absent from authoritative active detail reads');

  await stop();
  await start();
  const afterRestart = await api(`/api/quotations/${encodeURIComponent(quotationNumber)}`);
  assert(afterRestart.status === 404, 'Deleted state remains authoritative after server restart');
  const reused = await api('/api/quotations', { method: 'POST', body: JSON.stringify({ data: payload, createToken: randomUUID() }) });
  assert(reused.status === 409, 'Deleted quotation number cannot be recreated after restart');
  console.log(`Quotation PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`Quotation PostgreSQL integration failed after ${assertions} assertions: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await stop();
  await pool.end();
}
