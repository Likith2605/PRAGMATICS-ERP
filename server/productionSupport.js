// Shared server helpers for Production, BOM and Routing routers. These are
// deliberately small and side-effect free: routers own their own transactions.

import { safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';

export const bad = (message) => Object.assign(new Error(message), { status: 400 });
export const forbidden = (message) => Object.assign(new Error(message), { status: 403 });
export const notFound = (message) => Object.assign(new Error(message), { status: 404 });
export const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });

export const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';

/** Server-side permission gate. Admin always passes; role overrides are honoured. */
export const requirePermissions = (req, ...permissions) => {
  if (isAdmin(req)) return;
  const required = permissions.flat().filter(Boolean);
  if (!required.length) return;
  if (!hasPermissionForRole(req.user?.roleKey, required, req.user?.rolePermissions)) {
    throw forbidden('Your selected department role does not allow this operation.');
  }
};

export const text = (value, fallback = '') => String(value ?? '').trim() || fallback;
export const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
export const dateOnly = (value, fallback = '') => {
  const raw = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
};

export const idempotencyToken = (value) => {
  const token = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(token)) throw bad('A valid idempotency token is required.');
  return token;
};

export const readVersion = (value) => {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw bad('The PostgreSQL version last read is required.');
  return version;
};

export const assertVersion = (row, version, label) => {
  if (Number(row.version) !== version) throw conflict(`${label} changed on the server. Reload before continuing.`);
};

export const payloadSize = (value) => {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? {}));
  if (bytes > 5 * 1024 * 1024) throw Object.assign(new Error('Record exceeds the 5 MB size limit.'), { status: 413 });
  return bytes;
};

export const actor = (req) => ({
  id: String(req.user?.id || ''),
  email: String(req.user?.email || ''),
  role: String(req.user?.role || '')
});

/** Writes the module-owned audit table and the global ERP audit log together. */
export const writeAudit = async (
  client,
  req,
  { table, idColumn, id, action, before = null, after = null, reason = '', module = '', global = true }
) => {
  const user = actor(req);
  const safeBefore = before == null ? null : JSON.stringify(safeAuditValues(before));
  const safeAfter = after == null ? null : JSON.stringify(safeAuditValues(after));
  if (table !== 'erp_audit_log') {
    await client.query(
      `INSERT INTO ${table}(${idColumn},action,actor_id,actor_email,actor_role,reason,before_values,after_values)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [id, action, user.id || null, user.email || null, user.role || null, String(reason || '').slice(0, 1000), safeBefore, safeAfter]
    );
  }
  if (!global) return;
  await client.query(
    `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [user.id || '', user.email || '', user.role || '', module || table, String(id), String(id), action,
      String(reason || '').slice(0, 1000), safeBefore, safeAfter]
  );
};

/** Document-number reservation: never reuses a suffix, even after soft delete. */
export const nextNumber = async (client, { prefix, table, column, sequenceKey, pad = 6 }) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`production-number:${sequenceKey}`]);
  const sequence = await client.query(
    'SELECT last_number FROM production_sequences WHERE sequence_key=$1 FOR UPDATE', [sequenceKey]
  );
  const stored = Number(sequence.rows[0]?.last_number || 0);
  const rows = await client.query(`SELECT ${column} AS value FROM ${table} WHERE ${column} LIKE $1`, [`${prefix}%`]);
  let highest = stored;
  for (const row of rows.rows) {
    const match = String(row.value || '').match(/(\d+)\s*$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  const next = highest + 1;
  await client.query(
    `INSERT INTO production_sequences(sequence_key,last_number) VALUES($1,$2)
     ON CONFLICT (sequence_key) DO UPDATE SET last_number=GREATEST(production_sequences.last_number, EXCLUDED.last_number), updated_at=now()`,
    [sequenceKey, next]
  );
  return `${prefix}${String(next).padStart(pad, '0')}`;
};

/** Preserves the legacy JC-YYMMDD-NNN document numbering. */
export const jobCardNumber = async (client) => {
  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const number = `JC-${stamp}-${Math.floor(100 + Math.random() * 900)}`;
    const exists = await client.query('SELECT 1 FROM job_cards WHERE job_card_number=$1', [number]);
    if (!exists.rowCount) return number;
  }
  throw bad('Unable to allocate a unique Job Card number.');
};

/** Preserves the legacy BOM-<epoch millis> document numbering. */
export const bomNumber = async (client) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const number = `BOM-${Date.now()}`;
    const exists = await client.query('SELECT 1 FROM bom_headers WHERE bom_number=$1', [number]);
    if (!exists.rowCount) return number;
  }
  throw bad('Unable to allocate a unique BOM number.');
};

export const legacyRows = async (pool, storageKey) => {
  const result = await pool.query('SELECT data FROM erp_state WHERE storage_key=$1', [storageKey]);
  return Array.isArray(result.rows[0]?.data) ? result.rows[0].data : [];
};

export const auditRows = async (client, table, idColumn, id, limit = 200) => {
  const result = await client.query(
    `SELECT id,action,actor_id,actor_email,actor_role,reason,before_values,after_values,created_at
     FROM ${table} WHERE ${idColumn}=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
    [id, Math.min(Math.max(Number(limit) || 200, 1), 1000)]
  );
  return result.rows;
};

/** Legacy-shaped audit entry appended inside the JSON payload. */
export const historyEntry = (req, action, details = '') => ({
  action,
  details,
  user: String(req.user?.email || req.user?.username || ''),
  employeeId: String(req.user?.employeeId || ''),
  department: String(req.user?.department || ''),
  at: new Date().toISOString()
});
