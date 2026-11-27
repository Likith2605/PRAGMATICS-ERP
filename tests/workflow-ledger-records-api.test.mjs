/** Isolated PostgreSQL API test for workflow-ledger per-record authority. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) !== 'vyavastha_test') {
    throw new Error('Refusing workflow-ledger tests outside vyavastha_test.');
}
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) {
    throw new Error('ERP Admin test credentials are required.');
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
    await pool.end();
    throw new Error('Refusing DB writes: current_database() is not exactly vyavastha_test.');
}

const port = Number(process.env.ERP_WORKFLOW_RECORDS_TEST_PORT || 3394);
const base = `http://127.0.0.1:${port}`;
const prefix = `WFTEST-${randomUUID().slice(0, 8)}`;
const fixtureIds = {
    materialArrivals: `${prefix}-ARR`,
    qualityChecks: `${prefix}-QC`,
    rejectionReports: `${prefix}-RR`
};
let child;
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
        headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}),
            ...(options.headers || {})
        }
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const start = async () => {
    const env = { ...process.env, ERP_TEST_MODE: '1', ERP_TEST_DATABASE_URL: databaseUrl, PORT: String(port) };
    delete env.DATABASE_URL;
    child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
    for (let n = 0; n < 100; n += 1) {
        try {
            const health = await (await fetch(`${base}/api/health`)).json();
            if (health.ready && health.database?.migrations?.some((m) => m.version === '005_module_records')) return;
        } catch { /* server is still starting */ }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Isolated workflow-ledger server did not become ready.');
};
const stop = async () => {
    if (!child) return;
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    child = null;
};
const login = async () => (await api('/api/auth/login', json('POST', {
    email: process.env.ERP_ADMIN_EMAIL,
    password: process.env.ERP_ADMIN_PASSWORD,
    portal: 'admin'
}), '')).body.token;

const fixtureData = (key, id) => ({
    id,
    status: 'Pending',
    testFixture: prefix,
    items: [],
    ...(key === 'materialArrivals' ? { arrivalNumber: id, arrivalDate: '2026-11-26' } : {}),
    ...(key === 'qualityChecks' ? { qcNumber: id, inspectionType: 'Arrival Inspection' } : {}),
    ...(key === 'rejectionReports' ? { rejectionNumber: id, rejectedQty: 0 } : {})
});

try {
    await start();
    token = await login();
    assert(Boolean(token), 'Administrator session authenticates');
    assert((await api('/api/records/qualityChecks', {}, '')).status === 401, 'Unauthenticated workflow-ledger reads are rejected');

    for (const key of Object.keys(fixtureIds)) {
        const id = fixtureIds[key];
        const created = await api(`/api/records/${key}`, json('PUT', {
            records: [{ id, data: fixtureData(key, id), version: 0 }],
            deletes: [],
            reason: 'Automated isolated verification',
            updatedBy: 'workflow-ledger-records.test'
        }));
        assert(created.status === 200 && (created.body.saved || []).some((row) => row.id === id), `${key} is created in PostgreSQL per-record storage`);

        const listed = await api(`/api/records/${key}`);
        assert((listed.body.records || []).some((row) => row.id === id && row.version >= 1), `${key} is read from authoritative per-record storage`);

        const stale = await api(`/api/records/${key}`, json('PUT', {
            records: [{ id, data: { ...fixtureData(key, id), remarks: 'stale' }, version: 0 }],
            deletes: [],
            updatedBy: 'workflow-ledger-records.test'
        }));
        assert((stale.body.conflicts || []).some((row) => row.id === id), `${key} stale version returns the server copy as a conflict`);

        const current = await pool.query('SELECT version FROM module_records WHERE storage_key=$1 AND record_id=$2', [key, id]);
        assert(Number(current.rows[0].version) === 1, `${key} server version was not overwritten by a stale write`);

        const updated = await api(`/api/records/${key}`, json('PUT', {
            records: [{ id, data: { ...fixtureData(key, id), remarks: 'confirmed' }, version: 1 }],
            deletes: [],
            updatedBy: 'workflow-ledger-records.test'
        }));
        assert((updated.body.saved || []).some((row) => row.id === id && row.version === 2), `${key} accepts a current-version update`);

        const mirror = await api(`/api/state/${key}`, json('PUT', { data: [] }));
        assert(mirror.status >= 400, `${key} is rejected by the generic whole-key erp_state API`);

        const deleted = await api(`/api/records/${key}`, json('PUT', {
            records: [],
            deletes: [{ id, version: 2, reason: 'Automated isolated verification' }],
            reason: 'Automated isolated verification',
            updatedBy: 'workflow-ledger-records.test'
        }));
        assert(deleted.status === 409, `${key} permanent deletion is blocked by its controlled workflow`);
    }

    console.log(`Workflow ledger per-record PostgreSQL integration: ${assertions} passed, 0 failed.`);
} finally {
    await pool.query('DELETE FROM erp_audit_log WHERE module = ANY($1::text[]) AND record_id LIKE $2', [Object.keys(fixtureIds), `${prefix}%`]);
    await pool.query('DELETE FROM module_records WHERE storage_key = ANY($1::text[]) AND record_id LIKE $2', [Object.keys(fixtureIds), `${prefix}%`]);
    await stop();
    await pool.end();
}
