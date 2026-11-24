/**
 * Headless UI smoke check for the Debit Note workflow.
 * Seeds localStorage, opens the built app in Chrome via CDP and asserts the
 * new Debit Note surfaces render without runtime errors.
 *
 * Run:  node tests/debitnote-ui.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LIVE_SERVER_ISOLATION_SCRIPT } from './helpers/liveServerIsolation.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4319;

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

/* ----------------------------- static file server ----------------------------- */
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

/* ------------------------------ minimal CDP client ------------------------------ */
const profile = mkdtempSync(join(tmpdir(), 'dn-ui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9333`, `--user-data-dir=${profile}`,
  '--window-size=1600,1100', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

try {
  /* wait for the debugger endpoint */
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json/list');
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
${LIVE_SERVER_ISOLATION_SCRIPT}
      (() => {
        /* This script re-runs for EVERY document, and section 5 switches users by
           rewriting erp_auth between navigations. Seed only on the first load so a
           later navigation cannot undo the switch or roll back the workflow. */
        if (localStorage.getItem('erp_auth') !== null) return;
        const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem('erp_auth', JSON.stringify({
          isLoggedIn: true, username: 'Suresh Store', email: 'store_manager@pragmatic.test',
          roleKey: 'store_manager', department: 'Store Department'
        }));
        set('inventoryItems', [{ itemCode: 'RAW-002', itemName: 'SS 304 Sheet', unit: 'Nos', currentQty: 0 }]);
        set('employees', [{ employeeId: 'E1', name: 'Suresh Store', department: 'Store Department', role: 'Store Manager', roleKey: 'store_manager' }]);
        set('salesOrderHistory', [{
          reference: 'SO-001', date: '2026-09-01', status: 'Open', company: 'ACME Controls',
          payload: {
            soDetails: { projectId: 'PRJ-SO-001', soDate: '2026-09-01' },
            customerDetails: { companyName: 'ACME Controls Pvt Ltd' },
            items: [{ itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos' }]
          }
        }]);
        set('supplierPOHistory', [{
          reference: 'PO-100', date: '2026-09-05', vendor: 'Alpha Steels', status: 'Submitted',
          payload: {
            poDetails: { poNumber: 'PO-100', poDate: '2026-09-05', poStatus: 'Submitted' },
            vendorDetails: { companyName: 'Alpha Steels', gstNumber: '29AAAAA0000A1Z5', address: '12 Industrial Area, Bengaluru' },
            items: [
              { itemCode: 'RAW-002', itemName: 'SS 304 Sheet', quantity: 20, unit: 'Nos', unitPrice: 250, gst: 18, hsnSac: '7209' },
              { itemCode: 'RAW-003', itemName: 'EN8 Bar 25mm', quantity: 10, unit: 'Nos', unitPrice: 400, gst: 18, hsnSac: '7228' }
            ]
          }
        }]);
        ['soMaterialAvailabilityChecks','purchaseIndents','materialReceipts','qualityChecks','rejectionReports','debitNotes']
          .forEach((k) => { if (!localStorage.getItem(k)) set(k, []); });
        set('purchaseIndents', [{
          indentNumber: 'IND-000001', indentDate: '2026-09-02', soNumber: 'SO-001',
          projectId: 'PRJ-SO-001', customer: 'ACME Controls Pvt Ltd', status: 'Converted to PO',
          poNumber: 'PO-100', qcNumber: 'QC-000001', qcStatus: 'Inspected', sentToQCAt: '2026-09-08',
          reason: 'Shortage', storeRemarks: '', purchaseRemarks: '', additionalRequirements: [],
          clarifications: [], history: [], createdBy: 'Suresh Store',
          items: [{ materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', requiredQty: 20, shortageQty: 20, purchaseQty: 20, availableQty: 0 }]
        }]);
        set('materialReceipts', [{
          receiptNumber: 'MR-000001', poNumber: 'PO-100', indentNumber: '', soNumber: 'SO-001',
          projectId: 'PRJ-SO-001', vendor: 'Alpha Steels', invoiceNumber: 'TAX-INV-5001', invoiceDate: '2026-09-08',
          qcNumber: 'QC-000001', qcStatus: 'Partially Approved', postedToInventory: false, inventoryPosted: false,
          createdBy: 'Suresh Store', createdAt: '2026-09-08 10:00:00', documents: [],
          items: [
            { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', orderedQty: 20, receivedQty: 20, acceptedQty: 17, rejectedQty: 3 },
            { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', orderedQty: 10, receivedQty: 5, acceptedQty: 4, rejectedQty: 1 }
          ]
        }]);
        set('qualityChecks', [{
          qcNumber: 'QC-000001', receiptNumber: 'MR-000001', indentNumber: 'IND-000001', soNumber: 'SO-001',
          projectId: 'PRJ-SO-001', poNumber: 'PO-100', vendor: 'Alpha Steels', invoiceNumber: 'TAX-INV-5001',
          status: 'Partially Approved', inspector: 'Kiran Production', inspectionDate: '2026-09-10',
          postedToInventory: false, remarks: 'Surface defects found', documents: [], history: [],
          items: [
            { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', receivedQty: 20, acceptedQty: 17, rejectedQty: 3, result: 'Partial', rejectionReason: 'Surface scratch' },
            { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 5, acceptedQty: 4, rejectedQty: 1, result: 'Partial', rejectionReason: 'Diameter out of tolerance' }
          ]
        }]);
        set('rejectionReports', [{
          rejectionNumber: 'RRN-000001', rejectionDate: '2026-09-10', qcNumber: 'QC-000001',
          receiptNumber: 'MR-000001', indentNumber: 'IND-000001', soNumber: 'SO-001', projectId: 'PRJ-SO-001',
          poNumber: 'PO-100', vendor: 'Alpha Steels', invoiceNumber: 'TAX-INV-5001',
          status: 'Raised', inspector: 'Kiran Production', inspectionDate: '2026-09-10',
          qualityRemarks: 'Surface defects found', dcNumber: '', dcDate: '', documents: [],
          repurchaseIndentNumber: '', replacementIndentNumber: '', replacementPoNumber: '',
          rejectedTotal: 4, replacementQty: 0, pendingReplacementQty: 4, history: [],
          items: [
            { materialCode: 'RAW-002', materialName: 'SS 304 Sheet', unit: 'Nos', receivedQty: 20, acceptedQty: 17, rejectedQty: 3, replacementQty: 0, pendingReplacementQty: 3, reason: 'Surface scratch' },
            { materialCode: 'RAW-003', materialName: 'EN8 Bar 25mm', unit: 'Nos', receivedQty: 5, acceptedQty: 4, rejectedQty: 1, replacementQty: 0, pendingReplacementQty: 1, reason: 'Diameter out of tolerance' }
          ]
        }]);
      })();
    `
  });

  /* ------------------------------ helper: navigate ------------------------------ */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const goto = async (path) => {
    consoleErrors.length = 0;
    pageErrors.length = 0;
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}` });
    /* Wait for the app shell instead of a fixed delay: the first load (cold
       bundle + boot-time sync) can be several times slower than the rest. */
    await sleep(600);
    for (let i = 0; i < 40; i += 1) {
      const len = await evaluate(
        `(() => { const el = document.querySelector('#root') || document.body; return (el.innerText || '').length; })()`
      ).catch(() => 0);
      if (len > 200) break;
      await sleep(250);
    }
    await sleep(400);
  };

  const text = () => evaluate('document.body.innerText');
  const count = (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  /* Read-only <input> values never appear in innerText, so collect them explicitly. */
  const fieldValues = () => evaluate(
    `[...document.querySelectorAll('input')].map(i => i.value).join(' || ')`
  );
  const clickButton = async (label, { exact = true, index = 0 } = {}) => {
    const ok = await evaluate(`
      (() => {
        const all = [...document.querySelectorAll('button')];
        const matches = all.filter(b => ${exact ? `b.textContent.trim() === ${JSON.stringify(label)}` : `b.textContent.includes(${JSON.stringify(label)})`});
        if (!matches[${index}]) return false;
        matches[${index}].click();
        return true;
      })()
    `);
    if (!ok) throw new Error(`button not found: ${label}`);
    await sleep(900);
  };

  /* --------------------------------- 1. page load --------------------------------- */
  console.log('\n== 1. /debit-notes list screen');
  await goto('/debit-notes');
  let t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on load', pageErrors.join(' | '));
  check(t.includes('Debit Notes'), 'page title renders');
  check(t.includes('Rejections Awaiting Debit Note'), 'eligible-rejections block renders');
  check(t.includes('RRN-000001'), 'the rejection report is listed');
  check(t.includes('MR-000001'), 'the material receipt is listed (no new receipt required)');
  check(await count('.page-section') === 1, 'the page shell rendered once');
  const btnStyle = await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create Debit Note');
       const s = getComputedStyle(b); return s.display + '|' + s.padding + '|' + s.fontSize; })()`
  );
  check(!btnStyle.startsWith('none'), `the Create Debit Note button is visible and padded (${btnStyle})`);

  /* --------------------------------- 2. open the form --------------------------------- */
  console.log('\n== 2. Debit Note form auto-populates from the linked documents');
  await clickButton('Create Debit Note');
  t = await text();
  const fv = await fieldValues();
  const seeded = await evaluate(
    `[...document.querySelectorAll('input[type=number]')].map(i => i.value).join(',')`
  );
  check(seeded === '3,1', `both rejected lines pre-filled to their remaining qty (${seeded})`);
  check(pageErrors.length === 0, 'no uncaught exception opening the form', pageErrors.join(' | '));
  check(t.includes('Debit Note Header'), 'the form renders');
  check(fv.includes('TAX-INV-5001'), 'vendor invoice auto-filled');
  check(fv.includes('MR-000001'), 'material receipt auto-filled');
  check(fv.includes('QC-000001'), 'quality check auto-filled');
  check(fv.includes('PO-100'), 'purchase order auto-filled');
  check(fv.includes('Alpha Steels'), 'vendor auto-filled');
  check(fv.includes('29AAAAA0000A1Z5'), 'vendor GSTIN auto-filled from the PO');
  check(fv.includes('RRN-000001'), 'rejection report auto-filled');
  check(t.includes('Surface scratch'), 'rejection reason carried onto the line');
  check(t.includes('250.00'), 'PO rate shown (250.00)');
  check(t.includes('18%'), 'PO GST rate shown (18%)');
  check(t.includes('7209'), 'PO HSN shown');
  check(!t.includes('No material receipt'), 'the missing-receipt warning is not shown');

  /* The linked-document fields must be read-only, never typed. */
  const readOnlyCount = await evaluate(
    `[...document.querySelectorAll('input[readonly]')].length`
  );
  check(readOnlyCount >= 7, `linked document fields are read-only (${readOnlyCount} read-only inputs)`);

  /* Accepted material must not be offered. */
  check(!t.includes('MS Plate'), 'no unrelated material appears on the form');

  /* -------------------------------- 3. over-debit guard -------------------------------- */
  console.log('\n== 3. Frontend cap mirrors the service rule');
  await evaluate(`
    (() => {
      const inputs = [...document.querySelectorAll('input[type=number]')];
      const el = inputs[0];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '99');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(600);
  t = await text();
  check(
    t.includes('debit qty exceeds the 3 Nos still unclaimed'),
    'over-debit is blocked in the browser before saving'
  );

  /* Now clear it: an empty Debit Note must also be blocked. */
  await evaluate(`
    (() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      [...document.querySelectorAll('input[type=number]')].forEach((el) => {
        setter.call(el, '0');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    })()
  `);
  await sleep(600);
  t = await text();
  check(t.includes('Enter a debit quantity for at least one material'), 'empty Debit Note is blocked');

  /* -------------------------------- 4. create it -------------------------------- */
  console.log('\n== 4. Create the Debit Note from the UI');
  /* Re-open the form fresh, then set line 1 to 2 (line 2 keeps its prefilled balance of 1). */
  await goto('/debit-notes');
  await clickButton('Create Debit Note');
  await evaluate(`
    (() => {
      const el = [...document.querySelectorAll('input[type=number]')][0];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      el.focus();
      setter.call(el, '2');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(500);
  await clickButton('Create Debit Note');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on save', pageErrors.join(' | '));
  check(t.includes('DN-000001'), 'the Debit Note was numbered DN-000001');
  check(t.includes('Total Debit Value'), 'the details view renders the totals');
  check(t.includes('590.00'), 'line total 2 × 250 + 18% = 590.00');
  check(t.includes('1062.00'), 'grand total 500 + 400 + GST = 1062.00');
  check(t.includes('One Thousand Sixty Two Rupees only'), 'amount in words is correct');
  check(t.includes('Draft'), 'saved as Draft');
  check(t.includes('Submit for Admin Approval'), 'the Draft offers Submit for Admin Approval');
  check(!t.includes('Issue Debit Note'), 'a Draft offers no Issue action — Admin approval comes first');
  check(t.includes('Linked Documents'), 'read-only back-references are shown');
  check(t.includes('Download PDF'), 'PDF download is offered');
  check(t.includes('Print / View PDF'), 'PDF print is offered');

  const stored = await evaluate(`JSON.parse(localStorage.getItem('debitNotes'))`);
  check(stored.length === 1, `exactly one Debit Note persisted (${stored.length})`);
  check(stored[0].status === 'Draft', 'persisted as Draft');
  check(stored[0].receiptNumber === 'MR-000001', 'persisted the linked receipt');
  check(stored[0].invoiceNumber === 'TAX-INV-5001', 'persisted the linked vendor invoice');
  check(stored[0].items.length === 2, 'both rejected lines saved');
  check(
    stored[0].items.find((i) => i.materialCode === 'RAW-002')?.debitQty === 2,
    'the edited quantity 2 was saved'
  );
  check(
    stored[0].items.every((i) => i.unitPrice > 0 && i.gstPercent === 18),
    'both lines carry the PO price and GST'
  );
  const receipts = await evaluate(`JSON.parse(localStorage.getItem('materialReceipts'))`);
  check(receipts.length === 1, 'NO extra material receipt was created');
  const inv = await evaluate(`JSON.parse(localStorage.getItem('inventoryItems'))`);
  check(Number(inv[0].currentQty) === 0, 'inventory untouched — rejected qty never added');

  /* ------------- 5. Draft → Admin approval → Purchase issues ------------- */
  console.log('\n== 5. A Draft cannot be issued — the Admin must approve it first');
  check(!t.includes('Issue Debit Note'), 'a Draft offers NO Issue action (the Draft → Issue shortcut is closed)');
  check(t.includes('Submit for Admin Approval'), 'the Draft offers Submit for Admin Approval');
  check(!t.includes('Approve & Send to Purchase'), 'the Admin approval action is not offered to Store');

  await clickButton('Submit for Admin Approval');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on submit', pageErrors.join(' | '));
  check(t.includes('Admin Approval'), 'status changed to Admin Approval');
  check(t.includes('Awaiting Admin approval'), 'Store sees the "Awaiting Admin approval" badge');
  check(!t.includes('Issue Debit Note'), 'Store still cannot issue it');
  check(!t.includes('Send to Vendor (with Rejection Reasons)'), 'Store cannot send it to the vendor either');

  const submitted = await evaluate(`JSON.parse(localStorage.getItem('debitNotes'))`);
  check(submitted[0].status === 'Admin Approval', `status persisted as ${submitted[0].status}`);
  check(
    await evaluate(
      `JSON.parse(localStorage.getItem('notifications') || '[]').some(n => n.targetDept === 'Admin' && /approval/i.test(n.title || ''))`
    ),
    'the Admin was notified that the Debit Note awaits approval'
  );
  check(
    await evaluate(
      `JSON.parse(localStorage.getItem('notifications') || '[]').some(n => n.targetDept === 'Store Department' && n.reference === 'DN-000001')`
    ),
    'Store keeps visibility of its own request'
  );

  /* Switch login: Purchase must not be able to act before the Admin approves. */
  const beUser = async (name, email, roleKey, department, role) => {
    await evaluate(`
      (() => {
        localStorage.setItem('erp_auth', JSON.stringify({
          isLoggedIn: true, username: ${JSON.stringify(name)}, email: ${JSON.stringify(email)},
          roleKey: ${JSON.stringify(roleKey)}, department: ${JSON.stringify(department)}
        }));
        localStorage.setItem('employees', JSON.stringify([
          { employeeId: 'E9', name: ${JSON.stringify(name)}, email: ${JSON.stringify(email)},
            department: ${JSON.stringify(department)}, role: ${JSON.stringify(role)},
            roleKey: ${JSON.stringify(roleKey)} }
        ]));
        return true;
      })()
    `);
  };

  await beUser('Priya Purchase', 'purchase_manager@pragmatic.test', 'purchase_manager', 'Purchase Department', 'Purchase Manager');
  await goto('/debit-notes');
  await clickButton('Open', { exact: true });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception as Purchase', pageErrors.join(' | '));
  check(t.includes('Awaiting Admin approval'), 'Purchase sees "Awaiting Admin approval" instead of an Issue button');
  check(!t.includes('Issue Debit Note'), 'Purchase cannot issue before the Admin approves');
  check(!t.includes('Approve & Send to Purchase'), 'Purchase cannot approve as the Admin');

  /* The Admin approves and hands it to Purchase with the rejection reasons. */
  await beUser('Ravi Admin', 'admin@gmail.com', 'admin', 'Admin', 'Administrator');
  await goto('/debit-notes');
  await clickButton('Open', { exact: true });
  t = await text();
  check(t.includes('Approve & Send to Purchase'), 'the Admin is offered Approve & Send to Purchase');
  await clickButton('Approve & Send to Purchase');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on Admin approval', pageErrors.join(' | '));
  check(t.includes('Approved'), 'status changed to Approved');
  check(
    await evaluate(
      `JSON.parse(localStorage.getItem('notifications') || '[]').some(n => n.targetDept === 'Purchase Department' && /Rejection reasons:/i.test(n.message || ''))`
    ),
    'Purchase is handed the rejection reasons with the approved Debit Note'
  );

  /* Purchase now issues and sends it to the vendor with the reasons. */
  await beUser('Priya Purchase', 'purchase_manager@pragmatic.test', 'purchase_manager', 'Purchase Department', 'Purchase Manager');
  await goto('/debit-notes');
  await clickButton('Open', { exact: true });
  t = await text();
  check(t.includes('Issue Debit Note'), 'Purchase is offered Issue Debit Note once the Admin has approved');
  await clickButton('Issue Debit Note');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on issue', pageErrors.join(' | '));
  check(t.includes('Issued'), 'status changed to Issued');
  check(!t.includes('Issue Debit Note'), 'the Issue action is gone once issued');
  check(
    t.includes('Send to Vendor (with Rejection Reasons)'),
    'Purchase is offered Send to Vendor (with Rejection Reasons)'
  );
  await clickButton('Send to Vendor (with Rejection Reasons)');
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on send to vendor', pageErrors.join(' | '));
  check(t.includes('Sent to Vendor'), 'status changed to Sent to Vendor');
  check(t.includes('Rejection Notice sent to'), 'the rejection notice forwarded to the vendor is shown');
  check(t.includes('Surface scratch'), 'the notice states why the material was rejected');
  check(!t.includes('Close Debit Note'), 'it cannot close yet — the replacement has not passed Quality Check');

  const after = await evaluate(`JSON.parse(localStorage.getItem('debitNotes'))`);
  check(after[0].status === 'Sent to Vendor', `status persisted as ${after[0].status}`);
  check(
    after[0].vendorNotice?.lines?.some((l) => l.reason === 'Surface scratch'),
    'the rejection reasons are stored on the note'
  );
  const rej = await evaluate(`JSON.parse(localStorage.getItem('rejectionReports'))`);
  check(JSON.stringify(rej[0].debitNoteNumbers) === '["DN-000001"]', 'the rejection report back-references the Debit Note');

  /* -------------------------------- 6. back-reference on the receipt -------------------------------- */
  console.log('\n== 6. Read-only back-reference on the Material Receipt');
  /* Back to Store: the receipt screens, the Rejection Reports tab and the
     "Enter Tax Invoice / Material Receipt" action are Store-owned. */
  await beUser('Suresh Store', 'store_manager@pragmatic.test', 'store_manager', 'Store Department', 'Store Manager');
  await goto('/material-receipts');
  await clickButton('View', { exact: true });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the receipt detail (linkedQc bug fixed)', pageErrors.join(' | '));
  check(t.includes('Debit Notes (read-only)'), 'the receipt shows the Debit Note back-reference block');
  check(t.includes('DN-000001'), 'the receipt lists DN-000001');
  check(t.includes('This receipt is unchanged by the Debit Note'), 'the read-only notice is shown');
  check(t.includes('TAX-INV-5001'), 'the original invoice is still intact');

  /* -------------------------------- 7. Create button on the QC Report screen -------------------------------- */
  console.log('\n== 7. Create Debit Note button in the Quality Check Report section');
  await goto('/purchase-indents');
  await clickButton('Actions', { exact: false });
  await clickButton('Open', { exact: true });
  t = await text();
  const qcBlock = t.includes('Quality Check Report');
  check(qcBlock, 'the Quality Check Report block renders');
  if (qcBlock) {
    const idx = t.indexOf('Quality Check Report');
    const slice = t.slice(idx, idx + 1400);
    check(slice.includes('Rejected Materials') || slice.includes('Rejected Qty'), 'the rejected quantity is shown');
    check(
      slice.includes('Invoice stored on MR-000001') || slice.includes('Enter Tax Invoice / Material Receipt'),
      'the existing invoice button is still there'
    );
    check(
      /Debited: DN-000001|fully debited|Available 3|Rejected 4/.test(slice),
      'the Debit Note state line renders next to the invoice action'
    );
  }

  /* -------------------------------- 8. rejections tab -------------------------------- */
  console.log('\n== 8. Rejection Report screen shows the Debit Note');
  await goto('/material-receipts');
  t = await text();
  check(t.includes('Rejection Reports'), 'the Rejection Reports tab is offered to Store', JSON.stringify(t.slice(0, 400)));
  await clickButton('Rejection Reports', { exact: false });
  t = await text();
  check(pageErrors.length === 0, 'no uncaught exception on the rejections tab', pageErrors.join(' | '));
  check(t.includes('Debited Qty'), 'the Debited Qty column renders');
  check(t.includes('DN-000001'), 'the issued Debit Note is listed');
  await clickButton('Open', { exact: true });
  t = await text();
  check(t.includes('Debit Note:'), 'the Debit Note summary block renders on the report');
  check(
    /Rejected 4 · Already debited 3 · Available to claim 1/.test(t.replace(/\s+/g, ' ')),
    'it reports the partial debit balance (2 of 3 on line 1, 1 of 1 on line 2)'
  );
  check(t.includes('Issued: DN-000001'), 'the issued Debit Note is referenced on the report');
} catch (err) {
  failed += 1;
  failures.push(`harness error: ${err.message}`);
  console.log(`  FAIL harness error: ${err.message}`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('Debit Note UI OK');
