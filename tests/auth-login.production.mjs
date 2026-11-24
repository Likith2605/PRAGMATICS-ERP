import 'dotenv/config';
import assert from 'node:assert/strict';
import { getPool, closeDatabase } from '../server/database.js';

const base = String(process.argv[2] || '').replace(/\/$/, '');
if (!base) throw new Error('Pass the ERP production API base URL, for example http://192.168.10.1:3001/api');

const request = async (path, { token, department, ...options } = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(department ? { 'x-erp-department': department } : {}),
      ...(options.headers || {})
    }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

const closeSession = async (token) => {
  if (!token) return;
  const logout = await request('/auth/logout', { method: 'POST', token });
  assert.equal(logout.status, 200, 'production logout revokes the session');
  assert.equal((await request('/auth/me', { token })).status, 401, 'production rejects the revoked session');
};

let adminToken = '';
let employeeToken = '';
try {
  assert.ok(process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD, 'existing Admin credentials are configured');
  const adminLogin = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(adminLogin.status, 200, `production accepts the existing Admin login (${adminLogin.status})`);
  assert.equal(adminLogin.data.user?.roleKey, 'admin');
  adminToken = adminLogin.data.token;
  assert.equal((await request('/auth/me', { token: adminToken, department: 'Admin' })).status, 200);
  await closeSession(adminToken);
  adminToken = '';

  const storedEmployees = await getPool().query("SELECT data FROM erp_state WHERE storage_key='employees'");
  const employee = (storedEmployees.rows[0]?.data || []).find((item) => item?.active !== false && item?.email && item?.password && !['admin','administrator'].includes(String(item.roleKey || '').toLowerCase()) && String(item.role || '').toLowerCase() !== 'administrator');
  assert.ok(employee, 'an existing active employee login is available');
  const employeeLogin = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: employee.email, password: employee.password, portal: 'employee' }) });
  assert.equal(employeeLogin.status, 200, `production accepts an existing Employee login (${employeeLogin.status})`);
  assert.notEqual(employeeLogin.data.user?.roleKey, 'admin');
  employeeToken = employeeLogin.data.token;
  const assignments = employeeLogin.data.user.assignments || [];
  const roleProbe = await request('/auth/me', { token: employeeToken, department: employeeLogin.data.user.department || 'Sales Department' });
  const unassignedProbe = await request('/auth/me', { token: employeeToken, department: 'Store Department' });
  const employeeListProbe = await request('/state/employees', { token: employeeToken, department: employeeLogin.data.user.department || 'Sales Department' });
  console.log(JSON.stringify({ productionEmployeeRole: employeeLogin.data.user.roleKey || null, assignmentCount: assignments.length, meStatus: roleProbe.status, unassignedDepartmentStatus: unassignedProbe.status, employeeStateStatus: employeeListProbe.status }));
  assert.ok(assignments.length > 0);
  const initialDepartment = assignments[0].department;
  assert.equal(employeeLogin.data.user.activeDepartment, initialDepartment);
  assert.equal((await request('/auth/me', { token: employeeToken, department: initialDepartment })).status, 200);
  const unassigned = ['Sales Department','Purchase Department','Production Department','Store Department'].find((department) => !assignments.some((item) => item.department === department));
  if (unassigned) assert.equal((await request('/auth/me', { token: employeeToken, department: unassigned })).status, 403);
  for (const assignment of assignments) {
    const switched = await request('/auth/me', { token: employeeToken, department: assignment.department });
    assert.equal(switched.status, 200, `the existing session selects ${assignment.department}`);
    assert.equal(switched.data.user?.roleKey, assignment.roleKey);
  }
  await closeSession(employeeToken);
  employeeToken = '';
  console.log(JSON.stringify({ productionAdminLogin: 'passed', productionEmployeeLogin: 'passed', departmentAssignments: assignments.length, departmentValidation: 'passed', sessionLogout: 'passed' }));
} finally {
  await closeSession(employeeToken).catch(() => {});
  await closeSession(adminToken).catch(() => {});
  await closeDatabase();
}
