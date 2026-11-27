import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
  setItem: (key, value) => values.set(String(key), String(value)),
  removeItem: (key) => values.delete(String(key)),
  clear: () => values.clear(),
  key: (index) => [...values.keys()][index] ?? null,
  get length() { return values.size; }
};

const put = (key, value) => localStorage.setItem(key, JSON.stringify(value));
put('erp_auth', {
  isLoggedIn: true,
  role: 'Purchase Manager',
  roleKey: 'purchase_manager',
  department: 'Purchase Department',
  username: 'Purchase Dashboard Test'
});

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: WorkflowDashboardPage } = await vite.ssrLoadModule('/src/pages/WorkflowDashboardPage.jsx');
  const { default: DashboardPage } = await vite.ssrLoadModule('/src/pages/DashboardPage.jsx');
  const render = () => renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(WorkflowDashboardPage))
  );

  put('supplierPOHistory', [null, {}, { reference: 'PO-STALE-LOCAL-TEST', vendor: 'Stale Supplier', payload: {} }]);
  const html = render();
  assert.match(html, /Purchase Dashboard/, 'purchase dashboard renders');
  assert.match(html, /Loading dashboard data from PostgreSQL/, 'dashboard waits for authoritative API data');
  assert.doesNotMatch(html, /PO-STALE-LOCAL-TEST/, 'dashboard does not render stale browser PO records');

  put('supplierInvoiceHistory', [{ reference: 'SI-STALE-LOCAL-TEST' }]);
  const executiveHtml = renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(DashboardPage))
  );
  assert.match(executiveHtml, /Executive Dashboard/, 'executive dashboard renders');
  assert.match(executiveHtml, /Loading dashboard data from PostgreSQL/, 'executive dashboard waits for all authoritative sources');
  assert.doesNotMatch(executiveHtml, /SI-STALE-LOCAL-TEST/, 'executive dashboard ignores stale browser invoice records');
  assert.doesNotMatch(executiveHtml, /Inventory valuation/, 'dashboard does not present partial totals while data is loading');
  console.log('Workflow and executive dashboard render checks passed (PostgreSQL loading; stale local data ignored).');
} finally {
  await vite.close();
}
