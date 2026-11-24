/**
 * Geometric layout audit of the generated Debit Note PDF.
 * Extracts every text item with its x/y box from pdf.js and asserts the
 * document is inside the page margins, columns line up, and no blocks overlap.
 *
 * Run:  node tests/debitnote-pdf-layout.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const PDFJS = join(ROOT, 'node_modules', 'pdfjs-dist', 'build');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4466;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; let failed = 0; const failures = [];
const check = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; failures.push(`${label} ${extra}`); console.log(`  FAIL ${label} ${extra}`); }
};

const VIEW = `
<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
  import * as pdfjs from '/pdf.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
  window.__render = async (url) => {
    const doc = await pdfjs.getDocument({ url }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter(it => it.str && it.str.trim()).map(it => {
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        const w = it.width * (vp.scale / 1) * 1;
        return { s: it.str, x: +t[4].toFixed(1), y: +t[5].toFixed(1), w: +w.toFixed(1), h: it.height || 10 };
      });
      pages.push({ width: +vp.width.toFixed(1), height: +vp.height.toFixed(1), items });
    }
    return pages;
  };
  window.__ready = true;
</script></body></html>`;

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript' };
const pdfBytes = readFileSync(
  process.argv[2] || (process.env.DN_VARIANT === 'long'
    ? join(tmpdir(), 'debitnote-verify-long.pdf')
    : join(tmpdir(), 'debitnote-verify.pdf'))
);
const server = createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/pdf.mjs' || u === '/pdf.worker.mjs') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(readFileSync(join(PDFJS, u.slice(1))));
  } else if (u === '/dn.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdfBytes);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VIEW);
  }
});
await new Promise((r) => server.listen(PORT, r));

const profile = mkdtempSync(join(tmpdir(), 'dnlayout-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9337', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method: m, params: p })); });

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try { target = (await (await fetch('http://127.0.0.1:9337/json/list')).json()).find(t => t.type === 'page'); if (target) break; } catch {}
    await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  for (let i = 0; i < 60; i += 1) {
    const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
    if (r.result.value) break; await sleep(250);
  }
  const r = await send('Runtime.evaluate', { expression: 'window.__render("/dn.pdf")', returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'render failed');
  const pages = r.result.value;

  console.log(`\n== Layout audit (${pages.length} page(s)${process.env.DN_VARIANT === 'long' ? ', long-identifier stress variant' : ''})`);
  check(pages.length === 1, `the note fits on a single page (${pages.length})`);

  const page = pages[0];
  const { width, height, items } = page;
  /* A4 is 595 x 842pt. Allow 14pt (~5mm) of slack for the letterhead/footer,
     which legitimately sits closer to the trim edge than the body content. */
  const M = 14;
  const over = items.filter(i => i.x < M - 2 || i.y < M - 2 || i.x + i.w > width - M + 2 || i.y > height - M + 2);
  check(over.length === 0, `every text item sits inside the ${M}pt safe area`,
    over.length ? `e.g. ${JSON.stringify(over.slice(0, 3))}` : '');

  const text = items.map(i => i.s).join(' | ');
  /* Section anchors, using the labels the generator actually prints. */
  const anchors = [
    ['title', /DEBIT\s*NOTE/i], ['status', /NOT YET ISSUED|Status:/i],
    ['vendor block', /^To,$/i], ['vendor name', /Alpha/i],
    ['vendor gstin', /GSTIN:/i],
    ['debit note no', /Debit Note No:/i], ['against invoice', /Against Invoice:/i],
    ['po block', /PO No:/i], ['receipt block', /Receipt No:/i],
    ['qc block', /QC No:/i], ['rejection block', /Rejection Report:/i],
    ['indent block', /Indent No:/i], ['so block', /SO No:/i], ['project block', /Project:/i],
    ['reason block', /Reason for debit:/i],
    ['items table header', /Rejected Qty/i],
    ['totals block', /Taxable Amount/i], ['grand total', /Total Debit Value/i],
    ['amount in words', /Rupees\s*only/i],
    ['signatures', /Prepared by:/i]
  ];
  const found = [];
  for (const [name, re] of anchors) {
    const hit = items.find(i => re.test(i.s));
    check(Boolean(hit), `"${name}" is present in the PDF`);
    if (hit) found.push([name, hit.y]);
  }
  /* pdf.js + the viewport transform give y measured from the TOP of the page,
     so ascending y is top-to-bottom. */
  found.sort((a, b) => a[1] - b[1]);
  const seq = found.map(([n]) => n);
  const mustPrecede = [
    ['title', 'vendor block'], ['vendor block', 'items table header'],
    ['items table header', 'totals block'], ['totals block', 'grand total'],
    ['grand total', 'amount in words'], ['amount in words', 'signatures']
  ];
  const bad = mustPrecede.filter(([a, b]) => seq.indexOf(a) > seq.indexOf(b));
  check(bad.length === 0, 'sections appear in a sensible top-to-bottom order',
    bad.length ? `out of order: ${bad.map(p => p.join(' before ')).join(', ')} | ${seq.join(' -> ')}` : '');

  /* Overlap detection: two different strings occupying the same band. */
  let collisions = 0; const samples = [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]; const b = sorted[j];
      if (Math.abs(a.y - b.y) > Math.max(a.h, b.h) * 0.7) break;
      const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (xOverlap > 1.5) { collisions += 1; if (samples.length < 4) samples.push(`"${a.s}"(${a.x},${a.y}) x "${b.s}"(${b.x},${b.y})`); }
    }
  }
  check(collisions === 0, 'no text items overlap each other', collisions ? `${collisions} overlaps: ${samples.join(' ; ')}` : '');

  /* Column alignment, scoped to the items table band only (between the header
     row and the totals box). Money/qty columns are right-aligned, so the
     consistent edge is the RIGHT edge, not the left. */
  const headY = items.find(i => /Rejected Qty/i.test(i.s))?.y ?? -Infinity;
  const footY = items.find(i => /Taxable Amount/i.test(i.s))?.y ?? Infinity;
  const band = items.filter(i => i.y > headY + 2 && i.y < footY - 2);
  check(band.length > 0, `the items table band is identifiable (${band.length} cells)`);

  const rightEdges = (re) => band.filter(i => re.test(i.s)).map(i => Math.round(i.x + i.w));
  const cluster = (edges) => {
    const groups = [];
    edges.forEach((e) => {
      const g = groups.find((x) => Math.abs(x.mean - e) <= 2);
      if (g) { g.n += 1; g.mean = (g.mean * (g.n - 1) + e) / g.n; } else groups.push({ mean: e, n: 1 });
    });
    return groups.filter(g => g.n >= 2);
  };
  const moneyEdges = rightEdges(/^[\d,]+\.\d{2}$/);
  const moneyCols = cluster(moneyEdges);
  check(moneyEdges.length > 0, `money cells found in the table band (${moneyEdges.length})`,
    `band cells: ${JSON.stringify(band.map(i => i.s))}`);
  check(moneyCols.length >= 3, `money columns right-align consistently (${moneyCols.length} columns: ${moneyCols.map(g => `${g.mean.toFixed(0)}x${g.n}`).join(', ')})`);

  const qtyEdges = rightEdges(/^\d+(\.\d+)?$/);
  const qtyCols = cluster(qtyEdges);
  check(qtyCols.length >= 2, `quantity columns right-align consistently (${qtyCols.map(g => `${g.mean.toFixed(0)}x${g.n}`).join(', ')})`);

  const textLefts = [...new Set(band.filter(i => /RAW-|SS |EN8|Sheet|Bar/i.test(i.s)).map(i => Math.round(i.x)))];
  check(textLefts.length === 1, `the material description column shares one left edge (${textLefts.join(', ')})`);

  check(text.includes('250.00') && text.includes('1062.00'), 'the PO rate and grand total render');
  check(/Rupees\s*only/i.test(text), 'the amount-in-words line is rendered');
  console.log(`  page: ${width} x ${height} pt, ${items.length} text items`);
} catch (e) { failed += 1; failures.push(`harness: ${e.message}`); console.log(`  FAIL harness: ${e.message}`); }
finally { try { ws?.close(); } catch {} chrome.kill(); server.close(); try { rmSync(profile, { recursive: true, force: true }); } catch {} }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('\nFailures:'); failures.forEach(f => console.log(`  - ${f}`)); process.exit(1); }
console.log('Debit Note PDF layout OK');
