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
  const render = () => renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(WorkflowDashboardPage))
  );

  put('supplierPOHistory', []);
  assert.match(render(), /Purchase Dashboard/, 'purchase dashboard renders without PO data');

  put('supplierPOHistory', [null, {}, { reference: 'PO-INCOMPLETE-TEST', vendor: 'Test Supplier', payload: {} }]);
  const html = render();
  assert.match(html, /Purchase Dashboard/, 'purchase dashboard tolerates incomplete PO records');
  assert.match(html, /PO-INCOMPLETE-TEST/, 'purchase activity includes the incomplete PO without a render error');
  console.log('Workflow dashboard render checks passed (empty and incomplete PO data; Purchase Department role).');
} finally {
  await vite.close();
}
