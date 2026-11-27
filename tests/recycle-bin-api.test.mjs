/** Isolated PostgreSQL API integration test for the central Recycle Bin. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test')
  throw new Error('Refusing Recycle Bin tests outside vyavastha_test.');
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)
  throw new Error('ERP Admin test credentials are required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_RECYCLE_BIN_TEST_PORT || 3395);
const base = `http://127.0.0.1:${port}`;
let child;
let token = '';
let employeeToken = '';
let employeeDepartment = '';
let assertions = 0;
const assert = (ok, label) => { if (!ok) throw new Error(label); assertions += 1; console.log(`PASS ${label}`); };
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const json = (method, body) => ({ method, body: JSON.stringify(body || {}) });
const start = async () => {
  const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let n = 0; n < 100; n += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready && health.database?.migrations?.some((m) => m.version === '043_recycle_bin')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated Recycle Bin server did not become ready with migration 043.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const loginAdmin = async () => (await api('/api/auth/login', json('POST', {
  email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin'
}), '')).body.token;
const loginEmployee = async () => {
  const employee = await ensureEmployeeFixture();
  const response = await api('/api/auth/login', json('POST', { email: employee.email, password: employee.password, portal: 'employee' }), '');
  if (response.status !== 200) return { token: '', department: '' };
  return { token: response.body.token, department: response.body.user?.activeDepartment || response.body.user?.department || '' };
};

const suffix = randomUUID().slice(0, 8);
const employeeFixtureId = `rb-emp-${suffix}`;
const employeeFixtureEmail = `rb-emp-${suffix}@example.test`;
const employeeFixturePassword = `Rb-${suffix}-Pass!`;
const employeeCreateToken = `recycle-bin-employee-${suffix}`;
let employeeFixtureCreated = false;

const ensureEmployeeFixture = async () => {
  const fixture = {
    id: employeeFixtureId,
    employeeId: employeeFixtureId,
    name: 'Recycle Bin Employee',
    email: employeeFixtureEmail,
    password: employeeFixturePassword,
    role: 'Sales Employee',
    roleKey: 'sales_employee',
    department: 'Sales Department',
    active: true,
    departmentAssignments: [{ department: 'Sales Department', role: 'Sales Employee', roleKey: 'sales_employee' }]
  };
  const created = await api('/api/employees', json('POST', { data: fixture, createToken: employeeCreateToken }));
  if (created.status !== 201) throw new Error(`Could not create Employee API fixture: ${created.body.error || created.status}`);
  employeeFixtureCreated = true;
  return fixture;
};
const itemCode = `RB-ITEM-${suffix}`;
const quotationNumber = `RB-Q-${suffix}`;
const soNumber = `RB-SO-${suffix}`;
const missingParentSoNumber = `RB-SO-MISSING-${suffix}`;
const missingParentQuotationNumber = `RB-Q-MISSING-${suffix}`;
const today = new Date().toISOString().slice(0, 10);
let itemDeleted = false;
let itemRestored = false;

try {
  await start();
  token = await loginAdmin();
  assert(Boolean(token), 'Admin session authenticates');

  const unauthList = await api('/api/recycle-bin', {}, '');
  assert(unauthList.status === 401, 'Recycle Bin list requires authentication');

  const created = await api('/api/inventory/items', json('POST', {
    data: { itemCode, materialName: `Recycle Bin fixture ${suffix}`, unit: 'Nos' }
  }));
  assert(created.status === 201 && Number(created.body.record.version) === 1, 'Inventory fixture is created authoritatively');
  const deleted = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    version: 1, reason: 'Recycle Bin isolated fixture'
  }));
  assert(deleted.status === 200 && Boolean(deleted.body.record.deleted_at), 'Inventory fixture is soft-deleted');
  itemDeleted = true;

  const listed = await api(`/api/recycle-bin?module=store&search=${encodeURIComponent(itemCode)}`);
  const listedEntry = (listed.body.entries || []).find((entry) => entry.entity === 'inventory_items' && entry.recordId === itemCode);
  assert(listed.status === 200 && Boolean(listedEntry), 'Deleted inventory item appears in the Recycle Bin list');
  assert(listedEntry.moduleKey === 'store' && listedEntry.documentNumber === itemCode, 'Recycle Bin list exposes module and document number');
  assert(listedEntry.deleteReason === 'Recycle Bin isolated fixture' && Boolean(listedEntry.deletedBy), 'Recycle Bin list exposes deletion reason and actor');
  assert(listedEntry.canRestore === true && listedEntry.canPurge === true, 'Admin sees restore and purge actions');

  const wrongModule = await api(`/api/recycle-bin?module=sales&search=${encodeURIComponent(itemCode)}`);
  assert(wrongModule.status === 200 && !(wrongModule.body.entries || []).some((entry) => entry.recordId === itemCode), 'Module filter excludes records from other modules');

  const dateFiltered = await api(`/api/recycle-bin?from=${today}&to=${today}&deletedBy=${encodeURIComponent(process.env.ERP_ADMIN_EMAIL)}`);
  assert(dateFiltered.status === 200 && (dateFiltered.body.entries || []).some((entry) => entry.recordId === itemCode), 'Deletion-date and deleted-by filters include the tombstone');

  const detail = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}`);
  assert(detail.status === 200 && detail.body.entry.recordId === itemCode, 'Recycle Bin detail returns the tombstoned record');
  assert((detail.body.audit || []).some((row) => row.action === 'MASTER_DELETE'), 'Recycle Bin detail exposes the module delete audit row');

  const employeeLogin = await loginEmployee();
  employeeToken = employeeLogin.token;
  employeeDepartment = employeeLogin.department;
  assert(Boolean(employeeToken), 'A non-Admin employee account is available');

  const unauthRestore = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}/restore`, json('POST', { reason: 'No auth' }), '');
  assert(unauthRestore.status === 401, 'Unauthenticated restore is rejected');
  const nonAdminPurge = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}`, {
    ...json('DELETE', { reason: 'Non-admin purge', confirm: itemCode }),
    headers: employeeDepartment ? { 'X-ERP-Department': employeeDepartment } : {}
  }, employeeToken);
  assert(nonAdminPurge.status === 403, 'Non-Admin cannot permanently delete from the Recycle Bin');

  const missingReason = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}/restore`, json('POST', {}));
  assert(missingReason.status === 400, 'Restore requires a reason');
  const wrongEntity = await api(`/api/recycle-bin/not_a_module/${encodeURIComponent(itemCode)}/restore`, json('POST', { reason: 'Unknown module' }));
  assert(wrongEntity.status === 404, 'Unknown Recycle Bin entity is rejected');

  const restored = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}/restore`, json('POST', {
    reason: 'Recycle Bin isolated restore'
  }));
  assert(restored.status === 200 && !restored.body.record.deleted_at, 'Authorised restore clears the tombstone');
  assert(Number(restored.body.record.version) > 2, 'Restore advances the PostgreSQL version');
  itemDeleted = false;
  itemRestored = true;
  const restoreAudit = await pool.query(
    "SELECT 1 FROM erp_audit_log WHERE module='inventory_items' AND record_id=$1 AND action='RECYCLE_BIN_RESTORE'",
    [itemCode]
  );
  assert(restoreAudit.rowCount === 1, 'Restore writes a durable audit row');

  const restoredAgain = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}/restore`, json('POST', {
    reason: 'Already active'
  }));
  assert(restoredAgain.status === 409, 'Restoring an active record is rejected');
  const activeList = await api(`/api/recycle-bin?module=store&search=${encodeURIComponent(itemCode)}`);
  assert(!(activeList.body.entries || []).some((entry) => entry.recordId === itemCode), 'Restored record leaves the Recycle Bin list');

  const restoredVersion = Number(restored.body.record.version);
  const deletedAgain = await api(`/api/inventory/items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    version: restoredVersion, reason: 'Recycle Bin purge fixture'
  }));
  assert(deletedAgain.status === 200, 'Inventory fixture is soft-deleted again for purge');
  itemDeleted = true;
  itemRestored = false;

  const wrongConfirmation = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    reason: 'Wrong confirmation', confirm: 'WRONG'
  }));
  assert(wrongConfirmation.status === 400, 'Permanent delete requires an exact document-number confirmation');
  const purgeNoReason = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    confirm: itemCode
  }));
  assert(purgeNoReason.status === 400, 'Permanent delete requires a reason');

  const purged = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    reason: 'Recycle Bin isolated purge', confirm: itemCode
  }));
  assert(purged.status === 200 && purged.body.purged === true, 'Admin can permanently delete an unreferenced tombstone');
  itemDeleted = false;
  const itemRow = await pool.query('SELECT 1 FROM inventory_items WHERE item_code=$1', [itemCode]);
  assert(itemRow.rowCount === 0, 'Permanent delete removes the row from PostgreSQL');
  const purgeAudit = await pool.query(
    "SELECT 1 FROM erp_audit_log WHERE module='inventory_items' AND record_id=$1 AND action='RECYCLE_BIN_PURGE'",
    [itemCode]
  );
  assert(purgeAudit.rowCount === 1, 'Permanent delete writes a durable audit row');
  const purgedAgain = await api(`/api/recycle-bin/inventory_items/${encodeURIComponent(itemCode)}`, json('DELETE', {
    reason: 'Already purged', confirm: itemCode
  }));
  assert(purgedAgain.status === 404, 'A repeated permanent delete is rejected');

  await pool.query(
    `INSERT INTO quotations (quotation_number, customer_name, quotation_date, payload, created_by, updated_by, deleted_at, deleted_by, delete_reason, version)
     VALUES ($1,'Recycle Bin Customer',CURRENT_DATE,'{}'::jsonb,'test','test',now(),'test','fixture',2)`,
    [quotationNumber]
  );
  await pool.query(
    `INSERT INTO sales_orders (so_number, so_date, customer_name, quotation_ref, payload, created_by, updated_by, deleted_at, deleted_by, delete_reason, version)
     VALUES ($1,CURRENT_DATE,'Recycle Bin Customer',$2,'{}'::jsonb,'test','test',now(),'test','fixture',2)`,
    [soNumber, quotationNumber]
  );

  const blockedRestore = await api(`/api/recycle-bin/sales_orders/${encodeURIComponent(soNumber)}/restore`, json('POST', {
    reason: 'Parent still deleted'
  }));
  assert(blockedRestore.status === 409, 'Restore is blocked while a required parent remains deleted');

  await pool.query(
    `INSERT INTO sales_orders (so_number, so_date, customer_name, quotation_ref, payload, created_by, updated_by, deleted_at, deleted_by, delete_reason, version)
     VALUES ($1,CURRENT_DATE,'Recycle Bin Customer',$2,'{}'::jsonb,'test','test',now(),'test','fixture',2)`,
    [missingParentSoNumber, missingParentQuotationNumber]
  );
  const missingParentRestore = await api(`/api/recycle-bin/sales_orders/${encodeURIComponent(missingParentSoNumber)}/restore`, json('POST', {
    reason: 'Referenced quotation no longer exists'
  }));
  assert(missingParentRestore.status === 409, 'Restore is blocked when a required parent no longer exists');

  const restoredQuotation = await api(`/api/recycle-bin/quotations/${encodeURIComponent(quotationNumber)}/restore`, json('POST', {
    reason: 'Restore parent first'
  }));
  assert(restoredQuotation.status === 200, 'Parent record restores through the Recycle Bin');
  const restoredSo = await api(`/api/recycle-bin/sales_orders/${encodeURIComponent(soNumber)}/restore`, json('POST', {
    reason: 'Parent restored'
  }));
  assert(restoredSo.status === 200, 'Child record restores after its parent is active');

  await pool.query(
    "UPDATE sales_orders SET deleted_at=now(), deleted_by='test', delete_reason='fixture purge', version=version+1 WHERE so_number=$1",
    [soNumber]
  );

  const blockedPurge = await api(`/api/recycle-bin/quotations/${encodeURIComponent(quotationNumber)}`, json('DELETE', {
    reason: 'Referenced parent', confirm: quotationNumber
  }));
  assert(blockedPurge.status === 409, 'Permanent delete is blocked while child records still reference the parent');

  const purgedSo = await api(`/api/recycle-bin/sales_orders/${encodeURIComponent(soNumber)}`, json('DELETE', {
    reason: 'Remove child first', confirm: soNumber
  }));
  assert(purgedSo.status === 200, `Unreferenced child record can be permanently deleted (${purgedSo.status} ${purgedSo.body?.error || ''})`);
  await pool.query(
    "UPDATE quotations SET deleted_at=now(), deleted_by='test', delete_reason='fixture purge', version=version+1 WHERE quotation_number=$1",
    [quotationNumber]
  );
  const purgedQuotation = await api(`/api/recycle-bin/quotations/${encodeURIComponent(quotationNumber)}`, json('DELETE', {
    reason: 'Remove parent after child', confirm: quotationNumber
  }));
  assert(purgedQuotation.status === 200, `Parent record can be permanently deleted after children are gone (${purgedQuotation.status} ${purgedQuotation.body?.error || ''})`);
  const linkRows = await pool.query(
    'SELECT 1 FROM quotations WHERE quotation_number=$1 UNION ALL SELECT 1 FROM sales_orders WHERE so_number=$2',
    [quotationNumber, soNumber]
  );
  assert(linkRows.rowCount === 0, 'Dependency fixtures are physically removed after purge');

  console.log(`RECYCLE BIN API CHECKS PASSED (${assertions} assertions)`);
} finally {
  if (employeeFixtureCreated) {
    await pool.query('DELETE FROM erp_sessions WHERE lower(email)=lower($1)', [employeeFixtureEmail]).catch(() => {});
    await pool.query('DELETE FROM employees WHERE id=$1', [employeeFixtureId]).catch(() => {});
  }
  if (employeeFixtureCreated) await pool.query('DELETE FROM master_idempotency WHERE token=$1', [employeeCreateToken]).catch(() => {});
  await pool.query('DELETE FROM sales_order_items WHERE so_number=$1', [soNumber]).catch(() => {});
  await pool.query('DELETE FROM sales_orders WHERE so_number=$1', [soNumber]).catch(() => {});
  await pool.query('DELETE FROM sales_order_items WHERE so_number=$1', [missingParentSoNumber]).catch(() => {});
  await pool.query('DELETE FROM sales_orders WHERE so_number=$1', [missingParentSoNumber]).catch(() => {});
  await pool.query('DELETE FROM quotation_items WHERE quotation_number=$1', [quotationNumber]).catch(() => {});
  await pool.query('DELETE FROM quotations WHERE quotation_number=$1', [quotationNumber]).catch(() => {});
  await pool.query('DELETE FROM stock_ledger_entries WHERE item_code=$1', [itemCode]).catch(() => {});
  await pool.query('DELETE FROM inventory_batches WHERE item_code=$1', [itemCode]).catch(() => {});
  await pool.query('DELETE FROM inventory_items WHERE item_code=$1', [itemCode]).catch(() => {});
  await stop();
  await pool.end();
}
