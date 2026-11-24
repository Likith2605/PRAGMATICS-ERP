/**
 * Headless UI check for Store > Issues > "Pending Requests".
 *
 * Verifies that incoming Material Requests reach /store/issues, that the store
 * person can enter the receiver name, Job Card, PO Number and Customer Name at
 * issue time, and that those references land on the Store Issue slip while the
 * Material Request itself stays untouched.
 *
 * Run:  node tests/store-pending-requests-ui.mjs   (requires: npm run build)
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
const PORT = 4331;

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

const profile = mkdtempSync(join(tmpdir(), 'pend-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9341`, `--user-data-dir=${profile}`,
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
      const res = await fetch('http://127.0.0.1:9341/json/list');
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
        /* Navigations reload the document — never wipe what was already issued. */
        if (localStorage.getItem('__pend_seeded')) return;
        const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem('erp_auth', JSON.stringify({
          isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
          roleKey: 'store_manager', department: 'Store Department'
        }));
        set('employees', [
          { employeeId: 'E1', name: 'Suresh Store', department: 'Store Department', designation: 'Store Manager', roleKey: 'store_manager' },
          { employeeId: 'E2', name: 'Ravi Fitter', department: 'Production', designation: 'Fitter', roleKey: 'production_employee' }
        ]);
        set('inventoryItems', [{ itemCode: 'RAW-001', itemName: 'MS Plate 6mm', unit: 'Nos', currentQty: 100, reservedQty: 0 }]);
        set('productionJobCards', [{
          jobCardNumber: 'JC-2026-001', salesOrderRef: 'SO-2026-001', projectId: 'PRJ-001',
          projectName: 'Alpha Line', customerName: 'ACME Controls', partName: 'Bracket'
        }]);
        set('salesOrderHistory', [{
          date: '2026-09-10', reference: 'SO-2026-001', company: 'ACME Controls',
          payload: { soDetails: { customerPoNumber: 'PO-CUST-42' }, customerDetails: { companyName: 'ACME Controls' } }
        }]);
        set('materialRequests', [{
          mrNumber: 'MR-000001', materialRequestId: 'MR-000001',
          requestDate: '2026-09-12', requiredDate: '2026-09-20',
          jobCardNumber: 'JC-2026-001', jobCardId: 'JC-2026-001',
          salesOrderRef: 'SO-2026-001', salesOrderId: 'SO-2026-001', customer: 'ACME Controls',
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
        localStorage.setItem('__pend_seeded', '1');
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
  const inputValue = (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).value ?? null`);

  /* ------------------------------ 1. the queue ------------------------------ */
  console.log('\n== 1. Pending Requests tab on /store/issues');
  await goto('/store/issues');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Store Issue Register'), 'the existing register still renders first');
  let labels = await buttonLabels();
  check(labels.includes('Pending Requests'), 'a Pending Requests tab is rendered', labels);

  await clickButton('Pending Requests', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the queue', pageErrors.join(' | '));
  check(t.includes('Pending Material Requests'), 'the pending queue renders');
  check(t.includes('MR-000001'), 'the incoming Material Request is listed');
  check(t.includes('JC-2026-001'), 'the Job Card cell is shown');
  check(t.includes('PO-CUST-42'), 'the Customer PO is derived from the Sales Order', 'PO-CUST-42');
  check(t.includes('ACME Controls'), 'the customer column is shown');
  check(t.includes('Ravi (E2)'), 'the requester column is shown');
  const row = await evaluate(`[...document.querySelectorAll('.history-table tbody tr')].map(r => r.innerText).join('|')`);
  check(row.includes('MS Plate 6mm · bal 10 Nos'), 'the pending balance per line is shown', row);

  /* ------------------------- 2. the issue entry form ------------------------ */
  console.log('\n== 2. Issue entry form carries name / Job Card / PO / Customer');
  await clickButton('Issue', { exact: true });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the form', pageErrors.join(' | '));
  check(t.includes('Issue Material — MR-000001'), 'the issue form header renders');
  check(t.includes('Issue References'), 'the reference block renders');
  check(t.includes('Receiver Name / ID'), 'the receiver (name) block renders');
  check(await inputValue('input[placeholder="e.g. JC-0001"]') === 'JC-2026-001', 'Job Card is prefilled from the MR');
  check(await inputValue('input[placeholder="Customer PO number"]') === 'PO-CUST-42', 'PO Number is prefilled from the Sales Order');
  check(await inputValue('input[placeholder="Customer the material is going out for"]') === 'ACME Controls', 'Customer Name is prefilled from the MR');
  check(
    await evaluate(`Boolean(document.querySelector('input[placeholder="Lot No"]'))`),
    'the issue form offers a manual Lot No field'
  );

  /* store person corrects the references the way they read the paperwork */
  await setInput('input[placeholder="Customer PO number"]', 'PO-7788');
  await setInput('input[placeholder="Customer the material is going out for"]', 'ACME Controls Pvt Ltd');
  await setInput('input[placeholder="Lot No"]', 'LOT-UI-1');

  /* ------------------------------ 3. receiver ------------------------------ */
  console.log('\n== 3. Receiver picked from the Employee Master + acknowledgement');
  await evaluate(`
    (() => {
      const el = document.querySelector('input[placeholder^="Search employee"]');
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'Suresh');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(700);
  const picked = await evaluate(`
    (() => {
      const opt = document.querySelector('.employee-search-option');
      if (!opt) return false;
      opt.click();
      return true;
    })()
  `);
  check(picked, 'the employee dropdown offers the seeded employee');
  await sleep(600);
  t = await text();
  check(t.includes('Suresh Store (E1)'), 'the receiver is shown as E1 · name', t.slice(0, 400));

  const ackTick = await evaluate(`
    (() => {
      const cb = document.querySelector('.acknowledgement-box input');
      if (!cb || cb.checked) return Boolean(cb);
      cb.click();
      return cb.checked;
    })()
  `);
  check(ackTick === true, 'the receiver acknowledgement checkbox can be ticked');

  /* ------------------------------ 4. submit ------------------------------ */
  console.log('\n== 4. Submit issues the material and stamps the references');
  await clickButton('Issue Material', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception submitting', pageErrors.join(' | '));
  check(/Store Issue SI-\d+ created for MR-000001/.test(t), 'a success flash names the new Store Issue', t.slice(0, 400));
  check(t.includes('Production has been notified'), 'Production notification is confirmed on screen');

  const stored = await evaluate(`JSON.parse(localStorage.getItem('storeIssueHistory'))[0]`);
  check(stored && stored.poNumber === 'PO-7788', 'the Store Issue keeps the entered PO Number', JSON.stringify(stored && stored.poNumber));
  check(stored && stored.customer === 'ACME Controls Pvt Ltd', 'the Store Issue keeps the entered Customer Name', JSON.stringify(stored && stored.customer));
  check(stored && stored.jobCardNumber === 'JC-2026-001', 'the Store Issue keeps the entered Job Card', JSON.stringify(stored && stored.jobCardNumber));
  check(stored && stored.receivedBy === 'Suresh Store', 'the Store Issue records the receiver name', JSON.stringify(stored && stored.receivedBy));
  check(
    stored && stored.items?.[0]?.lotNumber === 'LOT-UI-1',
    'the Lot No typed on the issue screen is stored on the issue line',
    JSON.stringify(stored && stored.items?.[0]?.lotNumber)
  );
  const outTxRow = await evaluate(
    `(JSON.parse(localStorage.getItem('stockTransactions') || '[]').find(t => t.reference === ${JSON.stringify(stored?.issueNumber || '')}) || null)`
  );
  check(
    outTxRow?.lotNumber === 'LOT-UI-1',
    'the outward stock transaction carries the lot',
    JSON.stringify(outTxRow && outTxRow.lotNumber)
  );

  const mr = await evaluate(`JSON.parse(localStorage.getItem('materialRequests'))[0]`);
  check(mr.customer === 'ACME Controls', 'the Material Request customer is NOT rewritten', mr.customer);
  check(mr.poNumber === undefined, 'the Material Request gains no PO Number', String(mr.poNumber));
  check(mr.jobCardNumber === 'JC-2026-001', 'the Material Request job card is untouched', mr.jobCardNumber);
  check(mr.status === 'Partially Issued' || mr.status === 'Fully Issued', 'the MR lifecycle moved on as before', mr.status);

  /* --------------------------- 5. register shows PO ------------------------- */
  console.log('\n== 5. The register reads back the entered PO');
  await clickButton('Register', { exact: true });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception returning to the register', pageErrors.join(' | '));
  check(t.includes('PO-7788'), 'the new issue row shows the entered PO Number');
  const headers = await evaluate(`[...document.querySelectorAll('.history-table th')].map(h => h.textContent.trim()).join('|')`);
  check(headers.includes('PO No'), 'the register has a PO No column', headers);

  await clickButton('View');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the slip', pageErrors.join(' | '));
  check(t.includes('LOT-UI-1'), 'the Store Issue slip prints the Lot No');
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
console.log('Store Pending Requests UI OK');
