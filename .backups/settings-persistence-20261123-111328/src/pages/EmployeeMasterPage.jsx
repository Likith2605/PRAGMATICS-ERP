import { useEffect, useRef, useState } from 'react';
import { DEPARTMENTS, ROLES_BY_DEPARTMENT, ROLE_PERMISSIONS, roleKeyForRole, normalizeDepartment, isAdmin } from '../utils/permissions.js';
import { getEmployees, saveEmployees, generateEmployeeId } from '../utils/storeService.js';
import { getERPRecord, getRolePermissions, saveERPRecord, saveRolePermissions, deleteCustomRole as deleteCustomRoleRecord, deleteCustomDepartment as deleteCustomDepartmentRecord, deactivateCustomDepartment, deleteEmployee } from '../services/erpStateSync.js';
import { stableDepartmentId, stableRoleId } from '../../shared/roleIdentity.js';

const EMPTY_FORM = {
  name: '',
  email: '',
  password: '',
  mobile: '',
  department: 'Production Department',
  departmentAssignments: [{ department: 'Production Department', role: 'Production Employee', roleKey: 'production_employee' }],
  designation: '',
  roleKey: 'production_employee',
  role: 'Production Employee',
  joinedDate: ''
};

const EMPLOYEE_DEPARTMENTS = DEPARTMENTS.filter((department) => department !== 'Admin');
const ALL_PERMISSION_KEYS = [...new Set(Object.values(ROLE_PERMISSIONS).flat().filter((permission) => permission !== '*'))].sort();
const isServerAdminRecord = (employee) => ['admin', 'administrator'].includes(String(employee.roleKey || '').toLowerCase()) || String(employee.role || '').toLowerCase() === 'administrator' || employee.serverManaged === true;
const assignmentsFor = (employee) => {
  if (Array.isArray(employee.departmentAssignments) && employee.departmentAssignments.length) return employee.departmentAssignments;
  if (isServerAdminRecord(employee)) return [{ department: 'Admin', role: 'Administrator', roleKey: 'administrator' }];
  const normalized = normalizeDepartment(employee.department);
  const department = DEPARTMENTS.includes(normalized) && normalized !== 'Admin' ? normalized : 'Production Department';
  const role = ROLES_BY_DEPARTMENT[department]?.includes(employee.role) ? employee.role : (ROLES_BY_DEPARTMENT[department]?.[1] || ROLES_BY_DEPARTMENT[department]?.[0]);
  return [{ department, role, roleKey: roleKeyForRole(department, role) }];
};

const EmployeeMasterPage = () => {
  const [employees, setEmployees] = useState(getEmployees);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [departments, setDepartments] = useState(EMPLOYEE_DEPARTMENTS);
  const [roleCatalog, setRoleCatalog] = useState({});
  const [masterDialog, setMasterDialog] = useState(null);
  const [masterForm, setMasterForm] = useState({ name: '' });
  const [masterError, setMasterError] = useState('');
  const [masterSaving, setMasterSaving] = useState(false);
  const [permissionDialog, setPermissionDialog] = useState(null);
  const [permissionSelection, setPermissionSelection] = useState([]);
  const [permissionError, setPermissionError] = useState('');
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [deleteCanDeactivate, setDeleteCanDeactivate] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState(null);
  const deleteRequestLock = useRef(false);

  const admin = isAdmin();

  const refresh = () => setEmployees(getEmployees());

  useEffect(() => {
    if (!admin) return;
    let active = true;
    const refreshMasterCatalogs = async () => {
      const [savedDepartments, savedRoles] = await Promise.all([getERPRecord('departmentCatalog').catch(() => []), getERPRecord('roleCatalog').catch(() => [])]);
      if (!active) return;
      setDepartments([...new Set([...EMPLOYEE_DEPARTMENTS, ...(Array.isArray(savedDepartments) ? savedDepartments.filter((item) => item.active !== false).map((item) => item.name) : [])].filter(Boolean))]);
      const grouped = {};
      (Array.isArray(savedRoles) ? savedRoles : []).forEach((item) => { (grouped[item.department] ||= []).push({ id: item.id, departmentId: item.departmentId, name: item.name, roleKey: item.roleKey }); });
      setRoleCatalog(grouped);
    };
    refreshMasterCatalogs();
    const timer = window.setInterval(refreshMasterCatalogs, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [admin]);
  const rolesFor = (dept) => [...new Set([...(ROLES_BY_DEPARTMENT[dept] || []), ...(roleCatalog[dept] || []).map((item) => item.name)])];
  const roleKeyForAssignment = (dept, role) => roleCatalog[dept]?.find((item) => item.name === role)?.roleKey || roleKeyForRole(dept, role);
  const defaultRoleFor = (dept) => dept === 'Store Department' ? 'Store In-charge' : dept === 'Sales Department' ? 'Sales Executive' : (rolesFor(dept)[1] || rolesFor(dept)[0] || '');

  const toggleDepartment = (department) => setForm((prev) => {
    const existing = prev.departmentAssignments || [];
    const assigned = existing.some((item) => item.department === department);
    const departmentAssignments = assigned
      ? existing.filter((item) => item.department !== department)
      : [...existing, { department, role: defaultRoleFor(department), roleKey: defaultRoleFor(department) ? roleKeyForAssignment(department, defaultRoleFor(department)) : '' }];
    return { ...prev, departmentAssignments };
  });

  const setAssignmentRole = (department, role) => setForm((prev) => {
    const departmentAssignments = prev.departmentAssignments.map((item) => item.department === department
      ? { department, role, roleKey: roleKeyForAssignment(department, role) }
      : item);
    return { ...prev, departmentAssignments };
  });

  const requestRoleDeletion = (department, role) => {
    if (deleteRequestLock.current || deleteConfirmation) return;
    const isCustomRole = (roleCatalog[department] || []).some((item) => item.name === role);
    if (!admin || !isCustomRole) return;
    const customRole = (roleCatalog[department] || []).find((item) => item.name === role);
    if (!customRole?.id || ['undefined', 'null'].includes(String(customRole.id).toLowerCase())) {
      setDeleteNotice({ type: 'error', message: `Cannot delete role "${role}": its role ID is missing. Refresh the role catalog and try again.` });
      return;
    }
    setDeleteNotice(null);
    setDeleteError('');
    setDeleteBlocked(false);
    setDeleteCanDeactivate(false);
    setDeleteConfirmation({ kind: 'role', id: customRole.id, name: role, department });
  };

  const requestDepartmentDeletion = async (department) => {
    if (!admin || deleteRequestLock.current || deleteConfirmation) return;
    const customDepartment = departments.find((item) => item === department && !EMPLOYEE_DEPARTMENTS.includes(item));
    if (!customDepartment) {
      setDeleteNotice(null);
      setDeleteError('');
      setDeleteBlocked(false);
      setDeleteCanDeactivate(false);
      setDeleteConfirmation({ kind: 'department', id: null, name: department, builtIn: true });
      return;
    }
    deleteRequestLock.current = true;
    setDeleteSaving(true);
    setDeleteNotice(null);
    setDeleteError('');
    setDeleteBlocked(false);
    const savedDepartments = await getERPRecord('departmentCatalog').catch(() => []);
    const entry = (Array.isArray(savedDepartments) ? savedDepartments : []).find((item) => item.name === department);
    deleteRequestLock.current = false;
    setDeleteSaving(false);
    if (!entry?.id || ['undefined', 'null'].includes(String(entry.id).toLowerCase())) {
      setDeleteNotice({ type: 'error', message: `Cannot delete department "${department}": its department ID is missing. Refresh the department master and try again.` });
      return;
    }
    setDeleteCanDeactivate(false);
    setDeleteConfirmation({ kind: 'department', id: entry.id, name: department });
  };

  const closeDeleteConfirmation = () => {
    if (deleteSaving || deleteRequestLock.current) return;
    setDeleteConfirmation(null);
    setDeleteError('');
    setDeleteBlocked(false);
    setDeleteCanDeactivate(false);
  };

  const confirmCatalogDeletion = async () => {
    if (!deleteConfirmation || deleteRequestLock.current) return;
    deleteRequestLock.current = true;
    setDeleteSaving(true);
    setDeleteError('');
    try {
      if (deleteConfirmation.kind === 'employee') {
        const result = await deleteEmployee(deleteConfirmation.employeeId);
        if (!result.success) {
          setDeleteError(result.error || 'Employee could not be deleted.');
          setDeleteBlocked(result.status === 409);
          setDeleteCanDeactivate(false);
          return;
        }
        const refreshedEmployees = getEmployees();
        setEmployees(refreshedEmployees);
        setDeleteConfirmation(null);
        setDeleteNotice({ type: 'success', message: 'Employee deleted successfully. Historical records have been retained.' });
        return;
      }
      if (deleteConfirmation.kind === 'role') {
        const { id, name, department } = deleteConfirmation;
        const result = await deleteCustomRoleRecord(id);
        if (!result.success) {
          setDeleteError(result.error || `Could not delete role "${name}".`);
          setDeleteBlocked(/currently in use|assigned/i.test(result.error || ''));
          return;
        }
        const refreshedRoles = await getERPRecord('roleCatalog').catch(() => []);
        const groupedRoles = {};
        (Array.isArray(refreshedRoles) ? refreshedRoles : []).forEach((item) => { (groupedRoles[item.department] ||= []).push({ id: item.id, name: item.name, roleKey: item.roleKey }); });
        setRoleCatalog(groupedRoles);
        if ((form.departmentAssignments || []).some((item) => item.department === department && item.role === name)) setAssignmentRole(department, defaultRoleFor(department));
        setDeleteNotice({ type: 'success', message: `Role "${name}" was deleted.` });
        setDeleteConfirmation(null);
        return;
      }

      const { id, name } = deleteConfirmation;
      if (deleteConfirmation.builtIn || !id) {
        setDeleteError(`Built-in department "${name}" cannot be deleted or deactivated.`);
        setDeleteCanDeactivate(false);
        setDeleteBlocked(true);
        return;
      }
      if ((form.departmentAssignments || []).some((item) => item.department === name)) {
        setDeleteError(`Department "${name}" is assigned in this employee form. To permanently delete it, cancel, unassign it, and save the employee first. You can deactivate it now to preserve this assignment and its permissions.`);
        setDeleteCanDeactivate(true);
        setDeleteBlocked(true);
        return;
      }
      const result = await deleteCustomDepartmentRecord(id);
      if (!result.success) {
        setDeleteError(result.error || `Could not delete department "${name}".`);
        const dependencyBlocked = /assigned|in use|referenced|roles exist|built-in/i.test(result.error || '');
        setDeleteCanDeactivate(dependencyBlocked);
        setDeleteBlocked(dependencyBlocked);
        return;
      }
      setDepartments((current) => current.filter((item) => item !== name));
      setDeleteNotice({ type: 'success', message: `Department "${name}" was deleted.` });
      setDeleteConfirmation(null);
      setDeleteBlocked(false);
    } finally { deleteRequestLock.current = false; setDeleteSaving(false); }
  };

  const deactivateBlockedDepartment = async () => {
    if (!deleteConfirmation || deleteConfirmation.kind !== 'department' || deleteRequestLock.current) return;
    deleteRequestLock.current = true;
    setDeleteSaving(true);
    try {
      const { id, name } = deleteConfirmation;
      const result = await deactivateCustomDepartment(id);
      if (!result.success) { setDeleteError(result.error || `Could not deactivate department "${name}".`); return; }
      setDepartments((current) => current.filter((item) => item !== name));
      setDeleteNotice({ type: 'success', message: `Department "${name}" was deactivated. Existing assignments and records were preserved.` });
      setDeleteConfirmation(null);
      setDeleteCanDeactivate(false);
    } finally { deleteRequestLock.current = false; setDeleteSaving(false); }
  };

  const openMasterDialog = (kind, department = '') => { setMasterDialog({ kind, department }); setMasterForm({ name: '' }); setMasterError(''); };
  const saveMaster = async (event) => {
    event.preventDefault();
    if (masterSaving) return;
    const name = masterForm.name.trim();
    if (!name) return setMasterError(`${masterDialog.kind === 'department' ? 'Department' : 'Role'} name is required.`);
    setMasterSaving(true); setMasterError('');
    try {
      const [departmentData, roleData] = await Promise.all([getERPRecord('departmentCatalog').catch(() => []), getERPRecord('roleCatalog').catch(() => [])]);
      const departmentList = Array.isArray(departmentData) ? departmentData : [];
      const roleList = Array.isArray(roleData) ? roleData : [];
      if (masterDialog.kind === 'department') {
        if ([...EMPLOYEE_DEPARTMENTS, ...departmentList.map((item) => item.name)].some((item) => item.toLowerCase() === name.toLowerCase())) return setMasterError('A department with this name already exists.');
        const next = [...departmentList, { id: `dept-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, name, active: true }];
        if (!await saveERPRecord('departmentCatalog', next)) return setMasterError('Could not save department to the ERP server.');
        setDepartments((items) => [...new Set([...items, name])]);
      } else {
        const department = masterDialog.department;
        if (roleList.some((item) => item.department === department && item.name.toLowerCase() === name.toLowerCase())) return setMasterError('A role with this name already exists in this department.');
        const roleKey = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
        const departmentId = stableDepartmentId(department, departmentList);
        const customRole = { id: `role-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, departmentId, department, name, roleKey };
        const next = [...roleList, customRole];
        if (!await saveERPRecord('roleCatalog', next)) return setMasterError('Could not save role to the ERP server.');
        setRoleCatalog((current) => ({ ...current, [department]: [...(current[department] || []), customRole] }));
        setForm((prev) => ({ ...prev, departmentAssignments: prev.departmentAssignments.map((item) => item.department === department ? { ...item, role: name, roleKey } : item) }));
      }
      setMasterDialog(null);
    } finally { setMasterSaving(false); }
  };

  const openPermissionEditor = async (department, role) => {
    if (!admin || permissionSaving) return;
    setPermissionError('');
    const roleKey = roleKeyForAssignment(department, role);
    const [departmentCatalog, roleList] = await Promise.all([
      getERPRecord('departmentCatalog').catch(() => []),
      getERPRecord('roleCatalog').catch(() => [])
    ]);
    const departmentId = stableDepartmentId(department, departmentCatalog);
    const roleId = stableRoleId(department, roleKey, roleList, departmentCatalog);
    const saved = await getRolePermissions(departmentId, roleId).catch(() => ({ permissions: null }));
    setPermissionSelection(Array.isArray(saved.permissions) ? saved.permissions : (ROLE_PERMISSIONS[roleKey] || []));
    setPermissionDialog({ department, departmentId, role, roleId, roleKey });
  };

  const persistRolePermissions = async () => {
    if (!permissionDialog || permissionSaving) return;
    setPermissionSaving(true);
    setPermissionError('');
    const result = await saveRolePermissions({ department: permissionDialog.department, roleKey: permissionDialog.roleKey, permissions: permissionSelection });
    setPermissionSaving(false);
    if (!result.success) { setPermissionError(result.error || 'Permission changes could not be saved.'); return; }
    setPermissionDialog(null);
    setDeleteNotice({ type: 'success', message: `Permissions for ${permissionDialog.department} · ${permissionDialog.role} were saved to PostgreSQL.` });
  };

  const openAdd = () => {
    setEditId(null);
    const id = generateEmployeeId();
    setForm({
      ...EMPTY_FORM,
      employeeId: id.employeeId,
      role: defaultRoleFor(EMPTY_FORM.department),
      roleKey: roleKeyForRole(EMPTY_FORM.department, defaultRoleFor(EMPTY_FORM.department))
    });
    setError('');
    setShowPassword(false);
    setShowModal(true);
  };

  const openEdit = (emp) => {
    if (isServerAdminRecord(emp)) {
      window.alert('The Administrator login is managed by the ERP server configuration. Employee Master cannot change its department assignments.');
      return;
    }
    const departmentAssignments = assignmentsFor(emp);
    const dept = departmentAssignments[0]?.department || 'Production Department';
    const firstAssignment = departmentAssignments[0];
    const role = firstAssignment?.role || defaultRoleFor(dept);
    setEditId(emp.id);
    setForm({
      name: emp.name || '',
      email: emp.email || '',
      password: emp.password || '',
      mobile: emp.mobile || '',
      department: dept,
      departmentAssignments,
      designation: emp.designation || '',
      roleKey: roleKeyForRole(dept, role) || emp.roleKey || 'production_employee',
      role,
      joinedDate: emp.joinedDate || '',
      employeeId: emp.employeeId
    });
    setError('');
    setShowPassword(false);
    setShowModal(true);
  };

  const handleSave = async () => {
    setError('');
    if (!form.name.trim()) return setError('Employee name is required.');
    if (!form.employeeId.trim()) return setError('Employee ID is required.');

    const list = getEmployees();
    const duplicateId = list.find((e) => e.employeeId.trim().toLowerCase() === form.employeeId.trim().toLowerCase() && e.id !== editId);
    if (duplicateId) return setError(`Employee ID ${form.employeeId} is already in use.`);

    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      return setError('Enter a valid email address or leave it blank.');
    }

    const cleanEmail = form.email.trim().toLowerCase();
    const dupEmail = list.find((e) => e.id !== editId && e.email && e.email.trim().toLowerCase() === cleanEmail);
    if (dupEmail) return setError(`Email ${form.email.trim()} is already assigned to ${dupEmail.name}.`);

    if (cleanEmail && !form.password) {
      return setError('Login Password is required when a Login ID (email) is provided.');
    }

    if (form.password) {
      const pwd = String(form.password);
      const pwdError =
        pwd.length < 8
          ? 'Password must be at least 8 characters long.'
          : !/[A-Z]/.test(pwd)
          ? 'Password must contain at least one uppercase letter (A-Z).'
          : !/[a-z]/.test(pwd)
          ? 'Password must contain at least one lowercase letter (a-z).'
          : !/[0-9]/.test(pwd)
          ? 'Password must contain at least one numeric digit (0-9).'
          : !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pwd)
          ? 'Password must contain at least one special character (!@#$%^&* etc.).'
          : null;
      if (pwdError) return setError(pwdError);
    }

    if (!form.departmentAssignments?.length) return setError('Assign at least one department.');

    let next;
    const firstAssignment = form.departmentAssignments[0];
    const { primaryDepartment: _legacyPrimaryDepartment, ...formWithoutLegacyPrimary } = form;
    let departmentCatalog = []; let roleList = [];
    try { departmentCatalog = JSON.parse(localStorage.getItem('departmentCatalog') || '[]'); roleList = JSON.parse(localStorage.getItem('roleCatalog') || '[]'); } catch { /* IDs are reconstructed from saved catalogs when the server authenticates. */ }
    const departmentAssignments = form.departmentAssignments.map((assignment) => {
      const departmentId = stableDepartmentId(assignment.department, departmentCatalog);
      return { ...assignment, departmentId, roleId: stableRoleId(assignment.department, assignment.roleKey, roleList, departmentCatalog) };
    });
    const payload = { ...formWithoutLegacyPrimary, department: firstAssignment.department, role: firstAssignment.role, roleKey: firstAssignment.roleKey, departmentAssignments };
    if (editId) {
      next = list.map((e) => (e.id === editId ? { ...e, ...payload, employeeId: form.employeeId.trim().toUpperCase() } : e));
    } else {
      next = [
        {
          id: `emp-${Date.now()}`,
          employeeId: form.employeeId.trim().toUpperCase(),
          ...payload,
          active: true,
          createdAt: new Date().toISOString()
        },
        ...list
      ];
    }
    const persisted = await saveERPRecord('employees', next);
    if (!persisted) return setError('Employee changes could not be saved to the ERP server. Check the connection and try again.');
    saveEmployees(next);
    refresh();
    setShowModal(false);
  };

  const toggleActive = async (emp) => {
    const deactivating = emp.active !== false;
    let reason = '';
    if (deactivating) {
      if (!window.confirm(`Deactivate ${emp.name}? Their server sessions will be revoked.`)) return;
      reason = window.prompt(`Reason for deactivating ${emp.name}:`)?.trim() || '';
      if (!reason) return;
    }
    const next = getEmployees().map((e) => (e.id === emp.id ? {
      ...e,
      active: !e.active,
      ...(deactivating ? { deactivationReason: reason, deactivatedAt: new Date().toISOString() } : {})
    } : e));
    if (deactivating) {
      try {
        const reasons = JSON.parse(localStorage.getItem('erp_state_action_reasons') || '{}');
        reasons.employees = reason;
        localStorage.setItem('erp_state_action_reasons', JSON.stringify(reasons));
      } catch { /* the record's deactivationReason also carries the reason */ }
    }
    const persisted = await saveERPRecord('employees', next);
    if (!persisted) { window.alert('Employee account status could not be saved to the ERP server.'); return; }
    saveEmployees(next);
    refresh();
  };

  const handleDelete = (emp) => {
    if (!admin || deleteRequestLock.current || deleteConfirmation || isServerAdminRecord(emp)) return;
    setDeleteError(''); setDeleteBlocked(false); setDeleteCanDeactivate(false); setDeleteNotice(null);
    setDeleteConfirmation({ kind: 'employee', employeeId: emp.employeeId, name: emp.name });
  };
  const filtered = employees.filter((e) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;
    const assignmentText = assignmentsFor(e).map((assignment) => `${assignment.department} ${assignment.role}`).join(' ');
    return [e.name, e.employeeId, e.department, assignmentText, e.designation, e.mobile, e.email].join(' ').toLowerCase().includes(q);
  });

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Employee Master</h1>
        </div>
        <div className="header-actions">
          {admin && (
            <button type="button" className="button-primary" onClick={openAdd}>
              + Add Employee
            </button>
          )}
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Employees</h3>
          <span className="muted-text">{filtered.length} shown / {employees.length} total</span>
        </div>

        <input
          type="text"
          className="action-select form-input search-input"
          placeholder="Search by name, ID, department or role..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Employee Name</th>
                <th>Assigned Departments · Roles</th>
                <th>Login Status</th>
                <th>Account Status</th>
                {admin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={admin ? 7 : 6} className="no-history-row">No employees found.</td>
                </tr>
              ) : (
                filtered.map((emp) => (
                  <tr key={emp.id}>
                    <td><strong>{emp.employeeId}</strong></td>
                    <td>{emp.name}</td>
                    <td>
                      <div className="employee-department-summary">
                        {assignmentsFor(emp).map((assignment) => <span key={assignment.department}><strong>{assignment.department}</strong><small>{assignment.role}</small></span>)}
                      </div>
                    </td>
                    <td>
                      {emp.email ? (
                        <span className="status-badge active">Yes</span>
                      ) : (
                        <span className="status-badge st-pending-store">None</span>
                      )}
                    </td>
                    <td>
                      <span className={`status-badge ${emp.active === false ? 'st-cancelled' : 'active'}`}>
                        {emp.active === false ? 'Inactive' : 'Active'}
                      </span>
                    </td>
                    {admin && (
                      <td>
                        <div className="table-actions">
                          {isServerAdminRecord(emp) ? <span className="muted-text">Server managed</span> : <>
                            <button type="button" className="button-secondary button-small" onClick={() => openEdit(emp)}>Edit</button>
                            <button type="button" className="button-secondary button-small" onClick={() => toggleActive(emp)}>
                              {emp.active === false ? 'Activate' : 'Deactivate'}
                            </button>
                            <button type="button" className="button-secondary button-small" onClick={() => handleDelete(emp)} disabled={deleteSaving || Boolean(deleteConfirmation)}>Delete</button>
                          </>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="template-modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="template-modal employee-modal" onClick={(e) => e.stopPropagation()}>
            <div className="template-modal-header">
              <h3>{editId ? `Edit ${form.employeeId}` : 'Add Employee'}</h3>
              <button type="button" className="template-modal-close" onClick={() => setShowModal(false)} aria-label="Close">&times;</button>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label>Employee ID</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.employeeId}
                  onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label>Full Name *</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="form-field form-field--wide">
                <div className="employee-assignment-heading"><label>Department Assignments and Roles *</label>{admin && <button type="button" className="button-secondary button-small" onClick={() => openMasterDialog('department')}>+ Add Department</button>}</div>
                {deleteNotice && <div className={deleteNotice.type === 'success' ? 'employee-delete-notice success' : 'employee-delete-notice error'} role="status">{deleteNotice.message}</div>}
                <div className="employee-department-editor">
                  {departments.map((department) => {
                    const assignment = form.departmentAssignments.find((item) => item.department === department);
                    return <div className="employee-department-row" key={department}>
                      <label className="employee-department-check"><input type="checkbox" checked={Boolean(assignment)} onChange={() => toggleDepartment(department)} /> {department}</label>
                      {assignment && <div className="employee-role-controls">
                        <select className="action-select" aria-label={`${department} role`} value={assignment.role} onChange={(event) => setAssignmentRole(department, event.target.value)}>
                          {!assignment.role && <option value="">Select role</option>}
                          {rolesFor(department).map((role) => <option key={role} value={role}>{role}</option>)}
                        </select>
                        {admin && <button type="button" className="button-secondary button-small" onClick={() => openMasterDialog('role', department)}>+ Add Role</button>}
                        {admin && assignment.role && <button type="button" className="button-secondary button-small" onClick={() => openPermissionEditor(department, assignment.role)}>Permissions</button>}
                        {admin && (roleCatalog[department] || []).some((item) => item.name === assignment.role) && <button type="button" className="employee-delete-icon" aria-label={`Delete ${assignment.role} role`} title="Delete Role" disabled={deleteSaving || Boolean(deleteConfirmation)} onClick={() => requestRoleDeletion(department, assignment.role)}>&times;</button>}
                      </div>}
                      {admin && <button type="button" className="employee-delete-icon employee-delete-department" aria-label={`Delete ${department} department`} title="Delete Department" disabled={deleteSaving || Boolean(deleteConfirmation)} onClick={() => requestDepartmentDeletion(department)}>&times;</button>}
                    </div>;
                  })}
                </div>
              </div>
              <div className="form-field">
                <label>Designation</label>
                <input
                  type="text"
                  className="action-select form-input"
                  placeholder="e.g. Production Engineer, Store Assistant"
                  value={form.designation}
                  onChange={(e) => setForm({ ...form, designation: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label>Email / Login ID (optional)</label>
                <input
                  type="email"
                  className="action-select form-input"
                  placeholder="user@company.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value.trim() })}
                />
              </div>
              <div className="form-field">
                <label>Login Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="action-select form-input"
                    style={{ width: '100%', paddingRight: '52px', boxSizing: 'border-box' }}
                    placeholder="Min 8 chars, A-Z, a-z, 0-9, special char"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    style={{
                      position: 'absolute',
                      right: '8px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#2563eb',
                      fontSize: '12px',
                      fontWeight: 700,
                      padding: '4px 6px'
                    }}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <span className="muted-text">Used to log into the ERP via the Employee Portal. Click Show to view password.</span>
              </div>
              <div className="form-field">
                <label>Mobile</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.mobile}
                  onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label>Joined Date</label>
                <input
                  type="date"
                  className="action-select form-input"
                  value={form.joinedDate}
                  onChange={(e) => setForm({ ...form, joinedDate: e.target.value })}
                />
              </div>
            </div>

            {error && <div className="form-error">{error}</div>}

            <div className="template-modal-actions">
              <button type="button" className="button-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="button" className="button-primary" onClick={handleSave}>Save Employee</button>
            </div>
          </div>
        </div>
      )}
      {masterDialog && <div className="template-modal-backdrop employee-master-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !masterSaving) setMasterDialog(null); }}>
        <form className="template-modal employee-master-dialog" onSubmit={saveMaster}>
          <div className="template-modal-header"><h3>{masterDialog.kind === 'department' ? 'Add Department' : `Add Role · ${masterDialog.department}`}</h3><button type="button" className="template-modal-close" onClick={() => setMasterDialog(null)} aria-label="Close">×</button></div>
          <label className="form-field"><span>{masterDialog.kind === 'department' ? 'Department' : 'Role'} Name *</span><input autoFocus value={masterForm.name} onChange={(event) => setMasterForm({ ...masterForm, name: event.target.value })} /></label>
          {masterError && <div className="form-error">{masterError}</div>}
          <div className="template-modal-actions"><button type="button" className="button-secondary" disabled={masterSaving} onClick={() => setMasterDialog(null)}>Cancel</button><button type="submit" className="button-primary" disabled={masterSaving}>{masterSaving ? 'Saving…' : `Save ${masterDialog.kind === 'department' ? 'Department' : 'Role'}`}</button></div>
        </form>
      </div>}
      {permissionDialog && <div className="template-modal-backdrop employee-master-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !permissionSaving) setPermissionDialog(null); }}>
        <div className="template-modal employee-master-dialog" role="dialog" aria-modal="true" aria-labelledby="role-permissions-title">
          <div className="template-modal-header"><h3 id="role-permissions-title">Role Permissions · {permissionDialog.role}</h3><button type="button" className="template-modal-close" disabled={permissionSaving} onClick={() => setPermissionDialog(null)} aria-label="Close">&times;</button></div>
          <p>{permissionDialog.department} · changes are saved centrally for this department and role.</p>
          <div className="employee-permission-list">
            {ALL_PERMISSION_KEYS.map((permission) => <label key={permission}><input type="checkbox" checked={permissionSelection.includes(permission)} onChange={(event) => setPermissionSelection((current) => event.target.checked ? [...current, permission] : current.filter((item) => item !== permission))} /> <code>{permission}</code></label>)}
          </div>
          {permissionError && <div className="form-error" role="alert">{permissionError}</div>}
          <div className="template-modal-actions"><button type="button" className="button-secondary" disabled={permissionSaving} onClick={() => setPermissionDialog(null)}>Cancel</button><button type="button" className="button-primary" disabled={permissionSaving} onClick={persistRolePermissions}>{permissionSaving ? 'Saving…' : 'Save Permissions'}</button></div>
        </div>
      </div>}
      {deleteConfirmation && <div className="template-modal-backdrop employee-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeleteConfirmation(); }}>
        <div className="template-modal employee-delete-confirmation" role="dialog" aria-modal="true" aria-labelledby="employee-delete-title">
          <div className="template-modal-header"><h3 id="employee-delete-title">{deleteConfirmation.kind === 'employee' ? 'Delete Employee' : deleteConfirmation.kind === 'role' ? 'Confirm Role Deletion' : 'Confirm Department Deletion'}</h3><button type="button" className="template-modal-close" onClick={closeDeleteConfirmation} disabled={deleteSaving} aria-label="Close">&times;</button></div>
          <p className="employee-delete-confirmation-message">{deleteConfirmation.kind === 'employee' ? 'Are you sure you want to delete this employee? Their login access and department assignments will be removed. All existing audit history and business records will be retained.' : deleteConfirmation.kind === 'role' ? 'Are you sure you want to delete this role?' : 'Are you sure you want to delete this department?'}</p>
          <strong className="employee-delete-confirmation-name">{deleteConfirmation.kind === 'employee' ? `Employee ID: ${deleteConfirmation.employeeId} · ${deleteConfirmation.name}` : `${deleteConfirmation.kind === 'role' ? 'Role' : 'Department'}: ${deleteConfirmation.name}`}</strong>
          {deleteError && <div className="form-error" role="alert">{deleteError}</div>}
          <div className="template-modal-actions employee-delete-confirmation-actions">
            <button type="button" className="button-secondary" onClick={closeDeleteConfirmation} disabled={deleteSaving}>Cancel</button>
            {deleteCanDeactivate && <button type="button" className="button-secondary" onClick={deactivateBlockedDepartment} disabled={deleteSaving}>Deactivate Instead</button>}
            <button type="button" className="button-primary" onClick={confirmCatalogDeletion} disabled={deleteSaving || deleteBlocked}>{deleteSaving ? 'Deleting…' : deleteConfirmation.kind === 'employee' ? 'Delete Employee' : 'Delete'}</button>
          </div>
        </div>
      </div>}
    </section>
  );
};

export default EmployeeMasterPage;
