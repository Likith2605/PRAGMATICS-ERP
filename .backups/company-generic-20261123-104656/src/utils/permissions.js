import { getCurrentUser, isAdmin } from './auth.js';
import { stableDepartmentId, stableRoleId, permissionAssignmentKey } from '../../shared/roleIdentity.js';

export { isAdmin };

export const DEPARTMENTS = [
  'Admin',
  'Sales Department',
  'Purchase Department',
  'Production Department',
  'Store Department'
];

// Canonical role keys (machine) keyed per department.
export const ROLES_BY_DEPARTMENT = {
  'Admin': ['Administrator'],
  'Sales Department': ['Sales Manager', 'Sales Executive', 'Sales Employee'],
  'Purchase Department': ['Purchase Manager', 'Purchase Employee'],
  'Production Department': ['Production Manager', 'Production Employee'],
  'Store Department': ['Store In-charge', 'Store Manager', 'Store Employee']
};

export const ROLE_KEYS = {
  ADMINISTRATOR: 'administrator',
  SALES_MANAGER: 'sales_manager',
  SALES_EMPLOYEE: 'sales_employee',
  SALES_EXECUTIVE: 'sales_executive',
  PURCHASE_MANAGER: 'purchase_manager',
  PURCHASE_EMPLOYEE: 'purchase_employee',
  PRODUCTION_MANAGER: 'production_manager',
  PRODUCTION_EMPLOYEE: 'production_employee',
  STORE_MANAGER: 'store_manager',
  STORE_INCHARGE: 'store_incharge',
  STORE_EMPLOYEE: 'store_employee'
};

const ROLE_KEY_BY_LABEL = {
  'Administrator': 'administrator',
  'Sales Manager': 'sales_manager',
  'Sales Employee': 'sales_employee',
  'Sales Executive': 'sales_executive',
  'Purchase Manager': 'purchase_manager',
  'Purchase Employee': 'purchase_employee',
  'Production Manager': 'production_manager',
  'Production Employee': 'production_employee',
  'Store Manager': 'store_manager',
  'Store In-charge': 'store_incharge',
  'Store Employee': 'store_employee'
};

const ROLE_LABEL_BY_KEY = {
  administrator: 'Administrator',
  sales_manager: 'Sales Manager',
  sales_employee: 'Sales Employee',
  sales_executive: 'Sales Executive',
  purchase_manager: 'Purchase Manager',
  purchase_employee: 'Purchase Employee',
  production_manager: 'Production Manager',
  production_employee: 'Production Employee',
  store_manager: 'Store Manager',
  store_incharge: 'Store In-charge',
  store_employee: 'Store Employee'
};

// Legacy department names → canonical 5-department names.
const DEPT_ALIASES = {
  'Admin': 'Admin',
  'Sales Department': 'Sales Department',
  'Sales': 'Sales Department',
  'Purchase Department': 'Purchase Department',
  'Purchase': 'Purchase Department',
  'Production Department': 'Production Department',
  'Production': 'Production Department',
  'Store Department': 'Store Department',
  'Store': 'Store Department',
  'Stores': 'Store Department',
  'QC': 'Production Department',
  'Accounts': 'Sales Department',
  'Dispatch': 'Sales Department'
};

export const normalizeDepartment = (dept) => DEPT_ALIASES[dept] || dept || '';

const ROLE_KEY_ALIASES = {
  administrator: 'administrator',
  admin: 'administrator',
  sales_manager: 'sales_manager',
  sales_employee: 'sales_employee',
  sales_executive: 'sales_executive',
  sales: 'sales_employee',
  accounts: 'sales_employee',
  dispatch: 'sales_employee',
  purchase_manager: 'purchase_manager',
  purchase_employee: 'purchase_employee',
  purchase: 'purchase_employee',
  production_manager: 'production_manager',
  production_employee: 'production_employee',
  production: 'production_employee',
  qc: 'production_employee',
  operator: 'production_employee',
  store_manager: 'store_manager',
  store_incharge: 'store_incharge',
  store_employee: 'store_employee',
  stores: 'store_employee',
  store: 'store_employee'
};

const DEFAULT_EMPLOYEE_ROLE_BY_DEPT = {
  'Admin': 'administrator',
  'Sales Department': 'sales_employee',
  'Purchase Department': 'purchase_employee',
  'Production Department': 'production_employee',
  'Store Department': 'store_employee'
};

export const roleKeyForRole = (department, roleLabel) => {
  const dept = normalizeDepartment(department);
  if (!roleLabel) return DEFAULT_EMPLOYEE_ROLE_BY_DEPT[dept] || 'production_employee';
  const key = ROLE_KEY_BY_LABEL[roleLabel];
  if (key) return key;
  return DEFAULT_EMPLOYEE_ROLE_BY_DEPT[dept] || 'production_employee';
};

export const roleLabelForRoleKey = (roleKey, department) => {
  const dept = normalizeDepartment(department);
  const key = ROLE_KEY_ALIASES[roleKey] || DEFAULT_EMPLOYEE_ROLE_BY_DEPT[dept] || 'production_employee';
  return ROLE_LABEL_BY_KEY[key] || ROLE_LABEL_BY_KEY[DEFAULT_EMPLOYEE_ROLE_BY_DEPT[dept]] || 'Production Employee';
};

export const normalizeRoleKey = (roleKey) => ROLE_KEY_ALIASES[roleKey] || roleKey || '';

export const getCurrentUserInfo = () => {
  const auth = getCurrentUser();
  if (isAdmin()) {
    const employee = { employeeId: auth.employeeId || '-', name: auth.username || 'Administrator', department: 'Admin', designation: '', roleKey: 'administrator', role: 'Administrator' };
    return { auth, roleKey: 'administrator', employee };
  }
  const assignments = Array.isArray(auth.assignments) ? auth.assignments : [];
  if (assignments.length) {
    const selectedDepartment = normalizeDepartment(auth.activeDepartment || auth.department || '');
    const selected = assignments.find((item) => normalizeDepartment(item.department) === selectedDepartment) || assignments[0];
    const department = normalizeDepartment(selected.department);
    const roleKey = normalizeRoleKey(selected.roleKey || roleKeyForRole(department, selected.role));
    const employee = {
      employeeId: auth.employeeId || '-',
      name: auth.username || auth.name || auth.email || 'User',
      department,
      designation: auth.designation || '',
      roleKey,
      role: selected.role || ROLE_LABEL_BY_KEY[roleKey] || ''
    };
    return { auth, roleKey, employee };
  }
  const email = (auth.email || '').toLowerCase();
  let employee = null;

  try {
    const list = JSON.parse(localStorage.getItem('employees') || '[]');
    if (Array.isArray(list)) {
      employee =
        list.find(
          (e) => e.active !== false && e.email && e.email.toLowerCase() === email
        ) || null;
    }
  } catch {
    employee = null;
  }

  if (!employee) {
    employee = {
      employeeId: auth.employeeId || '-',
      name: auth.username || auth.email || 'User',
      department: isAdmin() ? 'Admin' : normalizeDepartment(auth.department || ''),
      designation: '',
      roleKey: isAdmin() ? 'administrator' : normalizeRoleKey(auth.roleKey || ''),
      role: ''
    };
    if (!employee.department) employee.department = isAdmin() ? 'Admin' : 'Production Department';
  }

  const dept = normalizeDepartment(employee.department);
  const roleKey = normalizeRoleKey(employee.roleKey || auth.roleKey || '') || DEFAULT_EMPLOYEE_ROLE_BY_DEPT[dept];

  return {
    auth,
    roleKey: isAdmin() ? 'administrator' : roleKey,
    employee: {
      ...employee,
      department: dept,
      roleKey: isAdmin() ? 'administrator' : roleKey,
      role: employee.role || ROLE_LABEL_BY_KEY[roleKey] || ''
    }
  };
};

export const getMyEmployeeId = () => {
  const info = getCurrentUserInfo();
  return isAdmin() ? null : (info.employee?.employeeId || null);
};

export const isRole = (roleKey) => {
  const info = getCurrentUserInfo();
  return info.roleKey === normalizeRoleKey(roleKey);
};

export const getCurrentDepartment = () => {
  const info = getCurrentUserInfo();
  return info.employee?.department || (isAdmin() ? 'Admin' : 'Unknown');
};

// Role-based permission matrix (canonical roleKey → permission tokens).
// 'reports.view' gates the Reports module (/reports and all /reports/* routes).
// It is currently satisfied by the administrator's '*' token; grant it to other
// roles by adding 'reports.view' to their lists when report access is required.
export const ROLE_PERMISSIONS = {
  administrator: ['*'],
  production_manager: [
    'production.view',
    'production.requirement.manage',
    'job_card.view',
    'job_card.create',
    'job_card.approve',
    'job_card.assign',
    'job_card.dispatch_request',
    'job_card.update_progress',
    'material_request.view',
    'material_request.create',
    'material_request.submit',
    'material_request.approve',
    'material_request.cancel',
    'production.entry.create',
    'production.qc.view',
    'production.qc.manage',
    'material_issue.view',
    'employee.view',
    'project.view',
    'ht_outsource.view',
    'ht_outsource.create',
    'indent.view',
    'indent.additional',
    'rejection.view',
    'ballooning.view',
    'ballooning.manage',
    'ballooning.approve'
  ],
  production_employee: [
    'production.view',
    'job_card.view',
    'job_card.update_progress',
    'job_card.dispatch_request',
    'production.entry.create',
    'production.qc.view',
    'production.qc.manage',
    'material_request.view',
    'material_request.create',
    'material_request.submit',
    'material_request.cancel',
    'material_issue.view',
    'project.view',
    'ht_outsource.view',
    'ht_outsource.create',
    'indent.view',
    'indent.additional',
    'rejection.view',
    'ballooning.view',
    'ballooning.manage'
  ],
  store_manager: [
    'store.module',
    'material_request.view',
    'material_request.edit',
    'material_issue.view',
    'material_issue.create',
    'material_issue.confirm',
    'material_return.view',
    'material_return.create',
    'inventory.view',
    'inventory.adjust',
    'inventory.transaction.view',
    'purchase_request.create',
    'purchase_request.view',
    'store.audit.view',
    'employee.view',
    'project.view',
    'ht_outsource.view',
    'ht_outsource.store_action',
    'indent.view',
    'indent.create',
    'indent.edit',
    'indent.submit',
    'receipt.view',
    'receipt.create',
    'arrival.create',
    'rejection.view',
    'rejection.forward',
    'debitnote.view',
    'debitnote.create'
  ],
  store_incharge: [
    'store.module', 'material_request.view', 'material_request.edit', 'material_issue.view',
    'material_issue.create', 'material_issue.confirm', 'material_return.view', 'material_return.create',
    'inventory.view', 'inventory.adjust', 'inventory.transaction.view', 'purchase_request.create',
    'purchase_request.view', 'store.audit.view', 'employee.view', 'project.view', 'ht_outsource.view',
    'ht_outsource.store_action', 'indent.view', 'indent.create', 'indent.edit', 'indent.submit',
    'receipt.view', 'receipt.create', 'arrival.create', 'rejection.view', 'rejection.forward',
    'debitnote.view', 'debitnote.create'
  ],
  store_employee: [
    'store.module',
    'material_request.view',
    'material_request.edit',
    'material_issue.view',
    'material_issue.create',
    'material_issue.confirm',
    'material_return.view',
    'material_return.create',
    'inventory.view',
    'inventory.transaction.view',
    'purchase_request.create',
    'purchase_request.view',
    'store.audit.view',
    'employee.view',
    'project.view',
    'ht_outsource.view',
    'ht_outsource.store_action',
    'indent.view',
    'indent.create',
    'indent.edit',
    'indent.submit',
    'receipt.view',
    'receipt.create',
    'arrival.create',
    'rejection.view',
    'rejection.forward',
    'debitnote.view',
    'debitnote.create'
  ],
  sales_manager: [
    'sales.enquiry',
    'sales.quotation',
    'sales.customer_order',
    'sales_order.view',
    'invoice.view',
    'delivery.view',
    'delivery.create',
    'project.view',
    'tally.export'
  ],
  sales_employee: [
    'sales.enquiry',
    'sales.quotation',
    'sales.customer_order',
    'sales_order.view',
    'invoice.view',
    'delivery.view',
    'delivery.create',
    'project.view',
    'tally.export'
  ],
  sales_executive: [
    'sales.enquiry', 'sales.quotation', 'sales.customer_order', 'sales_order.view',
    'invoice.view', 'delivery.view', 'delivery.create', 'project.view', 'tally.export'
  ],
  purchase_manager: [
    'purchase.reports.view',
    'purchase.order',
    'purchase.order.short_close',
    'purchase.supplier_invoice',
    'purchase_request.view',
    'purchase_request.approve',
    'quotation.approve',
    'inventory.view',
    'project.view',
    'ht_outsource.view',
    'ht_outsource.purchase_action',
    'indent.view',
    'indent.review',
    'indent.convert',
    'receipt.view',
    'rejection.view',
    'debitnote.view',
    'debitnote.create',
    'debitnote.record',
    'backup.view'
  ],
  purchase_employee: [
    'purchase.reports.view',
    'purchase.order',
    'purchase.supplier_invoice',
    'purchase_request.view',
    'inventory.view',
    'project.view',
    'ht_outsource.view',
    'ht_outsource.purchase_action',
    'indent.view',
    'indent.review',
    'indent.convert',
    'receipt.view',
    'rejection.view',
    'debitnote.view',
    'debitnote.create'
  ]
};

export const getPermissionSet = () => {
  const info = getCurrentUserInfo();
  if (!info.auth || !info.auth.isLoggedIn) return [];
  if (isAdmin()) return ['*'];
  const selectedDepartment = normalizeDepartment(info.employee?.department || info.auth.activeDepartment || info.auth.department);
  const assignment = (Array.isArray(info.auth.assignments) ? info.auth.assignments : []).find((item) => normalizeDepartment(item.department) === selectedDepartment);
  if (Array.isArray(assignment?.permissions)) return assignment.permissions;
  try {
    const departmentCatalog = JSON.parse(localStorage.getItem('departmentCatalog') || '[]');
    const roleCatalog = JSON.parse(localStorage.getItem('roleCatalog') || '[]');
    const permissionCatalog = JSON.parse(localStorage.getItem('rolePermissions') || '[]');
    const departmentId = assignment?.departmentId || stableDepartmentId(selectedDepartment, departmentCatalog);
    const roleId = assignment?.roleId || stableRoleId(selectedDepartment, info.roleKey, roleCatalog, departmentCatalog);
    const key = permissionAssignmentKey(departmentId, roleId);
    const saved = (Array.isArray(permissionCatalog) ? permissionCatalog : []).find((entry) => permissionAssignmentKey(entry.departmentId, entry.roleId) === key);
    if (Array.isArray(saved?.permissions)) return saved.permissions;
  } catch { /* Keep the built-in permission defaults if the local cache is unavailable. */ }
  return ROLE_PERMISSIONS[info.roleKey] || ROLE_PERMISSIONS[DEFAULT_EMPLOYEE_ROLE_BY_DEPT[info.employee?.department]] || [];
};

export const hasPermission = (permission) => {
  const perms = getPermissionSet();
  return perms.includes('*') || perms.includes(permission);
};

export const hasAnyPermission = (permissionList) => {
  const list = Array.isArray(permissionList) ? permissionList : [permissionList];
  return list.some((p) => hasPermission(p));
};

export const canManageEmployees = () => isAdmin();
