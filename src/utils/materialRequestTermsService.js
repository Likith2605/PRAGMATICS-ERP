/**
 * Terms & Requirement → Material Request bridge.
 *
 * Production → Request Material must NOT re-enter material lines that already
 * exist for a Sales Order / Job Card. This module fetches them and projects
 * the requested / issued / balance quantities on top.
 *
 * Requirement source (in priority order):
 *   1. Production → Item Requirements  (storage key `productionRequirements`,
 *      records PR-xxxx — the structured material requirement list linked to a
 *      Sales Order + Job Card). Every line carries a `lineId` which is kept as
 *      `termsRequirementItemId` on the Material Request for traceability.
 *   2. Fallback: the Sales Order "Ordered Items" lines
 *      (storage key `salesOrderHistory` → payload.items), but only the lines
 *      that exist in the Item Master (inventoryItems).
 *
 * This module is READ-ONLY over storage: it never writes anything.
 * Storage keys read: productionRequirements, salesOrderHistory, materialRequests,
 * storeIssueHistory, inventoryItems.
 */
import { getRequirements, REQUIREMENT_STATUS } from './productionRequirementService.js';
import { getSalesOrderByRef } from './workflowService.js';
import {
  getMaterialRequests,
  getStoreIssues,
  getInventoryItems,
  getMRScopeQtyMaps,
  SOURCE_TYPE
} from './storeService.js';

const norm = (v) => String(v ?? '').trim();
const num = (v) => Number(v) || 0;

export const TERMS_SOURCE = {
  ITEM_REQUIREMENT: 'Item Requirements',
  SALES_ORDER: 'Sales Order'
};

const normalizeInventoryItem = (item = {}) => ({
  ...(item.payload || {}),
  ...item,
  itemCode: norm(item.itemCode || item.item_code || item.payload?.itemCode),
  itemName: norm(item.itemName || item.material_name || item.payload?.itemName),
  unit: norm(item.unit || item.payload?.unit || 'Nos'),
  currentQty: num(item.currentQty ?? item.current_qty ?? item.payload?.currentQty)
});

const buildInventoryIndex = (inventory = getInventoryItems()) => {
  const byCode = new Map();
  const byName = new Map();
  (inventory || []).map(normalizeInventoryItem).forEach((it) => {
    if (!it) return;
    const code = norm(it.itemCode).toLowerCase();
    const name = norm(it.itemName).toLowerCase();
    if (code && !byCode.has(code)) byCode.set(code, it);
    if (name && !byName.has(name)) byName.set(name, it);
  });
  return { byCode, byName };
};

/* Match a free requirement line against the Item Master (code first, then name). */
const matchInventory = (idx, { itemCode, itemName }) => {
  const code = norm(itemCode).toLowerCase();
  const name = norm(itemName).toLowerCase();
  if (code && idx.byCode.has(code)) return idx.byCode.get(code);
  if (name && idx.byName.has(name)) return idx.byName.get(name);
  return null;
};

/**
 * Which Item Requirement lists belong to the given Sales Order / Job Card?
 * - A Job Card takes its own requirement lists plus SO-level lists (records
 *   with no job card) — never another Job Card's lists.
 * - Cancelled lists are ignored.
 */
const requirementsFor = (so, jc, requirements = getRequirements()) =>
  requirements.filter((r) => {
    if (!r) return false;
    if (norm(r.status) === REQUIREMENT_STATUS.CANCELLED) return false;
    const rSO = norm(r.soNumber);
    const rJC = norm(r.jobCardNumber);
    if (jc) return rJC === jc || (!rJC && so && rSO === so);
    if (so) return rSO === so && !rJC;
    return false;
  });

/**
 * Terms & Requirement lines for a Sales Order / Job Card.
 *
 * @param {{salesOrderId?: string, jobCardNumber?: string}} scope
 * @returns {Array<{termsRequirementItemId, itemId, materialId, itemCode, itemName,
 *   description, specification, size, purpose, unit, termsRequiredQty, sourceType,
 *   sourceRef, source, inMaster}>}
 */
export const getTermsRequirementLines = ({
  salesOrderId = '',
  jobCardNumber = '',
  sourceData
} = {}) => {
  const so = norm(salesOrderId);
  const jc = norm(jobCardNumber);
  if (!so && !jc) return [];

  const idx = buildInventoryIndex(sourceData?.inventory);
  const rows = [];

  requirementsFor(so, jc, sourceData?.requirements).forEach((rec) => {
    (rec.items || []).forEach((line) => {
      const inv = matchInventory(idx, { itemCode: line.itemCode, itemName: line.itemName });
      rows.push({
        termsRequirementItemId: norm(line.lineId),
        itemId: norm(inv?.id || line.itemId),
        materialId: norm(inv?.itemCode || line.itemCode),
        itemCode: norm(inv?.itemCode || line.itemCode),
        itemName: norm(inv?.itemName || line.itemName),
        description: norm(inv?.itemName || line.description || line.itemName),
        specification: norm(line.specification || inv?.spec || ''),
        size: norm(line.size || ''),
        purpose: norm(line.purpose || ''),
        unit: norm(inv?.unit || line.unit || 'Nos'),
        termsRequiredQty: num(line.quantity),
        sourceType: SOURCE_TYPE.TERMS_REQUIREMENT,
        sourceRef: norm(rec.requirementNumber),
        source: TERMS_SOURCE.ITEM_REQUIREMENT,
        inMaster: Boolean(inv)
      });
    });
  });

  /* Fallback: nothing on the requirement lists → use the Sales Order's own
     Ordered Items (only the ones that exist in the Item Master). */
  if (rows.length === 0 && so) {
    const soRec = Array.isArray(sourceData?.salesOrders)
      ? sourceData.salesOrders.find((row) => String(row.reference || row.salesOrderRef || '') === so)
      : getSalesOrderByRef(so);
    (soRec?.payload?.items || []).forEach((line, i) => {
      const inv = matchInventory(idx, { itemCode: line.itemCode, itemName: line.itemName });
      if (!inv) return; /* not in the Item Master → cannot be requested (spec §10) */
      rows.push({
        termsRequirementItemId: `SO:${so}#${i + 1}`,
        itemId: norm(inv.id),
        materialId: norm(inv.itemCode),
        itemCode: norm(inv.itemCode),
        itemName: norm(inv.itemName),
        description: norm(inv.itemName),
        specification: norm(inv.spec || ''),
        size: norm(inv.sizeDimensions || ''),
        purpose: '',
        unit: norm(inv.unit || line.unit || 'Nos'),
        termsRequiredQty: num(line.quantity),
        sourceType: SOURCE_TYPE.TERMS_REQUIREMENT,
        sourceRef: so,
        source: TERMS_SOURCE.SALES_ORDER,
        inMaster: true
      });
    });
  }

  /* One line per material: sum quantities coming from several lists. */
  const byKey = new Map();
  rows.forEach((r) => {
    const key = (r.materialId || r.itemCode || r.itemName).toLowerCase();
    const found = byKey.get(key);
    if (found) {
      found.termsRequiredQty += r.termsRequiredQty;
      if (!found.sourceRef.includes(r.sourceRef)) found.sourceRef += `, ${r.sourceRef}`;
      found.inMaster = found.inMaster || r.inMaster;
      return;
    }
    byKey.set(key, { ...r });
  });
  return Array.from(byKey.values());
};

/**
 * Already-requested / already-issued quantities for the given scope.
 * Scope = the selected Job Card, or any Material Request raised against the
 * same Sales Order (so sibling job cards cannot double-request the same line).
 * Cancelled / Rejected requests are ignored.
 *
 * @returns {{requested: Object.<string, number>, issued: Object.<string, number>}}
 */
export const getScopeQtyMaps = ({
  salesOrderRef = '',
  jobCardNumber = '',
  excludeMrNumber = '',
  sourceData
} = {}) =>
  getMRScopeQtyMaps({
    salesOrderRef,
    jobCardNumber,
    excludeMrNumber,
    requests: sourceData?.requests,
    issues: sourceData?.issues
  });

/**
 * Terms & Requirement lines + live quantity projection used by the
 * Material Request screen:
 *
 *   Balance = Required − Already Requested − Already Issued
 *
 * @param {{salesOrderId?, jobCardNumber?, excludeMrNumber?}} scope
 *   `excludeMrNumber` must be set while EDITING an existing Material Request
 *   so its own quantities are not counted against itself.
 */
export const getMaterialRequestLines = ({
  salesOrderId = '',
  jobCardNumber = '',
  excludeMrNumber = '',
  sourceData
} = {}) => {
  const lines = getTermsRequirementLines({ salesOrderId, jobCardNumber, sourceData });
  if (lines.length === 0) return [];

  const scope = {
    salesOrderRef: norm(salesOrderId),
    jobCardNumber: norm(jobCardNumber),
    excludeMrNumber: norm(excludeMrNumber)
  };
  const { requested, issued } = getScopeQtyMaps({ ...scope, sourceData });
  const invIdx = buildInventoryIndex(sourceData?.inventory);

  return lines.map((ln) => {
    const key = (ln.materialId || ln.itemCode || ln.itemName).toLowerCase();
    const reqKey = norm(ln.materialId);
    const req = num(requested[reqKey] || requested[key]);
    const iss = num(issued[reqKey] || issued[key]);
    const inv = matchInventory(invIdx, { itemCode: ln.itemCode, itemName: ln.itemName });
    const available = num(inv?.currentQty);
    const required = num(ln.termsRequiredQty);
    const balance = Math.max(0, required - req - iss);
    return {
      ...ln,
      requestedQty: req,
      issuedQty: iss,
      termsRequiredQty: required,
      balanceQty: balance,
      availableQty: available,
      shortageQty: Math.max(0, balance - available)
    };
  });
};

/** Duplicate check used by the Add Item form and the create/update service. */
export const isDuplicateMaterial = (lines, materialId) => {
  const key = norm(materialId).toLowerCase();
  if (!key) return false;
  return (lines || []).some((ln) => norm(ln.materialId).toLowerCase() === key);
};

export const TERMS_LINE_SOURCE_LABEL = (source) =>
  source === TERMS_SOURCE.SALES_ORDER ? 'Sales Order Item' : 'Item Requirements';
