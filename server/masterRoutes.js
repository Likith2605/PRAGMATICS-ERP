import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, requireDepartmentPermission, safeAuditValues } from './auth.js';
import { DEPARTMENT_ROLE_OPTIONS, hasPermissionForRole } from './departmentAccess.js';
import { validateContactField, findChangedContactValidationError } from '../shared/fieldValidation.js';
import { employeeDirectoryReferences } from './employeeStore.js';
import { readDepartmentRoleCatalogs } from './departmentRoleCatalogStore.js';

/**
 * Business master data API. PostgreSQL is the only authority for these
 * records. Browser localStorage may be refreshed from a confirmed response but
 * is never read as the master record itself.
 *
 * Mounted by server.js at /api/masters. Authentication is applied by the
 * parent /api middleware; department permissions are enforced here.
 */
const router = express.Router();

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const text = (value) => String(value ?? '').trim();
const first = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const upper = (value) => text(value).toUpperCase();
const norm = (value) => text(value).toLowerCase();
const tokenPattern = /^[A-Za-z0-9._:-]{8,120}$/;
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/;
const generatedId = (prefix) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const requestHash = (body) => createHash('sha256').update(stableStringify(body)).digest('hex');
const contactError = (payload) => {
  for (const [field, type] of [['phone', 'phone'], ['email', 'email'], ['gstin', 'gstin'], ['pan', 'none']]) {
    if (type === 'none') continue;
    const error = validateContactField(type, payload[field]);
    if (error) return error;
  }
  return null;
};
const changedContactError = (incoming, previous) => findChangedContactValidationError(incoming, previous) || null;
const timestamp = (value) => value?.toISOString?.() || value || null;

const mapCustomer = (input, id) => {
  const companyName = first(input.companyName, input.company_name, input.name, input.company);
  const contact = first(input.contactPerson, input.contact_person, input.customerName, input.customer_name);
  const code = first(input.customerCode, input.customer_code, input.vendorCode, input.vendor_code, input.code);
  const mapped = {
    company_name: companyName,
    customer_code: code,
    gstin: upper(first(input.gstin, input.gstNumber, input.gstNo)),
    pan: upper(first(input.pan, input.panNumber)),
    contact_person: contact,
    phone: text(input.phone),
    email: text(input.email),
    address: text(input.address ?? input.billingAddress),
    state: text(input.state),
    pincode: text(input.pincode),
    status: text(input.status) || 'Active'
  };
  return { id, ...mapped, payload: { ...input, ...mapped, id, companyName, customerName: contact, contactPerson: contact, customerCode: code, vendorCode: code } };
};
const viewCustomer = (row) => {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.id,
    companyName: row.company_name,
    customerName: payload.customerName || row.contact_person,
    contactPerson: row.contact_person,
    customerCode: row.customer_code,
    vendorCode: row.customer_code,
    gstin: row.gstin,
    pan: row.pan,
    phone: row.phone,
    email: row.email,
    address: row.address,
    state: row.state,
    pincode: row.pincode,
    status: row.status,
    version: Number(row.version),
    sourceKey: row.source_key || '',
    legacyId: row.legacy_id || '',
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    deletedAt: timestamp(row.deleted_at),
    deletedBy: row.deleted_by || '',
    deleteReason: row.delete_reason || ''
  };
};

const mapVendor = (input, id) => {
  const name = first(input.name, input.vendorName, input.companyName, input.company);
  const code = first(input.vendorCode, input.vendor_code, input.code, input.seq && `V-${String(input.seq).padStart(4, '0')}`);
  const mapped = {
    vendor_code: code,
    name,
    gstin: upper(first(input.gstin, input.gstNumber)),
    pan: upper(first(input.pan, input.panNumber)),
    contact_person: first(input.contactPerson, input.contact_person, input.customerName),
    phone: String(text(input.phone)).replace(/\D/g, '').slice(-10),
    email: text(input.email),
    address: text(input.address),
    status: text(input.status) || 'Active'
  };
  return { id, ...mapped, payload: { ...input, ...mapped, id, name, vendorCode: code, product: first(input.product, input.category) || 'Other' } };
};
const viewVendor = (row) => {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.id,
    seq: Number(payload.seq) || Number(String(row.vendor_code || '').replace(/\D/g, '')) || row.id,
    name: row.name,
    product: payload.product || 'Other',
    vendorCode: row.vendor_code,
    gstin: row.gstin,
    pan: row.pan,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    status: row.status,
    version: Number(row.version),
    sourceKey: row.source_key || '',
    legacyId: row.legacy_id || '',
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    deletedAt: timestamp(row.deleted_at),
    deletedBy: row.deleted_by || '',
    deleteReason: row.delete_reason || ''
  };
};

const mapMachine = (input, id) => {
  const machineId = upper(first(input.machineId, input.id, id));
  const name = first(input.name, input.machineName);
  const category = first(input.category, input.type);
  const location = first(input.location, input.workCenter, input.work_center);
  const mapped = {
    name,
    category,
    location,
    status: text(input.status) || 'Active',
    hourly_rate: number(first(input.hourlyRate, input.hourly_rate), 0)
  };
  const payload = {
    ...input,
    ...mapped,
    id: machineId,
    machineId,
    name,
    type: first(input.type, category) || category,
    workCenter: first(input.workCenter, input.work_center, location) || location,
    department: first(input.department) || 'Production Department',
    capacity: first(input.capacity),
    remarks: first(input.remarks),
    active: mapped.status === 'Active'
  };
  delete payload.hourlyRate;
  return { id: machineId, ...mapped, payload };
};
const viewMachine = (row) => {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.machine_id,
    machineId: row.machine_id,
    name: row.name,
    category: row.category,
    type: payload.type || row.category,
    location: row.location,
    workCenter: payload.workCenter || row.location,
    department: payload.department || 'Production Department',
    capacity: payload.capacity || '',
    remarks: payload.remarks || '',
    hourlyRate: number(row.hourly_rate),
    active: row.status === 'Active',
    status: row.status,
    version: Number(row.version),
    sourceKey: row.source_key || '',
    legacyId: row.legacy_id || '',
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    deletedAt: timestamp(row.deleted_at),
    deletedBy: row.deleted_by || '',
    deleteReason: row.delete_reason || ''
  };
};

const mapCompanySettings = (input, id = 'primary') => {
  const bank = input.bankDetails && typeof input.bankDetails === 'object' ? input.bankDetails : {};
  const mapped = {
    company_name: first(input.companyName, input.company_name, input.company) || 'PRAGMATICS',
    address: text(input.address),
    gstin: upper(first(input.gstin, input.gstNumber)),
    pan: upper(first(input.pan)),
    phone: text(input.phone),
    email: text(input.email),
    bank_name: first(bank.bankName, input.bankName),
    account_number: first(bank.accountNumber, input.accountNumber),
    ifsc_code: upper(first(bank.ifscCode, bank.ifsc, input.ifscCode)),
    branch: first(bank.branch, input.branch),
    logo_url: first(input.logoDataUrl, input.logoUrl, input.logo_url)
  };
  return { id, ...mapped, payload: { ...input, ...mapped, bankDetails: { ...bank, bankName: mapped.bank_name, accountNumber: mapped.account_number, ifscCode: mapped.ifsc_code, branch: mapped.branch } } };
};
const viewCompanySettings = (row) => {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.id,
    companyName: row.company_name,
    address: row.address,
    gstin: row.gstin,
    pan: row.pan,
    phone: row.phone,
    email: row.email,
    logoDataUrl: row.logo_url || payload.logoDataUrl || '',
    bankDetails: {
      ...(payload.bankDetails || {}),
      bankName: row.bank_name,
      accountNumber: row.account_number,
      ifscCode: row.ifsc_code,
      branch: row.branch
    },
    version: Number(row.version),
    updatedAt: timestamp(row.updated_at),
    updatedBy: row.updated_by
  };
};

const mapUom = (input, id) => {
  const code = first(input.code, input.uomCode, input.unit, input.name);
  const mapped = {
    code,
    name: first(input.name, input.description, code) || code,
    symbol: first(input.symbol, code),
    description: text(input.description),
    status: text(input.status) || 'Active'
  };
  return { id, ...mapped, payload: { ...input, ...mapped } };
};
const viewUom = (row) => ({ ...(row.payload || {}), ...row, id: row.id, version: Number(row.version), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), deletedAt: timestamp(row.deleted_at), sourceKey: row.source_key || '', legacyId: row.legacy_id || '' });

const mapMaterial = (input, id) => {
  const itemCode = first(input.itemCode, input.materialCode, input.code, input.serialNumber);
  const name = first(input.itemName, input.name, input.description, input.itemDescription);
  const mapped = {
    item_code: itemCode,
    name,
    category: first(input.category) || 'Standard Part',
    unit_code: first(input.unitCode, input.unit, input.uom),
    hsn_sac: first(input.hsnSac, input.hsn_sac, input.hsnCode),
    description: text(input.description),
    status: text(input.status) || 'Active'
  };
  return { id, ...mapped, payload: { ...input, ...mapped, id, itemCode, itemName: name, unit: mapped.unit_code } };
};
const viewMaterial = (row) => ({ ...(row.payload || {}), ...row, id: row.id, itemCode: row.item_code, itemName: row.name, unit: row.unit_code, unitCode: row.unit_code, hsnSac: row.hsn_sac, version: Number(row.version), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), deletedAt: timestamp(row.deleted_at), sourceKey: row.source_key || '', legacyId: row.legacy_id || '' });

const CONFIG = {
  customers: {
    table: 'customers', idColumn: 'id', label: 'Customers', module: 'Master Data: Customers',
    map: mapCustomer, view: viewCustomer,
    read: ['sales.enquiry', 'invoice.view', 'sales.customer_order'],
    write: ['sales.quotation', 'sales.customer_order'], deleteAdmin: true,
    compare: ['company_name', 'customer_code', 'gstin', 'pan', 'contact_person', 'phone', 'email', 'address', 'state', 'pincode', 'status'],
    validate: (mapped) => (!mapped.company_name ? 'Company / customer name is required.' : !mapped.contact_person ? 'Contact person is required.' : contactError(mapped)),
    strictContactChanges: true, referenceCheck: true,
    legacyKeys: ['customerDirectory', 'customerMaster'], idPrefix: 'customer'
  },
  vendors: {
    table: 'vendors', idColumn: 'id', label: 'Vendors', module: 'Master Data: Vendors',
    map: mapVendor, view: viewVendor,
    read: ['purchase.reports.view', 'purchase.order'], write: ['purchase.order'], deleteAdmin: true,
    compare: ['vendor_code', 'name', 'gstin', 'pan', 'contact_person', 'phone', 'email', 'address', 'status'],
    validate: (mapped) => (!mapped.name ? 'Vendor name is required.' : contactError(mapped)),
    referenceCheck: true,
    legacyKeys: ['vendorMaster', 'supplierMaster'], idPrefix: 'vendor',
    uniqueColumns: ['vendor_code', 'name']
  },
  machines: {
    table: 'machines', idColumn: 'machine_id', label: 'Machines', module: 'Master Data: Machines',
    map: mapMachine, view: viewMachine,
    read: ['production.view', 'job_card.view', 'inventory.view'], write: [], deleteAdmin: true, adminWrite: true,
    compare: ['name', 'category', 'location', 'status'],
    validate: (mapped) => (!mapped.name ? 'Machine name is required.' : !mapped.id ? 'Machine ID is required.' : null),
    legacyKeys: ['machines'], idPrefix: 'machine'
  },
  'company-settings': {
    table: 'company_settings', idColumn: 'id', label: 'Company Settings', module: 'Master Data: Company Settings',
    map: mapCompanySettings, view: viewCompanySettings,
    read: [], write: [], adminWrite: true, deleteAdmin: true, singleton: true,
    compare: ['company_name', 'address', 'gstin', 'pan', 'phone', 'email', 'bank_name', 'account_number', 'ifsc_code', 'branch', 'logo_url'],
    validate: (mapped) => {
      if (!mapped.company_name) return 'Company name is required.';
      const emailError = validateContactField('email', mapped.email);
      if (emailError) return emailError;
      const gstinError = validateContactField('gstin', mapped.gstin);
      return gstinError || null;
    },
    legacyKeys: ['companySettings'], idPrefix: 'company'
  },
  uoms: {
    table: 'uom_master', idColumn: 'id', label: 'Units of Measure', module: 'Master Data: UOM',
    map: mapUom, view: viewUom,
    read: ['inventory.view', 'purchase_request.view', 'material_request.view'], write: ['inventory.adjust'], deleteAdmin: true,
    compare: ['code', 'name', 'symbol', 'description', 'status'],
    validate: (mapped) => (!mapped.code ? 'UOM code is required.' : null),
    legacyKeys: [], idPrefix: 'uom', uniqueColumns: ['code']
  },
  materials: {
    table: 'material_master', idColumn: 'id', label: 'Material Master', module: 'Master Data: Materials',
    map: mapMaterial, view: viewMaterial,
    read: ['inventory.view', 'purchase_request.view', 'material_request.view'], write: ['inventory.adjust'], deleteAdmin: true,
    compare: ['item_code', 'name', 'category', 'unit_code', 'hsn_sac', 'description', 'status'],
    validate: (mapped) => (!mapped.item_code ? 'Item code is required.' : !mapped.name ? 'Item name is required.' : null),
    legacyKeys: [], legacyFromInventory: true, idPrefix: 'material', uniqueColumns: ['item_code']
  }
};

const configFor = (raw) => {
  const config = CONFIG[String(raw || '')];
  if (!config) throw bad(`Unknown master '${String(raw || '').slice(0, 40)}'.`, 400);
  return config;
};
const guard = (permissions) => (req, res, next) => {
  if (!permissions?.length) return next();
  return requireDepartmentPermission(...permissions)(req, res, next);
};
const adminOr = (permissions) => (req, res, next) => {
  if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
  return guard(permissions)(req, res, next);
};
const writeGuard = (config) => (req, res, next) => config.adminWrite ? requireAdmin(req, res, next) : guard(config.write)(req, res, next);
const deleteGuard = (config) => (req, res, next) => config.deleteAdmin ? requireAdmin(req, res, next) : adminOr(config.write)(req, res, next);

const tokenFrom = (req) => first(req.body?.createToken, req.body?.idempotencyToken, req.get('idempotency-key'));
const requireToken = (req) => {
  const token = tokenFrom(req);
  if (!tokenPattern.test(token)) throw bad('A valid idempotency token (8-120 characters) is required.');
  return token;
};
const requireVersion = (value, allowZero = false) => {
  const version = Number(value);
  if (!Number.isInteger(version) || version < (allowZero ? 0 : 1)) {
    throw bad(allowZero ? 'The PostgreSQL version last read is required (0 when no settings record exists yet).' : 'The PostgreSQL version last read is required.');
  }
  return version;
};
const requireId = (value) => {
  const id = text(value);
  if (!idPattern.test(id)) throw bad('Invalid master record ID.');
  return id;
};
const audit = async (client, req, config, id, label, action, reason, before, after) => client.query(
  `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
  [req.user?.id || 'unknown', req.user?.email || 'unknown', req.user?.role || 'unknown', config.module, String(id), text(label).slice(0, 240), action, text(reason).slice(0, 1000),
    before == null ? null : JSON.stringify(safeAuditValues(before)), after == null ? null : JSON.stringify(safeAuditValues(after))]
);

const claimToken = async (client, req, { token, kind, recordId, action }) => {
  const hash = requestHash({ ...(req.body || {}), createToken: undefined, idempotencyToken: undefined });
  const claimed = await client.query(
    `INSERT INTO master_idempotency (token,kind,record_id,action,request_hash,response)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb) ON CONFLICT (token) DO NOTHING RETURNING token`,
    [token, kind, String(recordId), action, hash]
  );
  if (claimed.rowCount) return { replay: false, hash };
  const prior = await client.query('SELECT request_hash,response FROM master_idempotency WHERE token=$1', [token]);
  if (prior.rows[0]?.request_hash !== hash) throw bad('This idempotency token was used for a different request.', 409);
  return { replay: true, response: prior.rows[0].response };
};
const completeToken = (client, token, response) => client.query('UPDATE master_idempotency SET response=$2::jsonb WHERE token=$1', [token, JSON.stringify(safeAuditValues(response))]);

const baseColumns = (config, mapped) => {
  const copy = { ...mapped };
  delete copy.id;
  delete copy.payload;
  return Object.fromEntries(Object.entries(copy).filter(([key]) => !['version', 'create_token', 'source_key', 'legacy_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at', 'deleted_by', 'delete_reason'].includes(key)));
};
const insertRow = async (client, config, mapped, { id, sourceKey = null, legacyId = null, token = null, actor }) => {
  const base = baseColumns(config, mapped);
  const keys = Object.keys(base);
  const values = keys.map((key) => base[key]);
  const result = await client.query(
    `INSERT INTO ${config.table} (${[config.idColumn, ...keys].join(',')}, source_key,legacy_id,create_token,created_by,updated_by,payload)
     VALUES ($${keys.length + 1},${keys.map((_, index) => `$${index + 1}`).join(',') || ''},$${keys.length + 2},$${keys.length + 3},$${keys.length + 4},$${keys.length + 5},$${keys.length + 6},$${keys.length + 7}::jsonb) RETURNING *`,
    [...values, id, sourceKey, legacyId, token, actor, actor, JSON.stringify(safeAuditValues(mapped.payload || {}))]
  );
  return result.rows[0];
};
const updateRow = async (client, config, mapped, { id, version, actor }) => {
  const base = baseColumns(config, mapped);
  const keys = Object.keys(base);
  const values = keys.map((key) => base[key]);
  const sets = keys.map((key, index) => `${key}=$${index + 1}`);
  sets.push(`version=version+1`, `updated_by=$${keys.length + 1}`, `payload=$${keys.length + 2}::jsonb`, `updated_at=now()`);
  const result = await client.query(
    `UPDATE ${config.table} SET ${sets.join(',')} WHERE ${config.idColumn}=$${keys.length + 3} AND deleted_at IS NULL AND version=$${keys.length + 4} RETURNING *`,
    [...values, actor, JSON.stringify(safeAuditValues(mapped.payload || {})), id, version]
  );
  return result.rows[0];
};
const getRow = async (executor, config, id, activeOnly = true) => {
  const result = await executor.query(`SELECT * FROM ${config.table} WHERE ${config.idColumn}=$1${activeOnly ? ' AND deleted_at IS NULL' : ''}`, [id]);
  return result.rows[0] || null;
};
const duplicateConflict = async (client, config, mapped, id, { sourceKey = null, legacyId = null } = {}) => {
  if (sourceKey && legacyId) {
    const imported = await client.query(`SELECT ${config.idColumn} AS id FROM ${config.table} WHERE source_key=$1 AND legacy_id=$2`, [sourceKey, legacyId]);
    if (imported.rowCount && imported.rows[0].id !== id) return 'This legacy record has already been imported. Duplicate records are not allowed.';
  }
  const candidates = [];
  if (config.uniqueColumns) {
    for (const column of config.uniqueColumns) {
      if (mapped[column]) candidates.push({ column, value: norm(mapped[column]) });
    }
  }
  if (config.table === 'uom_master' && mapped.code) candidates.push({ column: 'code', value: norm(mapped.code) });
  if (config.table === 'material_master' && mapped.item_code) candidates.push({ column: 'item_code', value: norm(mapped.item_code) });
  for (const candidate of candidates) {
    const result = await client.query(`SELECT ${config.idColumn} AS id, deleted_at FROM ${config.table} WHERE lower(${candidate.column})=$1`, [candidate.value]);
    for (const row of result.rows) {
      if (String(row.id) === id) continue;
      if (row.deleted_at) return `${candidate.column.replace('_', ' ')} '${mapped[candidate.column]}' belongs to a deleted record and cannot be reused.`;
      return `${candidate.column.replace('_', ' ')} '${mapped[candidate.column]}' is already used by another active record.`;
    }
  }
  return null;
};
const masterReferenceInUse = async (client, config, row) => {
  if (!config.referenceCheck) return null;
  const view = config.view(row);
  const needles = [view.id, view.name, view.companyName, view.customerName, view.contactPerson, view.customerCode, view.vendorCode]
    .filter(Boolean).map((value) => norm(value));
  const fieldPattern = config.table === 'vendors' ? /vendor|supplier/i : /customer|buyer|party|client|company/i;
  const state = await client.query(
    'SELECT storage_key,data FROM erp_state WHERE storage_key <> ALL($1::text[])',
    [config.legacyKeys]
  );
  const records = await client.query('SELECT storage_key,data FROM module_records');
  const inUse = (value, field = '') => {
    if (Array.isArray(value)) return value.some((item) => inUse(item, field));
    if (!value || typeof value !== 'object') return fieldPattern.test(field) && needles.includes(norm(value));
    return Object.entries(value).some(([key, child]) => inUse(child, key));
  };
  for (const source of [...state.rows, ...records.rows]) {
    if (inUse(source.data)) return 'This master record is referenced by business history and cannot be deleted. Deactivate it instead.';
  }
  return null;
};
const uniqueViolation = (error) => error?.code === '23505';

const handleCreate = (config) => async (req, res) => {
  const token = requireToken(req);
  const input = req.body?.data && typeof req.body.data === 'object' ? req.body.data : req.body || {};
  const id = requireId(first(input.id, input.machineId, input.itemCode, generatedId(config.idPrefix)));
  const mapped = config.map(input, id);
  if (config.singleton) throw bad('Company Settings is a single record; use PUT to update it.');
  const error = config.validate(mapped);
  if (error) throw bad(error);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const claim = await claimToken(client, req, { token, kind: config.table, recordId: id, action: 'CREATE' });
    if (claim.replay) {
      const replayed = await getRow(client, config, id, false);
      if (replayed?.deleted_at) throw bad('This record was deleted after the original create; replay cannot restore it.', 409);
      await client.query('COMMIT');
      return res.json({ ...claim.response, idempotentReplay: true });
    }
    const existing = await getRow(client, config, id, false);
    if (existing) throw bad('This record ID was previously used. Deleted master records cannot be restored by a retry.', 409);
    const conflict = await duplicateConflict(client, config, mapped, id);
    if (conflict) throw bad(conflict, 409);
    let row;
    try {
      row = await insertRow(client, config, mapped, { id, token, actor: req.user.email });
    } catch (insertError) {
      if (uniqueViolation(insertError)) throw bad('A record with the same code, identity, or idempotency token already exists.', 409);
      throw insertError;
    }
    await audit(client, req, config, id, mapped.name || mapped.company_name || id, 'CREATE', '', null, config.view(row));
    const response = { record: config.view(row), duplicate: false };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.status(201).json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};

const handleUpdate = (config) => async (req, res) => {
  const token = requireToken(req);
  const id = requireId(req.params.id);
  const version = requireVersion(req.body?.version, Boolean(config.singleton));
  const input = req.body?.data && typeof req.body.data === 'object' ? req.body.data : req.body || {};
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const claim = await claimToken(client, req, { token, kind: config.table, recordId: id, action: 'UPDATE' });
    if (claim.replay) {
      const current = await getRow(client, config, id, false);
      if (!current || current.deleted_at) throw bad('This record was deleted after the original update; replay cannot restore it.', 409);
      await client.query('COMMIT');
      return res.json({ ...claim.response, idempotentReplay: true });
    }
    const current = await getRow(client, config, id);
    if (!current) {
      // A singleton settings form has no row before its first save. Version 0
      // is the explicit "not loaded yet" sentinel; it never recreates a deleted
      // record because any existing row (including a tombstone) is checked.
      const any = config.singleton ? await getRow(client, config, id, false) : null;
      if (!config.singleton || version !== 0) throw bad(`${config.label} record not found.`, 404);
      if (any) throw bad('This settings record was previously saved. Reload before editing.', 409);
      const mapped = config.map({ ...input, id }, id);
      const validationError = config.validate(mapped);
      if (validationError) throw bad(validationError);
      let row;
      try {
        row = await insertRow(client, config, mapped, { id, token, actor: req.user.email });
      } catch (insertError) {
        if (uniqueViolation(insertError)) throw bad('This settings record already exists.', 409);
        throw insertError;
      }
      await audit(client, req, config, id, row.company_name || id, 'CREATE', text(req.body?.reason), null, config.view(row));
      const response = { record: config.view(row), created: true };
      await completeToken(client, token, response);
      await client.query('COMMIT');
      return res.status(201).json(response);
    }
    if (Number(current.version) !== version) throw bad(`${config.label} changed in PostgreSQL. Reload before editing.`, 409, { current: config.view(current) });
    // Merge the stored canonical values first so a partial form update never
    // silently clears a preserved code or relationship.
    const merged = { ...config.view(current), ...input, id };
    const mapped = config.map(merged, id);
    if (mapped.id !== id) throw bad('A master record ID cannot change during an update.');
    const validationError = config.validate(mapped);
    if (validationError) throw bad(validationError);
    const changedError = config.strictContactChanges ? changedContactError(mapped.payload, config.view(current)) : null;
    if (changedError) throw bad(changedError);
    const conflict = await duplicateConflict(client, config, mapped, id);
    if (conflict) throw bad(conflict, 409);
    let row;
    try {
      row = await updateRow(client, config, mapped, { id, version, actor: req.user.email });
    } catch (updateError) {
      if (uniqueViolation(updateError)) throw bad('A record with the same code already exists.', 409);
      throw updateError;
    }
    if (!row) throw bad(`${config.label} changed in PostgreSQL. Reload before editing.`, 409, { current: config.view(await getRow(client, config, id)) });
    await audit(client, req, config, id, row.name || row.company_name || id, 'UPDATE', text(req.body?.reason), config.view(current), config.view(row));
    const response = { record: config.view(row) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};

const handleDelete = (config) => async (req, res) => {
  const token = requireToken(req);
  const id = requireId(req.params.id);
  const version = requireVersion(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const claim = await claimToken(client, req, { token, kind: config.table, recordId: id, action: 'SOFT_DELETE' });
    if (claim.replay) {
      const current = await getRow(client, config, id, false);
      if (!current || !current.deleted_at) throw bad('This record is no longer deleted; replay cannot change it.', 409);
      await client.query('COMMIT');
      return res.json({ ...claim.response, idempotentReplay: true });
    }
    const current = await getRow(client, config, id);
    if (!current) throw bad(`${config.label} record not found.`, 404);
    if (Number(current.version) !== version) throw bad(`${config.label} changed in PostgreSQL. Reload before deleting.`, 409, { current: config.view(current) });
    const referenceError = await masterReferenceInUse(client, config, current);
    if (referenceError) throw bad(referenceError, 409);
    const updated = await client.query(
      `UPDATE ${config.table} SET deleted_at=now(),deleted_by=$2,delete_reason=$3,updated_by=$2,updated_at=now(),version=version+1 WHERE ${config.idColumn}=$1 AND deleted_at IS NULL AND version=$4 RETURNING *`,
      [id, req.user.email, reason, version]
    );
    const row = updated.rows[0];
    await audit(client, req, config, id, row.name || row.company_name || id, 'SOFT_DELETE', reason, config.view(current), null);
    const response = { deleted: id, version: Number(row.version) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
};

const legacySources = (config) => config.legacyFromInventory ? [{ storageKey: 'module_records', source: 'module_records/inventoryItems' }] : config.legacyKeys.map((storageKey) => ({ storageKey, source: `erp_state/${storageKey}` }));

const loadCandidates = async (config, executor = getPool()) => {
  const candidates = [];
  if (config.legacyFromInventory) {
    const result = await executor.query("SELECT record_id,data FROM module_records WHERE storage_key='inventoryItems'");
    for (const row of result.rows) candidates.push({ sourceKey: 'module_records/inventoryItems', identity: `item:${norm(row.record_id)}`, raw: { ...(row.data || {}), id: row.record_id } });
    return candidates;
  }
  if (!config.legacyKeys.length) return candidates;
  const result = await executor.query('SELECT storage_key,data FROM erp_state WHERE storage_key = ANY($1::text[])', [config.legacyKeys]);
  for (const row of result.rows) {
    const records = Array.isArray(row.data) ? row.data : [row.data];
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return;
      const identityValue = first(record.id, record.machineId, record.itemCode, record.code, record.seq);
      const identity = identityValue ? `${row.storage_key}:${norm(identityValue)}` : `${row.storage_key}:name:${norm(first(record.companyName, record.name, record.customerName))}:${index}`;
      candidates.push({ sourceKey: `erp_state/${row.storage_key}`, identity, raw: record });
    });
  }
  return candidates;
};

const candidateId = (config, candidate) => {
  if (config.singleton) return 'primary';
  const raw = candidate.raw || {};
  const explicit = first(raw.id, raw.machineId, raw.itemCode, raw.code);
  if (explicit) return requireId(explicit);
  const code = config.idPrefix === 'vendor' && raw.seq ? `V-${String(raw.seq).padStart(4, '0')}` : first(raw.customerCode, raw.vendorCode, raw.companyName, raw.name);
  const suffix = createHash('sha256').update(candidate.identity).digest('hex').slice(0, 10);
  const root = code ? norm(code).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48) : config.idPrefix;
  return requireId(`${config.idPrefix}-${root || 'record'}-${suffix}`);
};

const comparable = (config, row) => Object.fromEntries(config.compare.map((column) => [column, String(row?.[column] ?? '')]));
const classifyCandidates = async (config, executor = getPool()) => {
  const candidates = await loadCandidates(config, executor);
  const active = (await executor.query(`SELECT * FROM ${config.table} WHERE deleted_at IS NULL`)).rows;
  const deleted = (await executor.query(`SELECT * FROM ${config.table} WHERE deleted_at IS NOT NULL`)).rows;
  const seen = new Set();
  return candidates.map((candidate) => {
    const reasons = [];
    if (seen.has(candidate.identity)) reasons.push('Duplicate identity in the legacy source.');
    seen.add(candidate.identity);
    const id = candidateId(config, candidate);
    const mapped = config.map(candidate.raw, id);
    const validationError = config.validate(mapped);
    if (validationError) reasons.push(validationError);
    const codeColumns = config.uniqueColumns || (config.table === 'uom_master' ? ['code'] : config.table === 'material_master' ? ['item_code'] : []);
    const tombstone = deleted.find((row) => String(row[config.idColumn]) === id ||
      (row.source_key === candidate.sourceKey && row.legacy_id === candidate.identity) ||
      codeColumns.some((column) => text(mapped[column]) && norm(row[column]) === norm(mapped[column])));
    if (tombstone) reasons.push('A deleted record with this identity or code exists; it cannot be restored.');
    const existing = active.find((row) => String(row[config.idColumn]) === id ||
      (row.source_key === candidate.sourceKey && row.legacy_id === candidate.identity));
    let status = 'eligible';
    let existingId = '';
    if (existing) {
      existingId = String(existing[config.idColumn]);
      const before = comparable(config, existing);
      const after = comparable(config, mapped);
      if (stableStringify(before) === stableStringify(after)) status = 'identical';
      else { status = 'conflicting'; reasons.push('An active record with this identity has different values.'); }
    } else if (config.uniqueColumns || ['uom_master', 'material_master'].includes(config.table)) {
      const checkColumns = config.uniqueColumns || (config.table === 'uom_master' ? ['code'] : ['item_code']);
      const duplicate = active.find((row) => checkColumns.some((column) => text(mapped[column]) && norm(row[column]) === norm(mapped[column])));
      if (duplicate) { status = 'conflicting'; existingId = String(duplicate[config.idColumn]); reasons.push('Code or name is already used by a different active record.'); }
    }
    if (reasons.length && status === 'eligible') { status = 'invalid'; }
    const previewRow = { ...mapped, [config.idColumn]: id, payload: mapped.payload, version: 1, created_at: null, updated_at: null };
    return { key: candidate.identity, sourceKey: candidate.sourceKey, legacyId: candidate.identity, proposedId: id, status, reasons, existingId, candidate: config.view(previewRow) };
  });
};

router.get('/references', async (req, res) => {
  const [uoms, materials, catalogs] = await Promise.all([
    getPool().query('SELECT * FROM uom_master WHERE deleted_at IS NULL ORDER BY code'),
    getPool().query('SELECT * FROM material_master WHERE deleted_at IS NULL ORDER BY item_code'),
    readDepartmentRoleCatalogs()
  ]);
  const customDepartments = catalogs.departments
    .filter((entry) => !entry.legacy && !entry.deletedAt && entry.active !== false)
    .map((entry) => entry.name)
    .filter(Boolean);
  const canSeeEmployees = req.user?.roleKey === 'admin' || req.user?.role === 'Administrator' ||
    hasEmployeeView(req);
  const employees = canSeeEmployees ? await employeeDirectoryReferences() : [];
  res.json({
    uoms: uoms.rows.map((row) => ({ id: row.id, code: row.code, name: row.name, symbol: row.symbol, status: row.status, version: Number(row.version) })),
    materials: materials.rows.map((row) => ({ id: row.id, itemCode: row.item_code, name: row.name, category: row.category, unit: row.unit_code, status: row.status, version: Number(row.version) })),
    departments: [...new Set(['Admin', ...Object.keys(DEPARTMENT_ROLE_OPTIONS), ...customDepartments])].sort(),
    employees
  });
});

function hasEmployeeView(req) {
  try {
    return hasPermissionForRole(req.user?.roleKey, 'employee.view', req.user?.rolePermissions);
  } catch { return false; }
}

router.get('/:kind/legacy/preview', requireAdmin, async (req, res) => {
  const config = configFor(req.params.kind);
  const entries = await classifyCandidates(config);
  res.json({ kind: req.params.kind, sources: legacySources(config), entries });
});

router.post('/:kind/legacy/import', requireAdmin, async (req, res) => {
  const config = configFor(req.params.kind);
  const token = requireToken(req);
  const selected = Array.isArray(req.body?.selected) ? req.body.selected.map(text).filter(Boolean) : [];
  if (!selected.length) throw bad('Select at least one legacy record to import.');
  const actor = req.user.email;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const claim = await claimToken(client, req, { token, kind: config.table, recordId: 'selected-import', action: 'LEGACY_IMPORT' });
    if (claim.replay) {
      const ids = Array.isArray(claim.response?.importedIds) ? claim.response.importedIds : [];
      for (const id of ids) {
        const current = await getRow(client, config, id, false);
        if (!current || current.deleted_at) throw bad('A record imported by this token was deleted; replay cannot restore it.', 409);
      }
      await client.query('COMMIT');
      return res.json({ ...claim.response, idempotentReplay: true });
    }
    const preview = await classifyCandidates(config, client);
    const byKey = new Map(preview.map((entry) => [entry.key, entry]));
    const chosen = selected.map((key) => byKey.get(key));
    const rejected = chosen.filter((entry) => !entry || entry.status !== 'eligible');
    if (rejected.length) throw bad('Only eligible legacy records can be imported. Refresh the preview and review the selection.', 409, { rejected: rejected.map((entry) => ({ key: entry?.key || '', status: entry?.status || 'unknown', reasons: entry?.reasons || [] })) });
    const imported = [];
    for (const entry of chosen) {
      const id = entry.proposedId;
      const existing = await getRow(client, config, id, false);
      if (existing) throw bad(`Legacy record '${entry.key}' was already imported.`, 409);
      const mapped = config.map(entry.candidate, id);
      const conflict = await duplicateConflict(client, config, mapped, id, { sourceKey: entry.sourceKey, legacyId: entry.legacyId });
      if (conflict) throw bad(conflict, 409);
      let row;
      try {
        row = await insertRow(client, config, mapped, { id, sourceKey: entry.sourceKey, legacyId: entry.legacyId, token: `legacy:${token}:${entry.key}`, actor });
      } catch (insertError) {
        if (uniqueViolation(insertError)) throw bad(`Legacy record '${entry.key}' conflicts with an existing master.`, 409);
        throw insertError;
      }
      await audit(client, req, config, id, row.name || row.company_name || id, 'LEGACY_IMPORT', `Selected legacy import from ${entry.sourceKey}`, null, config.view(row));
      imported.push(config.view(row));
    }
    const response = { kind: req.params.kind, imported: imported.length, records: imported, importedIds: imported.map((record) => record.id) };
    await completeToken(client, token, response);
    await client.query('COMMIT');
    return res.status(201).json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

for (const [kind, config] of Object.entries(CONFIG)) {
  router.get(`/${kind}/history`, requireAdmin, async (req, res) => {
    const result = await getPool().query(
      'SELECT id,user_id,email,role,action,reason,before_values,after_values,created_at FROM erp_audit_log WHERE module=$1 ORDER BY created_at DESC,id DESC LIMIT 200',
      [config.module]
    );
    res.json({ kind, module: config.module, entries: result.rows });
  });

  router.get(`/${kind}`, guard(config.read), async (req, res) => {
    const includeDeleted = req.query.includeDeleted === '1' && (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator');
    const result = await getPool().query(`SELECT * FROM ${config.table} ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY ${config.idColumn}`);
    if (config.singleton) return res.json({ key: kind, record: result.rows[0] ? config.view(result.rows[0]) : null, records: result.rows.map(config.view) });
    res.json({ kind, records: result.rows.map(config.view) });
  });

  router.get(`/${kind}/:id`, guard(config.read), async (req, res) => {
    const row = await getRow(getPool(), config, requireId(req.params.id));
    if (!row) throw bad(`${config.label} record not found.`, 404);
    res.json({ key: kind, record: config.view(row) });
  });

  if (!config.singleton) router.post(`/${kind}`, writeGuard(config), handleCreate(config));
  router.put(`/${kind}/:id`, writeGuard(config), handleUpdate(config));
  router.delete(`/${kind}/:id`, deleteGuard(config), handleDelete(config));
}

router.get('/:kind/:id/history', requireAdmin, async (req, res) => {
  const config = configFor(req.params.kind);
  const id = requireId(req.params.id);
  const result = await getPool().query(
    'SELECT id,user_id,email,role,action,reason,before_values,after_values,created_at FROM erp_audit_log WHERE module=$1 AND record_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200',
    [config.module, id]
  );
  res.json({ kind: req.params.kind, id, entries: result.rows });
});

router.use((error, _req, res, _next) => {
  const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  if (status >= 500) console.error('Master API error:', error);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message, ...(error.current ? { current: error.current } : {}), ...(error.rejected ? { rejected: error.rejected } : {}) });
});

export default router;
export { router, CONFIG };
