/**
 * Quality report test (no framework required).
 * Run:  node tests/quality-report.test.mjs
 *
 * Covers the ERP quality report bridge:
 *   QualityApp server /api/sync/pull snapshot
 *     -> report payloads (check / drawing / dispatch)
 *     -> the mobile app's own HTML report builders
 *
 * The builders are the same code the mobile app runs, so this asserts the ERP
 * renders the identical document: header, PASS/FAIL, tolerance text, QR sticker.
 */

/* ------------------------------- localStorage shim ------------------------------- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
  setItem: (k, v) => mem.set(String(k), String(v)),
  removeItem: (k) => mem.delete(String(k)),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  }
};

const api = await import('../src/quality/qualityApi.js');
const { buildReportHtml, buildOverallReportHtml } = await import('../src/quality/report/pdf.js');
const { buildDispatchQrSvg, buildStickerHtml, buildDispatchQrText } = await import('../src/quality/report/sticker.js');
const { getLogoDataUri } = await import('../src/quality/report/logo.js');
const { COMPANY_NAME } = await import('../src/quality/config.js');
const { QUALITY_REPORT_FOOTER } = await import('../src/quality/report/footer.js');
const { normalizeQualityNumber } = await import('../server/qualityPullSync.js');

/* --------------------------------- test runner --------------------------------- */
let passed = 0;
let failed = 0;
const failures = [];

const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
};

const assertExactFooter = (html) => {
  const footers = [...html.matchAll(/<div class="footer">([\s\S]*?)<\/div>/g)];
  eq(footers.length, 1, 'exactly one footer');
  eq(footers[0]?.[1], QUALITY_REPORT_FOOTER, 'footer contains only the approved text');
};

const eq = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* ------------------------- fixture: an /api/sync/pull payload ------------------------- */
const nowIso = '2026-03-04 10:15:00';
const laterIso = '2026-03-05 14:45:00';

const snapshot = {
  server_time: laterIso,
  employees: [
    { id: 1, employee_id: 'QC001', name: 'Ravi Kumar', password: 'x', role: 'qc' },
    { id: 2, employee_id: 'DES001', name: 'Anita Desai', password: 'x', role: 'designer' }
  ],
  drawings: [
    {
      id: 10,
      drawing_no: 'DRG-1001',
      part_name: 'Flange Plate',
      customer: 'Acme Ltd',
      revision: 'B',
      material: 'MS IS 2062 E250',
      unit: 'mm',
      notes: 'Deburr edges',
      invoice_no: 'INV-77',
      invoice_date: '2026-02-01',
      drawing_rev_date: '2026-02-20',
      po_no: 'PO-55',
      qty: '250',
      treatment: 'Pickling',
      hardness: 'HB 180-220',
      image_uri: null,
      created_by: 2,
      created_at: '2026-02-19 09:00:00'
    }
  ],
  dimensions: [
    { id: 100, drawing_id: 10, dim_no: 1, description: 'Outer Dia', nominal: 120, nominal_text: '120', tol_upper: 0.2, tol_lower: -0.1 },
    { id: 101, drawing_id: 10, dim_no: 2, description: 'Bore Dia', nominal: 60, nominal_text: 'Bore Ø', tol_upper: 0.05, tol_lower: 0 },
    { id: 102, drawing_id: 10, dim_no: 3, description: 'Thickness', nominal: 10, nominal_text: '10 THK', tol_upper: 0.1, tol_lower: -0.1 }
  ],
  checks: [
    {
      id: 500,
      client_id: 'CH-500',
      drawing_id: 10,
      checked_by: 1,
      checked_at: nowIso,
      result: 'PASS',
      instrument: 'Vernier Calliper',
      inspector_notes: 'All dimensions within limits',
      inspector_name: 'Ravi Kumar'
    },
    {
      id: 501,
      client_id: 'CH-501',
      drawing_id: 10,
      checked_by: 1,
      checked_at: laterIso,
      result: 'FAIL',
      instrument: 'Micrometer',
      inspector_notes: 'Bore oversize on 2 samples',
      inspector_name: 'Ravi Kumar'
    }
  ],
  measurements: [
    // check 500 (older, superseded for dim 1 by check 501)
    { id: 900, check_id: 500, dimension_id: 100, sample1: 119.95, sample2: 120.02, remarks: '', pass: 1, instrument: 'Vernier Calliper', sample_status: 'OK|OK' },
    { id: 901, check_id: 500, dimension_id: 101, sample1: 60.01, sample2: 60.02, remarks: '', pass: 1, instrument: 'Vernier Calliper', sample_status: 'OK|OK' },
    // check 501 (newer -> wins for dim 1)
    { id: 902, check_id: 501, dimension_id: 100, sample1: 120.4, sample2: 120.45, remarks: 'Oversize', pass: 0, instrument: 'Micrometer', sample_status: 'NOT OK|NOT OK' },
    // dim 3 never measured -> unchecked
  ],
  dispatches: [
    {
      id: 700,
      dispatch_no: 'STK-260304-A1B2',
      drawing_id: 10,
      drawing_no: 'DRG-1001',
      part_name: 'Flange Plate',
      po_no: 'PO-55',
      invoice_no: 'INV-77',
      qty: '250',
      dispatched_by: 2,
      dispatched_at: laterIso,
      notes: '2 cartons'
    }
  ],
  instruments: [{ id: 1, name: 'Vernier Calliper' }],
  deleted_drawings: [],
  deleted_checks: []
};

api.getSnapshot; // touch to keep import lint-friendly
localStorage.setItem('qc_server_snapshot', JSON.stringify(snapshot));
localStorage.setItem('qc_server_session', JSON.stringify({ token: 't', employee: { name: 'Ravi Kumar', role: 'qc' }, url: 'http://localhost:3000' }));

/* ------------------------------------ lists ------------------------------------ */

console.log('\nquality report - lists');

check('checks list is newest first and enriched with drawing + inspector', () => {
  const rows = api.listChecks();
  eq(rows.length, 2, 'check count');
  eq(rows[0].id, 501, 'newest check first');
  eq(rows[0].drawing_no, 'DRG-1001', 'drawing number joined');
  eq(rows[0].part_name, 'Flange Plate', 'part name joined');
  eq(rows[0].customer, 'Acme Ltd', 'customer joined');
  eq(rows[0].po_no, 'PO-55', 'PO joined');
  eq(rows[0].inspector_employee_name, 'Ravi Kumar', 'inspector joined');
});

check('drawings and dispatches lists load', () => {
  eq(api.listDrawings().length, 1, 'drawing count');
  const dispatches = api.listDispatches();
  eq(dispatches.length, 1, 'dispatch count');
  eq(dispatches[0].dispatcher_name, 'Anita Desai', 'dispatcher joined');
});

/* ----------------------------- individual report ----------------------------- */

console.log('\nquality report - individual (check) report');

check('buildCheckReport returns the check with latest measurement per dimension', () => {
  const report = api.buildCheckReport(500);
  assert(report, 'report must exist');
  eq(report.check.id, 500, 'check id');
  eq(report.check.drawing_no, 'DRG-1001', 'drawing no');
  eq(report.rows.length, 2, 'rows = dimensions that have measurements');
  eq(report.rows[0].dim_no, 1, 'rows ordered by dim_no');
  // Matches repo.ts getCheckReport: measurements are ranked across the whole
  // drawing (ROW_NUMBER PARTITION BY dimension_id ORDER BY checked_at DESC),
  // so the newest check wins even when an older check is being reported on.
  eq(report.rows[0].check_id, 501, 'newest measurement per dimension wins');
  eq(report.rows[1].check_id, 500, 'dimension measured only once keeps its own check');
  eq(report.dims.length, 3, 'all dimensions listed');
  eq(report.dims[2].checked, false, 'unmeasured dimension is unchecked');
});

check('individual report HTML matches the mobile layout', () => {
  const report = api.buildCheckReport(500);
  const html = buildReportHtml(report, '');
  assert(html.includes(COMPANY_NAME), 'company name present');
  assert(html.includes('INSPECTION REPORT'), 'report title present');
  assert(html.includes('DIMENSIONAL OBSERVATION'), 'observations table title present');
  assert(html.includes('DRG-1001'), 'drawing number present');
  assert(html.includes('Flange Plate'), 'part name present');
  assert(html.includes('Acme Ltd'), 'customer present');
  assert(html.includes('PO-55'), 'PO present');
  assert(html.includes('INV-77'), 'invoice present');
  assert(html.includes('Vernier Calliper'), 'instrument present');
  assert(html.includes('Ravi Kumar'), 'inspector present');
  assert(html.includes('Outer Dia'), 'dimension description present');
  assert(html.includes('120'), 'nominal value present');
  assert(html.includes('+0.2 / -0.1'), 'tolerance text rendered');
  // Out-of-tolerance samples are flagged with the "bad" class; the stored
  // checks.result and the NOT OK status text are not printed by this report.
  assert(html.includes('class="num bad"'), 'out-of-tolerance sample flagged');
  assert(html.includes('class="num ok"'), 'in-tolerance sample flagged');
  // Dimensions with no measurement are appended as pending rows.
  assert(html.includes('class="pend"'), 'unmeasured dimension rendered as pending');
  assert(html.includes('500'), 'report number (check id) present');
  assertExactFooter(html);
  assert(html.includes('<!DOCTYPE html>'), 'full document');
  assert(html.includes('@page'), 'print stylesheet present');
});

check('individual report reflects the latest check when re-run for the newer check', () => {
  const report = api.buildCheckReport(501);
  eq(report.check.result, 'FAIL', 'FAIL result on the record');
  eq(report.rows[0].check_id, 501, 'newer measurement wins for dim 1');
  const html = buildReportHtml(report, '');
  assert(html.includes('120.4'), 'failing sample value rendered');
  assert(html.includes('class="num bad"'), 'failing sample flagged bad');
});

check('sample import preserves empty values instead of converting them to zero', () => {
  eq(normalizeQualityNumber(null), null, 'null sample remains empty');
  eq(normalizeQualityNumber(undefined), null, 'missing sample remains empty');
  eq(normalizeQualityNumber(''), null, 'blank sample remains empty');
  eq(normalizeQualityNumber('8.25'), 8.25, 'numeric string becomes a number');
});

/* ------------------------------- overall report ------------------------------- */

console.log('\nquality report - overall (drawing) report');

check('buildDrawingReport picks the latest measurement per dimension', () => {
  const report = api.buildDrawingReport(10);
  assert(report, 'report must exist');
  eq(report.drawing.drawing_no, 'DRG-1001', 'drawing no');
  eq(report.checks.length, 2, 'all checks of the drawing');
  eq(report.checks[0].id, 500, 'checks ordered oldest first');
  eq(report.checks[1].id, 501, 'checks ordered oldest first');
  eq(report.rows.length, 2, 'one row per measured dimension');
  eq(report.rows[0].check_id, 501, 'latest check wins for dim 1');
  eq(report.dims.length, 3, 'all dimensions listed');
  eq(report.dims[2].checked, false, 'unmeasured dimension flagged unchecked');
});

check('overall report HTML matches the mobile layout', () => {
  const report = api.buildDrawingReport(10);
  const html = buildOverallReportHtml(report, '');
  assert(html.includes(COMPANY_NAME), 'company name present');
  assert(html.includes('DRG-1001'), 'drawing number present');
  assert(html.includes('Outer Dia'), 'dimension present');
  assert(html.includes('Acme Ltd'), 'customer present');
  assert(html.includes('<!DOCTYPE html>'), 'full document');
  assertExactFooter(html);
});

check('overall report shows numeric samples and keeps symbolic check statuses', () => {
  const report = api.buildDrawingReport(10);
  const html = buildOverallReportHtml(report, '');
  assert(html.includes('120.4'), 'numeric sample rendered for numeric text nominal');
  assert(html.includes('120.45'), 'additional numeric sample rendered');
  assert(html.includes('>OK</td>'), 'symbolic check status rendered');
  assert(!html.includes('NOT OK'), 'numeric sample uses its measured value rather than status text');
});

check('overall report includes the logo when one is supplied', async () => {
  const report = api.buildDrawingReport(10);
  const logo = await getLogoDataUri();
  assert(logo.startsWith('data:image/'), 'logo is an embedded data uri');
  const html = buildOverallReportHtml(report, logo);
  assert(html.includes('data:image/'), 'logo embedded in report html');
});

/* ------------------------------ dispatch report ------------------------------ */

check('dispatch QR text matches the mobile format', () => {
  const dispatch = api.buildDispatchReport(700);
  const text = buildDispatchQrText(dispatch);
  assert(text.includes('SERIAL: STK-260304-A1B2'), 'serial line');
  assert(text.includes('DWG NO: DRG-1001'), 'drawing line');
  assert(text.includes('PART: Flange Plate'), 'part line');
  assert(text.includes('PO NO: PO-55'), 'po line');
  assert(text.includes('QTY: 250'), 'qty line');
});

check('dispatch sticker HTML matches the mobile layout', () => {
  const dispatch = api.buildDispatchReport(700);
  const html = buildStickerHtml(dispatch, '');
  assert(html.includes(COMPANY_NAME), 'company name present');
  assert(html.includes('STK-260304-A1B2'), 'serial present');
  assert(html.includes('DRG-1001'), 'drawing present');
  assert(html.includes('PO-55'), 'PO present');
  assert(html.includes('size: 6cm 3cm'), 'sticker page size present');
  assertExactFooter(html);
});

check('dispatch QR renders as SVG', async () => {
  const dispatch = api.buildDispatchReport(700);
  const svg = await buildDispatchQrSvg(dispatch);
  assert(svg.includes('<svg'), 'svg produced');
});

/* ------------------------------- missing data ------------------------------- */

check('unknown ids return null instead of throwing', () => {
  eq(api.buildCheckReport(9999), null, 'unknown check');
  eq(api.buildDrawingReport(9999), null, 'unknown drawing');
  eq(api.buildDispatchReport(9999), null, 'unknown dispatch');
});

/* --------------------------------- summary --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
