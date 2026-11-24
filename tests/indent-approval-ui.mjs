/**
 * Headless UI smoke check for the Admin approval chain:
 * Executive Dashboard shows the indent awaiting approval, clicking the action
 * deep-links to that indent's detail, the Admin approves it and Purchase is
 * notified.
 *
 * Run:  node tests/indent-approval-ui.mjs
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
const PORT = 4339;

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

const profile = mkdtempSync(join(tmpdir(), 'ia-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9339`, `--user-data-dir=${profile}`,
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
      const res = await fetch('http://127.0.0.1:9339/json/list');
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
      const isPrompt = m.params.type === 'prompt';
      send('Page.handleJavaScriptDialog', {
        accept: true,
        ...(isPrompt ? { promptText: 'Approved from the UI test' } : {})
      }).catch(() => {});
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
          isLoggedIn: true, username: 'Ravi Admin', email: 'admin@pragmatic.test',
          roleKey: 'admin', department: 'Admin'
        }));
        set('employees', [{ employeeId: 'E20', name: 'Suresh Store', department: 'Store Department', role: 'Store Manager', roleKey: 'store_manager' }]);
        set('inventoryItems', [{ itemCode: 'RAW-002', itemName: 'SS 304 Sheet', unit: 'Nos', currentQty: 0 }]);
        set('purchaseIndents', [
          {
            indentNumber: 'IND-000007', indentDate: '2026-10-06',
            soNumber: 'SO-261006-640', projectId: 'PE-2627-0011',
            customer: 'ACME Controls Pvt Ltd', deliveryDate: '2026-11-15', requiredDate: '2026-11-15',
            reason: 'Shortage against Sales Order material requirement',
            storeRemarks: 'Please approve', purchaseRemarks: '',
            status: 'Submitted',
            items: [{
              materialCode: 'RAW-002', materialName: 'SS 304 Sheet', drawingNo: '', description: '',
              specification: '', unit: 'Nos', requiredQty: 20, orderedQty: 20, availableQty: 0,
              shortageQty: 20, purchaseQty: 20, requiredDate: '2026-11-15',
              reason: 'Shortage against Sales Order', remarks: '', source: 'Sales Order Shortage'
            }],
            additionalRequirements: [], clarifications: [],
            createdBy: 'Suresh Store', createdByEmpId: 'E20', createdByDept: 'Store Department',
            createdAt: '2026-10-06 09:00:00',
            history: [{ action: 'Indent submitted', by: 'Suresh Store', at: '2026-10-06 09:05:00', note: 'Shared with Admin' }],
            adminApprovedAt: '', adminApprovedBy: ''
          }
        ]);
        set('notifications', [{
          id: 'notif-ind-1', title: 'Purchase Indent shared by Store - approval required',
          message: 'Store has shared Purchase Indent IND-000007 for review and approval.',
          type: 'info', reference: 'IND-000007', targetDept: 'Admin', roleKey: '',
          link: '/purchase-indents?indent=IND-000007', at: '2026-10-06 09:05:10', read: false
        }]);
        ['storeAuditLog', 'notificationsSeq'].forEach((k) => { if (!localStorage.getItem(k)) set(k, []); });
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
  const waitForText = async (needle, timeoutMs = 5000) => {
    const start = Date.now();
    let seen = '';
    while (Date.now() - start < timeoutMs) {
      seen = await text();
      if (seen.includes(needle)) return seen;
      await sleep(300);
    }
    return seen;
  };
  const url = () => evaluate('location.pathname + location.search');
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

  /* ---------------------- 1. dashboard surfaces the indent ---------------------- */
  console.log('\n== 1. Executive Dashboard approval block');
  await goto('/');
  let t = await waitForText('Purchase Indents awaiting your approval');
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Executive Dashboard'), 'the Executive Dashboard renders');
  check(t.includes('Purchase Indents awaiting your approval'), 'the approval block is visible');
  t = await waitForText('IND-000007');
  check(t.includes('IND-000007'), 'the shared indent is listed', t.slice(0, 300));
  check(t.includes('Open & Approve'), 'the row offers Open & Approve');

  /* ---------------------- 2. click deep-links to that indent ---------------------- */
  console.log('\n== 2. Open & Approve deep link');
  await clickButton('Open & Approve');
  const at = await url();
  check(at.includes('/purchase-indents'), `the dashboard navigated to Purchase Indents (${at})`);
  t = await waitForText('IND-000007');
  check(pageErrors.length === 0, 'no uncaught exception opening the indent', pageErrors.join(' | '));
  check(t.includes('IND-000007'), 'the indent detail is open', t.slice(0, 300));
  check(t.includes('Approve (Admin)'), 'the Admin approval action is offered on the detail');

  /* ---------------------- 3. approve, then Purchase is notified ---------------------- */
  console.log('\n== 3. Approve');
  await clickButton('Approve (Admin)');
  await sleep(700);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception approving', pageErrors.join(' | '));
  const stored = await evaluate(`JSON.parse(localStorage.getItem('purchaseIndents'))[0]`);
  check(Boolean(stored.adminApprovedAt), `approval timestamp recorded (${stored.adminApprovedAt})`);
  check(stored.adminApprovedBy === 'Ravi Admin', `approval recorded against the Admin (${stored.adminApprovedBy})`);
  check(
    stored.adminApprovedRemarks === 'Approved from the UI test',
    `the prompt remarks were stored (${stored.adminApprovedRemarks})`
  );
  const note = await evaluate(`
    JSON.parse(localStorage.getItem('notifications')).find(
      n => n.targetDept === 'Purchase Department' && n.reference === 'IND-000007'
    )
  `);
  check(Boolean(note), 'Purchase Department was notified');
  check(
    Boolean(note) && note.link === '/purchase-indents?indent=IND-000007',
    `the notification deep-links to the indent (${note && note.link})`
  );
  const audit = await evaluate(`
    JSON.parse(localStorage.getItem('storeAuditLog') || '[]').some(
      a => a.action === 'PURCHASE INDENT APPROVED BY ADMIN'
    )
  `);
  check(audit, 'the approval was written to the audit log');
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
console.log('Indent approval UI OK');
