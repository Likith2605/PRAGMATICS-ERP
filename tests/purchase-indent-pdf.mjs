/** Browser verification for Purchase Indent PDF download, print, branding and pagination. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_SERVER_ISOLATION_SCRIPT } from './helpers/liveServerIsolation.mjs';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4322;
const downloadDir = mkdtempSync(join(tmpdir(), 'indent-pdf-download-'));
const profileDir = mkdtempSync(join(tmpdir(), 'indent-pdf-chrome-'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = join(DIST, normalize(path).replace(/^([/\\])+/, ''));
  if (!existsSync(file) || path === '/') file = join(DIST, 'index.html');
  try { res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file)); }
  catch { res.writeHead(404).end('not found'); }
});
await new Promise((resolve) => server.listen(PORT, resolve));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9335', `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: 'ignore' });
let ws;
let msgId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
let passed = 0;
let failed = 0;
const check = (condition, label) => { if (condition) { passed += 1; console.log(`ok  ${label}`); } else { failed += 1; console.log(`FAIL ${label}`); } };

try {
  let target;
  for (let i = 0; i < 60 && !target; i += 1) {
    try { target = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find((entry) => entry.type === 'page'); } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Chrome endpoint unavailable');
  console.log('Chrome DevTools endpoint ready');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), sleep(10000).then(() => { throw new Error('Chrome WebSocket connection timed out'); })]);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    }
  };
  await send('Runtime.enable'); await send('Page.enable');
  console.log('Chrome page session ready');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: LIVE_SERVER_ISOLATION_SCRIPT });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/purchase-indents?indent=IND-PDF-TEST` });
  await sleep(1800);
  console.log('Seeded Purchase Indent loaded');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate(`
    localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn:true, username:'PDF Test Admin', roleKey:'admin', role:'Administrator' }));
    localStorage.setItem('companySettings', JSON.stringify({ companyName:'PDF TEST COMPANY', address:'', phone:'', email:'', website:'', gstin:'' }));
    localStorage.setItem('purchaseIndents', JSON.stringify([{
      indentNumber:'IND-PDF-TEST', indentDate:'2026-11-11', requirementNumber:'PR-2026-88', soNumber:'SO-PDF-9',
      productionJob:'JOB-88', requiredDate:'2026-11-20', deliveryDate:'2026-11-25',
      createdBy:'Test Preparer', createdByDept:'Store Department', createdAt:'2026-11-11 10:00', submittedAt:'2026-11-11 11:00',
      poNumber:'', status:'Submitted', adminApprovedBy:'Test Approver', adminApprovedAt:'2026-11-11 12:00',
      adminApprovedRemarks:'Approved for procurement', reason:'Long document pagination fixture', storeRemarks:'Store note', purchaseRemarks:'Purchase note',
      history:Array.from({length:45}, (_,i)=>({at:'2026-11-11 12:'+String(i).padStart(2,'0'), action:'Workflow entry '+i, name:'Test Approver', details:'Recorded workflow history for pagination verification.'})),
      items:Array.from({length:38}, (_,i)=>({materialCode:'MAT-'+i, materialName:'Test Material '+i, description:'Long specification for line '+i+' with verified dimensions and material grade', unit:i%2?'Kg':'Nos', requiredQty:i+1, orderedQty:i+2, availableQty:1, purchaseQty:i+1, requiredDate:'2026-11-20', source:'Production Requirement Shortage'}))
    }]));
    localStorage.setItem('qualityChecks', JSON.stringify([{
      qcNumber:'QC-PDF-1', indentNumber:'IND-PDF-TEST', status:'Approved', inspector:'Test Inspector', inspectionDate:'2026-11-12',
      remarks:'QC note from source record', items:[{materialName:'Test Material 0',unit:'Nos',receivedQty:2,acceptedQty:2,rejectedQty:0,result:'Pass'}]
    }]));
  `);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/purchase-indents?indent=IND-PDF-TEST` });
  await sleep(1800);
  const body = await evaluate('document.body.innerText');
  check(body.includes('IND-PDF-TEST'), 'detail page opens the seeded indent');
  check(body.includes('View PDF') && body.includes('Download PDF') && body.includes('Print'), 'View, Download PDF and Print actions render on detail page');
  const edited = await evaluate(`(() => {
    const group=[...document.querySelectorAll('.field-group')].find(g=>g.querySelector('label')?.textContent.trim()==='Reason');
    const input=group?.querySelector('input'); if(!input || input.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Edited reason from PDF preview test');
    input.dispatchEvent(new Event('input',{bubbles:true})); return true;
  })()`);
  check(edited, 'editable indent field accepts a draft edit without saving a record');
  const previewOpened = await evaluate(`(() => {
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='View PDF')?.click();
    return new Promise(resolve=>setTimeout(()=>resolve(Boolean(document.querySelector('[role="dialog"] iframe[src^="blob:"]'))),1000));
  })()`);
  check(previewOpened, 'View PDF opens an in-page preview');
  await evaluate(`document.querySelector('[role="dialog"] button')?.click()`);
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await evaluate(`(() => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Download PDF')?.click())()`);
  await sleep(2200);
  const pdfName = readdirSync(downloadDir).find((name) => name.startsWith('PurchaseIndent-IND-PDF-TEST.pdf'));
  check(Boolean(pdfName), 'Download PDF writes a file');
  if (pdfName) {
    const bytes = readFileSync(join(downloadDir, pdfName));
    const contents = bytes.toString('latin1');
    check(contents.startsWith('%PDF-') && bytes.length > 3000, 'download is a non-empty PDF');
    const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    const pages = document.numPages;
    check(pages > 1, `long indent paginates across ${pages} pages`);
    let extracted = '';
    for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
      const page = await document.getPage(pageNum);
      extracted += (await page.getTextContent()).items.map((item) => item.str).join(' ') + ' ';
    }
    check(extracted.includes('PDF TEST COMPANY') && extracted.includes('29AKWPP8736E1ZA'), 'Company Settings name and official GSTIN fallback are printed');
    check(extracted.includes('NO.17/3A') && extracted.includes('+91 9880030466') && extracted.includes('pragmatic.vasudev@gmail.com') && extracted.includes('www.pragmaticengineers.in'), 'official contact details fill blank Company Settings fields');
    check(extracted.includes('Edited reason from PDF preview test'), 'Download PDF reflects the current unsaved edit');
    const firstPageOps = await (await document.getPage(1)).getOperatorList();
    check(firstPageOps.fnArray.some((op) => op === OPS.paintImageXObject || op === OPS.paintImageXObjectRepeat), 'company logo image is placed in the PDF header');
    check(extracted.includes('MAT-0') && extracted.includes('Test Material 0') && extracted.includes('Production Requirement Shortage'), 'material details, UOM/source table data are present');
    check(extracted.includes('Test Preparer') && extracted.includes('Test Approver'), 'recorded preparer and approver are printed');
    check(extracted.includes('Source Workflow') && extracted.includes('Store Review') && extracted.includes('PR-2026-88'), 'workflow source text is wrapped and legible in the PDF');
    check(extracted.includes('QC-PDF-1') && extracted.includes('Test Inspector') && extracted.includes('QC note from source record'), 'linked QC details and line information are printed');
    check(!extracted.includes('Customer Details') && !/undefined|null/.test(extracted), 'missing customer data is not fabricated');
  }
  const printInvoked = await evaluate(`(() => {
    window.__openedPrintPdf=''; window.open=(url)=>{window.__openedPrintPdf=String(url);return null;};
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Print')?.click();
    return new Promise(resolve=>setTimeout(()=>resolve(window.__openedPrintPdf.startsWith('blob:')),500));
  })()`);
  check(printInvoked, 'Print opens a generated PDF for printing');
} catch (error) {
  failed += 1; console.error(`Harness failure: ${error.stack || error}`);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill(); server.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  try { rmSync(downloadDir, { recursive: true, force: true }); } catch {}
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
