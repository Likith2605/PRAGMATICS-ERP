import { generateSequentialNumber, saveSequenceCounter } from './storeSequencer.js';
import {
  hasPermission,
  isAdmin,
  getCurrentUserInfo,
  normalizeDepartment,
  normalizeRoleKey,
  roleLabelForRoleKey
} from './permissions.js';

const LS = {
  employees: 'employees',
  materialRequests: 'materialRequests',
  storeIssueHistory: 'storeIssueHistory',
  materialReturnHistory: 'materialReturnHistory',
  storeAuditLog: 'storeAuditLog',
  notifications: 'notifications',
  storePurchaseRequests: 'storePurchaseRequests',
  inventoryItems: 'inventoryItems',
  stockTransactions: 'stockTransactions',
  productionJobCards: 'productionJobCards',
  supplierPOHistory: 'supplierPOHistory',
  storeGRNs: 'storeGRNs',
  stockTransfers: 'stockTransfers',
  stockVerifications: 'stockVerifications',
  inventoryBatches: 'inventoryBatches',
  machines: 'machines'
};

export const STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  PENDING: 'Pending Store',
  PARTIAL: 'Partially Issued',
  FULL: 'Fully Issued',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed'
};

const ALLOWED_EDIT = new Set([
  STATUS.CANCELLED,
  STATUS.REJECTED,
  STATUS.CLOSED
]);

/* Where a Material Request line came from (audit trail / traceability).
   TERMS_REQUIREMENT = fetched from the Sales Order → Terms & Requirement list.
   ADDITIONAL         = added by Production through "+ Add Item" (Item Master). */
export const SOURCE_TYPE = {
  TERMS_REQUIREMENT: 'TERMS_REQUIREMENT',
  ADDITIONAL: 'ADDITIONAL'
};

export const SOURCE_TYPE_LABEL = {
  [SOURCE_TYPE.TERMS_REQUIREMENT]: 'Terms Requirement',
  [SOURCE_TYPE.ADDITIONAL]: 'Additional Item'
};

/* Older Material Requests were saved before sourceType existed: they were
   added by hand (or from an Item List), so they read back as ADDITIONAL. */
export const resolveSourceType = (it = {}) =>
  it.sourceType || (it.termsRequirementItemId ? SOURCE_TYPE.TERMS_REQUIREMENT : SOURCE_TYPE.ADDITIONAL);

/* A request can be edited / deleted only while no material has been issued
   against it: Draft, Submitted, Approved, Pending Store, Cancelled, Rejected. */
const MR_EDITABLE_STATUSES = new Set([
  STATUS.DRAFT,
  STATUS.SUBMITTED,
  STATUS.APPROVED,
  STATUS.PENDING,
  STATUS.CANCELLED,
  STATUS.REJECTED
]);

const canEditMaterialRequests = () =>
  hasPermission('material_request.create') || hasPermission('material_request.edit');

export const isMRStatusEditable = (status) => MR_EDITABLE_STATUSES.has(status);

const assertMRNotIssued = (mrNumber, verb) => {
  const totals = getMRMaterialTotals(mrNumber);
  const mr = getMaterialRequests().find((m) => m.mrNumber === mrNumber);
  const anyIssued = (mr?.items || []).some((it) => (totals.issued[it.materialId] || 0) > 0);
  if (anyIssued) throw new Error(`Cannot ${verb} - material has already been issued against this request.`);
};

export const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

/* -------------------------- storage quota handling -------------------------- */

const isQuotaError = (err) =>
  Boolean(err) &&
  (err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014 ||
    /quota/i.test(String(err.message || '')));

/** Bytes currently held by localStorage (keys + values). */
export const getStorageUsage = () => {
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      bytes += String(k || '').length + String(localStorage.getItem(k) || '').length;
    }
  } catch {
    /* storage unavailable */
  }
  return bytes;
};

const formatBytes = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

const trimListKey = (key, keep) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length <= keep) return false;
    localStorage.setItem(key, JSON.stringify(list.slice(0, keep)));
    return true;
  } catch {
    return false;
  }
};

const removeKey = (key) => {
  try {
    if (localStorage.getItem(key) === null) return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
};

/**
 * Free space when the browser storage quota is hit. Only derived / rebuilt
 * data is touched (automatic backup snapshots, old audit + notification
 * entries) — business records are never discarded. Each step reports whether
 * it actually freed something so the caller can retry the failed write.
 */
const QUOTA_RECOVERY_STEPS = [
  { label: 'kept only the latest automatic backup snapshot', run: () => trimListKey('erpDailySnapshots', 1) },
  { label: 'cleared the automatic backup snapshots', run: () => removeKey('erpDailySnapshots') },
  { label: 'trimmed the audit log to its latest 500 entries', run: () => trimListKey(LS.storeAuditLog, 500) },
  { label: 'trimmed notifications to their latest 200 entries', run: () => trimListKey(LS.notifications, 200) }
];

export const writeLS = (key, value) => {
  const payload = JSON.stringify(value);
  try {
    localStorage.setItem(key, payload);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('erp-state-change', { detail: { key } }));
    }
    return;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
  }

  /* Browser storage is full: drop derived data step by step and retry. */
  const freed = [];
  for (const step of QUOTA_RECOVERY_STEPS) {
    if (!step.run()) continue;
    freed.push(step.label);
    try {
      localStorage.setItem(key, payload);
      console.warn(`[storage] quota exceeded — ${freed.join('; ')}`);
      return;
    } catch (retryErr) {
      if (!isQuotaError(retryErr)) throw retryErr;
    }
  }

  const used = getStorageUsage();
  throw new Error(
    `Browser storage is full (${formatBytes(used)} used of the ~5 MB available)${
      freed.length ? ` — already ${freed.join('; ')}` : ''
    }. Export a backup from Settings → Backup & Restore, then delete old records (enquiries, quotations, histories) and try again.`
  );
};

/**
 * Proactive housekeeping: called on app launch so space is freed *before* any
 * module writes (several modules still call localStorage.setItem directly and
 * would otherwise throw a raw quota error). Returns a summary of what was
 * freed, or null when comfortably under budget. Never throws.
 */
export const enforceStorageBudget = (limitBytes = 4 * 1024 * 1024) => {
  try {
    let used = getStorageUsage();
    if (used <= limitBytes) return null;
    const freed = [];
    for (const step of QUOTA_RECOVERY_STEPS) {
      if (used <= limitBytes) break;
      if (!step.run()) continue;
      freed.push(step.label);
      used = getStorageUsage();
    }
    if (!freed.length) return null;
    const msg = `Browser storage was nearly full (${formatBytes(used)} after cleanup) — ${freed.join('; ')}.`;
    console.warn(`[storage] ${msg}`);
    return msg;
  } catch {
    return null;
  }
};

/* ------------------------------ date helpers ------------------------------ */

import { formatDateDMY } from './routeCard.js';

export const todayStr = () => new Date().toISOString().slice(0, 10);

export const nowTimeStr = () =>
  new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

export const nowDateStr = () =>
  new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export const nowDateTimeStr = () =>
  new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });

export const dateOnly = (s) => {
  if (!s) return '';
  const str = String(s);
  if (str.includes(',')) return str.split(',')[0].trim();
  const iso = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return formatDateDMY(iso[1]);
  return str;
};

/* -------------------------------- seeding -------------------------------- */

const DEFAULT_EMPLOYEES = [
  { id: 'emp-1', employeeId: 'EMP-001', name: 'Production Manager', email: 'prodmanager@gmail.com', password: 'Prod@1234', mobile: '', department: 'Production Department', designation: 'Production Manager', roleKey: 'production_manager', role: 'Production Manager', active: true, joinedDate: '' },
  { id: 'emp-2', employeeId: 'EMP-002', name: 'Mohan Kumar', email: 'mohan@gmail.com', password: 'Store@1234', mobile: '9845012345', department: 'Store Department', designation: 'Store Manager', roleKey: 'store_manager', role: 'Store Manager', active: true, joinedDate: '' },
  { id: 'emp-3', employeeId: 'EMP-023', name: 'Ravi Kumar', email: 'ravi@gmail.com', password: 'Ravi@1234', mobile: '9845067890', department: 'Production Department', designation: 'Production Engineer', roleKey: 'production_employee', role: 'Production Employee', active: true, joinedDate: '' },
  { id: 'emp-4', employeeId: 'EMP-004', name: 'Meena Devi', email: 'meena@gmail.com', password: 'Meena@1234', mobile: '9740011122', department: 'Production Department', designation: 'Quality Inspector', roleKey: 'production_employee', role: 'Production Employee', active: true, joinedDate: '' },
  { id: 'emp-5', employeeId: 'EMP-005', name: 'Suresh Kumar', email: 'suresh@gmail.com', password: 'Store@1234', mobile: '9632011223', department: 'Store Department', designation: 'Store Assistant', roleKey: 'store_employee', role: 'Store Employee', active: true, joinedDate: '' },
  { id: 'emp-6', employeeId: 'EMP-006', name: 'Priya Raman', email: 'priya@gmail.com', password: 'Prod@1234', mobile: '9632011224', department: 'Production Department', designation: 'Production Supervisor', roleKey: 'production_employee', role: 'Production Employee', active: true, joinedDate: '' },
  { id: 'emp-7', employeeId: 'EMP-007', name: 'Anand Krishnan', email: 'anand@gmail.com', password: 'Purchase@1234', mobile: '9532011225', department: 'Purchase Department', designation: 'Purchase Executive', roleKey: 'purchase_employee', role: 'Purchase Employee', active: true, joinedDate: '' },
  { id: 'emp-8', employeeId: 'EMP-008', name: 'Kavitha Nair', email: 'kavitha@gmail.com', password: 'Sales@1234', mobile: '9432011226', department: 'Sales Department', designation: 'Sales Executive', roleKey: 'sales_employee', role: 'Sales Employee', active: true, joinedDate: '' }
];

// One-time, idempotent migration of legacy employee records to the canonical
// 5-department + role model. Preserves credentials, names and IDs.
const migrateLegacyEmployeeData = () => {
  const list = readLS(LS.employees, []);
  if (!Array.isArray(list) || list.length === 0) return;
  let changed = false;
  const next = list.map((e) => {
    const department = normalizeDepartment(e.department);
    const roleKey = normalizeRoleKey(e.roleKey) || '';
    const role = e.role || roleLabelForRoleKey(roleKey || undefined, department);
    if (e.department !== department || e.roleKey !== roleKey || e.role !== role) changed = true;
    return { ...e, department, roleKey, role: role || roleLabelForRoleKey(roleKey || undefined, department) };
  });
  if (changed) writeLS(LS.employees, next);
};

export const ensureSeededData = () => {
  if (!localStorage.getItem(LS.employees)) writeLS(LS.employees, DEFAULT_EMPLOYEES);
  migrateLegacyEmployeeData();
  if (!localStorage.getItem(LS.machines)) writeLS(LS.machines, DEFAULT_MACHINES);
  [
    LS.materialRequests,
    LS.storeIssueHistory,
    LS.materialReturnHistory,
    LS.storeAuditLog,
    LS.notifications,
    LS.storePurchaseRequests,
    LS_HT_OUTSOURCE,
    'supplierPOHistory',
    'quotationHistory',
    'salesOrderHistory',
    'customerPOHistory',
    'customerInvoiceHistory',
    'deliveryChallanHistory',
    'supplierInvoiceHistory',
    'exportInvoiceHistory',
    'boms',
    'projectRequests',
    'vendorEnquiries',
    'vendorQuotations'
  ].forEach((k) => {
    if (!localStorage.getItem(k)) writeLS(k, []);
  });
};

/* ------------------------------- auth/login ------------------------------- */

// Employee Portal login: email is the Login ID, password is the Login Password
// set by the administrator on the Employee Master page.
export const authenticateEmployee = (email, password) => {
  try {
    const list = readLS(LS.employees, []);
    const clean = String(email || '').trim().toLowerCase();
    return (
      list.find(
        (e) =>
          e &&
          e.active !== false &&
          e.email &&
          e.email.trim().toLowerCase() === clean &&
          e.password === password
      ) || null
    );
  } catch (err) {
    console.error('authenticateEmployee failed', err);
    return null;
  }
};

/* --------------------------------- numbers -------------------------------- */

export const generateMRNumber = () =>
  generateSequentialNumber({ prefix: 'MR', sequenceKey: 'materialRequestSequence', historyKey: LS.materialRequests, idField: 'mrNumber' });

export const generateSINumber = () =>
  generateSequentialNumber({ prefix: 'SI', sequenceKey: 'storeIssueSequence', historyKey: LS.storeIssueHistory, idField: 'issueNumber' });

export const generateSRNumber = () =>
  generateSequentialNumber({ prefix: 'SR', sequenceKey: 'materialReturnSequence', historyKey: LS.materialReturnHistory, idField: 'returnNumber' });

export const generatePRNumber = () =>
  generateSequentialNumber({ prefix: 'PR', sequenceKey: 'storePurchaseRequestSequence', historyKey: LS.storePurchaseRequests, idField: 'prNumber' });

/* ----------------------------- audit + notifications ----------------------------- */

export const appendAuditLog = ({ action, reference = '', details = '' }) => {
  const info = getCurrentUserInfo();
  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    date: nowDateStr(),
    time: nowTimeStr(),
    user: info.employee?.name || info.auth?.username || 'User',
    employeeId: info.employee?.employeeId || '-',
    department: info.employee?.department || '-',
    role: info.employee?.role || info.employee?.designation || '-',
    action,
    reference,
    details
  };
  const logs = readLS(LS.storeAuditLog, []);
  writeLS(LS.storeAuditLog, [entry, ...logs].slice(0, 500));
  return entry;
};

export const getAuditLog = () => readLS(LS.storeAuditLog, []);

/**
 * Publish a notification. `docId` / `docName` optionally reference a file in
 * the workflow document store (workflowFiles.js) — the notification list then
 * opens that document instead of navigating, which is how the Purchase Order
 * PDF "sent to Store" is handed over.
 */
export const pushNotification = ({ title, message, type = 'info', reference = '', targetDept = '', targetRole = '', link = '', docId = '', docName = '' }) => {
  const list = readLS(LS.notifications, []);
  const entry = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    message,
    type,
    reference,
    targetDept,
    targetRole,
    link,
    docId,
    docName,
    dateTime: nowDateTimeStr(),
    read: false,
    createdAt: Date.now()
  };
  writeLS(LS.notifications, [entry, ...list].slice(0, 200));
  return entry;
};

export const getNotifications = () => readLS(LS.notifications, []);

export const markAllNotificationsRead = () => {
  const list = readLS(LS.notifications, []);
  writeLS(LS.notifications, list.map((n) => ({ ...n, read: true })));
};

/* ------------------------------- employees -------------------------------- */

export const getEmployees = () => readLS(LS.employees, []);

const DEFAULT_MACHINES = [
  { id: 'mc-1', machineId: 'MC001', name: 'CNC Turning Machine 01', type: 'CNC', workCenter: 'Turning', department: 'Production Department', location: 'Shop Floor 1', capacity: '1 shift', status: 'Active', remarks: '' },
  { id: 'mc-2', machineId: 'MC002', name: 'CNC Turning Machine 02', type: 'CNC', workCenter: 'Turning', department: 'Production Department', location: 'Shop Floor 1', capacity: '1 shift', status: 'Active', remarks: '' },
  { id: 'mc-3', machineId: 'MC003', name: 'VMC Machine 01', type: 'VMC', workCenter: 'Milling', department: 'Production Department', location: 'Shop Floor 1', capacity: '1 shift', status: 'Active', remarks: '' },
  { id: 'mc-4', machineId: 'MC004', name: 'Surface Grinder 01', type: 'Grinder', workCenter: 'Grinding', department: 'Production Department', location: 'Shop Floor 2', capacity: '1 shift', status: 'Active', remarks: '' }
];

export const getMachines = () => readLS(LS.machines, DEFAULT_MACHINES);
export const saveMachines = (list) => writeLS(LS.machines, list);
export const generateMachineId = () => {
  const list = getMachines();
  let max = 0;
  list.forEach((m) => {
    const mId = String(m.machineId || '').match(/(\d+)\s*$/);
    if (mId) {
      const n = parseInt(mId[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  });
  const next = max + 1;
  return { machineId: `MC${String(next).padStart(3, '0')}`, next };
};

export const findMachine = (ref) => {
  if (!ref) return null;
  const list = getMachines();
  const direct = list.find((m) => m.machineId === ref || m.id === ref || m.name === ref);
  if (direct) return direct;
  const target = String(ref).trim().toLowerCase();
  return (
    list.find(
      (m) =>
        String(m.machineId || '').trim().toLowerCase() === target ||
        String(m.id || '').trim().toLowerCase() === target ||
        String(m.name || '').trim().toLowerCase() === target
    ) || null
  );
};

export const machineDisplay = (ref) => {
  if (!ref) return '-';
  const m = findMachine(ref);
  if (m) return `${m.machineId} - ${m.name}`;
  return typeof ref === 'string' ? ref : (ref.name || ref.machineId || '-');
};

export const machineLabel = (m) => {
  if (!m) return '';
  if (typeof m === 'string') return m;
  return m.machineId && m.name ? `${m.machineId} - ${m.name}` : (m.name || m.machineId || '');
};

export const saveEmployees = (list) => {
  writeLS(LS.employees, list);
  return list;
};

export const generateEmployeeId = () => {
  const list = getEmployees();
  let max = 0;
  list.forEach((e) => {
    const m = String(e.employeeId || '').match(/(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  });
  const next = max + 1;
  return {
    employeeId: `EMP-${String(next).padStart(3, '0')}`,
    next
  };
};

/* ------------------------------ inventory/transactions ------------------------------ */

export const getInventoryItems = () => readLS(LS.inventoryItems, []);
export const saveInventoryItems = (items) => writeLS(LS.inventoryItems, items);
export const getStockTransactions = () => readLS(LS.stockTransactions, []);
export const saveStockTransactions = (tx) => writeLS(LS.stockTransactions, tx);

export const transactionTypeLabel = (tx) => {
  const reason = String(tx.reason || '').toLowerCase();
  if (reason.includes('store issue')) return 'Store Issue';
  if (reason.includes('store return')) return 'Store Return';
  if (reason.includes('purchase')) return 'Purchase Receipt';
  if (reason.includes('manual adjustment') || reason.includes('adjustment')) return 'Stock Adjustment';
  if (reason.includes('delivery challan') || reason.includes('dispatch')) return 'Dispatch';
  if (reason.includes('production')) return 'Production';
  if (reason.includes('issued to employee')) return 'Employee Issue';
  return tx.type === 'IN' ? 'Stock In' : 'Stock Out';
};

/* --------------------------- material requests --------------------------- */

export const getMaterialRequests = () => readLS(LS.materialRequests, []);

const saveMaterialRequests = (list) => writeLS(LS.materialRequests, list);

export const getJobCards = () => readLS(LS.productionJobCards, []);
export const saveJobCards = (list) => writeLS(LS.productionJobCards, list);

export const getStoreIssues = () => readLS(LS.storeIssueHistory, []);
export const getMaterialReturns = () => readLS(LS.materialReturnHistory, []);
export const getPurchaseRequests = () => readLS(LS.storePurchaseRequests, []);

const saveStoreIssues = (list) => writeLS(LS.storeIssueHistory, list);
const saveStoreReturns = (list) => writeLS(LS.materialReturnHistory, list);
const savePurchaseRequests = (list) => writeLS(LS.storePurchaseRequests, list);

const pushStockTransaction = (base, extra = {}) => {
  const tx = getStockTransactions();
  writeLS(LS.stockTransactions, [{ ...base, ...extra }, ...tx]);
};

export const getMRMaterialTotals = (mrNumber) => {
  const issues = getStoreIssues().filter((i) => i.mrNumber === mrNumber);
  const returns = getMaterialReturns().filter((r) => r.mrNumber === mrNumber);
  const issued = {};
  const returned = {};
  issues.forEach((i) =>
    (i.items || []).forEach((it) => {
      issued[it.materialId] = (issued[it.materialId] || 0) + (Number(it.currentIssueQty) || 0);
    })
  );
  returns.forEach((r) =>
    (r.items || []).forEach((it) => {
      returned[it.materialId] = (returned[it.materialId] || 0) + (Number(it.quantityReturned) || 0);
    })
  );
  return { issued, returned };
};

export const getMRItemStatus = (required, issued) => {
  const rq = Number(required) || 0;
  const isd = Number(issued) || 0;
  if (rq <= 0) return 'Pending';
  if (isd >= rq) return 'Issued';
  if (isd > 0) return 'Partially Issued';
  return 'Pending';
};

export const computeEffectiveMRStatus = (mr, totals) => {
  if (ALLOWED_EDIT.has(mr.status)) return mr.status;
  const items = mr.items || [];
  const totalRequired = items.reduce((a, it) => a + (Number(it.requiredQty) || 0), 0);
  const totalIssued = items.reduce((a, it) => a + ((totals.issued[it.materialId] || 0)), 0);
  if (totalRequired > 0 && totalIssued >= totalRequired) return STATUS.FULL;
  if (totalIssued > 0) return STATUS.PARTIAL;
  return mr.status || STATUS.PENDING;
};

export const decorateMR = (mr) => {
  const totals = getMRMaterialTotals(mr.mrNumber);
  const status = computeEffectiveMRStatus(mr, totals);
  const items = (mr.items || []).map((it) => {
    const issued = totals.issued[it.materialId] || 0;
    const returned = totals.returned[it.materialId] || 0;
    const inv = getInventoryItems().find((i) => i.itemCode === it.materialId);
    return {
      ...it,
      issuedQty: issued,
      returnedQty: returned,
      balanceQty: Math.max(0, (Number(it.requiredQty) || 0) - issued),
      lineStatus: getMRItemStatus(it.requiredQty, issued),
      unit: it.unit || inv?.unit || 'Nos'
    };
  });
  return { ...mr, status, items };
};

export const getMaterialShortages = (mr) => {
  const totalIssued = getMRMaterialTotals(mr.mrNumber);
  const inv = getInventoryItems();
  const rows = (mr.items || []).map((it) => {
    const issued = totalIssued.issued[it.materialId] || 0;
    const required = Number(it.requiredQty) || 0;
    const balance = Math.max(0, required - issued);
    const invItem = inv.find((i) => i.itemCode === it.materialId);
    const available = invItem ? Number(invItem.currentQty) || 0 : 0;
    const shortage = Math.max(0, balance - available);
    return {
      materialId: it.materialId,
      materialName: it.materialName,
      unit: it.unit || invItem?.unit || 'Nos',
      required,
      issued,
      balance,
      available,
      shortage,
      hasShortage: shortage > 0,
      canIssuePartially: balance > 0 && available > 0
    };
  });
  return rows;
};

/**
 * Quantities already committed for a Sales Order / Job Card:
 *   requested = Σ requiredQty of every in-scope Material Request line
 *   issued    = Σ issued qty from the Material Issue slips of those requests
 * Scope = the selected Job Card and/or Sales Order. Cancelled / Rejected
 * requests never count; `excludeMrNumber` skips the request being edited.
 */
export const getMRScopeQtyMaps = ({ salesOrderRef = '', jobCardNumber = '', excludeMrNumber = '' } = {}) => {
  const so = String(salesOrderRef || '').trim();
  const jc = String(jobCardNumber || '').trim();
  if (!so && !jc) return { requested: {}, issued: {} };
  const inScope = getMaterialRequests().filter((m) =>
    m &&
    String(m.mrNumber || '') !== String(excludeMrNumber || '') &&
    ![STATUS.CANCELLED, STATUS.REJECTED].includes(m.status) &&
    ((jc && String(m.jobCardNumber || '') === jc) || (so && String(m.salesOrderRef || '') === so))
  );
  const requested = {};
  inScope.forEach((m) => (m.items || []).forEach((it) => {
    const k = String(it.materialId || '');
    requested[k] = (requested[k] || 0) + (Number(it.requiredQty) || 0);
  }));
  const scopeNos = new Set(inScope.map((m) => m.mrNumber));
  const issued = {};
  getStoreIssues().filter((i) => scopeNos.has(i.mrNumber)).forEach((i) => (i.items || []).forEach((it) => {
    const k = String(it.materialId || '');
    issued[k] = (issued[k] || 0) + (Number(it.currentIssueQty) || 0);
  }));
  return { requested, issued };
};

/* Validation shared by create + update (spec §17). */
const assertMRItemsValid = (items, { inv, salesOrderRef, jobCardNumber, excludeMrNumber }) => {
  const progress = getMRScopeQtyMaps({ salesOrderRef, jobCardNumber, excludeMrNumber });
  const seen = new Set();
  items.forEach((it) => {
    const key = String(it.materialId || '').trim();
    const label = it.materialName || key;
    if (!inv.find((i) => i.itemCode === key)) {
      throw new Error(`Invalid material "${label}" — it is not in the inventory master.`);
    }
    if (!(Number(it.requiredQty) > 0)) {
      throw new Error(`Invalid required quantity for "${label}".`);
    }
    if (seen.has(key)) {
      throw new Error(`"${label}" is already included in the Material Request. Please update the existing request quantity.`);
    }
    seen.add(key);
    if (it.sourceType === SOURCE_TYPE.ADDITIONAL && !String(it.reason || '').trim()) {
      throw new Error(`"${label}": an Additional Item needs a reason (why it was not in Terms & Requirement).`);
    }
    const termsRequired = Number(it.termsRequiredQty) || 0;
    if (termsRequired > 0) {
      const alreadyReq = Number(progress.requested[key]) || 0;
      const alreadyIss = Number(progress.issued[key]) || 0;
      const balance = Math.max(0, termsRequired - alreadyReq - alreadyIss);
      if (Number(it.requiredQty) > balance) {
        throw new Error(
          `"${label}": request quantity ${Number(it.requiredQty)} exceeds the remaining balance ${balance} ` +
          `(Required ${termsRequired} − Requested ${alreadyReq} − Issued ${alreadyIss}).`
        );
      }
    }
  });
};

/* Keeps the Terms & Requirement traceability fields on every stored line. */
const mapMRItems = (items, inv, info) =>
  items.map((it) => {
    const invItem = inv.find((i) => i.itemCode === it.materialId) || null;
    return {
      materialId: it.materialId,
      itemId: String(it.itemId || invItem?.id || ''),
      materialName: it.materialName,
      materialDesc: it.materialDesc || '',
      grade: it.grade || '',
      spec: it.spec || '',
      sizeDimensions: it.sizeDimensions || '',
      unit: it.unit || invItem?.unit || 'Nos',
      requiredQty: Number(it.requiredQty) || 0,
      termsRequiredQty: Number(it.termsRequiredQty) || 0,
      sourceType: it.sourceType || (it.termsRequirementItemId ? SOURCE_TYPE.TERMS_REQUIREMENT : SOURCE_TYPE.ADDITIONAL),
      termsRequirementItemId: String(it.termsRequirementItemId || ''),
      reason: String(it.reason || ''),
      addedBy: String(it.addedBy || ''),
      addedDate: String(it.addedDate || ''),
      purpose: it.purpose || '',
      batchNo: it.batchNo || '',
      heatNumber: it.heatNumber || '',
      serialNumber: it.serialNumber || '',
      createdBy: it.createdBy || info.employee?.name || info.auth?.username || 'User'
    };
  });

export const createMaterialRequest = ({ jobCardNumber, salesOrderRef, customer, partName, drawingNumber, productionDepartment, requestedBy, requestedByEmpId, priority = 'Normal', requiredDate, remarks, items, projectId = '', projectName = '' }) => {
  if (!hasPermission('material_request.create')) throw new Error('Permission denied: material_request.create');
  if (!items || items.length === 0) throw new Error('At least one material line is required.');
  const inv = getInventoryItems();
  assertMRItemsValid(items, { inv, salesOrderRef, jobCardNumber, excludeMrNumber: '' });

  const mrNumber = generateMRNumber();
  const info = getCurrentUserInfo();
  const mr = {
    mrNumber,
    materialRequestId: mrNumber,
    requestDate: todayStr(),
    requiredDate: requiredDate || '',
    jobCardNumber: jobCardNumber || '',
    jobCardId: jobCardNumber || '',
    salesOrderRef: salesOrderRef || '',
    salesOrderId: salesOrderRef || '',
    customer: customer || '',
    partName: partName || '',
    drawingNumber: drawingNumber || '',
    projectId: (projectId || '').trim().toUpperCase(),
    projectName: projectName || '',
    productionDepartment: productionDepartment || info.employee?.department || 'Production Department',
    requestedBy: requestedBy || info.employee?.name || info.auth?.username || 'User',
    requestedByEmpId: requestedByEmpId || info.employee?.employeeId || '-',
    priority: priority || 'Normal',
    remarks: remarks || '',
    status: STATUS.DRAFT,
    createdBy: info.employee?.name || info.auth?.username || 'User',
    createdAt: nowDateTimeStr(),
    items: mapMRItems(items, inv, info)
  };
  const list = getMaterialRequests();
  writeLS(LS.materialRequests, [mr, ...list]);
  saveSequenceCounter('materialRequestSequence', mrNumber);
  appendAuditLog({
    action: 'MR CREATED',
    reference: mrNumber,
    details: `${mr.partName || 'N/A'} | ${mr.items.length} material(s) | ${sourceBreakdown(mr.items)} | SO ${mr.salesOrderRef || '-'} | JC ${mr.jobCardNumber || '-'} | Requested by ${mr.requestedBy}`
  });
  return mr;
};

/* "2 Terms Requirement, 1 Additional Item" — used by the audit trail. */
const sourceBreakdown = (items) => {
  const terms = (items || []).filter((i) => i.sourceType === SOURCE_TYPE.TERMS_REQUIREMENT).length;
  const extra = (items || []).length - terms;
  const parts = [];
  if (terms) parts.push(`${terms} Terms Requirement`);
  if (extra) parts.push(`${extra} Additional Item${extra > 1 ? 's' : ''}`);
  return parts.join(', ') || 'Manual';
};

export const submitMaterialRequest = (mrNumber) => {
  if (!hasPermission('material_request.submit')) throw new Error('Permission denied: material_request.submit');
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (mr.status === STATUS.CANCELLED || mr.status === STATUS.REJECTED || mr.status === STATUS.CLOSED) {
    throw new Error(`Cannot submit a ${mr.status} Material Request.`);
  }
  const updated = list.map((m, i) => (i === idx ? { ...m, status: STATUS.SUBMITTED, submittedAt: nowDateTimeStr() } : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR SUBMITTED', reference: mrNumber, details: 'Waiting for Production Manager approval.' });
  pushNotification({ title: 'Material Request Submitted', message: `Material Request ${mrNumber} is waiting for Production Manager approval.`, type: 'store', reference: mrNumber, targetDept: 'Production Department', targetRole: 'production_manager' });
  return updated[idx];
};

export const approveMaterialRequest = (mrNumber, approvalRemarks = '') => {
  if (!hasPermission('material_request.approve')) throw new Error('Permission denied: material_request.approve');
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (mr.status !== STATUS.SUBMITTED) throw new Error(`Can only approve a Submitted MR. Current status: ${mr.status}`);
  const info = getCurrentUserInfo();
  const updated = list.map((m, i) => (i === idx ? {
    ...m,
    status: STATUS.APPROVED,
    approvedBy: info.employee?.name || info.auth?.username || 'User',
    approvedByEmpId: info.employee?.employeeId || '-',
    approvedAt: nowDateTimeStr(),
    approvalRemarks: approvalRemarks || ''
  } : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR APPROVED', reference: mrNumber, details: `Approved by ${info.employee?.name || 'User'}. ${approvalRemarks || ''}` });
  pushNotification({ title: 'Material Request Approved', message: `Material Request ${mrNumber} has been approved and is now visible to the Store department.`, type: 'success', reference: mrNumber, targetDept: 'Store Department' });
  return updated[idx];
};

export const closeMaterialRequest = (mrNumber) => {
  if (!hasPermission('material_request.submit') && !hasPermission('material_issue.confirm')) {
    throw new Error('Permission denied: you cannot close a material request.');
  }
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  const totals = getMRMaterialTotals(mrNumber);
  const totalRequired = (mr.items || []).reduce((a, it) => a + (Number(it.requiredQty) || 0), 0);
  const totalIssued = (mr.items || []).reduce((a, it) => a + ((totals.issued[it.materialId] || 0)), 0);
  if (mr.status === STATUS.CLOSED) throw new Error('This Material Request is already closed.');
  if (!(totalRequired > 0 && totalIssued >= totalRequired)) {
    throw new Error('Only a Fully Issued Material Request can be closed.');
  }
  const updated = list.map((m, i) => (i === idx ? { ...m, status: STATUS.CLOSED, closedAt: nowDateTimeStr() } : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR CLOSED', reference: mrNumber, details: 'All material issued. Request closed.' });
  pushNotification({ title: 'Material Request Closed', message: `Material Request ${mrNumber} has been closed.`, type: 'success', reference: mrNumber, targetDept: 'Production Department' });
  return updated[idx];
};

export const cancelMaterialRequest = (mrNumber, reason = '') => {
  if (!hasPermission('material_request.cancel')) throw new Error('Permission denied: material_request.cancel');
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (ALLOWED_EDIT.has(mr.status)) throw new Error(`Cannot cancel a ${mr.status} Material Request.`);
  const totals = getMRMaterialTotals(mrNumber);
  const anyIssued = (mr.items || []).some((it) => (totals.issued[it.materialId] || 0) > 0);
  if (anyIssued) throw new Error('Cannot cancel — material has already been issued against this request.');
  const updated = list.map((m, i) => (i === idx ? { ...m, status: STATUS.CANCELLED, cancellationReason: reason, cancelledAt: nowDateTimeStr() } : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR CANCELLED', reference: mrNumber, details: reason || 'Cancelled by requester' });
  pushNotification({ title: 'Material Request Cancelled', message: `Material Request ${mrNumber} was cancelled.`, type: 'warning', reference: mrNumber });
  return updated[idx];
};

export const rejectMaterialRequest = (mrNumber, reason = '') => {
  if (!hasPermission('material_issue.confirm')) throw new Error('Permission denied: material_issue.confirm');
  if (!reason || !reason.trim()) throw new Error('Rejection reason is required.');
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (ALLOWED_EDIT.has(mr.status)) throw new Error(`Cannot reject a ${mr.status} Material Request.`);
  const totals = getMRMaterialTotals(mrNumber);
  const anyIssued = (mr.items || []).some((it) => (totals.issued[it.materialId] || 0) > 0);
  if (anyIssued) throw new Error('Cannot reject — material has already been issued against this request.');
  const updated = list.map((m, i) => (i === idx ? { ...m, status: STATUS.REJECTED, rejectionReason: reason, rejectedAt: nowDateTimeStr() } : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR REJECTED', reference: mrNumber, details: reason });
  pushNotification({ title: 'Material Request Rejected', message: `Material Request ${mrNumber} was rejected: ${reason}`, type: 'warning', reference: mrNumber });
  return updated[idx];
};

export const updateMaterialRequest = (mrNumber, updates) => {
  if (!canEditMaterialRequests()) throw new Error('Permission denied: material_request.edit');
  const items = updates.items || [];
  if (!items || items.length === 0) throw new Error('At least one material line is required.');
  const inv = getInventoryItems();
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (!MR_EDITABLE_STATUSES.has(mr.status)) throw new Error(`This Material Request cannot be edited. Current status: ${mr.status}`);
  assertMRNotIssued(mrNumber, 'edit');
  /* The Job Card is optional: an explicitly blank value clears it, while
     callers that omit the field keep the existing link. */
  const hasJc = Object.prototype.hasOwnProperty.call(updates, 'jobCardNumber');
  const nextJobCard = hasJc ? String(updates.jobCardNumber || '').trim() : String(mr.jobCardNumber || '');
  assertMRItemsValid(items, {
    inv,
    salesOrderRef: updates.salesOrderRef || mr.salesOrderRef,
    jobCardNumber: nextJobCard,
    excludeMrNumber: mrNumber
  });
  const info = getCurrentUserInfo();
  const merged = {
    ...mr,
    requiredDate: updates.requiredDate || '',
    jobCardNumber: nextJobCard,
    jobCardId: nextJobCard,
    salesOrderRef: updates.salesOrderRef || '',
    salesOrderId: updates.salesOrderRef || '',
    customer: updates.customer || '',
    partName: updates.partName || '',
    drawingNumber: updates.drawingNumber || '',
    projectId: (updates.projectId || mr.projectId || '').trim().toUpperCase(),
    projectName: updates.projectName || '',
    priority: updates.priority || 'Normal',
    remarks: updates.remarks || '',
    requestedBy: updates.requestedBy || mr.requestedBy,
    requestedByEmpId: updates.requestedByEmpId || mr.requestedByEmpId,
    items: mapMRItems(items, inv, info),
    updatedAt: nowDateTimeStr(),
    updatedBy: info.employee?.name || info.auth?.username || 'User'
  };
  const updated = list.map((m, i) => (i === idx ? merged : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR UPDATED', reference: mrNumber, details: `${merged.partName || 'N/A'} | ${merged.items.length} material(s) | Edited by ${merged.updatedBy}` });
  return updated[idx];
};

export const deleteMaterialRequest = (mrNumber) => {
  if (!canEditMaterialRequests()) throw new Error('Permission denied: material_request.edit');
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (!MR_EDITABLE_STATUSES.has(mr.status)) throw new Error(`This Material Request cannot be deleted. Current status: ${mr.status}`);
  assertMRNotIssued(mrNumber, 'delete');
  const updated = list.filter((m) => m.mrNumber !== mrNumber);
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR DELETED', reference: mrNumber, details: `${mr.partName || 'N/A'} | ${mr.items?.length || 0} material(s) | Draft deleted` });
  return true;
};

export const markPendingStore = (mrNumber) => {
  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) return null;
  if (list[idx].status !== STATUS.APPROVED && list[idx].status !== STATUS.SUBMITTED && list[idx].status !== STATUS.PENDING) return list[idx];
  const updated = list.map((m, i) => (i === idx ? { ...m, status: STATUS.PENDING } : m));
  writeLS(LS.materialRequests, updated);
  appendAuditLog({ action: 'MR CLAIMED BY STORE', reference: mrNumber, details: `Status changed to Pending Store` });
  return updated[idx];
};

const computeUpdatedMRStatusAfterIssue = (mr, totals, siItems) => {
  const allRequired = (mr.items || []).reduce((a, it) => a + (Number(it.requiredQty) || 0), 0);
  const totalIssuedNow = siItems.reduce((a, l) => a + (Number(l.currentIssueQty) || 0), 0);
  const existingIssued = (mr.items || []).reduce((a, it) => a + ((totals.issued[it.materialId] || 0)), 0);
  const totalIssued = existingIssued + totalIssuedNow;
  if (allRequired > 0 && totalIssued >= allRequired) return STATUS.FULL;
  if (totalIssued > 0) return STATUS.PARTIAL;
  return mr.status === STATUS.DRAFT ? STATUS.DRAFT : STATUS.PENDING;
};

/**
 * Issue stock against a Material Request.
 *
 * `issueRefs` carries the references the store person confirms on the issue
 * screen (Job Card / Customer PO / Customer). They are stamped onto the Store
 * Issue slip and the stock transaction only — the Material Request itself is
 * never rewritten by the Store department.
 */
export const issueMaterial = ({ mrNumber, issueQtyById, receiver, remarks = '', batchInfo = {}, issueRefs = {} }) => {
  if (!hasPermission('material_issue.confirm')) throw new Error('Permission denied: material_issue.confirm');
  const mrs = getMaterialRequests();
  const mrIdx = mrs.findIndex((m) => m.mrNumber === mrNumber);
  if (mrIdx === -1) throw new Error('Material Request not found.');
  const mr = mrs[mrIdx];
  if (mr.status === STATUS.DRAFT) throw new Error('Cannot issue a Draft Material Request — it must be submitted to the Store first.');
  if (mr.status === STATUS.FULL || ALLOWED_EDIT.has(mr.status)) {
    throw new Error(`Cannot issue material: request status is ${mr.status}.`);
  }

  if (!receiver || !receiver.name) throw new Error('Material receiver (employee) must be selected from the employee master.');
  if (!receiver.employeeId) throw new Error('Material receiver employee ID is missing.');
  if (!receiver.acknowledged) throw new Error('Employee acknowledgement checkbox is required before issuing.');

  const jcForValidation = getJobCards().find((j) => j.jobCardNumber === mr.jobCardNumber);
  const mrProjectId = (mr.projectId || '').trim().toUpperCase();
  const jcProjectId = ((jcForValidation && jcForValidation.projectId) || '').trim().toUpperCase();
  if (mrProjectId && jcProjectId && mrProjectId !== jcProjectId) {
    throw new Error(`Cross-project linkage blocked: Material Request ${mrNumber} belongs to project ${mrProjectId}, but Job Card ${mr.jobCardNumber} is linked to ${jcProjectId}.`);
  }

  /* References confirmed by the store person on the issue screen. */
  const siJobCard = String(issueRefs.jobCardNumber || '').trim() || mr.jobCardNumber || '';
  const siPoNumber = String(issueRefs.poNumber || '').trim();
  const siCustomer = String(issueRefs.customer || '').trim() || mr.customer || '';
  if (siJobCard && siJobCard !== mr.jobCardNumber) {
    const entered = getJobCards().find((j) => j.jobCardNumber === siJobCard);
    const enteredProjectId = String((entered && entered.projectId) || '').trim().toUpperCase();
    if (mrProjectId && enteredProjectId && mrProjectId !== enteredProjectId) {
      throw new Error(
        `Cross-project linkage blocked: Job Card ${siJobCard} belongs to project ${enteredProjectId}, but Material Request ${mrNumber} belongs to ${mrProjectId}.`
      );
    }
  }

  const totals = getMRMaterialTotals(mrNumber);
  const inv = getInventoryItems();
  const issueNumber = generateSINumber();
  const issuer = getCurrentUserInfo();

  const siItems = [];
  const fefoDeductions = []; // FEFO batch depletion: [{ id, qty }]
  (mr.items || []).forEach((it) => {
    const materialId = it.materialId;
    const required = Number(it.requiredQty) || 0;
    const alreadyIssued = totals.issued[materialId] || 0;
    const balance = required - alreadyIssued;
    const invItem = inv.find((i) => i.itemCode === materialId);
    const available = invItem ? Number(invItem.currentQty) || 0 : 0;
    const requestedToday = Number(issueQtyById && issueQtyById[materialId]) || 0;
    if (requestedToday <= 0) return;
    const maxIssuable = Math.max(0, Math.min(available, balance));
    if (requestedToday > maxIssuable) {
      throw new Error(
        `Issue exceeds the permitted limit for "${it.materialName || materialId}": available ${available}, remaining to be issued ${balance}, but ${requestedToday} was entered.`
      );
    }

    /* --- shelf life: FEFO (First Expiry, First Out) + hard expiry block ---
       For shelf-life-managed items the nearest-expiry open batch is the one
       that must go out first. If that batch is already expired the issue is
       refused until the expired stock is written off (audit trail intact). */
    let fefo = null;
    if (invItem?.shelfLifeManaged) {
      const openBatches = getInventoryBatches()
        .filter(
          (b) =>
            String(b.itemCode || '').toLowerCase() === String(materialId).toLowerCase() &&
            (Number(b.availableQty) || 0) > 0 &&
            b.expiryDate
        )
        .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));
      if (openBatches.length > 0) {
        const nearest = openBatches[0];
        const st = getExpiryStatus(nearest.expiryDate);
        if (st.status === 'EXPIRED') {
          throw new Error(
            `FEFO blocked for "${it.materialName || materialId}": nearest-expiry batch ${nearest.batchNumber} expired on ${nearest.expiryDate}. Write it off from the Shelf Life / Expiry register before issuing.`
          );
        }
        fefo = {
          batchNumber: nearest.batchNumber,
          expiryDate: nearest.expiryDate,
          daysLeft: st.daysLeft,
          nearExpiry: st.status === 'NEAR'
        };
      }
      // No open batch with an expiry date: legacy stock received before shelf
      // life capture — issue allowed, but FEFO cannot be verified for it.
    }

    const batch = (batchInfo && batchInfo[materialId]) || {};
    const itemBatches = getInventoryBatches().filter((candidate) =>
      String(candidate.itemCode || '').toLowerCase() === String(materialId).toLowerCase() && (Number(candidate.availableQty) || 0) > 0
    );
    const explicitReceiptBatch = batch.receiptBatchId
      ? itemBatches.find((candidate) => candidate.id === batch.receiptBatchId)
      : null;
    const fefoBatch = fefo ? itemBatches.find((candidate) => candidate.expiryDate === fefo.expiryDate && candidate.batchNumber === fefo.batchNumber) : null;
    const batchBySupplierNumber = batch.batchNo
      ? itemBatches.filter((candidate) => String(candidate.supplierBatchNumber || candidate.batchNumber || '') === String(batch.batchNo))
      : [];
    const selectedReceiptBatch = explicitReceiptBatch || (batch.batchNo && batchBySupplierNumber.length === 1 ? batchBySupplierNumber[0] : null) || fefoBatch || (!batch.batchNo && itemBatches.length === 1 ? itemBatches[0] : null);
    if (batch.receiptBatchId && !explicitReceiptBatch) throw new Error(`Selected receipt batch is unavailable for "${it.materialName || materialId}".`);
    if (batch.batchNo && batchBySupplierNumber.length > 1 && !explicitReceiptBatch) throw new Error(`Supplier batch ${batch.batchNo} is ambiguous for "${it.materialName || materialId}". Select its receipt batch ID.`);
    if (itemBatches.length > 1 && !selectedReceiptBatch) throw new Error(`Select the receipt batch for "${it.materialName || materialId}" before issuing stock.`);
    if (selectedReceiptBatch && requestedToday > (Number(selectedReceiptBatch.availableQty) || 0)) {
      throw new Error(`Selected batch ${selectedReceiptBatch.internalBatchId || selectedReceiptBatch.batchNumber} has only ${selectedReceiptBatch.availableQty} available; issue a smaller quantity.`);
    }
    if (selectedReceiptBatch) fefoDeductions.push({ id: selectedReceiptBatch.id, qty: requestedToday });
    /* Lot number: whatever the store person typed on the issue screen wins,
       otherwise the lot recorded against the batch that is going out (the
       receipt / QC carries it into the inventory batch register). */
    const resolvedBatchNo = batch.batchNo || it.batchNo || selectedReceiptBatch?.supplierBatchNumber || selectedReceiptBatch?.batchNumber || fefo?.batchNumber || '';
    const registerBatch = resolvedBatchNo
      ? getInventoryBatches().find(
          (b) =>
            String(b.batchNumber || '') === String(resolvedBatchNo) &&
            (!b.itemCode || String(b.itemCode).toLowerCase() === String(materialId).toLowerCase())
        )
      : null;
    const lotNumber = String(batch.lotNumber || '').trim() || registerBatch?.lotNumber || '';
    siItems.push({
      materialId,
      materialName: it.materialName,
      materialDesc: it.materialDesc || '',
      spec: it.spec || '',
      unit: it.unit || invItem?.unit || 'Nos',
      requestedQty: required,
      previouslyIssued: alreadyIssued,
      currentIssueQty: requestedToday,
      totalIssued: alreadyIssued + requestedToday,
      remainingQty: Math.max(0, balance - requestedToday),
      batchNo: batch.batchNo || it.batchNo || fefo?.batchNumber || '',
      receiptBatchId: selectedReceiptBatch?.id || '',
      internalBatchId: selectedReceiptBatch?.internalBatchId || '',
      lotNumber,
      heatNumber: batch.heatNumber || it.heatNumber || '',
      serialNumber: batch.serialNumber || it.serialNumber || '',
      fefoBatchNo: fefo?.batchNumber || '',
      fefoExpiryDate: fefo?.expiryDate || '',
      fefoDaysLeft: fefo ? fefo.daysLeft : null,
      fefoNearExpiry: Boolean(fefo?.nearExpiry)
    });
  });

  if (siItems.length === 0) throw new Error('Enter an issue quantity for at least one material.');

  // Deplete the FEFO batches so the next issue picks the next-soonest batch.
  if (fefoDeductions.length > 0) {
    const batches = getInventoryBatches();
    const nextBatches = batches.map((b) => {
      const d = fefoDeductions.find((x) => x.id === b.id);
      if (!d) return b;
      const left = Math.max(0, (Number(b.availableQty) || 0) - d.qty);
      return { ...b, availableQty: left, status: left > 0 ? b.status : 'Depleted' };
    });
    writeLS(LS.inventoryBatches, nextBatches);
  }

  const updatedInv = inv.map((item) => {
    const line = siItems.find((s) => s.materialId === item.itemCode);
    if (line) return { ...item, currentQty: Math.max(0, (Number(item.currentQty) || 0) - line.currentIssueQty) };
    return item;
  });
  writeLS(LS.inventoryItems, updatedInv);

  const now = new Date();
  siItems.forEach((line) => {
    const invItem = updatedInv.find((i) => i.itemCode === line.materialId);
    pushStockTransaction(
      {
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: now.toISOString().slice(0, 10),
        dateTime: nowDateTimeStr(),
        itemCode: line.materialId,
        itemName: line.materialName,
        unit: line.unit,
        type: 'OUT',
        quantity: line.currentIssueQty,
        balanceAfter: invItem ? invItem.currentQty : 0,
        reason: 'Store Issue',
        reference: issueNumber,
        transactionNumber: issueNumber,
        mrNumber,
        jobCardNumber: siJobCard,
        poNumber: siPoNumber,
        customer: siCustomer,
        projectId: mrProjectId,
        projectName: jcForValidation?.projectName || mr.projectName || '',
        issuedTo: receiver.name,
        issuedToId: receiver.employeeId,
        issuedBy: issuer.employee?.name || issuer.auth?.username || 'Store',
        issuedByDept: issuer.employee?.department || 'Store Department',
        batchNo: line.batchNo,
        receiptBatchId: line.receiptBatchId || '',
        internalBatchId: line.internalBatchId || '',
        lotNumber: line.lotNumber || '',
        heatNumber: line.heatNumber,
        fefoBatchNo: line.fefoBatchNo || '',
        fefoExpiryDate: line.fefoExpiryDate || '',
        fefoNearExpiry: Boolean(line.fefoNearExpiry)
      },
      { transactionNumber: issueNumber }
    );
  });

  const nearExpiryLines = siItems.filter((l) => l.fefoNearExpiry);
  if (nearExpiryLines.length > 0) {
    pushNotification({
      title: 'Shelf Life — Near Expiry Issued',
      message: nearExpiryLines
        .map((l) => `${l.materialName}: batch ${l.fefoBatchNo} expires ${l.fefoExpiryDate} (${l.fefoDaysLeft} day(s) left)`)
        .join(' | '),
      type: 'warning',
      reference: issueNumber
    });
  }

  const si = {
    issueNumber,
    issueDate: now.toISOString().slice(0, 10),
    issueTime: nowTimeStr(),
    mrNumber,
    jobCardNumber: siJobCard,
    poNumber: siPoNumber,
    salesOrderRef: mr.salesOrderRef || '',
    projectId: mrProjectId,
    projectName: jcForValidation?.projectName || mr.projectName || '',
    customer: siCustomer,
    partName: mr.partName || '',
    requestedBy: mr.requestedBy || '',
    requestedByEmpId: mr.requestedByEmpId || '-',
    issuedBy: issuer.employee?.name || issuer.auth?.username || 'Store Employee',
    issuedById: issuer.employee?.employeeId || '-',
    issuedByDept: issuer.employee?.department || 'Store Department',
    receivedBy: receiver.name,
    receivedByEmpId: receiver.employeeId,
    receivedByDept: receiver.department || '',
    receivedByDesignation: receiver.designation || '',
    receivedByMobile: receiver.mobile || '',
    acknowledged: true,
    acknowledgementText: 'I confirm that I have received the above material.',
    acknowledgedAt: nowDateTimeStr(),
    remarks: remarks || '',
    items: siItems
  };
  writeLS(LS.storeIssueHistory, [si, ...getStoreIssues()]);
  saveSequenceCounter('storeIssueSequence', issueNumber);

  const updatedStatus = computeUpdatedMRStatusAfterIssue(mr, totals, siItems);
  const updatedMr = { ...mr, status: updatedStatus, lastIssueAt: nowDateTimeStr() };
  writeLS(LS.materialRequests, mrs.map((m, i) => (i === mrIdx ? updatedMr : m)));

  const jcs = getJobCards();
  const jcIdx = jcs.findIndex((j) => j.jobCardNumber === mr.jobCardNumber);
  if (jcIdx !== -1) {
    const jcsNext = [...jcs];
    jcsNext[jcIdx] = { ...jcsNext[jcIdx], materialStatus: updatedStatus, lastMaterialUpdate: nowDateTimeStr() };
    writeLS(LS.productionJobCards, jcsNext);
  }

  appendAuditLog({
    action: 'MATERIAL ISSUED',
    reference: issueNumber,
    details: `Received by ${receiver.name} (${receiver.employeeId}) | MR ${mrNumber} | Job Card ${siJobCard || '—'}${siPoNumber ? ` | PO ${siPoNumber}` : ''}${siCustomer ? ` | ${siCustomer}` : ''}`
  });

  if (updatedStatus === STATUS.FULL) {
    pushNotification({ title: 'Material Fully Issued', message: `All materials for MR ${mrNumber} (Job Card ${mr.jobCardNumber}) have been issued. You can close this MR.`, type: 'success', reference: issueNumber, targetDept: 'Production Department' });
  } else {
    pushNotification({ title: 'Partial Issue', message: `Material Request ${mrNumber} has been partially issued. Remaining items pending.`, type: 'info', reference: issueNumber, targetDept: 'Production Department' });
  }

  return si;
};

export const returnMaterial = ({ issueNumber, receiver, items, remarks = '' }) => {
  if (!hasPermission('material_return.create')) throw new Error('Permission denied: material_return.create');
  const si = getStoreIssues().find((i) => i.issueNumber === issueNumber);
  if (!si) throw new Error('Store Issue not found.');
  if (!receiver || !receiver.name) throw new Error('Returning employee must be selected from the employee master.');
  if (!receiver.acknowledged) throw new Error('Return acknowledgement checkbox is required.');

  const allReturns = getMaterialReturns();
  const siReturns = allReturns.filter((r) => r.issueNumber === issueNumber);

  const returnNumber = generateSRNumber();
  const inv = getInventoryItems();
  const now = new Date();
  const info = getCurrentUserInfo();

  const prepared = [];
  (items || []).forEach((line) => {
    const qty = Number(line.quantityReturned) || 0;
    if (qty <= 0) return;
    const siLine = (si.items || []).find((l) => l.materialId === line.materialId);
    if (!siLine) throw new Error(`Material "${line.materialName || line.materialId}" was not part of this Store Issue.`);
    const issuedQty = Number(siLine.currentIssueQty) || 0;
    const alreadyReturned = siReturns.reduce((a, r) => {
      const rl = r.items || [];
      return a + (rl.find((x) => x.materialId === line.materialId)?.quantityReturned || 0);
    }, 0);
    const maxReturnable = Math.max(0, (Number(siLine.totalIssued) || issuedQty) - alreadyReturned);
    if (qty > maxReturnable) {
      throw new Error(`Cannot return ${qty} of "${line.materialName || line.materialId}" — only ${maxReturnable} can be returned.`);
    }
    const invItem = inv.find((i) => i.itemCode === line.materialId);
    prepared.push({
      materialId: line.materialId,
      materialName: line.materialName || siLine.materialName,
      materialDesc: line.materialDesc || siLine.materialDesc || '',
      unit: line.unit || siLine.unit || invItem?.unit || 'Nos',
      quantityIssued: Number(siLine.currentIssueQty) || 0,
      quantityReturned: qty,
      returnReason: line.reason || line.returnReason || '',
      batchNo: line.batchNo || siLine.batchNo || '',
      lotNumber: line.lotNumber || siLine.lotNumber || '',
      heatNumber: line.heatNumber || siLine.heatNumber || ''
    });
  });

  if (prepared.length === 0) throw new Error('Enter a return quantity for at least one material.');

  const updatedInv = inv.map((item) => {
    const line = prepared.find((p) => p.materialId === item.itemCode);
    if (line) return { ...item, currentQty: (Number(item.currentQty) || 0) + line.quantityReturned };
    return item;
  });
  writeLS(LS.inventoryItems, updatedInv);

  prepared.forEach((line) => {
    const invItem = updatedInv.find((i) => i.itemCode === line.materialId);
    pushStockTransaction(
      {
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: now.toISOString().slice(0, 10),
        dateTime: nowDateTimeStr(),
        itemCode: line.materialId,
        itemName: line.materialName,
        unit: line.unit,
        type: 'IN',
        quantity: line.quantityReturned,
        balanceAfter: invItem ? invItem.currentQty : 0,
        reason: 'Store Return',
        reference: returnNumber,
        transactionNumber: returnNumber,
        issueNumber,
        mrNumber: si.mrNumber,
        jobCardNumber: si.jobCardNumber,
        projectId: si.projectId || '',
        projectName: si.projectName || '',
        returnedBy: receiver.name,
        returnedById: receiver.employeeId,
        receivedBy: info.employee?.name || info.auth?.username || 'Store',
        batchNo: line.batchNo,
        lotNumber: line.lotNumber || '',
        heatNumber: line.heatNumber
      },
      { transactionNumber: returnNumber }
    );
  });

  const record = {
    returnNumber,
    returnDate: now.toISOString().slice(0, 10),
    returnTime: nowTimeStr(),
    issueNumber,
    mrNumber: si.mrNumber,
    jobCardNumber: si.jobCardNumber || '',
    salesOrderRef: si.salesOrderRef || '',
    projectId: si.projectId || '',
    projectName: si.projectName || '',
    customer: si.customer || '',
    partName: si.partName || '',
    returnedBy: receiver.name,
    returnedById: receiver.employeeId,
    returnedByDept: receiver.department || '',
    returnedByDesignation: receiver.designation || '',
    receivedBy: info.employee?.name || info.auth?.username || 'Store',
    receivedById: info.employee?.employeeId || '-',
    receivedByDept: info.employee?.department || 'Store Department',
    acknowledged: true,
    acknowledgedAt: nowDateTimeStr(),
    remarks: remarks || '',
    items: prepared
  };
  writeLS(LS.materialReturnHistory, [record, ...allReturns]);
  saveSequenceCounter('materialReturnSequence', returnNumber);

  appendAuditLog({
    action: 'MATERIAL RETURNED',
    reference: returnNumber,
    details: `Returned by ${receiver.name} (${receiver.employeeId}) against SI ${issueNumber} | ${prepared.length} material(s)`
  });
  pushNotification({ title: 'Material Returned', message: `Material Return ${returnNumber} received from ${receiver.name}.`, type: 'success', reference: returnNumber });

  return record;
};

export const createPurchaseRequestForShortage = ({ mrNumber, items, remarks = '' }) => {
  if (!hasPermission('purchase_request.create')) throw new Error('Permission denied: purchase_request.create');
  const mr = getMaterialRequests().find((m) => m.mrNumber === mrNumber);
  if (!mr) throw new Error('Material Request not found.');
  const shortages = (items || []).filter((it) => Number(it.shortage) > 0);
  if (shortages.length === 0) throw new Error('No shortage found for the selected materials.');

  const prNumber = generatePRNumber();
  const info = getCurrentUserInfo();
  const record = {
    prNumber,
    prDate: todayStr(),
    mrNumber,
    jobCardNumber: mr.jobCardNumber || '',
    partName: mr.partName || '',
    projectId: mr.projectId || '',
    projectName: mr.projectName || '',
    requestedBy: info.employee?.name || info.auth?.username || 'Store',
    requestedById: info.employee?.employeeId || '-',
    department: info.employee?.department || 'Store Department',
    priority: mr.priority || 'Normal',
    remarks: remarks || `Shortage against MR ${mrNumber}`,
    status: 'Pending Approval',
    items: shortages.map((it) => ({
      materialId: it.materialId,
      materialName: it.materialName,
      unit: it.unit || 'Nos',
      requiredQty: Number(it.requiredQty) || 0,
      issuedQty: Number(it.issued) || 0,
      balanceQty: Number(it.balance) || 0,
      availableQty: Number(it.available) || 0,
      shortageQty: Number(it.shortage) || 0
    })),
    createdAt: nowDateTimeStr()
  };
  writeLS(LS.storePurchaseRequests, [record, ...getPurchaseRequests()]);
  saveSequenceCounter('storePurchaseRequestSequence', prNumber);
  appendAuditLog({ action: 'PURCHASE REQUEST CREATED', reference: prNumber, details: `Shortage for ${shortages.length} material(s) against MR ${mrNumber}` });
  pushNotification({ title: 'New Purchase Request', message: `Purchase Request ${prNumber} created for material shortage against MR ${mrNumber}. Awaiting Purchase Manager review.`, type: 'purchase', reference: prNumber, targetDept: 'Purchase Department', targetRole: 'purchase_manager' });
  return record;
};

export const approvePurchaseRequest = (prNumber, approvalRemarks = '') => {
  if (!hasPermission('purchase_request.approve')) throw new Error('Permission denied: purchase_request.approve');
  const list = getPurchaseRequests();
  const idx = list.findIndex((p) => p.prNumber === prNumber);
  if (idx === -1) throw new Error('Purchase Request not found.');
  const pr = list[idx];
  if (pr.status !== 'Pending Approval') throw new Error(`Can only approve a Pending PR. Current status: ${pr.status}`);
  const info = getCurrentUserInfo();
  const updated = list.map((p, i) => (i === idx ? {
    ...p,
    status: 'Approved',
    approvedBy: info.employee?.name || info.auth?.username || 'User',
    approvedByEmpId: info.employee?.employeeId || '-',
    approvedAt: nowDateTimeStr(),
    approvalRemarks: approvalRemarks || ''
  } : p));
  writeLS(LS.storePurchaseRequests, updated);
  appendAuditLog({ action: 'PURCHASE REQUEST APPROVED', reference: prNumber, details: `Approved by ${info.employee?.name || 'User'}. ${approvalRemarks || ''}` });
  pushNotification({ title: 'Purchase Request Approved', message: `Purchase Request ${prNumber} has been approved. You can now create a PO.`, type: 'success', reference: prNumber, targetDept: 'Purchase Department' });
  return updated[idx];
};

export const rejectPurchaseRequest = (prNumber, reason = '') => {
  if (!hasPermission('purchase_request.approve')) throw new Error('Permission denied: purchase_request.approve');
  if (!reason || !reason.trim()) throw new Error('Rejection reason is required.');
  const list = getPurchaseRequests();
  const idx = list.findIndex((p) => p.prNumber === prNumber);
  if (idx === -1) throw new Error('Purchase Request not found.');
  const updated = list.map((p, i) => (i === idx ? {
    ...p,
    status: 'Rejected',
    rejectionReason: reason,
    rejectedAt: nowDateTimeStr()
  } : p));
  writeLS(LS.storePurchaseRequests, updated);
  appendAuditLog({ action: 'PURCHASE REQUEST REJECTED', reference: prNumber, details: reason });
  pushNotification({ title: 'Purchase Request Rejected', message: `Purchase Request ${prNumber} was rejected: ${reason}`, type: 'warning', reference: prNumber });
  return updated[idx];
};

export const getJobCardMaterialProfile = (jobCardNumber) => {
  const mrs = getMaterialRequests().filter((m) => m.jobCardNumber === jobCardNumber);
  return mrs.map((mr) => {
    const totals = getMRMaterialTotals(mr.mrNumber);
    const status = computeEffectiveMRStatus(mr, totals);
    const issues = getStoreIssues().filter((i) => i.mrNumber === mr.mrNumber);
    return { mr: decorateMR(mr), status, issues, totals };
  });
};

/* =====================================================================================
 * INVENTORY MODULE (integrated with the existing Store module)
 * Transaction-based stock: every movement is logged in stockTransactions and derives
 * the ledger. No separate manually-maintained balances.
 * ===================================================================================== */

const canCreateGRN = () => hasPermission('material_issue.confirm') || hasPermission('inventory.adjust');
const canApproveStockOps = () => hasPermission('inventory.adjust');
const canAdjustStock = () => hasPermission('inventory.adjust');

export const getGRNs = () => readLS(LS.storeGRNs, []);
export const getStockTransfers = () => readLS(LS.stockTransfers, []);
export const getStockVerifications = () => readLS(LS.stockVerifications, []);
export const getInventoryBatches = () => readLS(LS.inventoryBatches, []);

/* ------------------------------ shelf life / expiry ------------------------------
 * Best-practice model shared by SAP, Odoo and ERPNext:
 *   - Expiry is captured on the receiving line (mfg date + expiry date).
 *   - Stock is issued FEFO — First Expiry, First Out.
 *   - Expired stock is hard-blocked at issue and can only leave through an
 *     audited write-off (disposal) entry.
 *   - A watchlist surfaces what is expiring soon so it gets consumed in time.
 * --------------------------------------------------------------------------------- */

/** Days before expiry at which a batch is flagged "Near Expiry". */
export const EXPIRY_NEAR_DAYS = 30;

/**
 * Expiry state of a single batch.
 * @returns {{status: 'EXPIRED'|'NEAR'|'VALID'|'UNKNOWN', daysLeft: number|null}}
 */
export const getExpiryStatus = (expiryDate, nearDays = EXPIRY_NEAR_DAYS) => {
  if (!expiryDate) return { status: 'UNKNOWN', daysLeft: null };
  const exp = new Date(`${String(expiryDate).slice(0, 10)}T23:59:59`);
  if (Number.isNaN(exp.getTime())) return { status: 'UNKNOWN', daysLeft: null };
  const daysLeft = Math.ceil((exp.getTime() - Date.now()) / 86400000);
  if (daysLeft < 0) return { status: 'EXPIRED', daysLeft };
  if (daysLeft <= nearDays) return { status: 'NEAR', daysLeft };
  return { status: 'VALID', daysLeft };
};

export const EXPIRY_STATUS_LABEL = {
  EXPIRED: 'Expired',
  NEAR: 'Near Expiry',
  VALID: 'Valid',
  UNKNOWN: 'No Expiry'
};

/**
 * FEFO-ordered shelf-life watchlist: every open batch that carries an expiry
 * date (or belongs to a shelf-life-managed item), soonest expiry first.
 */
export const getExpiryWatchList = () => {
  const items = getInventoryItems();
  const itemFor = (code) =>
    items.find((i) => String(i.itemCode || '').toLowerCase() === String(code || '').toLowerCase());

  return getInventoryBatches()
    .map((b) => {
      const item = itemFor(b.itemCode);
      const { status, daysLeft } = getExpiryStatus(b.expiryDate);
      return {
        ...b,
        itemName: b.itemName || item?.itemName || '',
        unit: item?.unit || 'Nos',
        shelfLifeManaged: Boolean(item?.shelfLifeManaged),
        status,
        daysLeft
      };
    })
    .filter((b) => (Number(b.availableQty) || 0) > 0 && (b.expiryDate || b.shelfLifeManaged))
    .sort((a, b) => {
      // FEFO: soonest expiry first; batches without a date sort last.
      const av = a.expiryDate || '9999-12-31';
      const bv = b.expiryDate || '9999-12-31';
      return av.localeCompare(bv);
    });
};

/** Batch record created from a receiving line (used by GRN + QC posting paths). */
export const addInventoryBatch = (batch) => {
  if (!batch || (!batch.batchNumber && !batch.internalBatchId)) return null;
  const record = {
    id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...batch,
    batchNumber: batch.batchNumber || '',
    supplierBatchNumber: batch.supplierBatchNumber || batch.batchNumber || '',
    status: batch.status || 'In Stock'
  };
  const list = getInventoryBatches();
  const existingIndex = list.findIndex((item) =>
    (record.internalBatchId && item.internalBatchId === record.internalBatchId) ||
    (!record.internalBatchId && item.itemCode === record.itemCode && item.batchNumber === record.batchNumber &&
      item.grnNumber === record.grnNumber && record.batchNumber)
  );
  if (existingIndex >= 0) {
    const updated = { ...list[existingIndex], ...record, id: list[existingIndex].id };
    list[existingIndex] = updated;
    writeLS(LS.inventoryBatches, list);
    return updated;
  }
  writeLS(LS.inventoryBatches, [record, ...list]);
  return record;
};

/**
 * Expired stock leaves inventory ONLY through this audited write-off.
 * Reduces the batch's available quantity and the item's balance, and logs a
 * stock transaction with reason "Expiry Write-off".
 */
export const writeOffExpiredBatch = ({ batchId, qty = 0, reason = '' }) => {
  if (!canAdjustStock()) throw new Error('Permission denied: inventory.adjust required for write-off.');

  const batches = getInventoryBatches();
  const idx = batches.findIndex((b) => b.id === batchId);
  if (idx === -1) throw new Error('Batch not found.');

  const batch = batches[idx];
  const { status, daysLeft } = getExpiryStatus(batch.expiryDate);
  if (status !== 'EXPIRED') {
    throw new Error(
      `Batch ${batch.batchNumber} is not expired (${batch.expiryDate || 'no expiry date recorded'}, ${daysLeft ?? '?'} day(s) left) — write-off is only allowed for expired stock.`
    );
  }

  const available = Number(batch.availableQty) || 0;
  const writeQty = Number(qty) > 0 ? Math.min(Number(qty), available) : available;
  if (writeQty <= 0) throw new Error(`Nothing available to write off for batch ${batch.batchNumber}.`);

  const newAvailable = available - writeQty;
  const operator = getCurrentUserInfo();
  const updatedBatch = {
    ...batch,
    availableQty: newAvailable,
    status: newAvailable > 0 ? 'In Stock' : 'Expired - Written Off',
    writtenOffQty: (Number(batch.writtenOffQty) || 0) + writeQty,
    writtenOffAt: nowDateTimeStr(),
    writtenOffBy: operator.employee?.name || operator.auth?.username || 'Store',
    writeOffReason: reason || 'Expired — disposal'
  };
  const nextBatches = [...batches];
  nextBatches[idx] = updatedBatch;
  writeLS(LS.inventoryBatches, nextBatches);

  // Reduce the item balance by the written-off quantity.
  const items = getInventoryItems();
  const itemIdx = items.findIndex(
    (it) => String(it.itemCode || '').toLowerCase() === String(batch.itemCode || '').toLowerCase()
  );
  let balanceAfter = Number(items[itemIdx]?.currentQty) || 0;
  if (itemIdx !== -1) {
    balanceAfter = Math.max(0, balanceAfter - writeQty);
    const nextItems = [...items];
    nextItems[itemIdx] = { ...items[itemIdx], currentQty: balanceAfter };
    writeLS(LS.inventoryItems, nextItems);
  }

  const woNumber = generateSequentialNumber({
    prefix: 'WO',
    sequenceKey: 'expiryWriteOffSequence',
    historyKey: LS.stockTransactions,
    idField: 'transactionNumber'
  });

  pushStockTransaction({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: todayStr(),
    dateTime: nowDateTimeStr(),
    itemCode: batch.itemCode || '-',
    itemName: batch.itemName || '',
    unit: updatedBatch.unit || 'Nos',
    type: 'OUT',
    quantity: writeQty,
    balanceAfter,
    reason: 'Expiry Write-off',
    reference: woNumber,
    transactionNumber: woNumber,
    batchNo: batch.batchNumber || '',
    lotNumber: batch.lotNumber || '',
    expiryDate: batch.expiryDate || '',
    supplier: batch.supplier || '',
    remarks: reason || 'Expired stock disposed',
    writtenOffBy: updatedBatch.writtenOffBy
  });

  appendAuditLog({
    action: 'EXPIRY WRITE-OFF',
    reference: woNumber,
    details: `${writeQty} ${updatedBatch.unit || 'unit(s)'} of ${batch.itemName || batch.itemCode} | Batch ${batch.batchNumber} expired ${batch.expiryDate}${reason ? ` | ${reason}` : ''}`
  });

  return { ...updatedBatch, writeOffNumber: woNumber, writtenOffQty: writeQty };
};

export const generateGRNNumber = () =>
  generateSequentialNumber({ prefix: 'GRN', sequenceKey: 'grnSequence', historyKey: LS.storeGRNs, idField: 'grnNumber' });

export const generateTransferNumber = () =>
  generateSequentialNumber({ prefix: 'ST', sequenceKey: 'stockTransferSequence', historyKey: LS.stockTransfers, idField: 'transferNumber' });

export const generateVerificationNumber = () =>
  generateSequentialNumber({ prefix: 'SV', sequenceKey: 'stockVerificationSequence', historyKey: LS.stockVerifications, idField: 'verificationNumber' });

const matchInventoryItem = (items, code, name) =>
  items.find(
    (it) =>
      (code && String(it.itemCode || '').toLowerCase() === String(code).toLowerCase()) ||
      (name && it.itemName && String(it.itemName).toLowerCase() === String(name).toLowerCase())
  );

const recordBatch = (batch) => {
  const list = getInventoryBatches();
  writeLS(LS.inventoryBatches, [{ id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...batch }, ...list]);
};

/* ------------------------------- GRN / material receipt ------------------------------- */

/**
 * Business rule: NO QUALITY APPROVAL = NO INVENTORY UPDATE.
 *
 * A GRN records a physical delivery only. It can never increase available
 * inventory on its own — that is reserved for Quality approved quantity
 * (workflowService.postApprovedMaterialToInventory). `qcNumber` is therefore
 * mandatory: the referenced Quality Check must exist and be Approved /
 * Partially Approved before a single unit is posted.
 */
export const createGRN = ({
  poRef = '',
  supplier = '',
  supplierInvoice = '',
  invoiceDate = '',
  receivedBy = '',
  items = [],
  qcNumber = ''
}) => {
  if (!canCreateGRN()) throw new Error('Permission denied: not a Store role.');

  const qualityChecks = readLS('qualityChecks', []);
  const qc = String(qcNumber || '').trim()
    ? qualityChecks.find((q) => String(q.qcNumber) === String(qcNumber).trim())
    : null;
  if (!qc) {
    throw new Error(
      'A Goods Receipt Note cannot post to inventory. Record the delivery as a Tax Invoice / Material Receipt, complete the Quality Check, then post the accepted quantity.'
    );
  }
  if (!['Approved', 'Partially Approved'].includes(qc.status)) {
    throw new Error(
      `Quality Check ${qc.qcNumber} is "${qc.status}". Inventory can only be updated for Approved / Partially Approved material.`
    );
  }
  if (qc.postedToInventory) {
    throw new Error(`Quality Check ${qc.qcNumber} has already been posted to inventory.`);
  }

  const lines = (items || []).filter((l) => Number(l.receivedQty) || 0 > 0);
  if (lines.length === 0) throw new Error('Enter a received quantity for at least one item.');

  lines.forEach((l) => {
    const received = Number(l.receivedQty) || 0;
    const accepted = Number(l.acceptedQty) || 0;
    const rejected = Number(l.rejectedQty) || 0;
    if (accepted < 0 || rejected < 0) throw new Error('Quantities cannot be negative.');
    if (accepted + rejected > received) {
      throw new Error(`Accepted + Rejected (${accepted + rejected}) exceeds Received (${received}) for "${l.itemName || l.itemCode}".`);
    }
    if (l.qcStatus === 'Rejected' && accepted !== 0) {
      throw new Error(`QC status is Rejected for "${l.itemName || l.itemCode}" — accepted quantity must be 0.`);
    }
    // Shelf life: an expiry date only makes sense on an identified batch, and
    // already-expired material must never enter the store.
    if (l.expiryDate && !String(l.batchNumber || '').trim()) {
      throw new Error(`Enter a Batch / Lot number for "${l.itemName || l.itemCode}" — expiry dates are tracked per batch.`);
    }
    if (l.expiryDate && getExpiryStatus(l.expiryDate).status === 'EXPIRED') {
      throw new Error(
        `Expired material refused: "${l.itemName || l.itemCode}" carries expiry date ${l.expiryDate}. Raise a Debit Note against the supplier instead of receiving it.`
      );
    }
  });

  const grnNumber = generateGRNNumber();
  const info = getCurrentUserInfo();
  const inv = getInventoryItems();
  let updatedInv = inv;

  lines.forEach((l) => {
    const accepted = Number(l.acceptedQty) || 0;
    if (accepted <= 0) return;

    const matchIdx = updatedInv.findIndex(
      (it) =>
        (l.itemCode && String(it.itemCode || '').toLowerCase() === String(l.itemCode).toLowerCase()) ||
        (l.itemName && it.itemName && String(it.itemName).toLowerCase() === String(l.itemName).toLowerCase())
    );

    let finalBalance = accepted;
    if (matchIdx !== -1) {
      const cur = Number(updatedInv[matchIdx].currentQty) || 0;
      updatedInv[matchIdx] = { ...updatedInv[matchIdx], currentQty: cur + accepted };
      finalBalance = cur + accepted;
    } else {
      updatedInv = [
        {
          id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemCode: l.itemCode || `PRAG-MAT-${Math.floor(100 + Math.random() * 900)}`,
          itemName: l.itemName,
          category: 'Raw Material',
          hsnSac: l.hsnSac || '',
          unit: l.unit || 'Nos',
          currentQty: accepted,
          reservedQty: 0,
          minReorderLevel: Number(l.minReorderLevel) || 10,
          unitCost: Number(l.unitCost) || 0,
          sellingPrice: (Number(l.unitCost) || 0) * 1.3,
          location: l.location || 'Main Store',
          warehouse: l.warehouse || 'Main Store',
          itemType: 'PO Linked'
        },
        ...updatedInv
      ];
      finalBalance = accepted;
    }

    pushStockTransaction(
      {
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: todayStr(),
        dateTime: nowDateTimeStr(),
        itemCode: l.itemCode || '-',
        itemName: l.itemName,
        unit: l.unit || 'Nos',
        type: 'IN',
        quantity: accepted,
        balanceAfter: finalBalance,
        reason: 'GRN',
        reference: grnNumber,
        transactionNumber: grnNumber,
        poReference: poRef || '',
        supplier: supplier || '',
        batchNo: l.batchNumber || '',
        lotNumber: l.lotNumber || '',
        warehouse: l.warehouse || '',
        rack: l.rack || '',
        shelf: l.shelf || '',
        bin: l.bin || '',
        qcStatus: l.qcStatus || 'Passed',
        acceptedQty: accepted,
        rejectedQty: Number(l.rejectedQty) || 0
      },
      { transactionNumber: grnNumber }
    );

    if (l.batchNumber) {
      recordBatch({
        batchNumber: l.batchNumber,
        lotNumber: l.lotNumber || '',
        itemCode: l.itemCode || '',
        itemName: l.itemName,
        supplier: supplier || '',
        grnNumber,
        receivedDate: todayStr(),
        mfgDate: l.mfgDate || '',
        expiryDate: l.expiryDate || '',
        qtyReceived: accepted,
        availableQty: accepted,
        warehouse: l.warehouse || '',
        rack: l.rack || '',
        shelf: l.shelf || '',
        bin: l.bin || '',
        status: 'In Stock'
      });
    }
  });

  writeLS(LS.inventoryItems, updatedInv);

  const grn = {
    grnNumber,
    grnDate: todayStr(),
    poRef,
    supplier,
    supplierInvoice,
    invoiceDate,
    receivedBy,
    receivedById: info.employee?.employeeId || '-',
    receivedByDept: info.employee?.department || 'Store Department',
    createdBy: info.employee?.name || info.auth?.username || 'Store',
    createdAt: nowDateTimeStr(),
    items: lines.map((l) => ({
      itemCode: l.itemCode || '',
      itemName: l.itemName,
      unit: l.unit || 'Nos',
      orderedQty: Number(l.orderedQty) || 0,
      receivedQty: Number(l.receivedQty) || 0,
      acceptedQty: Number(l.acceptedQty) || 0,
      rejectedQty: Number(l.rejectedQty) || 0,
      batchNumber: l.batchNumber || '',
      lotNumber: l.lotNumber || '',
      mfgDate: l.mfgDate || '',
      expiryDate: l.expiryDate || '',
      warehouse: l.warehouse || '',
      rack: l.rack || '',
      shelf: l.shelf || '',
      bin: l.bin || '',
      qcStatus: l.qcStatus || 'Passed',
      remarks: l.remarks || ''
    }))
  };
  writeLS(LS.storeGRNs, [grn, ...getGRNs()]);
  saveSequenceCounter('grnSequence', grnNumber);
  appendAuditLog({ action: 'GRN CREATED', reference: grnNumber, details: `${lines.length} line(s) received; accepted quantity posted to inventory.` });
  pushNotification({
    title: 'Goods Receipt Note',
    message: `GRN ${grnNumber} posted — ${lines.filter((l) => Number(l.acceptedQty) > 0).length} line(s) added to inventory.`,
    type: 'store',
    reference: grnNumber
  });
  return grn;
};

/* --------------------------- item-wise PO receiving (Store POS) --------------------------- */

/**
 * DEPRECATED / DISABLED — direct Purchase Order → Inventory path removed.
 *
 * Business rule: NO QUALITY APPROVAL = NO INVENTORY UPDATE. A Purchase Order
 * (and a material receipt raised against it) never increases available stock.
 * The function is kept only so old callers fail loudly with the correct
 * instruction instead of silently bypassing the workflow.
 *
 * Required path:
 *   PO → Store Tax Invoice / Material Receipt → Quality Check
 *      → Accepted Quantity → Inventory   (workflowService)
 */
export const receivePurchaseOrderItems = ({ po } = {}) => {
  const poRef = po?.reference || po?.payload?.poDetails?.poNumber || '';
  throw new Error(
    `Direct PO receipt into inventory is disabled${
      poRef ? ` for ${poRef}` : ''
    }. Use Tax Invoice / Material Receipt → Quality Check; only quality approved quantity is added to inventory.`
  );
};

/* ---------------------------------- item master + quick adjustment ---------------------------------- */

/**
 * Add a new material/item with the SAME structure and validation Admin uses in the
 * inventory master (LS key inventoryItems is shared). Duplicate item codes are
 * rejected so code-based workflows (receiving, issuing, reorder) stay unambiguous.
 */
export const addInventoryItem = ({
  itemCode = '',
  itemName = '',
  category = 'Standard Part',
  hsnSac = '',
  unit = 'Nos',
  currentQty = 0,
  minReorderLevel = 0,
  unitCost = 0,
  sellingPrice = 0,
  location = '',
  warehouse = '',
  itemType = 'Regular Usage'
}) => {
  if (!canAdjustStock()) throw new Error('Permission denied: inventory.adjust');
  const codeIn = String(itemCode || '').trim();
  const name = String(itemName || '').trim();
  if (!name) throw new Error('Please fill in Item Name.');
  const inv = getInventoryItems();
  const isTaken = (c) => inv.some((it) => String(it.itemCode || '').toLowerCase() === String(c).toLowerCase());
  let code = codeIn;
  if (code) {
    if (isTaken(code)) throw new Error('An item with this Item Code already exists.');
  } else {
    let attempts = 0;
    code = `PRAG-${Math.floor(100 + Math.random() * 900)}`;
    while (isTaken(code) && attempts < 50) {
      code = `PRAG-${Math.floor(100 + Math.random() * 900)}`;
      attempts += 1;
    }
    if (isTaken(code)) code = `PRAG-${Date.now().toString(36).toUpperCase()}`;
  }
  const openingQty = Number(currentQty) || 0;
  if (openingQty < 0) throw new Error('Quantity cannot be negative.');
  const item = {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    itemCode: code,
    itemName: name,
    category: category || 'Standard Part',
    hsnSac: String(hsnSac || ''),
    unit: unit || 'Nos',
    currentQty: openingQty,
    reservedQty: 0,
    minReorderLevel: Math.max(0, Number(minReorderLevel) || 0),
    unitCost: Number(unitCost) || 0,
    sellingPrice: Number(sellingPrice) || 0,
    location: location || '',
    warehouse: warehouse || location || '',
    itemType: itemType || 'Regular Usage'
  };
  writeLS(LS.inventoryItems, [item, ...inv]);
  appendAuditLog({ action: 'INVENTORY ITEM ADDED', reference: code, details: `${name} (${code})` });
  return item;
};

/**
 * Quick Stock In/Out adjustment, mirroring the Admin Inventory page: delta-based
 * IN/OUT movement, reason + optional reference, quantized to the same inventory
 * master and stock-transaction history. Stock can never go below zero.
 */
export const adjustInventoryStock = ({
  itemId = '',
  itemCode = '',
  adjustType = 'IN',
  quantity,
  reason = '',
  reference = '',
  date = ''
}) => {
  if (!canAdjustStock()) throw new Error('Permission denied: inventory.adjust');
  const qtyChange = Number(quantity);
  if (!qtyChange || qtyChange <= 0) throw new Error('Please enter a valid quantity greater than zero.');
  const inv = getInventoryItems();
  const target = inv.find(
    (it) => (itemId && it.id === itemId) || (!itemId && itemCode && String(it.itemCode || '').toLowerCase() === String(itemCode).toLowerCase())
  );
  if (!target) throw new Error('Item not found in the inventory master.');

  const current = Number(target.currentQty) || 0;
  let newQty = current;
  if (adjustType === 'IN') {
    newQty = current + qtyChange;
  } else {
    newQty = Math.max(0, current - qtyChange);
  }

  writeLS(LS.inventoryItems, inv.map((it) => (it.id === target.id ? { ...it, currentQty: newQty } : it)));

  pushStockTransaction({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: date || todayStr(),
    dateTime: nowDateTimeStr(),
    itemCode: target.itemCode,
    itemName: target.itemName,
    unit: target.unit || 'Nos',
    type: adjustType,
    quantity: qtyChange,
    balanceAfter: newQty,
    reason: reason.trim() ? reason.trim() : (adjustType === 'IN' ? 'Stock Inward (Purchase)' : 'Production Consumption'),
    reference: reference || '-'
  });

  appendAuditLog({
    action: 'QUICK STOCK ADJUSTMENT',
    reference: reference || '-',
    details: `${target.itemName} (${target.itemCode}): ${current} -> ${newQty} (${adjustType} ${qtyChange})`
  });

  return {
    id: target.id,
    itemCode: target.itemCode,
    itemName: target.itemName,
    previousQty: current,
    newQty,
    type: adjustType,
    quantity: qtyChange
  };
};

/* ---------------------------------- stock transfer ---------------------------------- */

export const createStockTransfer = ({ fromWarehouse = '', toWarehouse = '', toLocation = '', requestedBy = '', requestedByEmpId = '', remarks = '', items = [] }) => {
  if (!canCreateGRN()) throw new Error('Permission denied: not a Store role.');
  const lines = (items || []).filter((l) => Number(l.quantity) > 0);
  if (lines.length === 0) throw new Error('Enter a transfer quantity for at least one item.');
  if (!fromWarehouse.trim() || !toWarehouse.trim()) throw new Error('From and To warehouse/location are required.');

  lines.forEach((l) => {
    const qty = Number(l.quantity) || 0;
    const inv = getInventoryItems();
    const src = matchInventoryItem(inv, l.itemCode, l.itemName);
    if (!src) throw new Error(`Source item "${l.itemName || l.itemCode}" not found in inventory.`);
    if (qty > Number(src.currentQty) || 0) {
      throw new Error(`Insufficient stock at source for "${l.itemName || l.itemCode}" (available ${src.currentQty} ${src.unit || 'Nos'}).`);
    }
    if (String(src.warehouse || src.location || '').toLowerCase() === String(toWarehouse).toLowerCase()) {
      throw new Error(`Source and destination warehouse are the same for "${l.itemName || l.itemCode}".`);
    }
  });

  const transferNumber = generateTransferNumber();
  const info = getCurrentUserInfo();
  const transfer = {
    transferNumber,
    transferDate: todayStr(),
    fromWarehouse,
    toWarehouse,
    toLocation,
    requestedBy,
    requestedByEmpId,
    requestedById: info.employee?.employeeId || '-',
    grantedBy: info.employee?.name || info.auth?.username || 'Store',
    remarks: remarks || '',
    status: 'Pending',
    createdAt: nowDateTimeStr(),
    items: lines.map((l) => ({
      itemCode: l.itemCode || '',
      itemName: l.itemName,
      unit: l.unit || 'Nos',
      quantity: Number(l.quantity) || 0,
      batchNumber: l.batchNumber || ''
    }))
  };
  writeLS(LS.stockTransfers, [transfer, ...getStockTransfers()]);
  saveSequenceCounter('stockTransferSequence', transferNumber);
  appendAuditLog({ action: 'STOCK TRANSFER REQUESTED', reference: transferNumber, details: `${fromWarehouse} -> ${toWarehouse}` });
  pushNotification({ title: 'Stock Transfer', message: `Transfer ${transferNumber} raised (${fromWarehouse} -> ${toWarehouse}), awaiting approval.`, type: 'store', reference: transferNumber });
  return transfer;
};

/** Approval is the point when stock actually moves (OUT from source, IN to destination). */
export const approveStockTransfer = (transferNumber) => {
  if (!canApproveStockOps()) throw new Error('Permission denied: only Store Manager / Admin can approve transfers.');
  const list = getStockTransfers();
  const idx = list.findIndex((t) => t.transferNumber === transferNumber);
  if (idx === -1) throw new Error('Stock Transfer not found.');
  const transfer = list[idx];
  if (transfer.status !== 'Pending') throw new Error(`Transfer ${transferNumber} is already ${transfer.status}.`);

  const inv = getInventoryItems();
  let updatedInv = [...inv];

  transfer.items.forEach((line) => {
    const qty = Number(line.quantity) || 0;
    const srcIdx = updatedInv.findIndex(
      (it) =>
        (line.itemCode && String(it.itemCode || '').toLowerCase() === String(line.itemCode).toLowerCase()) ||
        (line.itemName && it.itemName && String(it.itemName).toLowerCase() === String(line.itemName).toLowerCase())
    );
    if (srcIdx === -1) throw new Error(`Source item "${line.itemName || line.itemCode}" not found while approving.`);
    if (qty > Number(updatedInv[srcIdx].currentQty) || 0) {
      throw new Error(`Insufficient source stock for "${line.itemName || line.itemCode}".`);
    }
    const src = updatedInv[srcIdx];
    const srcAfter = Math.max(0, (Number(src.currentQty) || 0) - qty);
    updatedInv[srcIdx] = { ...src, currentQty: srcAfter };

    pushStockTransaction(
      {
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: todayStr(),
        dateTime: nowDateTimeStr(),
        itemCode: line.itemCode || src.itemCode,
        itemName: line.itemName || src.itemName,
        unit: line.unit || src.unit || 'Nos',
        type: 'OUT',
        quantity: qty,
        balanceAfter: srcAfter,
        reason: 'Stock Transfer OUT',
        reference: transferNumber,
        transactionNumber: transferNumber,
        warehouse: transfer.fromWarehouse,
        batchNo: line.batchNumber || '',
        lotNumber: line.lotNumber || ''
      },
      { transactionNumber: transferNumber }
    );

    const destIdx = updatedInv.findIndex(
      (it) =>
        !(Number(it.currentQty) === 0 && String(it.warehouse || it.location || '') !== '') &&
        ((line.itemCode && String(it.itemCode || '').toLowerCase() === String(line.itemCode).toLowerCase()) ||
          (line.itemName && it.itemName && String(it.itemName).toLowerCase() === String(line.itemName).toLowerCase())) &&
        String(it.warehouse || it.location || '').toLowerCase() === String(transfer.toWarehouse).toLowerCase()
    );

    if (destIdx !== -1) {
      const dest = updatedInv[destIdx];
      const destAfter = (Number(dest.currentQty) || 0) + qty;
      updatedInv[destIdx] = { ...dest, currentQty: destAfter };
      pushStockTransaction(
        {
          id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          date: todayStr(),
          dateTime: nowDateTimeStr(),
          itemCode: line.itemCode || dest.itemCode,
          itemName: line.itemName || dest.itemName,
          unit: line.unit || dest.unit || 'Nos',
          type: 'IN',
          quantity: qty,
          balanceAfter: destAfter,
          reason: 'Stock Transfer IN',
          reference: transferNumber,
          transactionNumber: transferNumber,
          warehouse: transfer.toWarehouse,
          batchNo: line.batchNumber || '',
          lotNumber: line.lotNumber || ''
        },
        { transactionNumber: transferNumber }
      );
    } else {
      updatedInv = [
        {
          id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemCode: line.itemCode || src.itemCode,
          itemName: line.itemName || src.itemName,
          category: src.category || 'Raw Material',
          hsnSac: src.hsnSac || '',
          unit: line.unit || src.unit || 'Nos',
          currentQty: qty,
          reservedQty: 0,
          minReorderLevel: src.minReorderLevel || 10,
          unitCost: src.unitCost || 0,
          sellingPrice: src.sellingPrice || (Number(src.unitCost) || 0) * 1.3,
          location: transfer.toLocation || transfer.toWarehouse,
          warehouse: transfer.toWarehouse,
          itemType: src.itemType || 'Regular Usage'
        },
        ...updatedInv
      ];
      pushStockTransaction(
        {
          id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          date: todayStr(),
          dateTime: nowDateTimeStr(),
          itemCode: line.itemCode || src.itemCode,
          itemName: line.itemName || src.itemName,
          unit: line.unit || src.unit || 'Nos',
          type: 'IN',
          quantity: qty,
          balanceAfter: qty,
          reason: 'Stock Transfer IN',
          reference: transferNumber,
          transactionNumber: transferNumber,
          warehouse: transfer.toWarehouse,
          batchNo: line.batchNumber || '',
          lotNumber: line.lotNumber || ''
        },
        { transactionNumber: transferNumber }
      );
    }
  });

  writeLS(LS.inventoryItems, updatedInv);
  const next = [...list];
  next[idx] = { ...transfer, status: 'Completed', approvedBy: getCurrentUserInfo().employee?.name || 'Store', approvedAt: nowDateTimeStr() };
  writeLS(LS.stockTransfers, next);
  appendAuditLog({ action: 'STOCK TRANSFER APPROVED', reference: transferNumber, details: `Completed: ${transfer.fromWarehouse} -> ${transfer.toWarehouse}` });
  pushNotification({ title: 'Stock Transfer Completed', message: `Transfer ${transferNumber} moved ${transfer.items.length} item(s).`, type: 'store', reference: transferNumber });
  return next[idx];
};

/* ----------------------------- physical stock verification ----------------------------- */

export const createStockVerification = ({ itemId = '', itemCode = '', itemName = '', physicalQty, reason = '' }) => {
  if (!canCreateGRN()) throw new Error('Permission denied: not a Store role.');
  const inv = getInventoryItems();
  const target = inv.find((i) => i.id === itemId) || matchInventoryItem(inv, itemCode, itemName);
  if (!target) throw new Error('Select an inventory item to verify.');
  const physical = Number(physicalQty);
  if (Number.isNaN(physical) || physical < 0) throw new Error('Physical quantity must be a non-negative number.');

  const verificationNumber = generateVerificationNumber();
  const info = getCurrentUserInfo();
  const verification = {
    verificationNumber,
    date: todayStr(),
    itemId: target.id,
    itemCode: target.itemCode,
    itemName: target.itemName,
    unit: target.unit || 'Nos',
    systemQty: Number(target.currentQty) || 0,
    physicalQty: physical,
    difference: physical - (Number(target.currentQty) || 0),
    reason: reason || '',
    verifiedBy: info.employee?.name || info.auth?.username || 'Store',
    verifiedById: info.employee?.employeeId || '-',
    status: 'Pending Approval',
    createdAt: nowDateTimeStr(),
    approvedBy: '',
    approvedAt: ''
  };
  writeLS(LS.stockVerifications, [verification, ...getStockVerifications()]);
  saveSequenceCounter('stockVerificationSequence', verificationNumber);
  appendAuditLog({ action: 'PHYSICAL VERIFICATION RECORDED', reference: verificationNumber, details: `${target.itemName} system ${verification.systemQty} vs physical ${physical}` });
  pushNotification({
    title: 'Physical Verification',
    message: `Verification ${verificationNumber} recorded (difference ${verification.difference >= 0 ? '+' : ''}${verification.difference}), awaiting approval.`,
    type: 'store',
    reference: verificationNumber
  });
  return verification;
};

/** Authorized approval applies the counted difference to inventory and posts a ledger entry. */
export const approveStockVerification = (verificationNumber, approve = true) => {
  if (!canApproveStockOps()) throw new Error('Permission denied: only Store Manager / Admin can approve verification.');
  const list = getStockVerifications();
  const idx = list.findIndex((v) => v.verificationNumber === verificationNumber);
  if (idx === -1) throw new Error('Stock Verification not found.');
  const verification = list[idx];
  if (verification.status !== 'Pending Approval') throw new Error('Verification is already processed.');

  const info = getCurrentUserInfo();
  if (!approve) {
    const next = [...list];
    next[idx] = { ...verification, status: 'Rejected', approvedBy: info.employee?.name || 'Store', approvedAt: nowDateTimeStr() };
    writeLS(LS.stockVerifications, next);
    appendAuditLog({ action: 'PHYSICAL VERIFICATION REJECTED', reference: verificationNumber, details: verification.itemName });
    return next[idx];
  }

  const inv = getInventoryItems();
  const targetIdx = inv.findIndex((i) => i.id === verification.itemId);
  if (targetIdx === -1) throw new Error('Inventory item not found.');
  const target = inv[targetIdx];
  const newQty = verification.physicalQty;
  const diff = newQty - (Number(target.currentQty) || 0);
  const nextInv = [...inv];
  nextInv[targetIdx] = { ...target, currentQty: newQty };
  writeLS(LS.inventoryItems, nextInv);

  pushStockTransaction(
    {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: todayStr(),
      dateTime: nowDateTimeStr(),
      itemCode: target.itemCode,
      itemName: target.itemName,
      unit: target.unit || 'Nos',
      type: diff >= 0 ? 'IN' : 'OUT',
      quantity: Math.abs(diff),
      balanceAfter: newQty,
      reason: 'Physical Verification Adjustment',
      reference: verificationNumber,
      transactionNumber: verificationNumber
    },
    { transactionNumber: verificationNumber }
  );

  const next = [...list];
  next[idx] = { ...verification, status: 'Approved', approvedBy: info.employee?.name || 'Store', approvedAt: nowDateTimeStr() };
  writeLS(LS.stockVerifications, next);
  appendAuditLog({ action: 'PHYSICAL VERIFICATION APPROVED', reference: verificationNumber, details: `${target.itemName} adjusted ${diff >= 0 ? '+' : ''}${diff}` });
  pushNotification({
    title: 'Verification Applied',
    message: `Stock for ${target.itemName} adjusted by ${diff >= 0 ? '+' : ''}${diff} as per approved verification ${verificationNumber}.`,
    type: 'store',
    reference: verificationNumber
  });
  return next[idx];
};

/* ------------------------------ authorized adjustment ------------------------------ */

/**
 * Authorized stock adjustment. Gated to Store Manager / Admin. Always posts a
 * ledger transaction so the balance stays transaction-based.
 */
export const createStockAdjustment = ({ itemId = '', itemCode = '', itemName = '', type = 'IN', quantity, reason = '', reference = '' }) => {
  if (!canApproveStockOps()) throw new Error('Permission denied: only Store Manager / Admin can adjust stock.');
  const qty = Number(quantity);
  if (!qty || qty <= 0) throw new Error('Adjustment quantity must be greater than zero.');
  const inv = getInventoryItems();
  const target = inv.find((i) => i.id === itemId) || matchInventoryItem(inv, itemCode, itemName);
  if (!target) throw new Error('Select an inventory item to adjust.');
  const current = Number(target.currentQty) || 0;
  let newQty = type === 'IN' ? current + qty : Math.max(0, current - qty);
  const actual = type === 'IN' ? qty : Math.min(current, qty);

  const nextInv = inv.map((i) => (i.id === target.id ? { ...i, currentQty: newQty } : i));
  writeLS(LS.inventoryItems, nextInv);

  const adjustmentNumber = reference || `ADJ-${Date.now()}`;
  pushStockTransaction(
    {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: todayStr(),
      dateTime: nowDateTimeStr(),
      itemCode: target.itemCode,
      itemName: target.itemName,
      unit: target.unit || 'Nos',
      type,
      quantity: actual,
      balanceAfter: newQty,
      reason: reason.trim() ? `Stock Adjustment: ${reason.trim()}` : 'Stock Adjustment',
      reference: adjustmentNumber,
      transactionNumber: adjustmentNumber
    },
    { transactionNumber: adjustmentNumber }
  );

  const info = getCurrentUserInfo();
  appendAuditLog({ action: 'STOCK ADJUSTED', reference: adjustmentNumber, details: `${target.itemName}: ${current} -> ${newQty} (${actual}) ${reason}` });
  pushNotification({ title: 'Stock Adjusted', message: `${target.itemName} changed from ${current} to ${newQty}.`, type: 'store', reference: adjustmentNumber });
  return { adjustmentNumber, itemCode: target.itemCode, itemName: target.itemName, previousQty: current, newQty, type, reason };
};

/* ---------------------------------- reorder level ---------------------------------- */

export const getReorderList = () => {
  return getInventoryItems()
    .map((it) => {
      const current = Number(it.currentQty) || 0;
      const reorderLevel = Number(it.reorderLevel) > 0 ? Number(it.reorderLevel) : (Number(it.minReorderLevel) || 0);
      const shortfall = Math.max(0, reorderLevel - current);
      const suggested = shortfall > 0 ? reorderLevel * 2 - current : 0;
      return {
        item: it,
        current,
        reorderLevel,
        requiredQty: shortfall,
        suggestedPurchaseQty: Math.max(0, suggested),
        status: current <= 0 ? 'OUT OF STOCK' : current <= reorderLevel ? 'LOW STOCK' : 'OK'
      };
    })
    .filter((r) => r.status !== 'OK');
};

export const createReorderPurchaseRequest = ({ itemCode = '', itemName = '', unit = 'Nos', quantity }) => {
  if (!hasPermission('purchase_request.create')) throw new Error('Permission denied: purchase_request.create');
  const qty = Number(quantity);
  if (!qty || qty <= 0) throw new Error('Enter a valid required quantity.');
  const prNumber = generatePRNumber();
  const info = getCurrentUserInfo();
  const record = {
    prNumber,
    prDate: todayStr(),
    mrNumber: '',
    jobCardNumber: '',
    partName: '',
    projectId: '',
    projectName: '',
    requestedBy: info.employee?.name || info.auth?.username || 'Store',
    requestedById: info.employee?.employeeId || '-',
    department: info.employee?.department || 'Store Department',
    priority: 'Normal',
    remarks: 'Auto purchase request from reorder alert',
    status: 'Pending Approval',
    items: [{ materialId: itemCode, materialName: itemName, unit: unit || 'Nos', requiredQty: qty, issuedQty: 0, balanceQty: qty, availableQty: 0, shortageQty: qty }],
    createdAt: nowDateTimeStr()
  };
  writeLS(LS.storePurchaseRequests, [record, ...getPurchaseRequests()]);
  saveSequenceCounter('storePurchaseRequestSequence', prNumber);
  appendAuditLog({ action: 'PURCHASE REQUEST CREATED', reference: prNumber, details: `Reorder purchase request for ${itemName}` });
  pushNotification({ title: 'Purchase Request', message: `Purchase Request ${prNumber} created from reorder alert.`, type: 'purchase', reference: prNumber });
  return record;
};

/* ---------------------------------- ledger + reports ---------------------------------- */

/** Derived, running-balance ledger for one item — computed purely from transactions. */
export const buildInventoryLedger = (itemCode) => {
  const tx = getStockTransactions()
    .filter((t) => t.itemCode && String(t.itemCode).toLowerCase() === String(itemCode || '').toLowerCase())
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ka = String(a.t.dateTime || a.t.date || '');
      const kb = String(b.t.dateTime || b.t.date || '');
      const diff = ka.localeCompare(kb);
      // Movements stored newest-first; equal timestamps are therefore shown oldest-first by index
      return diff !== 0 ? diff : b.i - a.i;
    })
    .map((x) => x.t);
  if (tx.length === 0) return [];
  const rows = [];
  let balance = 0;
  tx.forEach((t, i) => {
    const isIn = t.type === 'IN';
    balance += isIn ? Number(t.quantity) || 0 : -(Number(t.quantity) || 0);
    rows.push({
      id: t.id || `row-${i}`,
      date: t.date || (t.dateTime || '').slice(0, 10),
      transaction: transactionTypeLabel(t),
      reason: t.reason || '',
      reference: t.reference || t.transactionNumber || '-',
      jobCardNumber: t.jobCardNumber || '',
      projectId: t.projectId || '',
      batchNumber: t.batchNo || '',
      in: isIn ? Number(t.quantity) || 0 : 0,
      out: isIn ? 0 : Number(t.quantity) || 0,
      balance
    });
  });
  return rows;
};

export const getItemStockOverview = () => {
  const tx = getStockTransactions();
  const byCode = {};
  tx.forEach((t) => {
    if (!t.itemCode) return;
    byCode[t.itemCode] = byCode[t.itemCode] || { received: 0, issued: 0, returned: 0, damaged: 0, rejected: 0 };
    const qty = Number(t.quantity) || 0;
    const reason = String(t.reason || '').toLowerCase();
    if (reason.includes('damage')) byCode[t.itemCode].damaged += t.type === 'IN' ? qty : -qty;
    else if (reason.includes('reject')) byCode[t.itemCode].rejected += t.type === 'IN' ? qty : -qty;
    else if (reason.includes('store return')) byCode[t.itemCode].returned += qty;
    else if (reason.includes('store issue')) byCode[t.itemCode].issued += qty;
    else if (t.type === 'IN') byCode[t.itemCode].received += qty;
    else byCode[t.itemCode].issued += qty;
  });
  return getInventoryItems().map((it) => {
    const s = byCode[it.itemCode] || { received: 0, issued: 0, returned: 0, damaged: 0, rejected: 0 };
    const current = Number(it.currentQty) || 0;
    const reserved = Number(it.reservedQty) || 0;
    return {
      ...it,
      receivedQty: s.received,
      issuedQty: s.issued,
      returnedQty: s.returned,
      damagedQty: s.damaged,
      rejectedQty: s.rejected,
      reservedQty: reserved,
      availableQty: Math.max(0, current - reserved),
      stockValue: current * (Number(it.unitCost) || 0),
      stockStatus: current <= 0 ? 'Out of Stock' : current <= (Number(it.reorderLevel) > 0 ? Number(it.reorderLevel) : Number(it.minReorderLevel) || 0) ? 'Low Stock' : 'In Stock'
    };
  });
};

export const getStockTotals = () => {
  const items = getInventoryItems();
  const tx = getStockTransactions();
  const today = todayStr();
  let totalQty = 0;
  let totalValue = 0;
  let low = 0;
  let out = 0;
  items.forEach((it) => {
    const current = Number(it.currentQty) || 0;
    totalQty += current;
    totalValue += current * (Number(it.unitCost) || 0);
    const reorderLevel = Number(it.reorderLevel) > 0 ? Number(it.reorderLevel) : (Number(it.minReorderLevel) || 0);
    if (current <= 0) out += 1;
    else if (current <= reorderLevel) low += 1;
  });
  let inToday = 0;
  let outToday = 0;
  tx.forEach((t) => {
    if (String(t.date || t.dateTime || '').slice(0, 10) !== today) return;
    if (t.type === 'IN') inToday += Number(t.quantity) || 0;
    else outToday += Number(t.quantity) || 0;
  });
  const pendingQC = getGRNs().filter((g) => g.items.some((i) => (i.qcStatus || 'Passed') === 'Pending')).length;
  return {
    totalItems: items.length,
    totalStockQty: totalQty,
    totalStockValue: totalValue,
    lowStockCount: low,
    outOfStockCount: out,
    pendingQC,
    stockInToday: inToday,
    stockOutToday: outToday,
    materialReturnsToday: getMaterialReturns().filter((r) => r.returnDate === today).length,
    stockAdjustmentsToday: tx.filter((t) => String(t.date || '').slice(0, 10) === today && String(t.reason || '').toLowerCase().includes('adjust')).length
  };
};

/** Monthly movement (IN vs OUT) for the last N months, for the dashboard chart. */
export const getMonthlyMovement = (months = 6) => {
  const result = [];
  const now = new Date();
  const tx = getStockTransactions();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-IN', { month: 'short' });
    const entries = tx.filter((t) => String(t.date || t.dateTime || '').slice(0, 7) === key);
    let sumIn = 0;
    let sumOut = 0;
    entries.forEach((t) => {
      if (t.type === 'IN') sumIn += Number(t.quantity) || 0;
      else sumOut += Number(t.quantity) || 0;
    });
    result.push({ month: label, in: sumIn, out: sumOut });
  }
  return result;
};

/** Category-wise stock quantity/value, for the dashboard chart. */
export const getCategoryWiseStock = () => {
  const map = {};
  getInventoryItems().forEach((it) => {
    const cat = it.category || 'Uncategorised';
    map[cat] = map[cat] || { category: cat, qty: 0, value: 0 };
    const qty = Number(it.currentQty) || 0;
    map[cat].qty += qty;
    map[cat].value += qty * (Number(it.unitCost) || 0);
  });
  return Object.values(map).sort((a, b) => b.qty - a.qty);
};

/** Material consumption grouped by production order (job card), from ledger OUT issues. */
export const getConsumptionByProductionOrder = () => {
  const map = {};
  getStockTransactions()
    .filter((t) => String(t.reason || '').toLowerCase().includes('store issue'))
    .forEach((t) => {
      const key = t.jobCardNumber || t.projectId || 'General';
      map[key] = map[key] || { jobCardNumber: t.jobCardNumber, projectId: t.projectId || '', qty: 0, lines: 0 };
      map[key].qty += Number(t.quantity) || 0;
      map[key].lines += 1;
    });
  return Object.values(map);
};

/** Batch availability: received vs consumed, derived from ledger + batch register. */
export const getBatchAvailability = () => {
  // `availableQty` is already decremented when an issue/write-off is recorded.
  // Subtracting the same OUT transactions again used to double-deplete FEFO stock.
  return getInventoryBatches().map((batch) => ({
    ...batch,
    consumedQty: Math.max(0, (Number(batch.qtyReceived) || 0) - (Number(batch.availableQty) || 0)),
    availableQty: Math.max(0, Number(batch.availableQty) || 0)
  }));
};

/* ─────────────────────────────────────────────
   Item Lists (raw materials per project/drawing)
   ───────────────────────────────────────────── */
const BOM_LS_KEY = 'bomMasterList';

export const getBOMs = () => readLS(BOM_LS_KEY, []);

export const saveBOMs = (list) => writeLS(BOM_LS_KEY, list);

export const getBOMById = (id) => getBOMs().find((b) => b.id === id) || null;

export const getBOMByPartName = (partName) => getBOMs().find((b) => b.partName.toLowerCase() === partName.toLowerCase()) || null;

export const createBOM = ({ projectId, customerName, companyName, drawingNumber, remarks, items }) => {
  const info = getCurrentUserInfo();
  const bom = {
    id: `BOM-${Date.now()}`,
    projectId: (projectId || '').trim(),
    customerName: (customerName || '').trim(),
    companyName: (companyName || '').trim(),
    drawingNumber: (drawingNumber || '').trim(),
    remarks: remarks || '',
    items: items.map((it) => ({
      materialId: it.materialId || '',
      materialName: it.materialName || '',
      grade: it.grade || '',
      spec: it.spec || '',
      sizeDimensions: it.sizeDimensions || '',
      unit: it.unit || '',
      requiredQty: Number(it.requiredQty) || 0,
      purpose: it.purpose || ''
    })),
    createdBy: info.employee?.name || 'Admin',
    createdByEmpId: info.employee?.employeeId || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const list = getBOMs();
  list.unshift(bom);
  saveBOMs(list);
  appendAuditLog({ action: 'ITEM LIST CREATED', reference: bom.id, details: `Project: ${projectId} | Drawing: ${drawingNumber} | ${items.length} material(s)` });
  return bom;
};

export const updateBOM = (id, updates) => {
  const list = getBOMs();
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) throw new Error('Item list not found');
  list[idx] = { ...list[idx], ...updates, updatedAt: new Date().toISOString() };
  if (updates.items) {
    list[idx].items = updates.items.map((it) => ({
      materialId: it.materialId || '',
      materialName: it.materialName || '',
      grade: it.grade || '',
      spec: it.spec || '',
      sizeDimensions: it.sizeDimensions || '',
      unit: it.unit || '',
      requiredQty: Number(it.requiredQty) || 0,
      purpose: it.purpose || ''
    }));
  }
  saveBOMs(list);
  appendAuditLog({ action: 'ITEM LIST UPDATED', reference: list[idx].id, details: `Project: ${list[idx].projectId} | Drawing: ${list[idx].drawingNumber} | ${list[idx].items.length} material(s)` });
  return list[idx];
};

export const deleteBOM = (id) => {
  const list = getBOMs();
  const bom = list.find((b) => b.id === id);
  if (!bom) throw new Error('Item list not found');
  saveBOMs(list.filter((b) => b.id !== id));
  appendAuditLog({ action: 'ITEM LIST DELETED', reference: bom.id, details: `Project: ${bom.projectId} | Drawing: ${bom.drawingNumber}` });
};

/* ------------------------- vendor enquiries & quotations ------------------------- */

const LS_VENDOR_ENQUIRIES = 'vendorEnquiries';
const LS_VENDOR_QUOTATIONS = 'vendorQuotations';

const getVendorEnquiries = () => readLS(LS_VENDOR_ENQUIRIES, []);
const saveVendorEnquiries = (list) => writeLS(LS_VENDOR_ENQUIRIES, list);
const getVendorQuotations = () => readLS(LS_VENDOR_QUOTATIONS, []);
const saveVendorQuotations = (list) => writeLS(LS_VENDOR_QUOTATIONS, list);

/**
 * Vendor Quotation lifecycle.
 *   Received → Accepted → PO Created
 * A Purchase Order may only be generated from an Accepted quotation.
 */
export const QUOTATION_STATUS = {
  DRAFT: 'Draft',
  RECEIVED: 'Received',
  UNDER_REVIEW: 'Under Review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  PO_CREATED: 'PO Created',
  CANCELLED: 'Cancelled'
};

/** Statuses that mean "this quotation has already produced a Purchase Order". */
export const QUOTATION_PO_CREATED_STATUSES = [QUOTATION_STATUS.PO_CREATED, 'Ordered'];

/** Statuses a Purchase Order may be generated from. */
export const QUOTATION_ACCEPTED_STATUSES = [
  QUOTATION_STATUS.ACCEPTED,
  QUOTATION_STATUS.PO_CREATED,
  'Ordered'
];

/** Statuses that can never produce a Purchase Order. */
export const QUOTATION_BLOCKED_STATUSES = [
  QUOTATION_STATUS.RECEIVED,
  QUOTATION_STATUS.REJECTED,
  QUOTATION_STATUS.CANCELLED
];

/** Statuses a quotation can no longer be accepted from (terminal without acceptance). */
export const QUOTATION_NOT_ACCEPTABLE_STATUSES = [QUOTATION_STATUS.REJECTED, QUOTATION_STATUS.CANCELLED];

export const generateVENumber = () =>
  generateSequentialNumber({ prefix: 'VE', sequenceKey: 'vendorEnquirySequence', historyKey: LS_VENDOR_ENQUIRIES, idField: 'enquiryNumber' });

export const generateVQNumber = () =>
  generateSequentialNumber({ prefix: 'VQ', sequenceKey: 'vendorQuotationSequence', historyKey: LS_VENDOR_QUOTATIONS, idField: 'quotationNumber' });

export const getAllVendorEnquiries = () => getVendorEnquiries();

/** Vendor Enquiries raised from a given Purchase Indent. */
export const getVendorEnquiriesForIndent = (indentNumber) =>
  getVendorEnquiries().filter((e) => String(e.indentNumber || '') === String(indentNumber || ''));

const getPurchaseIndent = (indentNumber) =>
  readLS('purchaseIndents', []).find((i) => String(i.indentNumber) === String(indentNumber)) || null;

/**
 * Vendor Enquiry. The source is either an existing Store Purchase Request (legacy
 * `prNumber` flow) or a Purchase Indent raised from a Sales Order shortage. When an
 * indent is given, Project ID / Sales Order / Customer / Required Date are inherited
 * from the indent so traceability is never lost.
 */
export const createVendorEnquiry = ({
  prNumber = '',
  indentNumber = '',
  soNumber = '',
  projectId,
  projectName = '',
  partName = '',
  jobCardNumber = '',
  items = [],
  vendors = [],
  remarks = '',
  termsAndConditions = '',
  validUntil = '',
  requiredDate = '',
  customer = ''
}) => {
  const indent = indentNumber ? getPurchaseIndent(indentNumber) : null;
  if (indentNumber && !indent) throw new Error(`Purchase Indent ${indentNumber} not found.`);
  if (!indent && !String(prNumber || '').trim()) {
    throw new Error('A Vendor Enquiry must reference a Purchase Indent or a Purchase Request.');
  }

  const enquiryLines = (items || []).filter(
    (it) => (Number(it.requiredQty) || 0) > 0 || (Number(it.shortageQty) || 0) > 0
  );
  if (enquiryLines.length === 0) throw new Error('Add at least one material with a required quantity.');

  const enquiryNumber = generateVENumber();
  const info = getCurrentUserInfo();
  const record = {
    enquiryNumber,
    prNumber: prNumber || '',
    indentNumber: indent?.indentNumber || '',
    soNumber: soNumber || indent?.soNumber || '',
    sourceType: indent ? 'Purchase Indent' : 'Purchase Request',
    projectId: projectId || indent?.projectId || '',
    projectName: projectName || '',
    partName: partName || '',
    jobCardNumber: jobCardNumber || '',
    customer: customer || indent?.customer || '',
    requiredDate: requiredDate || indent?.requiredDate || '',
    requestedBy: info.employee?.name || info.auth?.username || 'Store',
    department: info.employee?.department || 'Purchase Department',
    items: enquiryLines.map((it) => ({
      materialId: it.materialId || '',
      materialCode: it.materialCode || '',
      materialName: it.materialName || '',
      unit: it.unit || 'Nos',
      requiredQty: Number(it.requiredQty) || 0,
      shortageQty: Number(it.shortageQty) || 0,
      specification: it.specification || it.spec || '',
      remarks: it.remarks || ''
    })),
    vendors: (vendors || []).map((v) => ({
      name: v.name || '',
      contact: v.contact || '',
      email: v.email || '',
      phone: v.phone || '',
      status: 'Invited'
    })),
    remarks,
    termsAndConditions,
    validUntil: validUntil || '',
    status: 'Draft',
    quotationNumbers: [],
    poNumber: '',
    createdAt: nowDateTimeStr()
  };
  saveVendorEnquiries([record, ...getVendorEnquiries()]);
  saveSequenceCounter('vendorEnquirySequence', enquiryNumber);
  appendAuditLog({
    action: 'VENDOR ENQUIRY CREATED',
    reference: enquiryNumber,
    details: `${indent ? `Indent: ${indent.indentNumber} | ` : `PR: ${prNumber} | `}${vendors?.length || 0} vendor(s) invited | ${enquiryLines.length} material(s)`
  });
  if (indent) {
    pushNotification({
      title: 'Vendor Enquiry raised',
      message: `Vendor Enquiry ${enquiryNumber} raised for Purchase Indent ${indent.indentNumber} (Project ${indent.projectId || '—'} / SO ${indent.soNumber}).`,
      type: 'purchase',
      reference: enquiryNumber,
      targetDept: 'Purchase Department'
    });
  }
  return record;
};

export const updateVendorEnquiry = (enquiryNumber, updates) => {
  const list = getVendorEnquiries();
  const idx = list.findIndex((e) => e.enquiryNumber === enquiryNumber);
  if (idx === -1) throw new Error('Vendor enquiry not found');
  list[idx] = { ...list[idx], ...updates, updatedAt: nowDateTimeStr() };
  saveVendorEnquiries(list);
  appendAuditLog({ action: 'VENDOR ENQUIRY UPDATED', reference: enquiryNumber, details: `Status: ${list[idx].status}` });
  return list[idx];
};

export const deleteVendorEnquiry = (enquiryNumber) => {
  const list = getVendorEnquiries();
  const enquiry = list.find((e) => e.enquiryNumber === enquiryNumber);
  if (!enquiry) throw new Error('Vendor enquiry not found');
  saveVendorEnquiries(list.filter((e) => e.enquiryNumber !== enquiryNumber));
  appendAuditLog({ action: 'VENDOR ENQUIRY DELETED', reference: enquiryNumber, details: `PR: ${enquiry.prNumber}` });
};

export const getAllVendorQuotations = () => getVendorQuotations();

/** Vendor Quotations received against a Vendor Enquiry. */
export const getVendorQuotationsForEnquiry = (enquiryNumber) =>
  getVendorQuotations().filter((q) => String(q.enquiryNumber || '') === String(enquiryNumber || ''));

/**
 * Vendor Quotation. Must be linked to an existing Vendor Enquiry; Project ID,
 * Sales Order and Purchase Indent references are inherited from that enquiry so
 * the document chain SO → Indent → Enquiry → Quotation stays intact.
 */
export const createVendorQuotation = ({
  enquiryNumber,
  vendorName,
  vendorContact,
  vendorEmail,
  items = [],
  totalAmount,
  deliveryDays,
  paymentTerms,
  validity,
  deliveryDate = '',
  quotationDate = '',
  taxPct: headerTaxPct,
  discountPct: headerDiscountPct,
  otherTerms = '',
  remarks = ''
}) => {
  const enquiry = String(enquiryNumber || '').trim()
    ? getVendorEnquiries().find((e) => String(e.enquiryNumber) === String(enquiryNumber).trim())
    : null;
  if (!enquiry) throw new Error(`Vendor Enquiry ${enquiryNumber} not found — a quotation must be linked to an enquiry.`);
  if (String(enquiry.status || '') === 'Cancelled') {
    throw new Error(`Vendor Enquiry ${enquiry.enquiryNumber} is cancelled — quotations are not accepted.`);
  }
  if (!String(vendorName || '').trim()) throw new Error('Vendor name is required on a quotation.');

  const quoteLines = (items || []).filter((it) => String(it.materialName || '').trim());
  if (quoteLines.length === 0) throw new Error('Add at least one quoted material.');

  const quotationNumber = generateVQNumber();
  const recordLines = quoteLines.map((it) => {
    const quotedQty = Number(it.quotedQty) || Number(it.requiredQty) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    const taxPct = Number(it.taxPct ?? it.tax ?? headerTaxPct) || 0;
    const discount = Number(it.discount ?? headerDiscountPct) || 0;
    const lineTotal = Number(it.totalPrice) || quotedQty * unitPrice;
    return {
      materialId: it.materialId || '',
      materialCode: it.materialCode || '',
      materialName: it.materialName,
      description: it.description || '',
      hsnSac: it.hsnSac || '',
      unit: it.unit || 'Nos',
      requiredQty: Number(it.requiredQty) || 0,
      quotedQty,
      unitPrice,
      taxPct,
      taxAmount: Number(it.taxAmount) || (lineTotal * taxPct) / 100,
      discount,
      discountAmount: Number(it.discountAmount) || discount,
      totalPrice: lineTotal,
      deliveryDays: Number(it.deliveryDays) || Number(deliveryDays) || 0,
      deliveryDate: it.deliveryDate || deliveryDate || '',
      paymentTerms: it.paymentTerms || paymentTerms || '',
      remarks: it.remarks || ''
    };
  });
  const lineTaxTotal = recordLines.reduce((a, it) => a + (Number(it.taxAmount) || 0), 0);
  const lineSubTotal = recordLines.reduce(
    (a, it) => a + (Number(it.quotedQty) || 0) * (Number(it.unitPrice) || 0),
    0
  );
  const lineDiscountTotal = recordLines.reduce(
    (a, it) => a + (((Number(it.quotedQty) || 0) * (Number(it.unitPrice) || 0) * (Number(it.discount) || 0)) / 100),
    0
  );
  const record = {
    quotationNumber,
    enquiryNumber: enquiry.enquiryNumber,
    indentNumber: enquiry.indentNumber || '',
    soNumber: enquiry.soNumber || '',
    projectId: enquiry.projectId || '',
    customer: enquiry.customer || '',
    requiredDate: enquiry.requiredDate || '',
    vendorName: vendorName || '',
    vendorContact: vendorContact || '',
    vendorEmail: vendorEmail || '',
    items: recordLines,
    // Commercial breakdown kept explicit so the quotation is self-describing and a
    // Purchase Order can be generated from it without re-entering anything.
    subtotal: lineSubTotal,
    totalAmount: Number(totalAmount) || lineSubTotal,
    discountAmount: lineDiscountTotal,
    // Header-level commercial terms so a quotation can be compared PO-to-PO
    taxPct: Number(headerTaxPct) || 0,
    discountPct: Number(headerDiscountPct) || 0,
    taxAmount: lineTaxTotal,
    totalWithTax: (Number(totalAmount) || lineSubTotal) + lineTaxTotal,
    deliveryDays: Number(deliveryDays) || 0,
    deliveryDate: deliveryDate || '',
    quotationDate: quotationDate || todayStr(),
    paymentTerms: paymentTerms || '',
    validity: validity || '',
    otherTerms: otherTerms || '',
    remarks,
    status: QUOTATION_STATUS.RECEIVED,
    poNumber: '',
    acceptedBy: '',
    acceptedDate: '',
    acceptedTime: '',
    createdAt: nowDateTimeStr()
  };
  saveVendorQuotations([record, ...getVendorQuotations()]);
  saveSequenceCounter('vendorQuotationSequence', quotationNumber);

  // Keep the enquiry in step with the quotation lifecycle.
  const enquiries = getVendorEnquiries();
  const eIdx = enquiries.findIndex((e) => String(e.enquiryNumber) === String(enquiry.enquiryNumber));
  if (eIdx >= 0) {
    enquiries[eIdx] = {
      ...enquiries[eIdx],
      quotationNumbers: [...(enquiries[eIdx].quotationNumbers || []), quotationNumber],
      status: ['Closed', 'Cancelled'].includes(enquiries[eIdx].status) ? enquiries[eIdx].status : 'Quotation Received',
      updatedAt: nowDateTimeStr()
    };
    saveVendorEnquiries(enquiries);
  }

  appendAuditLog({ action: 'VENDOR QUOTATION RECEIVED', reference: quotationNumber, details: `Enquiry: ${enquiryNumber} | Vendor: ${vendorName} | Amount: ₹${totalAmount}` });
  /* Purchase has recorded the quotation: only the Admin can approve it, so the
     Admin is notified and the link deep-links straight to this quotation. */
  pushNotification({
    title: 'Vendor Quotation awaiting Admin approval',
    message: `Vendor quotation ${quotationNumber} from ${vendorName} for Purchase Indent ${enquiry.indentNumber || '—'} (Enquiry ${enquiry.enquiryNumber}) has been recorded by Purchase and needs your approval.`,
    type: 'store',
    reference: quotationNumber,
    targetDept: 'Admin',
    link: `/vendor-quotations?quotation=${encodeURIComponent(quotationNumber)}`
  });
  return record;
};

export const updateVendorQuotation = (quotationNumber, updates) => {
  const list = getVendorQuotations();
  const idx = list.findIndex((q) => q.quotationNumber === quotationNumber);
  if (idx === -1) throw new Error('Vendor quotation not found');
  list[idx] = { ...list[idx], ...updates, updatedAt: nowDateTimeStr() };
  saveVendorQuotations(list);
  appendAuditLog({ action: 'VENDOR QUOTATION UPDATED', reference: quotationNumber, details: `Status: ${list[idx].status}` });
  return list[idx];
};

/** Find a Vendor Quotation by its number (or by the PO it already generated). */
export const getVendorQuotationByNumber = (quotationNumber) =>
  getVendorQuotations().find((q) => String(q.quotationNumber) === String(quotationNumber || '')) || null;

/**
 * Every commercial / traceability check a quotation must satisfy before it can be
 * accepted and converted into a Purchase Order. Returns an array of human readable
 * problems — an empty array means the quotation is complete.
 */
export const validateQuotationForAcceptance = (quotationNumber) => {
  const q = getVendorQuotationByNumber(quotationNumber);
  const problems = [];
  if (!q) return [`Vendor Quotation ${quotationNumber} not found.`];

  if (!String(q.enquiryNumber || '').trim()) problems.push('Vendor Enquiry number is missing.');
  if (!String(q.vendorName || '').trim()) problems.push('Vendor name is missing.');

  const lines = Array.isArray(q.items) ? q.items : [];
  if (lines.length === 0) {
    problems.push('Quotation has no items.');
  } else {
    lines.forEach((l, i) => {
      const row = i + 1;
      const label = l.materialName || l.materialCode || `row ${row}`;
      if (!String(l.materialName || '').trim()) problems.push(`Item ${row} (${label}): material name is missing.`);
      if (!(Number(l.quotedQty) > 0)) problems.push(`Item ${row} (${label}): quantity must be greater than zero.`);
      if (!(Number(l.unitPrice) >= 0) || l.unitPrice === '' || l.unitPrice === null)
        problems.push(`Item ${row} (${label}): unit price is missing.`);
      if (!(Number(l.taxPct) >= 0)) problems.push(`Item ${row} (${label}): tax percentage is invalid.`);
    });
  }

  if (QUOTATION_NOT_ACCEPTABLE_STATUSES.includes(String(q.status)))
    problems.push(`Quotation status "${q.status}" cannot be accepted.`);

  return problems;
};

/**
 * Accept a Vendor Quotation. Records who accepted it and exactly when
 * (Accepted By / Accepted Date / Accepted Time) and unlocks the
 * "Create Purchase Order" action.
 */
export const acceptVendorQuotation = (quotationNumber, { acceptedBy = '' } = {}) => {
  /* Approval is an Admin-only action: Purchase records the quotation, the Admin
     approves it. Checked before validation so a non-admin learns nothing. */
  if (!isAdmin()) {
    throw new Error('Permission denied: only the Admin can approve a Vendor Quotation.');
  }
  const problems = validateQuotationForAcceptance(quotationNumber);
  if (problems.length > 0) throw new Error(`Quotation cannot be accepted:\n- ${problems.join('\n- ')}`);

  const list = getVendorQuotations();
  const idx = list.findIndex((q) => String(q.quotationNumber) === String(quotationNumber));
  const current = list[idx];
  if (QUOTATION_PO_CREATED_STATUSES.includes(String(current.status)))
    throw new Error(`Vendor Quotation ${current.quotationNumber} already generated Purchase Order ${current.poNumber || ''}.`);

  const acceptedDate = todayStr();
  const acceptedTime = nowTimeStr();
  const approver = acceptedBy || current.acceptedBy
    || getCurrentUserInfo().employee?.name || getCurrentUserInfo().auth?.username || 'Administrator';
  list[idx] = {
    ...current,
    status: QUOTATION_STATUS.ACCEPTED,
    acceptedBy: approver,
    acceptedDate,
    acceptedTime,
    updatedAt: nowDateTimeStr()
  };
  saveVendorQuotations(list);

  appendAuditLog({
    action: 'VENDOR QUOTATION ACCEPTED',
    reference: current.quotationNumber,
    details: `Vendor: ${current.vendorName} | By: ${list[idx].acceptedBy} | ${acceptedDate} ${acceptedTime}`
  });
  pushNotification({
    title: 'Vendor Quotation Accepted',
    message: `Quotation ${current.quotationNumber} for ${current.vendorName} was accepted. A Purchase Order can now be created.`,
    type: 'success',
    reference: current.quotationNumber,
    targetDept: 'Store Department'
  });
  return list[idx];
};

/**
 * Record the Purchase Order generated from a quotation. This is the traceability
 * link Quotation → PO and it also blocks a second PO from the same quotation.
 */
export const markQuotationPOCreated = (quotationNumber, poNumber) => {
  const list = getVendorQuotations();
  const idx = list.findIndex((q) => String(q.quotationNumber) === String(quotationNumber));
  if (idx === -1) return null;
  list[idx] = {
    ...list[idx],
    status: QUOTATION_STATUS.PO_CREATED,
    poNumber,
    purchaseOrderId: poNumber,
    purchaseOrderNumber: poNumber,
    poCreatedDate: todayStr(),
    updatedAt: nowDateTimeStr()
  };
  saveVendorQuotations(list);
  appendAuditLog({
    action: 'PURCHASE ORDER FROM QUOTATION',
    reference: quotationNumber,
    details: `Purchase Order ${poNumber} generated from quotation ${quotationNumber}`
  });
  return list[idx];
};

export const deleteVendorQuotation = (quotationNumber) => {
  const list = getVendorQuotations();
  const vq = list.find((q) => q.quotationNumber === quotationNumber);
  if (!vq) throw new Error('Vendor quotation not found');
  saveVendorQuotations(list.filter((q) => q.quotationNumber !== quotationNumber));
  appendAuditLog({ action: 'VENDOR QUOTATION DELETED', reference: quotationNumber, details: `Vendor: ${vq.vendorName}` });
};

/* --------------------- HT Outsource Request (HTR) --------------------- */
// Formal Production → Store letter for outsourced heat treatment.
// Store moves stock out/in; Purchase assigns vendor / tracks PO+bill;
// Production only records target vs actual hardness.

const LS_HT_OUTSOURCE = 'htOutsourceRequests';
const LS_HT_OUTSOURCE_SEQ = 'htOutsourceSequence';

export const HT_OUTSOURCE_STATUS = {
  RAISED: 'Raised',
  VENDOR_ASSIGNED: 'Vendor Assigned',
  ISSUED: 'Issued to Vendor',
  RECEIVED: 'Received at Store',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
};

const getHTList = () => readLS(LS_HT_OUTSOURCE, []);
const saveHTList = (list) => writeLS(LS_HT_OUTSOURCE, list);

const generateHTRNumber = () =>
  generateSequentialNumber({
    prefix: 'HTR',
    sequenceKey: LS_HT_OUTSOURCE_SEQ,
    historyKey: LS_HT_OUTSOURCE,
    idField: 'htrNumber'
  });

export const getHTOutsourceRequests = () => getHTList();

export const createHTOutsourceRequest = ({
  jobCardNumber,
  projectId = '',
  partName = '',
  drawingNumber = '',
  processType = '',
  processSpec = '',
  targetHardness = '',
  qtyRequested = 0,
  vendorName = '',
  vendorAddress = '',
  vendorPhone = '',
  vendorEmail = '',
  needByDate = '',
  inventoryItemCode = '',
  remarks = ''
}) => {
  if (!hasPermission('ht_outsource.create') && !hasPermission('job_card.create')) {
    throw new Error('Permission denied: ht_outsource.create');
  }
  if (!jobCardNumber) throw new Error('Job Card number is required for an HT Outsource Request.');
  if (!Number(qtyRequested) || Number(qtyRequested) <= 0) throw new Error('Qty to send must be greater than 0.');

  const htrNumber = generateHTRNumber();
  const info = getCurrentUserInfo();
  const record = {
    htrNumber,
    requestDate: todayStr(),
    jobCardNumber,
    projectId,
    partName,
    drawingNumber,
    processType,
    processSpec,
    targetHardness,
    qtyRequested: Number(qtyRequested) || 0,
    vendorName: vendorName || '',
    vendorAddress: vendorAddress || '',
    vendorPhone: vendorPhone || '',
    vendorEmail: vendorEmail || '',
    needByDate: needByDate || '',
    inventoryItemCode: inventoryItemCode || '',
    raisedBy: info.employee?.name || info.auth?.username || 'Production',
    raisedByDept: info.employee?.department || 'Production Department',
    status: vendorName ? HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED : HT_OUTSOURCE_STATUS.RAISED,
    issuedQty: 0,
    issuedDate: '',
    issuedBy: '',
    outwardChallan: '',
    vehicleNo: '',
    receivedQty: 0,
    receivedDate: '',
    receivedBy: '',
    inwardChallan: '',
    poRef: '',
    billRef: '',
    rateInfo: '',
    actualHardness: '',
    disposition: 'Pending',
    completedBy: '',
    completedDate: '',
    remarks: remarks || '',
    createdAt: nowDateTimeStr(),
    updatedAt: nowDateTimeStr()
  };

  saveHTList([record, ...getHTList()]);
  saveSequenceCounter(LS_HT_OUTSOURCE_SEQ, htrNumber);
  appendAuditLog({
    action: 'HT OUTSOURCE REQUEST CREATED',
    reference: htrNumber,
    details: `JC: ${jobCardNumber} | Qty: ${record.qtyRequested} | Process: ${processType || '-'} | Target: ${targetHardness || '-'}`
  });
  pushNotification({
    title: `HT Outsource Request ${htrNumber}`,
    message: `Store must issue ${record.qtyRequested} Nos of ${partName || 'parts'} for heat treatment${vendorName ? ` to ${vendorName}` : ''}.`,
    type: 'info',
    reference: htrNumber,
    targetDept: 'Store Department'
  });
  if (vendorName) {
    pushNotification({
      title: `HT vendor assigned on ${htrNumber}`,
      message: `Purchase: vendor ${vendorName} — track job-work PO / bill against ${htrNumber}.`,
      type: 'info',
      reference: htrNumber,
      targetDept: 'Purchase Department'
    });
  }
  return record;
};

export const updateHTOutsourceRequest = (htrNumber, updates = {}, auditAction = 'HT OUTSOURCE REQUEST UPDATED') => {
  const list = getHTList();
  const idx = list.findIndex((r) => r.htrNumber === htrNumber);
  if (idx === -1) throw new Error(`HT Outsource Request ${htrNumber} not found.`);
  list[idx] = { ...list[idx], ...updates, updatedAt: nowDateTimeStr() };
  saveHTList(list);
  appendAuditLog({ action: auditAction, reference: htrNumber, details: updates.status ? `Status: ${list[idx].status}` : Object.keys(updates).join(', ') });
  return list[idx];
};

export const assignVendorToHTR = ({ htrNumber, vendorName, vendorAddress = '', vendorPhone = '', vendorEmail = '', poRef = '', rateInfo = '' }) => {
  if (!hasPermission('ht_outsource.purchase_action') && !hasPermission('purchase.order')) {
    throw new Error('Permission denied: ht_outsource.purchase_action');
  }
  if (!vendorName) throw new Error('Select a vendor from Vendor Master.');
  const list = getHTList();
  const rec = list.find((r) => r.htrNumber === htrNumber);
  if (!rec) throw new Error(`HT Outsource Request ${htrNumber} not found.`);
  if (rec.status === HT_OUTSOURCE_STATUS.ISSUED || rec.status === HT_OUTSOURCE_STATUS.RECEIVED || rec.status === HT_OUTSOURCE_STATUS.COMPLETED) {
    throw new Error(`${htrNumber} is already issued/received — vendor cannot be changed.`);
  }
  const updated = updateHTOutsourceRequest(htrNumber, {
    vendorName,
    vendorAddress,
    vendorPhone,
    vendorEmail,
    poRef: poRef || rec.poRef || '',
    rateInfo: rateInfo || rec.rateInfo || '',
    status: HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED
  }, 'HTR VENDOR ASSIGNED');
  pushNotification({
    title: `Vendor assigned: ${htrNumber}`,
    message: `${vendorName} — Store can now issue material for heat treatment.`,
    type: 'info',
    reference: htrNumber,
    targetDept: 'Store Department'
  });
  return updated;
};

const findInventoryForHTR = (rec) => {
  const inv = getInventoryItems();
  if (rec.inventoryItemCode) {
    const byCode = inv.find((i) => i.itemCode === rec.inventoryItemCode);
    if (byCode) return byCode;
  }
  const name = String(rec.partName || '').trim().toLowerCase();
  if (!name) return null;
  return inv.find((i) => String(i.itemName || '').trim().toLowerCase() === name) || null;
};

const syncJobCardHT = (jobCardNumber, patch) => {
  if (!jobCardNumber) return;
  const jcs = getJobCards();
  const idx = jcs.findIndex((j) => j.jobCardNumber === jobCardNumber);
  if (idx === -1) return;
  const jc = jcs[idx];
  jcs[idx] = {
    ...jc,
    operations: {
      ...jc.operations,
      heatTreatment: {
        ...(jc.operations?.heatTreatment || {}),
        ...patch
      }
    }
  };
  writeLS(LS.productionJobCards, jcs);
};

export const issueHTRToVendor = ({ htrNumber, qty, outwardChallan = '', vehicleNo = '', issuedBy = '' }) => {
  if (!hasPermission('ht_outsource.store_action') && !hasPermission('material_issue.confirm')) {
    throw new Error('Permission denied: ht_outsource.store_action');
  }
  const list = getHTList();
  const rec = list.find((r) => r.htrNumber === htrNumber);
  if (!rec) throw new Error(`HT Outsource Request ${htrNumber} not found.`);
  if (rec.status === HT_OUTSOURCE_STATUS.CANCELLED || rec.status === HT_OUTSOURCE_STATUS.COMPLETED) {
    throw new Error(`${htrNumber} is ${rec.status} — cannot issue.`);
  }
  if (rec.status === HT_OUTSOURCE_STATUS.ISSUED || rec.status === HT_OUTSOURCE_STATUS.RECEIVED) {
    throw new Error(`${htrNumber} is already issued to vendor.`);
  }
  const issueQty = Number(qty) || 0;
  if (issueQty <= 0) throw new Error('Enter qty to issue (must be > 0).');
  if (issueQty > Number(rec.qtyRequested)) {
    throw new Error(`Issue qty ${issueQty} exceeds requested qty ${rec.qtyRequested}.`);
  }
  if (!rec.vendorName) throw new Error('Purchase must assign a vendor first (Vendor Master contact is copied onto this HTR).');

  const info = getCurrentUserInfo();
  const invItem = findInventoryForHTR(rec);
  if (invItem) {
    const available = Number(invItem.currentQty) || 0;
    if (issueQty > available) {
      throw new Error(`Insufficient stock for "${invItem.itemName}": available ${available}, issue ${issueQty}.`);
    }
    const inv = getInventoryItems();
    const nextInv = inv.map((i) =>
      i.itemCode === invItem.itemCode ? { ...i, currentQty: Math.max(0, available - issueQty) } : i
    );
    writeLS(LS.inventoryItems, nextInv);
    const after = nextInv.find((i) => i.itemCode === invItem.itemCode);
    pushStockTransaction({
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: todayStr(),
      dateTime: nowDateTimeStr(),
      itemCode: invItem.itemCode,
      itemName: invItem.itemName,
      unit: invItem.unit || 'Nos',
      type: 'OUT',
      quantity: issueQty,
      balanceAfter: after ? Number(after.currentQty) || 0 : 0,
      reason: `Out for Heat Treatment → ${rec.vendorName}`,
      reference: htrNumber,
      transactionNumber: htrNumber,
      jobCardNumber: rec.jobCardNumber,
      projectId: rec.projectId,
      issuedTo: rec.vendorName,
      issuedBy: issuedBy || info.employee?.name || info.auth?.username || 'Store'
    }, { transactionNumber: htrNumber });
  }

  const updated = updateHTOutsourceRequest(htrNumber, {
    issuedQty: issueQty,
    issuedDate: todayStr(),
    issuedBy: issuedBy || info.employee?.name || info.auth?.username || 'Store',
    outwardChallan,
    vehicleNo,
    status: HT_OUTSOURCE_STATUS.ISSUED
  }, 'HTR ISSUED TO VENDOR');
  syncJobCardHT(rec.jobCardNumber, {
    qtySent: issueQty,
    sentDate: todayStr(),
    status: 'Sent to Vendor',
    vendor: rec.vendorName
  });
  appendAuditLog({
    action: 'HTR STOCK OUT',
    reference: htrNumber,
    details: `Qty ${issueQty} out to ${rec.vendorName} | Challan: ${outwardChallan || '-'} | At vendor stock: ${issueQty - rec.receivedQty}`
  });
  pushNotification({
    title: `${htrNumber} issued to vendor`,
    message: `${issueQty} Nos sent to ${rec.vendorName} for heat treatment.`,
    type: 'info',
    reference: htrNumber,
    targetDept: 'Production Department'
  });
  return updated;
};

export const receiveHTRFromVendor = ({ htrNumber, qty, inwardChallan = '', receivedBy = '', remarks = '' }) => {
  if (!hasPermission('ht_outsource.store_action') && !hasPermission('material_issue.confirm')) {
    throw new Error('Permission denied: ht_outsource.store_action');
  }
  const list = getHTList();
  const rec = list.find((r) => r.htrNumber === htrNumber);
  if (!rec) throw new Error(`HT Outsource Request ${htrNumber} not found.`);
  if (rec.status !== HT_OUTSOURCE_STATUS.ISSUED) {
    throw new Error(`${htrNumber} must be Issued to Vendor before goods can be received back.`);
  }
  const recvQty = Number(qty) || 0;
  if (recvQty <= 0) throw new Error('Enter qty received (must be > 0).');
  if (recvQty > Number(rec.issuedQty)) {
    throw new Error(`Received qty ${recvQty} exceeds issued qty ${rec.issuedQty}.`);
  }

  const info = getCurrentUserInfo();
  const invItem = findInventoryForHTR(rec);
  if (invItem) {
    const inv = getInventoryItems();
    const nextInv = inv.map((i) =>
      i.itemCode === invItem.itemCode
        ? { ...i, currentQty: (Number(i.currentQty) || 0) + recvQty }
        : i
    );
    writeLS(LS.inventoryItems, nextInv);
    const after = nextInv.find((i) => i.itemCode === invItem.itemCode);
    pushStockTransaction({
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: todayStr(),
      dateTime: nowDateTimeStr(),
      itemCode: invItem.itemCode,
      itemName: invItem.itemName,
      unit: invItem.unit || 'Nos',
      type: 'IN',
      quantity: recvQty,
      balanceAfter: after ? Number(after.currentQty) || 0 : 0,
      reason: `Heat Treatment return from ${rec.vendorName}`,
      reference: htrNumber,
      transactionNumber: htrNumber,
      jobCardNumber: rec.jobCardNumber,
      projectId: rec.projectId,
      issuedBy: receivedBy || info.employee?.name || info.auth?.username || 'Store'
    }, { transactionNumber: htrNumber });
  }

  const updated = updateHTOutsourceRequest(htrNumber, {
    receivedQty: recvQty,
    receivedDate: todayStr(),
    receivedBy: receivedBy || info.employee?.name || info.auth?.username || 'Store',
    inwardChallan,
    remarks: remarks || rec.remarks,
    status: HT_OUTSOURCE_STATUS.RECEIVED
  }, 'HTR RECEIVED FROM VENDOR');
  syncJobCardHT(rec.jobCardNumber, {
    qtyReceived: recvQty,
    receivedDate: todayStr(),
    status: 'Received'
  });
  appendAuditLog({
    action: 'HTR STOCK IN',
    reference: htrNumber,
    details: `Qty ${recvQty} in from ${rec.vendorName} | Challan: ${inwardChallan || '-'} | Still at vendor: ${rec.issuedQty - recvQty}`
  });
  pushNotification({
    title: `${htrNumber} received at store`,
    message: `${recvQty} Nos back from ${rec.vendorName}. Production to record actual hardness.`,
    type: 'info',
    reference: htrNumber,
    targetDept: 'Production Department'
  });
  return updated;
};

export const completeHTR = ({ htrNumber, actualHardness = '', disposition = 'Pass', completedBy = '', remarks = '' }) => {
  if (!hasPermission('ht_outsource.create') && !hasPermission('job_card.update_progress') && !hasPermission('production.qc.manage')) {
    throw new Error('Permission denied to complete heat treatment verification.');
  }
  const list = getHTList();
  const rec = list.find((r) => r.htrNumber === htrNumber);
  if (!rec) throw new Error(`HT Outsource Request ${htrNumber} not found.`);
  if (rec.status !== HT_OUTSOURCE_STATUS.RECEIVED) {
    throw new Error('Goods must be Received at Store before production can mark hardness Pass/Fail.');
  }
  const info = getCurrentUserInfo();
  const status = disposition === 'Pass' ? HT_OUTSOURCE_STATUS.COMPLETED : rec.status;
  const updated = updateHTOutsourceRequest(htrNumber, {
    actualHardness,
    disposition,
    completedBy: completedBy || info.employee?.name || info.auth?.username || 'Production',
    completedDate: todayStr(),
    remarks: remarks || rec.remarks,
    status
  }, 'HTR HARDNESS VERIFIED');
  syncJobCardHT(rec.jobCardNumber, {
    actualHardness,
    disposition,
    status: disposition === 'Pass' ? 'Completed' : 'Failed / Rework',
    inspector: completedBy || info.employee?.name || 'Production',
    remarks: remarks || rec.remarks
  });
  pushNotification({
    title: `${htrNumber} hardness ${disposition}`,
    message: `Actual: ${actualHardness || '-'} vs Target: ${rec.targetHardness || '-'}`,
    type: disposition === 'Pass' ? 'success' : 'warning',
    reference: htrNumber,
    targetDept: 'Production Department'
  });
  return updated;
};

export const cancelHTR = (htrNumber, reason = '') => {
  if (!hasPermission('ht_outsource.create') && !hasPermission('material_request.cancel')) {
    throw new Error('Permission denied to cancel HTR.');
  }
  const list = getHTList();
  const rec = list.find((r) => r.htrNumber === htrNumber);
  if (!rec) throw new Error(`HT Outsource Request ${htrNumber} not found.`);
  if (rec.status === HT_OUTSOURCE_STATUS.ISSUED) {
    throw new Error('Cannot cancel after material is issued to vendor. Receive goods back first.');
  }
  return updateHTOutsourceRequest(htrNumber, { status: HT_OUTSOURCE_STATUS.CANCELLED, remarks: reason || rec.remarks }, 'HTR CANCELLED');
};

export const linkInventoryToHTR = (htrNumber, inventoryItemCode) => {
  return updateHTOutsourceRequest(htrNumber, { inventoryItemCode }, 'HTR INVENTORY LINKED');
};
