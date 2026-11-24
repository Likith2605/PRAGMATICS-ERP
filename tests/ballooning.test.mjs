/**
 * Ballooning module test (no framework required).
 * Run:  node tests/ballooning.test.mjs
 *
 * Verifies that services/ballooningApi.js reproduces the contract of the
 * Express backend that shipped inside the ballooning zip (backend/server.js),
 * because the ballooning pages were copied verbatim and still talk to it
 * through the same five methods (get / post / put / delete / upload).
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

const api = (await import('../src/services/ballooningApi.js')).default;

/* --------------------------------- test runner --------------------------------- */
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

const section = (name) => console.log(`\n== ${name}`);

const expectThrowsAsync = async (fn, pattern, label) => {
  try {
    await fn();
  } catch (err) {
    const ok = pattern ? pattern.test(String(err.message)) : true;
    if (ok) {
      passed += 1;
      console.log(`  ok   ${label} -> "${err.message}"`);
    } else {
      failed += 1;
      failures.push(`${label}: "${err.message}" !~ ${pattern}`);
      console.log(`  FAIL ${label}: "${err.message}" !~ ${pattern}`);
    }
    return;
  }
  failed += 1;
  failures.push(`${label}: expected a rejection`);
  console.log(`  FAIL ${label}: expected a rejection`);
};

const drawingFile = (name = 'DWG-1001.pdf') =>
  new File([new Uint8Array([37, 80, 68, 70, 45])], name, { type: 'application/pdf' });

const uploadDrawing = (projectId, name) => {
  const fd = new FormData();
  fd.append('drawing', drawingFile(name));
  return api.upload(`/projects/${projectId}/drawing`, fd);
};

/* ---------------------------------- fixtures ---------------------------------- */

section('health and routing');
check((await api.get('/health')).status === 'ok', 'GET /health answers {status:ok}');
await expectThrowsAsync(() => api.get('/no/such/endpoint'), /Request failed/, 'unknown endpoint rejects like the Express 404');

section('projects');
const p1 = await api.post('/projects', {
  drawingNumber: 'DWG-1001',
  partName: 'Mounting Plate',
  customerName: 'ABC Engineering Pvt Ltd',
  revision: 'A',
  inspector: 'Inspector One',
  createdBy: 'Admin User'
});
check(typeof p1._id === 'string' && p1._id.length > 0, 'POST /projects returns an _id');
check(p1.status === 'Draft', 'new project defaults to status Draft');
check(p1.unit === 'mm', 'new project defaults to unit mm');
check(p1.createdBy === 'Admin User', 'createdBy is stored');

const p2 = await api.post('/projects', { drawingNumber: 'DWG-1002', partName: 'Cover', createdBy: 'Admin User' });
const list = await api.get('/projects');
check(list.length === 2, `GET /projects lists both projects (${list.length})`);
check(list[0]._id === p2._id && list[1]._id === p1._id, 'GET /projects is sorted newest first');

const fetched = await api.get(`/projects/${p1._id}`);
check(fetched.drawingNumber === 'DWG-1001', 'GET /projects/:id returns the project');

const updated = await api.put(`/projects/${p1._id}`, { status: 'Under Review', revision: 'B' });
check(updated.status === 'Under Review' && updated.revision === 'B', 'PUT /projects/:id merges the payload');
check(updated.drawingNumber === 'DWG-1001', 'PUT /projects/:id keeps untouched fields');
await expectThrowsAsync(() => api.get('/projects/does-not-exist'), /Project not found/, 'unknown project rejects with Project not found');

section('drawings');
const d1 = await uploadDrawing(p1._id);
check(typeof d1._id === 'string', 'upload creates a drawing record');
check(d1.fileName === 'DWG-1001.pdf', 'upload keeps the original file name');
check(d1.pageCount === 1, 'upload defaults pageCount to 1');
check(typeof d1.filePath === 'string' && d1.filePath.length > 0, 'upload returns a usable filePath');

const d2 = await uploadDrawing(p1._id, 'DWG-1001-revB.pdf');
const drawings = await api.get(`/projects/${p1._id}/drawings`);
check(drawings.length === 2, `GET /projects/:id/drawings lists both files (${drawings.length})`);
check(drawings[0]._id === d2._id, 'GET /projects/:id/drawings is newest first');
const single = await api.get(`/projects/${p1._id}/drawing`);
check(single._id === d2._id, 'GET /projects/:id/drawing falls back to the latest upload');

const renamed = await api.put(`/projects/${p1._id}/drawings/${d1._id}`, { fileName: 'renamed.pdf' });
check(renamed.fileName === 'renamed.pdf', 'PUT /projects/:id/drawings/:drawingId renames the file');
await expectThrowsAsync(() => api.put(`/projects/${p1._id}/drawings/nope`, { fileName: 'x' }), /Drawing not found/, 'renaming an unknown drawing rejects');

const deletedDrawing = await api.delete(`/projects/${p1._id}/drawings/${d2._id}`);
check(deletedDrawing.success === true, 'DELETE /projects/:id/drawings/:drawingId returns success');
const afterDelete = await api.get(`/projects/${p1._id}/drawings`);
check(afterDelete.length === 1, `the deleted drawing is gone (${afterDelete.length} left)`);
await expectThrowsAsync(() => api.delete(`/projects/${p1._id}/drawings/nope`), /Drawing not found/, 'deleting an unknown drawing rejects');

section('balloons');
const b1 = await api.post(`/projects/${p1._id}/balloons`, {
  drawingId: d1._id,
  page: 1,
  text: '100 ± 0.10',
  type: 'Dimension',
  x: 280,
  y: 160,
  anchorX: 300,
  anchorY: 180
});
check(b1.number === 1, 'first balloon is numbered 1');
check(b1.status === 'Draft', 'balloon defaults to status Draft');
const b2 = await api.post(`/projects/${p1._id}/balloons`, { drawingId: d1._id, number: 7, text: '50 ± 0.05', type: 'Dimension' });
check(b2.number === 7, 'an explicit balloon number is respected');
const b3 = await api.post(`/projects/${p1._id}/balloons`, { drawingId: d1._id, text: 'Ø20', type: 'Diameter' });
check(b3.number === 3, 'the next automatic number continues the sequence');

const balloons = await api.get(`/projects/${p1._id}/balloons`);
check(balloons.length === 3, `GET /projects/:id/balloons lists them (${balloons.length})`);
check(balloons.map((b) => b.number).join(',') === '1,3,7', `balloons are sorted by number (${balloons.map((b) => b.number).join(',')})`);
const filtered = await api.get(`/projects/${p1._id}/balloons?drawingId=${b1.drawingId}`);
check(filtered.length === 3, 'drawingId query filters the balloon list');
const filteredNone = await api.get(`/projects/${p1._id}/balloons?drawingId=other`);
check(filteredNone.length === 0, 'a foreign drawingId returns no balloons');

const renumbered = await api.put(`/balloons/${b1._id}`, { number: 12, text: '100' });
check(renumbered.number === 12 && renumbered.text === '100', 'PUT /balloons/:id updates the balloon');
await expectThrowsAsync(() => api.put('/balloons/nope', { number: 1 }), /Balloon not found/, 'updating an unknown balloon rejects');

section('characteristics');
const c1 = await api.post(`/projects/${p1._id}/characteristics`, {
  balloonId: b1._id,
  drawingId: d1._id,
  number: 1,
  type: 'Dimension',
  value: '100',
  unit: 'mm',
  plusTolerance: '0.10',
  minusTolerance: '-0.10',
  upperLimit: '100.10',
  lowerLimit: '99.90',
  specification: '100 ± 0.10',
  inspectionMethod: 'Vernier Caliper',
  instrument: 'Vernier',
  actualValue: '',
  result: 'NOT INSPECTED',
  page: 1,
  x: 280,
  y: 160
});
check(typeof c1._id === 'string', 'POST /projects/:id/characteristics creates the record');
check(c1.result === 'NOT INSPECTED', 'a new characteristic starts NOT INSPECTED');
const c2 = await api.post(`/projects/${p1._id}/characteristics`, { balloonId: b2._id, number: 2, value: '50', unit: 'mm' });
check(c2.number === 2, 'characteristic numbers round-trip');

const chars = await api.get(`/projects/${p1._id}/characteristics`);
check(chars.length === 2, `GET /projects/:id/characteristics lists them (${chars.length})`);
const inspected = await api.put(`/characteristics/${c1._id}`, { actualValue: '100.05', result: 'PASS' });
check(inspected.actualValue === '100.05' && inspected.result === 'PASS', 'PUT /characteristics/:id stores the measured value');
await expectThrowsAsync(() => api.put('/characteristics/nope', { result: 'PASS' }), /Characteristic not found/, 'updating an unknown characteristic rejects');
const removedChar = await api.delete(`/characteristics/${c2._id}`);
check(removedChar.success === true, 'DELETE /characteristics/:id returns success');
check((await api.get(`/projects/${p1._id}/characteristics`)).length === 1, 'the characteristic is gone');

section('balloon deletion cascades to its characteristics');
const cascadeBalloon = await api.post(`/projects/${p1._id}/balloons`, { drawingId: d1._id, text: 'R5', type: 'Radius' });
const cascadeChar = await api.post(`/projects/${p1._id}/characteristics`, { balloonId: cascadeBalloon._id, number: 3, value: '5', unit: 'mm' });
const cascadeResult = await api.delete(`/balloons/${cascadeBalloon._id}`);
check(cascadeResult.success === true, 'DELETE /balloons/:id returns success');
const remaining = await api.get(`/projects/${p1._id}/characteristics`);
check(!remaining.some((c) => c._id === cascadeChar._id), 'deleting a balloon deletes its characteristics');

section('approval');
const approval = await api.post(`/projects/${p1._id}/approval`, { status: 'Approved', comments: 'Looks good', approvedBy: 'Admin User' });
check(approval.status === 'Approved', 'POST /projects/:id/approval keeps the submitted status');
const approvedProject = await api.get(`/projects/${p1._id}`);
check(approvedProject.status === 'Approved', 'the approval updates the project status');
const pendingApproval = await api.post(`/projects/${p1._id}/approval`, { comments: 'for review' });
check(pendingApproval.status === 'Submitted for Review', 'an approval without status defaults to Submitted for Review');
check((await api.get(`/projects/${p1._id}`)).status === 'Under Review', 'that default moves the project to Under Review');

section('export');
const exported = await api.post(`/projects/${p1._id}/export`, { type: 'pdf' });
check(exported.success === true && exported.message === 'Export placeholder ready', 'POST /projects/:id/export answers like the zip backend');

section('duplicate project');
await api.post(`/projects/${p1._id}/balloons`, { drawingId: d1._id, text: '30', type: 'Dimension' });
const beforeProject = await api.get(`/projects/${p1._id}`);
const beforeDrawings = await api.get(`/projects/${p1._id}/drawings`);
const beforeBalloons = await api.get(`/projects/${p1._id}/balloons`);
const beforeChars = await api.get(`/projects/${p1._id}/characteristics`);
const copy = await api.post(`/projects/${p1._id}/duplicate`);
check(copy._id !== p1._id, 'the copy gets a new id');
check(copy.drawingNumber === beforeProject.drawingNumber, 'the copy keeps the project fields');
check(copy.status === 'Draft', 'the copy starts over as Draft');
const copyDrawings = await api.get(`/projects/${copy._id}/drawings`);
const copyBalloons = await api.get(`/projects/${copy._id}/balloons`);
const copyChars = await api.get(`/projects/${copy._id}/characteristics`);
check(copyDrawings.length === beforeDrawings.length, `drawings are copied (${copyDrawings.length})`);
check(copyBalloons.length === beforeBalloons.length, `balloons are copied (${copyBalloons.length})`);
check(copyChars.length === beforeChars.length, `characteristics are copied (${copyChars.length})`);
check(copyBalloons.every((b) => b._id !== undefined) && copyBalloons.every((b) => !beforeBalloons.some((o) => o._id === b._id)), 'copied balloons get fresh ids');
check(copyDrawings.every((d) => !beforeDrawings.some((o) => o._id === d._id)), 'copied drawings get fresh ids');
check((await api.get(`/projects/${p1._id}/balloons`)).length === beforeBalloons.length, 'the original balloons are untouched');
check(copyBalloons.every((b) => b.projectId === copy._id), 'copied balloons belong to the copy');
check(copyDrawings.every((d) => d.filePath === '' || typeof d.filePath === 'string'), 'copied drawings expose a filePath');

section('delete project cascades');
const delProject = await api.post('/projects', { drawingNumber: 'DWG-DEL', createdBy: 'Admin User' });
const delDrawing = await uploadDrawing(delProject._id, 'del.pdf');
const delBalloon = await api.post(`/projects/${delProject._id}/balloons`, { drawingId: delDrawing._id, text: '1', type: 'Dimension' });
await api.post(`/projects/${delProject._id}/characteristics`, { balloonId: delBalloon._id, number: 1, value: '1' });
const deleteResult = await api.delete(`/projects/${delProject._id}`);
check(deleteResult.success === true, 'DELETE /projects/:id returns success');
check(!(await api.get('/projects')).some((p) => p._id === delProject._id), 'the project is gone');
check((await api.get(`/projects/${delProject._id}/balloons`)).length === 0, 'its balloons are gone');
check((await api.get(`/projects/${delProject._id}/characteristics`)).length === 0, 'its characteristics are gone');
check((await api.get(`/projects/${delProject._id}/drawings`)).length === 0, 'its drawings are gone');

section('storage namespacing');
const keys = [];
for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
check(keys.length > 0 && keys.every((k) => k.startsWith('ballooning_')), 'ballooning data lives under its own localStorage prefix');
const erpKeys = ['inventoryItems', 'stockTransactions', 'quotationHistory', 'erp_auth', 'notifications'];
check(!keys.some((k) => erpKeys.includes(k)), 'no ERP localStorage key is touched by the ballooning module');

/* ---------------------------------- summary ---------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
