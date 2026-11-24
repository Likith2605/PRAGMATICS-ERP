/**
 * Verifies generateDebitNotePDF produces a real, non-trivial PDF in the browser
 * and that it contains the expected debit figures.
 *
 * Run:  node tests/debitnote-pdf.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_SERVER_ISOLATION_SCRIPT } from './helpers/liveServerIsolation.mjs';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4321;
const LONG = process.env.DN_VARIANT === 'long' || process.argv.includes('--long');
const OUT = join(tmpdir(), LONG ? 'debitnote-verify-long.pdf' : 'debitnote-verify.pdf');

let passed = 0;
let failed = 0;
const failures = [];
const check = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; failures.push(`${label} ${extra}`); console.log(`  FAIL ${label} ${extra}`); }
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(DIST, normalize(url).replace(/^([/\\])+/, ''));
  if (!existsSync(file) || url === '/') file = join(DIST, 'index.html');
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise((r) => server.listen(PORT, r));

const profile = mkdtempSync(join(tmpdir(), 'dn-pdf-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9334', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
      target = list.find((t) => t.type === 'page'); if (target) break;
    } catch { /* wait */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome endpoint unavailable');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  /* The fixture below is seeded with Runtime.evaluate AFTER the first load, so
     the boot-time PostgreSQL hydration must never run (it would replace the
     seeded Debit Note on the second navigation). */
  await send('Page.addScriptToEvaluateOnNewDocument', { source: LIVE_SERVER_ISOLATION_SCRIPT });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/debit-notes` });
  await sleep(2200);

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  console.log(`\n== generateDebitNotePDF${LONG ? ' (long-identifier stress variant)' : ''}`);
  /* DN_VARIANT=long feeds absurdly long identifiers through every label/value
     column so the measured-gutter logic is exercised, not just the happy path. */
  const v = (normal, long) => (LONG ? long : normal);
  const noteNumber = v('DN-000001', 'DN-000001');
  await evaluate(`
    localStorage.setItem('companySettings', JSON.stringify({ companyName:'DEBIT PDF TEST BRAND', address:'', phone:'', email:'', website:'', gstin:'' }));
    localStorage.setItem('erp_auth', JSON.stringify({
      isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
      roleKey: 'store_manager', department: 'Store Department'
    }));
    ['soMaterialAvailabilityChecks','purchaseIndents','materialReceipts','qualityChecks','rejectionReports','debitNotes']
      .forEach((k) => { if (!localStorage.getItem(k)) localStorage.setItem(k, '[]'); });
    localStorage.setItem('debitNotes', JSON.stringify([{
      debitNoteNumber: ${JSON.stringify(noteNumber)}, debitNoteDate: '2026-09-12', status: 'Created',
      vendor: ${JSON.stringify(v('Alpha Steels', 'Alpha Steels International Trading Company Private Limited'))},
      vendorGstNumber: ${JSON.stringify(v('29AAAAA0000A1Z5', '29AAAAA0000A1Z5'))},
      vendorAddress: '12 Industrial Area, Bengaluru',
      invoiceNumber: ${JSON.stringify(v('TAX-INV-5001', 'TAX-INV-2026-0005001-REVISED-SUPPLIER-COPY'))},
      invoiceDate: '2026-09-08',
      receiptNumber: ${JSON.stringify(v('MR-000001', 'MR-2026-09-000123456'))},
      qcNumber: ${JSON.stringify(v('QC-000001', 'QC-2026-000123456'))},
      rejectionNumber: ${JSON.stringify(v('RRN-000001', 'RRN-2026-000987654'))},
      poNumber: ${JSON.stringify(v('PO-100', 'PO-2026-000123456-SUPPLIER'))},
      indentNumber: ${JSON.stringify(v('IND-000001', 'IND-2026-000987654'))},
      soNumber: ${JSON.stringify(v('SO-001', 'SO-2026-000123456'))},
      projectId: ${JSON.stringify(v('PRJ-SO-001', 'PRJ-2026-SOUTH-BLOCK-01'))},
      inspector: 'Kiran Production', qualityRemarks: 'Surface defects and diameter out of tolerance',
      remarks: 'Credit note for material failed at inspection.',
      createdBy: 'Suresh Store', issuedBy: 'Suresh Store', issuedAt: '2026-09-12 16:00:00',
      createdAt: '2026-09-12 15:00:00', documents: [], history: [],
      subtotal: 900, taxableAmount: 900, totalGST: 162, cgst: 81, sgst: 81, grandTotal: 1062,
      totalDebitQty: 3, amountInWords: 'One Thousand Sixty Two Rupees only',
      items: [
        { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', hsnSac: '7209',
          reason: 'Surface scratch', rejectedQty: 3, debitQty: 2, unitPrice: 250, gstPercent: 18,
          amount: 500, gstAmount: 90, cgstAmount: 45, sgstAmount: 45, lineTotal: 590 },
        { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', hsnSac: '7228',
          reason: 'Diameter out of tolerance', rejectedQty: 1, debitQty: 1, unitPrice: 400, gstPercent: 18,
          amount: 400, gstAmount: 72, cgstAmount: 36, sgstAmount: 36, lineTotal: 472 },
        ...Array.from({ length: ${LONG ? 43 : 0} }, (_, i) => ({
          materialCode: 'LONG-' + i, materialName: 'Long fixture material ' + i + ' with extended specification details',
          unit: 'Kg', hsnSac: '7209', reason: 'Long document pagination verification line ' + i,
          rejectedQty: 1, debitQty: 1, unitPrice: 10, gstPercent: 18, amount: 10, gstAmount: 1.8,
          cgstAmount: 0.9, sgstAmount: 0.9, lineTotal: 11.8
        }))
      ]
    }]));
  `);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/debit-notes` });
  await sleep(2000);

  const opened = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Open');
      if (!b) return false; b.click(); return true; })()
  `);
  check(opened === true, 'the seeded Debit Note opens in the details view');
  await sleep(800);

  const shown = await evaluate('document.body.innerText');
  check(shown.includes('DN-000001'), 'the details view shows DN-000001');
  check(shown.includes('1062.00'), 'the details view shows the grand total');

  /* Intercept the download so we can inspect the bytes. */
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: tmpdir() });
  const clicked = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Download PDF');
      if (!b) return false; b.click(); return true; })()
  `);
  check(clicked === true, 'the Download PDF button is clickable');
  await sleep(3500);

  const { existsSync: ex, readdirSync } = await import('node:fs');
  let file = null;
  /* Chrome appends " (n)" for repeat downloads, so match the newest matching file. */
  const cands = readdirSync(tmpdir())
    .filter(n => /^DebitNote-DN-\d+\.pdf( \(\d+\))?$/.test(n))
    .map(n => ({ n, t: statSync(join(tmpdir(), n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (cands.length) file = join(tmpdir(), cands[0].n);
  check(Boolean(file), `the PDF file was written (${file ? file.split(/[\\/]/).pop() : 'not found'})`);

  if (file) {
    const buf = readFileSync(file);
    writeFileSync(OUT, buf);
    const head = buf.subarray(0, 5).toString('latin1');
    check(head === '%PDF-', `valid PDF header (${head.trim()})`);
    check(buf.length > 3000, `PDF has real content (${buf.length} bytes)`);
    const text = buf.toString('latin1');
    check(/\/Type\s*\/Page[^s]/.test(text), 'the PDF has at least one page object');
    if (LONG) check((text.match(/\/Type\s*\/Page\b/g) || []).length > 1, 'long Debit Note table spans multiple pages');
    check(text.includes('DejaVuSans') || text.includes('Helvetica') || text.includes('Arial') || text.includes('Liberation'), 'an embedded font is present');
    const parsedPdf = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
    let parsedText = '';
    for (let pageNum = 1; pageNum <= parsedPdf.numPages; pageNum += 1) {
      const page = await parsedPdf.getPage(pageNum);
      parsedText += (await page.getTextContent()).items.map((item) => item.str).join(' ') + ' ';
    }
    check(parsedText.includes('DEBIT PDF TEST BRAND') && parsedText.includes('29AKWPP8736E1ZA'), 'Company Settings name and official GSTIN fallback appear in the Debit Note');
    check(parsedText.includes('NO.17/3A') && parsedText.includes('+91 9880030466') && parsedText.includes('pragmatic.vasudev@gmail.com') && parsedText.includes('www.pragmaticengineers.in'), 'official contact details fill blank Company Settings fields');
    const firstPageOps = await (await parsedPdf.getPage(1)).getOperatorList();
    check(firstPageOps.fnArray.some((op) => op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat), 'company logo image is placed in the Debit Note header');

    /* Pull the readable text out of the content streams to confirm the figures printed. */
    const raw = buf.toString('latin1');
    const flat = raw.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
                    .replace(/[()]/g, ' ')
                    .replace(/\\[A-Za-z0-9]+/g, ' ');
    const digits = flat.match(/\d[\d,]*\.\d{2}/g) || [];
    const uniq = [...new Set(digits)];
    check(uniq.includes('250.00'), `PO rate 250.00 printed (${uniq.slice(0, 12).join(', ')})`);
    check(uniq.includes('590.00'), 'line total 590.00 printed');
    check(uniq.includes('1062.00'), 'grand total 1062.00 printed');
    check(uniq.includes('900.00') || uniq.includes('500.00'), 'taxable amounts printed');
    check(flat.includes('DEBIT') || flat.includes('Debit'), 'the DEBIT NOTE title is present');
    check(flat.includes('Alpha') || flat.includes('Steels'), 'the vendor name is printed');
    /* In the long variant the identifier is deliberately truncated for fit. */
    if (LONG) {
      check(flat.includes('TAX-INV-2026-0005001'), 'the long invoice reference is printed (possibly truncated)');
      check(flat.includes('RRN-2026-000987654') || flat.includes('RRN-2026-0009'), 'the long rejection reference is printed');
      /* Guards against the stress variant silently going vacuous. */
      check(flat.includes('...'), 'at least one over-long value was truncated to fit its column');
    } else {
      check(flat.includes('TAX-INV-5001'), 'the vendor invoice reference is printed');
      check(flat.includes('PO-100'), 'the PO reference is printed');
      check(flat.includes('MR-000001'), 'the receipt reference is printed');
      check(flat.includes('QC-000001'), 'the QC reference is printed');
      check(flat.includes('RRN-000001'), 'the rejection report reference is printed');
    }
    console.log(`  (PDF saved for inspection: ${OUT})`);
  }
} catch (err) {
  failed += 1; failures.push(`harness: ${err.message}`);
  console.log(`  FAIL harness: ${err.message}`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill(); server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
console.log('Debit Note PDF OK');
