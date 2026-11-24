/**
 * Headless UI smoke check for the Store > Material Requests queue.
 * Verifies the row action buttons (View / Edit / Delete), the inline edit form
 * and the delete flow, including the `material_request.edit` permission.
 *
 * Run:  node tests/material-requests-ui.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_SERVER_ISOLATION_SCRIPT } from './helpers/liveServerIsolation.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4327;

let passed = 0;
let failed = 0;
const failures = [];
const check = (cond, label, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} ${extra}`);
    console.log(`  FAIL ${label} ${extra}`);
  }
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(DIST, normalize(url).replace(/^([/\\])+/, ''));
  if (!existsSync(file) || url === '/') file = join(DIST, 'index.html');
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const profile = mkdtempSync(join(tmpdir(), 'mr-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9335`, `--user-data-dir=${profile}`,
  '--window-size=1600,1100', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:9335/json/list');
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became available');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? '')})`));
      else resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
${LIVE_SERVER_ISOLATION_SCRIPT}
      (() => {
        const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem('erp_auth', JSON.stringify({
          isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
          roleKey: 'store_manager', department: 'Store Department'
        }));
        set('employees', [{ employeeId: 'E1', name: 'Suresh Store', department: 'Store Department', role: 'Store Manager', roleKey: 'store_manager' }]);
        set('inventoryItems', [{ itemCode: 'RAW-001', itemName: 'MS Plate 6mm', unit: 'Nos', currentQty: 100 }]);
        set('materialRequests', [{
          mrNumber: 'MR-000001', materialRequestId: 'MR-000001',
          requestDate: '2026-09-12', requiredDate: '2026-09-20',
          jobCardNumber: 'JC-2026-001', jobCardId: 'JC-2026-001',
          salesOrderRef: '', salesOrderId: '', customer: 'ACME Controls',
          partName: 'Bracket', drawingNumber: 'DWG-01',
          productionDepartment: 'Production', requestedBy: 'Ravi', requestedByEmpId: 'E2',
          priority: 'Normal', remarks: 'Line build', projectId: 'PRJ-001', projectName: 'Alpha Line',
          status: 'Approved',
          items: [{
            materialId: 'RAW-001', itemId: 'I1', materialName: 'MS Plate 6mm', unit: 'Nos',
            requiredQty: 10, termsRequiredQty: 0, sourceType: 'ADDITIONAL', reason: 'Line build',
            createdBy: 'Ravi'
          }],
          history: []
        }]);
      })();
    `
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const goto = async (path) => {
    pageErrors.length = 0;
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}` });
    await sleep(1800);
  };

  const text = () => evaluate('document.body.innerText');
  const buttonLabels = () => evaluate(
    `[...document.querySelectorAll('button')].map(b => b.textContent.trim()).join('|')`
  );
  const clickButton = async (label, { exact = true, index = 0 } = {}) => {
    const ok = await evaluate(`
      (() => {
        const all = [...document.querySelectorAll('button')];
        const matches = all.filter(b => ${exact ? `b.textContent.trim() === ${JSON.stringify(label)}` : `b.textContent.includes(${JSON.stringify(label)})`});
        if (!matches[${index}]) return false;
        matches[${index}].click();
        return true;
      })()
    `);
    if (!ok) throw new Error(`button not found: ${label}`);
    await sleep(900);
  };
  const setInput = async (selector, value) => {
    const ok = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    if (!ok) throw new Error(`input not found: ${selector}`);
    await sleep(400);
  };

  /* ------------------------------ 1. queue actions ------------------------------ */
  console.log('\n== 1. Request Queue shows View / Edit / Delete');
  await goto('/store/material-requests');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Request Queue'), 'the Request Queue tab renders');
  check(t.includes('MR-000001'), 'the seeded request is listed');
  const labels = await buttonLabels();
  check(labels.includes('|View'), 'a View button is rendered');
  check(labels.includes('|Edit'), 'an Edit button sits next to View');
  check(labels.includes('|Delete'), 'a Delete button sits next to View');
  check(!labels.includes('|Process|'), 'the old Process label is gone');

  /* ------------------------------ 2. edit ------------------------------ */
  console.log('\n== 2. Edit opens the inline form and saves');
  await clickButton('Edit');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the editor', pageErrors.join(' | '));
  check(t.includes('Edit Material Request MR-000001'), 'the edit form header renders');
  check(t.includes('Material Lines'), 'the material lines table renders');
  check(await buttonLabels().then((l) => l.includes('|Save Changes|')), 'a Save Changes button is rendered');
  await setInput('input[type=number]', '15');
  await clickButton('Save Changes');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception saving', pageErrors.join(' | '));
  check(t.includes('Material Request MR-000001 updated'), 'a success flash message is shown');
  check(t.includes('Request Queue'), 'the queue is shown again after saving');
  const storedQty = await evaluate(`JSON.parse(localStorage.getItem('materialRequests'))[0].items[0].requiredQty`);
  check(storedQty === 15, `the edited quantity was persisted (${storedQty})`);

  /* ------------------------------ 3. delete ------------------------------ */
  console.log('\n== 3. Delete removes the request');
  await clickButton('Delete');
  await sleep(600);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception deleting', pageErrors.join(' | '));
  check(t.includes('Material Request MR-000001 deleted'), 'a delete confirmation flash message is shown');
  const remaining = await evaluate(`JSON.parse(localStorage.getItem('materialRequests')).length`);
  check(remaining === 0, `the request was removed from storage (${remaining})`);
  const rows = await evaluate(`[...document.querySelectorAll('.history-table tbody tr')].map(r => r.innerText).join('|')`);
  check(!rows.includes('MR-000001'), 'the queue row is gone', rows);
} catch (err) {
  failed += 1;
  failures.push(String(err.message || err));
  console.log('  FAIL', err.message || err);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log('Material Requests UI OK');
