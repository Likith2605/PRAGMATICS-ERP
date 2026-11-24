import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(String(key)) ?? null,
  setItem: (key, value) => memory.set(String(key), String(value)),
  removeItem: (key) => memory.delete(String(key)),
  clear: () => memory.clear()
};

const {
  ADMIN_DASHBOARD_LINK,
  SALES_DASHBOARD_LINK,
  PURCHASE_DASHBOARD_LINK,
  STORE_DASHBOARD_LINK,
  PRODUCTION_DASHBOARD_LINK,
  dashboardNavigationItemFor,
  filterNavigationItems,
  homePathFor
} = await import('../src/utils/roleNavigation.js');
const { getPermissionSet } = await import('../src/utils/permissions.js');
const sidebarSource = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

assert.doesNotMatch(sidebarSource, /Store Home/, 'Store Home is absent from sidebar labels and icon mapping');
for (const storeEntry of ['Inventory', 'Items to Review', 'Purchase Indents', 'Material Receipts', 'Vendor Supplier Record', 'Debit Notes', 'Store Issues', 'HT Outsource', 'Material Returns', 'Inventory Transactions', 'Shelf Life / Expiry', 'Workflow Dashboard']) {
  assert.ok(sidebarSource.includes(`label: '${storeEntry}'`), `Store submenu retains ${storeEntry}`);
}
assert.match(appSource, /<Route path="\/store" element=\{<Navigate to="\/inventory" replace \/>\} \/>/, 'legacy Store Home URL redirects to Inventory');
assert.doesNotMatch(appSource, /import StorePage from '\.\/pages\/StorePage\.jsx'/, 'Store Home page is not routed directly');

const destinations = [
  [{ department: 'Admin', roleKey: 'admin' }, '/'],
  [{ department: 'Sales Department', roleKey: 'sales_employee' }, '/sales-dashboard'],
  [{ department: 'Purchase Department', roleKey: 'purchase_employee' }, '/workflow'],
  [{ department: 'Store Department', roleKey: 'store_employee' }, '/workflow'],
  [{ department: 'Production Department', roleKey: 'production_employee' }, '/production'],
  [{ department: 'Unassigned', roleKey: 'employee' }, '/access-denied']
];
for (const [auth, expected] of destinations) {
  assert.equal(homePathFor(auth), expected, `${auth.department} home destination`);
}

assert.deepEqual(dashboardNavigationItemFor('Purchase Department'), PURCHASE_DASHBOARD_LINK);
assert.equal(PURCHASE_DASHBOARD_LINK.label, 'Purchase Dashboard');
assert.equal(PURCHASE_DASHBOARD_LINK.path, '/workflow');
assert.equal(PURCHASE_DASHBOARD_LINK.perm, 'purchase.order');
assert.deepEqual(dashboardNavigationItemFor('Sales Department'), SALES_DASHBOARD_LINK);
assert.deepEqual(dashboardNavigationItemFor('Admin'), ADMIN_DASHBOARD_LINK);

const dashboardLinks = [
  ['admin', ADMIN_DASHBOARD_LINK],
  ['sales_employee', SALES_DASHBOARD_LINK],
  ['purchase_employee', PURCHASE_DASHBOARD_LINK],
  ['store_employee', STORE_DASHBOARD_LINK],
  ['production_employee', PRODUCTION_DASHBOARD_LINK]
];
for (const [roleKey, link] of dashboardLinks) {
  localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn: true, roleKey, department: {
    admin: 'Admin', sales_employee: 'Sales Department', purchase_employee: 'Purchase Department',
    store_employee: 'Store Department', production_employee: 'Production Department'
  }[roleKey] }));
  const permissions = getPermissionSet();
  const visible = filterNavigationItems([link], (permission) => permissions.includes('*') || permissions.includes(permission));
  assert.equal(visible.length, 1, `${roleKey} sees its dashboard navigation link`);
}

localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn: true, roleKey: 'sales_employee', department: 'Sales Department' }));
assert.equal(filterNavigationItems([PURCHASE_DASHBOARD_LINK], (permission) => getPermissionSet().includes(permission)).length, 0,
  'Sales cannot see the Purchase Dashboard link');

for (const roleKey of ['sales_manager', 'sales_employee']) {
  localStorage.setItem('erp_auth', JSON.stringify({ isLoggedIn: true, roleKey, department: 'Sales Department' }));
  assert.equal(getPermissionSet().includes('backup.view'), false, `${roleKey} cannot access backup and export`);
  assert.equal(getPermissionSet().includes('tally.export'), true, `${roleKey} can export to Tally`);
}

console.log('Dashboard routing and role-specific sidebar checks passed.');
