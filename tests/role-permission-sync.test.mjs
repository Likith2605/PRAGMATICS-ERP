import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ALLOWED_PERMISSION_KEYS, hasPermissionForRole, permissionsForRole } from '../server/departmentAccess.js';
import { permissionAssignmentKey, stableDepartmentId, stableRoleId } from '../shared/roleIdentity.js';

const departments = [{ id: 'dept-sales-v2', name: 'Sales Department' }, { id: 'dept-store-v2', name: 'Store Department' }];
const roles = [
  { id: 'role-sales-custom', departmentId: 'dept-sales-v2', department: 'Sales Department', roleKey: 'custom_operator', name: 'Sales Operator' },
  { id: 'role-store-custom', departmentId: 'dept-store-v2', department: 'Store Department', roleKey: 'custom_operator', name: 'Store Operator' }
];
const salesDeptId = stableDepartmentId('Sales Department', departments);
const storeDeptId = stableDepartmentId('Store Department', departments);
const salesRoleId = stableRoleId('Sales Department', 'custom_operator', roles, departments);
const storeRoleId = stableRoleId('Store Department', 'custom_operator', roles, departments);

assert.equal(salesDeptId, 'dept-sales-v2');
assert.equal(salesRoleId, 'role-sales-custom');
assert.notEqual(permissionAssignmentKey(salesDeptId, salesRoleId), permissionAssignmentKey(storeDeptId, storeRoleId), 'role permissions stay scoped to department IDs and role IDs');
assert.deepEqual(permissionsForRole('custom_operator'), [], 'unconfigured custom roles grant no permissions');
assert.equal(hasPermissionForRole('custom_operator', 'sales.quotation', ['sales.quotation']), true, 'saved custom permissions are enforced by the server helper');
assert.equal(hasPermissionForRole('custom_operator', 'inventory.adjust', ['sales.quotation']), false, 'custom permission overrides do not leak across modules');
assert.ok(ALLOWED_PERMISSION_KEYS.includes('sales.quotation'));
assert.ok(ALLOWED_PERMISSION_KEYS.includes('inventory.adjust'));
assert.equal(hasPermissionForRole('sales_employee', 'sales.quotation'), true, 'built-in permission defaults remain available');

const routes = await readFile(new URL('../server/departmentRoleCatalogRoutes.js', import.meta.url), 'utf8');
const auth = await readFile(new URL('../server/auth.js', import.meta.url), 'utf8');
const employeeMaster = await readFile(new URL('../src/pages/EmployeeMasterPage.jsx', import.meta.url), 'utf8');
const permissions = await readFile(new URL('../src/utils/permissions.js', import.meta.url), 'utf8');
const stateRoutes = await readFile(new URL('../server/erpStateRoutes.js', import.meta.url), 'utf8');
const masterRoutes = await readFile(new URL('../server/masterRoutes.js', import.meta.url), 'utf8');
assert.match(routes, /router\.put\('\/role-permissions\/:departmentId\/:roleId', route/);
assert.match(routes, /ALLOWED_PERMISSION_KEYS\.includes\(permission\)/, 'permission endpoint validates supported permission keys');
assert.match(routes, /module: 'rolePermissions'/, 'role permission updates are audited');
assert.match(auth, /readDepartmentRoleCatalogs\(\)/, 'authentication reloads the PostgreSQL-backed catalogs and permissions');
assert.match(auth, /rolePermissions: assignment\.permissions/, 'selected department assignment carries its saved permissions');
assert.match(masterRoutes, /readDepartmentRoleCatalogs\(\)/, 'master reference dropdowns use the authoritative catalog store');
assert.doesNotMatch(masterRoutes, /SELECT data FROM erp_state WHERE storage_key='departmentCatalog'/, 'master references do not read stale generic department catalogs');
assert.match(stateRoutes, /Scoped role permissions use the versioned \/api\/organization-catalogs API/, 'legacy scoped permission writes cannot bypass version checks');
assert.doesNotMatch(permissions, /localStorage\.getItem\('rolePermissions'\)/, 'client authorization does not fall back to stale localStorage permissions');
assert.match(employeeMaster, /saveRolePermissions\(/, 'Employee Master provides an Admin permission save flow');

const storage = new Map([
  ['erp_auth', JSON.stringify({
    isLoggedIn: true,
    roleKey: 'custom_operator',
    role: 'Sales Operator',
    activeDepartment: 'Sales Department',
    assignments: [{ department: 'Sales Department', role: 'Sales Operator', roleKey: 'custom_operator' }]
  })],
  ['rolePermissions', JSON.stringify([{ departmentId: 'stale-dept', roleId: 'stale-role', permissions: ['inventory.adjust'] }])]
]);
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key)
};
const { hasPermission: hasClientPermission } = await import('../src/utils/permissions.js');
assert.equal(hasClientPermission('inventory.adjust'), false, 'stale localStorage permission records are ignored');

console.log('Department-scoped role permission synchronization checks passed.');
