/** Isolated PostgreSQL API integration test for routing operations and entries. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing Routing tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_ROUTING_TEST_PORT || 3393);
const base = `http://127.0.0.1:${port}`;
let child;
let token = '';
let assertions = 0;
const assert = (ok, label, detail = '') => {
  if (!ok) throw new Error(detail ? `${label}: ${detail}` : label);
  assertions += 1;
  console.log(`PASS ${label}`);
};
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
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
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let n = 0; n < 100; n += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((m) => m.version === '040_production_gaps')) return;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Routing server did not become ready.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const login = async () => (await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.ERP_ADMIN_EMAIL,
    password: process.env.ERP_ADMIN_PASSWORD,
    portal: 'admin'
  })
}, '')).body.token;

let jobCardNumber = '';
const today = new Date().toISOString().slice(0, 10);
const getCard = async () => (await api(`/api/production/job-cards/${jobCardNumber}`)).body.record;

try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');

  const created = await api('/api/production/job-cards', {
    method: 'POST',
    body: JSON.stringify({
      createToken: randomUUID(),
      data: {
        jobCardDate: today,
        projectId: 'ROUTING-TEST-PROJ',
        soNumber: 'SO-ROUTING-TEST',
        customerName: 'Isolated Test Customer',
        partCode: `ROUTE-${randomUUID().slice(0, 8)}`,
        partName: 'Routing integration component',
        orderQuantity: 20,
        processes: [],
        qualityControl: { finalQC: { disposition: 'Pass', acceptedQty: 8, reworkQty: 0, scrapQty: 0 } }
      }
    })
  });
  assert(created.status === 201 && /^JC-\d{6}-\d{3}$/.test(created.body.record.jobCardNumber),
    'Routing fixture Job Card created', JSON.stringify(created));
  jobCardNumber = created.body.record.jobCardNumber;

  let card = await getCard();
  const unauthenticated = await api(`/api/routing/job-cards/${jobCardNumber}/operations`, {}, '');
  assert([401, 403].includes(unauthenticated.status), 'Operation list requires authentication');

  const first = await api(`/api/routing/job-cards/${jobCardNumber}/operations`, {
    method: 'POST',
    body: JSON.stringify({
      version: card.version,
      operation: {
        process: 'Turning', status: 'Pending', plannedHours: 2, plannedQty: 10,
        machineId: 'M-ROUTE-1', machineName: 'CNC-1', operatorId: 'E-ROUTE-1', operatorName: 'Operator One', required: true
      }
    })
  });
  assert(first.status === 201 && first.body.operation.sequenceNumber === 1 &&
    first.body.operation.operationName === 'Turning' && first.body.operation.status === 'Pending' &&
    first.body.operation.machineId === 'M-ROUTE-1' && first.body.operation.plannedQty === 10,
  'Operation is normalized, assigned the next sequence and stored in PostgreSQL', JSON.stringify(first));

  const stale = await api(`/api/routing/job-cards/${jobCardNumber}/operations`, {
    method: 'POST', body: JSON.stringify({ version: 1, operation: { operationName: 'Stale' } })
  });
  assert(stale.status === 409, 'Adding an operation with a stale Job Card version is rejected');

  card = await getCard();
  const second = await api(`/api/routing/job-cards/${jobCardNumber}/operations`, {
    method: 'POST',
    body: JSON.stringify({
      version: card.version,
      operation: { operationName: 'Grinding', plannedHours: 1.5, plannedQty: 10, required: true }
    })
  });
  assert(second.status === 201 && second.body.operation.sequenceNumber === 2,
    'A second operation receives sequence number 2');

  const invalidHours = await api(`/api/routing/job-cards/${jobCardNumber}/operations`, {
    method: 'POST', body: JSON.stringify({ version: 1, operation: { operationName: 'Bad', plannedHours: -1 } })
  });
  assert(invalidHours.status === 409, 'Stale version is checked before operation validation');

  const list = await api(`/api/routing/job-cards/${jobCardNumber}/operations`);
  assert(list.body.operations.length === 2 && list.body.operations[0].sequenceNumber === 1 &&
    list.body.operations[1].sequenceNumber === 2,
  'Operation list returns both PostgreSQL rows in sequence order');

  card = await getCard();
  const started = await api(`/api/routing/operations/${first.body.operation.id}/start`, {
    method: 'POST', body: JSON.stringify({ version: card.version, employeeId: 'E-ROUTE-2', employeeName: 'Operator Two' })
  });
  assert(started.status === 200 && started.body.operation.status === 'In Progress' &&
    Boolean(started.body.operation.startedAt) && started.body.operation.operatorId === 'E-ROUTE-2',
  'Starting an operation records its status, timestamp and operator');

  card = await getCard();
  const completedOperation = await api(`/api/routing/operations/${first.body.operation.id}/complete`, {
    method: 'POST', body: JSON.stringify({ version: card.version, actualHours: 1.25, outputQty: 8 })
  });
  assert(completedOperation.status === 200 && completedOperation.body.operation.status === 'Completed' &&
    completedOperation.body.operation.actualHours === 1.25 && completedOperation.body.operation.outputQty === 8 &&
    Boolean(completedOperation.body.operation.completedAt),
  'Completing an operation records hours, output and completion timestamp');

  const blockedCompletion = await api(`/api/production/job-cards/${jobCardNumber}/complete`, {
    method: 'POST', body: JSON.stringify({ version: (await getCard()).version })
  });
  assert(blockedCompletion.status === 400 &&
    String(blockedCompletion.body.error).includes('Grinding'),
  'Job Card completion is blocked while a required routing operation is pending');

  card = await getCard();
  const invalidEntry = await api(`/api/routing/operations/${first.body.operation.id}/entries`, {
    method: 'POST', body: JSON.stringify({
      version: card.version,
      entry: { entryDate: today, plannedQty: 10, producedQty: 7, acceptedQty: 7, rejectedQty: 1 }
    })
  });
  assert(invalidEntry.status === 400, 'Entry rejects accepted plus rejected quantity above produced quantity');

  const negativeEntry = await api(`/api/routing/operations/${first.body.operation.id}/entries`, {
    method: 'POST', body: JSON.stringify({
      version: card.version,
      entry: { entryDate: today, plannedQty: -1, producedQty: 7 }
    })
  });
  assert(negativeEntry.status === 400, 'Entry rejects negative planned quantity');

  const entry = await api(`/api/routing/operations/${first.body.operation.id}/entries`, {
    method: 'POST', body: JSON.stringify({
      version: card.version,
      entry: {
        entryDate: today,
        plannedQty: 10,
        producedQty: 8,
        acceptedQty: 7,
        rejectedQty: 1,
        reworkQty: 0,
        employeeId: 'E-ROUTE-1',
        employeeName: 'Operator One',
        machineId: 'M-ROUTE-1',
        machineName: 'CNC-1',
        remarks: 'routing test entry'
      }
    })
  });
  assert(entry.status === 201 && Number(entry.body.entry.accepted_qty) === 7 &&
    Number(entry.body.entry.rejected_qty) === 1 &&
    Number(entry.body.entry.operation_id) === Number(first.body.operation.id),
  'Valid entry is stored with planned, produced, accepted and rejected quantities', JSON.stringify(entry));

  card = await getCard();
  assert(Number(card.producedQuantity) === 8 && Number(card.acceptedQuantity) === 7 &&
    Number(card.rejectedQuantity) === 1,
  'Job Card totals are updated from the authoritative operation entry');

  const operationEntries = await api(`/api/routing/operations/${first.body.operation.id}/entries`);
  assert(operationEntries.body.entries.length === 1, 'Operation entries endpoint returns the persisted entry');
  const cardEntries = await api(`/api/routing/job-cards/${jobCardNumber}/entries`);
  assert(cardEntries.body.entries.length === 1 &&
    Number(cardEntries.body.entries[0].id) === Number(entry.body.entry.id) &&
    Number(cardEntries.body.entries[0].accepted_qty) === 7,
  'Job Card entries endpoint returns the same entry', JSON.stringify(cardEntries.body.entries));
  const legacyEntries = await pool.query(
    'SELECT produced_qty,accepted_qty,rejected_qty,rework_qty,employee_id,machine_id,planned_qty FROM production_entries WHERE job_card_number=$1',
    [jobCardNumber]
  );
  assert(legacyEntries.rowCount === 1 && Number(legacyEntries.rows[0].produced_qty) === 8 &&
    Number(legacyEntries.rows[0].accepted_qty) === 7 && Number(legacyEntries.rows[0].rejected_qty) === 1 &&
    Number(legacyEntries.rows[0].planned_qty) === 10 && legacyEntries.rows[0].employee_id === 'E-ROUTE-1' &&
    legacyEntries.rows[0].machine_id === 'M-ROUTE-1',
  'Legacy production entry projection keeps quantities and assignments in step');

  const deleteWithEntries = await api(`/api/routing/operations/${first.body.operation.id}`, {
    method: 'DELETE', body: JSON.stringify({ version: card.version })
  });
  assert(deleteWithEntries.status === 409, 'An operation with recorded entries cannot be deleted');

  card = await getCard();
  const finishSecond = await api(`/api/routing/operations/${second.body.operation.id}/complete`, {
    method: 'POST', body: JSON.stringify({ version: card.version, actualHours: 1, outputQty: 8 })
  });
  assert(finishSecond.status === 200 && finishSecond.body.operation.status === 'Completed',
    'Final required routing operation completes');

  const completion = await api(`/api/production/job-cards/${jobCardNumber}/complete`, {
    method: 'POST', body: JSON.stringify({ version: (await getCard()).version })
  });
  assert(completion.status === 200 && completion.body.record.status === 'Completed',
    'Job Card completes once all required routing operations and final QC pass', JSON.stringify(completion));

  const audit = await api(`/api/routing/job-cards/${jobCardNumber}/audit`);
  const actions = audit.body.entries.map((entry) => entry.action);
  assert(['OPERATION_ADDED', 'OPERATION_UPDATED', 'PRODUCTION_ENTRY']
    .every((action) => actions.includes(action)),
  'Routing changes and entries are recorded in the Job Card audit table');
  const staleAfterComplete = await api(`/api/routing/operations/${second.body.operation.id}/complete`, {
    method: 'POST', body: JSON.stringify({ version: 1 })
  });
  assert(staleAfterComplete.status === 409, 'Stale routing updates remain rejected after completion');
  console.log(`Routing PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`Routing integration failed after ${assertions}: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (jobCardNumber) {
      await pool.query('DELETE FROM production_operation_entries WHERE job_card_number=$1', [jobCardNumber]);
      await pool.query('DELETE FROM production_entries WHERE job_card_number=$1', [jobCardNumber]);
      await pool.query('DELETE FROM job_card_operations WHERE job_card_number=$1', [jobCardNumber]);
      await pool.query('DELETE FROM job_card_items WHERE job_card_number=$1', [jobCardNumber]);
      await pool.query('DELETE FROM job_card_audit WHERE job_card_number=$1', [jobCardNumber]);
      await pool.query('DELETE FROM job_cards WHERE job_card_number=$1', [jobCardNumber]);
      await pool.query("DELETE FROM erp_audit_log WHERE record_id=$1 AND module='job_cards'", [jobCardNumber]);
    }
  } catch (cleanupError) {
    console.error(`Routing fixture cleanup warning: ${cleanupError.message}`);
    process.exitCode = 1;
  }
  await stop();
  await pool.end();
}
