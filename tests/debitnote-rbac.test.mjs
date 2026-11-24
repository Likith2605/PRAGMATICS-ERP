import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(String(key)) ?? null,
  setItem: (key, value) => memory.set(String(key), String(value)),
  removeItem: (key) => memory.delete(String(key)),
  clear: () => memory.clear()
};

const { getPermissionSet } = await import('../src/utils/permissions.js');
const rolePermission = (roleKey, department, permission) => {
  localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn: true, roleKey, department }));
  const permissions = getPermissionSet();
  return permissions.includes('*') || permissions.includes(permission);
};

for (const role of [
  ['production_manager', 'Production Department'],
  ['production_employee', 'Production Department']
]) {
  assert.equal(rolePermission(...role, 'debitnote.view'), false, `${role[0]} cannot view Debit Notes`);
  assert.equal(rolePermission(...role, 'production.qc.view'), true, `${role[0]} retains QC access`);
}

for (const role of [
  ['purchase_manager', 'Purchase Department'],
  ['purchase_employee', 'Purchase Department'],
  ['store_manager', 'Store Department'],
  ['store_employee', 'Store Department']
]) {
  assert.equal(rolePermission(...role, 'debitnote.view'), true, `${role[0]} retains Debit Note viewing`);
}
assert.equal(rolePermission('purchase_manager', 'Purchase Department', 'debitnote.create'), true,
  'Purchase retains Debit Note creation');
assert.equal(rolePermission('administrator', 'Admin', 'debitnote.view'), true,
  'Admin retains full access');

const sidebar = readFileSync(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
const productionGroup = sidebar.match(/label: 'Production & QC'[\s\S]*?\n  \] },/);
assert.ok(productionGroup, 'Production & QC navigation group exists');
assert.ok(!productionGroup[0].includes("label: 'Debit Notes'"), 'Production navigation omits Debit Notes');
assert.match(sidebar, /label: 'Purchase'[\s\S]*?label: 'Debit Notes'/, 'Purchase navigation retains Debit Notes');
assert.match(sidebar, /label: 'Store'[\s\S]*?label: 'Debit Notes'/, 'Store navigation retains Debit Notes');

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
assert.match(app, /const DebitNotesAccessDenied = \(\) =>/);
assert.match(app, /path="\/debit-notes"\s+element=\{hasAnyPermission\('debitnote\.view'\) \? <DebitNotesPage \/> : <DebitNotesAccessDenied \/>\}/,
  'direct Debit Notes URL renders an Access Denied page without view permission');

console.log('Debit Note RBAC checks passed for Production, Purchase, Store, Admin, sidebar, and direct route access.');
