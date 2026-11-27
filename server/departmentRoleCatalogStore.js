import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { DEPARTMENT_ROLE_OPTIONS, normalizeDepartment, normalizeEmployeeAssignments } from './departmentAccess.js';
import { permissionAssignmentKey, stableDepartmentId, stableRoleId } from '../shared/roleIdentity.js';

const LEGACY_KEYS = ['departmentCatalog', 'roleCatalog', 'rolePermissions'];
const invalidId = (value) => !value || ['undefined', 'null'].includes(String(value).trim().toLowerCase());
const rowDate = (value) => value?.toISOString?.() || value || null;

const legacyRecordId = (kind, record) => {
  const provided = String(record?.id ?? '').trim();
  if (!invalidId(provided)) return provided;
  const identity = kind === 'role'
    ? `${record?.department || ''}\u0000${record?.roleKey || ''}\u0000${record?.name || ''}`
    : String(record?.name || '');
  const prefix = kind === 'role' ? 'role' : 'department';
  return `${prefix}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
};

const departmentFromRow = (row) => ({
  id: row.id,
  name: row.name,
  active: row.active,
  version: Number(row.version),
  createdAt: rowDate(row.created_at),
  updatedAt: rowDate(row.updated_at),
  deletedAt: rowDate(row.deleted_at),
  deletedBy: row.deleted_by || null,
  deleteReason: row.delete_reason || '',
  legacy: false
});

const roleFromRow = (row) => ({
  id: row.id,
  departmentId: row.department_id,
  department: row.department,
  name: row.name,
  roleKey: row.role_key,
  active: row.active,
  version: Number(row.version),
  createdAt: rowDate(row.created_at),
  updatedAt: rowDate(row.updated_at),
  deletedAt: rowDate(row.deleted_at),
  deletedBy: row.deleted_by || null,
  deleteReason: row.delete_reason || '',
  legacy: false
});

const permissionFromRow = (row) => ({
  departmentId: row.department_id,
  roleId: row.role_id,
  department: row.department,
  roleKey: row.role_key,
  permissions: Array.isArray(row.permissions) ? row.permissions : [],
  version: Number(row.version),
  updatedAt: rowDate(row.updated_at),
  legacy: false
});

export const readLegacyDepartmentRoleSnapshots = async (executor = getPool()) => {
  const result = await executor.query(
    'SELECT storage_key,data FROM erp_state WHERE storage_key=ANY($1::text[])',
    [LEGACY_KEYS]
  );
  return Object.fromEntries(result.rows.map((row) => [row.storage_key, row.data]));
};

export const readDepartmentRoleCatalogs = async (executor = getPool()) => {
  const departmentsResult = await executor.query('SELECT * FROM department_catalog ORDER BY lower(name),id');
  const rolesResult = await executor.query('SELECT * FROM role_catalog ORDER BY lower(department),lower(name),id');
  const permissionsResult = await executor.query('SELECT * FROM role_permission_catalog ORDER BY department_id,role_id');
  const legacy = await readLegacyDepartmentRoleSnapshots(executor);
  const departments = departmentsResult.rows.map(departmentFromRow);
  const roles = rolesResult.rows.map(roleFromRow);
  const permissions = permissionsResult.rows.map(permissionFromRow);
  const departmentIds = new Set(departments.map((item) => item.id));
  const departmentNames = new Set(departments.map((item) => normalizeDepartment(item.name).toLowerCase()));
  const roleIds = new Set(roles.map((item) => item.id));
  const roleIdentities = new Set(roles.map((item) => `${item.departmentId}::${item.roleKey.toLowerCase()}`));
  const permissionIdentities = new Set(permissions.map((item) => permissionAssignmentKey(item.departmentId, item.roleId)));

  for (const item of Array.isArray(legacy.departmentCatalog) ? legacy.departmentCatalog : []) {
    if (!item || typeof item !== 'object') continue;
    const id = legacyRecordId('department', item);
    const name = String(item.name || '').trim();
    if (!name || departmentIds.has(id) || departmentNames.has(normalizeDepartment(name).toLowerCase())) continue;
    departments.push({ ...item, id, name, active: item.active !== false, version: 0, deletedAt: null, legacy: true });
    departmentIds.add(id);
    departmentNames.add(normalizeDepartment(name).toLowerCase());
  }

  for (const item of Array.isArray(legacy.roleCatalog) ? legacy.roleCatalog : []) {
    if (!item || typeof item !== 'object') continue;
    const id = legacyRecordId('role', item);
    const department = normalizeDepartment(item.department);
    const departmentId = item.departmentId || stableDepartmentId(department, departments);
    const roleKey = String(item.roleKey || '').trim();
    const identity = `${departmentId}::${roleKey.toLowerCase()}`;
    if (!department || !item.name || !roleKey || roleIds.has(id) || roleIdentities.has(identity)) continue;
    roles.push({ ...item, id, departmentId, department, roleKey, active: item.active !== false, version: 0, deletedAt: null, legacy: true });
    roleIds.add(id);
    roleIdentities.add(identity);
  }

  for (const item of Array.isArray(legacy.rolePermissions) ? legacy.rolePermissions : []) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.permissions)) continue;
    const departmentId = String(item.departmentId || '');
    const roleId = String(item.roleId || '');
    const identity = permissionAssignmentKey(departmentId, roleId);
    if (!departmentId || !roleId || permissionIdentities.has(identity)) continue;
    permissions.push({
      ...item,
      departmentId,
      roleId,
      permissions: item.permissions,
      version: 0,
      legacy: true
    });
    permissionIdentities.add(identity);
  }
  return { departments, roles, permissions };
};

export const validateEmployeeCatalogAssignments = async (employee, executor = getPool(), existingEmployee = null) => {
  const assignmentError = employee?.departmentAssignments !== undefined && !Array.isArray(employee.departmentAssignments)
    ? 'Department assignments must be a list.'
    : '';
  if (assignmentError) return assignmentError;
  const catalogs = await readDepartmentRoleCatalogs(executor);
  const assignments = normalizeEmployeeAssignments(employee);
  const existingAssignments = normalizeEmployeeAssignments(existingEmployee || {});
  for (const assignment of assignments) {
    const department = normalizeDepartment(assignment.department);
    const builtInDepartment = Object.hasOwn(DEPARTMENT_ROLE_OPTIONS, department);
    const departmentRecord = catalogs.departments.find((item) =>
      normalizeDepartment(item.name) === department && !item.deletedAt
    );
    if (!builtInDepartment && !departmentRecord) return `Department '${department}' no longer exists or is inactive.`;

    const departmentId = stableDepartmentId(department, catalogs.departments);
    const source = (employee.departmentAssignments || []).find((entry) => normalizeDepartment(entry.department) === department);
    if (source?.departmentId && String(source.departmentId) !== departmentId) return 'Department assignment does not match the saved department ID.';

    const builtInRole = (DEPARTMENT_ROLE_OPTIONS[department] || []).some((role) => role.roleKey === assignment.roleKey);
    const customRole = catalogs.roles.find((item) =>
      item.departmentId === departmentId &&
      String(item.roleKey).toLowerCase() === String(assignment.roleKey).toLowerCase() &&
      !item.deletedAt
    );
    const roleId = stableRoleId(department, assignment.roleKey, catalogs.roles, catalogs.departments);
    if (source?.roleId && String(source.roleId) !== roleId) return `Role assignment does not match the saved role ID for '${department}'.`;
    const retainedAssignment = existingAssignments.some((existing) =>
      existing.department === department &&
      String(existing.roleKey).toLowerCase() === String(assignment.roleKey).toLowerCase() &&
      stableDepartmentId(existing.department, catalogs.departments) === departmentId &&
      stableRoleId(existing.department, existing.roleKey, catalogs.roles, catalogs.departments) === roleId
    );
    if (!builtInDepartment && departmentRecord?.legacy && !retainedAssignment) {
      return `Department '${department}' must be imported before it can be newly assigned.`;
    }
    if (!builtInDepartment && (departmentRecord?.active === false) && !retainedAssignment) {
      return `Department '${department}' is inactive and cannot be newly assigned.`;
    }
    if (!builtInRole && !customRole) return `Role '${assignment.role}' no longer exists or is inactive in '${department}'.`;
    if (!builtInRole && customRole.legacy && !retainedAssignment) {
      return `Role '${assignment.role}' must be imported before it can be newly assigned.`;
    }
    if (!builtInRole && customRole.active === false && !retainedAssignment) {
      return `Role '${assignment.role}' is inactive and cannot be newly assigned in '${department}'.`;
    }
  }
  return null;
};

export const resolveRolePermission = (catalogs, departmentId, roleId) =>
  catalogs.permissions.find((entry) => permissionAssignmentKey(entry.departmentId, entry.roleId) === permissionAssignmentKey(departmentId, roleId)) || null;

export const departmentRoleLegacyId = legacyRecordId;
