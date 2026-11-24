/**
 * Verifies the two attached-format documents end to end in the browser:
 *   1. Purchase Order print sheet + generatePurchaseOrderPDF ("PO to Supplier"
 *      format: Your Ref No., Ship To, Disc % / Unit Price, packing / freight,
 *      CGST-SGST split, Rs ... Only. words)
 *   2. Export Invoice page (list / open / new form) + generateExportInvoicePDF
 *      ("Invoice cum Packing List" format, USD, Rule 96A, SWIFT)
 *
 * Run:  node tests/exportinvoice-pdf.mjs   (requires a fresh `npm run build`)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_SERVER_ISOLATION_SCRIPT } from './helpers/liveServerIsolation.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4325;

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

const profile = mkdtempSync(join(tmpdir(), 'ei-pdf-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9346', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let msgId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

/* remove stale downloads from earlier runs */
const clearPattern = (re) => {
  try {
    readdirSync(tmpdir())
      .filter((n) => re.test(n))
      .forEach((n) => { try { unlinkSync(join(tmpdir(), n)); } catch { /* ignore */ } });
  } catch { /* ignore */ }
};
const newest = (re) => {
  const cands = readdirSync(tmpdir())
    .filter((n) => re.test(n))
    .map((n) => ({ n, t: statSync(join(tmpdir(), n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return cands.length ? join(tmpdir(), cands[0].n) : null;
};
const pdfChecks = (file, label) => {
  if (!file) { check(false, `${label}: the PDF file was written`, '(not found)'); return null; }
  check(true, `${label}: the PDF file was written (${file.split(/[\\/]/).pop()})`);
  const buf = readFileSync(file);
  check(buf.subarray(0, 5).toString('latin1') === '%PDF-', `${label}: valid PDF header`);
  check(buf.length > 3000, `${label}: PDF has real content (${buf.length} bytes)`);
  const raw = buf.toString('latin1');
  return raw
    .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/[()]/g, ' ')
    .replace(/\\[A-Za-z0-9]+/g, ' ');
};

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:9346/json/list')).json();
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
  /* Fixtures are seeded with Runtime.evaluate after the first load; keep the
     boot-time PostgreSQL hydration from overwriting them on the next
     navigation. */
  await send('Page.addScriptToEvaluateOnNewDocument', { source: LIVE_SERVER_ISOLATION_SCRIPT });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  /* ------------------------------ seed data ------------------------------ */
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1800);
  const poPayload = {
    poDetails: {
      poNumber: 'PO-TEST-1', poDate: '2026-09-30', deliveryDueDate: '2026-10-15',
      yourRefNo: 'ETP/26-27/EST-0319', yourRefDate: '2026-09-29',
      shipToName: 'Mr. Varadaraj (Stores)',
      shipToAddress: 'Sy No 4, Bommanahalli, Bengaluru - 560068',
      shipToMobile: '+91 9880519466',
      packingCharges: '500', freight: '300',
      paymentTerms: '30 Days', poStatus: 'Submitted', projectRef: 'PRJ-1',
      termsAndConditions: '1. Materials must strictly conform to specifications.\n2. Test certificate must accompany the delivery.'
    },
    vendorDetails: {
      companyName: 'Excel Technocrats', address: '12 Industrial Area, Bengaluru',
      contactNumber: '+91 9845000000', gstNumber: '29AAAAA0000A1Z5'
    },
    companyDetails: {
      companyName: 'PRAGMATIC ENGINEERS',
      address: 'NO.17/3A, KRISHNARAJU ESTATE, BENGALORE-560083',
      phone: '+91 9880030466', email: 'pragmatic.vasudev@gmail.com',
      gstin: '29AKWPP8736E1ZA', state: 'Karnataka (29)'
    },
    items: [
      {
        itemName: 'HMB HARDWARE', itemCode: '1501.250.000', drawingNo: 'DWG-01',
        hsnSac: '7326', quantity: 1, unit: 'NOS', unitPrice: 16850, gst: 18,
        amount: 16850, gstAmount: 3033, discountPct: 0
      }
    ],
    totals: {
      subtotal: 16850, discount: 0, taxableAmount: 16850, totalGST: 3033,
      cgst: 1516.5, sgst: 1516.5, grandTotal: 19883
    },
    amountInWords: 'Nineteen Thousand Eight Hundred Eighty Three Rupees'
  };
  const invPayload = {
    invoiceNumber: 'GST/26-27/032', invoiceDate: '2026-09-30', exporterRef: 'PE/EXP/001',
    buyersOrderNo: 'EST/26-27/037', buyersOrderDate: '2026-09-29',
    buyer: {
      name: 'ABC TRADING LLC', address: 'Jebel Ali Free Zone, Dubai, UAE',
      contactPerson: 'Mr. Ali', contactNo: '+971 50 000 0000'
    },
    shipToAddress: 'ABC TRADING LLC, Jebel Ali Free Zone, Dubai, UAE',
    logistics: {
      preCarriage: 'BY ROAD', placeOfReceipt: 'BENGALURU', portOfLoading: 'NHAVA SHEVA',
      finalDestination: 'JEBEL ALI', vesselFlight: 'MV EXPRESS', portOfDischarge: 'JEBEL ALI',
      marksNumbers: 'ABC / DUBAI', containerNo: 'MSCU1234567', otherReferences: 'PO-889'
    },
    countryOfOrigin: 'INDIA', countryOfDestination: 'UAE',
    termsOfDelivery: 'Ex-works', paymentTerms: 'OTHERS, 30 DAYS',
    items: [{ packages: '20 CTNS', description: 'CNC MACHINED PARTS', quantity: 10.625, unit: 'Kg', rate: 80, amount: 850 }],
    netWeight: '10.500 KGS', grossWeight: '25.000 KGS',
    declaration: 'We declare that the particulars given above are true and correct and that the items are of Indian origin.',
    companyDetails: {
      companyName: 'PRAGMATIC ENGINEERS',
      address: 'NO.17/3A, KRISHNARAJU ESTATE, BENGALORE-560083',
      email: 'pragmatic.vasudev@gmail.com', phone: '+91 9880030466',
      gstin: '29AKWPP8736E1ZA', pan: 'AKWPP8736E'
    },
    exportProfile: {
      contactPerson: 'S. Vasudeva Prashanth', contactNo: '+91 98800 30466',
      iecNumber: 'AKWPP8736E', lutNumber: 'AD2904260184606'
    },
    bankDetails: {
      bankName: 'HDFC BANK', branch: 'BANNERGHATTA ROAD',
      accountNumber: '50200012345678', swiftCode: 'HDFCINBB'
    },
    totals: { amountUSD: 850 },
    amountInWords: 'Eight Hundred Fifty Only.',
    status: 'Issued'
  };

  await evaluate(`
    localStorage.setItem('erp_auth', JSON.stringify({
      isLoggedIn: true, username: 'Admin', email: 'admin@gmail.com',
      roleKey: 'admin', role: 'Administrator'
    }));
    localStorage.setItem('companySettings', ${JSON.stringify(JSON.stringify({
      companyName: 'PRAGMATIC ENGINEERS',
      address: 'NO.17/3A, KRISHNARAJU ESTATE, BENGALORE-560083',
      phone: '+91 9880030466', email: 'pragmatic.vasudev@gmail.com',
      gstin: '29AKWPP8736E1ZA', state: 'Karnataka (29)',
      bankDetails: { bankName: 'HDFC BANK', branch: 'BANNERGHATTA ROAD', accountNumber: '50200012345678' }
    }))});
    localStorage.setItem('supplierPOHistory', ${JSON.stringify(JSON.stringify([{
      date: '2026-09-30', reference: 'PO-TEST-1', vendor: 'Excel Technocrats',
      projectRef: 'PRJ-1', dueDate: '2026-10-15', total: '₹ 20683.00', status: 'Submitted',
      payload: poPayload
    }]))});
    localStorage.setItem('exportInvoiceHistory', ${JSON.stringify(JSON.stringify([{
      reference: 'GST/26-27/032', date: '2026-09-30', buyer: 'ABC TRADING LLC', status: 'Issued',
      payload: invPayload
    }]))});
  `);

  /* ============================ 1. PURCHASE ORDER ============================ */
  console.log('\n== Purchase Order (PO to Supplier format)');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/purchase-order` });
  await sleep(2400);

  const opened = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'View');
      if (!b) return false; b.click(); return true; })()
  `);
  check(opened === true, 'the seeded PO opens from the list');
  await sleep(900);

  const poShown = await evaluate('document.body.innerText');
  check(poShown.includes('PO-TEST-1'), 'the view shows PO-TEST-1');
  check(poShown.includes('Ship To:'), 'the print sheet has the Ship To block');
  check(poShown.includes('Your Ref No.:'), 'the print sheet shows Your Ref No.');
  check(poShown.includes('ETP/26-27/EST-0319'), 'the vendor reference is printed');
  check(poShown.includes('Total Purchase Value In Amount'), 'the amount-in-words box label is present');
  check(poShown.includes('Rs. Twenty Thousand Six Hundred Eighty Three Only.'), 'the words include packing + freight (20683)');
  check(poShown.includes('20683.00'), 'the grand total block shows 20683.00 (19883 + 500 packing + 300 freight)');
  check(poShown.includes('Packing Charges') && poShown.includes('FREIGHT'), 'packing charges and freight rows are present');
  check(poShown.includes('Disc %') && poShown.includes('Unit Price'), 'the table has Disc % and Unit Price columns');

  clearPattern(/^PurchaseOrder-PO-TEST-1\.pdf( \(\d+\))?$/);
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: tmpdir() });
  const dlPO = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Download PDF');
      if (!b) return false; b.click(); return true; })()
  `);
  check(dlPO === true, 'the Download PDF button is clickable');
  await sleep(3200);

  const flat = pdfChecks(newest(/^PurchaseOrder-PO-TEST-1\.pdf( \(\d+\))?$/), 'PO PDF');
  if (flat) {
    check(flat.includes('PURCHASE ORDER'), 'the PURCHASE ORDER title is printed');
    check(flat.includes('Ship To'), 'the Ship To block is printed');
    check(flat.includes('Your Ref No.'), 'Your Ref No. label is printed');
    check(flat.includes('ETP/26-27/EST-0319'), 'the vendor reference is printed in the PDF');
    check(flat.includes('GSTIN'), 'the GSTIN is printed');
    check(flat.includes('Description') && flat.includes('of Materials'), 'the materials table header is printed');
    check(flat.includes('Unit Price'), 'the Unit Price column is printed');
    check(flat.includes('GRAND TOTAL'), 'the GRAND TOTAL row is printed');
    const digits = [...new Set((flat.match(/\d[\d,]*\.\d{2}/g) || []).map((d) => d.replace(/,/g, '')))];
    check(digits.includes('20683.00'), `the grand total 20683.00 is printed (${digits.slice(0, 10).join(', ')})`);
    check(digits.includes('17350.00'), 'the sub total 17350.00 (incl. packing) is printed');
    check(digits.includes('500.00'), 'the packing charges 500.00 is printed');
    check(digits.includes('300.00'), 'the freight 300.00 is printed');
    check(digits.includes('1516.50'), 'the split CGST/SGST 1516.50 is printed');
    check(flat.includes('Twenty Thousand'), 'the amount in Rs ... Only. words is printed');
  }

  /* ============================= 2. EXPORT INVOICE ============================= */
  console.log('\n== Export Invoice (Invoice cum Packing List format)');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/export-invoice` });
  await sleep(2400);

  const listShown = await evaluate('document.body.innerText');
  check(listShown.includes('GST/26-27/032'), 'the export invoice list shows the seeded invoice');
  check(listShown.includes('ABC TRADING LLC'), 'the buyer name is listed');
  check(listShown.includes('850.00'), 'the USD amount is listed');

  const openInv = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Open');
      if (!b) return false; b.click(); return true; })()
  `);
  check(openInv === true, 'the seeded export invoice opens');
  await sleep(900);

  const invShown = await evaluate('document.body.innerText');
  check(invShown.includes('Port of Loading') && invShown.includes('NHAVA SHEVA'), 'the view shows the logistics fields');
  check(invShown.includes('Eight Hundred Fifty Only.'), 'the USD amount-in-words is shown');

  clearPattern(/^ExportInvoice-GST-26-27-032\.pdf( \(\d+\))?$/);
  const dlInv = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Download PDF');
      if (!b) return false; b.click(); return true; })()
  `);
  check(dlInv === true, 'the export invoice Download PDF button is clickable');
  await sleep(3200);

  const flat2 = pdfChecks(newest(/^ExportInvoice-GST-26-27-032\.pdf( \(\d+\))?$/), 'Export Invoice PDF');
  if (flat2) {
    check(flat2.includes('INVOICE CUM PACKING LIST'), 'the INVOICE CUM PACKING LIST title is printed');
    check(flat2.includes('ABC TRADING LLC'), 'the buyer is printed');
    check(flat2.includes('NHAVA SHEVA'), 'the port of loading is printed');
    check(flat2.includes('CNC MACHINED PARTS'), 'the goods description is printed');
    check(flat2.includes('IEC NO.'), 'the IEC number line is printed');
    check(/rule 96a/i.test(flat2), 'the LUT Rule 96A declaration is printed');
    check(flat2.includes('SWIFT'), 'the SWIFT code label is printed');
    check(flat2.includes('HDFCINBB'), 'the SWIFT code value is printed');
    check(flat2.includes('Eight Hundred Fifty Only.'), 'the amount in words is printed');
    const digits2 = [...new Set(flat2.match(/\d[\d,]*\.\d{2}/g) || [])];
    check(digits2.includes('850.00'), `the USD total 850.00 is printed (${digits2.slice(0, 10).join(', ')})`);
    check(/\bFor\b/.test(flat2) && flat2.includes('PRAGMATIC ENGINEERS'), 'the signature block (For + company name) is printed');
    check(/19\.84\d+ 788\.03\d+ 555\.59\d+ -769\.\d+ re/.test(flat2), 'the outer page frame rect is drawn (7mm / 19mm / 196 x 271.6mm)');
    check(/19\.84\d+ 788\.03\d+ 555\.59\d+ -769\.\d+ re\s+S/.test(flat2), 'the outer page frame is stroked');
  }

  /* ------------------------- new invoice form opens ------------------------- */
  const backBtn = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Back to List');
      if (!b) return false; b.click(); return true; })()
  `);
  check(backBtn === true, 'Back to List returns to the export invoice list');
  await sleep(700);
  const newBtn = await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('New Export Invoice'));
      if (!b) return false; b.click(); return true; })()
  `);
  check(newBtn === true, 'the New Export Invoice button exists');
  await sleep(700);
  const formShown = await evaluate('document.body.innerText');
  check(formShown.includes('Invoice Details') && formShown.includes('Export Profile'), 'the create form renders its sections');
  const previewNo = await evaluate(`
    (() => { const i = [...document.querySelectorAll('input')].find(x => /^GST\\//.test(x.value || ''));
      return i ? i.value : ''; })()
  `);
  check(/^GST\/\d{2}-\d{2}\/\d{3}$/.test(previewNo), `a preview invoice number is generated (${previewNo || 'not found'})`);
  check(formShown.includes('Pre-Carriage by'), 'the logistics fields are on the form');

  /* -------------------- sidebar: dropdown under Customer Invoice -------------------- */
  console.log('\n== Sidebar: Export Invoice under Customer Invoice');
  const exportLinks = await evaluate(`
    (() => [...document.querySelectorAll('aside a')].filter(a => a.getAttribute('href') === '/export-invoice').length)()
  `);
  check(exportLinks === 1, `exactly one Export Invoice link in the sidebar (${exportLinks})`);
  const customerLinks = await evaluate(`
    (() => [...document.querySelectorAll('aside a')].filter(a => a.getAttribute('href') === '/customer-invoice').length)()
  `);
  check(customerLinks === 1, `exactly one Customer Invoice link in the sidebar (${customerLinks})`);
  const asideText = await evaluate(`document.querySelector('aside').innerText`);
  check(asideText.includes('Customer Invoice'), 'the sidebar has a Customer Invoice group');
  const nested = await evaluate(`
    (() => {
      const aside = document.querySelector('aside');
      const groups = [...aside.querySelectorAll('.nav-group')];
      return groups.some(g => g.innerText.includes('Customer Invoice') && g.innerText.includes('Export Invoice'));
    })()
  `);
  check(nested === true, 'Export Invoice is nested under the Customer Invoice group');

  /* ---------------------- Sales Order → Export Invoice connection ---------------------- */
  console.log('\n== Sales Order -> Export Invoice connection');
  await evaluate(`
    localStorage.setItem('salesOrderHistory', ${JSON.stringify(JSON.stringify([{
      reference: 'SO-TEST-1', date: '2026-09-28', status: 'Confirmed',
      payload: {
        soDetails: {
          soNumber: 'SO-TEST-1', soDate: '2026-09-28', quotationRef: 'Q-777',
          customerPoNumber: 'CPO-555', customerPoDate: '2026-09-25',
          projectId: 'PRJ-1', placeOfSupply: 'Jebel Ali, Dubai'
        },
        customerDetails: {
          customerName: 'Mr Buyer', companyName: 'XYZ IMPORTS LLC',
          address: 'Jebel Ali Free Zone, Dubai, UAE',
          contactNumber: '+971 55 000 1111', email: 'buyer@xyz.ae'
        },
        companyDetails: { companyName: 'PRAGMATIC ENGINEERS' },
        items: [
          { itemCode: 'P-001', itemName: 'MACHINED HOUSING', quantity: 10, unit: 'Nos', unitPrice: 500, gst: 18 }
        ]
      }
    }]))});
  `);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/sales-order` });
  await sleep(2400);

  const picked = await evaluate(`
    (() => { const s = document.querySelector('select.action-select');
      if (!s) return false;
      s.value = 'export_invoice';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true; })()
  `);
  check(picked === true, 'the Sales Order Workflow Actions dropdown exists');
  await sleep(1300);

  const soBody = await evaluate('document.body.innerText');
  check(soBody.includes('Create Export Invoice'), 'the SO action opens the Export Invoice create form');
  check((await evaluate('location.pathname')) === '/export-invoice', 'the app navigates to /export-invoice');

  const prefilled = await evaluate(`
    (() => {
      const inputs = [...document.querySelectorAll('input, textarea')];
      return {
        buyer: inputs.some(i => i.value === 'XYZ IMPORTS LLC'),
        address: inputs.some(i => (i.value || '').includes('Jebel Ali Free Zone')),
        contact: inputs.some(i => i.value === '+971 55 000 1111'),
        orderNo: inputs.some(i => i.value === 'CPO-555'),
        otherRef: inputs.some(i => i.value === 'SO-TEST-1'),
        qty: inputs.some(i => i.type === 'number' && i.value === '10'),
        desc: inputs.some(i => (i.value || '').includes('MACHINED HOUSING')),
        rateNotCopied: !inputs.some(i => i.value === '500')
      };
    })()
  `);
  check(prefilled.buyer, 'buyer name flows from the Sales Order');
  check(prefilled.address, 'buyer address flows from the Sales Order');
  check(prefilled.contact, 'buyer contact flows from the Sales Order');
  check(prefilled.orderNo, "the buyer's order no (customer PO) flows in");
  check(prefilled.otherRef, 'the SO number is carried as Other Reference');
  check(prefilled.qty, 'item quantity flows from the Sales Order');
  check(prefilled.desc, 'item description flows from the Sales Order');
  check(prefilled.rateNotCopied, 'the USD rate is left blank (INR price is not copied)');

  const sourceShown = await evaluate('document.body.innerText');
  check(sourceShown.includes('SO-TEST-1'), 'the source Sales Order is shown on the form');
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
console.log('PO + Export Invoice PDF OK');
