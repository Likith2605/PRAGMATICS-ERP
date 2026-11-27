import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { getPool } from './database.js';
import { assignmentForDepartment, normalizeDepartment, normalizeEmployeeAssignments, hasPermissionForRole } from './departmentAccess.js';
import { stableDepartmentId, stableRoleId, permissionAssignmentKey } from '../shared/roleIdentity.js';
import { findEmployeeForAuthentication, employeeDirectoryReferences } from './employeeStore.js';
import { verifyEmployeePassword } from './employeeCredentials.js';
import { readDepartmentRoleCatalogs, resolveRolePermission } from './departmentRoleCatalogStore.js';

const TOKEN_TTL_HOURS = Number(process.env.ERP_SESSION_TTL_HOURS || 12);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const constantTimeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};
const publicUser = (row) => ({
  id: row.user_id,
  email: row.email,
  username: row.display_name,
  name: row.display_name,
  role: row.role,
  roleKey: row.role_key,
  department: row.department,
  employeeId: row.employee_id,
  isLoggedIn: true
});
export const safeAuditValues = (value) => {
  if (Array.isArray(value)) return value.map(safeAuditValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|secret|credential/i.test(key)).map(([key, child]) => [key, safeAuditValues(child)]));
};

export const authRouter = express.Router();

const roleStateFor = async (employee, department = '') => {
  const { departments: departmentCatalog, roles: roleCatalog, permissions: permissionCatalog } = await readDepartmentRoleCatalogs();
  const assignments = normalizeEmployeeAssignments(employee).map((assignment) => {
    const departmentId = stableDepartmentId(assignment.department, departmentCatalog);
    const roleId = stableRoleId(assignment.department, assignment.roleKey, roleCatalog, departmentCatalog);
    const scoped = resolveRolePermission({ permissions: permissionCatalog }, departmentId, roleId);
    return { ...assignment, departmentId, roleId, ...(scoped ? { permissions: scoped.permissions } : {}) };
  });
  return { assignments, assignment: assignmentForDepartment(assignments, department || assignments[0]?.department) };
};

const loginUser = async (employee, department = '') => {
  const { assignments, assignment } = await roleStateFor(employee, department);
  return {
    assignments,
    activeDepartment: assignment?.department || '',
    role: assignment?.role || employee.role || employee.designation || 'Staff / Employee',
    roleKey: assignment?.roleKey || 'employee',
    department: assignment?.department || '',
    employeeId: employee.employeeId || ''
  };
};

authRouter.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const portal = String(req.body?.portal || 'employee');
  if (portal === 'admin' && (!process.env.ERP_ADMIN_EMAIL || !process.env.ERP_ADMIN_PASSWORD)) {
    return res.status(503).json({ error: 'Administrator sign-in is not configured on the ERP server. Set ERP_ADMIN_EMAIL and ERP_ADMIN_PASSWORD in the server environment.' });
  }
  const isAdmin = email === String(process.env.ERP_ADMIN_EMAIL || '').trim().toLowerCase() &&
    constantTimeEqual(password, process.env.ERP_ADMIN_PASSWORD);
  let user;
  if (isAdmin && process.env.ERP_ADMIN_EMAIL && process.env.ERP_ADMIN_PASSWORD) {
    user = { id: 'admin', email, username: process.env.ERP_ADMIN_NAME || 'Administrator', role: 'Administrator', roleKey: 'admin', department: 'Admin', activeDepartment: 'Admin', assignments: [{ department: 'Admin', role: 'Administrator', roleKey: 'admin' }], employeeId: '-' };
  } else if (portal !== 'admin') {
    const account = await findEmployeeForAuthentication({ email });
    const employee = account?.employee;
    if (employee && !account.deleted && employee.active !== false &&
      !['admin','administrator'].includes(String(employee.roleKey || '').toLowerCase()) &&
      String(employee.role || '').toLowerCase() !== 'administrator' &&
      String(employee.email || '').trim().toLowerCase() === email &&
      await verifyEmployeePassword(password, account.passwordHash ?? account.password)) {
      const access = await loginUser(employee);
      if (!access.assignments.length) return res.status(403).json({ error: 'No active department assignment is configured for this employee.' });
      user = { id: String(employee.id || employee.employeeId || email), email, username: employee.name || employee.employeeId || email, ...access };
    }
  }
  if (!user) return res.status(401).json({ error: 'Invalid login ID or password.' });

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);
  await getPool().query(
    `INSERT INTO erp_sessions (token_hash,user_id,email,display_name,role,role_key,department,employee_id,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [hashToken(token), user.id, user.email, user.username, user.role, user.roleKey, user.department, user.employeeId, expiresAt]
  );
  res.json({ token, expiresAt: expiresAt.toISOString(), user: { ...user, isLoggedIn: true } });
});

export const authenticateRequest = async (req, res, next) => {
  try {
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in is required.' });
    const result = await getPool().query(
      `SELECT user_id,email,display_name,role,role_key,department,employee_id
       FROM erp_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,
      [hashToken(token)]
    );
    if (!result.rowCount) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    const session = result.rows[0];
    req.user = publicUser(session);
    if (String(session.user_id) !== 'admin') {
      const account = await findEmployeeForAuthentication({ userId: session.user_id, email: session.email });
      const employee = account?.employee;
      if (!employee || account.deleted || employee.active === false ||
          String(employee.email || '').toLowerCase() !== String(session.email).toLowerCase()) {
        return res.status(401).json({ error: 'Employee account is inactive or no longer available. Sign in again or contact an administrator.' });
      }
      const { assignments } = await roleStateFor(employee, session.department);
      const requestedDepartment = normalizeDepartment(req.get('x-erp-department') || session.department || assignments[0]?.department);
      const assignment = assignmentForDepartment(assignments, requestedDepartment);
      if (!assignment) return res.status(403).json({ error: 'The selected department is not assigned to this employee.' });
      req.user = {
        ...req.user,
        role: assignment.role,
        roleKey: assignment.roleKey,
        departmentId: assignment.departmentId,
        roleId: assignment.roleId,
        rolePermissions: assignment.permissions,
        department: assignment.department,
        activeDepartment: assignment.department,
        assignments,
        employeeId: employee.employeeId || ''
      };
    } else {
      req.user.assignments = [{ department: 'Admin', role: 'Administrator', roleKey: 'admin' }];
      req.user.activeDepartment = 'Admin';
    }
    next();
  } catch (error) { next(error); }
};

export const requireAdmin = (req, res, next) => {
  if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
  return res.status(403).json({ error: 'Administrator access is required.' });
};

export const requireDepartmentPermission = (...permissions) => (req, res, next) => {
  if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
  const candidates = permissions.flat();
  const required = ['GET', 'HEAD'].includes(req.method) ? candidates.slice(0, 1) : candidates.slice(-1);
  if (req.user?.department && hasPermissionForRole(req.user.roleKey, required, req.user.rolePermissions)) return next();
  return res.status(403).json({ error: 'Your selected department role does not allow this operation.' });
};

export const auditSensitiveAction = async (req, { module, recordId, recordLabel = '', action, reason = '', before = null, after = null }) => {
  const user = req.user;
  if (!user) throw new Error('Cannot audit a sensitive action without an authenticated user.');
  await getPool().query(
    `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [user.id, user.email, user.role, module, String(recordId), recordLabel, action, reason,
      before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
  );
};

authRouter.get('/me', authenticateRequest, (req, res) => res.json({ user: req.user }));

/**
 * Non-sensitive aggregate for dashboard display. It reads the authoritative
 * PostgreSQL employee catalog without exposing employee records to roles that
 * are not permitted to view the directory.
 */
authRouter.get('/employee-count', authenticateRequest, async (req, res) => {
    if (req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator' &&
        !hasPermissionForRole(req.user?.roleKey, ['employee.view', '*'], req.user?.rolePermissions)) {
        return res.status(403).json({ error: 'Your selected department role does not allow employee data.' });
    }
    const employees = await employeeDirectoryReferences();
    res.json({ count: employees.length });
});

authRouter.get('/audit', authenticateRequest, requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
  const result = await getPool().query(
    `SELECT a.id,a.user_id,a.email,a.role,a.module,a.record_id,a.record_label,a.action,a.reason,a.before_values,a.after_values,a.created_at,
            COALESCE(actor.display_name,a.email) AS actor_name, actor.employee_id AS actor_employee_id
     FROM erp_audit_log a
     LEFT JOIN LATERAL (
       SELECT s.display_name,s.employee_id FROM erp_sessions s
       WHERE (s.user_id=a.user_id OR lower(s.email)=lower(a.email)) AND s.created_at<=a.created_at
       ORDER BY s.created_at DESC LIMIT 1
     ) actor ON true
     ORDER BY a.created_at DESC LIMIT $1`, [limit]
  );
  res.json({ entries: result.rows });
});
authRouter.post('/logout', async (req, res) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'A session token is required to sign out.' });
  await getPool().query('UPDATE erp_sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(token)]);
  res.json({ success: true });
});
