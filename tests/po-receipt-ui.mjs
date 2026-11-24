/**
 * Headless UI smoke check for the notification deep links in the
 * Purchase Order → Store → Receipt → Quality + Purchase chain:
 *
 *   /material-receipts?po=PO-xxxx   opens the receipt form for that PO (Store)
 *   /quality-checks?receipt=REC-x   opens the inspection (Quality)
 *   /supplier-invoice?receipt=REC-x converts the vendor invoice (Purchase)
 *
 * Run:  node tests/po-receipt-ui.mjs
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
const PORT = 4340;

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

const profile = mkdtempSync(join(tmpdir(), 'prf-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9340`, `--user-data-dir=${profile}`,
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
      const res = await fetch('http://127.0.0.1:9340/json/list');
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
            isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
            roleKey: 'store_manager', department: 'Store Department'
          }));
        }
        set('employees', [
          { employeeId: 'E20', name: 'Suresh Store', department: 'Store Department', role: 'Store Manager', roleKey: 'store_manager' },
          { employeeId: 'E10', name: 'Kiran Production', department: 'Production Department', role: 'Production Employee', roleKey: 'production_employee' },
          { employeeId: 'E30', name: 'Suresh Kumar', department: 'Purchase Department', role: 'Purchase Manager', roleKey: 'purchase_manager' }
        ]);
        set('inventoryItems', [{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', currentQty: 5 }]);
        set('supplierPOHistory', [
          {
            reference: 'PO-2627-0010', date: '2026-10-06', vendor: 'ABC Suppliers', status: 'Submitted',
            payload: {
              poDetails: {
                poNumber: 'PO-2627-0010', poDate: '2026-10-06', poStatus: 'Submitted',
                projectRef: 'PE-2627-0011', salesOrderRef: 'SO-261006-640', paymentTerms: '30 Days'
              },
              vendorDetails: { companyName: 'ABC Suppliers' },
              items: [
                { itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', quantity: 10, unitPrice: 500, gst: 18 }
              ],
              totals: { grandTotal: 5900 }
            }
          },
          {
            reference: 'PO-2627-0011', date: '2026-10-06', vendor: 'XYZ Traders', status: 'Submitted',
            payload: {
              poDetails: {
                poNumber: 'PO-2627-0011', poDate: '2026-10-06', poStatus: 'Submitted',
                projectRef: 'PE-2627-0012', salesOrderRef: 'SO-261006-641', paymentTerms: '15 Days'
              },
              vendorDetails: { companyName: 'XYZ Traders' },
              items: [
                { itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', quantity: 6, unitPrice: 500, gst: 18 }
              ],
              totals: { grandTotal: 3540 }
            }
          }
        ]);
        set('materialReceipts', [
          {
            receiptNumber: 'REC-000001', receiptDate: '2026-10-06',
            poNumber: 'PO-2627-0010', projectId: 'PE-2627-0011', vendor: 'ABC Suppliers',
            invoiceNumber: 'INV-9001', invoiceDate: '2026-10-05', dcNumber: 'DC-101',
            status: 'Pending Quality', qcNumber: '',
            items: [{ materialCode: 'MAT-001', materialName: 'MS Plate', unit: 'Nos', receivedQty: 10 }],
            history: []
          }
        ]);
        ['notifications', 'qualityChecks', 'purchaseIndents', 'materialArrivals', 'rejectionReports',
          'debitNotes', 'storeAuditLog', 'materialReceiptSequence'].forEach((k) => {
          if (!localStorage.getItem(k)) set(k, []);
        });
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
    await sleep(2200);
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
  const login = (department, roleKey, username) => evaluate(`
    localStorage.setItem('erp_auth', JSON.stringify({
      isLoggedIn: true, username: ${JSON.stringify(username)},
      email: ${JSON.stringify(`${roleKey}@pragmatic.test`)}, roleKey: ${JSON.stringify(roleKey)},
      department: ${JSON.stringify(department)}
    }))
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
    await sleep(700);
  };

  /* ------------------------ 1. Store: ?po= opens the receipt form ------------------------ */
  console.log('\n== 1. Store opens /material-receipts?po=…');
  await goto('/material-receipts?po=PO-2627-0010');
  let t = await waitForText('Tax Invoice / Material Receipts');
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Tax Invoice / Material Receipts'), 'the receipt page rendered');
  const searchAfter = await evaluate('location.search');
  check(searchAfter === '', `the deep-link param is cleared after it is applied (${searchAfter})`);
  const formPO = await evaluate(`(document.querySelector('select[required]') || {}).value || ''`);
  check(formPO === 'PO-2627-0010', `the receipt form is prefilled with the PO (${formPO})`);

  /* ------------------------ 2. Quality: ?receipt= opens inspection ------------------------ */
  console.log('\n== 2. Quality opens /quality-checks?receipt=…');
  await login('Production Department', 'production_employee', 'Kiran Production');
  await goto('/quality-checks?receipt=REC-000001');
  t = await waitForText('Inspect Receipt REC-000001');
  check(pageErrors.length === 0, 'no uncaught exception opening the inspection', pageErrors.join(' | '));
  check(t.includes('Inspect Receipt REC-000001'), 'the inspection form opened for the receipt', t.slice(0, 200));
  const searchAfter2 = await evaluate('location.search');
  check(searchAfter2 === '', `the deep-link param is cleared (${searchAfter2})`);

  /* ------------------------ 3. Purchase: ?receipt= converts the invoice ------------------------ */
  console.log('\n== 3. Purchase opens /supplier-invoice?receipt=…');
  await login('Purchase Department', 'purchase_manager', 'Suresh Kumar');
  await goto('/supplier-invoice?receipt=REC-000001');
  t = await waitForText('INV-9001');
  check(pageErrors.length === 0, 'no uncaught exception converting the invoice', pageErrors.join(' | '));
  check(t.includes('INV-9001'), 'the vendor invoice from the receipt is prefilled', t.slice(0, 300));
  check(t.includes('PO-2627-0010'), 'the Supplier Invoice is linked to the Purchase Order');

  /* ---------- 4. Receipt Type must not block the form ("Original delivery") ---------- */
  console.log('\n== 4. Receipt form saves with Receipt Type = Original delivery');
  await login('Store Department', 'store_manager', 'Suresh Store');
  await goto('/material-receipts?po=PO-2627-0011');
  t = await waitForText('Tax Invoice / Material Receipts');
  check(pageErrors.length === 0, 'no uncaught exception opening the receipt form', pageErrors.join(' | '));
  const formState = JSON.parse(await evaluate(`
    (() => {
      const setV = (el, v) => {
        const proto = el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      };
      const receiptType = [...document.querySelectorAll('form select')].find(s => [...s.options].some(o => o.textContent.includes('Original delivery')));
      const inv = document.querySelector('input[placeholder="Vendor tax invoice no"]');
      const date = document.querySelector('input[type="date"][required]');
      const qty = document.querySelector('table input[type="number"]');
      const lot = document.querySelector('input[placeholder="Lot No (manual)"]');
      if (inv) setV(inv, 'INV-7771');
      if (date) setV(date, '2026-10-06');
      if (qty) setV(qty, '3');
      if (lot) setV(lot, 'LOT-7771');
      const form = document.querySelector('form');
      return JSON.stringify({
        lotFieldPresent: Boolean(lot),
        receiptTypeValue: receiptType ? receiptType.value : 'NO-SELECT',
        receiptTypeValid: receiptType ? receiptType.checkValidity() : false,
        invalidCount: form ? form.querySelectorAll(':invalid').length : -1
      });
    })()
  `));
  await sleep(600);
  check(formState.lotFieldPresent, 'the receipt line offers a manual Lot No field');
  check(formState.receiptTypeValue === 'original', `Receipt Type has a real value (${formState.receiptTypeValue})`);
  check(formState.receiptTypeValid, 'the Receipt Type control passes browser validation');
  check(formState.invalidCount === 0, `no control blocks the submit (${formState.invalidCount} invalid)`, JSON.stringify(formState));

  await clickButton('Save Material Receipt');
  await sleep(1200);
  const receiptsNow = await evaluate(`JSON.parse(localStorage.getItem('materialReceipts') || '[]')`);
  const created = receiptsNow.find((r) => r.poNumber === 'PO-2627-0011');
  check(!!created, `the receipt was saved (${receiptsNow.map((r) => r.receiptNumber).join(',')})`);
  if (created) {
    check(created.invoiceNumber === 'INV-7771', `it carries the invoice number (${created.invoiceNumber})`);
    check(created.items[0]?.lotNumber === 'LOT-7771', `the manually typed Lot No is saved on the line (${created.items[0]?.lotNumber})`);
    check(!created.replacementForRejection, 'an original delivery is not booked as a replacement');
  }
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
console.log('PO receipt deep links OK');
