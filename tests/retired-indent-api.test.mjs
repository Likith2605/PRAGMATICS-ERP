import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 3012;
const api = `http://localhost:${port}/api`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), QC_PULL_ENABLED: '0' },
  stdio: 'ignore', windowsHide: true
});
const getIndents = async() => {
  const response = await fetch(`${api}/state/purchaseIndents`);
  assert.equal(response.ok, true, 'purchase indent state endpoint responds');
  return (await response.json()).data || [];
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await getIndents(); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert.ok(ready, 'test backend started against the configured PostgreSQL database');

  const before = await getIndents();
  const historical = before.filter((indent) => indent.sourceType === 'storeDirect');
  assert.ok(historical.length > 0, 'historical records exist for preservation checks');
  const attempted = [...before, {
    indentNumber: `IND-API-RETIRED-${Date.now()}`, sourceType: 'storeDirect', status: 'Submitted', items: []
  }];
  for (const body of [
    { data: attempted },
    { records: { purchaseIndents: attempted } }
  ]) {
    const globalWrite = 'records' in body;
    const response = await fetch(globalWrite ? `${api}/state` : `${api}/state/purchaseIndents`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(globalWrite ? body : { data: attempted })
    });
    assert.equal(response.status, 400, 'a new retired-source indent write is rejected');
  }

  const after = await getIndents();
  assert.deepEqual(after.filter((indent) => indent.sourceType === 'storeDirect'), historical, 'historical records remain unchanged');
  assert.ok(!after.some((indent) => indent.indentNumber.startsWith('IND-API-RETIRED-')), 'rejected API writes create no record');
  console.log(`Retired indent API blocked new records and preserved ${historical.length} historical record(s).`);
} finally {
  child.kill();
}
