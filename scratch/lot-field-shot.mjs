/**
 * Scratch: screenshot the Material Receipt material-lines table so the new
 * Batch No / Lot No columns can be shown.  Run: node scratch/lot-field-shot.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_SERVER_ISOLATION_SCRIPT } from '../tests/helpers/liveServerIsolation.mjs';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4399;

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

const profile = mkdtempSync(join(tmpdir(), 'lot-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9345`, `--user-data-dir=${profile}`,
  '--window-size=1760,1400', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9345/json/list')).json();
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
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
${LIVE_SERVER_ISOLATION_SCRIPT}
      (() => {
        const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem('erp_auth', JSON.stringify({
          isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
          roleKey: 'store_manager', department: 'Store Department'
        }));
        set('inventoryItems', [{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', currentQty: 5 }]);
        set('supplierPOHistory', [
          {
            reference: 'PO-2627-0011', date: '2026-10-06', vendor: 'XYZ Traders', status: 'Submitted',
            payload: {
              poDetails: { poNumber: 'PO-2627-0011', poDate: '2026-10-06', poStatus: 'Submitted', projectRef: 'PE-2627-0012', salesOrderRef: 'SO-261006-641', paymentTerms: '15 Days' },
              vendorDetails: { companyName: 'XYZ Traders' },
              items: [{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', quantity: 6, unitPrice: 500, gst: 18 }],
              totals: { grandTotal: 3540 }
            }
          }
        ]);
        ['notifications', 'qualityChecks', 'purchaseIndents', 'materialArrivals', 'rejectionReports',
          'debitNotes', 'storeAuditLog', 'materialReceiptSequence', 'materialReceipts'].forEach((k) => {
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

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/material-receipts?po=PO-2627-0011` });
  await sleep(3000);

  const info = await evaluate(`
    (() => {
      const lot = document.querySelector('input[placeholder="Lot No (manual)"]');
      const batch = document.querySelector('input[placeholder="Batch No"]');
      const wrapper = document.querySelector('.history-table-wrapper');
      const ths = [...document.querySelectorAll('table th')].map(h => h.textContent.trim());
      if (wrapper) wrapper.scrollIntoView({ block: 'center' });
      if (lot) lot.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return JSON.stringify({
        lotFound: Boolean(lot),
        batchFound: Boolean(batch),
        headers: ths,
        wrapperScrollLeft: wrapper ? wrapper.scrollLeft : null,
        wrapperScrollWidth: wrapper ? wrapper.scrollWidth : null,
        wrapperClientWidth: wrapper ? wrapper.clientWidth : null
      });
    })()
  `);
  await sleep(800);
  console.log(info);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(join(ROOT, 'scratch'), { recursive: true });
  const out = join(ROOT, 'scratch', 'lot-no-field.png');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
} catch (err) {
  console.error('FAIL', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
