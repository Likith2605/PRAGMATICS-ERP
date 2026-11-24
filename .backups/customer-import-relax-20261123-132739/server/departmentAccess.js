const DEPARTMENT_ROLE_KEYS = Object.freeze({
  'Sales Department': new Set(['sales_manager', 'sales_employee', 'sales_executive']),
  'Purchase Department': new Set(['purchase_manager', 'purchase_employee']),
  'Production Department': new Set(['production_manager', 'production_employee']),
  'Store Department': new Set(['store_manager', 'store_employee', 'store_incharge'])
});

const DEPARTMENT_ALIASES = Object.freeze({
  Sales: 'Sales Department',
  Purchase: 'Purchase Department',
  Production: 'Production Department',
  Store: 'Store Department',
  Stores: 'Store Department',
  QC: 'Production Department'
});

const DEFAULT_ROLE = Object.freeze({
  'Sales Department': 'sales_employee',
  'Purchase Department': 'purchase_employee',
  'Production Department': 'production_employee',
  'Store Department': 'store_employee'
});

const ROLE_KEYS_BY_LABEL = Object.freeze({
  'sales manager': 'sales_manager', 'sales employee': 'sales_employee', 'sales executive': 'sales_executive',
  'purchase manager': 'purchase_manager', 'purchase employee': 'purchase_employee',
  'production manager': 'production_manager', 'production employee': 'production_employee',
  'store manager': 'store_manager', 'store employee': 'store_employee', 'store in-charge': 'store_incharge'
});

const LABELS = Object.freeze({
  sales_manager: 'Sales Manager', sales_employee: 'Sales Employee', sales_executive: 'Sales Executive',
  purchase_manager: 'Purchase Manager', purchase_employee: 'Purchase Employee',
  production_manager: 'Production Manager', production_employee: 'Production Employee',
  store_manager: 'Store Manager', store_employee: 'Store Employee', store_incharge: 'Store In-charge'
});

export const normalizeDepartment = (value) => DEPARTMENT_ALIASES[value] || value || '';

export const normalizeEmployeeAssignments = (employee = {}) => {
  const raw = Array.isArray(employee.departmentAssignments) && employee.departmentAssignments.length
    ? employee.departmentAssignments
    : [{ department: employee.department, role: employee.role, roleKey: employee.roleKey }];
  const assignments = new Map();
  for (const entry of raw) {
    const department = normalizeDepartment(entry?.department);
    if (!department) continue;
    const roleKey = String(entry?.roleKey || ROLE_KEYS_BY_LABEL[String(entry?.role || '').toLowerCase()] || '').toLowerCase();
    const safeRoleKey = DEPARTMENT_ROLE_KEYS[department]?.has(roleKey) ? roleKey : (roleKey || DEFAULT_ROLE[department] || 'employee');
    assignments.set(department, { department, roleKey: safeRoleKey, role: LABELS[safeRoleKey] || String(entry?.role || safeRoleKey) });
  }
  return [...assignments.values()];
};

export const assignmentForDepartment = (assignments, department) =>
  assignments.find((item) => item.department === normalizeDepartment(department)) || null;

export const validateEmployeeAssignments = (employee = {}) => {
  if (employee.departmentAssignments !== undefined && !Array.isArray(employee.departmentAssignments)) return 'Department assignments must be a list.';
  if (Array.isArray(employee.departmentAssignments)) {
    const seen = new Set();
    for (const entry of employee.departmentAssignments) {
      const department = normalizeDepartment(entry?.department);
      if (!department) return 'Department name is required for each assignment.';
      if (seen.has(department)) return `Department '${department}' is assigned more than once.`;
      seen.add(department);
      const roleKey = String(entry?.roleKey || ROLE_KEYS_BY_LABEL[String(entry?.role || '').toLowerCase()] || '').toLowerCase();
      if (!roleKey) return `A role is required for '${department}'.`;
    }
    if (!seen.size) return 'Assign at least one department to the employee.';
  } else {
    if (normalizeDepartment(employee.department) === 'Admin' && (String(employee.roleKey || '').toLowerCase() === 'administrator' || String(employee.role || '').toLowerCase() === 'administrator')) return null;
    const assignments = normalizeEmployeeAssignments(employee);
    if (!assignments.length) return 'A valid department and role are required for the employee.';
  }
  return null;
};

export const DEPARTMENT_ROLE_OPTIONS = Object.freeze({
  'Sales Department': [
    { role: 'Sales Manager', roleKey: 'sales_manager' },
    { role: 'Sales Executive', roleKey: 'sales_executive' },
    { role: 'Sales Employee', roleKey: 'sales_employee' }
  ],
  'Purchase Department': [
    { role: 'Purchase Manager', roleKey: 'purchase_manager' },
    { role: 'Purchase Employee', roleKey: 'purchase_employee' }
  ],
  'Production Department': [
    { role: 'Production Manager', roleKey: 'production_manager' },
    { role: 'Production Employee', roleKey: 'production_employee' }
  ],
  'Store Department': [
    { role: 'Store In-charge', roleKey: 'store_incharge' },
    { role: 'Store Manager', roleKey: 'store_manager' },
    { role: 'Store Employee', roleKey: 'store_employee' }
  ]
});

// Storage keys are shared sync buckets; assigning them to an operational area
// prevents one selected role from writing another area's transaction records.
const PREFIX_DEPARTMENT = Object.freeze([
  [/^(sales|quotation|customer|exportInvoice|delivery|projectRequest|projectRequests)/i, 'Sales Department'],
  [/^(purchase|vendor|supplier|materialReceipt|materialArrival|rejection|debitNote|htOutsource)/i, 'Purchase Department'],
  [/^(production|jobCard|quality|ballooning|machine|bom)/i, 'Production Department'],
  [/^(inventory|stock|store|materialRequest|employeeIssue)/i, 'Store Department']
]);

export const departmentForStorageKey = (key) => {
  const match = PREFIX_DEPARTMENT.find(([pattern]) => pattern.test(String(key || '')));
  return match?.[1] || null;
};

const ROLE_PERMISSIONS = Object.freeze({
  sales_executive: ['sales.enquiry','sales.quotation','sales.customer_order','sales_order.view','invoice.view','delivery.view','delivery.create','project.view','tally.export'],
  sales_manager: ['sales.enquiry','sales.quotation','sales.customer_order','sales_order.view','invoice.view','delivery.view','delivery.create','project.view','tally.export'],
  sales_employee: ['sales.enquiry','sales.quotation','sales.customer_order','sales_order.view','invoice.view','delivery.view','delivery.create','project.view','tally.export'],
  purchase_manager: ['purchase.reports.view','purchase.order','purchase.order.short_close','purchase.supplier_invoice','purchase_request.view','purchase_request.approve','quotation.approve','inventory.view','project.view','ht_outsource.view','ht_outsource.purchase_action','indent.view','indent.review','indent.convert','receipt.view','rejection.view','debitnote.view','debitnote.create','debitnote.record','backup.view'],
  purchase_employee: ['purchase.reports.view','purchase.order','purchase.supplier_invoice','purchase_request.view','inventory.view','project.view','ht_outsource.view','ht_outsource.purchase_action','indent.view','indent.review','indent.convert','receipt.view','rejection.view','debitnote.view','debitnote.create'],
  production_manager: ['production.view','production.requirement.manage','job_card.view','job_card.create','job_card.approve','job_card.assign','job_card.dispatch_request','job_card.update_progress','material_request.view','material_request.create','material_request.submit','material_request.approve','material_request.cancel','production.entry.create','production.qc.view','production.qc.manage','material_issue.view','employee.view','project.view','ht_outsource.view','ht_outsource.create','indent.view','indent.additional','rejection.view','ballooning.view','ballooning.manage','ballooning.approve'],
  production_employee: ['production.view','job_card.view','job_card.update_progress','job_card.dispatch_request','production.entry.create','production.qc.view','production.qc.manage','material_request.view','material_request.create','material_request.submit','material_request.cancel','material_issue.view','project.view','ht_outsource.view','ht_outsource.create','indent.view','indent.additional','rejection.view','ballooning.view','ballooning.manage'],
  store_manager: ['store.module','material_request.view','material_request.edit','material_issue.view','material_issue.create','material_issue.confirm','material_return.view','material_return.create','inventory.view','inventory.adjust','inventory.transaction.view','purchase_request.create','purchase_request.view','store.audit.view','employee.view','project.view','ht_outsource.view','ht_outsource.store_action','indent.view','indent.create','indent.edit','indent.submit','receipt.view','receipt.create','arrival.create','rejection.view','rejection.forward','debitnote.view','debitnote.create'],
  store_incharge: ['store.module','material_request.view','material_request.edit','material_issue.view','material_issue.create','material_issue.confirm','material_return.view','material_return.create','inventory.view','inventory.adjust','inventory.transaction.view','purchase_request.create','purchase_request.view','store.audit.view','employee.view','project.view','ht_outsource.view','ht_outsource.store_action','indent.view','indent.create','indent.edit','indent.submit','receipt.view','receipt.create','arrival.create','rejection.view','rejection.forward','debitnote.view','debitnote.create'],
  store_employee: ['store.module','material_request.view','material_request.edit','material_issue.view','material_issue.create','material_issue.confirm','material_return.view','material_return.create','inventory.view','inventory.transaction.view','purchase_request.create','purchase_request.view','store.audit.view','employee.view','project.view','ht_outsource.view','ht_outsource.store_action','indent.view','indent.create','indent.edit','indent.submit','receipt.view','receipt.create','arrival.create','rejection.view','rejection.forward','debitnote.view','debitnote.create']
});

export const ALLOWED_PERMISSION_KEYS = Object.freeze([...new Set(Object.values(ROLE_PERMISSIONS).flat())].sort());
export const permissionsForRole = (roleKey, overrides) => Array.isArray(overrides) ? overrides : (ROLE_PERMISSIONS[roleKey] || []);
export const hasPermissionForRole = (roleKey, required, overrides) => {
  const available = new Set(permissionsForRole(roleKey, overrides));
  const list = Array.isArray(required) ? required : [required];
  return list.some((permission) => available.has(permission));
};
