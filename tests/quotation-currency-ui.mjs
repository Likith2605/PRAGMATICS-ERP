/**
 * Multi-currency quotations E2E test.
 *
 * Covers:
 *   - Currency defaults to INR and the FX fields stay hidden for INR
 *   - Choosing a foreign currency reveals Exchange Rate + Rate Date
 *   - Saving a non-INR quotation without a rate is blocked (field error)
 *   - The live hint shows the rate and the INR equivalent of the grand total
 *   - Preview prints the currency, the rate, the tax treatment and foreign money
 *   - The history entry carries currency + amountINR + the FX snapshot
 *   - Re-opening from history restores currency / rate / tax treatment
 *   - Switching back to INR hides the FX fields and saves a plain INR quotation
 *
 * Run:  node tests/quotation-currency-ui.mjs   (requires a fresh `npm run build`)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');
const DIST = join(ROOT, 'dist');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4344;
const DEBUG_PORT = 9344;

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

const profile = mkdtempSync(join(tmpdir(), 'qt-cur-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'
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
  window.__sel = (el, v) => {
    if (!el) throw new Error('select not found');
    el.value = String(v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.__btn = (text, root) => {
    const list = Array.from((root || document).querySelectorAll('button'));
    return list.find((b) => b.textContent.trim() === text) || list.find((b) => b.textContent.includes(text)) || null;
  };
  window.__click = (el) => { if (!el) throw new Error('element to click not found'); el.click(); };
  true;
`;

try {
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
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
      window.__set(document.getElementById('customerName'), 'Currency Test Customer');
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

  const setCurrency = async (code) => {
    await evaluate(`window.__sel(document.getElementById('quotationCurrency'), ${JSON.stringify(code)})`);
    await sleep(350);
  };

  const setFxField = async (value) => {
    await evaluate(`window.__set(document.getElementById('exchangeRate'), ${JSON.stringify(value)})`);
    await sleep(250);
  };

  const setTaxMode = async (mode) => {
    await evaluate(`window.__sel(document.getElementById('taxMode'), ${JSON.stringify(mode)})`);
    await sleep(250);
  };

  const saveForm = async () => {
    await evaluate(`window.__click(window.__btn('Save', document.querySelector('form.quotation-form')))`);
    await sleep(1600);
    return evaluate('location.pathname');
  };

  /* ================= Section 1: INR default, no FX fields ================= */
  console.log('\n== INR default ==');
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

  const inr0 = await evaluate(`(() => ({
    currency: (document.getElementById('quotationCurrency') || {}).value,
    rateField: Boolean(document.getElementById('exchangeRate')),
    rateDate: Boolean(document.getElementById('rateDate')),
    taxMode: (document.getElementById('taxMode') || {}).value,
    taxOptions: Array.from(document.querySelectorAll('#taxMode option')).map((o) => o.value)
  }))()`);
  check(inr0.currency === 'INR', 'the quotation defaults to INR', JSON.stringify(inr0));
  check(!inr0.rateField && !inr0.rateDate, 'no exchange rate / rate date fields are shown for INR');
  check(inr0.taxMode === 'intra' && inr0.taxOptions.join(',') === 'intra,inter,export',
    'Tax Treatment defaults to CGST + SGST with the three modes available', JSON.stringify(inr0.taxOptions));

  /* ================= Section 2: foreign currency requires a rate ================= */
  console.log('\n== Foreign currency requires an exchange rate ==');
  await fillCustomerProject('PRJ-CUR-01');
  await pickTemplate('standard_part');
  await fillItem(0, { 'Drawing No.': 'DWG-CUR-01', 'Item Description': 'Currency Test Part', 'Qty': '2', 'Price': '100' });

  await setCurrency('USD');
  const usd0 = await evaluate(`(() => ({
    currency: document.getElementById('quotationCurrency').value,
    rateField: Boolean(document.getElementById('exchangeRate')),
    rateDate: Boolean(document.getElementById('rateDate')),
    rateRequired: (document.querySelector('label[for="exchangeRate"]') || {}).textContent || '',
    hint: (document.querySelector('#exchangeRate') || {}).placeholder || ''
  }))()`);
  check(usd0.currency === 'USD', 'the currency switch to USD is applied');
  check(usd0.rateField && usd0.rateDate, 'Exchange Rate and Rate Date appear for a foreign currency');
  check(usd0.rateRequired.includes('USD') && usd0.rateRequired.includes('*'),
    'the exchange rate field is labelled as required', JSON.stringify(usd0.rateRequired));

  const blockedPath = await saveForm();
  const blocked = await evaluate(`(() => ({
    err: (document.querySelector('.field-hint.error') || {}).textContent || '',
    history: JSON.parse(localStorage.getItem('quotationHistory') || '[]').length
  }))()`);
  check(blockedPath === '/quotation', 'saving without an exchange rate stays on the form', blockedPath);
  check(blocked.err.includes('Exchange rate'), 'the exchange rate field shows the blocking error', JSON.stringify(blocked.err));
  check(blocked.history === 0, 'no history entry is written while the rate is missing');

  /* ================= Section 3: rate + export tax mode ================= */
  console.log('\n== Rate, INR hint and preview ==');
  await setFxField('83.45');
  await setTaxMode('export');
  const hint = await evaluate(`(() => {
    const f = document.getElementById('exchangeRate');
    const box = f ? f.parentElement : null;
    return box ? box.innerText : '';
  })()`);
  check(hint.includes('1 USD = 83.45 INR'), 'the hint repeats the entered rate', JSON.stringify(hint));
  check(hint.includes('16,690.00'), 'the hint shows the INR equivalent of the grand total', JSON.stringify(hint));

  const savedPath = await saveForm();
  check(savedPath === '/quotation/preview', 'the quotation saves once a rate is provided', savedPath);

  const prev = await evaluate(`(() => {
    const t = document.body.innerText;
    return {
      currencyLine: /Currency:\\s*USD[^\\n]*/.exec(t) ? /Currency:\\s*USD[^\\n]*/.exec(t)[0] : '',
      taxLine: /Tax:\\s*[^\\n]*/.exec(t) ? /Tax:\\s*[^\\n]*/.exec(t)[0] : '',
      hasUsdTotal: t.includes('USD 200.00'),
      words: (document.body.innerText.match(/Two Hundred Dollars/) || [])[0] || '',
      hasInrRate: t.includes('1 USD = 83.45 INR')
    };
  })()`);
  check(prev.currencyLine.includes('USD') && prev.hasInrRate,
    'the preview prints the currency with its INR rate', JSON.stringify(prev.currencyLine));
  check(prev.taxLine.includes('Export / LUT - zero rated'), 'the preview prints the chosen tax treatment', JSON.stringify(prev.taxLine));
  check(prev.hasUsdTotal, 'the grand total is printed in USD');
  check(prev.words === 'Two Hundred Dollars', 'the amount in words uses the foreign currency', JSON.stringify(prev.words));

  const hist = await evaluate(`(() => {
    const h = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    const e = h[0] || null;
    if (!e) return null;
    return {
      count: h.length,
      currency: e.currency,
      total: e.total,
      amountINR: e.amountINR,
      payloadCurrency: e.payload.quotationDetails.currency,
      payloadRate: e.payload.quotationDetails.exchangeRate,
      payloadTaxMode: e.payload.quotationDetails.taxMode
    };
  })()`);
  check(Boolean(hist), 'the quotation is written to history');
  check(hist && hist.currency === 'USD' && hist.payloadCurrency === 'USD',
    'the history entry records the currency', JSON.stringify(hist));
  check(hist && hist.total === '$200.00', 'the history total is formatted in the quotation currency', JSON.stringify(hist && hist.total));
  check(hist && Number(hist.amountINR) === 16690, 'the history entry stores the INR equivalent', JSON.stringify(hist && hist.amountINR));
  check(hist && String(hist.payloadRate) === '83.45', 'the FX rate is stored on the payload', JSON.stringify(hist && hist.payloadRate));
  check(hist && hist.payloadTaxMode === 'export', 'the tax treatment is stored on the payload', JSON.stringify(hist && hist.payloadTaxMode));

  /* ================= Section 4: reopen from history ================= */
  console.log('\n== Re-opening the foreign quotation ==');
  await go('/quotation');
  const opened = await evaluate(`(() => {
    const sel = Array.from(document.querySelectorAll('.history-table tbody tr'))
      .map((tr) => tr.querySelector('select.action-select'))
      .find(Boolean);
    if (!sel) return false;
    sel.value = 'editQuotation';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  check(opened === true, 'the quotation is opened for editing from history');
  await sleep(900);

  const reopened = await evaluate(`(() => ({
    currency: (document.getElementById('quotationCurrency') || {}).value,
    rate: (document.getElementById('exchangeRate') || {}).value,
    taxMode: (document.getElementById('taxMode') || {}).value,
    rateVisible: Boolean(document.getElementById('exchangeRate'))
  }))()`);
  check(reopened.currency === 'USD', 'the currency is restored when editing', JSON.stringify(reopened));
  check(reopened.rate === '83.45' && reopened.rateVisible, 'the exchange rate is restored when editing', JSON.stringify(reopened));
  check(reopened.taxMode === 'export', 'the tax treatment is restored when editing', JSON.stringify(reopened));

  /* ================= Section 5: switch back to INR ================= */
  console.log('\n== Switching back to INR ==');
  await setCurrency('INR');
  const backInr = await evaluate(`(() => ({
    rateField: Boolean(document.getElementById('exchangeRate')),
    rateDate: Boolean(document.getElementById('rateDate'))
  }))()`);
  check(!backInr.rateField && !backInr.rateDate, 'the FX fields disappear when the currency returns to INR');

  const resavedPath = await saveForm();
  check(resavedPath === '/quotation/preview', 'the INR quotation saves without an exchange rate', resavedPath);

  const inrPrev = await evaluate(`(() => {
    const t = document.body.innerText;
    const g = t.slice(t.indexOf('TOTAL'), t.indexOf('TOTAL') + 40);
    return {
      currencyLine: /Currency:\\s*INR/.test(t),
      showsRate: /1 USD = 83.45 INR/.test(t),
      hasInrTotal: g.includes('TOTAL') && g.includes('200.00'),
      gt: g,
      usdLeftover: t.includes('USD 200.00'),
      words: t.includes('Two Hundred Rupees')
    };
  })()`);
  check(inrPrev.currencyLine, 'the preview now prints INR as the currency');
  check(!inrPrev.showsRate, 'no FX rate is printed for an INR quotation');
  check(inrPrev.hasInrTotal && !inrPrev.usdLeftover, 'the grand total row shows the plain INR amount',
    JSON.stringify(inrPrev));
  check(inrPrev.words, 'the amount in words is back to Rupees');

  const histInr = await evaluate(`(() => {
    const h = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    const e = h[0] || null;
    return e ? { count: h.length, currency: e.currency, total: e.total, amountINR: e.amountINR } : null;
  })()`);
  check(histInr && histInr.count === 1, 're-saving does not duplicate the history entry', JSON.stringify(histInr));
  check(histInr && histInr.currency === 'INR', 'the history entry is updated to INR', JSON.stringify(histInr));
  check(histInr && histInr.total === '₹200.00', 'the history total is formatted in rupees', JSON.stringify(histInr && histInr.total));
  check(histInr && Number(histInr.amountINR) === 200, 'the INR equivalent matches the total', JSON.stringify(histInr && histInr.amountINR));

  /* ================= Section 6: runtime errors ================= */
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
console.log('Quotation Currency OK');
