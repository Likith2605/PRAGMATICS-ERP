/**
 * Headless UI smoke check for the Enquiry drawing auto-fetch on
 * Ballooning > Create New Inspection Project ("Core 3" screen #3):
 *   - picking a Project ID + Drawing No offers the PDF Sales uploaded with the
 *     Enquiry as a View link,
 *   - saving without choosing a file uploads that PDF automatically.
 *
 * Run:  node tests/ballooning-drawing-ui.mjs
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
const PORT = 4342;

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

const profile = mkdtempSync(join(tmpdir(), 'bln-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9342`, `--user-data-dir=${profile}`,
  '--window-size=1600,1100', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];
const dialogs = [];

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
      const res = await fetch('http://127.0.0.1:9342/json/list');
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
      dialogs.push(m.params.message || '');
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
          isLoggedIn: true, username: 'Ravi Admin', email: 'admin@pragmatic.test',
          roleKey: 'admin', department: 'Admin'
        }));
        set('employees', [{ employeeId: 'E01', name: 'Ravi Admin', department: 'Admin', role: 'Admin', roleKey: 'admin' }]);
        set('projectRequests', [
          {
            projectId: 'PE-2627-0008', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [{ itemName: 'MS Plate 10mm', drawingNo: 'DWG-01', drawingFileName: 'bracket.pdf', quantity: 10, unit: 'Nos', materialSpec: 'MS Plate' }]
          },
          {
            projectId: 'PE-2627-0009', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [{ itemName: 'MS Plate 10mm', drawingNo: 'DWG-02', drawingFileName: 'shaft.pdf', quantity: 4, unit: 'Nos', materialSpec: 'MS Plate' }]
          }
        ]);
        ['notifications', 'storeAuditLog', 'purchaseIndents', 'salesOrderHistory']
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
  const pick = async (selector, value) => {
    await evaluate(`
      (() => {
        const el = ${JSON.stringify(selector)} === 'project'
          ? document.querySelector('form select')
          : document.querySelectorAll('form select')[1];
        if (!el) throw new Error('select not found: ' + ${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(1300);
  };
  const clickButton = async (label) => {
    const ok = await evaluate(`
      (() => {
        const matches = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!matches[0]) return false;
        matches[0].click();
        return true;
      })()
    `);
    if (!ok) throw new Error(`button not found: ${label}`);
    await sleep(1500);
  };

  /* ------------------- 1. the enquiry drawing is offered ------------------- */
  console.log('\n== 1. View link for the stored drawing');
  await goto('/ballooning/new');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Create New Inspection Project'), 'the page renders');

  await evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open('DrawingFilesDB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('drawings')) db.createObjectStore('drawings');
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('drawings', 'readwrite');
        tx.objectStore('drawings').put(
          'data:application/pdf;base64,' + btoa('%PDF-1.4\\nfake enquiry drawing'),
          'PE-2627-0008::DWG-01'
        );
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    })
  `);

  await pick('project', 'PE-2627-0008');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception picking the project', pageErrors.join(' | '));
  check(t.includes('DWG-01'), 'the drawing numbers of the project are listed');

  await pick('drawing', 'DWG-01');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception picking the drawing', pageErrors.join(' | '));
  check(t.includes('View enquiry drawing'), 'a View link for the enquiry drawing is offered');
  check(t.includes('bracket.pdf'), 'the missing-file choice is explained with the stored file name', '');

  /* ------------------- 2. project whose PDF is not stored ------------------- */
  console.log('\n== 2. Missing PDF says so');
  await pick('project', 'PE-2627-0009');
  await pick('drawing', 'DWG-02');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception switching projects', pageErrors.join(' | '));
  check(t.includes('No PDF stored'), 'the missing PDF is explained on screen');
  check(!t.includes('is attached automatically'), 'no auto-attach promise without a stored PDF');

  dialogs.length = 0;
  const viewClicked = await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('View enquiry drawing'));
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  await sleep(700);
  check(viewClicked, 'the View link is clickable');
  check(
    dialogs.some((d) => d.includes('No drawing PDF found')),
    'viewing a missing drawing explains where to upload it',
    dialogs.join(' | ')
  );

  /* ------------------- 3. saving uploads the enquiry drawing ------------------- */
  console.log('\n== 3. Save without a file uploads the enquiry drawing');
  await pick('project', 'PE-2627-0008');
  await pick('drawing', 'DWG-01');
  t = await text();
  check(t.includes('is attached automatically'), 'the form says the enquiry drawing will be used');

  /* Drawings live in PostgreSQL (server/ballooningRoutes.js) — the legacy
     `ballooning_drawings` localStorage mirror no longer exists — so ask the API.
     The route is keyed by the row UUID, not by the human projectId, so resolve
     the project(s) first. */
  const listDrawings = () =>
    evaluate(`
      fetch('http://localhost:3001/api/ballooning/projects')
        .then((r) => (r.ok ? r.json() : []))
        .then((list) =>
          Promise.all(
            list
              .filter((p) => p.projectId === 'PE-2627-0008')
              .map((p) =>
                fetch('http://localhost:3001/api/ballooning/projects/' + p._id + '/drawings')
                  .then((r) => (r.ok ? r.json() : []))
                  .catch(() => [])
              )
          )
        )
        .then((groups) => groups.flat())
        .catch(() => [])
    `);
  const drawingsBefore = await listDrawings();

  await clickButton('Continue');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception saving', pageErrors.join(' | '));

  const drawings = await listDrawings();
  check(
    drawings.length === drawingsBefore.length + 1,
    `the project got the new drawing (was ${drawingsBefore.length}, now ${drawings.length})`
  );
  const saved = drawings.find((d) => d.drawingNo === 'DWG-01') || drawings[0] || {};
  check(saved.fileName === 'bracket.pdf', `the enquiry PDF was uploaded (${saved.fileName})`);
  check(saved.drawingNo === 'DWG-01', `it carries the drawing number (${saved.drawingNo})`);

  const fileUrl = `http://localhost:3001${saved.filePath || ''}`;
  const fileStored = await evaluate(`
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(fileUrl)});
        if (!res.ok) return false;
        const buf = await res.arrayBuffer();
        return buf.byteLength > 0;
      } catch { return false; }
    })()
  `);
  check(fileStored, 'the PDF itself is stored in the ballooning file store');
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
console.log('Ballooning drawing auto-fetch UI OK');
