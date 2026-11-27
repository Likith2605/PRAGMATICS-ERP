import { getPool } from './database.js';

const stripSensitiveValues = (value) => {
  if (Array.isArray(value)) return value.map(stripSensitiveValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|token|secret|credential/i.test(key))
    .map(([key, child]) => [key, stripSensitiveValues(child)]));
};

const withoutCredentials = (employee) => {
  const { password, password_hash, passwordHash, ...safe } = employee || {};
  return stripSensitiveValues(safe);
};

export const employeeRecordFromRow = (row) => ({
  ...(row.payload && typeof row.payload === 'object' ? row.payload : {}),
  id: row.id,
  employeeId: row.employee_id,
  name: row.name,
  email: row.email,
  active: row.active,
  department: row.department,
  role: row.role,
  roleKey: row.role_key,
  mobile: row.mobile,
  designation: row.designation,
  joinedDate: row.joined_date,
  departmentAssignments: Array.isArray(row.department_assignments) ? row.department_assignments : [],
  version: Number(row.version),
  createdAt: row.created_at?.toISOString?.() || row.created_at,
  updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  deletedAt: row.deleted_at?.toISOString?.() || row.deleted_at || null,
  deletedBy: row.deleted_by || null,
  deleteReason: row.delete_reason || '',
  hasLoginPassword: Boolean(row.password_hash)
});

export const getLegacyEmployeeRecords = async (executor = getPool()) => {
  const result = await executor.query("SELECT data FROM erp_state WHERE storage_key='employees'");
  return Array.isArray(result.rows[0]?.data) ? result.rows[0].data : [];
};

const sameIdentity = (left, right) => {
  const leftIds = [left.id, left.employeeId, left.email].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  const rightIds = [right.id, right.employeeId, right.email].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  return leftIds.some((value) => rightIds.includes(value));
};

export const getEmployeeRecordsForMasterReferences = async (executor = getPool(), { includeDeleted = false } = {}) => {
  const result = await executor.query(
    'SELECT * FROM employees ORDER BY lower(name), lower(employee_id)'
  );
  const allCurrent = result.rows.map(employeeRecordFromRow);
  const current = includeDeleted ? allCurrent : allCurrent.filter((employee) => employee.deletedAt == null);
  const legacy = await getLegacyEmployeeRecords(executor);
  for (const employee of legacy) {
    if (!employee || typeof employee !== 'object' || allCurrent.some((record) => sameIdentity(record, employee))) continue;
    current.push(withoutCredentials(employee));
  }
  return current;
};

export const getEmployeeRecordsForAssignmentChecks = async (executor = getPool()) => {
  const records = await getEmployeeRecordsForMasterReferences(executor, { includeDeleted: false });
  return records.filter((employee) => employee?.deletedAt == null);
};

export const findEmployeeForAuthentication = async ({ userId, email }, executor = getPool()) => {
  const result = await executor.query(
    `SELECT * FROM employees
     WHERE id=$1 OR lower(employee_id)=lower($1) OR lower(email)=lower($2)
     ORDER BY CASE WHEN lower(email)=lower($2) THEN 0 ELSE 1 END
     LIMIT 1`,
    [String(userId || ''), String(email || '').toLowerCase()]
  );
  if (result.rowCount) {
    const row = result.rows[0];
    return {
      source: 'postgresql',
      employee: employeeRecordFromRow(row),
      passwordHash: row.password_hash,
      deleted: Boolean(row.deleted_at)
    };
  }

  const legacy = await getLegacyEmployeeRecords(executor);
  const employee = legacy.find((record) =>
    String(record?.id || record?.employeeId || '').toLowerCase() === String(userId || '').toLowerCase() &&
    String(record?.email || '').toLowerCase() === String(email || '').toLowerCase()
  );
  return employee ? { source: 'legacy', employee, password: employee.password, deleted: false } : null;
};

export const employeeDirectoryReferences = async (executor = getPool()) => {
  const records = await getEmployeeRecordsForMasterReferences(executor);
  return records
    .filter((employee) => employee.active !== false && employee.deletedAt == null)
    .map(withoutCredentials);
};

export const publicEmployee = (employee) => withoutCredentials(employee);
