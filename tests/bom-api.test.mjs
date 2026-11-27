/** Isolated PostgreSQL API integration test for BOM versioning and migration. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing BOM tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_BOM_TEST_PORT || 3392);
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
  throw new Error('Isolated BOM server did not become ready.');
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

let bomNumber = '';
let revisedBomNumber = '';
let concurrentBomNumber = '';
let legacyA = '';
let legacyB = '';
let legacyStateBefore;
const partCode = `BOMTEST-${randomUUID().slice(0, 8)}`;
const partName = `Isolated BOM part ${partCode}`;

const payload = (version, quantity, effectiveDate) => ({
  version,
  partCode,
  partName,
  drawingNumber: partCode,
  projectId: 'BOM-TEST-PROJ',
  customerName: 'Isolated Test Customer',
  effectiveDate,
  items: [{ materialId: `MAT-${partCode}`, materialName: partName, requiredQty: quantity, unit: 'Nos' }]
});

try {
  await start();
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');

  const createToken = randomUUID();
  const created = await api('/api/bom', {
    method: 'POST', body: JSON.stringify({ data: payload(1, 2, '2026-01-10'), createToken })
  });
  assert(created.status === 201 && Number(created.body.record.version) === 1 &&
    /^BOM-\d+$/.test(created.body.record.bomNumber),
  'Create returns a PostgreSQL-confirmed BOM with legacy BOM-<epoch> numbering', JSON.stringify(created));
  bomNumber = created.body.record.bomNumber;
  const retry = await api('/api/bom', {
    method: 'POST', body: JSON.stringify({ data: payload(1, 2, '2026-01-10'), createToken })
  });
  assert(retry.status === 200 && retry.body.duplicate, 'Create retry is idempotent');

  const list = await api(`/api/bom?partCode=${encodeURIComponent(partCode)}`);
  assert(list.body.records.length === 1 && list.body.records[0].bomNumber === bomNumber,
    'List reads the persisted BOM');
  const detail = await api(`/api/bom/${bomNumber}`);
  assert(detail.status === 200 && Number(detail.body.record.items[0].requiredQty) === 2,
    'Detail reads BOM lines from PostgreSQL');

  const early = await api(`/api/bom/effective?partCode=${encodeURIComponent(partCode)}&date=2026-01-15`);
  assert(early.status === 200 && early.body.record.bomNumber === bomNumber,
    'Effective lookup resolves the version active on the requested date');

  const revised = await api(`/api/bom/${bomNumber}`, {
    method: 'PUT', body: JSON.stringify({ version: 1, data: payload(2, 9, '2026-02-10') })
  });
  assert(revised.status === 200 && Number(revised.body.record.version) === 2 &&
    revised.body.supersedes === bomNumber && revised.body.record.bomNumber !== bomNumber,
  'Editing creates a new BOM number at version 2 and supersedes the original', JSON.stringify(revised));
  revisedBomNumber = revised.body.record.bomNumber;

  const oldRow = await pool.query('SELECT status,version FROM bom_headers WHERE bom_number=$1', [bomNumber]);
  const newRow = await pool.query('SELECT status,version FROM bom_headers WHERE bom_number=$1', [revisedBomNumber]);
  assert(oldRow.rows[0].status === 'Superseded' && Number(oldRow.rows[0].version) === 2 &&
    newRow.rows[0].status === 'Active' && Number(newRow.rows[0].version) === 2,
  'Only the newest BOM is Active and the old version is preserved with an advanced version');

  const beforeRevision = await api(`/api/bom/effective?partCode=${encodeURIComponent(partCode)}&date=2026-01-15`);
  const afterRevision = await api(`/api/bom/effective?partCode=${encodeURIComponent(partCode)}&date=2026-02-15`);
  assert(beforeRevision.body.record.bomNumber === bomNumber &&
    Number(beforeRevision.body.record.items[0].requiredQty) === 2 &&
    afterRevision.body.record.bomNumber === revisedBomNumber &&
    Number(afterRevision.body.record.items[0].requiredQty) === 9,
  'Effective-date lookups still resolve older superseded versions for earlier dates');

  const staleEdit = await api(`/api/bom/${bomNumber}`, {
    method: 'PUT', body: JSON.stringify({ version: 1, data: payload(3, 5, '2026-03-10') })
  });
  assert([409, 404].includes(staleEdit.status), 'Stale BOM version is rejected');

  const concurrentBase = await api('/api/bom', {
    method: 'POST', body: JSON.stringify({ data: payload(1, 1, '2026-01-10'), createToken: randomUUID() })
  });
  assert(concurrentBase.status === 201, 'Concurrent-edit fixture created');
  const concurrentNumber = concurrentBase.body.record.bomNumber;
  const edits = await Promise.all(['A', 'B'].map((tag) => api(`/api/bom/${concurrentNumber}`, {
    method: 'PUT', body: JSON.stringify({
      version: 1,
      data: { ...payload(2, tag === 'A' ? 3 : 4, '2026-02-10'), remarks: tag }
    })
  })));
  assert(edits.filter((r) => r.status === 200).length === 1 &&
    edits.filter((r) => r.status === 409).length === 1,
  'Concurrent BOM edits produce exactly one winner and one stale-version rejection', JSON.stringify(edits.map((r) => r.status)));
  concurrentBomNumber = edits.find((r) => r.status === 200)?.body.record.bomNumber || '';

  const unauthenticatedPreview = await api('/api/bom/migration-preview', {}, '');
  assert([401, 403].includes(unauthenticatedPreview.status), 'Migration preview requires authentication');

  legacyA = `BOM-LEGACY-${randomUUID()}`;
  legacyB = `BOM-LEGACY-${randomUUID()}`;
  const stateResult = await pool.query("SELECT data FROM erp_state WHERE storage_key='bomMasterList'");
  legacyStateBefore = stateResult.rows[0]?.data ?? null;
  const legacyList = Array.isArray(legacyStateBefore) ? legacyStateBefore : [];
  await pool.query(
    `INSERT INTO erp_state(storage_key,data,updated_at) VALUES('bomMasterList',$1::jsonb,now())
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([
      ...legacyList,
      { id: legacyA, bomNumber: legacyA, version: 1, ...payload(1, 7, '2026-01-10') },
      { id: legacyB, bomNumber: legacyB, version: 1, ...payload(1, 8, '2026-01-10') }
    ])]
  );
  const preview = await api('/api/bom/migration-preview');
  assert(preview.status === 200 && preview.body.eligible.some((r) => r.number === legacyA) &&
    preview.body.eligible.some((r) => r.number === legacyB),
  'Admin preview lists only the new legacy fixtures as eligible', JSON.stringify(preview.body.counts));

  const imported = await api('/api/bom/migration-preview/import-missing', {
    method: 'POST',
    body: JSON.stringify({ records: [preview.body.eligible.find((r) => r.number === legacyA).payload] })
  });
  assert(imported.status === 200 && imported.body.imported.includes(legacyA) &&
    !imported.body.imported.includes(legacyB),
  'Selected legacy import commits only the explicitly chosen record', JSON.stringify(imported.body));
  const unimported = await pool.query('SELECT 1 FROM bom_headers WHERE bom_number=$1', [legacyB]);
  assert(unimported.rowCount === 0, 'Unselected legacy fixture is not imported');
  const importAudit = await pool.query("SELECT action FROM bom_audit WHERE bom_number=$1 AND action='IMPORT'", [legacyA]);
  assert(importAudit.rowCount === 1, 'Selected import is recorded in the BOM audit table');

  const deleted = await api(`/api/bom/${revisedBomNumber}`, {
    method: 'DELETE', body: JSON.stringify({ version: 2, reason: 'isolated BOM test cleanup' })
  });
  assert(deleted.status === 200, 'Admin soft-deletes the active BOM');
  const deletedRow = await pool.query(
    'SELECT deleted_at,deleted_by,delete_reason FROM bom_headers WHERE bom_number=$1', [revisedBomNumber]
  );
  assert(Boolean(deletedRow.rows[0].deleted_at) && Boolean(deletedRow.rows[0].deleted_by) &&
    deletedRow.rows[0].delete_reason === 'isolated BOM test cleanup',
  'Deletion metadata is retained in PostgreSQL');
  const restored = await api(`/api/bom/${revisedBomNumber}/restore`, {
    method: 'POST', body: JSON.stringify({ reason: 'isolated BOM restore verification' })
  });
  assert(restored.status === 200 && restored.body.record.status === 'Active',
    'Admin restores the soft-deleted BOM with audit metadata');
  const bomAudit = await pool.query('SELECT action FROM bom_audit WHERE bom_number=$1', [bomNumber]);
  assert(['CREATE', 'SUPERSEDE'].every((action) => bomAudit.rows.some((r) => r.action === action)),
    'Create and supersede audit records are retained');
  console.log(`BOM PostgreSQL integration: ${assertions} passed, 0 failed.`);
} catch (error) {
  console.error(`BOM integration failed after ${assertions}: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  const numbers = [bomNumber, revisedBomNumber, concurrentBomNumber, legacyA, legacyB].filter(Boolean);
  try {
    if (numbers.length) {
      await pool.query('DELETE FROM bom_items WHERE bom_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM bom_audit WHERE bom_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM job_card_items WHERE bom_number = ANY($1)', [numbers]);
      await pool.query('DELETE FROM bom_headers WHERE bom_number = ANY($1)', [numbers]);
      await pool.query("DELETE FROM erp_audit_log WHERE record_id = ANY($1) AND module='bom'", [numbers]);
    }
    if (legacyStateBefore === null) await pool.query("DELETE FROM erp_state WHERE storage_key='bomMasterList'");
    else if (legacyStateBefore !== undefined) {
      await pool.query('UPDATE erp_state SET data=$1::jsonb,updated_at=now() WHERE storage_key=$2',
        [JSON.stringify(legacyStateBefore), 'bomMasterList']);
    }
  } catch (cleanupError) {
    console.error(`BOM fixture cleanup warning: ${cleanupError.message}`);
    process.exitCode = 1;
  }
  await stop();
  await pool.end();
}
