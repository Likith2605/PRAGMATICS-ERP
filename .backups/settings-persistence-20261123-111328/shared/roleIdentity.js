const slug = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';

export const stableDepartmentId = (department, catalog = []) => {
  const entry = (Array.isArray(catalog) ? catalog : []).find((item) => String(item.name).toLowerCase() === String(department || '').toLowerCase());
  return entry?.id || `builtin-department-${slug(department)}`;
};

export const stableRoleId = (department, roleKey, roleCatalog = [], departmentCatalog = []) => {
  const departmentId = stableDepartmentId(department, departmentCatalog);
  const role = (Array.isArray(roleCatalog) ? roleCatalog : []).find((item) =>
    item.departmentId
      ? String(item.departmentId).toLowerCase() === String(departmentId).toLowerCase() && String(item.roleKey || '') === String(roleKey || '')
      : String(item.department || '').toLowerCase() === String(department || '').toLowerCase() && String(item.roleKey || '') === String(roleKey || '')
  );
  return role?.id || `builtin-role-${slug(department)}-${slug(roleKey)}`;
};

export const permissionAssignmentKey = (departmentId, roleId) => `${String(departmentId || '')}::${String(roleId || '')}`;
