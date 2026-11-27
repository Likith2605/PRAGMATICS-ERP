import { authHeaders } from '../utils/auth.js';

const apiBase = () => typeof window !== 'undefined' && window.location
  ? (window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api')
  : String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase()}/organization-catalogs${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Department/role catalog request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
};

export const newCatalogToken = (prefix = 'catalog') => {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
};

const listRecords = async (path) => {
  const body = await request(path);
  if (!Array.isArray(body.records)) throw new Error('Department/role catalog response did not contain a record list.');
  return body.records;
};
export const listDepartments = async ({ includeDeleted = false } = {}) =>
  listRecords(`/departments${includeDeleted ? '?includeDeleted=1' : ''}`);
export const listRoles = async ({ includeDeleted = false } = {}) =>
  listRecords(`/roles${includeDeleted ? '?includeDeleted=1' : ''}`);
export const getDepartment = async (id) => (await request(`/departments/${encodeURIComponent(id)}`)).record;
export const getRole = async (id) => (await request(`/roles/${encodeURIComponent(id)}`)).record;
export const createDepartment = async (data, idempotencyToken = newCatalogToken('department')) =>
  request('/departments', { method: 'POST', body: JSON.stringify({ data, idempotencyToken }) });
export const createRole = async (data, idempotencyToken = newCatalogToken('role')) =>
  request('/roles', { method: 'POST', body: JSON.stringify({ data, idempotencyToken }) });
export const updateDepartment = async (id, data, version, reason = '', idempotencyToken = newCatalogToken('department-update')) =>
  request(`/departments/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify({ data, version, reason, idempotencyToken })
  });
export const updateRole = async (id, data, version, reason = '', idempotencyToken = newCatalogToken('role-update')) =>
  request(`/roles/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify({ data, version, reason, idempotencyToken })
  });
export const deleteDepartment = async (id, version, reason, idempotencyToken = newCatalogToken('department-delete')) =>
  request(`/departments/${encodeURIComponent(id)}`, {
    method: 'DELETE', body: JSON.stringify({ version, reason, idempotencyToken })
  });
export const deleteRole = async (id, version, reason, idempotencyToken = newCatalogToken('role-delete')) =>
  request(`/roles/${encodeURIComponent(id)}`, {
    method: 'DELETE', body: JSON.stringify({ version, reason, idempotencyToken })
  });
export const restoreDepartment = async (id, version, reason, idempotencyToken = newCatalogToken('department-restore')) =>
  request(`/departments/${encodeURIComponent(id)}/restore`, {
    method: 'POST', body: JSON.stringify({ version, reason, idempotencyToken })
  });
export const restoreRole = async (id, version, reason, idempotencyToken = newCatalogToken('role-restore')) =>
  request(`/roles/${encodeURIComponent(id)}/restore`, {
    method: 'POST', body: JSON.stringify({ version, reason, idempotencyToken })
  });
export const getRolePermissions = async (departmentId, roleId) =>
  request(`/role-permissions/${encodeURIComponent(departmentId)}/${encodeURIComponent(roleId)}`);
export const saveRolePermissions = async ({ departmentId, roleId, permissions, version }, idempotencyToken = newCatalogToken('role-permissions')) => {
  const saved = await request(`/role-permissions/${encodeURIComponent(departmentId)}/${encodeURIComponent(roleId)}`, {
    method: 'PUT', body: JSON.stringify({ permissions, version, idempotencyToken })
  });
  try {
    const auth = JSON.parse(localStorage.getItem('erp_auth') || 'null');
    if (auth && Array.isArray(auth.assignments)) {
      auth.assignments = auth.assignments.map((assignment) =>
        String(assignment.departmentId || '') === String(departmentId) &&
        String(assignment.roleId || '') === String(roleId)
          ? { ...assignment, permissions: saved.permissions }
          : assignment
      );
      localStorage.setItem('erp_auth', JSON.stringify(auth));
      window.dispatchEvent(new CustomEvent('erp-auth-permissions-updated'));
    }
  } catch {
    // The PostgreSQL permission update is authoritative; session refresh reloads it if cache parsing fails.
  }
  return saved;
};
export const getLegacyDepartmentRolePreview = async () => (await request('/legacy/preview')).entries || [];
export const importSelectedDepartmentRoleCatalog = async (selected, idempotencyToken = newCatalogToken('catalog-import')) =>
  request('/legacy/import', { method: 'POST', body: JSON.stringify({ selected, idempotencyToken }) });
export const getDepartmentRoleCatalogHistory = async (module = '') => {
  const query = module ? `?module=${encodeURIComponent(module)}` : '';
  return (await request(`/history${query}`)).entries || [];
};
