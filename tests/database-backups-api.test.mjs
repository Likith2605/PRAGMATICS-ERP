import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing DATABASE_URL.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing PostgreSQL backup tests outside vyavastha_test.');
}
if (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD) {
  throw new Error('ERP Admin test credentials are required.');
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing database-writing tests: current_database() is not exactly vyavastha_test.');
}

const port = await new Promise((resolve, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const { port: selected } = listener.address();
    listener.close((error) => error ? reject(error) : resolve(selected));
  });
});
const base = `http://127.0.0.1:${port}`;
const backupDirectory = await mkdtemp(join(tmpdir(), 'erp-postgres-backup-test-'));
const suffix = randomUUID();
let child;
let token = '';
let assertions = 0;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  assertions += 1;
  console.log(`PASS ${message}`);
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const api = async (path, options = {}, auth = token) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}`, 'X-ERP-Department': 'Admin' } : {}),
      ...(options.headers || {})
    }
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    response
  };
};
const start = async () => {
  const env = {
    ...process.env,
    ERP_TEST_MODE: '1',
    ERP_TEST_DATABASE_URL: databaseUrl,
    ERP_POSTGRES_BACKUP_DIR: backupDirectory,
    ERP_ALLOW_POSTGRES_RESTORE: 'true',
    ERP_POSTGRES_RESTORE_MAINTENANCE_CONFIRMED: 'true',
    PORT: String(port)
  };
  delete env.DATABASE_URL;
  child = spawn(process.execPath, ['server.js'], { env, stdio: 'ignore' });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready) return;
    } catch { /* Wait for the isolated test server to start. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated PostgreSQL backup test server did not become ready.');
};
const stop = async () => {
  if (!child) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
};
const login = async () => (await api(
  '/api/auth/login',
  json('POST', { email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }),
  ''
)).body.token;

try {
  await start();
  assert((await api('/api/database-backups/status', {}, '')).status === 401, 'Backup status rejects unauthenticated reads');
  token = await login();
  assert(Boolean(token), 'Admin session authenticates');

  const status = await api('/api/database-backups/status');
  assert(status.status === 200 && /^[a-f0-9]{64}$/i.test(status.body.identityFingerprint), 'Backup status returns only a database identity fingerprint');
  assert(status.body.backupDirectoryConfigured, 'Backup storage is configured for the isolated test server');
  assert(status.body.restoreEnabled === false, 'Restore remains disabled in test mode despite the enable flag');

  const created = await api('/api/database-backups', json('POST', {}));
  assert(created.status === 201 && created.body.backup?.integrityStatus === 'VERIFIED', 'A full isolated PostgreSQL dump is created and structurally verified');
  const backupId = created.body.backup.id;
  assert(Number(created.body.backup.byteSize) > 0, 'Backup metadata records a non-empty artifact and size');

  const listing = await api('/api/database-backups');
  assert(listing.status === 200 && listing.body.records.some((entry) => entry.id === backupId), 'Backup history lists the generated backup');

  const verification = await api(`/api/database-backups/${backupId}/verify`, json('POST', {}));
  assert(verification.status === 200 && verification.body.backup.integrityStatus === 'VERIFIED'
    && verification.body.backup.verifiedBy === process.env.ERP_ADMIN_EMAIL,
  'Integrity API verifies checksum/archive structure and records the verifying Admin');

  const download = await fetch(`${base}/api/database-backups/${backupId}/download`, {
    headers: { Authorization: `Bearer ${token}`, 'X-ERP-Department': 'Admin' }
  });
  assert(download.status === 200 && (await download.arrayBuffer()).byteLength === Number(created.body.backup.byteSize), 'Authorized download returns the exact backup artifact');

  await writeFile(join(backupDirectory, `${backupId}.dump`), `tampered-${suffix}`);
  const tampered = await api(`/api/database-backups/${backupId}/verify`, json('POST', {}));
  assert(tampered.status === 409, 'Modified backup is rejected by checksum verification');
  const failedHistory = await api('/api/database-backups');
  assert(failedHistory.body.records.find((entry) => entry.id === backupId)?.integrityStatus === 'FAILED', 'Backup history records failed integrity status');

  const restore = await api(`/api/database-backups/${backupId}/restore`, json('POST', {
    confirmation: `RESTORE ${backupId}`,
    identityFingerprint: status.body.identityFingerprint,
    reason: 'Confirm test-mode safety guard'
  }));
  assert(restore.status === 403, 'Restore is denied in test mode and is not executed');

  const after = await pool.query('SELECT current_database() AS name');
  assert(after.rows[0]?.name === 'vyavastha_test', 'All test database access remains restricted to vyavastha_test');
  console.log(`RESULT: ${assertions} passed, 0 failed; no restore operation was executed.`);
} finally {
  await stop();
  if (token) {
    await pool.query(
      'UPDATE erp_sessions SET revoked_at=now() WHERE token_hash=$1',
      [createHash('sha256').update(token).digest('hex')]
    ).catch(() => {});
  }
  await pool.end();
  await rm(backupDirectory, { recursive: true, force: true });
}
