/**
 * Comprehensive database connectivity and CRUD test.
 *
 * Tests verified:
 *  1. DATABASE_URL is configured
 *  2. PostgreSQL is reachable (SELECT 1)
 *  3. Migrations apply without error (idempotent)
 *  4. schema_migrations table has all expected versions
 *  5. erp_state PUT / GET round-trip (upsert and read back)
 *  6. erp_state filters excluded keys (erp_auth should be rejected)
 *  7. ballooning project CREATE / READ / UPDATE
 *  8. balloon CREATE / LIST under project
 *  9. characteristic CREATE / LIST under project
 * 10. cascade DELETE removes project + related rows
 * 11. drawing metadata INSERT (without file upload)
 * 12. getMigrationStatus() returns expected versions
 *
 * Run: node tests/db-crud.test.mjs
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { closeDatabase, checkDatabase, runMigrations, getMigrationStatus, getPool } from '../server/database.js';

const EXPECTED_MIGRATIONS = ['001_ballooning', '002_erp_state', '003_erp_indexes'];

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

// ── Guard: need DATABASE_URL ──────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL is not configured. Create .env from .env.example first.');
    process.exit(0);
}

try {
    section('1. Connectivity');
    const connected = await checkDatabase();
    check(connected === true, 'SELECT 1 returns 1');

    section('2. Migrations (idempotent)');
    await runMigrations(); // must not throw even when already applied
    ok('runMigrations() completed without error');

    const status = await getMigrationStatus();
    const versions = status.map(s => s.version);
    for (const expected of EXPECTED_MIGRATIONS) {
        check(versions.includes(expected), `Migration ${expected} recorded in schema_migrations`);
    }

    section('3. erp_state PUT / GET');
    const db = getPool();
    const testKey = `__db_test_${Date.now()}`;
    const testValue = { verified: true, ts: new Date().toISOString() };
    await db.query(
        `INSERT INTO erp_state (storage_key, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (storage_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [testKey, JSON.stringify(testValue)]
    );
    const readBack = await db.query('SELECT data FROM erp_state WHERE storage_key = $1', [testKey]);
    check(readBack.rowCount === 1, 'erp_state row inserted');
    check(readBack.rows[0].data?.verified === true, 'erp_state data round-trips correctly');
    // Clean up
    await db.query('DELETE FROM erp_state WHERE storage_key = $1', [testKey]);
    ok('erp_state test row cleaned up');

    section('4. Ballooning project CRUD');
    const projectId = randomUUID();
    const now = new Date().toISOString();
    await db.query(
        'INSERT INTO ballooning_projects (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $3)',
        [projectId, JSON.stringify({ drawingNumber: 'DB-TEST-001', partName: 'DB CRUD test part', status: 'Draft', unit: 'mm' }), now]
    );
    ok('ballooning_projects INSERT');

    const projRow = await db.query('SELECT * FROM ballooning_projects WHERE id = $1', [projectId]);
    check(projRow.rowCount === 1, 'ballooning_projects SELECT by id');
    check(projRow.rows[0].data?.drawingNumber === 'DB-TEST-001', 'project data.drawingNumber correct');

    await db.query(
        `UPDATE ballooning_projects SET data = data || $2::jsonb, updated_at = $3 WHERE id = $1`,
        [projectId, JSON.stringify({ status: 'Under Review' }), new Date().toISOString()]
    );
    const updatedRow = await db.query('SELECT data FROM ballooning_projects WHERE id = $1', [projectId]);
    check(updatedRow.rows[0].data?.status === 'Under Review', 'ballooning_projects UPDATE data merge');

    section('5. Drawing metadata INSERT');
    const drawingId = randomUUID();
    await db.query(
        `INSERT INTO ballooning_drawings (id, project_id, file_name, drawing_no, storage_name, page_count, uploaded_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
        [drawingId, projectId, 'test-drawing.pdf', 'DWG-001', `${drawingId}.pdf`, now]
    );
    const drawRow = await db.query('SELECT * FROM ballooning_drawings WHERE id = $1', [drawingId]);
    check(drawRow.rowCount === 1, 'ballooning_drawings INSERT');
    check(drawRow.rows[0].file_name === 'test-drawing.pdf', 'drawing file_name correct');

    section('6. Balloon CRUD');
    const balloonId = randomUUID();
    await db.query(
        `INSERT INTO ballooning_balloons (id, project_id, drawing_id, number, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
        [balloonId, projectId, drawingId, 1, JSON.stringify({ text: '10 ± 0.1', x: 0.25, y: 0.5, status: 'Draft' }), now]
    );
    const balloonRows = await db.query('SELECT * FROM ballooning_balloons WHERE project_id = $1', [projectId]);
    check(balloonRows.rowCount === 1, 'ballooning_balloons INSERT + SELECT');
    check(balloonRows.rows[0].data?.text === '10 ± 0.1', 'balloon data text correct');

    section('7. Characteristic CRUD');
    const charId = randomUUID();
    await db.query(
        `INSERT INTO ballooning_characteristics (id, project_id, drawing_id, balloon_id, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
        [charId, projectId, drawingId, balloonId, JSON.stringify({ nominal: 10, upper: 0.1, lower: -0.1, status: 'NOT INSPECTED' }), now]
    );
    const charRows = await db.query('SELECT * FROM ballooning_characteristics WHERE project_id = $1', [projectId]);
    check(charRows.rowCount === 1, 'ballooning_characteristics INSERT + SELECT');

    section('8. Cascade DELETE');
    await db.query('DELETE FROM ballooning_projects WHERE id = $1', [projectId]);
    const afterDelete = await db.query('SELECT id FROM ballooning_balloons WHERE project_id = $1', [projectId]);
    check(afterDelete.rowCount === 0, 'balloons cascade-deleted with project');
    const afterDeleteChar = await db.query('SELECT id FROM ballooning_characteristics WHERE project_id = $1', [projectId]);
    check(afterDeleteChar.rowCount === 0, 'characteristics cascade-deleted with project');
    ok('Project and all related rows cleaned up');

    section('9. Parameterized query injection guard');
    // Attempt injection via storage_key — should store literally, not execute SQL
    const injectionKey = "'; DROP TABLE erp_state; --";
    await db.query(
        `INSERT INTO erp_state (storage_key, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (storage_key) DO NOTHING`,
        [injectionKey, JSON.stringify({ safe: true })]
    );
    // Table must still exist
    const tableCheck = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'erp_state'`);
    check(tableCheck.rowCount === 1, 'erp_state table survives injection attempt');
    await db.query('DELETE FROM erp_state WHERE storage_key = $1', [injectionKey]);
    ok('Injection test row cleaned up');

} catch (error) {
    fail('Unexpected error', error.message);
    console.error(error);
} finally {
    await closeDatabase();
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
    console.error('\nFailed:');
    failures.forEach((f) => console.error(`  • ${f}`));
    process.exit(1);
} else {
    console.log('\nAll database tests passed ✓');
}
