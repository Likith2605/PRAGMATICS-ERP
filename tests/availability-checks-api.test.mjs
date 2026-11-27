/** Guarded PostgreSQL integration test for durable Sales Order availability checks. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing availability-check tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_AVAILABILITY_TEST_PORT || 3397);
const base = `http://127.0.0.1:${port}`;
let child;
let token = '';
let employeeToken = '';
let employeeFixtureCreated = false;
let employeeCreateToken = '';
let originalLegacy = null;
let legacyFixtureWritten = false;
let assertions = 0;
const suffix = randomUUID().slice(0, 10);
const soNumber = `SO-AV-${suffix}`;
const legacySoNumber = `SO-AV-LEGACY-${suffix}`;
const itemCode = `AV-MAT-${suffix}`;
const legacyItemCode = `AV-LEG-MAT-${suffix}`;
const employeeEmail = `availability-test-${suffix}@example.test`;
const employeePassword = `Av-${suffix}-Pass!`;
const employeeId = `availability-employee-${suffix}`;
const assert = (ok, label) => {
  if (!ok) throw new Error(label);
  assertions += 1;
  console.log(`PASS ${label}`);
};
const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((migration) => migration.version === '048_employee_master')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated availability-check server did not become ready with migration 046.');
};
const loginAdmin = async () => {
  const response = await api('/api/auth/login', json('POST', {
    email: process.env.ERP_ADMIN_EMAIL,
    password: process.env.ERP_ADMIN_PASSWORD,
    portal: 'admin'
  }), '');
  return response.body.token || '';
};
const loginEmployee = async () => {
  const response = await api('/api/auth/login', json('POST', {
    email: employeeEmail,
    password: employeePassword,
    portal: 'employee'
  }), '');
  return response.body.token || '';
};
const restoreLegacy = async () => {
  if (!legacyFixtureWritten) return;
  if (originalLegacy) {
    await pool.query('UPDATE erp_state SET data=$2::jsonb,updated_at=$3 WHERE storage_key=$1', [
      'soMaterialAvailabilityChecks', JSON.stringify(originalLegacy.data), originalLegacy.updated_at
    ]);
  } else {
    await pool.query("DELETE FROM erp_state WHERE storage_key='soMaterialAvailabilityChecks'");
  }
};

try {
  await start();
  token = await loginAdmin();
  assert(Boolean(token), 'Admin session authenticates');
  const employeeFixture = {
    id: employeeId, employeeId, name: 'Availability Test Employee', email: employeeEmail,
    password: employeePassword, role: 'Sales Employee', roleKey: 'sales_employee',
    department: 'Sales Department', active: true,
    departmentAssignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  };
  employeeCreateToken = `availability-employee-create-${suffix}`;
  const createdEmployee = await api('/api/employees', json('POST', { data: employeeFixture, createToken: employeeCreateToken }));
  assert(createdEmployee.status === 201, `Dedicated Employee API creates authorization fixture (${createdEmployee.body.error || ''})`);
  employeeFixtureCreated = true;
  employeeToken = await loginEmployee();
  assert(Boolean(employeeToken), 'Non-Admin test account authenticates');

  const unauthenticated = await api('/api/records/soMaterialAvailabilityChecks', {}, '');
  assert(unauthenticated.status === 401, 'Availability-check list requires authentication');
  const deniedPreview = await api('/api/availability-checks/migration-preview', {}, '');
  assert(deniedPreview.status === 401, 'Legacy preview requires an authenticated Admin');

  const legacyRows = await pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key='soMaterialAvailabilityChecks'");
  originalLegacy = legacyRows.rowCount ? legacyRows.rows[0] : null;
  const makePayload = (material) => ({
    soDetails: { projectId: `AV-PROJECT-${suffix}`, soDate: new Date().toISOString().slice(0, 10), deliveryDate: '' },
    customerDetails: { companyName: 'Availability Test Customer' },
    items: [{ itemCode: material, itemName: 'Availability fixture material', quantity: 10, unit: 'Nos' }]
  });
  for (const [number, material] of [[soNumber, itemCode], [legacySoNumber, legacyItemCode]]) {
    await pool.query(
      `INSERT INTO sales_orders(so_number,so_date,customer_name,project_id,status,currency,grand_total,amount_inr,payload,created_by,updated_by)
       VALUES($1,CURRENT_DATE,'Availability Test Customer',$2,'Confirmed','INR',0,0,$3::jsonb,'availability-test','availability-test')`,
      [number, `AV-PROJECT-${suffix}`, JSON.stringify(makePayload(material))]
    );
    await pool.query(
      `INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by)
       VALUES('inventoryItems',$1,$2::jsonb,1,now(),'availability-test')`,
      [material, JSON.stringify({ itemCode: material, itemName: 'Availability fixture material', currentQty: 3, unit: 'Nos' })]
    );
  }

  const deniedWrite = await api(`/api/availability-checks/${encodeURIComponent(soNumber)}`,
    json('PUT', { remarks: 'Unauthorized attempt', version: 0 }), employeeToken, 'Sales Department');
  assert(deniedWrite.status === 403, 'Availability-check writes preserve Store role authorization');
  const genericWrite = await api('/api/state/soMaterialAvailabilityChecks', json('PUT', { data: [] }));
  assert([400, 403].includes(genericWrite.status), 'Generic erp_state synchronization cannot overwrite availability checks');
  const genericBulkWrite = await api('/api/state', json('PUT', {
    records: { soMaterialAvailabilityChecks: [{ soNumber, remarks: 'stale generic snapshot' }] }
  }));
  assert(genericBulkWrite.status === 400, 'Bulk generic synchronization rejects module-owned availability checks');
  const preservedLegacy = await pool.query(
    "SELECT data,updated_at FROM erp_state WHERE storage_key='soMaterialAvailabilityChecks'"
  );
  assert(
    JSON.stringify(preservedLegacy.rows[0] || null) === JSON.stringify(originalLegacy || null),
    'Rejected bulk synchronization preserves the legacy availability snapshot'
  );
  const masterLegacyKeys = ['companySettings', 'customerDirectory', 'customerMaster', 'vendorMaster', 'vendorMasterSequence', 'supplierMaster', 'machines'];
  const masterLegacyBefore = await pool.query(
    'SELECT storage_key,data,updated_at FROM erp_state WHERE storage_key=ANY($1::text[]) ORDER BY storage_key',
    [masterLegacyKeys]
  );
  for (const key of masterLegacyKeys) {
    const single = await api(`/api/state/${encodeURIComponent(key)}`, json('PUT', { data: [] }));
    assert(single.status === 400, `Generic synchronization rejects migrated master key ${key}`);
    const bulk = await api('/api/state', json('PUT', { records: { [key]: [] } }));
    assert(bulk.status === 400, `Bulk generic synchronization rejects migrated master key ${key}`);
  }
  const masterLegacyAfter = await pool.query(
    'SELECT storage_key,data,updated_at FROM erp_state WHERE storage_key=ANY($1::text[]) ORDER BY storage_key',
    [masterLegacyKeys]
  );
  assert(
    JSON.stringify(masterLegacyAfter.rows) === JSON.stringify(masterLegacyBefore.rows),
    'Rejected master synchronization preserves all existing legacy snapshots for Admin reconciliation'
  );

  const saved = await api(`/api/availability-checks/${encodeURIComponent(soNumber)}`, json('PUT', { remarks: 'Test stock snapshot', version: 0 }));
  assert(saved.status === 200 && saved.body.record.recordVersion === 1, 'Availability check is created with PostgreSQL version 1');
  assert(saved.body.record.lines[0].availableStock === 3 && saved.body.record.lines[0].shortageQty === 7, 'Availability line is calculated from PostgreSQL Sales Order and inventory records');
  const listed = await api('/api/records/soMaterialAvailabilityChecks');
  assert(listed.status === 200 && listed.body.records?.some((record) => record.data?.soNumber === soNumber),
    `Dedicated module-record list returns persisted checks (${listed.status})`);

  const updated = await api(`/api/availability-checks/${encodeURIComponent(soNumber)}`, json('PUT', { remarks: 'Updated snapshot', version: 1 }));
  assert(updated.status === 200 && updated.body.record.recordVersion === 2, 'Availability check update advances optimistic version');
  const stale = await api(`/api/availability-checks/${encodeURIComponent(soNumber)}`, json('PUT', { remarks: 'Stale write', version: 1 }));
  assert(stale.status === 409, 'Stale availability-check update is rejected');

  const productionNotified = await api(`/api/availability-checks/${encodeURIComponent(soNumber)}/production-notified`, json('POST', { version: 2 }));
  assert(productionNotified.status === 200 && productionNotified.body.record.productionNotified, 'Production notification state is versioned and persisted');

  originalLegacy = originalLegacy || null;
  const legacy = {
    soNumber: legacySoNumber,
    lines: [{ lineNo: 1, materialCode: legacyItemCode, materialName: 'Availability fixture material', orderedQty: 10, shortageQty: 7 }],
    checkedBy: 'Legacy Tester',
    checkedDate: new Date().toISOString().slice(0, 10),
    remarks: 'Preserved legacy check'
  };
  await pool.query(
    `INSERT INTO erp_state(storage_key,data,updated_at) VALUES('soMaterialAvailabilityChecks',$1::jsonb,now())
     ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`,
    [JSON.stringify([legacy])]
  );
  legacyFixtureWritten = true;
  const preview = await api('/api/availability-checks/migration-preview');
  assert(preview.status === 200 && preview.body.eligible.some((entry) => entry.soNumber === legacySoNumber), 'Admin preview identifies eligible preserved legacy check');
  const imported = await api('/api/availability-checks/migration-preview/import', json('POST', { soNumbers: [legacySoNumber] }));
  assert(imported.status === 200 && imported.body.imported.includes(legacySoNumber), 'Admin can explicitly import a selected legacy check');
  const preserved = await pool.query("SELECT data FROM erp_state WHERE storage_key='soMaterialAvailabilityChecks'");
  assert(preserved.rows[0]?.data?.some((record) => record.soNumber === legacySoNumber), 'Legacy snapshot remains unchanged after selected import');
  const importConflict = await api('/api/availability-checks/migration-preview/import', json('POST', { soNumbers: [legacySoNumber] }));
  assert(importConflict.status === 200 && importConflict.body.conflicts.some((entry) => entry.soNumber === legacySoNumber), 'Repeated import is reported as a conflict without duplicate records');

  console.log(`Availability-check PostgreSQL integration test passed (${assertions} assertions).`);
} finally {
  try { await restoreLegacy(); } catch {}
  if (employeeFixtureCreated) {
    await pool.query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [employeeEmail]).catch(() => {});
    await pool.query('DELETE FROM employees WHERE id=$1', [employeeId]).catch(() => {});
  }
  if (employeeCreateToken) await pool.query('DELETE FROM master_idempotency WHERE token=$1', [employeeCreateToken]).catch(() => {});
  await pool.query("DELETE FROM module_records WHERE storage_key='soMaterialAvailabilityChecks' AND record_id=ANY($1::text[])", [[soNumber, legacySoNumber]]).catch(() => {});
  await pool.query("DELETE FROM module_records WHERE storage_key='inventoryItems' AND record_id=ANY($1::text[])", [[itemCode, legacyItemCode]]).catch(() => {});
  await pool.query('DELETE FROM sales_order_items WHERE so_number=ANY($1::text[])', [[soNumber, legacySoNumber]]).catch(() => {});
  await pool.query('DELETE FROM sales_orders WHERE so_number=ANY($1::text[])', [[soNumber, legacySoNumber]]).catch(() => {});
  if (child) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await pool.end();
}
