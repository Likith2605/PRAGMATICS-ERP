/**
 * Quotation "Machine / Equipment" template — Sub Parts feature E2E test.
 *
 * Covers:
 *   - Sub Parts section shown only for the Machine / Equipment template
 *   - Add / Edit / Delete sub parts (each machine keeps its own list)
 *   - Machine without sub parts stays valid
 *   - Save -> preview shows machine details once + its Sub Parts underneath
 *   - localStorage payload carries per-item subParts
 *   - Editing a saved quotation preserves sub parts (and re-saves cleanly)
 *   - Standard Part template is completely unchanged
 *
 * Run:  node tests/quotation-subparts.mjs   (requires a fresh `npm run build`)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4327;

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

const profile = mkdtempSync(join(tmpdir(), 'qt-sub-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9347', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
const pageErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const HELPERS = `
  window.__set = (el, v) => {
    if (!el) throw new Error('input not found');
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.__btn = (text, root) => {
    const list = Array.from((root || document).querySelectorAll('button'));
    return list.find((b) => b.textContent.trim() === text) || list.find((b) => b.textContent.includes(text)) || null;
  };
  window.__click = (el) => { if (!el) throw new Error('element to click not found'); el.click(); };
  window.__sec = (i) => document.querySelectorAll('.item-table tbody tr.sub-parts-row')[i] || null;
  window.__srows = (i) => {
    const s = window.__sec(i);
    return s ? Array.from(s.querySelectorAll('.sub-parts-table tbody tr')) : [];
  };
  window.__addSub = (i) => {
    const s = window.__sec(i);
    if (!s) throw new Error('sub parts section ' + i + ' missing');
    const b = window.__btn('Add Sub Part', s);
    if (!b) throw new Error('Add Sub Part button missing in section ' + i);
    b.click();
  };
  window.__subVals = (i) => window.__srows(i).map((r) => ({
    desc: (r.querySelector('input[placeholder="Sub Part Description"]') || {}).value,
    qty: (r.querySelector('input[placeholder="Quantity"]') || {}).value
  }));
  true;
`;

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9347/json/list')).json();
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
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || 'exception');
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const go = async (path) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}` });
    await sleep(1700);
    await evaluate(HELPERS);
  };

  const pickTemplate = async (id) => {
    await evaluate(`(() => {
      const r = document.querySelector('input[name="quotationTemplateOption"][value="${id}"]');
      if (!r) throw new Error('template radio missing: ${id}');
      r.click();
      return true;
    })()`);
    await sleep(450);
    await evaluate(`(() => {
      const m = document.querySelector('.template-modal');
      if (!m) throw new Error('template confirm modal missing');
      window.__click(window.__btn('OK', m));
      return true;
    })()`);
    await sleep(450);
  };

  const fillCustomerProject = async (pid) => {
    await evaluate(`(() => {
      window.__set(document.getElementById('customerName'), 'Test Customer');
      window.__set(document.querySelector('input[placeholder="Search or select Project ID..."]'), ${JSON.stringify(pid)});
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
  };

  const fillItem = async (i, fields) => {
    await evaluate(`(() => {
      const r = document.querySelectorAll('.item-table tbody tr.item-row')[${i}];
      if (!r) throw new Error('item row ${i} missing');
      const fields = ${JSON.stringify(fields)};
      for (const [ph, val] of Object.entries(fields)) {
        const el = r.querySelector('[placeholder="' + ph + '"]');
        if (!el) throw new Error('field "' + ph + '" missing in item row ${i}');
        window.__set(el, val);
      }
      return true;
    })()`);
    await sleep(150);
  };

  const fillSub = async (i, j, desc, qty) => {
    await evaluate(`(() => {
      const rows = window.__srows(${i});
      const r = rows[${j}];
      if (!r) throw new Error('sub part row ${i}.${j} missing');
      window.__set(r.querySelector('input[placeholder="Sub Part Description"]'), ${JSON.stringify(desc)});
      if (${qty === undefined ? 'false' : 'true'}) window.__set(r.querySelector('input[placeholder="Quantity"]'), ${JSON.stringify(String(qty))});
      return true;
    })()`);
    await sleep(120);
  };

  /* ================= Section 1: machine template + initial sub parts UI ================= */
  console.log('\n== Machine / Equipment template: Sub Parts UI ==');
  await go('/quotation');
  await evaluate(`
    localStorage.setItem('erp_auth', JSON.stringify({
      isLoggedIn: true, username: 'Admin', email: 'admin@gmail.com',
      roleKey: 'admin', role: 'Administrator'
    }));
    localStorage.removeItem('quotationHistory');
    localStorage.removeItem('currentQuotation');
    true
  `);
  await go('/quotation');

  await evaluate(`window.__click(window.__btn('Create Quotation'))`);
  await sleep(600);
  check((await evaluate('location.pathname')) === '/quotation', 'Create Quotation opens the entry form');
  check((await evaluate('document.body.innerText')).includes('Quotation Entry Form'), 'the quotation entry form is shown');

  await fillCustomerProject('PRJ-SUBPART-01');
  await pickTemplate('machine_equipment');
  const active = await evaluate('document.body.innerText');
  check(active.includes('Active Template') && active.includes('Machine / Equipment'), 'the Machine / Equipment template is confirmed');

  const ui0 = await evaluate(`(() => ({
    sections: document.querySelectorAll('.item-table tbody tr.sub-parts-row').length,
    tables: document.querySelectorAll('.sub-parts-table').length,
    addBtn: Boolean(window.__btn('Add Sub Part')),
    hint: document.body.innerText.includes('No sub parts added yet'),
    title: Boolean(document.querySelector('.sub-parts-title'))
  }))()`);
  check(ui0.sections === 1, 'a Sub Parts section appears after the machine item row (1)');
  check(ui0.tables === 0, 'no sub parts table exists before adding any');
  check(ui0.addBtn && ui0.hint && ui0.title, 'the section shows the "Sub Parts" title, hint and Add Sub Part button');

  await fillItem(0, { 'Drawing Number': 'Machine A', 'Qty': '2', 'Price': '1000' });

  await evaluate('window.__addSub(0)'); await sleep(250);
  await evaluate('window.__addSub(0)'); await sleep(250);
  await evaluate('window.__addSub(0)'); await sleep(250);
  const added = await evaluate(`(() => ({
    rows: window.__srows(0).length,
    slnos: window.__srows(0).map((r) => r.querySelector('td.sp-sl').textContent.trim()),
    qty: window.__srows(0).map((r) => r.querySelector('input[placeholder="Quantity"]').value),
    cols: Array.from(document.querySelectorAll('.sub-parts-table thead th')).map((t) => t.textContent.trim())
  }))()`);
  check(added.rows === 3, 'Add Sub Part x3 creates three sub part rows');
  check(added.slnos.join(',') === '1,2,3', 'sub parts are numbered 1,2,3', `got ${added.slnos}`);
  check(added.qty.every((q) => q === '1'), 'each new sub part defaults to quantity 1', `got ${added.qty}`);
  check(added.cols.join('|') === 'SL.No|Sub Part Description|Quantity|Action', 'the sub parts table has the expected columns', `got ${added.cols}`);

  /* ================= Section 2: edit / delete ================= */
  console.log('\n== Edit / Delete sub parts ==');
  await fillSub(0, 0, 'Sub Part A1', 1);
  await fillSub(0, 1, 'Sub Part A2', 2);
  await fillSub(0, 2, 'Sub Part A3', 3);

  await evaluate(`window.__click(window.__srows(0)[0].querySelector('.sp-act button'))`);
  await sleep(200);
  const focused = await evaluate(`document.activeElement && document.activeElement.id`);
  check(focused === 'subpart-desc-0-0', 'the Edit button focuses that sub part description input', `got ${focused}`);

  await evaluate(`(() => {
    window.__set(window.__srows(0)[0].querySelector('input[placeholder="Sub Part Description"]'), 'Sub Part A1 edited');
    return true;
  })()`);
  await sleep(200);
  let aVals = await evaluate('window.__subVals(0)');
  check(aVals[0].desc === 'Sub Part A1 edited', 'editing a sub part updates its description');

  await evaluate(`window.__click(window.__srows(0)[2].querySelectorAll('.sp-act button')[1])`);
  await sleep(250);
  aVals = await evaluate('window.__subVals(0)');
  check(aVals.length === 2, 'Delete removes the chosen sub part');
  check(aVals[0].desc === 'Sub Part A1 edited' && aVals[1].desc === 'Sub Part A2' && aVals[1].qty === '2',
    'the remaining sub parts keep their values after a delete', JSON.stringify(aVals));

  /* ================= Section 3: two machines keep separate sub parts ================= */
  console.log('\n== Separate sub parts per machine ==');
  await evaluate(`window.__click(window.__btn('+ Add Item'))`);
  await sleep(350);
  await fillItem(1, { 'Drawing Number': 'Machine B', 'Qty': '1', 'Price': '2500' });

  const sep0 = await evaluate(`(() => ({
    sections: document.querySelectorAll('.item-table tbody tr.sub-parts-row').length,
    sec1Empty: !window.__sec(1).querySelector('.sub-parts-table'),
    sec0Rows: window.__srows(0).length
  }))()`);
  check(sep0.sections === 2, 'the second machine gets its own Sub Parts section');
  check(sep0.sec1Empty, 'the new machine starts with NO sub parts (not copied from machine A)');
  check(sep0.sec0Rows === 2, "machine A's sub parts are unaffected by adding machine B");

  await evaluate('window.__addSub(1)'); await sleep(250);
  await evaluate('window.__addSub(1)'); await sleep(250);
  await fillSub(1, 0, 'Sub Part B1', 1);
  await fillSub(1, 1, 'Sub Part B2', 5);

  await evaluate(`window.__click(window.__btn('+ Add Item'))`);
  await sleep(350);
  await fillItem(2, { 'Drawing Number': 'Machine C', 'Qty': '3', 'Price': '500' });

  const sep1 = await evaluate(`(() => ({
    sections: document.querySelectorAll('.item-table tbody tr.sub-parts-row').length,
    a: window.__subVals(0),
    b: window.__subVals(1),
    sec2Empty: !window.__sec(2).querySelector('.sub-parts-table')
  }))()`);
  check(sep1.sections === 3, 'every machine item has its own Sub Parts section (3 sections)');
  check(sep1.a.map((s) => s.desc).join('|') === 'Sub Part A1 edited|Sub Part A2', 'machine A still holds only its two sub parts', JSON.stringify(sep1.a));
  check(sep1.b.map((s) => s.desc).join('|') === 'Sub Part B1|Sub Part B2' && sep1.b[1].qty === '5',
    'machine B holds only its own sub parts with its own quantities', JSON.stringify(sep1.b));
  check(sep1.sec2Empty, 'machine C (added without sub parts) has an empty Sub Parts section');

  /* ================= Section 4: save + preview ================= */
  console.log('\n== Save and quotation preview ==');
  const formErr = await evaluate(`(() => {
    const e = document.querySelector('.form-error');
    return e ? e.textContent : '';
  })()`);
  check(!formErr, 'the form has no validation errors before saving', formErr);
  await evaluate(`window.__click(window.__btn('Save', document.querySelector('form.quotation-form')))`);
  await sleep(1500);
  check((await evaluate('location.pathname')) === '/quotation/preview', 'saving navigates to the quotation preview');

  const prev = await evaluate(`(() => {
    const tds = Array.from(document.querySelectorAll('.doc-items-table .td-item-desc'));
    return {
      machines: tds.map((t) => t.querySelector('.doc-item-title').textContent.trim()),
      subBlocks: document.querySelectorAll('.doc-sub-parts').length,
      texts: tds.map((t) => t.innerText)
    };
  })()`);
  check(prev.machines.join('|') === 'Machine A|Machine B|Machine C',
    'machine details are displayed once each (not repeated per sub part)', JSON.stringify(prev.machines));
  check(prev.subBlocks === 2, 'only machines with sub parts show a Sub Parts block (2 blocks)');
  check(prev.texts[0].includes('Sub Parts') && prev.texts[0].includes('1. Sub Part A1 edited') && prev.texts[0].includes('Qty: 1')
    && prev.texts[0].includes('2. Sub Part A2') && prev.texts[0].includes('Qty: 2'),
    "machine A's Sub Parts are listed underneath machine A's details", JSON.stringify(prev.texts[0]));
  check(!prev.texts[0].includes('Sub Part B1'), "machine A's block does not contain machine B's sub parts");
  check(prev.texts[1].includes('Sub Parts') && prev.texts[1].includes('1. Sub Part B1') && prev.texts[1].includes('2. Sub Part B2')
    && prev.texts[1].includes('Qty: 5'),
    "machine B's Sub Parts are listed underneath machine B's details", JSON.stringify(prev.texts[1]));
  check(!prev.texts[1].includes('Sub Part A1'), "machine B's block does not contain machine A's sub parts");
  check(!prev.texts[2].includes('Sub Parts'), 'machine C (no sub parts) shows no Sub Parts block');

  const histPayload = await evaluate(`(() => {
    const h = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    const entry = h.find((x) => (x.payload.items || []).some((i) => i.itemName === 'Machine A'));
    if (!entry) return null;
    const items = entry.payload.items;
    return {
      count: h.length,
      a: (items.find((i) => i.itemName === 'Machine A').subParts) || null,
      b: (items.find((i) => i.itemName === 'Machine B').subParts) || null,
      c: (items.find((i) => i.itemName === 'Machine C').subParts) || null
    };
  })()`);
  check(Boolean(histPayload), 'the quotation is saved to quotation history');
  check(histPayload && histPayload.a && histPayload.a.length === 2
    && histPayload.a[0].description === 'Sub Part A1 edited' && String(histPayload.a[0].quantity) === '1'
    && histPayload.a[1].description === 'Sub Part A2' && String(histPayload.a[1].quantity) === '2',
    'the saved payload carries machine A sub parts with correct data', JSON.stringify(histPayload && histPayload.a));
  check(histPayload && histPayload.b && histPayload.b.length === 2
    && histPayload.b[0].description === 'Sub Part B1' && String(histPayload.b[1].quantity) === '5',
    'the saved payload carries machine B sub parts with correct data', JSON.stringify(histPayload && histPayload.b));
  check(histPayload && (!histPayload.c || histPayload.c.length === 0),
    'machine C is saved without sub parts', JSON.stringify(histPayload && histPayload.c));

  /* ================= Section 5: edit an existing quotation ================= */
  console.log('\n== Editing an existing quotation ==');
  await go('/quotation');
  const machineRef = await evaluate(`(() => {
    const h = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    const e = h.find((x) => (x.payload.items || []).some((i) => i.itemName === 'Machine A'));
    return e ? e.reference : null;
  })()`);
  check(Boolean(machineRef), 'the machine quotation reference is found in history', String(machineRef));
  const loaded = await evaluate(`(() => {
    const ref = ${JSON.stringify(machineRef)};
    const sel = Array.from(document.querySelectorAll('.history-table tbody tr'))
      .filter((tr) => tr.innerText.includes(ref))
      .map((tr) => tr.querySelector('select.action-select'))
      .find(Boolean);
    if (!sel) return false;
    sel.value = 'editQuotation';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  check(loaded === true, 'the saved quotation is opened for editing from history');
  await sleep(900);

  const editState = await evaluate(`(() => ({
    header: document.body.innerText.includes('Edit Quotation'),
    itemNames: Array.from(document.querySelectorAll('.item-table tbody tr.item-row'))
      .map((r) => (r.querySelector('[placeholder="Drawing Number"]') || {}).value),
    sections: document.querySelectorAll('.item-table tbody tr.sub-parts-row').length,
    a: window.__subVals(0),
    b: window.__subVals(1),
    cHasTable: Boolean(window.__sec(2) && window.__sec(2).querySelector('.sub-parts-table'))
  }))()`);
  check(editState.header, 'the form is in edit mode');
  check(editState.itemNames.join('|') === 'Machine A|Machine B|Machine C', 'the machine items are loaded for editing', JSON.stringify(editState.itemNames));
  check(editState.sections === 3, 'all three Sub Parts sections are restored');
  check(editState.a.map((s) => s.desc).join('|') === 'Sub Part A1 edited|Sub Part A2' && editState.a[1].qty === '2',
    'machine A sub parts are preserved when editing', JSON.stringify(editState.a));
  check(editState.b.map((s) => s.desc).join('|') === 'Sub Part B1|Sub Part B2',
    'machine B sub parts are preserved when editing', JSON.stringify(editState.b));
  check(!editState.cHasTable, 'machine C still has no sub parts when editing');

  await fillSub(0, 1, 'Sub Part A2 updated', 2);
  await evaluate(`window.__click(window.__btn('Save', document.querySelector('form.quotation-form')))`);
  await sleep(1500);
  check((await evaluate('location.pathname')) === '/quotation/preview', 'the edited quotation saves and reopens the preview');

  const rePrev = await evaluate(`(() => {
    const tds = Array.from(document.querySelectorAll('.doc-items-table .td-item-desc'));
    return { a: tds[0] ? tds[0].innerText : '', blocks: document.querySelectorAll('.doc-sub-parts').length };
  })()`);
  check(rePrev.a.includes('Sub Part A2 updated'), 'the updated sub part appears in the preview', JSON.stringify(rePrev.a.slice(0, 200)));

  const reHist = await evaluate(`(() => {
    const h = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    const rows = h.filter((x) => (x.payload.items || []).some((i) => i.itemName === 'Machine A'));
    const a = rows[0] ? (rows[0].payload.items.find((i) => i.itemName === 'Machine A').subParts) : null;
    return { total: h.length, machineRows: rows.length, a };
  })()`);
  check(reHist.machineRows === 1 && reHist.total === 1, 're-saving the edited quotation does not duplicate the history entry', JSON.stringify(reHist));
  check(reHist.a && reHist.a[1].description === 'Sub Part A2 updated', 'the updated sub part is persisted in the saved payload', JSON.stringify(reHist.a));

  /* ================= Section 6: Standard Part template untouched ================= */
  console.log('\n== Standard Part template unchanged ==');
  await go('/quotation');
  await evaluate(`window.__click(window.__btn('Create Quotation'))`);
  await sleep(600);
  await fillCustomerProject('PRJ-STDPART-01');
  await pickTemplate('standard_part');

  const stdUi = await evaluate(`(() => ({
    sections: document.querySelectorAll('.item-table tbody tr.sub-parts-row').length,
    addBtn: Boolean(window.__btn('Add Sub Part')),
    subWord: document.body.innerText.includes('Sub Parts'),
    headers: Array.from(document.querySelectorAll('.item-table thead th')).map((t) => t.textContent.trim())
  }))()`);
  check(stdUi.sections === 0, 'the Standard Part template has NO Sub Parts sections');
  check(!stdUi.addBtn, 'the Standard Part template has NO Add Sub Part button');
  check(!stdUi.subWord, 'the Standard Part form shows no "Sub Parts" terminology');
  check(stdUi.headers.includes('Drawing No.') && stdUi.headers.some((h) => h.startsWith('Item Description')),
    'the Standard Part columns are exactly as before', JSON.stringify(stdUi.headers));

  await fillItem(0, { 'Drawing No.': 'DWG-001', 'Item Description': 'Standard Bearing Housing', 'Qty': '5', 'Price': '100' });
  await evaluate(`window.__click(window.__btn('Save', document.querySelector('form.quotation-form')))`);
  await sleep(1500);

  const stdPrev = await evaluate(`(() => ({
    path: location.pathname,
    blocks: document.querySelectorAll('.doc-sub-parts').length,
    titles: Array.from(document.querySelectorAll('.doc-items-table .td-item-desc')).map((t) => t.innerText),
    drawing: document.body.innerText.includes('DWG-001')
  }))()`);
  check(stdPrev.path === '/quotation/preview', 'the Standard Part quotation saves and previews normally');
  check(stdPrev.drawing && stdPrev.titles.some((t) => t.includes('Standard Bearing Housing')),
    'the Standard Part item renders in the preview', JSON.stringify(stdPrev.titles));
  check(stdPrev.blocks === 0, 'the Standard Part preview has no Sub Parts blocks');

  const stdHist = await evaluate(`(() => {
    const h = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    const rows = h.filter((x) => x.payload.quotationDetails.quotationTemplate === 'standard_part');
    const it = rows[0] ? rows[0].payload.items[0] : null;
    return { count: rows.length, hasSubParts: it ? ('subParts' in it) : null };
  })()`);
  check(stdHist.count === 1, 'the Standard Part quotation is saved to history');
  check(stdHist.hasSubParts === false, 'Standard Part items carry no subParts property', JSON.stringify(stdHist));

  /* ================= Section 7: runtime errors ================= */
  console.log('\n== Page errors ==');
  check(pageErrors.length === 0, 'no JavaScript runtime exceptions were thrown', JSON.stringify(pageErrors.slice(0, 3)));
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
console.log('Quotation Sub Parts OK');
