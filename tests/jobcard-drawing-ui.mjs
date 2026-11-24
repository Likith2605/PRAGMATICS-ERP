/**
 * Headless UI smoke check for the Enquiry drawing auto-fetch on
 * Production > Job Cards ("Core 3" screen #2):
 *   - linking a Project ID pulls the Drawing Number and shows a View link for
 *     the PDF Sales uploaded with the Enquiry,
 *   - saving the Job Card keeps that drawing as an attachment on the record,
 *   - the Job Card view lists the attachment and offers the view link.
 *
 * Run:  node tests/jobcard-drawing-ui.mjs
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
const PORT = 4343;

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

const profile = mkdtempSync(join(tmpdir(), 'jc-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9343`, `--user-data-dir=${profile}`,
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
      const res = await fetch('http://127.0.0.1:9343/json/list');
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
          isLoggedIn: true, username: 'Ravi Kumar', email: 'production_manager@pragmatic.test',
          roleKey: 'production_manager', department: 'Production Department'
        }));
        set('employees', [{ employeeId: 'E10', name: 'Ravi Kumar', department: 'Production Department', role: 'Production Manager', roleKey: 'production_manager' }]);
        set('inventoryItems', [{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100 }]);
        set('projectRequests', [
          {
            projectId: 'PE-2627-0008', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [{ itemName: 'Bracket', drawingNo: 'DWG-01', drawingFileName: 'bracket.pdf', quantity: 10, unit: 'Nos', materialSpec: 'MS Plate' }]
          },
          {
            projectId: 'PE-2627-0009', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [{ itemName: 'Shaft', drawingNo: 'DWG-02', drawingFileName: 'shaft.pdf', quantity: 4, unit: 'Nos', materialSpec: 'MS Plate' }]
          },
          {
            projectId: 'PE-2627-0010', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [
              { itemName: 'Bracket', drawingNo: 'DWG-A', drawingFileName: 'frame-a.pdf', quantity: 10, unit: 'Nos', materialSpec: 'MS Plate' },
              { itemName: 'Bracket', drawingNo: 'DWG-B', drawingFileName: 'frame-b.pdf', quantity: 5, unit: 'Nos', materialSpec: 'MS Plate' }
            ]
          }
        ]);
        set('productionJobCards', []);
        ['notifications', 'storeAuditLog', 'purchaseIndents', 'salesOrderHistory', 'customerPOHistory']
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
    await sleep(900);
  };
  const linkProject = async (pid) => {
    await evaluate(`
      (() => {
        const el = document.querySelector('input[placeholder^="Search Project ID"]');
        if (!el) throw new Error('Project ID autocomplete not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(pid)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
      })()
    `);
    await sleep(700);
    const ok = await evaluate(`
      (() => {
        const hits = [...document.querySelectorAll('div')].filter(
          d => d.querySelector(':scope > div > div > strong') &&
               d.querySelector(':scope > div > div > strong').textContent.trim() === ${JSON.stringify(pid)}
        );
        const item = hits[hits.length - 1];
        if (!item) return false;
        item.click();
        return true;
      })()
    `);
    if (!ok) throw new Error(`project suggestion not found: ${pid}`);
    await sleep(1400);
  };
  const drawingValue = () =>
    evaluate(`
      (() => {
        const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Drawing Number'));
        const input = label && label.parentElement && label.parentElement.querySelector('input');
        return input ? input.value : '';
      })()
    `);

  /* ------------------- 1. linked project pulls the drawing ------------------- */
  console.log('\n== 1. Auto-fetch on the Job Card form');
  await goto('/production');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Job Card'), 'the page renders');

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

  await clickButton('+ Issue Production Job Card');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the form', pageErrors.join(' | '));

  await linkProject('PE-2627-0008');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception linking the project', pageErrors.join(' | '));
  const dwg = await drawingValue();
  check(dwg === 'DWG-01', `the Drawing Number came from the enquiry (${dwg})`);
  check(t.includes('View bracket.pdf'), 'a View link for the stored drawing PDF is shown');

  /* ------------------- 2. missing PDF is explained ------------------- */
  console.log('\n== 2. Missing PDF is explained');
  await linkProject('PE-2627-0009');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception switching projects', pageErrors.join(' | '));
  check(t.includes('No PDF stored'), 'the missing PDF is explained on screen');
  check(!t.includes('View shaft.pdf'), 'no view link without a stored file');

  await linkProject('PE-2627-0008');
  t = await text();
  check(t.includes('View bracket.pdf'), 'the view link comes back with the project');

  /* ------------------- 3. saved Job Card keeps the drawing ------------------- */
  console.log('\n== 3. Saved Job Card keeps the drawing');
  await clickButton('Save & Update Job Card');
  await sleep(800);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception saving', pageErrors.join(' | '));
  const cards = await evaluate(`JSON.parse(localStorage.getItem('productionJobCards') || '[]')`);
  check(cards.length === 1, `the Job Card was saved (${cards.length})`);
  const att = cards[0] ? (cards[0].attachments || []).find((a) => a.name === 'bracket.pdf') : null;
  check(!!att, `the saved Job Card carries the drawing attachment (${JSON.stringify((cards[0] || {}).attachments || [])})`);
  if (att) {
    check(att.source === 'enquiry drawing', `flagged as auto-fetched (${att.source})`);
    check(att.drawingNo === 'DWG-01', `carries the drawing number (${att.drawingNo})`);
  }

  const tView = await text();
  check(tView.includes('View drawing'), 'the Job Card view offers the drawing view link');
  check(
    tView.includes('bracket.pdf'),
    'the Job Card view lists the attached drawing',
    tView.slice(0, 400)
  );

  /* ------------------- 4. several drawings → pick one ------------------- */
  console.log('\n== 4. Multi-drawing project → choose the drawing');
  await goto('/production');
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
        const store = tx.objectStore('drawings');
        store.put('data:application/pdf;base64,' + btoa('%PDF-1.4\\nframe A'), 'PE-2627-0010::DWG-A');
        store.put('data:application/pdf;base64,' + btoa('%PDF-1.4\\nframe B'), 'PE-2627-0010::DWG-B');
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    })
  `);
  await clickButton('+ Issue Production Job Card');
  await linkProject('PE-2627-0010');
  let t2 = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the multi-drawing project', pageErrors.join(' | '));
  const optionTexts = await evaluate(`
    (() => {
      const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Drawing Number'));
      const sel = label && label.parentElement.querySelector('select');
      if (!sel) return 'NO-SELECT';
      return [...sel.options].map(o => o.value).join('|');
    })()
  `);
  check(optionTexts === '|DWG-A|DWG-B', `a drawing dropdown lists both drawings (${optionTexts})`);
  check(t2.includes('View frame-a.pdf'), 'the first drawing is offered by default');

  await evaluate(`
    (() => {
      const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Drawing Number'));
      const sel = label && label.parentElement.querySelector('select');
      if (!sel) throw new Error('drawing select not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'DWG-B');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(1400);
  t2 = await text();
  check(pageErrors.length === 0, 'no uncaught exception switching drawings', pageErrors.join(' | '));
  check(t2.includes('View frame-b.pdf'), 'the chosen drawing is fetched and offered');

  await clickButton('Save & Update Job Card');
  await sleep(800);
  const cards2 = await evaluate(`JSON.parse(localStorage.getItem('productionJobCards') || '[]')`);
  const newest = cards2[cards2.length - 1];
  const att2 = newest ? (newest.attachments || []).find((a) => a.name === 'frame-b.pdf') : null;
  check(!!att2, `the saved Job Card keeps the chosen drawing (${JSON.stringify((newest || {}).attachments || [])})`);
  if (att2) check(att2.drawingNo === 'DWG-B', `it carries the chosen drawing number (${att2.drawingNo})`);
  check(
    !JSON.stringify((newest || {}).attachments || []).includes('frame-a.pdf'),
    'the drawing the user switched away from is not saved',
    JSON.stringify((newest || {}).attachments || [])
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
console.log('Job Card drawing auto-fetch UI OK');
