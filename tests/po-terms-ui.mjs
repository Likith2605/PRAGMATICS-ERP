/**
 * Headless UI check for the Purchase Order "Terms & Delivery Instructions"
 * section:
 *
 *   1. a PO raised from an approved quotation opens with the company standard
 *      T&C (the vendor's one-liner must never blank them out),
 *   2. the vendor's own quoted terms are carried over read-only,
 *   3. the T&C template picker applies / saves templates,
 *   4. the printed PO shows standard terms + "As Quoted by Vendor" + delivery
 *      instructions, while internal notes stay off the document,
 *   5. a manually created PO is prefilled the same way.
 *
 * Run:  node tests/po-terms-ui.mjs
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
const PORT = 4345;

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

const profile = mkdtempSync(join(tmpdir(), 'pot-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9345`, `--user-data-dir=${profile}`,
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
      const res = await fetch('http://127.0.0.1:9345/json/list');
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      pageErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
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
            isLoggedIn: true, username: 'Suresh Kumar', email: 'purchase_manager@pragmatic.test',
            roleKey: 'purchase_manager', department: 'Purchase Department'
          }));
        }
        set('employees', [
          { employeeId: 'E30', name: 'Suresh Kumar', department: 'Purchase Department', role: 'Purchase Manager', roleKey: 'purchase_manager' }
        ]);
        set('inventoryItems', [{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', currentQty: 50 }]);
        set('vendorEnquiries', [{
          enquiryNumber: 'VE-UI-1', prNumber: 'PR-UI-1', indentNumber: '', soNumber: '',
          projectId: 'P-UI-1', projectName: 'Terms UI', partName: 'Housing',
          requestedBy: 'Admin', remarks: 'ui', status: 'Quotations Received',
          createdAt: new Date().toISOString(),
          vendors: [{ name: 'Acme Metals', contact: 'Raj', email: '', status: 'Quotation Received' }],
          items: [{ materialId: 'M1', materialCode: 'MAT-001', materialName: 'MS Plate 6mm', unit: 'Nos', requiredQty: 10, shortageQty: 10 }]
        }]);
        set('vendorQuotations', [{
          quotationNumber: 'VQ-UI-1', enquiryNumber: 'VE-UI-1', indentNumber: '', soNumber: '',
          projectId: 'P-UI-1', vendorName: 'Acme Metals',
          quotationDate: '2026-10-01', createdAt: new Date().toISOString(),
          status: 'Accepted', acceptedBy: 'Administrator', acceptedDate: '2026-10-05', acceptedTime: '10:00 am',
          paymentTerms: '45 days from invoice', validity: '30 days', deliveryDays: 15,
          otherTerms: 'Material to be new stock; packing extra',
          remarks: 'Freight extra, to be borne by buyer.',
          totalAmount: 5900, subtotal: 5000, taxAmount: 900, totalWithTax: 5900,
          items: [{ materialId: 'M1', materialCode: 'MAT-001', materialName: 'MS Plate 6mm', description: 'IS2062',
                    unit: 'Nos', requiredQty: 10, quotedQty: 10, unitPrice: 500, discount: 0, taxPct: 18,
                    taxAmount: 900, totalPrice: 5900, deliveryDays: 15 }]
        }]);
        set('supplierPOHistory', []);
        ['notifications', 'purchaseIndents', 'storeAuditLog', 'purchaseOrderSequence'].forEach((k) => {
          if (!localStorage.getItem(k)) set(k, []);
        });
        /* deterministic template list for every run */
        localStorage.removeItem('poTermsTemplates');
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
    await sleep(2400);
  };

  const text = () => evaluate('document.body.innerText');
  const waitForText = async (needle, timeoutMs = 6000) => {
    const start = Date.now();
    let seen = '';
    while (Date.now() - start < timeoutMs) {
      seen = await text();
      if (seen.includes(needle)) return seen;
      await sleep(300);
    }
    return seen;
  };

  const clickButton = async (label, { index = 0 } = {}) => {
    const found = await evaluate(`
      (() => {
        const matches = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!matches[${index}]) return false;
        matches[${index}].click();
        return true;
      })()
    `);
    if (!found) throw new Error(`button not found: ${label}`);
    await sleep(800);
  };

  const termsValue = () => evaluate(`
    (() => {
      const ta = [...document.querySelectorAll('.page-section textarea')]
        .find(t => (t.closest('.field-group')?.innerText || '').includes('PO Terms and Conditions'));
      return ta ? ta.value : null;
    })()
  `);

  /* -------- 1. approved quotation -> PO opens with the standard terms -------- */
  console.log('\n== 1. an approved quotation opens as a PO with the standard terms');
  await goto('/vendor-quotations');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the quotations page', pageErrors.join(' | '));
  const opened = await evaluate(`
    (() => {
      const sel = [...document.querySelectorAll('select.action-select')]
        .find(s => [...s.options].some(o => o.value === 'createPO'));
      if (!sel) return false;
      sel.value = 'createPO';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.value = '';
      return true;
    })()
  `);
  await sleep(2500);
  check(opened, 'the quotation offers "Create Purchase Order"');
  t = await text();
  check((await evaluate('location.pathname')) === '/purchase-order', 'the PO form opened');
  check(pageErrors.length === 0, 'no uncaught exception opening the PO form', pageErrors.join(' | '));
  const tc = await termsValue();
  check(!!tc, 'the T&C textarea exists');
  check(!!tc && tc.includes('Materials must strictly conform'), 'T&C are prefilled with the standard clauses (not blank)', String(tc).slice(0, 60));
  check(
    !!tc && ['Test certificate', 'factory gate', 'quality inspection'].every((s) => tc.includes(s)),
    'all four standard clauses are present'
  );

  /* -------- 2. vendor quoted terms are carried over read-only -------- */
  console.log('\n== 2. the vendor quoted terms are carried over');
  t = await text();
  check(t.includes('Vendor Quoted Terms (from VQ-UI-1)'), 'the read-only quoted-terms block is shown');
  check(t.includes('45 days from invoice'), 'payment terms carried from the quotation');
  check(t.includes('Material to be new stock; packing extra'), 'vendor quoted terms carried');
  check(t.includes('Freight extra, to be borne by buyer.'), 'vendor remarks carried');
  const readOnly = await evaluate(`
    (() => {
      const box = [...document.querySelectorAll('.page-section label')]
        .find(l => l.innerText.includes('Vendor Quoted Terms'));
      if (!box) return null;
      const wrap = box.closest('.field-group');
      return { inputs: wrap.querySelectorAll('input, textarea, select').length, text: wrap.innerText.length };
    })()
  `);
  check(!!readOnly && readOnly.inputs === 0, 'the quoted-terms block has no editable control', JSON.stringify(readOnly));
  check(await evaluate(`!![...document.querySelectorAll('.page-section label')].find(l => l.innerText.includes('Special Instructions'))`), 'the delivery / gate notes field exists');
  check(
    await evaluate(`(() => { const l = [...document.querySelectorAll('.page-section label')].find(x => x.innerText.includes('Internal Notes')); return !!l && l.innerText.includes('not printed on the PO'); })()`),
    'the internal notes field exists and is marked as not printed'
  );

  /* -------- 3. the T&C template picker -------- */
  console.log('\n== 3. the T&C template picker');
  check(await evaluate(`!![...document.querySelectorAll('button')].find(b => b.innerText.includes('Select a template'))`), 'the template picker button is present');
  await evaluate(`(() => { const b = [...document.querySelectorAll('button.template-select-button')][0]; if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const menuNames = await evaluate(`
    [...document.querySelectorAll('.template-menu div')].map(d => d.innerText.split('\\n')[0]).filter(Boolean)
  `);
  check(menuNames.includes('Standard Purchase Terms'), 'the standard template is listed', JSON.stringify(menuNames));
  check(menuNames.includes('Fabrication / Machining PO'), 'a second template is listed', JSON.stringify(menuNames));
  await evaluate(`
    (() => {
      const el = [...document.querySelectorAll('.template-menu div')].find(d => d.innerText.includes('Fabrication / Machining PO'));
      if (el) el.click();
      return !!el;
    })()
  `);
  await sleep(500);
  const applied = await termsValue();
  check(!!applied && applied.includes('Work shall be carried out as per the approved drawings'), 'picking a template replaces the terms', String(applied).slice(0, 60));

  /* save the edited text as a new template */
  await evaluate(`(() => { window.prompt = () => 'Probe PO Terms'; return true; })()`);
  await clickButton('Save as Template');
  const templatesStored = await evaluate(`JSON.parse(localStorage.getItem('poTermsTemplates') || '[]').map(x => x.name)`);
  check(templatesStored.includes('Probe PO Terms'), 'the new template is persisted', JSON.stringify(templatesStored));

  /* back to the standard terms before saving */
  await evaluate(`(() => { const b = [...document.querySelectorAll('button.template-select-button')][0]; if (b) b.click(); return !!b; })()`);
  await sleep(400);
  await evaluate(`
    (() => {
      const el = [...document.querySelectorAll('.template-menu div')].find(d => d.innerText.includes('Standard Purchase Terms'));
      if (el) el.click();
      return !!el;
    })()
  `);
  await sleep(500);

  /* -------- 4. save the PO and check the printed document -------- */
  console.log('\n== 4. the printed Purchase Order');
  await evaluate(`
    (() => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const tas = [...document.querySelectorAll('.page-section textarea')];
      const notes = tas.find(x => (x.closest('.field-group')?.innerText || '').startsWith('Special Instructions'));
      const internal = tas.find(x => (x.closest('.field-group')?.innerText || '').startsWith('Internal Notes'));
      if (notes) { set.call(notes, 'Deliver at Gate 2, 9 AM to 5 PM'); notes.dispatchEvent(new Event('input', { bubbles: true })); }
      if (internal) { set.call(internal, 'Vendor promised dispatch by 20th'); internal.dispatchEvent(new Event('input', { bubbles: true })); }
      return !!notes && !!internal;
    })()
  `);
  await sleep(400);
  await clickButton('Save Purchase Order');
  await sleep(2500);
  t = await waitForText('Terms & Conditions:');
  check(pageErrors.length === 0, 'no uncaught exception saving the PO', pageErrors.join(' | '));
  check(t.includes('Materials must strictly conform'), 'the printed T&C show the standard clauses');
  check(t.includes('As Quoted by Vendor (VQ-UI-1, Acme Metals)'), 'the printed "As Quoted by Vendor" box is present');
  check(t.includes('Payment terms: 45 days from invoice'), 'the printed vendor terms show the payment terms');
  check(t.includes('Terms quoted by vendor: Material to be new stock; packing extra'), 'the printed vendor terms show the quoted terms');
  check(t.includes('Delivery Instructions:') && t.includes('Deliver at Gate 2'), 'the printed delivery instructions are present');
  const storedPO = await evaluate(`JSON.parse(localStorage.getItem('supplierPOHistory') || '[]')[0] || null`);
  check(!!storedPO, 'the PO was stored');
  if (storedPO) {
    const pd = storedPO.payload.poDetails;
    check(pd.internalNotes === 'Vendor promised dispatch by 20th', 'internal notes are stored', String(pd.internalNotes));
    check(!t.includes('Vendor promised dispatch by 20th'), 'internal notes are NOT printed on the PO');
    check(String(pd.termsAndConditions).includes('Materials must strictly conform'), 'the stored terms are the standard clauses');
    check(String(pd.quotationTerms).includes('Material to be new stock'), 'the stored vendor quoted terms are kept', String(pd.quotationTerms));
    check(pd.paymentTerms === '45 days from invoice', 'payment terms stored on the PO');
  }

  /* -------- 5. a manually created PO starts with the same standard terms -------- */
  console.log('\n== 5. a manual Purchase Order');
  await clickButton('Back to PO List');
  await clickButton('+ Create Purchase Order');
  await sleep(1200);
  t = await text();
  check(t.includes('Create Purchase Order'), 'the manual create form opened');
  const manualTC = await termsValue();
  check(!!manualTC && manualTC.includes('Materials must strictly conform'), 'the manual form is prefilled with the standard clauses', String(manualTC).slice(0, 60));
  check(
    await evaluate(`!![...document.querySelectorAll('button')].find(b => b.innerText.includes('Select a template'))`),
    'the manual form has the template picker too'
  );
  check(pageErrors.length === 0, 'no uncaught exception on the manual form', pageErrors.join(' | '));
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
console.log('PO terms section OK');
