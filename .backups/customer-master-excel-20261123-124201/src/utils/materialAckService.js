/**
 * Store → Production Material Acknowledgement
 * ---------------------------------------------------------------------------
 * Closes the one gap in the existing Material Request flow: after Production
 * raises a Material Request, Stores formally confirms — per material — how much
 * is genuinely available, and that confirmation is pushed back to Production.
 *
 * Deliberately layered on top of the EXISTING data:
 *   • Reads/writes the existing `materialRequests` key (no parallel MR system).
 *   • Availability comes from the existing `inventoryItems` master.
 *   • Shortage purchasing reuses `workflowService.createPurchaseIndent`.
 *   • Notifications reuse `storeService.pushNotification`.
 *
 * Acknowledgement state lives in `mr.acknowledgement` and is intentionally
 * SEPARATE from `mr.status` (the issue lifecycle), so no existing status
 * semantics, tests or screens change.
 *
 * Stock rules enforced here:
 *   1. Pending-QC / rejected material is excluded because `currentQty` only
 *      ever grows through `postApprovedMaterialToInventory` (QC approval).
 *   2. `reservedQty` is subtracted.
 *   3. Quantity already acknowledged to OTHER open Material Requests is
 *      subtracted, so the same physical stock cannot satisfy two projects.
 */

import {
  STATUS,
  getMaterialRequests,
  getInventoryItems,
  getMRMaterialTotals,
  writeLS,
  appendAuditLog,
  pushNotification,
  nowDateTimeStr
} from './storeService.js';
import { getCurrentUserInfo, hasPermission } from './permissions.js';
import { getIndents, createPurchaseIndent, INDENT_STATUS } from './workflowService.js';

const MR_KEY = 'materialRequests';

export const ACK_STATUS = {
  PENDING: 'Pending Acknowledgement',
  FULL: 'Fully Available',
  PARTIAL: 'Partially Available',
  NONE: 'Not Available'
};

export const ACK_LINE_STATUS = {
  FULL: 'Available',
  PARTIAL: 'Partial',
  NONE: 'Not Available'
};

/** Filter buckets offered on the Stores acknowledgement dashboard. */
export const ACK_FILTERS = [
  'Pending Acknowledgement',
  ACK_STATUS.FULL,
  ACK_STATUS.PARTIAL,
  ACK_STATUS.NONE,
  'Purchase Indent Pending',
  'Awaiting Material Receipt',
  'Completed'
];

/** MR states Stores is allowed to acknowledge. */
const ACK_ELIGIBLE = new Set([
  STATUS.SUBMITTED,
  STATUS.APPROVED,
  STATUS.PENDING,
  STATUS.PARTIAL,
  STATUS.FULL
]);

const num = (v) => Number(v) || 0;

/* ------------------------------- status helpers ------------------------------- */

export const lineStatusFor = (requiredQty, availableQty) => {
  const req = num(requiredQty);
  const avail = num(availableQty);
  if (req <= 0 || avail >= req) return ACK_LINE_STATUS.FULL;
  if (avail > 0) return ACK_LINE_STATUS.PARTIAL;
  return ACK_LINE_STATUS.NONE;
};

export const ackStatusForLines = (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) return ACK_STATUS.PENDING;
  if (lines.every((l) => l.status === ACK_LINE_STATUS.FULL)) return ACK_STATUS.FULL;
  if (lines.every((l) => l.status === ACK_LINE_STATUS.NONE)) return ACK_STATUS.NONE;
  return ACK_STATUS.PARTIAL;
};

/* ------------------------------ availability math ------------------------------ */

/**
 * Quantity of `materialId` already promised to OTHER still-open Material
 * Requests. Material already issued against those requests has left
 * `currentQty`, so it is subtracted back out to avoid double-penalising.
 */
const committedToOtherRequests = (materialId, excludeMrNumber) => {
  const key = String(materialId || '');
  const exclude = String(excludeMrNumber || '');
  let total = 0;
  for (const mr of getMaterialRequests()) {
    if (!mr || String(mr.mrNumber || '') === exclude) continue;
    if (!ACK_ELIGIBLE.has(mr.status)) continue;
    const ack = mr.acknowledgement;
    if (!ack || ack.status === ACK_STATUS.PENDING || ack.status === ACK_STATUS.NONE) continue;
    const line = (ack.lines || {})[key];
    if (!line) continue;
    const promised = Math.max(0, num(line.acknowledgedQty));
    if (promised <= 0) continue;
    const totals = getMRMaterialTotals(mr.mrNumber);
    const alreadyIssued = num(totals.issued[key]);
    total += Math.max(0, promised - alreadyIssued);
  }
  return total;
};

/**
 * Live, per-material availability for a Material Request.
 * `effectiveAvailable` is the number Stores may actually acknowledge —
 * on-hand, less reserved, less what other requests already hold.
 */
export const computeAckLines = (mr, { excludeMrNumber = '' } = {}) => {
  const inv = getInventoryItems();
  const exclude = String(excludeMrNumber || mr?.mrNumber || '');
  return (mr?.items || []).map((it) => {
    const materialId = String(it.materialId || '');
    const invItem = inv.find((i) => i.itemCode === materialId) || null;
    const currentQty = num(invItem?.currentQty);
    const reservedQty = num(invItem?.reservedQty);
    const blockedQty = committedToOtherRequests(materialId, exclude);
    const effectiveAvailable = Math.max(0, currentQty - reservedQty - blockedQty);
    const requiredQty = num(it.requiredQty);
    const availableQty = Math.min(requiredQty, effectiveAvailable);
    const shortageQty = Math.max(0, requiredQty - availableQty);
    return {
      materialId,
      materialName: it.materialName || materialId,
      unit: it.unit || invItem?.unit || 'Nos',
      requiredQty,
      currentQty,
      reservedQty,
      blockedQty,
      effectiveAvailable,
      availableQty,
      shortageQty,
      status: lineStatusFor(requiredQty, availableQty)
    };
  });
};

/* ---------------------------- acknowledgement read ---------------------------- */

/** Stored acknowledgement, or a neutral "pending" shell for a fresh request. */
export const getAcknowledgement = (mr) => {
  const stored = mr?.acknowledgement;
  if (stored && stored.status) {
    return {
      ...stored,
      lines: stored.lines || {},
      history: stored.history || []
    };
  }
  return {
    status: ACK_STATUS.PENDING,
    lines: {},
    history: [],
    remarks: '',
    acknowledgedBy: '',
    acknowledgedByEmpId: '',
    acknowledgedAt: '',
    purchaseIndentNumber: ''
  };
};

export const getAcknowledgementFor = (mrNumber) => {
  const mr = getMaterialRequests().find((m) => m.mrNumber === mrNumber);
  return mr ? getAcknowledgement(mr) : null;
};

/* --------------------------- purchase indent linkage --------------------------- */

/** Existing non-cancelled Purchase Indent raised for this Material Request. */
export const findIndentForMR = (mrNumber) => {
  const target = String(mrNumber || '');
  return (
    getIndents().find(
      (i) =>
        i &&
        i.sourceType === 'materialRequest' &&
        String(i.requirementNumber || '') === target &&
        i.status !== INDENT_STATUS.CANCELLED
    ) || null
  );
};

/** Where procurement stands for this request — used by the dashboard filters. */
export const getProcurementPhase = (mrNumber) => {
  const indent = findIndentForMR(mrNumber);
  if (!indent) return '';
  if (indent.status === INDENT_STATUS.COMPLETED) return '';
  if (
    indent.poNumber ||
    indent.status === INDENT_STATUS.CONVERTED ||
    indent.status === INDENT_STATUS.PO_CREATED
  ) {
    return 'Awaiting Material Receipt';
  }
  return 'Purchase Indent Pending';
};

/**
 * Purchase Indents a Stores user may link to `mrNumber`: every live indent
 * except this request's own and any already claimed by another Material
 * Request (so one indent can never be counted against two requirements).
 */
export const getLinkableIndents = (mrNumber) => {
  const exclude = String(mrNumber || '');
  const claimedElsewhere = new Set(
    getMaterialRequests()
      .filter((m) => m && String(m.mrNumber || '') !== exclude)
      .map((m) => String(m.acknowledgement?.purchaseIndentNumber || ''))
      .filter(Boolean)
  );
  return getIndents().filter(
    (i) =>
      i &&
      i.status !== INDENT_STATUS.CANCELLED &&
      String(i.indentNumber || '') !== exclude &&
      !claimedElsewhere.has(String(i.indentNumber || ''))
  );
};

/**
 * Link an existing Purchase Indent, or raise one for the current shortage.
 * Reuses `workflowService.createPurchaseIndent` — indents are never duplicated:
 * an indent already tied to this Material Request short-circuits the create.
 */
export const linkPurchaseIndent = ({ mrNumber, indentNumber = '', remarks = '' }) => {
  if (!hasPermission('indent.create')) {
    throw new Error('Permission denied: indent.create');
  }
  const mr = getMaterialRequests().find((m) => m.mrNumber === mrNumber);
  if (!mr) throw new Error('Material Request not found.');
  if (!ACK_ELIGIBLE.has(mr.status)) {
    throw new Error(`Cannot link a Purchase Indent to a ${mr.status} Material Request.`);
  }

  const existing = findIndentForMR(mrNumber);

  if (indentNumber) {
    const target = getIndents().find((i) => i.indentNumber === indentNumber);
    if (!target) throw new Error(`Purchase Indent ${indentNumber} not found.`);
    if (target.status === INDENT_STATUS.CANCELLED) {
      throw new Error(`Purchase Indent ${indentNumber} is cancelled.`);
    }
    if (existing && existing.indentNumber !== indentNumber) {
      throw new Error(
        `Material Request ${mrNumber} is already linked to Purchase Indent ${existing.indentNumber}.`
      );
    }
    if (existing) return { indent: existing, created: false, changed: false };

    const list = getMaterialRequests();
    const updated = list.map((m) =>
      m.mrNumber === mrNumber
        ? {
            ...m,
            acknowledgement: {
              ...getAcknowledgement(m),
              purchaseIndentNumber: indentNumber
            }
          }
        : m
    );
    writeLS(MR_KEY, updated);
    appendAuditLog({
      action: 'PURCHASE INDENT LINKED',
      reference: indentNumber,
      details: `Material Request ${mrNumber} linked to existing indent.`
    });
    return { indent: target, created: false, changed: true };
  }

  /* Create — refuse if one already exists for this requirement. */
  if (existing) {
    return { indent: existing, created: false, changed: false };
  }

  const lines = computeAckLines(mr).filter((l) => num(l.shortageQty) > 0);
  if (lines.length === 0) {
    throw new Error('No shortage found — nothing to indent for this Material Request.');
  }

  const indent = createPurchaseIndent({
    soNumber: mr.salesOrderRef || '',
    reason: `Shortage from Material Request ${mrNumber}`,
    remarks: remarks || `Raised from the Store acknowledgement of ${mrNumber}.`,
    requiredDate: mr.requiredDate || '',
    lines: lines.map((l) => ({
      materialCode: l.materialId,
      materialName: l.materialName,
      unit: l.unit,
      requiredQty: l.requiredQty,
      availableQty: l.availableQty,
      shortageQty: l.shortageQty,
      purchaseQty: l.shortageQty,
      description: '',
      specification: ''
    })),
    sourceInfo: {
      sourceType: 'materialRequest',
      requirementNumber: mrNumber,
      projectId: mr.projectId || '',
      customer: mr.customer || '',
      productionJob: mr.jobCardNumber || '',
      source: 'Material Request Shortage'
    }
  });

  const list = getMaterialRequests();
  writeLS(
    MR_KEY,
    list.map((m) =>
      m.mrNumber === mrNumber
        ? {
            ...m,
            acknowledgement: {
              ...getAcknowledgement(m),
              purchaseIndentNumber: indent.indentNumber
            }
          }
        : m
    )
  );

  return { indent, created: true, changed: true };
};

/* ------------------------------ submit acknowledge ------------------------------ */

const buildNotificationMessage = (mr, status, lines, remarks) => {
  const materials = lines
    .map(
      (l) =>
        `${l.materialName}: ${l.availableQty}/${l.requiredQty} ${l.unit} available, ${l.shortageQty} ${l.unit} short (${l.status})`
    )
    .join(' | ');
  const parts = [
    `Material Request ${mr.mrNumber}`,
    mr.salesOrderRef ? `SO ${mr.salesOrderRef}` : '',
    mr.projectId ? `Project ${mr.projectId}` : '',
    mr.projectName ? `(${mr.projectName})` : '',
    `Status: ${status}`,
    materials
  ];
  if (remarks) parts.push(`Remarks: ${remarks}`);
  return parts.filter(Boolean).join(' — ');
};

/**
 * Stores acknowledges material availability for a Material Request.
 *
 * Quantities are always recomputed server-side-equivalent from live inventory;
 * a caller-supplied "verified" figure may only ever LOWER the acknowledged
 * amount, never raise it above real unreserved, uncommitted stock.
 */
export const submitAcknowledgement = ({ mrNumber, lines = [], remarks = '' }) => {
  if (!hasPermission('material_issue.confirm')) {
    throw new Error('Permission denied: material_issue.confirm');
  }

  const list = getMaterialRequests();
  const idx = list.findIndex((m) => m.mrNumber === mrNumber);
  if (idx === -1) throw new Error('Material Request not found.');
  const mr = list[idx];
  if (!ACK_ELIGIBLE.has(mr.status)) {
    throw new Error(`Cannot acknowledge a ${mr.status} Material Request.`);
  }

  const previous = getAcknowledgement(mr);
  const live = computeAckLines(mr);
  const submitted = new Map(lines.map((l) => [String(l.materialId), l]));

  const nextLines = {};
  for (const line of live) {
    const entry = submitted.get(line.materialId) || {};
    const cap = Math.min(line.requiredQty, line.effectiveAvailable);
    const rawVerified = entry.verifiedQty;
    const hasVerified =
      rawVerified !== '' && rawVerified !== null && rawVerified !== undefined && !Number.isNaN(Number(rawVerified));
    const ackQty = hasVerified ? Math.min(cap, Math.max(0, num(rawVerified))) : cap;

    const prevLine = previous.lines[line.materialId] || {};
    nextLines[line.materialId] = {
      materialName: line.materialName,
      unit: line.unit,
      requiredQty: line.requiredQty,
      availableQty: ackQty,
      acknowledgedQty: ackQty,
      shortageQty: Math.max(0, line.requiredQty - ackQty),
      effectiveAvailable: line.effectiveAvailable,
      status: lineStatusFor(line.requiredQty, ackQty),
      verifiedQty: hasVerified ? Math.max(0, num(rawVerified)) : ackQty,
      remarks: String(entry.remarks || ''),
      purchaseIndentNumber: String(entry.purchaseIndentNumber || prevLine.purchaseIndentNumber || '')
    };
  }

  const nextStatus = ackStatusForLines(Object.values(nextLines));
  const totalAvailable = Object.values(nextLines).reduce((a, l) => a + num(l.availableQty), 0);
  const totalShortage = Object.values(nextLines).reduce((a, l) => a + num(l.shortageQty), 0);

  /* Scenario 8 — an identical re-submission must not create a second record
     or a second notification. */
  const unchanged =
    previous.status === nextStatus &&
    String(previous.remarks || '') === String(remarks || '') &&
    Object.keys(nextLines).every(
      (k) => num(previous.lines?.[k]?.acknowledgedQty) === num(nextLines[k].acknowledgedQty)
    );
  if (unchanged && previous.acknowledgedAt) {
    return { changed: false, acknowledgement: previous, mr };
  }

  const info = getCurrentUserInfo();
  const historyEntry = {
    by: info.employee?.name || info.auth?.username || 'User',
    byEmpId: info.employee?.employeeId || '-',
    at: nowDateTimeStr(),
    previousStatus: previous.status,
    newStatus: nextStatus,
    availableQty: totalAvailable,
    shortageQty: totalShortage,
    remarks: String(remarks || '')
  };

  const acknowledgement = {
    ...previous,
    status: nextStatus,
    lines: nextLines,
    remarks: String(remarks || ''),
    acknowledgedBy: historyEntry.by,
    acknowledgedByEmpId: historyEntry.byEmpId,
    acknowledgedAt: historyEntry.at,
    updatedAt: historyEntry.at,
    completedAt: nextStatus === ACK_STATUS.FULL ? historyEntry.at : '',
    purchaseIndentNumber:
      previous.purchaseIndentNumber ||
      Object.values(nextLines).map((l) => l.purchaseIndentNumber).find(Boolean) ||
      '',
    history: [...(previous.history || []), historyEntry]
  };

  const updated = list.map((m, i) => (i === idx ? { ...m, acknowledgement } : m));
  writeLS(MR_KEY, updated);

  appendAuditLog({
    action: 'MATERIAL ACKNOWLEDGED',
    reference: mrNumber,
    details: `${nextStatus} | available ${totalAvailable} | shortage ${totalShortage} | ${Object.keys(nextLines).length} material(s) | ${remarks || 'no remarks'}`
  });

  /* Rule 7 — every acknowledgement update notifies Production. */
  pushNotification({
    title: `Store Acknowledgement — ${nextStatus}`,
    message: buildNotificationMessage(mr, nextStatus, Object.values(nextLines), remarks),
    type: nextStatus === ACK_STATUS.FULL ? 'success' : 'warning',
    reference: mrNumber,
    targetDept: 'Production Department',
    link: `/production/material-requests?mr=${encodeURIComponent(mrNumber)}`
  });

  return { changed: true, acknowledgement, mr: updated[idx] };
};

/* --------------------------------- dashboards --------------------------------- */

/**
 * Stores dashboard rows with procurement phase derived, so the page can apply
 * the required filters without duplicating any of this logic.
 */
export const getAckQueue = () =>
  getMaterialRequests()
    .filter((m) => m && ACK_ELIGIBLE.has(m.status))
    .map((mr) => {
      const ack = getAcknowledgement(mr);
      const lines = computeAckLines(mr);
      return {
        mr,
        ack,
        lines,
        phase: getProcurementPhase(mr.mrNumber),
        indentNumber: ack.purchaseIndentNumber || findIndentForMR(mr.mrNumber)?.indentNumber || ''
      };
    });

/** Apply one of `ACK_FILTERS` to a queue row. */
export const matchesAckFilter = (row, filter) => {
  if (!filter || filter === 'All') return true;
  if (filter === ACK_STATUS.PENDING) return row.ack.status === ACK_STATUS.PENDING;
  if (filter === ACK_STATUS.FULL) return row.ack.status === ACK_STATUS.FULL;
  if (filter === ACK_STATUS.PARTIAL) return row.ack.status === ACK_STATUS.PARTIAL;
  if (filter === ACK_STATUS.NONE) return row.ack.status === ACK_STATUS.NONE;
  if (filter === 'Completed') return row.ack.status === ACK_STATUS.FULL && row.mr.status === STATUS.FULL;
  if (filter === 'Purchase Indent Pending') return row.phase === 'Purchase Indent Pending';
  if (filter === 'Awaiting Material Receipt') return row.phase === 'Awaiting Material Receipt';
  return true;
};

/** Production dashboard — latest acknowledgement per Material Request. */
export const getProductionAckSummary = () =>
  getMaterialRequests()
    .filter((m) => m && ACK_ELIGIBLE.has(m.status))
    .map((mr) => {
      const ack = getAcknowledgement(mr);
      const lines = computeAckLines(mr);
      const indent = findIndentForMR(mr.mrNumber);
      return {
        mr,
        ack,
        lines,
        indentNumber: ack.purchaseIndentNumber || indent?.indentNumber || '',
        indentStatus: indent?.status || '',
        totalRequired: lines.reduce((a, l) => a + num(l.requiredQty), 0),
        totalAvailable: lines.reduce((a, l) => a + num(l.availableQty), 0),
        totalShortage: lines.reduce((a, l) => a + num(l.shortageQty), 0),
        lastAcknowledgedAt: ack.acknowledgedAt || ''
      };
    });
