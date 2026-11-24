/**
 * Full ERP PostgreSQL End-to-End Audit & Verification Suite
 *
 * Verifies all modules, endpoints, schema, data persistence across restart,
 * password preservation, and single/bulk ERP state operations.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeDatabase, checkDatabase, runMigrations, getPool } from '../server/database.js';

if (!process.env.DATABASE_URL) {
  console.log('SKIP: DATABASE_URL is not configured.');
  process.exit(0);
}

const PORT = 3322;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

const ok = (label) => { passed++; console.log(`  ✓  ${label}`); };
const fail = (label, detail = '') => {
  failed++;
  failures.push(`${label}${detail ? ': ' + detail : ''}`);
  console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, label, detail = '') => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n── ${name}`);

const isDeepEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => isDeepEqual(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => isDeepEqual(a[k], b[k]));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

let serverProcess = null;

const startServer = () => {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', () => {});
    serverProcess.stderr.on('data', () => {});
    serverProcess.on('error', reject);
    setTimeout(resolve, 800);
  });
};

const stopServer = () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
};

/* PUT /api/state/:key REPLACES the whole module value (ON CONFLICT DO UPDATE
   SET data = EXCLUDED.data), and this suite runs against the same
   DATABASE_URL as the live server. Without a snapshot every run would wipe a
   module down to a single *-TEST-* record and never put it back, so read each
   key first and restore it once the persistence checks are done. Keys that did
   not exist are deleted again rather than recreated as empty arrays.
   Declared at module scope so the finally block can always reach it, even when
   the audit aborts in an early section. */
const originalState = new Map();

const snapshotModule = async (key) => {
  const before = await request(`/api/state/${key}`);
  if (before.status === 404) originalState.set(key, { absent: true });
  // Only snapshot a value we actually read back: writing `{ data: undefined }`
  // would store an empty object and destroy the module instead of restoring it.
  else if (before.ok) originalState.set(key, { data: before.data?.data });
  else console.error(`       [snapshot skipped] ${key}: status ${before.status}`);
};

const restoreModuleSnapshots = async () => {
  for (const [key, original] of [...originalState]) {
    try {
      if (original.absent) await request(`/api/state/${key}`, { method: 'DELETE' });
      else await request(`/api/state/${key}`, { method: 'PUT', body: JSON.stringify({ data: original.data }) });
      originalState.delete(key);
    } catch (err) {
      // Left in the map so restoreViaDatabase() can retry it directly.
      console.error(`       [restore failed] ${key}: ${err.message}`);
    }
  }
};

/* Last resort for keys the HTTP restore could not put back — used when the
   spawned server is down (for example the restart in section 7 failed). Writes
   straight to erp_state with the same upsert/delete the API route performs. */
const restoreViaDatabase = async () => {
  if (originalState.size === 0) return;
  let pool;
  try {
    pool = getPool();
  } catch (err) {
    console.error(`       [restore skipped] no database connection: ${err.message}`);
    return;
  }
  for (const [key, original] of [...originalState]) {
    try {
      if (original.absent) {
        await pool.query('DELETE FROM erp_state WHERE storage_key = $1', [key]);
      } else {
        await pool.query(
          `INSERT INTO erp_state (storage_key, data, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (storage_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [key, JSON.stringify(original.data ?? null)]
        );
      }
      originalState.delete(key);
      console.log(`       [restored via database] ${key}`);
    } catch (err) {
      console.error(`       [restore failed] ${key}: ${err.message}`);
    }
  }
};

try {
  section('1. Database Connectivity & Migration Schema Check');
  const dbConnected = await checkDatabase();
  check(dbConnected === true, 'PostgreSQL is reachable (SELECT 1)');

  await runMigrations();
  ok('Migrations applied cleanly');

  const pool = getPool();
  const tablesRes = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  const tables = tablesRes.rows.map(r => r.table_name);
  console.log('     Found public tables:', tables.join(', '));
  check(tables.includes('erp_state'), "Table 'erp_state' exists");
  check(tables.includes('ballooning_projects'), "Table 'ballooning_projects' exists");
  check(tables.includes('ballooning_drawings'), "Table 'ballooning_drawings' exists");
  check(tables.includes('ballooning_balloons'), "Table 'ballooning_balloons' exists");
  check(tables.includes('ballooning_characteristics'), "Table 'ballooning_characteristics' exists");
  check(tables.includes('ballooning_inspections'), "Table 'ballooning_inspections' exists");
  check(tables.includes('ballooning_approvals'), "Table 'ballooning_approvals' exists");
  check(tables.includes('schema_migrations'), "Table 'schema_migrations' exists");

  await closeDatabase();

  section('2. Start Server Process & Health Probe');
  await startServer();
  let serverReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const h = await request('/api/health');
      if (h.ok && h.data?.database?.connected) {
        serverReady = true;
        break;
      }
    } catch {
      /* waiting for server */
    }
    await sleep(200);
  }
  check(serverReady === true, `Express backend operational on port ${PORT}`);

  section('3. erp_state Bulk API Operations');
  const bulkTestKey = `__bulk_test_${Date.now()}`;
  const putBulkRes = await request('/api/state', {
    method: 'PUT',
    body: JSON.stringify({ records: { [bulkTestKey]: { name: 'Audit Test', timestamp: Date.now() } } })
  });
  check(putBulkRes.ok && putBulkRes.data?.success, 'PUT /api/state bulk upsert success');

  const postBeaconKey = `__beacon_test_${Date.now()}`;
  const postBeaconRes = await request('/api/state', {
    method: 'POST',
    body: JSON.stringify({ records: { [postBeaconKey]: { name: 'Beacon Test', timestamp: Date.now() } } })
  });
  check(postBeaconRes.ok && postBeaconRes.data?.success, 'POST /api/state unload beacon upsert success');

  const getBulkRes = await request('/api/state');
  check(getBulkRes.ok && getBulkRes.data?.records?.[bulkTestKey]?.name === 'Audit Test', 'GET /api/state retrieves inserted record');
  check(getBulkRes.ok && getBulkRes.data?.records?.[postBeaconKey]?.name === 'Beacon Test', 'GET /api/state retrieves unload beacon record');

  // Clean up beacon key
  await request(`/api/state/${postBeaconKey}`, { method: 'DELETE' });

  section('4. erp_state Single-Key Granular Operations (GET, PUT, DELETE)');
  const singleKey = `__single_key_${Date.now()}`;
  const putSingleRes = await request(`/api/state/${singleKey}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { message: 'Single key test', count: 42 } })
  });
  check(putSingleRes.ok && putSingleRes.data?.success, `PUT /api/state/${singleKey} creates single record`);

  const getSingleRes = await request(`/api/state/${singleKey}`);
  check(getSingleRes.ok && getSingleRes.data?.data?.count === 42, `GET /api/state/${singleKey} reads back record data`);

  const delSingleRes = await request(`/api/state/${singleKey}`, { method: 'DELETE' });
  check(delSingleRes.ok && delSingleRes.data?.deleted === true, `DELETE /api/state/${singleKey} removes single record`);

  const getAfterDel = await request(`/api/state/${singleKey}`);
  check(getAfterDel.status === 404, `GET /api/state/${singleKey} after delete returns 404`);

  section('5. Employee Credential & Password Persistence Audit');
  const testEmpKey = 'employees';
  const getEmpState = await request(`/api/state/${testEmpKey}`);
  const existingEmployees = getEmpState.ok ? getEmpState.data.data : [];
  const testEmpId = `EMP-TEST-${Date.now()}`;
  const testPassword = 'Secure@Pass1234';
  const updatedEmployees = [
    ...(Array.isArray(existingEmployees) ? existingEmployees : []),
    {
      id: testEmpId,
      employeeId: testEmpId,
      name: 'Audit Test User',
      email: `audit.${Date.now()}@gmail.com`,
      password: testPassword,
      department: 'Production Department',
      designation: 'QA Tester',
      roleKey: 'production_employee',
      role: 'Production Employee',
      active: true
    }
  ];

  const saveEmpRes = await request(`/api/state/${testEmpKey}`, {
    method: 'PUT',
    body: JSON.stringify({ data: updatedEmployees })
  });
  check(saveEmpRes.ok, 'PUT /api/state/employees with password');

  const readBackEmp = await request(`/api/state/${testEmpKey}`);
  const foundEmp = (readBackEmp.data?.data || []).find(e => e.employeeId === testEmpId);
  check(foundEmp?.password === testPassword, 'Employee password preserved intact in PostgreSQL without stripping');

  // Clean up employee test record
  const cleanedEmployees = updatedEmployees.filter(e => e.employeeId !== testEmpId);
  await request(`/api/state/${testEmpKey}`, {
    method: 'PUT',
    body: JSON.stringify({ data: cleanedEmployees })
  });
  ok('Employee test record cleaned up');

  section('6. Module-by-Module Persistence Verification');
  const MODULE_TESTS = [
    { module: 'Quotations', key: 'quotationHistory', sample: [{ quotationNumber: `QT-TEST-${Date.now()}`, clientName: 'Audit Customer', totalAmount: 150000 }] },
    { module: 'Customer Purchase Orders', key: 'customerPOHistory', sample: [{ poNumber: `CPO-TEST-${Date.now()}`, customerName: 'Audit Corp', grandTotal: 250000 }] },
    { module: 'Sales Orders', key: 'salesOrderHistory', sample: [{ soNumber: `SO-TEST-${Date.now()}`, customerName: 'Audit Corp', grandTotal: 180000 }] },
    { module: 'Purchase Orders', key: 'supplierPOHistory', sample: [{ poNumber: `PO-TEST-${Date.now()}`, vendorName: 'Audit Steel Vendor', grandTotal: 95000 }] },
    { module: 'Vendor Enquiries', key: 'vendorEnquiries', sample: [{ enquiryNumber: `VE-TEST-${Date.now()}`, vendorName: 'Audit Metals' }] },
    { module: 'Vendor Quotations', key: 'vendorQuotations', sample: [{ quotationNumber: `VQ-TEST-${Date.now()}`, status: 'Received', totalAmount: 48000 }] },
    { module: 'Inventory & Items', key: 'inventoryItems', perRecord: true, sample: [{ itemCode: `ITM-TEST-${Date.now()}`, itemName: 'Aluminum Bar 50mm', currentStock: 120, unit: 'Kg' }] },
    { module: 'Stock Transactions', key: 'stockTransactions', perRecord: true, sample: [{ transactionId: `TX-TEST-${Date.now()}`, type: 'Receipt', quantity: 50 }] },
    { module: 'Material Requests', key: 'materialRequests', sample: [{ mrNumber: `MR-TEST-${Date.now()}`, department: 'Production Department', status: 'Submitted' }] },
    { module: 'Store Issues', key: 'storeIssueHistory', sample: [{ issueNumber: `SI-TEST-${Date.now()}`, issuedTo: 'Operator A', status: 'Issued' }] },
    { module: 'Material Returns', key: 'materialReturnHistory', sample: [{ returnNumber: `SR-TEST-${Date.now()}`, reason: 'Excess Material' }] },
    { module: 'Production Job Cards', key: 'productionJobCards', sample: [{ jobCardNumber: `JC-TEST-${Date.now()}`, partName: 'Spindle Shaft', targetQty: 10 }] },
    { module: 'Bill of Materials (BOM)', key: 'boms', sample: [{ bomId: `BOM-TEST-${Date.now()}`, assemblyName: 'Gearbox Housing' }] },
    { module: 'Purchase Indents', key: 'purchaseIndents', sample: [{ indentNumber: `IND-TEST-${Date.now()}`, status: 'Under Purchase Review' }] },
    { module: 'Material Receipts', key: 'materialReceipts', sample: [{ receiptNumber: `MRN-TEST-${Date.now()}`, invoiceNumber: 'INV-999', status: 'Received' }] },
    { module: 'Quality Checks', key: 'qualityChecks', sample: [{ qcNumber: `QC-TEST-${Date.now()}`, inspector: 'Tester', acceptedQty: 50, rejectedQty: 0 }] },
    { module: 'Debit Notes', key: 'debitNotes', sample: [{ debitNoteNumber: `DN-TEST-${Date.now()}`, vendorName: 'Rejected Vendor Ltd', debitAmount: 4500 }] },
    { module: 'Customer Invoices', key: 'customerInvoiceHistory', sample: [{ invoiceNumber: `INV-TEST-${Date.now()}`, customerName: 'Client Alpha', amount: 120000 }] },
    { module: 'Export Invoices', key: 'exportInvoiceHistory', sample: [{ invoiceNumber: `EXP-TEST-${Date.now()}`, currency: 'USD', amount: 5000 }] },
    { module: 'Delivery Challans', key: 'deliveryChallanHistory', sample: [{ dcNumber: `DC-TEST-${Date.now()}`, vehicleNumber: 'KA-01-AB-1234' }] },
    { module: 'Supplier Invoices', key: 'supplierInvoiceHistory', sample: [{ billNumber: `SUP-TEST-${Date.now()}`, vendorName: 'Vendor Beta', totalAmount: 34000 }] },
    { module: 'Vendor Master', key: 'vendorMaster', sample: [{ name: 'AUDIT SPECIALTY ALLOYS', product: 'Titanium Rods', phone: '9999988888' }] },
    { module: 'Machine Master', key: 'machines', sample: [{ id: `MCH-TEST-${Date.now()}`, machineName: 'VMC Haas VF2', status: 'Running' }] },
    { module: 'Company Settings', key: 'companySettings', sample: { companyName: 'Pragmatic Engineers', gstin: '29ABCDE1234F1Z5', verified: true } },
    { module: 'Notifications', key: 'notifications', sample: [{ id: `NOTIF-${Date.now()}`, title: 'Test Alert', message: 'System verification' }] },
    { module: 'Store Audit Log', key: 'storeAuditLog', sample: [{ id: `LOG-${Date.now()}`, action: 'VERIFICATION', at: new Date().toISOString() }] }
  ];

  /* The snapshot/restore helpers live at module scope (see above). Snapshot
     every module key this suite is about to overwrite. */
  await snapshotModule(testEmpKey);
  for (const m of MODULE_TESTS) {
    if (!m.perRecord) await snapshotModule(m.key);
  }

  for (const m of MODULE_TESTS) {
    // Modules that graduated to per-record storage (Phase 2) are verified
    // through /api/records instead of the generic /api/state mirror.
    if (m.perRecord) {
      const recordId = `AUDIT-${Date.now()}`;
      const writeRes = await request(`/api/records/${m.key}`, {
        method: 'PUT',
        body: JSON.stringify({ records: [{ id: recordId, data: m.sample[0], version: 0 }], updatedBy: 'audit-suite' })
      });
      if (!writeRes.ok || (writeRes.data.saved || []).length !== 1) {
        fail(`Module [${m.module}] per-record write failed`, writeRes.data?.error || `status ${writeRes.status}`);
        continue;
      }
      const readRes = await request(`/api/records/${m.key}`);
      const row = (readRes.data?.records || []).find((r) => r.id === recordId);
      const matches = row && isDeepEqual(row.data, m.sample[0]) && Number(row.version) === 1;
      check(matches, `Module [${m.module}] (${m.key}) CRUD round-trip verified in PostgreSQL (per-record API)`);
      // Clean the audit record so the live table keeps only real data
      await request(`/api/records/${m.key}`, {
        method: 'PUT',
        body: JSON.stringify({ deletes: [{ id: recordId, version: row ? row.version : 1 }], updatedBy: 'audit-suite' })
      });
      continue;
    }

    // 1. Write to PostgreSQL via state API
    const writeRes = await request(`/api/state/${m.key}`, {
      method: 'PUT',
      body: JSON.stringify({ data: m.sample })
    });
    if (!writeRes.ok) {
      fail(`Module [${m.module}] write failed`, writeRes.data?.error || `status ${writeRes.status}`);
      continue;
    }

    // 2. Read back from PostgreSQL
    const readRes = await request(`/api/state/${m.key}`);
    const matches = isDeepEqual(readRes.data?.data, m.sample);
    if (!matches) {
      console.error(`       [DEBUG ${m.key}] expected:`, JSON.stringify(m.sample));
      console.error(`       [DEBUG ${m.key}] actual:  `, JSON.stringify(readRes.data));
    }
    check(matches, `Module [${m.module}] (${m.key}) CRUD round-trip verified in PostgreSQL`);
  }

  section('7. Persistence Across Server Restart (Simulation)');
  // Stop the server and restart it on the same port
  console.log('     Restarting backend server...');
  stopServer();
  await sleep(1000);
  await startServer();

  let restartedReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const h = await request('/api/health');
      if (h.ok && h.data?.database?.connected) {
        restartedReady = true;
        break;
      }
    } catch {
      /* wait */
    }
    await sleep(200);
  }
  check(restartedReady === true, 'Backend restarted and reconnected to PostgreSQL');

  // Verify records persist unchanged after server restart
  let restartVerifiedCount = 0;
  for (const m of MODULE_TESTS.slice(0, 5)) {
    const readRes = await request(`/api/state/${m.key}`);
    if (isDeepEqual(readRes.data?.data, m.sample)) {
      restartVerifiedCount++;
    }
  }
  check(restartVerifiedCount === 5, 'Records intact after backend restart');

  // The samples have served their purpose (module round-trip + restart
  // persistence); put the real module values back before anything else runs.
  await restoreModuleSnapshots();
  ok('Module snapshots restored to their pre-audit values');

  section('8. Ballooning Module End-to-End PostgreSQL Integration');
  // 1. Create project
  const projectRes = await request('/api/ballooning/projects', {
    method: 'POST',
    body: JSON.stringify({
      drawingNumber: `DWG-AUDIT-${Date.now()}`,
      partName: 'Turbine Rotor Component',
      unit: 'mm',
      status: 'Draft',
      inspector: 'Inspector QA',
      reviewer: 'Lead Engineer'
    })
  });
  check(projectRes.ok && projectRes.data?._id, 'Ballooning: Create project in ballooning_projects table');
  const projId = projectRes.data?._id;

  // 2. Add balloon
  const balloonRes = await request(`/api/ballooning/projects/${projId}/balloons`, {
    method: 'POST',
    body: JSON.stringify({
      number: 1,
      text: '25.4 ± 0.05',
      nominal: 25.4,
      upperTolerance: 0.05,
      lowerTolerance: -0.05,
      x: 0.45,
      y: 0.62,
      page: 1,
      status: 'Draft'
    })
  });
  check(balloonRes.ok && balloonRes.data?._id, 'Ballooning: Create balloon in ballooning_balloons table');
  const balloonId = balloonRes.data?._id;

  // 3. Add characteristic
  const charRes = await request(`/api/ballooning/projects/${projId}/characteristics`, {
    method: 'POST',
    body: JSON.stringify({
      balloonId,
      number: '1',
      description: 'Outer Diameter',
      nominal: 25.4,
      upper: 0.05,
      lower: -0.05,
      measured: 25.42,
      result: 'PASS',
      status: 'PASS'
    })
  });
  check(charRes.ok && charRes.data?._id, 'Ballooning: Create characteristic in ballooning_characteristics table');

  // 4. Update ballooning project approval
  const appRes = await request(`/api/ballooning/projects/${projId}/approval`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'Approved',
      approvedBy: 'Quality Manager',
      comments: 'All dimensions within specified tolerance'
    })
  });
  check(appRes.ok && appRes.data?.status === 'Approved', 'Ballooning: Submit approval to ballooning_approvals table');

  // 5. Verify project updated status
  const projCheck = await request(`/api/ballooning/projects/${projId}`);
  check(projCheck.data?.status === 'Approved', 'Ballooning: Project status updated to Approved in PostgreSQL');

  // 6. Cascade delete project
  const delProj = await request(`/api/ballooning/projects/${projId}`, { method: 'DELETE' });
  check(delProj.ok && delProj.data?.success, 'Ballooning: Cascade delete project and related records');

  // Verify balloons are deleted
  const balloonsAfter = await request(`/api/ballooning/projects/${projId}/balloons`);
  check(balloonsAfter.status === 404, 'Ballooning: Balloons deleted via foreign key CASCADE');

  // Clean up bulk test key
  await request(`/api/state/${bulkTestKey}`, { method: 'DELETE' });

} catch (err) {
  fail('Fatal audit exception', err.message);
  console.error(err);
} finally {
  // Put the live module values back even when the audit aborts midway — the
  // samples are only meant to exist for the duration of section 6/7. HTTP first
  // (server still up), then straight to PostgreSQL if it is not reachable.
  await restoreModuleSnapshots();
  stopServer();
  await restoreViaDatabase();
  await closeDatabase();
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Full Audit Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error('Audit Failures:');
  failures.forEach(f => console.error(`  • ${f}`));
  process.exit(1);
} else {
  console.log('ALL AUDIT TESTS PASSED SUCCESSFULLY! ✓');
}
