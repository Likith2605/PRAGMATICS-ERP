import 'dotenv/config';
import { spawn } from 'node:child_process';
import { closeDatabase, runMigrations, getPool } from '../server/database.js';

if (!process.env.DATABASE_URL) {
    console.log('SKIP PostgreSQL integration test: DATABASE_URL is not configured.');
    process.exit(0);
}

const PORT = 3311;
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server.js'], {
    env: {...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = async(path, options) => {
    const response = await fetch(`${base}${path}`, options);
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
    return body;
};

try {
    await runMigrations();
    await closeDatabase();
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const health = await request('/api/health');
            ready = health.database?.connected === true;
            if (ready) break;
        } catch { /* server is still starting */ }
        await sleep(250);
    }
    if (!ready) throw new Error(`PostgreSQL API did not become ready. ${output}`);

    const existingState = await request('/api/state');
    const previousSettings = existingState.records.companySettings || {};
    await request('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: { companySettings: {...previousSettings, __postgresTest: true } } })
    });
    const synchronizedState = await request('/api/state');
    if (synchronizedState.records.companySettings?.__postgresTest !== true) throw new Error('ERP state synchronization failed');
    await request('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: { companySettings: previousSettings } })
    });

    const project = await request('/api/ballooning/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drawingNumber: `TEST-${Date.now()}`, partName: 'Integration test' })
    });
    const balloon = await request(`/api/ballooning/projects/${project._id}/balloons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: 1, text: '10 ± 0.1', x: 0.25, y: 0.5 })
    });
    const balloons = await request(`/api/ballooning/projects/${project._id}/balloons`);
    if (balloons.length !== 1 || balloons[0]._id !== balloon._id) throw new Error('Balloon CRUD verification failed');
    await request(`/api/ballooning/projects/${project._id}`, { method: 'DELETE' });
    console.log('PostgreSQL integration test passed: migrations, health, project, balloon CRUD, cascade delete.');
} finally {
    child.kill();
    await closeDatabase();
}