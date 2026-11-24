/**
 * Headless UI smoke check for Store > Items to Review row actions.
 * Asserts that Review/View, Edit and Delete render on every row, that Edit
 * deep-links to the Production requirement editor, that Delete cancels then
 * removes a submitted requirement, that a Completed requirement is refused and
 * that a Store-only user gets a clear permission message.
 *
 * Run:  node tests/store-item-reqs-ui.mjs
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
const PORT = 4338;

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

const profile = mkdtempSync(join(tmpdir(), 'sir-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9338`, `--user-data-dir=${profile}`,
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
      const res = await fetch('http://127.0.0.1:9338/json/list');
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
        if (!localStorage.getItem('erp_auth')) {
          localStorage.setItem('erp_auth', JSON.stringify({
            isLoggedIn: true, username: 'Ravi Admin', email: 'admin@pragmatic.test',
            roleKey: 'admin', department: 'Admin'
          }));
        }
        set('employees', [{ employeeId: 'E10', name: 'Ravi Kumar', department: 'Production Department', role: 'Production Manager', roleKey: 'production_manager' }]);
        set('inventoryItems', [{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100 }]);
        set('productionRequirements', [
          {
            requirementNumber: 'PR-000011', requirementDate: '2026-10-06',
            projectId: 'PE-2627-0011', soNumber: 'SO-261006-640', jobCardNumber: '',
            customer: 'ACME Controls', partName: 'Bracket', productionJob: '', drawingNo: 'DWG-01',
            qty: 10, requiredDate: '2026-10-20', status: 'Pending Review',
            createdBy: 'Ravi Kumar', submittedAt: '2026-10-06 10:00:00',
            items: [{ itemId: 'I1', itemName: 'MS Plate 10mm', itemCode: 'RAW-001', unit: 'Nos', quantity: 10 }],
            history: [], attachments: []
          },
          {
            requirementNumber: 'PR-000012', requirementDate: '2026-10-06',
            projectId: 'PE-2627-0012', soNumber: '', jobCardNumber: '',
            customer: 'ACME Controls', partName: 'Shaft', productionJob: '', drawingNo: '',
            qty: 4, requiredDate: '2026-10-25', status: 'Completed',
            createdBy: 'Ravi Kumar', completedAt: '2026-10-06 12:00:00',
            items: [{ itemId: 'I1', itemName: 'MS Plate 10mm', itemCode: 'RAW-001', unit: 'Nos', quantity: 4 }],
            history: [], attachments: []
          }
        ]);
        ['notifications', 'storeAuditLog', 'productionRequirementsSequence', 'purchaseIndents']
          .forEach((k) => { if (!localStorage.getItem(k)) set(k, []); });
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
  const rowButtons = () => evaluate(`
    [...document.querySelectorAll('.history-table tbody tr')]
      .map(r => [...r.querySelectorAll('button')].map(b => b.textContent.trim()).join('+'))
      .filter(s => s.length > 0)
      .join('|')
  `);
  const clickButton = async (label, { index = 0 } = {}) => {
    const ok = await evaluate(`
      (() => {
        const matches = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!matches[${index}]) return false;
        matches[${index}].click();
        return true;
      })()
    `);
    if (!ok) throw new Error(`button not found: ${label}`);
    await sleep(900);
  };

  /* ---------------------------- 1. row actions ---------------------------- */
  console.log('\n== 1. Row actions');
  await goto('/store/item-requirements');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Items to Review'), 'the page renders');
  const rows = await rowButtons();
  check(
    rows === 'Review+Edit+Delete|View+Edit+Delete',
    `both rows render Review/View, Edit and Delete (${rows})`
  );

  /* ---------------------------- 2. edit deep link ---------------------------- */
  console.log('\n== 2. Edit opens the Production editor');
  await clickButton('Edit', { index: 0 });
  await sleep(800);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the editor', pageErrors.join(' | '));
  check(
    t.includes('PR-000011') || t.includes('PE-2627-0011'),
    'the requirement editor loaded',
    t.slice(0, 200)
  );
  const statusAfterEdit = await evaluate(
    `JSON.parse(localStorage.getItem('productionRequirements')).find(r => r.requirementNumber === 'PR-000011').status`
  );
  check(statusAfterEdit === 'Draft', `the requirement was re-opened as a Draft (${statusAfterEdit})`);

  /* ---------------------------- 3. delete a submitted row ---------------------------- */
  console.log('\n== 3. Delete cancels then removes');
  await goto('/store/item-requirements');
  await clickButton('Delete', { index: 0 });
  await sleep(700);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception deleting', pageErrors.join(' | '));
  check(t.includes('PR-000011 deleted'), 'the success message is shown');
  const remaining = await evaluate(
    `JSON.parse(localStorage.getItem('productionRequirements')).map(r => r.requirementNumber).join(',')`
  );
  check(remaining === 'PR-000012', `only the Completed requirement remains (${remaining})`);
  const rowsAfter = await rowButtons();
  check(!rowsAfter.includes('PR-000011'), 'the deleted row is gone', rowsAfter);

  /* ---------------------------- 4. Completed is refused ---------------------------- */
  console.log('\n== 4. Delete on a Completed requirement');
  await clickButton('Delete', { index: 0 });
  await sleep(600);
  t = await text();
  check(t.includes('Completed and cannot be deleted'), 'the refusal message is shown');
  const stillThere = await evaluate(
    `JSON.parse(localStorage.getItem('productionRequirements')).map(r => r.requirementNumber).join(',')`
  );
  check(stillThere === 'PR-000012', `the Completed requirement was kept (${stillThere})`);

  /* ---------------------------- 5. Store user permission message ---------------------------- */
  console.log('\n== 5. Store user sees the permission message');
  await evaluate(`
    localStorage.setItem('erp_auth', JSON.stringify({
      isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
      roleKey: 'store_manager', department: 'Store Department'
    }))
  `);
  await goto('/store/item-requirements');
  await clickButton('Edit', { index: 0 });
  await sleep(500);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception for the Store user', pageErrors.join(' | '));
  check(
    t.includes('Only the Production Manager'),
    'a clear permission message is shown instead of a silent failure'
  );
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
console.log('Store Item Requirements UI OK');
