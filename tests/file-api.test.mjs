/**
 * File storage API test (/api/files → file_blobs table)
 *
 * Verifies the Phase-1 "files live in PostgreSQL" path:
 *   upload → read back (byte-identical) → list → delete → gone,
 *   plus input validation and a sanity check that /api/state still works
 *   after mounting the new router in server.js.
 *
 * Usage: node tests/file-api.test.mjs   (DATABASE_URL required)
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  console.log('SKIP: DATABASE_URL is not configured.');
  process.exit(0);
}

const PORT = 3324;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let adminToken = '';
const failures = [];

const ok = (label) => { passed++; console.log(`  ✓  ${label}`); };
const fail = (label, detail = '') => {
  failed++;
  failures.push(`${label}${detail ? ': ' + detail : ''}`);
  console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, label, detail = '') => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n── ${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
};

let serverProcess = null;
const startServer = () =>
  new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', () => {});
    serverProcess.stderr.on('data', () => {});
    serverProcess.on('error', reject);
    setTimeout(resolve, 800);
  });

const stopServer = () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
};

const FILE_ID = `wf-test-${Date.now()}`;
const CONTENT = 'Hello PostgreSQL file storage — नमस्ते 123';
const CONTENT_B64 = Buffer.from(CONTENT, 'utf8').toString('base64');

try {
  section('1. Start server & health');
  await startServer();
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const h = await request('/api/health');
      if (h.ok && h.data?.database?.connected) { ready = true; break; }
    } catch { /* waiting */ }
    await sleep(200);
  }
  check(ready, 'Server up and PostgreSQL connected');
  const login = await request('/api/auth/login', { method: 'POST', headers: {}, body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  check(login.ok && login.data?.token, 'Admin login returns server token');
  adminToken = login.data?.token || '';

  section('2. file_blobs table exists');
  const list0 = await request('/api/files');
  check(list0.ok && Array.isArray(list0.data.files), 'GET /api/files returns file list (table reachable)');

  section('3. Upload file');
  const put = await request(`/api/files/${FILE_ID}`, {
    method: 'PUT',
    body: JSON.stringify({
      fileName: 'test-attachment.txt',
      mimeType: 'text/plain',
      scope: 'workflow',
      metadata: { origin: 'file-api.test' },
      contentBase64: CONTENT_B64
    })
  });
  check(put.ok && put.data.success, 'PUT /api/files/:id stores the file');
  check(put.data.file?.sizeBytes === Buffer.byteLength(CONTENT, 'utf8'), 'sizeBytes matches decoded length',
    `got ${put.data.file?.sizeBytes}`);

  section('4. Read back');
  const get = await request(`/api/files/${FILE_ID}`);
  check(get.ok, 'GET /api/files/:id succeeds');
  check(get.data.fileName === 'test-attachment.txt', 'fileName round-trips');
  check(get.data.scope === 'workflow', 'scope round-trips');
  check(get.data.metadata?.origin === 'file-api.test', 'metadata round-trips');
  check(get.data.contentBase64 === CONTENT_B64, 'content is byte-identical after storage',
    'base64 mismatch');

  section('5. Overwrite (upsert)');
  const put2 = await request(`/api/files/${FILE_ID}`, {
    method: 'PUT',
    body: JSON.stringify({ fileName: 'test-attachment-v2.txt', mimeType: 'text/plain', scope: 'workflow', contentBase64: CONTENT_B64 })
  });
  const get2 = await request(`/api/files/${FILE_ID}`);
  check(put2.ok && get2.data.fileName === 'test-attachment-v2.txt', 'PUT overwrites existing id (ON CONFLICT UPDATE)');

  section('6. Validation');
  const badId = await request('/api/files/bad id with spaces!', { method: 'PUT', body: JSON.stringify({ contentBase64: CONTENT_B64 }) });
  check(badId.status === 400, 'Invalid id rejected with 400', `got ${badId.status}`);
  const noBody = await request(`/api/files/${FILE_ID}-empty`, { method: 'PUT', body: JSON.stringify({}) });
  check(noBody.status === 400, 'Missing contentBase64 rejected with 400', `got ${noBody.status}`);

  section('7. Delete');
  const del = await request(`/api/files/${FILE_ID}`, { method: 'DELETE', body: JSON.stringify({ reason: 'Remove temporary file test attachment' }) });
  check(del.ok && del.data.deleted === true, 'DELETE removes the file');
  const getGone = await request(`/api/files/${FILE_ID}`);
  check(getGone.status === 404, 'GET after delete returns 404', `got ${getGone.status}`);

  section('8. ERP state API sanity (server.js router re-mount)');
  const state = await request('/api/state');
  check(state.ok && typeof state.data.records === 'object', 'GET /api/state still works alongside /api/files');

} catch (err) {
  fail('Fatal test exception', err.message);
  console.error(err);
} finally {
  stopServer();
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`File API Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`));
}
process.exit(failed === 0 ? 0 : 1);
