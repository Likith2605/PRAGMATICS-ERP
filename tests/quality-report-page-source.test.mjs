import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

localStorage.setItem('qc_server_snapshot', JSON.stringify({
  drawings: [{ id: 'stale-local-drawing', drawing_no: 'STALE-LOCAL-QUALITY-REPORT' }]
}));
localStorage.setItem('erp_auth', JSON.stringify({
  isLoggedIn: true,
  role: 'Quality Inspector',
  roleKey: 'quality_inspector',
  department: 'Quality Department',
  username: 'Quality Report Test'
}));

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: QualityReportPage } = await vite.ssrLoadModule('/src/pages/QualityReportPage.jsx');
  const html = renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(QualityReportPage))
  );
  assert.match(html, /Loading quality reports from PostgreSQL/);
  assert.doesNotMatch(html, /STALE-LOCAL-QUALITY-REPORT/);
  const appSource = readFileSync('src/App.jsx', 'utf8');
  assert.match(appSource, /path="\/quality-report"\s+element=\{<Guard perm=\{\['production\.qc\.view', 'production\.qc\.manage', 'reports\.view'\]\}><QualityReportPage \/><\/Guard>\}/,
    'Quality Report retains QC/report permission gating');
  console.log('Quality report source check passed (PostgreSQL loading state; cached snapshot ignored).');
} finally {
  await vite.close();
}
