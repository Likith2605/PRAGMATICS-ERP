import { useState } from 'react';
import { DEPARTMENTS, ROLES_BY_DEPARTMENT, roleKeyForRole, isAdmin, getCurrentUserInfo } from '../utils/permissions.js';
import { getEmployees, saveEmployees, generateEmployeeId } from '../utils/storeService.js';

const EMPTY_FORM = {
  name: '',
  email: '',
  password: '',
  mobile: '',
  department: 'Production Department',
  designation: '',
  roleKey: 'production_employee',
  role: 'Production Employee',
  joinedDate: ''
};

const EmployeeMasterPage = () => {
  const [employees, setEmployees] = useState(getEmployees);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const admin = isAdmin();

  const refresh = () => setEmployees(getEmployees());

  const rolesFor = (dept) => ROLES_BY_DEPARTMENT[dept] || [];
  const defaultRoleFor = (dept) => rolesFor(dept)[1] || rolesFor(dept)[0] || '';

  const setDepartment = (dept) => {
    const role = defaultRoleFor(dept);
    setForm((prev) => ({
      ...prev,
      department: dept,
      role,
      roleKey: roleKeyForRole(dept, role)
    }));
  };

  const setRole = (role) =>
    setForm((prev) => ({ ...prev, role, roleKey: roleKeyForRole(prev.department, role) }));

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
    const dept = emp.department || 'Production Department';
    const role = rolesFor(dept).includes(emp.role) ? emp.role : defaultRoleFor(dept);
    setEditId(emp.id);
    setForm({
      name: emp.name || '',
      email: emp.email || '',
      password: emp.password || '',
      mobile: emp.mobile || '',
      department: dept,
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

  const handleSave = () => {
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

    let next;
    const roleKey = roleKeyForRole(form.department, form.role);
    const payload = { ...form, department: form.department, role: form.role, roleKey };
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
    saveEmployees(next);
    refresh();
    setShowModal(false);
  };

  const toggleActive = (emp) => {
    const next = getEmployees().map((e) => (e.id === emp.id ? { ...e, active: !e.active } : e));
    saveEmployees(next);
    refresh();
  };

  const handleDelete = (emp) => {
    const info = getCurrentUserInfo();
    const myEmail = (info.auth?.email || '').toLowerCase();
    const myEmpId = info.employee?.employeeId || '';

    // Guard 1: never let the signed-in user delete their own record —
    // they would be logged out immediately with no way back in.
    const isSelf =
      (emp.email && myEmail && emp.email.trim().toLowerCase() === myEmail) ||
      (emp.employeeId && myEmpId && emp.employeeId.trim().toUpperCase() === myEmpId.trim().toUpperCase());
    if (isSelf) {
      window.alert(
        `You cannot delete your own account (${emp.employeeId} — ${emp.name}). You would lose access immediately and could not log back in.\n\nAsk another Administrator to delete it if the account must be removed.`
      );
      return;
    }

    // Guard 2: never delete the last active Administrator —
    // otherwise nobody can administer the ERP again.
    const isAdminEmp = (e) =>
      e.roleKey === 'administrator' || (e.role || '').toLowerCase() === 'administrator';
    const list = getEmployees();
    const activeAdmins = list.filter((e) => e.active !== false && isAdminEmp(e));
    if (isAdminEmp(emp) && activeAdmins.length <= 1) {
      window.alert(
        `"${emp.name}" is the only active Administrator account. It cannot be deleted — deactivate another admin instead, or create a new Administrator first.`
      );
      return;
    }

    const warn = isAdminEmp(emp)
      ? `Delete Administrator "${emp.name}" (${emp.employeeId})${emp.email ? ` — login ${emp.email}` : ''}?\n\nThey will lose ERP access immediately. Existing records keep their saved copy of this employee. This cannot be undone.`
      : `Delete employee "${emp.name}" (${emp.employeeId})${emp.email ? ` — login ${emp.email}` : ''}?\n\nThey will lose ERP access immediately. Existing records (issues, requests, audit logs) keep their saved copy. This cannot be undone.`;
    if (!window.confirm(warn)) return;

    saveEmployees(getEmployees().filter((e) => e.id !== emp.id));
    refresh();
  };

  const filtered = employees.filter((e) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return [e.name, e.employeeId, e.department, e.role, e.designation, e.mobile, e.email].join(' ').toLowerCase().includes(q);
  });

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Human Resources</div>
          <h1 className="page-title">Employee Master</h1>
          <p className="page-description">
            Master list of employees. Give each staff member a Login ID (email) and Login Password so they can sign in through the Employee Portal.
          </p>
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
          placeholder="Search by name, ID, department..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Department</th>
                <th>Role</th>
                <th>Designation</th>
                <th>Email / Login ID</th>
                <th>Mobile</th>
                <th>Login</th>
                <th>Status</th>
                {admin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={admin ? 12 : 11} className="no-history-row">No employees found.</td>
                </tr>
              ) : (
                filtered.map((emp) => (
                  <tr key={emp.id}>
                    <td><strong>{emp.employeeId}</strong></td>
                    <td>{emp.name}</td>
                    <td>{emp.department}</td>
                    <td>{emp.role || emp.designation || '—'}</td>
                    <td>{emp.designation || '—'}</td>
                    <td>{emp.email || '—'}</td>
                    <td>{emp.mobile || '—'}</td>
                    <td>
                      {emp.email && emp.password ? (
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
                          <button type="button" className="button-secondary button-small" onClick={() => openEdit(emp)}>Edit</button>
                          <button type="button" className="button-secondary button-small" onClick={() => toggleActive(emp)}>
                            {emp.active === false ? 'Activate' : 'Deactivate'}
                          </button>
                          <button
                            type="button"
                            className="button-secondary button-small"
                            style={{ color: '#dc2626', borderColor: '#fecaca' }}
                            onClick={() => handleDelete(emp)}
                            title={`Delete ${emp.name} from Employee Master`}
                          >
                            Delete
                          </button>
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
          <div className="template-modal" onClick={(e) => e.stopPropagation()}>
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
              <div className="form-field">
                <label>Department</label>
                <select className="action-select" value={form.department} onChange={(e) => setDepartment(e.target.value)}>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>Role *</label>
                <select className="action-select" value={form.role} onChange={(e) => setRole(e.target.value)}>
                  {rolesFor(form.department).map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
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
    </section>
  );
};

export default EmployeeMasterPage;