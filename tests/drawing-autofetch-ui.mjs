/**
 * Headless UI smoke check for the Enquiry drawing auto-fetch on
 * Production > Item Requirements ("Core 3" screen #1):
 *   - choosing a Project ID pulls the drawing number and the PDF the Sales team
 *     uploaded with the Enquiry and copies it onto the record's attachments
 *     (no View / Re-fetch controls on the form any more),
 *   - the Required Items table is never auto-filled (project or Sales Order),
 *   - switching to a project whose drawing has no stored PDF clears the previous
 *     auto-fetched attachment,
 *   - the saved requirement keeps the auto-attached drawing.
 *
 * Run:  node tests/drawing-autofetch-ui.mjs
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
const PORT = 4341;

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

const profile = mkdtempSync(join(tmpdir(), 'dwg-ui-'));
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
          isLoggedIn: true, username: 'Ravi Kumar', email: 'production_manager@pragmatic.test',
          roleKey: 'production_manager', department: 'Production Department'
        }));
        set('employees', [{ employeeId: 'E10', name: 'Ravi Kumar', department: 'Production Department', role: 'Production Manager', roleKey: 'production_manager' }]);
        set('inventoryItems', [{ itemCode: 'RAW-001', itemName: 'MS Plate 10mm', unit: 'Nos', currentQty: 100 }]);
        set('projectRequests', [
          {
            projectId: 'PE-2627-0008', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [{ itemName: 'MS Plate 10mm', drawingNo: 'DWG-01', drawingFileName: 'bracket.pdf', quantity: 10, unit: 'Nos', materialSpec: 'MS Plate' }]
          },
          {
            projectId: 'PE-2627-0009', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [{ itemName: 'MS Plate 10mm', drawingNo: 'DWG-02', drawingFileName: 'shaft.pdf', quantity: 4, unit: 'Nos', materialSpec: 'MS Plate' }]
          },
          {
            projectId: 'PE-2627-0010', customerName: 'ACME Controls', companyName: 'ACME Controls',
            items: [
              { itemName: 'MS Plate 10mm', drawingNo: 'DWG-A', drawingFileName: 'frame-a.pdf', quantity: 10, unit: 'Nos', materialSpec: 'MS Plate' },
              { itemName: 'MS Plate 10mm', drawingNo: 'DWG-B', drawingFileName: 'frame-b.pdf', quantity: 5, unit: 'Nos', materialSpec: 'MS Plate' }
            ]
          }
        ]);
        set('productionRequirements', []);
        ['notifications', 'storeAuditLog', 'productionRequirementsSequence', 'purchaseIndents', 'salesOrderHistory']
          .forEach((k) => { if (!localStorage.getItem(k)) set(k, []); });
        set('salesOrderHistory', [
          {
            reference: 'SO-SEED-0001',
            company: 'ACME Controls',
            status: 'Open',
            payload: {
              customerDetails: { companyName: 'ACME Controls' },
              soDetails: { projectId: 'PE-2627-0008', deliveryDate: '2026-11-15' },
              items: [{ itemName: 'Control Panel', drawingNo: 'DWG-01', drawingFileName: 'bracket.pdf', quantity: 10, unit: 'Nos' }]
            }
          }
        ]);
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
  const clickPartial = async (needle) => {
    const ok = await evaluate(`
      (() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(needle)}));
        if (!b) return false;
        b.click();
        return true;
      })()
    `);
    if (!ok) throw new Error(`button not found (contains): ${needle}`);
    await sleep(700);
  };
  const setProjectId = async (value) => {
    await evaluate(`
      (() => {
        const el = document.querySelector('input[placeholder="e.g. PRJ-2026-001"]');
        if (!el) throw new Error('Project ID input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(1400);
  };
  const openAttachmentNames = () =>
    evaluate(`[...document.querySelectorAll('button[title="Open attachment"]')].map(b => b.textContent.trim()).join('|')`);
  const pickDrawing = async (value) => {
    await evaluate(`
      (() => {
        const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Drawing No'));
        const sel = label && label.parentElement.querySelector('select');
        if (!sel) throw new Error('drawing select not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, ${JSON.stringify(value)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await sleep(1400);
  };

  /* the Required Items rows are filled by hand now — pick material + quantity */
  const fillFirstRow = async (name, quantity) => {
    await evaluate(`
      (() => {
        const input = document.querySelector('.material-select-input');
        if (!input) throw new Error('material input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(600);
    const picked = await evaluate(`
      (() => {
        const opt = [...document.querySelectorAll('.material-select-option')]
          .find(o => o.textContent.includes(${JSON.stringify(name)}));
        if (!opt) return false;
        opt.click();
        return true;
      })()
    `);
    if (!picked) throw new Error(`material option not found: ${name}`);
    await sleep(400);
    await evaluate(`
      (() => {
        const input = document.querySelector('.item-req-table tbody tr input[type="number"]');
        if (!input) throw new Error('quantity input not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(String(quantity))});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(400);
  };

  /* the item table must stay untouched: only the single blank row is there */
  const itemTableState = () =>
    evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('.item-req-table tbody tr')];
        const filled = rows.filter(tr =>
          [...tr.querySelectorAll('input, textarea')].some(el => (el.value || '').trim() !== '')
        ).length;
        return rows.length + ':' + filled;
      })()
    `);

  /* ------------------- 1. Project ID pulls the stored drawing ------------------- */
  console.log('\n== 1. Auto-fetch + view link');
  await goto('/production/item-requirements');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Item Requirements'), 'the page renders');

  /* store the enquiry drawing PDF for PE-2627-0008::DWG-01 in IndexedDB */
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

  await clickButton('+ New Item Requirement');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the form', pageErrors.join(' | '));
  check(t.includes('Draft'), 'the requirement form opened as a Draft');

  await setProjectId('PE-2627-0008');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception after choosing the project', pageErrors.join(' | '));
  check(t.includes('bracket.pdf'), 'the auto-attached drawing is listed under Attachment', t.includes('bracket.pdf') ? '' : '');
  check(
    !t.includes('View drawing PDF') && !t.includes('Re-fetch') && !t.includes('Attached:'),
    'the View drawing PDF / Re-fetch controls are gone from the form'
  );
  const drawingNoValue = await evaluate(
    `[...document.querySelectorAll('input')].find(i => i.placeholder === 'Auto-filled from enquiry')?.value || ''`
  );
  check(drawingNoValue === 'DWG-01', `Drawing No was pulled from the enquiry (${drawingNoValue})`);
  const chips = await openAttachmentNames();
  check(chips === 'bracket.pdf', `the drawing PDF was auto-attached (${chips})`);
  const tableAfterProject = await itemTableState();
  check(tableAfterProject === '1:0', `the Required Items table is not auto-filled (${tableAfterProject})`);

  /* ------------------- 1b. Sales Order fills identifiers only ------------------- */
  console.log('\n== 1b. Sales Order → no required items');
  await evaluate(`
    (() => {
      const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Sales Order Ref'));
      const sel = label && label.parentElement.querySelector('select');
      if (!sel) throw new Error('Sales Order select not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'SO-SEED-0001');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(1500);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception choosing the Sales Order', pageErrors.join(' | '));
  const soForm = await evaluate(`
    (() => {
      const byLabel = (txt) => {
        const l = [...document.querySelectorAll('label')].find(x => x.textContent.includes(txt));
        const el = l && l.parentElement.querySelector('input, select');
        return el ? el.value : 'MISSING';
      };
      return JSON.stringify({
        project: byLabel('Project ID'),
        customer: byLabel('Customer'),
        items: [...document.querySelectorAll('.item-req-table tbody tr')].length,
        filled: [...document.querySelectorAll('.item-req-table tbody tr')].filter(tr =>
          [...tr.querySelectorAll('input, textarea')].some(el => (el.value || '').trim() !== '')
        ).length
      });
    })()
  `);
  const soState = JSON.parse(soForm);
  check(soState.project === 'PE-2627-0008', `the SO brought its Project ID (${soState.project})`);
  check(soState.customer === 'ACME Controls', `the SO brought its Customer (${soState.customer})`);
  check(
    soState.items === 1 && soState.filled === 0,
    `only Project ID / Drawing / PDF are fetched — the item table stays empty (${soForm})`
  );
  const chipsAfterSO = await openAttachmentNames();
  check(chipsAfterSO === 'bracket.pdf', `the SO's drawing PDF was attached (${chipsAfterSO})`);

  /* ------------------- 2. a project without a stored PDF ------------------- */
  console.log('\n== 2. Missing PDF clears the previous auto-attachment');
  await setProjectId('PE-2627-0009');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception switching projects', pageErrors.join(' | '));
  check(!t.includes('No PDF stored'), 'the missing-PDF note is gone with the drawing controls');
  const chipsAfterSwitch = await openAttachmentNames();
  check(chipsAfterSwitch === '', `the previous auto-attached drawing was removed (${chipsAfterSwitch})`);

  await setProjectId('PE-2627-0008');
  const chipsBack = await openAttachmentNames();
  check(chipsBack === 'bracket.pdf', `coming back re-attaches the drawing (${chipsBack})`);

  /* ------------------- 3. the saved record keeps the drawing ------------------- */
  console.log('\n== 3. Saved requirement keeps the auto-attached drawing');
  await fillFirstRow('MS Plate 10mm', 10);
  await clickButton('Save Draft');
  await sleep(700);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception saving', pageErrors.join(' | '));
  check(!t.includes('Project ID is required.'), 'the requirement validated and saved');
  const saved = await evaluate(`
    (() => {
      const list = JSON.parse(localStorage.getItem('productionRequirements') || '[]');
      return JSON.stringify(list.map(r => ({ no: r.requirementNumber, projectId: r.projectId, atts: r.attachments })));
    })()
  `);
  const rec = JSON.parse(saved)[0];
  const att = rec ? (rec.atts || []).find((a) => a.name === 'bracket.pdf') : null;
  check(!!att, `the saved requirement has the drawing attached (${saved.slice(0, 220)})`);
  if (att) {
    check(att.source === 'enquiry drawing', `the attachment is flagged as auto-fetched (${att.source})`);
    check(att.drawingNo === 'DWG-01', `the attachment carries the drawing number (${att.drawingNo})`);
    check(typeof att.id === 'string' && att.id.length > 0, 'the attachment points at a stored document');
  }
  const storedDoc = await evaluate(`
    new Promise((resolve) => {
      const req = indexedDB.open('WorkflowFilesDB', 1);
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('workflowFiles')) { db.close(); resolve(false); return; }
        const tx = db.transaction('workflowFiles', 'readonly');
        const get = tx.objectStore('workflowFiles').get(${JSON.stringify(att && att.id ? att.id : '__none__')});
        get.onsuccess = () => { db.close(); resolve(!!get.result); };
        get.onerror = () => { db.close(); resolve(false); };
      };
      req.onerror = () => resolve(false);
    })
  `);
  check(storedDoc, 'the drawing file itself is stored for the record');

  /* ------------------- 4. the read-only view links the drawing ------------------- */
  console.log('\n== 4. Read-only view offers the drawing link');
  await clickButton('View');
  await sleep(600);
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception opening the view', pageErrors.join(' | '));
  check(t.includes('View drawing'), 'the detail view offers a drawing view link');
  check(t.includes('bracket.pdf'), 'the detail view lists the auto-attached drawing');

  /* ------------------- 5. a project with several drawings ------------------- */
  console.log('\n== 5. Multi-drawing project → choose the drawing');
  await goto('/production/item-requirements');
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
  await clickButton('+ New Item Requirement');
  await setProjectId('PE-2627-0010');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the multi-drawing project', pageErrors.join(' | '));
  const optionTexts = await evaluate(`
    (() => {
      const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Drawing No'));
      const sel = label && label.parentElement.querySelector('select');
      if (!sel) return 'NO-SELECT';
      return [...sel.options].map(o => o.value).join('|');
    })()
  `);
  check(optionTexts === '|DWG-A|DWG-B', `a drawing dropdown lists both drawings (${optionTexts})`);
  check(t.includes('frame-a.pdf'), 'the first drawing is auto-attached by default');
  const chipsA = await openAttachmentNames();
  check(chipsA === 'frame-a.pdf', `default attachment is the first drawing (${chipsA})`);

  await pickDrawing('DWG-B');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception switching drawings', pageErrors.join(' | '));
  const chipsB = await openAttachmentNames();
  check(chipsB === 'frame-b.pdf', `the chosen drawing replaced the previous one (${chipsB})`);
  check(t.includes('frame-b.pdf'), 'the status line shows the chosen drawing');

  await fillFirstRow('MS Plate 10mm', 5);
  await clickButton('Save Draft');
  await sleep(700);
  const savedMulti = await evaluate(`
    JSON.stringify(JSON.parse(localStorage.getItem('productionRequirements') || '[]').map(r => r.attachments || []))
  `);
  const atts = JSON.parse(savedMulti).flat();
  check(
    atts.some((a) => a.name === 'frame-b.pdf' && a.drawingNo === 'DWG-B'),
    `the saved requirement keeps the chosen drawing (${savedMulti})`
  );
  check(
    !atts.some((a) => a.name === 'frame-a.pdf'),
    'the drawing the user switched away from is not saved',
    savedMulti
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
console.log('Drawing auto-fetch UI OK');
