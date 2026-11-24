import { normalizeDepartment } from './permissions.js';

export const ADMIN_DASHBOARD_LINK = Object.freeze({ label: 'Dashboard', path: '/', perm: null, end: true });
export const SALES_DASHBOARD_LINK = Object.freeze({ label: 'Sales Dashboard', path: '/sales-dashboard', perm: null, end: true });
export const PURCHASE_DASHBOARD_LINK = Object.freeze({
  label: 'Purchase Dashboard',
  path: '/workflow',
  perm: 'purchase.order',
  end: true
});
export const STORE_DASHBOARD_LINK = Object.freeze({ label: 'Workflow Dashboard', path: '/workflow', perm: 'store.module', end: true });
export const PRODUCTION_DASHBOARD_LINK = Object.freeze({ label: 'Production Home', path: '/production', perm: 'production.view', end: true });

export const homePathFor = (authData) => {
  const department = normalizeDepartment(authData?.department || '');
  const roleKey = String(authData?.roleKey || '').toLowerCase();
  const role = String(authData?.role || '').toLowerCase();

  if (department === 'Production Department') return '/production';
  if (department === 'Store Department') return '/workflow';
  if (department === 'Sales Department') return '/sales-dashboard';
  if (department === 'Purchase Department') return '/workflow';
  if (department === 'Admin' || (!department && ['admin', 'administrator'].includes(roleKey)) || (!department && role === 'administrator')) return '/';
  return '/access-denied';
};

export const dashboardNavigationItemFor = (department) => {
  const normalized = normalizeDepartment(department || '');
  if (normalized === 'Sales Department') return SALES_DASHBOARD_LINK;
  if (normalized === 'Purchase Department') return PURCHASE_DASHBOARD_LINK;
  if (normalized === 'Production Department' || normalized === 'Store Department') return null;
  return ADMIN_DASHBOARD_LINK;
};

export const filterNavigationItems = (items, hasAnyPermission) =>
  items.filter((item) => !item.perm || hasAnyPermission(item.perm));
