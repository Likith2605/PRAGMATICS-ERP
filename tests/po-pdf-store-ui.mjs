/**
 * Headless UI check for "Save Purchase Order sends the PO PDF to the Store
 * Department that raised the Purchase Indent":
 *
 *   1. saving a PO (quotation path) generates the PDF, stores it in the
 *      workflow document store and stamps it on the saved PO record,
 *   2. Store is notified with a deep link to /material-receipts?po=...,
 *   3. the Store receipt screen offers the document (form + awaiting-PO list),
 *   4. a manually raised PO is sent the same way, and re-saving replaces the
 *      document instead of stacking duplicates,
 *   5. the Store manager sees the notification in the bell and clicking it
 *      opens the PO PDF Purchase sent (no navigation away from the dashboard).
 *
 * Run:  node tests/po-pdf-store-ui.mjs
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
const PORT = 4346;

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

const profile = mkdtempSync(join(tmpdir(), 'popdf-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=9346`, `--user-data-dir=${profile}`,
  '--window-size=1600,1200', 'about:blank'
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
      const res = await fetch('http://127.0.0.1:9346/json/list');
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
      dialogs.push(String(m.params.message || ''));
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
        /* Seed only what is missing: the hook runs on every navigation and must
           never wipe what the app has just written. */
        const seed = (k, v) => { if (!localStorage.getItem(k)) set(k, v); };
        if (!localStorage.getItem('erp_auth')) {
          localStorage.setItem('erp_auth', JSON.stringify({
            isLoggedIn: true, username: 'Suresh Kumar', email: 'purchase_manager@pragmatic.test',
            roleKey: 'purchase_manager', department: 'Purchase Department'
          }));
        }
        seed('employees', [
          { employeeId: 'E30', name: 'Suresh Kumar', department: 'Purchase Department', role: 'Purchase Manager', roleKey: 'purchase_manager' }
        ]);
        seed('inventoryItems', [{ itemCode: 'MAT-001', itemName: 'MS Plate', unit: 'Nos', currentQty: 50 }]);
        seed('purchaseIndents', [{
          indentNumber: 'PI-UI-1', soNumber: '', projectId: 'P-UI-1', projectName: 'PDF Store UI',
          status: 'Raised', raisedBy: 'Store', createdBy: 'Store', createdByDept: 'Store Department',
          requiredDate: '2026-10-20', remarks: 'raised by Store', history: [], createdAt: new Date().toISOString(),
          items: [{ materialCode: 'MAT-001', materialName: 'MS Plate 6mm', unit: 'Nos', purchaseQty: 10, shortageQty: 10 }]
        }]);
        seed('vendorEnquiries', [{
          enquiryNumber: 'VE-UI-1', prNumber: 'PR-UI-1', indentNumber: 'PI-UI-1', soNumber: '',
          projectId: 'P-UI-1', projectName: 'PDF Store UI', partName: 'Housing',
          requestedBy: 'Admin', remarks: 'ui', status: 'Quotations Received',
          createdAt: new Date().toISOString(),
          vendors: [{ name: 'Acme Metals', contact: 'Raj', email: '', status: 'Quotation Received' }],
          items: [{ materialId: 'M1', materialCode: 'MAT-001', materialName: 'MS Plate 6mm', unit: 'Nos', requiredQty: 10, shortageQty: 10 }]
        }]);
        seed('vendorQuotations', [{
          quotationNumber: 'VQ-UI-1', enquiryNumber: 'VE-UI-1', indentNumber: 'PI-UI-1', soNumber: '',
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
        ['supplierPOHistory', 'notifications', 'storeAuditLog', 'purchaseOrderSequence'].forEach((k) => seed(k, []));
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
  const waitForText = async (needle, timeoutMs = 9000) => {
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

  /** Size + MIME of a stored workflow document, straight out of IndexedDB. */
  const docBytes = (id) => evaluate(`
    (async () => {
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('WorkflowFilesDB');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const blob = await new Promise((res, rej) => {
          const tx = db.transaction('workflowFiles', 'readonly');
          const g = tx.objectStore('workflowFiles').get(${JSON.stringify(id)});
          g.onsuccess = () => res(g.result);
          g.onerror = () => rej(g.error);
        });
        return blob ? [blob.size, blob.type] : null;
      } catch (e) {
        return ['error', String(e && e.message || e)];
      }
    })()
  `);

  const storedPOs = () => evaluate(`JSON.parse(localStorage.getItem('supplierPOHistory') || '[]')`);
  const notifications = () => evaluate(`JSON.parse(localStorage.getItem('notifications') || '[]')`);

  /* -------- 1. quotation path: PDF generated, stored and stamped -------- */
  console.log('\n== 1. saving a PO from an accepted quotation sends the PDF to Store');
  await goto('/vendor-quotations');
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
  check((await evaluate('location.pathname')) === '/purchase-order', 'the PO form opened');
  await clickButton('Save Purchase Order');
  let t = await waitForText('PO PDF sent to Store');
  check(pageErrors.length === 0, 'no uncaught exception saving the PO', pageErrors.join(' | '));
  check(t.includes('PO PDF sent to Store'), 'the view shows the "PO PDF sent to Store" button', '');

  const pos = await storedPOs();
  check(pos.length === 1, 'one Purchase Order was stored', `got ${pos.length}`);
  const poNumber = pos[0]?.reference || '';
  const docs = pos[0]?.payload?.poDocuments || [];
  check(docs.length === 1, 'the saved PO carries exactly one document', JSON.stringify(docs));
  check(
    docs[0]?.name === `PurchaseOrder-${poNumber}.pdf`,
    'the document is named after the PO',
    String(docs[0]?.name)
  );
  check(docs[0]?.kind === 'Purchase Order', 'the document is marked as a Purchase Order', String(docs[0]?.kind));
  check(String(docs[0]?.id || '').startsWith('wfdoc-'), 'the document has a workflow file id', String(docs[0]?.id));

  const bytes = docs[0] ? await docBytes(docs[0].id) : null;
  check(
    Array.isArray(bytes) && bytes[0] > 1000,
    'the real PDF bytes are in the document store',
    JSON.stringify(bytes)
  );
  check(Array.isArray(bytes) && bytes[1] === 'application/pdf', 'the stored file is a PDF', JSON.stringify(bytes));

  const notif = (await notifications()).find((n) => n.title === 'Purchase Order PDF sent to Store');
  check(!!notif, 'Store receives a dedicated "PDF sent" notification');
  check(!!notif && notif.targetDept === 'Store Department', 'the notification targets the Store Department', JSON.stringify(notif));
  check(!!notif && notif.reference === poNumber, 'the notification is linked to this PO', String(notif?.reference));
  check(!!notif && notif.link === `/material-receipts?po=${poNumber}`, 'the notification deep-links to the receipt screen', String(notif?.link));
  check(
    !!notif && notif.message.includes('Purchase Indent PI-UI-1'),
    'the notification names the Purchase Indent the PO came from',
    String(notif?.message)
  );
  check(
    (await notifications()).some((n) => n.title === 'Purchase Order from Accepted Quotation'),
    'the original workflow Store notification is still sent'
  );

  const indent = (await evaluate(`JSON.parse(localStorage.getItem('purchaseIndents') || '[]')`))[0];
  check(
    !!indent && indent.poNumber === poNumber && String(indent.status).toLowerCase().includes('converted'),
    'the Store Purchase Indent now points at this PO',
    JSON.stringify({ status: indent?.status, poNumber: indent?.poNumber })
  );

  /* -------- 2. the Store receipt screen offers the document -------- */
  console.log('\n== 2. the Store receipt screen offers the PO document');
  await goto(`/material-receipts?po=${encodeURIComponent(poNumber)}`);
  t = await waitForText('Purchase Order Document');
  check(t.includes(`PurchaseOrder-${poNumber}.pdf`), 'the receipt form shows the PO document button');
  check(pageErrors.length === 0, 'no uncaught exception on the receipt screen', pageErrors.join(' | '));

  await goto('/material-receipts');
  await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button.tab-link')]
        .find(x => x.innerText.includes('POs Awaiting'));
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(900);
  t = await text();
  check(t.includes('PO PDF'), 'the awaiting-PO list offers the PO PDF', '');
  check(pageErrors.length === 0, 'no uncaught exception on the awaiting list', pageErrors.join(' | '));

  /* -------- 3. a manual PO, and a re-save that must not duplicate -------- */
  console.log('\n== 3. a manually raised PO and a re-save');
  await goto('/purchase-order');
  await clickButton('+ Create Purchase Order');
  await sleep(1200);
  const filled = await evaluate(`
    (() => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const forLabel = (needle) => {
        const g = [...document.querySelectorAll('.field-group')]
          .find(x => (x.querySelector('label')?.innerText || '').includes(needle));
        return (g && g.querySelector('input')) || null;
      };
      const vendor = forLabel('Vendor / Company Name');
      const contact = forLabel('Contact Person');
      if (vendor) { set.call(vendor, 'Acme Metals'); vendor.dispatchEvent(new Event('input', { bubbles: true })); }
      if (contact) { set.call(contact, 'Raj'); contact.dispatchEvent(new Event('input', { bubbles: true })); }
      return !!(vendor && contact);
    })()
  `);
  check(filled, 'the manual form got a vendor');
  const valid = await evaluate(`
    (() => { const f = document.querySelector('form.quotation-form'); return f ? f.checkValidity() : null; })()
  `);
  check(valid === true, 'the manual form passes native validation', String(valid));
  await clickButton('Save Purchase Order');
  t = await waitForText('PO PDF sent to Store');
  if (dialogs.length) console.log('  dialogs:', dialogs.join(' | '));
  check(pageErrors.length === 0, 'no uncaught exception saving the manual PO', pageErrors.join(' | '));

  const after = await storedPOs();
  check(after.length === 2, 'the manual PO was stored beside the first one', `got ${after.length}`);
  const manual = after.find((p) => String(p.payload?.poDetails?.quotationRef || '') === '');
  check(
    !!manual && (manual.payload.poDocuments || []).length === 1,
    'the manual PO carries its document',
    JSON.stringify(manual?.payload?.poDocuments || null)
  );
  const manualNotif = (await notifications()).find(
    (n) => n.title === 'Purchase Order PDF sent to Store' && n.reference === (manual?.reference || '')
  );
  check(!!manualNotif, 'Store is notified for the manual PO too', JSON.stringify(manualNotif));
  check(
    !!manualNotif && !manualNotif.message.includes('Purchase Indent'),
    'a PO without an indent does not invent an indent reference',
    String(manualNotif?.message)
  );

  const beforeId = manual?.payload?.poDocuments?.[0]?.id || '';
  await clickButton('Edit PO');
  await sleep(1000);
  t = await text();
  check(!t.includes('PO PDF sent to Store'), 'the document button is gone while editing', '');
  await clickButton('Save Purchase Order');
  t = await waitForText('PO PDF sent to Store');
  const afterEdit = (await storedPOs()).find((p) => String(p.reference) === String(manual?.reference || ''));
  const docsAfter = afterEdit?.payload?.poDocuments || [];
  check(docsAfter.length === 1, 're-saving replaces the document instead of stacking duplicates', JSON.stringify(docsAfter));
  check(
    docsAfter[0] && docsAfter[0].id !== beforeId,
    'the re-saved PO points at a freshly generated document',
    `${beforeId} -> ${docsAfter[0]?.id}`
  );
  const oldBytes = await docBytes(beforeId);
  check(oldBytes === null, 'the superseded document was removed from storage', JSON.stringify(oldBytes));
  check(pageErrors.length === 0, 'no uncaught exception on the re-save', pageErrors.join(' | '));

  /* -------- 4. the Store manager gets it in the bell and the click opens the PDF -------- */
  console.log('\n== 4. the Store Department notification opens the PO PDF');
  await evaluate(`
    (() => {
      localStorage.setItem('erp_auth', JSON.stringify({
        isLoggedIn: true, username: 'Mohan Kumar', email: 'mohan@gmail.com',
        roleKey: 'store_manager', department: 'Store Department'
      }));
      return true;
    })()
  `);
  await goto('/');
  check(pageErrors.length === 0, 'no uncaught exception on the Store dashboard', pageErrors.join(' | '));

  const badge = await evaluate(`
    (() => { const b = document.querySelector('.notification-badge'); return b ? b.innerText : null; })()
  `);
  check(!!badge && parseInt(badge, 10) > 0, 'the Store manager opens the department and sees an unread badge', String(badge));

  const storeNotif = await evaluate(`
    (() => {
      const n = (JSON.parse(localStorage.getItem('notifications') || '[]'))
        .find(x => x.title === 'Purchase Order PDF sent to Store');
      return n ? { targetDept: n.targetDept, link: n.link, docId: n.docId, docName: n.docName } : null;
    })()
  `);
  check(!!storeNotif && storeNotif.targetDept === 'Store Department', 'the notification is addressed to the Store Department', JSON.stringify(storeNotif));
  check(!!storeNotif && String(storeNotif.docId || '').startsWith('wfdoc-'), 'the notification carries the PO document id', JSON.stringify(storeNotif));

  /* the Store dashboard runs its own notification block — the pushed
     notification must be listed there, on top, marked unread */
  const dashRow = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('button')]
        .filter(b => !b.closest('.notifications-panel') && b.innerText.includes('Purchase Order PDF sent to Store'));
      return { count: rows.length, texts: rows.map(r => r.innerText) };
    })()
  `);
  check(dashRow.count > 0, 'the Store dashboard lists the PO PDF notification', JSON.stringify(dashRow));
  check(
    dashRow.texts.some((x) => x.includes('Purchase Indent PI-UI-1')),
    'the row shows where the PO came from',
    JSON.stringify(dashRow.texts)
  );

  await evaluate(`
    (() => {
      window.__opened = [];
      window.open = (u) => { window.__opened.push(String(u)); return {}; };
      const row = [...document.querySelectorAll('button')]
        .find(b => !b.closest('.notifications-panel') && b.innerText.includes('Purchase Order PDF sent to Store'));
      if (row) row.click();
      return !!row;
    })()
  `);
  await sleep(1000);
  const openedFromDashboard = await evaluate(`window.__opened || []`);
  check(
    openedFromDashboard.length > 0 && String(openedFromDashboard[0]).startsWith('blob:'),
    'clicking the Store dashboard notification opens the PO PDF Purchase sent',
    JSON.stringify(openedFromDashboard)
  );
  const seen = await evaluate(`JSON.parse(localStorage.getItem('storeDashboardSeen') || '[]')`);
  check(
    Array.isArray(seen) && seen.some((k) => String(k).startsWith('notif:')),
    'the notification is marked as seen once opened',
    JSON.stringify(seen)
  );
  const pathAfterRow = await evaluate('location.pathname');
  check(pathAfterRow === '/', 'opening the PDF does not navigate away from the dashboard', String(pathAfterRow));

  /* the bell carries the same notification on every Store page */
  await evaluate(`(() => { const b = document.querySelector('.notification-bell'); if (b) b.click(); return !!b; })()`);
  await sleep(900);
  const item = await evaluate(`
    (() => {
      const it = [...document.querySelectorAll('.notification-item')]
        .find(x => x.innerText.includes('Purchase Order PDF sent to Store'));
      return it ? {
        clickable: it.classList.contains('is-clickable'),
        marked: it.classList.contains('has-document'),
        text: it.innerText
      } : null;
    })()
  `);
  check(!!item, 'the PO PDF notification is listed in the bell for the Store manager');
  check(!!item && item.clickable, 'the notification is clickable', JSON.stringify(item));
  check(!!item && item.marked, 'the notification is marked as carrying a document', JSON.stringify(item));

  await evaluate(`
    (() => {
      const it = [...document.querySelectorAll('.notification-item')]
        .find(x => x.innerText.includes('Purchase Order PDF sent to Store'));
      if (it) it.click();
      return !!it;
    })()
  `);
  await sleep(900);
  const openedTabs = await evaluate(`window.__opened || []`);
  check(
    openedTabs.length > 1 && String(openedTabs[openedTabs.length - 1]).startsWith('blob:'),
    'clicking the bell notification opens the PO PDF as well',
    JSON.stringify(openedTabs)
  );
  const pathAfter = await evaluate('location.pathname');
  check(pathAfter === '/', 'the click does not drag the Store manager away from the dashboard', String(pathAfter));

  const storeDocBytes = storeNotif?.docId ? await docBytes(storeNotif.docId) : null;
  check(
    Array.isArray(storeDocBytes) && storeDocBytes[0] > 1000,
    'the document the notification points at really exists',
    JSON.stringify(storeDocBytes)
  );
  check(pageErrors.length === 0, 'no uncaught exception handling the notification', pageErrors.join(' | '));
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
console.log('PO PDF to Store OK');
