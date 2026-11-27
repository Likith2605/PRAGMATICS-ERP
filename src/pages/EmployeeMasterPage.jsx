import { useEffect, useRef, useState } from 'react';
import { DEPARTMENTS, ROLES_BY_DEPARTMENT, ROLE_PERMISSIONS, roleKeyForRole, normalizeDepartment, isAdmin } from '../utils/permissions.js';
import {
  listDepartments, listRoles, createDepartment, createRole, deleteDepartment, deleteRole,
  updateDepartment, updateRole, restoreDepartment, restoreRole, getRolePermissions, saveRolePermissions,
  getLegacyDepartmentRolePreview, importSelectedDepartmentRoleCatalog
} from '../services/departmentRoleCatalogApi.js';
import { listEmployees, createEmployee, updateEmployee, deleteEmployee, restoreEmployee, getLegacyEmployeesPreview, importLegacyEmployees } from '../services/employeeApi.js';
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
const nextEmployeeId = (employees) => {
  const max = employees.reduce((current, employee) => {
    const match = String(employee.employeeId || '').match(/(\d+)\s*$/);
    return match ? Math.max(current, Number(match[1]) || 0) : current;
  }, 0);
  return `EMP-${String(max + 1).padStart(3, '0')}`;
};

const EmployeeMasterPage = () => {
  const [employees, setEmployees] = useState([]);
  const [employeeLoading, setEmployeeLoading] = useState(true);
  const [employeeError, setEmployeeError] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editVersion, setEditVersion] = useState(null);
  const [editHasPassword, setEditHasPassword] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [departments, setDepartments] = useState(EMPLOYEE_DEPARTMENTS);
  const [departmentCatalog, setDepartmentCatalog] = useState([]);
  const [roleRecords, setRoleRecords] = useState([]);
  const [roleCatalog, setRoleCatalog] = useState({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [showDeletedCatalogs, setShowDeletedCatalogs] = useState(false);
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
  const [showLegacy, setShowLegacy] = useState(false);
  const [legacyEntries, setLegacyEntries] = useState([]);
  const [legacySelection, setLegacySelection] = useState([]);
  const [legacyError, setLegacyError] = useState('');
  const [legacyLoading, setLegacyLoading] = useState(false);
  const [legacyImporting, setLegacyImporting] = useState(false);
  const [showCatalogLegacy, setShowCatalogLegacy] = useState(false);
  const [catalogLegacyEntries, setCatalogLegacyEntries] = useState([]);
  const [catalogLegacySelection, setCatalogLegacySelection] = useState([]);
  const [catalogLegacyError, setCatalogLegacyError] = useState('');
  const [catalogLegacyLoading, setCatalogLegacyLoading] = useState(false);
  const [catalogLegacyImporting, setCatalogLegacyImporting] = useState(false);
  const deleteRequestLock = useRef(false);

  const admin = isAdmin();

  const refresh = async () => {
    setEmployeeError('');
    const records = await listEmployees({ includeDeleted });
    setEmployees(records);
    return records;
  };
  const refreshMasterCatalogs = async (isActive = () => true) => {
    setCatalogLoading(true);
    try {
      const [savedDepartments, savedRoles] = await Promise.all([
        listDepartments({ includeDeleted: true }),
        listRoles({ includeDeleted: true })
      ]);
      if (!isActive()) return;
      setDepartmentCatalog(savedDepartments);
      setRoleRecords(savedRoles);
      setDepartments([...new Set([...EMPLOYEE_DEPARTMENTS, ...savedDepartments.map((item) => item.name)].filter(Boolean))]);
      const grouped = {};
      savedRoles.forEach((item) => { (grouped[item.department] ||= []).push(item); });
      setRoleCatalog(grouped);
      setCatalogError('');
    } catch (loadError) {
      if (isActive()) setCatalogError(loadError.message || 'Department and role catalogs could not be loaded from PostgreSQL.');
      throw loadError;
    } finally {
      if (isActive()) setCatalogLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setEmployeeLoading(true);
    setEmployeeError('');
    listEmployees({ includeDeleted })
      .then((records) => { if (active) setEmployees(records); })
      .catch((loadError) => { if (active) setEmployeeError(loadError.message || 'Employee records could not be loaded.'); })
      .finally(() => { if (active) setEmployeeLoading(false); });
    return () => { active = false; };
  }, [admin, includeDeleted]);

  useEffect(() => {
    if (!admin) return;
    let active = true;
    refreshMasterCatalogs(() => active).catch(() => {});
    const timer = window.setInterval(() => refreshMasterCatalogs(() => active).catch(() => {}), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [admin]);
  const rolesFor = (dept) => {
    const assignedRole = form.departmentAssignments.find((item) => item.department === dept)?.role;
    const selectable = (roleCatalog[dept] || []).filter((item) =>
      (!item.legacy && item.active !== false && !item.deletedAt) || item.name === assignedRole
    ).map((item) => item.name);
    return [...new Set([...(ROLES_BY_DEPARTMENT[dept] || []), ...selectable])];
  };
  const roleKeyForAssignment = (dept, role) => roleCatalog[dept]?.find((item) => item.name === role)?.roleKey || roleKeyForRole(dept, role);
  const defaultRoleFor = (dept) => dept === 'Store Department' ? 'Store In-charge' : dept === 'Sales Department' ? 'Sales Executive' : (rolesFor(dept)[1] || rolesFor(dept)[0] || '');

  const toggleDepartment = (department) => setForm((prev) => {
    const existing = prev.departmentAssignments || [];
    const assigned = existing.some((item) => item.department === department);
    const catalogRecord = departmentCatalog.find((item) => item.name === department);
    if (!assigned && catalogRecord && (catalogRecord.legacy || catalogRecord.active === false || catalogRecord.deletedAt)) return prev;
    const departmentAssignments = assigned
      ? existing.filter((item) => item.department !== department)
      : [...existing, { department, role: defaultRoleFor(department), roleKey: defaultRoleFor(department) ? roleKeyForAssignment(department, defaultRoleFor(department)) : '' }];
    return { ...prev, departmentAssignments };
  });

  const setAssignmentRole = (department, role) => setForm((prev) => {
    const currentRole = prev.departmentAssignments.find((item) => item.department === department)?.role;
    const roleRecord = roleCatalog[department]?.find((item) => item.name === role);
    if (roleRecord && (roleRecord.legacy || roleRecord.active === false || roleRecord.deletedAt) && role !== currentRole) return prev;
    const departmentAssignments = prev.departmentAssignments.map((item) => item.department === department
      ? { department, role, roleKey: roleKeyForAssignment(department, role) }
      : item);
    return { ...prev, departmentAssignments };
  });

  const requestRoleDeletion = (department, role) => {
    if (deleteRequestLock.current || deleteConfirmation) return;
    const isCustomRole = (roleCatalog[department] || []).some((item) => item.name === role && !item.legacy);
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
    const anyEntry = departmentCatalog.find((item) => item.name === department);
    if (anyEntry?.legacy) {
      deleteRequestLock.current = false;
      setDeleteSaving(false);
      setDeleteNotice({ type: 'error', message: `Department "${department}" is a preserved legacy record. Import it before managing it.` });
      return;
    }
    const entry = departmentCatalog.find((item) => item.name === department && !item.deletedAt);
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
        const reason = window.prompt(`Reason for deleting ${deleteConfirmation.name}:`)?.trim();
        if (!reason) {
          setDeleteError('A deletion reason is required.');
          return;
        }
        await deleteEmployee(deleteConfirmation.id, deleteConfirmation.version, reason);
        await refresh();
        setDeleteConfirmation(null);
        setDeleteNotice({ type: 'success', message: 'Employee was soft-deleted. Historical records have been retained.' });
        return;
      }
      if (deleteConfirmation.kind === 'role') {
        const { id, name, department } = deleteConfirmation;
        const record = roleRecords.find((item) => item.id === id);
        const reason = window.prompt(`Reason for deleting role "${name}":`)?.trim();
        if (!reason) { setDeleteError('A deletion reason is required.'); return; }
        await deleteRole(id, record?.version, reason);
        await refreshMasterCatalogs();
        if ((form.departmentAssignments || []).some((item) => item.department === department && item.role === name)) setAssignmentRole(department, defaultRoleFor(department));
        setDeleteNotice({ type: 'success', message: `Role "${name}" was soft-deleted. It can be restored from the catalog history.` });
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
      const record = departmentCatalog.find((item) => item.id === id);
      const reason = window.prompt(`Reason for deleting department "${name}":`)?.trim();
      if (!reason) { setDeleteError('A deletion reason is required.'); return; }
      await deleteDepartment(id, record?.version, reason);
      await refreshMasterCatalogs();
      setDeleteNotice({ type: 'success', message: `Department "${name}" was soft-deleted. It can be restored from the catalog history.` });
      setDeleteConfirmation(null);
      setDeleteBlocked(false);
    } catch (requestError) {
      setDeleteError(requestError.message || 'The requested change could not be completed.');
      const dependencyBlocked = requestError.status === 409 && /assigned|in use|roles exist|roles before/i.test(requestError.message || '');
      setDeleteCanDeactivate(dependencyBlocked && deleteConfirmation?.kind === 'department');
      setDeleteBlocked(dependencyBlocked);
    } finally { deleteRequestLock.current = false; setDeleteSaving(false); }
  };

  const openLegacyPreview = async () => {
    setShowLegacy(true);
    setLegacyLoading(true);
    setLegacyError('');
    try {
      const entries = await getLegacyEmployeesPreview();
      setLegacyEntries(entries);
      setLegacySelection(entries.filter((entry) => entry.status === 'eligible').map((entry) => entry.key));
    } catch (previewError) {
      setLegacyError(previewError.message || 'Legacy employee preview could not be loaded.');
    } finally {
      setLegacyLoading(false);
    }
  };

  const toggleLegacySelection = (key) => setLegacySelection((current) =>
    current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
  );

  const importLegacySelection = async () => {
    if (!legacySelection.length || legacyImporting) return;
    setLegacyImporting(true);
    setLegacyError('');
    try {
      const result = await importLegacyEmployees(legacySelection);
      await refresh();
      setLegacyEntries((current) => current.map((entry) =>
        legacySelection.includes(entry.key) ? { ...entry, status: 'already-imported' } : entry
      ));
      setLegacySelection([]);
      setDeleteNotice({ type: 'success', message: `${result.imported?.length || 0} selected legacy employee(s) imported. The legacy snapshot was preserved.` });
    } catch (importError) {
      setLegacyError(importError.message || 'Selected employees could not be imported.');
    } finally {
      setLegacyImporting(false);
    }
  };

  const openCatalogLegacyPreview = async () => {
    setShowCatalogLegacy(true);
    setCatalogLegacyLoading(true);
    setCatalogLegacyError('');
    try {
      const entries = await getLegacyDepartmentRolePreview();
      setCatalogLegacyEntries(entries);
      setCatalogLegacySelection([]);
    } catch (previewError) {
      setCatalogLegacyError(previewError.message || 'Legacy department and role catalogs could not be loaded.');
    } finally {
      setCatalogLegacyLoading(false);
    }
  };

  const toggleCatalogLegacySelection = (entry) => {
    const key = `${entry.kind}:${entry.key}`;
    setCatalogLegacySelection((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  };

  const importCatalogLegacySelection = async () => {
    if (!catalogLegacySelection.length || catalogLegacyImporting) return;
    setCatalogLegacyImporting(true);
    setCatalogLegacyError('');
    const selected = catalogLegacyEntries
      .filter((entry) => catalogLegacySelection.includes(`${entry.kind}:${entry.key}`))
      .map(({ kind, key }) => ({ kind, key }));
    try {
      const result = await importSelectedDepartmentRoleCatalog(selected);
      await refreshMasterCatalogs();
      setCatalogLegacyEntries((current) => current.map((entry) =>
        catalogLegacySelection.includes(`${entry.kind}:${entry.key}`) ? { ...entry, status: 'already-imported' } : entry
      ));
      setCatalogLegacySelection([]);
      setDeleteNotice({ type: 'success', message: `${result.imported?.length || 0} selected catalog record(s) imported. The legacy snapshots were preserved.` });
    } catch (importError) {
      setCatalogLegacyError(importError.message || 'Selected catalog records could not be imported.');
    } finally {
      setCatalogLegacyImporting(false);
    }
  };

  const restoreCatalogRecord = async (kind, record) => {
    const reason = window.prompt(`Reason for restoring ${kind} "${record.name}":`)?.trim();
    if (!reason) return;
    try {
      if (kind === 'department') await restoreDepartment(record.id, record.version, reason);
      else await restoreRole(record.id, record.version, reason);
      await refreshMasterCatalogs();
      setDeleteNotice({ type: 'success', message: `${kind === 'department' ? 'Department' : 'Role'} "${record.name}" was restored.` });
    } catch (restoreError) {
      setCatalogError(restoreError.message || `The ${kind} could not be restored.`);
    }
  };

  const activateCatalogRecord = async (kind, record) => {
    const reason = window.prompt(`Reason for activating ${kind} "${record.name}":`)?.trim();
    if (!reason) return;
    try {
      const update = kind === 'department' ? updateDepartment : updateRole;
      await update(record.id, { name: record.name, ...(kind === 'role' ? { roleKey: record.roleKey } : {}), active: true }, record.version, reason);
      await refreshMasterCatalogs();
      setDeleteNotice({ type: 'success', message: `${kind === 'department' ? 'Department' : 'Role'} "${record.name}" was activated.` });
    } catch (activateError) {
      setCatalogError(activateError.message || `The ${kind} could not be activated.`);
    }
  };

  const deactivateBlockedDepartment = async () => {
    if (!deleteConfirmation || deleteConfirmation.kind !== 'department' || deleteRequestLock.current) return;
    deleteRequestLock.current = true;
    setDeleteSaving(true);
    try {
      const { id, name } = deleteConfirmation;
      const record = departmentCatalog.find((item) => item.id === id);
      const reason = window.prompt(`Reason for deactivating department "${name}":`)?.trim();
      if (!reason) { setDeleteError('A deactivation reason is required.'); return; }
      await updateDepartment(id, { name, active: false }, record?.version, reason);
      await refreshMasterCatalogs();
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
      if (masterDialog.kind === 'department') {
        if ([...EMPLOYEE_DEPARTMENTS, ...departmentCatalog.map((item) => item.name)].some((item) => item.toLowerCase() === name.toLowerCase())) return setMasterError('A department with this name already exists.');
        await createDepartment({ name });
        await refreshMasterCatalogs();
      } else {
        const department = masterDialog.department;
        if (roleRecords.some((item) => !item.deletedAt && item.department === department && item.name.toLowerCase() === name.toLowerCase())) return setMasterError('A role with this name already exists in this department.');
        const roleKey = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
        const departmentId = stableDepartmentId(department, departmentCatalog);
        await createRole({ departmentId, department, name, roleKey });
        await refreshMasterCatalogs();
        setForm((prev) => ({ ...prev, departmentAssignments: prev.departmentAssignments.map((item) => item.department === department ? { ...item, role: name, roleKey } : item) }));
      }
      setMasterDialog(null);
    } catch (saveError) {
      setMasterError(saveError.message || 'Catalog changes could not be saved to PostgreSQL.');
    } finally { setMasterSaving(false); }
  };

  const openPermissionEditor = async (department, role) => {
    if (!admin || permissionSaving) return;
    setPermissionError('');
    const roleKey = roleKeyForAssignment(department, role);
    try {
      const departmentId = stableDepartmentId(department, departmentCatalog);
      const roleId = stableRoleId(department, roleKey, roleRecords, departmentCatalog);
      const saved = await getRolePermissions(departmentId, roleId);
      setPermissionSelection(Array.isArray(saved.permissions) ? saved.permissions : (ROLE_PERMISSIONS[roleKey] || []));
      setPermissionDialog({ department, departmentId, role, roleId, roleKey, version: saved.version });
    } catch (loadError) {
      setPermissionSelection([]);
      setPermissionError(loadError.message || 'Role permissions could not be loaded from PostgreSQL.');
      setPermissionDialog({ department, role, roleKey });
    }
  };

  const persistRolePermissions = async () => {
    if (!permissionDialog || permissionSaving) return;
    setPermissionSaving(true);
    setPermissionError('');
    let result;
    try {
      result = await saveRolePermissions({
        departmentId: permissionDialog.departmentId,
        roleId: permissionDialog.roleId,
        permissions: permissionSelection,
        version: permissionDialog.version
      });
    } catch (saveError) {
      setPermissionError(saveError.message || 'Permission changes could not be saved.');
      setPermissionSaving(false);
      return;
    }
    setPermissionSaving(false);
    if (!result.success) { setPermissionError(result.error || 'Permission changes could not be saved.'); return; }
    setPermissionDialog(null);
    setDeleteNotice({ type: 'success', message: `Permissions for ${permissionDialog.department} · ${permissionDialog.role} were saved to PostgreSQL.` });
  };

  const openAdd = () => {
    setEditId(null);
    setEditVersion(null);
    setEditHasPassword(false);
    setForm({
      ...EMPTY_FORM,
      employeeId: nextEmployeeId(employees),
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
    setEditVersion(emp.version);
    setEditHasPassword(Boolean(emp.hasLoginPassword));
    setForm({
      name: emp.name || '',
      email: emp.email || '',
      password: '',
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

    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      return setError('Enter a valid email address or leave it blank.');
    }

    const cleanEmail = form.email.trim().toLowerCase();
    if (cleanEmail && !form.password && !editHasPassword) {
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

    const firstAssignment = form.departmentAssignments[0];
    const { primaryDepartment: _legacyPrimaryDepartment, ...formWithoutLegacyPrimary } = form;
    let departmentCatalog = []; let roleList = [];
    try {
      [departmentCatalog, roleList] = await Promise.all([listDepartments({ includeDeleted: true }), listRoles({ includeDeleted: true })]);
    } catch (catalogError) {
      return setError(catalogError.message || 'Department and role assignments could not be verified.');
    }
    const departmentAssignments = form.departmentAssignments.map((assignment) => {
      const departmentId = stableDepartmentId(assignment.department, departmentCatalog);
      return { ...assignment, departmentId, roleId: stableRoleId(assignment.department, assignment.roleKey, roleList, departmentCatalog) };
    });
    const payload = { ...formWithoutLegacyPrimary, employeeId: form.employeeId.trim().toUpperCase(), email: cleanEmail, department: firstAssignment.department, role: firstAssignment.role, roleKey: firstAssignment.roleKey, departmentAssignments };
    try {
      if (editId) await updateEmployee(editId, payload, editVersion);
      else await createEmployee({ ...payload, active: true });
      await refresh();
      setShowModal(false);
    } catch (saveError) {
      setError(saveError.message || 'Employee changes could not be saved to PostgreSQL.');
    }
  };

  const toggleActive = async (emp) => {
    const deactivating = emp.active !== false;
    let reason = '';
    if (deactivating) {
      if (!window.confirm(`Deactivate ${emp.name}? Their server sessions will be revoked.`)) return;
      reason = window.prompt(`Reason for deactivating ${emp.name}:`)?.trim() || '';
      if (!reason) return;
    }
    try {
      await updateEmployee(emp.id, { active: !deactivating, reason }, emp.version);
      await refresh();
    } catch (statusError) {
      window.alert(statusError.message || 'Employee account status could not be saved to PostgreSQL.');
    }
  };

  const handleRestore = async (emp) => {
    const reason = window.prompt(`Reason for restoring ${emp.name}:`)?.trim();
    if (!reason) return;
    try {
      await restoreEmployee(emp.id, emp.version, reason);
      await refresh();
      setDeleteNotice({ type: 'success', message: `${emp.name} was restored.` });
    } catch (restoreError) {
      setEmployeeError(restoreError.message || 'Employee could not be restored.');
    }
  };

  const handleDelete = (emp) => {
    if (!admin || deleteRequestLock.current || deleteConfirmation || isServerAdminRecord(emp)) return;
    setDeleteError(''); setDeleteBlocked(false); setDeleteCanDeactivate(false); setDeleteNotice(null);
    setDeleteConfirmation({ kind: 'employee', id: emp.id, employeeId: emp.employeeId, version: emp.version, name: emp.name });
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
            <>
              <button type="button" className="button-secondary" onClick={openLegacyPreview}>Review Legacy Records</button>
              <button type="button" className="button-secondary" onClick={openCatalogLegacyPreview}>Review Catalog Legacy</button>
              <button type="button" className="button-primary" onClick={openAdd}>+ Add Employee</button>
            </>
          )}
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Employees</h3>
          <span className="muted-text">{filtered.length} shown / {employees.length} total</span>
        </div>
        {admin && <label className="form-field"><span><input type="checkbox" checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)} /> Include deleted employees</span></label>}
        {deleteNotice && <div className={deleteNotice.type === 'success' ? 'employee-delete-notice success' : 'employee-delete-notice error'} role="status">{deleteNotice.message}</div>}
        {employeeLoading && <div className="muted-text" role="status">Loading employees from PostgreSQL…</div>}
        {employeeError && <div className="form-error" role="alert">{employeeError} <button type="button" className="button-secondary button-small" onClick={() => refresh().catch((error) => setEmployeeError(error.message))}>Retry</button></div>}

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
              {employeeLoading ? (
                <tr><td colSpan={admin ? 7 : 6} className="no-history-row">Loading employees…</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={admin ? 7 : 6} className="no-history-row">{employeeError ? 'Employee data is unavailable.' : 'No employees found.'}</td>
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
                        {emp.deletedAt ? 'Deleted' : emp.active === false ? 'Inactive' : 'Active'}
                      </span>
                    </td>
                    {admin && (
                      <td>
                        <div className="table-actions">
                          {emp.deletedAt
                            ? <button type="button" className="button-secondary button-small" onClick={() => handleRestore(emp)}>Restore</button>
                            : isServerAdminRecord(emp) ? <span className="muted-text">Server managed</span> : <>
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
                {catalogLoading && <div className="muted-text" role="status">Loading department and role catalogs from PostgreSQL…</div>}
                {catalogError && <div className="form-error" role="alert">{catalogError} <button type="button" className="button-secondary button-small" onClick={() => refreshMasterCatalogs().catch(() => {})}>Retry</button></div>}
                {admin && <label className="form-field"><span><input type="checkbox" checked={showDeletedCatalogs} onChange={(event) => setShowDeletedCatalogs(event.target.checked)} /> Include inactive and deleted catalog records</span></label>}
                {deleteNotice && <div className={deleteNotice.type === 'success' ? 'employee-delete-notice success' : 'employee-delete-notice error'} role="status">{deleteNotice.message}</div>}
                <div className="employee-department-editor">
                  {departments.map((department) => {
                    const assignment = form.departmentAssignments.find((item) => item.department === department);
                    const departmentRecord = departmentCatalog.find((item) => item.name === department);
                    return <div className="employee-department-row" key={department}>
                      <label className="employee-department-check"><input type="checkbox" checked={Boolean(assignment)} disabled={!assignment && Boolean(departmentRecord && (departmentRecord.legacy || departmentRecord.active === false || departmentRecord.deletedAt))} title={!assignment && departmentRecord?.legacy ? 'Import this legacy department before assigning it' : !assignment && (departmentRecord?.active === false || departmentRecord?.deletedAt) ? 'Activate or restore this department before assigning it' : ''} onChange={() => toggleDepartment(department)} /> {department}</label>
                      {assignment && <div className="employee-role-controls">
                        <select className="action-select" aria-label={`${department} role`} value={assignment.role} onChange={(event) => setAssignmentRole(department, event.target.value)}>
                          {!assignment.role && <option value="">Select role</option>}
                          {rolesFor(department).map((role) => <option key={role} value={role}>{role}</option>)}
                        </select>
                        {admin && <button type="button" className="button-secondary button-small" disabled={catalogLoading || Boolean(departmentRecord?.legacy || departmentRecord?.active === false || departmentRecord?.deletedAt)} title={departmentRecord?.legacy ? 'Import this legacy department before adding roles' : departmentRecord?.active === false || departmentRecord?.deletedAt ? 'Activate or restore this department before adding roles' : ''} onClick={() => openMasterDialog('role', department)}>+ Add Role</button>}
                        {admin && assignment.role && <button type="button" className="button-secondary button-small" onClick={() => openPermissionEditor(department, assignment.role)}>Permissions</button>}
                        {admin && (roleCatalog[department] || []).some((item) => item.name === assignment.role && !item.legacy && item.active !== false && !item.deletedAt) && <button type="button" className="employee-delete-icon" aria-label={`Delete ${assignment.role} role`} title="Delete Role" disabled={deleteSaving || Boolean(deleteConfirmation)} onClick={() => requestRoleDeletion(department, assignment.role)}>&times;</button>}
                      </div>}
                      {admin && !EMPLOYEE_DEPARTMENTS.includes(department) && <button type="button" className="employee-delete-icon employee-delete-department" aria-label={`Delete ${department} department`} title={departmentRecord?.legacy ? 'Import this legacy department before managing it' : 'Delete Department'} disabled={deleteSaving || Boolean(deleteConfirmation) || Boolean(departmentRecord?.legacy)} onClick={() => requestDepartmentDeletion(department)}>&times;</button>}
                    </div>;
                  })}
                </div>
                {showDeletedCatalogs && <div className="employee-department-editor" aria-label="Inactive and deleted catalog records">
                  {departmentCatalog.filter((item) => item.active === false || item.deletedAt).map((item) => <div className="employee-department-row" key={`deleted-department-${item.id}`}>
                    <span>{item.name} <small>{item.deletedAt ? 'Deleted' : 'Inactive'}{item.legacy ? ' · Legacy (read-only)' : ''}</small></span>
                    {!item.legacy && (item.deletedAt
                      ? <button type="button" className="button-secondary button-small" onClick={() => restoreCatalogRecord('department', item)}>Restore</button>
                      : <button type="button" className="button-secondary button-small" onClick={() => activateCatalogRecord('department', item)}>Activate</button>)}
                  </div>)}
                  {roleRecords.filter((item) => item.active === false || item.deletedAt).map((item) => <div className="employee-department-row" key={`deleted-role-${item.id}`}>
                    <span>{item.department} · {item.name} <small>{item.deletedAt ? 'Deleted' : 'Inactive'}{item.legacy ? ' · Legacy (read-only)' : ''}</small></span>
                    {!item.legacy && (item.deletedAt
                      ? <button type="button" className="button-secondary button-small" onClick={() => restoreCatalogRecord('role', item)}>Restore</button>
                      : <button type="button" className="button-secondary button-small" onClick={() => activateCatalogRecord('role', item)}>Activate</button>)}
                  </div>)}
                  {!departmentCatalog.some((item) => item.active === false || item.deletedAt) && !roleRecords.some((item) => item.active === false || item.deletedAt) && <span className="muted-text">No inactive or deleted catalog records.</span>}
                </div>}
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
                    placeholder={editId ? 'Leave blank to keep the current password' : 'Min 8 chars, A-Z, a-z, 0-9, special char'}
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
                <span className="muted-text">{editId ? 'Passwords are never shown. Leave blank to retain the current password.' : 'Used to log into the ERP via the Employee Portal.'}</span>
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
          <div className="template-modal-actions"><button type="button" className="button-secondary" disabled={permissionSaving} onClick={() => setPermissionDialog(null)}>Cancel</button><button type="button" className="button-primary" disabled={permissionSaving || !permissionDialog.departmentId || !permissionDialog.roleId} onClick={persistRolePermissions}>{permissionSaving ? 'Saving…' : 'Save Permissions'}</button></div>
        </div>
      </div>}
      {showLegacy && <div className="template-modal-backdrop employee-master-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !legacyImporting) setShowLegacy(false); }}>
        <div className="template-modal employee-master-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-legacy-title">
          <div className="template-modal-header"><h3 id="employee-legacy-title">Legacy Employee Preview</h3><button type="button" className="template-modal-close" disabled={legacyImporting} onClick={() => setShowLegacy(false)} aria-label="Close">&times;</button></div>
          <p>Review the preserved PostgreSQL legacy snapshot. Only selected records are imported; nothing is changed automatically.</p>
          {legacyLoading ? <div className="muted-text" role="status">Loading legacy records…</div> : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead><tr><th>Select</th><th>Employee ID</th><th>Name</th><th>Email</th><th>Department / Role</th><th>Status</th></tr></thead>
                <tbody>
                  {legacyEntries.length ? legacyEntries.map((entry) => (
                    <tr key={entry.key}>
                      <td><input type="checkbox" aria-label={`Select ${entry.employee.name}`} checked={legacySelection.includes(entry.key)} disabled={entry.status !== 'eligible' || legacyImporting} onChange={() => toggleLegacySelection(entry.key)} /></td>
                      <td>{entry.employee.employeeId || entry.key}</td>
                      <td>{entry.employee.name || '—'}</td>
                      <td>{entry.employee.email || '—'}</td>
                      <td>{entry.employee.department || '—'} / {entry.employee.role || entry.employee.roleKey || '—'}</td>
                      <td>{entry.status === 'eligible' ? 'Available to import' : 'Already imported'}</td>
                    </tr>
                  )) : <tr><td colSpan="6" className="no-history-row">No legacy employee records were found.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {legacyError && <div className="form-error" role="alert">{legacyError}</div>}
          <div className="template-modal-actions">
            <button type="button" className="button-secondary" disabled={legacyImporting} onClick={() => setShowLegacy(false)}>Close</button>
            <button type="button" className="button-primary" disabled={legacyImporting || legacySelection.length === 0} onClick={importLegacySelection}>{legacyImporting ? 'Importing…' : `Import Selected (${legacySelection.length})`}</button>
          </div>
        </div>
      </div>}
      {showCatalogLegacy && <div className="template-modal-backdrop employee-master-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !catalogLegacyImporting) setShowCatalogLegacy(false); }}>
        <div className="template-modal employee-master-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-legacy-title">
          <div className="template-modal-header"><h3 id="catalog-legacy-title">Legacy Department and Role Catalog Preview</h3><button type="button" className="template-modal-close" disabled={catalogLegacyImporting} onClick={() => setShowCatalogLegacy(false)} aria-label="Close">&times;</button></div>
          <p>Preserved PostgreSQL snapshots are read-only. Only explicitly selected records are imported; nothing is changed automatically.</p>
          {catalogLegacyLoading ? <div className="muted-text" role="status">Loading legacy catalog records…</div> : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead><tr><th>Select</th><th>Kind</th><th>Identifier</th><th>Details</th><th>Status</th></tr></thead>
                <tbody>
                  {catalogLegacyEntries.length ? catalogLegacyEntries.map((entry) => (
                    <tr key={`${entry.kind}:${entry.key}`}>
                      <td><input type="checkbox" aria-label={`Select legacy ${entry.kind} ${entry.key}`} checked={catalogLegacySelection.includes(`${entry.kind}:${entry.key}`)} disabled={entry.status !== 'eligible' || catalogLegacyImporting} onChange={() => toggleCatalogLegacySelection(entry)} /></td>
                      <td>{entry.kind}</td>
                      <td>{entry.key}</td>
                      <td>{entry.kind === 'permission'
                        ? `${entry.record.department || entry.record.departmentId} · ${entry.record.roleKey || entry.record.roleId}`
                        : `${entry.record.department ? `${entry.record.department} · ` : ''}${entry.record.name || 'Unnamed'}`}</td>
                      <td>{entry.status === 'eligible' ? 'Available to import' : entry.status === 'already-imported' ? 'Already imported' : 'Conflict; review before import'}</td>
                    </tr>
                  )) : <tr><td colSpan="5" className="no-history-row">No legacy department, role, or permission records were found.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {catalogLegacyError && <div className="form-error" role="alert">{catalogLegacyError}</div>}
          <div className="template-modal-actions">
            <button type="button" className="button-secondary" disabled={catalogLegacyImporting} onClick={() => setShowCatalogLegacy(false)}>Close</button>
            <button type="button" className="button-primary" disabled={catalogLegacyImporting || catalogLegacySelection.length === 0} onClick={importCatalogLegacySelection}>{catalogLegacyImporting ? 'Importing…' : `Import Selected (${catalogLegacySelection.length})`}</button>
          </div>
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
