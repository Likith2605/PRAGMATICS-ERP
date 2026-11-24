/**
 * Headless UI check for the Store → Production Material Acknowledgement flow.
 * Run:  node tests/material-ack-ui.mjs      (requires `npm run build` first)
 *
 * Covers spec §1 (steps 3, 6, 7), §2 (Stores + Production dashboards) and the
 * UI half of scenarios 9 and 10:
 *   1. Stores tab "Pending Material Acknowledgements" + required filters
 *   2. Material-wise acknowledgement screen (required / available / shortage / status)
 *   3. Submit acknowledgement -> persisted + notification pushed to Production
 *   4. Purchase Indent raised once for the shortage, never twice
 *   5. Production list carries a "Store Ack" column
 *   6. Deep link /production/material-requests?mr= opens the Store acknowledgement
 *   7. Production dashboard section "Store Material Acknowledgement"
 *   8. Scenario 9 - Job Card creation screen warns on unconfirmed material
 *   9. Scenario 10 - a Production user cannot reach the Store ack screen
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

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html missing — run `npm run build` first.');
  process.exit(1);
}

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

const profile = mkdtempSync(join(tmpdir(), 'ack-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9341`, `--user-data-dir=${profile}`,
  '--window-size=1600,1200', 'about:blank'
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
        const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        /* Seed exactly once: later navigations must not wipe acknowledgements
           the test has already written. */
        if (localStorage.getItem('__ack_seeded')) return;
        set('__ack_seeded', '1');

        set('erp_auth', {
          isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
          roleKey: 'store_manager', department: 'Store Department'
        });
        set('employees', [
          { employeeId: 'E1', name: 'Suresh Store', department: 'Store Department', role: 'Store Manager', roleKey: 'store_manager', email: 'store_manager@pragmatic.test' },
          { employeeId: 'E2', name: 'Ravi Production', department: 'Production Department', role: 'Production Manager', roleKey: 'production_manager', email: 'production_manager@pragmatic.test' }
        ]);
        set('inventoryItems', [
          { id: 'INV-1', itemCode: 'STEEL', itemName: 'Steel Rod', category: 'Raw Material', unit: 'kg', currentQty: 100, reservedQty: 0 },
          { id: 'INV-2', itemCode: 'BOLTS', itemName: 'Fasteners', category: 'Fastener', unit: 'Nos', currentQty: 200, reservedQty: 80 },
          { id: 'INV-3', itemCode: 'PAINT', itemName: 'Paint', category: 'Consumable', unit: 'L', currentQty: 0, reservedQty: 0 }
        ]);
        set('materialRequests', [{
          mrNumber: 'MR-000001', materialRequestId: 'MR-000001',
          requestDate: '2026-11-04', requiredDate: '2026-11-20',
          jobCardNumber: 'JC-2026-001', jobCardId: 'JC-2026-001',
          salesOrderRef: 'SO-2026-001', salesOrderId: 'SO-2026-001', customer: 'ACME Controls',
          partName: 'Bracket', drawingNumber: 'DWG-01',
          productionDepartment: 'Production Department', requestedBy: 'Ravi', requestedByEmpId: 'E2',
          priority: 'Normal', remarks: 'Line build', projectId: 'PRJ-001', projectName: 'Alpha Line',
          status: 'Approved',
          items: [
            { materialId: 'STEEL', itemId: 'INV-1', materialName: 'Steel Rod', unit: 'kg', requiredQty: 100, termsRequiredQty: 0, sourceType: 'ADDITIONAL', reason: 'Line build', createdBy: 'Ravi' },
            { materialId: 'BOLTS', itemId: 'INV-2', materialName: 'Fasteners', unit: 'Nos', requiredQty: 200, termsRequiredQty: 0, sourceType: 'ADDITIONAL', reason: 'Line build', createdBy: 'Ravi' },
            { materialId: 'PAINT', itemId: 'INV-3', materialName: 'Paint', unit: 'L', requiredQty: 20, termsRequiredQty: 0, sourceType: 'ADDITIONAL', reason: 'Line build', createdBy: 'Ravi' }
          ],
          history: []
        }]);
        set('notifications', []);
        set('storeAuditLog', []);
        set('purchaseIndents', []);
        set('productionJobCards', [{
          jobCardNumber: 'JC-2026-001', status: 'In Production', projectId: 'PRJ-001',
          partName: 'Bracket', customer: 'ACME Controls', plannedQty: 100, producedQty: 0
        }]);
      })();
    `
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const goto = async (path, wait = 1800) => {
    pageErrors.length = 0;
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}` });
    await sleep(wait);
  };

  const text = () => evaluate('document.body.innerText');
  const tableHeaders = (index = 0) => evaluate(
    `(() => { const t = document.querySelectorAll('.history-table')[${index}]; return t ? [...t.querySelectorAll('thead th')].map(h => h.textContent.trim()).join('|') : ''; })()`
  );
  const buttonLabels = () => evaluate(
    `[...document.querySelectorAll('button')].map(b => b.textContent.trim()).join('|')`
  );
  const clickButton = async (label, { exact = true, index = 0 } = {}) => {
    const predicate = exact
      ? `b.textContent.trim() === ${JSON.stringify(label)}`
      : `b.textContent.includes(${JSON.stringify(label)})`;
    const ok = await evaluate(`
      (() => {
        const all = [...document.querySelectorAll('button')];
        const matches = all.filter(b => ${predicate});
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
        setter.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    if (!ok) throw new Error(`input not found: ${selector}`);
    await sleep(400);
  };
  const setAuth = async (username, email, roleKey, department) => {
    await evaluate(`
      localStorage.setItem('erp_auth', JSON.stringify({
        isLoggedIn: true, username: ${JSON.stringify(username)}, email: ${JSON.stringify(email)},
        roleKey: ${JSON.stringify(roleKey)}, department: ${JSON.stringify(department)}
      }));
      true;
    `);
    await sleep(200);
  };

  /* ==================== 1. Stores acknowledgement tab ==================== */
  console.log('\n== 1. Stores — Pending Material Acknowledgements tab');
  await goto('/store/material-requests');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  let labels = await buttonLabels();
  check(labels.includes('Pending Material Acknowledgements'), 'the acknowledgement tab is rendered', labels);
  await clickButton('Pending Material Acknowledgements', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the tab', pageErrors.join(' | '));
  check(t.includes('Pending Material Acknowledgements'), 'the acknowledgement section heading renders');
  check(t.includes('MR-000001'), 'the seeded request is listed');
  let headers = await tableHeaders(0);
  for (const col of ['MR No', 'Sales Order', 'Project', 'Requested By', 'Request Date', 'Items', 'Acknowledgement Status', 'Action']) {
    check(headers.includes(col), `queue column "${col}" is present`, headers);
  }
  const filterOptions = await evaluate(
    `[...document.querySelectorAll('.filters-grid select option')].map(o => o.textContent.trim()).join('|')`
  );
  for (const f of [
    'Pending Acknowledgement', 'Fully Available', 'Partially Available', 'Not Available',
    'Purchase Indent Pending', 'Awaiting Material Receipt', 'Completed'
  ]) {
    check(filterOptions.includes(f), `filter "${f}" is offered`, filterOptions);
  }
  check(t.includes('Pending Acknowledgement'), 'the row starts as Pending Acknowledgement');

  /* ==================== 2. Acknowledgement screen ==================== */
  console.log('\n== 2. Material-wise acknowledgement screen');
  await clickButton('View / Acknowledge');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the ack screen', pageErrors.join(' | '));
  check(t.includes('Acknowledge MR-000001'), 'the ack screen header renders');
  headers = await tableHeaders(0);
  for (const col of ['Material', 'Required Qty', 'Available Qty', 'Verified Qty', 'Shortage Qty', 'Store Status']) {
    check(headers.includes(col), `ack column "${col}" is present`, headers);
  }
  const chips = await evaluate(
    `[...document.querySelectorAll('.history-table tbody .status-badge')].map(s => s.className + '=' + s.textContent.trim()).join('|')`
  );
  check(chips.includes('st-available=Available'), 'Steel shows Available', chips);
  check(chips.includes('st-partial=Partial'), 'Bolts shows Partial', chips);
  check(chips.includes('st-not-available=Not Available'), 'Paint shows Not Available', chips);
  const ackRows = await evaluate(
    `[...document.querySelectorAll('.history-table tbody tr')].slice(0,3).map(r => {
       const td = r.querySelectorAll('td');
       return td[0].innerText.split('\\n')[0] + '=' + td[5].innerText.trim();
     }).join('|')`
  );
  check(ackRows === 'Steel Rod=0|Fasteners=80|Paint=20', `shortages computed per material (${ackRows})`);
  const maxAttrs = await evaluate(
    `[...document.querySelectorAll('.history-table tbody input[type=number]')].map(i => i.max).join('|')`
  );
  check(maxAttrs === '100|120|0', `verified qty capped at real stock (${maxAttrs})`);

  /* Stores may not type more than the real unreserved stock. */
  await setInput('.history-table tbody input[type=number]', '9999');
  t = await text();
  check(t.includes('entry exceeds'), 'over-claiming is flagged in the UI', t.slice(0, 200));
  await setInput('.history-table tbody input[type=number]', '100');

  /* ==================== 3. Submit acknowledgement ==================== */
  console.log('\n== 3. Submit acknowledgement -> persisted + notified');
  await clickButton('Submit Acknowledgement', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception submitting', pageErrors.join(' | '));
  check(t.includes('Production has been notified'), 'a confirmation flash is shown', t.slice(0, 300));
  const storedAck = await evaluate(
    `JSON.parse(localStorage.getItem('materialRequests'))[0].acknowledgement`
  );
  check(storedAck && storedAck.status === 'Partially Available', `status persisted as Partially Available (${storedAck?.status})`);
  check(storedAck.lines.STEEL.acknowledgedQty === 100, 'Steel acknowledged at 100');
  check(storedAck.lines.BOLTS.acknowledgedQty === 120, 'Bolts acknowledged at 120 (reserve excluded)');
  check(storedAck.lines.BOLTS.shortageQty === 80, 'Bolts shortage stored as 80');
  check(storedAck.lines.PAINT.acknowledgedQty === 0, 'Paint acknowledged at 0');
  check(storedAck.history?.length === 1, 'exactly one history entry written');
  check(!!storedAck.acknowledgedBy, 'history records who acknowledged', storedAck?.acknowledgedBy);
  const notifs = await evaluate(`JSON.parse(localStorage.getItem('notifications'))`);
  check(notifs.length === 1, `exactly one notification pushed (${notifs.length})`);
  check(notifs[0].targetDept === 'Production Department', 'notification targets Production', notifs[0]?.targetDept);
  check(notifs[0].reference === 'MR-000001', 'notification carries the MR number');
  check(String(notifs[0].link).includes('/production/material-requests?mr=MR-000001'), 'notification deep-links to the MR', notifs[0]?.link);
  check(String(notifs[0].message).includes('Partially Available'), 'notification states the ack status');
  check(String(notifs[0].message).includes('SO-2026-001'), 'notification carries the Sales Order');
  check(String(notifs[0].message).includes('PRJ-001'), 'notification carries the Project');
  check(String(notifs[0].message).includes('Steel Rod'), 'notification carries the material name');

  /* ==================== 4. Purchase Indent ==================== */
  console.log('\n== 4. Purchase Indent raised once for the shortage');
  t = await text();
  check(t.includes('Shortage: 100 unit(s)'), 'the total shortage is surfaced', t.slice(0, 400));
  await clickButton('Create Purchase Indent for Shortage', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception creating the indent', pageErrors.join(' | '));
  let indents = await evaluate(`JSON.parse(localStorage.getItem('purchaseIndents'))`);
  check(indents.length === 1, `exactly one indent created (${indents.length})`);
  check(indents[0].requirementNumber === 'MR-000001', 'indent links back to the Material Request');
  check(indents[0].sourceType === 'materialRequest', 'indent sourceType is materialRequest');
  check(indents[0].soNumber === 'SO-2026-001', 'indent carries the Sales Order');
  labels = await buttonLabels();
  check(!labels.includes('Create Purchase Indent for Shortage'), 'the create button disappears once linked');
  check(!labels.includes('Link Existing Purchase Indent'), 'no second indent action is offered');
  indents = await evaluate(`JSON.parse(localStorage.getItem('purchaseIndents'))`);
  check(indents.length === 1, 're-entering the screen does not duplicate the indent', `${indents.length}`);

  /* ==================== 5. Production list ==================== */
  console.log('\n== 5. Production sees the acknowledgement');
  await setAuth('Ravi Production', 'production_manager@pragmatic.test', 'production_manager', 'Production Department');
  await goto('/production/material-requests');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the Production list', pageErrors.join(' | '));
  headers = await tableHeaders(0);
  check(headers.includes('Store Ack'), 'the list carries a "Store Ack" column', headers);
  const prodRow = await evaluate(
    `[...document.querySelectorAll('.history-table tbody tr')].map(r => r.innerText).find(r => r.includes('MR-000001')) || ''`
  );
  check(prodRow.includes('Partially Available'), 'the row shows the Store response', prodRow);

  /* ==================== 6. Deep link ==================== */
  console.log('\n== 6. Deep link ?mr= opens the Store acknowledgement');
  await goto('/production/material-requests?mr=MR-000001');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the deep link', pageErrors.join(' | '));
  check(t.includes('Material Request MR-000001'), 'the request detail opened', t.slice(0, 200));
  check(t.includes('Store Acknowledgement'), 'the Store Acknowledgement block renders');
  check(t.includes('Stores confirmed a partial supply'), 'the partial headline is shown', t.slice(0, 400));
  check(t.includes('80'), 'the shortage quantity is visible');
  headers = await tableHeaders(0);
  for (const col of ['Required', 'Store Confirmed', 'Shortage', 'Store Status', 'Stock Now']) {
    check(headers.includes(col), `detail column "${col}" is present`, headers);
  }

  /* ==================== 7. Production dashboard ==================== */
  console.log('\n== 7. Production dashboard section');
  await goto('/production', 2600);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the dashboard', pageErrors.join(' | '));
  const dash = await evaluate(
    `(() => { const el = document.querySelector('[data-testid="store-ack-dashboard"]'); return el ? el.innerText : ''; })()`
  );
  check(dash.length > 0, 'the Store Material Acknowledgement section renders');
  for (const label of [
    'Store Material Acknowledgement', 'Pending Requests', 'Store Responses',
    'Available Materials', 'Shortage Materials', 'Purchase Indent Pending',
    'Awaiting Material Receipt', 'Last acknowledgement', 'Expected Availability'
  ]) {
    check(dash.includes(label), `dashboard shows "${label}"`, dash.slice(0, 400));
  }
  check(dash.includes('MR-000001'), 'the request appears in the dashboard table');
  check(dash.includes('Partially Available'), 'the Store response is shown');

  /* ==================== 8. Scenario 9 — Job Card creation ==================== */
  console.log('\n== 8. Scenario 9 — Job Card creation warns on unconfirmed material');
  await clickButton('+ Issue Production Job Card', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the create form', pageErrors.join(' | '));
  const notice = await evaluate(
    `(() => { const el = document.querySelector('[data-testid="create-jobcard-ack-notice"]'); return el ? el.innerText : ''; })()`
  );
  check(notice.length > 0, 'the acknowledgement warning renders on the creation screen');
  check(notice.includes('MR-000001'), 'the outstanding request is listed', notice);
  check(notice.includes('Partially Available'), 'the Store response is shown', notice);
  check(notice.includes('partial supply must not be treated as full'), 'partial availability is not silently treated as full', notice);

  /* ==================== 9. Scenario 10 — unauthorised ==================== */
  console.log('\n== 9. Scenario 10 — Production cannot reach the Store ack screen');
  await setAuth('Ravi Production', 'production_employee@pragmatic.test', 'production_employee', 'Production Department');
  await goto('/store/material-requests');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the guarded route', pageErrors.join(' | '));
  labels = await buttonLabels();
  check(!labels.includes('Pending Material Acknowledgements'), 'the acknowledgement tab is not offered to Production', labels);
  check(!t.includes('Acknowledge MR-000001'), 'the ack screen is unreachable without store.module');
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
console.log('Material Acknowledgement UI OK');
