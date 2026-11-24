import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });

  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/login') {
    res.end(JSON.stringify({ token: 'test-token' }));
  } else if (req.url === '/api/upload') {
    res.end(JSON.stringify({ ok: true, url: '/uploads/ballooned.pdf' }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.QC_SERVER_URL = `http://127.0.0.1:${server.address().port}`;

try {
  const { uploadDrawingToQualityServer } = await import('../server/qcSyncClient.js');
  const input = {
    drawing_no: 'DRG-TEST',
    filename: 'Ballooned-DRG-TEST.pdf',
    data: Buffer.from('%PDF-test').toString('base64'),
  };
  const result = await uploadDrawingToQualityServer(input);

  assert.equal(result.ok, true);
  assert.equal(result.url, '/uploads/ballooned.pdf');
  assert.equal(requests.length, 2, 'authenticates, then uploads');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].url, '/api/upload');
  assert.equal(requests[1].authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(requests[1].body), input);
  console.log('Mobile QC PDF upload test passed.');

  const originalFetch = globalThis.fetch;
  const responses = [
    new Response(JSON.stringify({ imported: [], mobileSync: { ok: true, drawings: 1, dimensions: 5 } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response('<!DOCTYPE html><title>Error</title>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }),
  ];
  globalThis.fetch = async () => responses.shift();
  try {
    const { importFromBallooning } = await import('../src/services/qualityApi.js');
    const result = await importFromBallooning('test-project', {
      blob: new Blob(['%PDF-test'], { type: 'application/pdf' }),
      fileName: 'ballooned.pdf',
      drawingNo: 'DRG-TEST',
    });
    assert.equal(result.mobileSync.ok, false);
    assert.match(result.mobileSync.error, /Restart the ERP API server/);
    console.log('Stale ERP API response is reported with restart guidance.');
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
