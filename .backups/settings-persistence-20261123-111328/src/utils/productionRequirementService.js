/**
 * Production Item Requirement workflow.
 *
 * Sales Order → Production creates a Required Item List → Store is notified →
 * Store reviews live stock availability (Items to Review) → shortage lines are
 * raised as Purchase Indents (shortage only, duplicate-protected) →
 * Purchase / Receipt / QC completes → Store marks Material Available →
 * Production marks the requirement Completed.
 *
 * The old Store "Sales Order Review" workflow keeps working unchanged — this
 * module is additive and links into the existing Purchase Indent machinery.
 */
import {
  readLS,
  writeLS,
  getInventoryItems,
  pushNotification,
  appendAuditLog,
  todayStr,
  nowDateTimeStr
} from './storeService.js';
import { generateSequentialNumber, saveSequenceCounter } from './storeSequencer.js';
import { deleteWorkflowDocument } from './workflowFiles.js';
import { hasPermission, getCurrentUserInfo, getCurrentDepartment, isAdmin } from './permissions.js';
import { getIndents, createPurchaseIndent, INDENT_STATUS } from './workflowService.js';

const REQ_KEY = 'productionRequirements';
const REQ_SEQ_KEY = 'productionRequirementSequence';

export const REQUIREMENT_STATUS = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending Review',
  STOCK_AVAILABLE: 'Stock Available',
  SHORTAGE_IDENTIFIED: 'Shortage Identified',
  PURCHASE_REQUIRED: 'Purchase Required',
  PURCHASE_COMPLETED: 'Purchase Completed',
  MATERIAL_AVAILABLE: 'Material Available',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
};

const REQUIREMENT_LINK = (no) => `/production/item-requirements?req=${encodeURIComponent(no)}`;
const STORE_REVIEW_LINK = (no) => `/store/item-requirements?req=${encodeURIComponent(no)}`;

/* ------------------------------ low level helpers ------------------------------ */

const getList = (key) => readLS(key, []);
const saveList = (key, list) => writeLS(key, list);

const currentUser = () => {
  const info = getCurrentUserInfo();
  return {
    name: info.employee?.name || info.auth?.username || 'User',
    empId: info.employee?.employeeId || '-',
    dept: info.employee?.department || '-',
    role: info.employee?.role || info.employee?.designation || '-'
  };
};

const requirePerm = (perm, message) => {
  if (!hasPermission(perm)) throw new Error(message || `Permission denied: ${perm}`);
};

const isAdminUser = () => isAdmin() || hasPermission('*');

const inDept = (deptName) => isAdminUser() || getCurrentDepartment() === deptName;
const isStore = () => inDept('Store Department');
const isProduction = () => inDept('Production Department');
const isPurchase = () => inDept('Purchase Department');

const deny = (msg) => {
  throw new Error(msg);
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const log = (action, reference, details = '') => appendAuditLog({ action, reference, details });

const historyEntry = (action, details = '') => ({ ...currentUser(), action, details, at: nowDateTimeStr() });

const notify = (payload) => pushNotification(payload);

/**
 * Item Requirements are a Production MANAGER responsibility: a Production
 * Employee must not see or touch this screen. The token is granted only to
 * Production Manager (and Administrator), so both the permission and the
 * department are enforced here.
 */
const requireProduction = () => {
  requirePerm(
    'production.requirement.manage',
    'Permission denied: only the Production Manager of the Production Department can manage Item Requirements.'
  );
  if (!isProduction()) deny('Only the Production Department can manage Item Requirements.');
};

const requireStore = (perm, message) => {
  requirePerm(perm, message);
  if (!isStore()) deny(message);
};

export const ensureRequirementsSeeded = () => {
  if (!localStorage.getItem(REQ_KEY)) localStorage.setItem(REQ_KEY, '[]');
};

/* ------------------------------ line normalisation ------------------------------ */

/**
 * Item Master identity check: a requirement line may carry the inventory
 * record's unique id (set by the Material Name selector). Records written
 * before ids existed fall back to their item code, which is unique in the
 * master (see addInventoryItem in storeService).
 */
const inventoryHasId = (id) => {
  const s = String(id || '').trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return getInventoryItems().some(
    (x) => String(x.id || '').trim() === s || String(x.itemCode || '').toLowerCase() === lower
  );
};

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Two requirement lines reference the same material (by itemId, else code, else name). */
const isSameMaterial = (a, b) => {
  if (a.itemId && b.itemId) return String(a.itemId) === String(b.itemId);
  if (a.itemCode && b.itemCode) return sameText(a.itemCode, b.itemCode);
  return sameText(a.itemName, b.itemName);
};

const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    deny('Add at least one item to the Required Item List.');
  }
  const norm = items.map((raw, idx) => {
    const it = raw || {};
    const item = {
      lineId: String(it.lineId || `l-${Date.now().toString(36)}-${idx}-${Math.random().toString(36).slice(2, 6)}`),
      itemId: String(it.itemId ?? '').trim(),
      itemName: String(it.itemName ?? '').trim(),
      itemCode: String(it.itemCode ?? '').trim(),
      description: String(it.description ?? '').trim(),
      specification: String(it.specification ?? '').trim(),
      size: String(it.size ?? '').trim(),
      purpose: String(it.purpose ?? '').trim(),
      quantity: num(it.quantity),
      unit: String(it.unit ?? '').trim() || 'Nos',
      requiredDate: String(it.requiredDate ?? '').trim(),
      remarks: String(it.remarks ?? '').trim()
    };
    if (!item.itemName) deny('Please select a material/item from Inventory.');
    if (item.itemId && !inventoryHasId(item.itemId)) deny('Please select a material/item from Inventory.');
    if (item.quantity <= 0) deny(`"${item.itemName}": quantity must be greater than zero.`);
    return item;
  });
  for (let a = 0; a < norm.length; a += 1) {
    for (let b = a + 1; b < norm.length; b += 1) {
      if (isSameMaterial(norm[a], norm[b])) deny('This item is already added to the requirement.');
    }
  }
  return norm;
};

const materialKeyOf = (it) =>
  String(it.itemCode || it.itemName || it.materialCode || it.materialName || '')
    .toLowerCase()
    .trim();

const findInventoryItem = (it) => {
  const inv = getInventoryItems();
  const id = String(it.itemId || '').trim();
  if (id) {
    const lower = id.toLowerCase();
    const byId = inv.find(
      (x) => String(x.id || '').trim() === id || String(x.itemCode || '').toLowerCase() === lower
    );
    if (byId) return byId;
  }
  const code = String(it.itemCode || '').toLowerCase().trim();
  const name = String(it.itemName || '').toLowerCase().trim();
  return (
    inv.find(
      (x) =>
        (code && String(x.itemCode || '').toLowerCase().trim() === code) ||
        (name && String(x.itemName || '').toLowerCase().trim() === name)
    ) || null
  );
};

/* ------------------------------ stock / indent projections ------------------------------ */

/** Quantity of a requirement's items already covered by non-cancelled indents. */
export const getIndentedQtyMap = (requirementNumber) => {
  const map = {};
  getIndents().forEach((ind) => {
    if (String(ind.requirementNumber || '') !== String(requirementNumber)) return;
    if (ind.status === INDENT_STATUS.CANCELLED) return;
    (ind.items || []).forEach((it) => {
      const k = materialKeyOf(it);
      if (!k) return;
      map[k] = (map[k] || 0) + num(it.purchaseQty);
    });
  });
  return map;
};

/**
 * Live, non-destructive projection of every requirement line:
 * required vs current stock vs reserved vs already-indented → remaining shortage.
 */
export const computeRequirementLines = (requirementOrNumber) => {
  const rec =
    typeof requirementOrNumber === 'string' ? getRequirement(requirementOrNumber) : requirementOrNumber;
  if (!rec) return [];
  const indented = getIndentedQtyMap(rec.requirementNumber);
  const savedLines = rec.storeReview?.lines || {};
  return (rec.items || []).map((it, idx) => {
    const match = findInventoryItem(it);
    const currentStock = match ? num(match.currentQty) : 0;
    const reservedQty = match ? num(match.reservedQty) : 0;
    const availableQty = Math.max(0, currentStock - reservedQty);
    const requiredQty = num(it.quantity);
    const shortageQty = Math.max(0, requiredQty - availableQty);
    const indentedQty = indented[materialKeyOf(it)] || 0;
    const remainingShortageQty = Math.max(0, shortageQty - indentedQty);
    const saved = savedLines[it.lineId] || {};
    return {
      ...it,
      lineNo: idx + 1,
      inventoryMatched: Boolean(match),
      inventoryItemName: match?.itemName || '',
      currentStock,
      reservedQty,
      availableQty,
      requiredQty,
      shortageQty,
      indentedQty,
      remainingShortageQty,
      lineStatus: shortageQty > 0 ? 'Shortage' : 'Available',
      storeRemarks: saved.remarks || ''
    };
  });
};

/* ------------------------------ CRUD ------------------------------ */

export const getRequirements = () => getList(REQ_KEY);

export const getRequirement = (requirementNumber) =>
  getRequirements().find((r) => String(r.requirementNumber) === String(requirementNumber)) || null;

const persist = (rec) => {
  const list = getRequirements();
  const idx = list.findIndex((r) => String(r.requirementNumber) === String(rec.requirementNumber));
  if (idx >= 0) list[idx] = rec;
  else list.unshift(rec);
  saveList(REQ_KEY, list);
  return rec;
};

export const getRequirementsForSO = (soNumber) =>
  getRequirements().filter((r) => String(r.soNumber || '') === String(soNumber));

export const getRequirementsForJobCard = (jobCardNumber) =>
  getRequirements().filter((r) => String(r.jobCardNumber || '') === String(jobCardNumber));

export const getRequirementsAwaitingStoreReview = () =>
  getRequirements().filter((r) => r.status === REQUIREMENT_STATUS.PENDING_REVIEW);

export const createRequirement = ({
  projectId = '',
  soNumber = '',
  jobCardNumber = '',
  customer = '',
  partName = '',
  productionJob = '',
  drawingNo = '',
  qty = '',
  requiredDate = '',
  attachments = [],
  items = []
}) => {
  requireProduction();
  const normItems = normalizeItems(items);
  const project = String(projectId).trim();
  if (!project) deny('Project ID is required for the Required Item List.');

  const requirementNumber = generateSequentialNumber({
    prefix: 'PR',
    sequenceKey: REQ_SEQ_KEY,
    historyKey: REQ_KEY,
    idField: 'requirementNumber'
  });
  const user = currentUser();
  const rec = {
    requirementNumber,
    requirementDate: todayStr(),
    projectId: project,
    soNumber: String(soNumber).trim(),
    jobCardNumber: String(jobCardNumber).trim(),
    customer: String(customer).trim(),
    partName: String(partName).trim(),
    productionJob: String(productionJob).trim(),
    drawingNo: String(drawingNo).trim(),
    qty: Number(qty) || 0,
    requiredDate: String(requiredDate).trim(),
    attachments: Array.isArray(attachments) ? attachments : [],
    status: REQUIREMENT_STATUS.DRAFT,
    items: normItems,
    storeReview: null,
    indentNumbers: [],
    createdBy: user.name,
    createdByEmpId: user.empId,
    createdByDept: user.dept,
    createdAt: nowDateTimeStr(),
    updatedAt: nowDateTimeStr(),
    submittedAt: '',
    history: [historyEntry('Requirement created', `${normItems.length} item(s) for Project ${project}`)]
  };
  saveList(REQ_KEY, [rec, ...getRequirements()]);
  saveSequenceCounter(REQ_SEQ_KEY, requirementNumber);
  log('PRODUCTION REQUIREMENT CREATED', requirementNumber, `Project ${project} | ${normItems.length} item(s)`);
  return rec;
};

export const updateRequirement = (requirementNumber, patch = {}) => {
  requireProduction();
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  const wasCancelled = rec.status === REQUIREMENT_STATUS.CANCELLED;
  if (rec.status !== REQUIREMENT_STATUS.DRAFT && !wasCancelled) {
    deny('Only Draft or Cancelled Item Requirements can be edited - cancel the requirement before making changes.');
  }

  const items = patch.items !== undefined ? normalizeItems(patch.items) : rec.items;
  const updated = {
    ...rec,
    status: wasCancelled ? REQUIREMENT_STATUS.DRAFT : rec.status,
    projectId: patch.projectId !== undefined ? String(patch.projectId).trim() : rec.projectId,
    soNumber: patch.soNumber !== undefined ? String(patch.soNumber).trim() : rec.soNumber,
    jobCardNumber: patch.jobCardNumber !== undefined ? String(patch.jobCardNumber).trim() : rec.jobCardNumber,
    customer: patch.customer !== undefined ? String(patch.customer).trim() : rec.customer,
    partName: patch.partName !== undefined ? String(patch.partName).trim() : rec.partName,
    productionJob: patch.productionJob !== undefined ? String(patch.productionJob).trim() : rec.productionJob,
    drawingNo: patch.drawingNo !== undefined ? String(patch.drawingNo).trim() : rec.drawingNo || '',
    qty: patch.qty !== undefined ? Number(patch.qty) || 0 : rec.qty || 0,
    attachments: patch.attachments !== undefined && Array.isArray(patch.attachments) ? patch.attachments : rec.attachments || [],
    requiredDate: patch.requiredDate !== undefined ? String(patch.requiredDate).trim() : rec.requiredDate,
    items,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(rec.history || []),
      ...(wasCancelled ? [historyEntry('Re-opened for revision', 'Status moved back to Draft')] : []),
      historyEntry('Requirement edited', `${items.length} item(s)`)
    ]
  };
  if (!updated.projectId) deny('Project ID is required for the Required Item List.');
  persist(updated);
  const keptIds = new Set((updated.attachments || []).map((d) => d && d.id));
  (rec.attachments || []).forEach((d) => {
    if (d && d.id && !keptIds.has(d.id)) deleteWorkflowDocument(d.id);
  });
  log('PRODUCTION REQUIREMENT EDITED', requirementNumber, `${items.length} item(s)`);
  return updated;
};

export const deleteRequirement = (requirementNumber) => {
  if (!isAdmin()) deny('Permission denied: only an Admin can delete an Item Requirement.');
  requireProduction();
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (rec.status !== REQUIREMENT_STATUS.DRAFT && rec.status !== REQUIREMENT_STATUS.CANCELLED) {
    deny('Only Draft or Cancelled Item Requirements can be deleted - cancel the requirement first.');
  }
  const linkedIndent = (rec.indentNumbers || [])[0]
    || (getIndents() || []).find((i) => i && i.requirementNumber === requirementNumber)?.indentNumber;
  if (linkedIndent) {
    deny(`Item Requirement ${requirementNumber} cannot be deleted - Purchase Indent ${linkedIndent} was raised from it.`);
  }
  saveList(REQ_KEY, getRequirements().filter((r) => String(r.requirementNumber) !== String(requirementNumber)));
  (rec.attachments || []).forEach((d) => {
    if (d && d.id) deleteWorkflowDocument(d.id);
  });
  log('PRODUCTION REQUIREMENT DELETED', requirementNumber, `Project ${rec.projectId}`);
  return true;
};

export const submitRequirement = (requirementNumber) => {
  requireProduction();
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (rec.status !== REQUIREMENT_STATUS.DRAFT) deny('Only Draft Item Requirements can be submitted to Store.');
  if (!rec.items?.length) deny('Add at least one item before submitting.');

  rec.status = REQUIREMENT_STATUS.PENDING_REVIEW;
  rec.submittedAt = nowDateTimeStr();
  rec.updatedAt = rec.submittedAt;
  rec.history = [...(rec.history || []), historyEntry('Submitted to Store', `${rec.items.length} item(s) for review`)];
  persist(rec);
  log('REQUIREMENT SUBMITTED TO STORE', requirementNumber, `Project ${rec.projectId} | ${rec.items.length} item(s)`);

  notify({
    title: 'Item Requirement submitted by Production',
    message: `Production has submitted Item Requirement ${requirementNumber} for Project ${rec.projectId}${
      rec.productionJob ? ` (Production Job: ${rec.productionJob})` : ''
    } with ${rec.items.length} item(s). Review stock availability and raise Purchase Indents for shortages.`,
    reference: requirementNumber,
    targetDept: 'Store Department',
    type: 'store',
    link: STORE_REVIEW_LINK(requirementNumber)
  });
  return rec;
};

export const cancelRequirement = (requirementNumber, reason = '') => {
  if (!isAdmin()) deny('Permission denied: only an Admin can cancel an Item Requirement.');
  if (!String(reason || '').trim()) deny('A cancellation reason is required.');
  requireProduction();
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (rec.status === REQUIREMENT_STATUS.COMPLETED || rec.status === REQUIREMENT_STATUS.CANCELLED) {
    deny(`Item Requirement ${requirementNumber} is already ${rec.status.toLowerCase()}.`);
  }
  rec.status = REQUIREMENT_STATUS.CANCELLED;
  rec.cancelReason = String(reason).trim();
  rec.updatedAt = nowDateTimeStr();
  rec.history = [...(rec.history || []), historyEntry('Requirement cancelled', reason)];
  persist(rec);
  log('PRODUCTION REQUIREMENT CANCELLED', requirementNumber, reason);
  return rec;
};

/* ------------------------------ Store review ------------------------------ */

export const saveStoreReview = (requirementNumber, { remarks = '', lineRemarks = {} } = {}) => {
  requireStore(
    'indent.view',
    'Permission denied: only the Store Department can review an Item Requirement.'
  );
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (
    rec.status === REQUIREMENT_STATUS.DRAFT ||
    rec.status === REQUIREMENT_STATUS.COMPLETED ||
    rec.status === REQUIREMENT_STATUS.CANCELLED
  ) {
    deny(`Item Requirement ${requirementNumber} cannot be reviewed in status "${rec.status}".`);
  }

  const lines = computeRequirementLines(rec);
  if (!lines.length) deny('Item Requirement has no items to review.');

  const user = currentUser();
  const shortageCount = lines.filter((l) => l.shortageQty > 0).length;
  const reviewLines = {};
  lines.forEach((l) => {
    reviewLines[l.lineId] = {
      availableQty: l.availableQty,
      shortageQty: l.shortageQty,
      status: l.lineStatus,
      remarks: String(lineRemarks[l.lineId] || '')
    };
  });

  const updated = {
    ...rec,
    storeReview: {
      reviewedBy: user.name,
      reviewedAt: nowDateTimeStr(),
      remarks: String(remarks || ''),
      lines: reviewLines
    },
    status: shortageCount > 0 ? REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED : REQUIREMENT_STATUS.STOCK_AVAILABLE,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(rec.history || []),
      historyEntry(
        'Store review saved',
        shortageCount > 0
          ? `${shortageCount} item(s) with shortage — Purchase Indent needed`
          : 'All items available in stock'
      )
    ]
  };
  persist(updated);
  log(
    'PRODUCTION REQUIREMENT REVIEWED',
    requirementNumber,
    `${lines.length - shortageCount} available | ${shortageCount} shortage`
  );

  notify({
    title: 'Store review saved for Item Requirement',
    message: `Store completed the stock review of Item Requirement ${requirementNumber} (Project ${updated.projectId}): ${
      lines.length - shortageCount} item(s) available, ${shortageCount} item(s) with shortage.`,
    reference: requirementNumber,
    targetDept: 'Production Department',
    type: 'info',
    link: REQUIREMENT_LINK(requirementNumber)
  });

  return { requirement: updated, lines: computeRequirementLines(updated) };
};

/* ------------------------------ Purchase Indent from shortage ------------------------------ */

export const createIndentFromRequirement = ({
  requirementNumber,
  lineIds = null,
  quantities = {},
  reason = '',
  remarks = '',
  requiredDate = ''
}) => {
  requireStore('indent.create', 'Permission denied: only the Store Department can create a Purchase Indent.');
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (
    rec.status === REQUIREMENT_STATUS.DRAFT ||
    rec.status === REQUIREMENT_STATUS.COMPLETED ||
    rec.status === REQUIREMENT_STATUS.CANCELLED
  ) {
    deny(`Item Requirement ${requirementNumber} cannot raise a Purchase Indent in status "${rec.status}".`);
  }

  const shortageLines = computeRequirementLines(rec).filter((l) => l.remainingShortageQty > 0);
  if (!shortageLines.length) {
    deny('No pending shortage — every item is either available in stock or already indented.');
  }
  const selected = Array.isArray(lineIds) && lineIds.length
    ? shortageLines.filter((l) => lineIds.includes(l.lineId))
    : shortageLines;
  if (!selected.length) deny('Select at least one shortage line to indent.');

  const built = [];
  selected.forEach((l) => {
    const qty = Math.min(
      num(quantities?.[l.lineId] ?? l.remainingShortageQty),
      l.remainingShortageQty
    );
    if (qty <= 0) return;
    built.push({
      lineId: l.lineId,
      materialCode: l.itemCode || '',
      materialName: l.itemName,
      description: l.description,
      specification: l.specification,
      unit: l.unit,
      requiredQty: l.requiredQty,
      orderedQty: l.requiredQty,
      availableStock: l.availableQty,
      availableQty: l.availableQty,
      shortageQty: l.remainingShortageQty,
      purchaseQty: qty,
      requiredDate: l.requiredDate || requiredDate || ''
    });
  });
  if (!built.length) deny('No lines with quantity to indent.');

  const indent = createPurchaseIndent({
    soNumber: rec.soNumber || '',
    reason: reason || `Shortage from Production Requirement ${requirementNumber}`,
    remarks,
    requiredDate,
    lines: built,
    sourceInfo: {
      sourceType: 'productionRequirement',
      requirementNumber,
      productionJob: rec.productionJob,
      projectId: rec.projectId,
      customer: rec.customer,
      source: 'Production Requirement Shortage'
    }
  });

  const updated = {
    ...rec,
    indentNumbers: Array.from(new Set([...(rec.indentNumbers || []), indent.indentNumber])),
    status: REQUIREMENT_STATUS.PURCHASE_REQUIRED,
    updatedAt: nowDateTimeStr(),
    history: [
      ...(rec.history || []),
      historyEntry('Purchase Indent created', `${indent.indentNumber} for ${indent.items.length} item(s)`)
    ]
  };
  persist(updated);
  log('REQUIREMENT INDENT CREATED', requirementNumber, `Indent ${indent.indentNumber}`);

  notify({
    title: 'Purchase Indent raised for Item Requirement',
    message: `Purchase Indent ${indent.indentNumber} raised for Item Requirement ${requirementNumber} (Project ${updated.projectId}).`,
    reference: requirementNumber,
    targetDept: 'Production Department',
    type: 'info',
    link: REQUIREMENT_LINK(requirementNumber)
  });

  return indent;
};

/* ------------------------------ status transitions ------------------------------ */

export const markPurchaseCompleted = (requirementNumber) => {
  requireStore('indent.view', 'Permission denied: only the Store Department can update requirement status.');
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (rec.status !== REQUIREMENT_STATUS.PURCHASE_REQUIRED) {
    deny(`Only a Requirement in "Purchase Required" can be marked Purchase Completed (current: "${rec.status}").`);
  }
  rec.status = REQUIREMENT_STATUS.PURCHASE_COMPLETED;
  rec.updatedAt = nowDateTimeStr();
  rec.history = [...(rec.history || []), historyEntry('Purchase completed', 'All raised indents procured')];
  persist(rec);
  log('REQUIREMENT PURCHASE COMPLETED', requirementNumber, rec.indentNumbers?.join(', ') || '');
  return rec;
};

export const markMaterialAvailable = (requirementNumber) => {
  requireStore('indent.view', 'Permission denied: only the Store Department can update requirement status.');
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (
    rec.status === REQUIREMENT_STATUS.DRAFT ||
    rec.status === REQUIREMENT_STATUS.COMPLETED ||
    rec.status === REQUIREMENT_STATUS.CANCELLED
  ) {
    deny(`Item Requirement ${requirementNumber} cannot be marked Material Available in status "${rec.status}".`);
  }
  const remaining = computeRequirementLines(rec).filter((l) => l.remainingShortageQty > 0);
  if (remaining.length) {
    deny(`${remaining.length} item(s) still have un-indented shortage — raise a Purchase Indent first.`);
  }
  rec.status = REQUIREMENT_STATUS.MATERIAL_AVAILABLE;
  rec.updatedAt = nowDateTimeStr();
  rec.history = [...(rec.history || []), historyEntry('Material available', 'All items ready for production')];
  persist(rec);
  log('REQUIREMENT MATERIAL AVAILABLE', requirementNumber, '');

  notify({
    title: 'Material available for Item Requirement',
    message: `All items for Item Requirement ${requirementNumber} (Project ${rec.projectId}) are available. Production can proceed.`,
    reference: requirementNumber,
    targetDept: 'Production Department',
    type: 'info',
    link: REQUIREMENT_LINK(requirementNumber)
  });
  return rec;
};

export const completeRequirement = (requirementNumber) => {
  const rec = getRequirement(requirementNumber);
  if (!rec) deny(`Item Requirement ${requirementNumber} not found.`);
  if (!(isProduction() || isStore())) {
    deny('Only Production or Store can complete an Item Requirement.');
  }
  if (rec.status !== REQUIREMENT_STATUS.MATERIAL_AVAILABLE) {
    deny(`Only a Requirement with status "Material Available" can be completed (current: "${rec.status}").`);
  }
  rec.status = REQUIREMENT_STATUS.COMPLETED;
  rec.updatedAt = nowDateTimeStr();
  rec.history = [...(rec.history || []), historyEntry('Requirement completed', 'Material handed to production')];
  persist(rec);
  log('REQUIREMENT COMPLETED', requirementNumber, `Project ${rec.projectId}`);
  return rec;
};

/* ------------------------------ views ------------------------------ */

export const getRequirementIndents = (requirementNumber) =>
  getIndents()
    .filter((i) => String(i.requirementNumber || '') === String(requirementNumber))
    .map((i) => ({
      indentNumber: i.indentNumber,
      indentDate: i.indentDate,
      status: i.status,
      poNumber: i.poNumber || '',
      items: (i.items || []).length,
      purchaseQty: (i.items || []).reduce((sum, it) => sum + num(it.purchaseQty), 0)
    }));

/** Compact counts used by dashboards. */
export const getRequirementSummary = () => {
  const all = getRequirements();
  return {
    total: all.length,
    drafts: all.filter((r) => r.status === REQUIREMENT_STATUS.DRAFT).length,
    awaitingReview: all.filter((r) => r.status === REQUIREMENT_STATUS.PENDING_REVIEW).length,
    shortage: all.filter(
      (r) =>
        r.status === REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED ||
        r.status === REQUIREMENT_STATUS.PURCHASE_REQUIRED ||
        r.status === REQUIREMENT_STATUS.PURCHASE_COMPLETED
    ).length,
    materialAvailable: all.filter((r) => r.status === REQUIREMENT_STATUS.MATERIAL_AVAILABLE).length,
    completed: all.filter((r) => r.status === REQUIREMENT_STATUS.COMPLETED).length
  };
};
