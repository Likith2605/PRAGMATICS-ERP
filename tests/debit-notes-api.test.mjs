/** Isolated PostgreSQL API integration test for Debit Notes (Phase 3). */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
const dbName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
if (dbName !== 'vyavastha_test') throw new Error('Refusing Debit Note tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ERP_DEBIT_NOTE_TEST_PORT || 3394);
const base = `http://127.0.0.1:${port}`;
const harness = `
import express from 'express';
import { checkDatabase } from './server/database.js';
import { authRouter } from './server/auth.js';
import debitNoteRoutes from './server/debitNoteRoutes.js';
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/auth', authRouter);
app.get('/api/health', async (_req, res) => {
  try { await checkDatabase(); res.json({ ready: true }); }
  catch (error) { res.status(500).json({ ready: false, error: error.message }); }
});
app.use('/api/debit-notes', debitNoteRoutes);
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500)
    .json({ error: Number(error.status) >= 400 ? error.message : 'Internal server error' });
});
app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('debit-note-test-server-ready'));
`;

let child;
let childStderr = '';
let childStdout = '';
let token = '';
let assertions = 0;
const assert = (ok, label) => {
  if (!ok) throw new Error(label);
  assertions += 1;
  console.log(`PASS ${label}`);
};
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  childStderr = '';
  childStdout = '';
  child = spawn(process.execPath, ['--input-type=module', '-e', harness], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { childStdout += String(chunk); });
  child.stderr.on('data', (chunk) => { childStderr += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Isolated Debit Note server did not become ready.${childStderr ? ` stderr: ${childStderr}` : ''}`);
};
const stop = async () => {
  if (!child) return;
  const exiting = child;
  child = null;
  if (exiting.exitCode === null && exiting.signalCode === null) {
    exiting.kill();
    await new Promise((resolve) => {
      exiting.once('exit', resolve);
      // A child that exits between kill() and listener attachment still resolves.
      if (exiting.exitCode !== null || exiting.signalCode !== null) resolve();
    });
  }
};
const login = async () => (await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' })
}, '')).body.token;

const addModule = (storageKey, recordId, data) => pool.query(
  'INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES($1,$2,$3::jsonb,1,now(),$4)',
  [storageKey, recordId, JSON.stringify(data), 'debit-notes-integration-test']
);

const createdNumbers = new Set();
const fixtureIds = [];
const today = new Date().toISOString().slice(0, 10);
const tag = randomUUID().slice(0, 8);

const makeFixture = async (suffix) => {
  const poNumber = `PO-DBN-${suffix}`;
  const arrivalNumber = `ARR-DBN-${suffix}`;
  const qcNumber = `QC-DBN-${suffix}`;
  const rejectionNumber = `RRN-DBN-${suffix}`;
  const poId = `DBNPO-${suffix}`;
  const arrivalId = `DBNARR-${suffix}`;
  const rejectionId = `DBNRRN-${suffix}`;
  fixtureIds.push(['supplierPOHistory', poId], ['materialArrivals', arrivalId], ['rejectionReports', rejectionId]);
  const po = {
    poNumber,
    date: today,
    poDate: today,
    status: 'Ordered',
    items: [{ itemCode: `RAW-${suffix}`, itemName: `Test Steel ${suffix}`, unit: 'Nos', unitPrice: 50, gst: 18 }],
    vendorDetails: { vendorName: 'Isolated Debit Vendor', companyName: 'Isolated Debit Vendor', gstNumber: 'GSTIN-TEST', address: 'Test address' }
  };
  const arrival = { arrivalNumber, poNumber, vendor: 'Isolated Debit Vendor', vendorGstNumber: 'GSTIN-TEST', arrivedDate: today };
  const rejection = {
    rejectionNumber,
    rejectionDate: today,
    poNumber,
    arrivalNumber,
    qcNumber,
    vendor: 'Isolated Debit Vendor',
    qualityRemarks: 'Rejected by isolated integration test',
    items: [{ materialCode: `RAW-${suffix}`, materialName: `Test Steel ${suffix}`, unit: 'Nos', rejectedQty: 3, reason: 'Bent' }]
  };
  await addModule('supplierPOHistory', poId, po);
  await addModule('materialArrivals', arrivalId, arrival);
  await addModule('rejectionReports', rejectionId, rejection);
  return { suffix, poNumber, arrivalNumber, qcNumber, rejectionNumber, rejection };
};

const payloadFor = (fixture, qty = 2, remarks = 'isolated integration test') => ({
  rejectionNumber: fixture.rejectionNumber,
  debitNoteDate: today,
  remarks,
  items: [{
    materialCode: `RAW-${fixture.suffix}`,
    materialName: `Test Steel ${fixture.suffix}`,
    debitQty: qty
  }]
});

let primaryNumber = '';
let cancelledNumber = '';
let legacyNumber = '';
try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates through the isolated server');

  const primary = await makeFixture(tag);
  const second = await makeFixture(`${tag}B`);
  const third = await makeFixture(`${tag}C`);

  const createToken = randomUUID();
  const created = await api('/api/debit-notes', {
    method: 'POST',
    body: JSON.stringify({ data: payloadFor(primary), createToken })
  });
  primaryNumber = created.body.record?.debitNoteNumber || '';
  createdNumbers.add(primaryNumber);
  assert(created.status === 201 && Number(created.body.record.version) === 1, 'Create returns a PostgreSQL-confirmed Draft at version 1');
  assert(/^DN-\d{6}$/.test(primaryNumber), `Legacy DN-000001 numbering is preserved (${primaryNumber})`);
  assert(Number(created.body.record.grandTotal) === 118 && Number(created.body.record.subtotal) === 100, 'Amounts are recalculated from PO rate and GST, never from the client');
  assert(created.body.record.sourceStamp?.rejectionNumber === primary.rejectionNumber && created.body.record.sourceStamp?.poNumber === primary.poNumber, 'Create stamps the source records read from PostgreSQL');

  const retry = await api('/api/debit-notes', {
    method: 'POST',
    body: JSON.stringify({ data: payloadFor(primary), createToken })
  });
  assert(retry.status === 200 && retry.body.duplicate && retry.body.record.debitNoteNumber === primaryNumber, 'Idempotent retry returns the same note instead of creating a duplicate');
  const rowCount = await pool.query('SELECT count(*)::int AS n FROM debit_notes WHERE rejection_number=$1', [primary.rejectionNumber]);
  assert(rowCount.rows[0].n === 1, 'Exactly one Debit Note row exists after the retry');

  const list = await api('/api/debit-notes');
  assert(list.body.records.some((record) => record.debitNoteNumber === primaryNumber), 'List reads the persisted note from PostgreSQL');
  const detail = await api(`/api/debit-notes/${primaryNumber}`);
  assert(detail.status === 200 && detail.body.record.items[0].unitPrice === 50, 'Detail reads the priced line from PostgreSQL');
  const duplicate = await api('/api/debit-notes', {
    method: 'POST',
    body: JSON.stringify({ data: payloadFor(primary), createToken: randomUUID() })
  });
  assert(duplicate.status === 409, 'A second Debit Note claiming the same rejected quantity is rejected');

  const editA = await api(`/api/debit-notes/${primaryNumber}`, {
    method: 'PUT',
    body: JSON.stringify({ version: 1, data: { ...payloadFor(primary), remarks: 'edit A' } })
  });
  const editB = await api(`/api/debit-notes/${primaryNumber}`, {
    method: 'PUT',
    body: JSON.stringify({ version: 1, data: { ...payloadFor(primary), remarks: 'edit B' } })
  });
  assert([editA.status, editB.status].filter((status) => status === 200).length === 1 &&
    [editA.status, editB.status].filter((status) => status === 409).length === 1, 'Concurrent edits reject the stale version');
  const updatedRow = await pool.query('SELECT version::int AS version,remarks FROM debit_notes WHERE debit_note_number=$1', [primaryNumber]);
  assert(updatedRow.rows[0].version === 2, 'PostgreSQL contains exactly one winning update');

  /* Primary path (mirroring workflowService): Store submits straight to Admin
   * Approval; the legacy Requested → Purchase Review path remains available on
   * the API but is not the default transition. */
  const transitions = [
    ['submit', 'Admin Approval'],
    ['approve', 'Approved']
  ];
  let version = 2;
  for (const [route, expected] of transitions) {
    const response = await api(`/api/debit-notes/${primaryNumber}/${route}`, {
      method: 'POST',
      body: JSON.stringify({ version })
    });
    assert(response.status === 200 && response.body.record.status === expected, `${route} transitions the note to ${expected}`);
    version = Number(response.body.record.version);
  }

  const cancelled = await api('/api/debit-notes', {
    method: 'POST',
    body: JSON.stringify({ data: payloadFor(second), createToken: randomUUID() })
  });
  cancelledNumber = cancelled.body.record?.debitNoteNumber || '';
  createdNumbers.add(cancelledNumber);
  assert(cancelled.status === 201, 'A separate source transaction can create its own Debit Note');
  const cancel = await api(`/api/debit-notes/${cancelledNumber}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ version: 1, reason: 'isolated test cancellation' })
  });
  assert(cancel.status === 200 && cancel.body.record.status === 'Cancelled', 'Cancel is a persisted workflow transition');

  legacyNumber = `DN-LEGACY-${tag}`;
  createdNumbers.add(legacyNumber);
  const legacyData = {
    ...payloadFor(third),
    debitNoteNumber: legacyNumber,
    rejectionNumber: third.rejectionNumber,
    status: 'Draft'
  };
  const legacyId = `DBNLEG-${tag}`;
  fixtureIds.push(['debitNotes', legacyId]);
  await addModule('debitNotes', legacyId, legacyData);
  const preview = await api('/api/debit-notes/migration-preview');
  assert(preview.status === 200 && preview.body.eligible.some((entry) => entry.number === legacyNumber), 'Admin migration preview lists the unique legacy Debit Note');
  const imported = await api('/api/debit-notes/migration-preview/import-missing', {
    method: 'POST',
    body: JSON.stringify({ records: preview.body.eligible.filter((entry) => entry.number === legacyNumber) })
  });
  assert(imported.status === 200 && imported.body.imported.includes(legacyNumber) && imported.body.conflicts.length === 0, 'Selected legacy import commits with the original document number');
  const importedRow = await pool.query('SELECT version::int AS version,payload FROM debit_notes WHERE debit_note_number=$1', [legacyNumber]);
  assert(importedRow.rowCount === 1 && importedRow.rows[0].version === 1 && importedRow.rows[0].payload.migratedFrom === 'legacy', 'Imported note is stored in PostgreSQL with its legacy identity intact');
  const previewAgain = await api('/api/debit-notes/migration-preview');
  assert(previewAgain.body.existing.some((entry) => entry.number === legacyNumber), 'A second preview marks the imported legacy note as already imported');

  const audits = await pool.query(
    `SELECT DISTINCT action FROM debit_note_audit WHERE debit_note_number = ANY($1::text[]) ORDER BY action`,
    [[...createdNumbers]]
  );
  const actions = audits.rows.map((row) => row.action);
  assert(['CREATE', 'UPDATE', 'SUBMIT', 'APPROVE', 'CANCEL', 'IMPORT'].every((action) => actions.includes(action)), 'Every create, edit, workflow transition and import writes an audit row');

  const softDelete = await api(`/api/debit-notes/${cancelledNumber}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: 2, reason: 'isolated test cleanup' })
  });
  assert(softDelete.status === 200, 'Admin soft-delete is confirmed through the API');
  const deletedRow = await pool.query('SELECT deleted_at,deleted_by,delete_reason FROM debit_notes WHERE debit_note_number=$1', [cancelledNumber]);
  assert(Boolean(deletedRow.rows[0].deleted_at) && deletedRow.rows[0].delete_reason === 'isolated test cleanup', 'Soft-delete metadata remains in PostgreSQL');

  const restore = await api(`/api/debit-notes/${cancelledNumber}/restore`, {
    method: 'POST',
    body: JSON.stringify({ version: 3, reason: 'isolated test restore' })
  });
  assert(restore.status === 200 && restore.body.record.status === 'Cancelled', 'Admin restore returns the soft-deleted Debit Note with audit');


  console.log(`Debit Note PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`Debit Note integration failed after ${assertions}: ${error.stack || error.message}`);
  if (childStderr.trim()) console.error(`Isolated server stderr: ${childStderr}`);
  if (childStdout.trim()) console.error(`Isolated server stdout: ${childStdout}`);
  process.exitCode = 1;
} finally {
  /* Remove only fixtures created by this run; legacy data is never deleted. */
  if (createdNumbers.size) {
    await pool.query('DELETE FROM debit_note_items WHERE debit_note_number = ANY($1::text[])', [[...createdNumbers]]);
    await pool.query('DELETE FROM debit_note_audit WHERE debit_note_number = ANY($1::text[])', [[...createdNumbers]]);
    await pool.query('DELETE FROM debit_notes WHERE debit_note_number = ANY($1::text[])', [[...createdNumbers]]);
  }
  for (const [storageKey, recordId] of fixtureIds) {
    await pool.query('DELETE FROM module_records WHERE storage_key=$1 AND record_id=$2', [storageKey, recordId]);
  }
  await stop();
  await pool.end();
}
