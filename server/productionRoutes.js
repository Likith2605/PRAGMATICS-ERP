import express from 'express';
import { getPool } from './database.js';
import { requireAdmin } from './auth.js';
import {
  bad, conflict, notFound, forbidden, text, num, dateOnly, idempotencyToken,
  readVersion, assertVersion, payloadSize, requirePermissions, writeAudit,
  nextNumber, jobCardNumber, legacyRows, auditRows, historyEntry, isAdmin
} from './productionSupport.js';
import { normalizeOperation, viewOperation, pendingOperations } from './routingSupport.js';
import { moveHtStock } from './productionStock.js';

const router = express.Router();
const SAFE_NUMBER = /^[A-Za-z0-9._:-]{1,100}$/;

const REQUIREMENT_STATUS = Object.freeze({
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending Review',
  STOCK_AVAILABLE: 'Stock Available',
  SHORTAGE_IDENTIFIED: 'Shortage Identified',
  PURCHASE_REQUIRED: 'Purchase Required',
  PURCHASE_COMPLETED: 'Purchase Completed',
  MATERIAL_AVAILABLE: 'Material Available',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
});

const HT_STATUS = Object.freeze({
  RAISED: 'Raised',
  VENDOR_ASSIGNED: 'Vendor Assigned',
  ISSUED: 'Issued to Vendor',
  RECEIVED: 'Received at Store',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
});

const requireNumber = (value, label) => {
  const number = String(value ?? '').trim();
  if (!SAFE_NUMBER.test(number)) throw bad(`A valid ${label} is required.`);
  return number;
};

/* ------------------------------------------------------------------ */
/* Production Requirements                                              */
/* ------------------------------------------------------------------ */

const normalizeRequirementItem = (raw, index) => {
  const item = raw || {};
  const materialCode = text(item.materialCode || item.itemCode || item.materialId);
  const materialName = text(item.materialName || item.itemName || materialCode);
  if (!materialCode || !materialName) throw bad(`Requirement line ${index + 1} needs a material code and name.`);
  const requiredQty = num(item.requiredQty ?? item.quantity, 0);
  if (requiredQty < 0) throw bad(`Requirement line ${index + 1} quantity cannot be negative.`);
  const lineId = text(item.lineId, `line-${index + 1}`);
  return {
    lineId,
    materialCode,
    materialName,
    requiredQty,
    availableQty: num(item.availableQty, 0),
    shortageQty: num(item.shortageQty, Math.max(0, requiredQty - num(item.availableQty, 0))),
    unit: text(item.unit, 'Nos'),
    payload: { ...item, lineId }
  };
};

const normalizeRequirement = (data, fallbackNumber = '') => {
  payloadSize(data);
  const requirementNumber = requireNumber(data?.requirementNumber || fallbackNumber, 'requirement number');
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) throw bad('At least one required item is needed.');
  const partName = text(data?.partName || data?.drawingNumber || data?.drawingNo);
  if (!partName) throw bad('Part name is required.');
  const requiredQty = num(data?.requiredQty ?? data?.orderQuantity ?? data?.qty, 0);
  if (requiredQty <= 0) throw bad('Required quantity must be greater than zero.');
  const status = text(data?.status, REQUIREMENT_STATUS.DRAFT);
  if (!Object.values(REQUIREMENT_STATUS).includes(status)) throw bad(`Unsupported requirement status "${status}".`);
  const seenMaterials = new Set();
  for (const item of items) {
    const key = String(item.materialCode || item.itemCode || item.materialId || item.materialName || item.itemName || '').trim().toLowerCase();
    if (key && seenMaterials.has(key)) throw bad(`Duplicate material "${item.materialName || item.itemName || key}" is not allowed in a Production Requirement.`);
    if (key) seenMaterials.add(key);
  }
  return {
    ...data,
    requirementNumber,
    requirementDate: dateOnly(data?.requirementDate, new Date().toISOString().slice(0, 10)),
    soNumber: text(data?.soNumber || data?.salesOrderRef),
    projectId: text(data?.projectId),
    customer: text(data?.customer || data?.customerName),
    partName,
    requiredQty,
    status,
    remarks: text(data?.remarks),
    items: items.map(normalizeRequirementItem)
  };
};

const viewRequirement = async (client, row) => {
  const items = await client.query(
    'SELECT * FROM production_requirement_items WHERE requirement_number=$1 ORDER BY line_number', [row.requirement_number]
  );
  return {
    ...(row.payload || {}),
    requirementNumber: row.requirement_number,
    requirementDate: String(row.requirement_date).slice(0, 10),
    soNumber: row.so_number || '',
    projectId: row.project_id || '',
    customer: row.customer || '',
    partName: row.part_name,
    requiredQty: Number(row.required_qty),
    status: row.status,
    remarks: row.remarks || '',
    version: Number(row.version),
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    items: items.rows.map((item) => ({ ...(item.payload || {}), ...item, lineNumber: Number(item.line_number) }))
  };
};

const insertRequirement = async (client, req, payload, createToken = null) => {
  await client.query(
    `INSERT INTO production_requirements(requirement_number,requirement_date,so_number,project_id,customer,part_name,required_qty,status,remarks,created_by,updated_by,payload,create_token)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11::jsonb,$12)`,
    [payload.requirementNumber, payload.requirementDate, payload.soNumber, payload.projectId, payload.customer,
      payload.partName, payload.requiredQty, payload.status, payload.remarks, text(req.user?.email), JSON.stringify(payload), createToken]
  );
  for (const [index, item] of payload.items.entries()) {
    await client.query(
      `INSERT INTO production_requirement_items(requirement_number,line_number,material_code,material_name,required_qty,available_qty,shortage_qty,unit,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [payload.requirementNumber, index + 1, item.materialCode, item.materialName, item.requiredQty,
        item.availableQty, item.shortageQty, item.unit, JSON.stringify(item.payload || item)]
    );
  }
};

const replaceRequirementItems = async (client, number, items) => {
  await client.query('DELETE FROM production_requirement_items WHERE requirement_number=$1', [number]);
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO production_requirement_items(requirement_number,line_number,material_code,material_name,required_qty,available_qty,shortage_qty,unit,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [number, index + 1, item.materialCode, item.materialName, item.requiredQty, item.availableQty,
        item.shortageQty, item.unit, JSON.stringify(item.payload || item)]
    );
  }
};

router.get('/requirements', async (req, res) => {
  requirePermissions(req, 'production.requirement.manage', 'production.view', 'job_card.view');
  const params = [];
  let where = 'deleted_at IS NULL';
  if (req.query.status) { params.push(text(req.query.status)); where += ` AND status=$${params.length}`; }
  if (req.query.projectId) { params.push(text(req.query.projectId)); where += ` AND lower(project_id)=lower($${params.length})`; }
  if (req.query.soNumber) { params.push(text(req.query.soNumber)); where += ` AND lower(so_number)=lower($${params.length})`; }
  const result = await getPool().query(
    `SELECT * FROM production_requirements WHERE ${where} ORDER BY requirement_date DESC,requirement_number DESC`, params
  );
  const records = [];
  for (const row of result.rows) records.push(await viewRequirement(getPool(), row));
  res.json({ records });
});

router.get('/requirements/:number/audit', async (req, res) => {
  requirePermissions(req, 'production.requirement.manage', 'production.view', 'job_card.view');
  const number = requireNumber(req.params.number, 'requirement number');
  const exists = await getPool().query('SELECT 1 FROM production_requirements WHERE requirement_number=$1', [number]);
  if (!exists.rowCount) throw notFound('Production requirement not found.');
  res.json({ entries: await auditRows(getPool(), 'erp_audit_log', 'record_id', number, Number(req.query.limit)) });
});

router.get('/requirements/:number', async (req, res) => {
  requirePermissions(req, 'production.requirement.manage', 'production.view', 'job_card.view');
  const result = await getPool().query(
    'SELECT * FROM production_requirements WHERE requirement_number=$1 AND deleted_at IS NULL', [requireNumber(req.params.number, 'requirement number')]
  );
  if (!result.rowCount) throw notFound('Production requirement not found.');
  res.json({ record: await viewRequirement(getPool(), result.rows[0]) });
});

router.post('/requirements', async (req, res) => {
  requirePermissions(req, 'production.requirement.manage', 'material_request.create');
  const createToken = idempotencyToken(req.body?.createToken);
  const payload = normalizeRequirement(req.body?.data, 'PENDING');
  payload.status = REQUIREMENT_STATUS.DRAFT;
  payload.history = [historyEntry(req, 'Requirement created', `${payload.items.length} item(s)`)];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT * FROM production_requirements WHERE create_token=$1 FOR UPDATE', [createToken]);
    if (prior.rowCount) {
      if (prior.rows[0].deleted_at) throw conflict('Deleted requirement cannot be recreated by retry.');
      await client.query('COMMIT');
      return res.json({ record: await viewRequirement(client, prior.rows[0]), duplicate: true });
    }
    payload.requirementNumber = await nextNumber(client, {
      prefix: 'PR-', table: 'production_requirements', column: 'requirement_number', sequenceKey: 'productionRequirement'
    });
    await insertRequirement(client, req, payload, createToken);
    await writeAudit(client, req, { table: 'erp_audit_log', idColumn: 'record_id', global: false, id: payload.requirementNumber, action: 'CREATE', after: payload, module: 'production_requirements' });
    await client.query('COMMIT');
    res.status(201).json({ record: { ...payload, version: 1 }, duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.put('/requirements/:number', async (req, res) => {
  requirePermissions(req, 'production.requirement.manage', 'material_request.create');
  const number = requireNumber(req.params.number, 'requirement number');
  const version = readVersion(req.body?.version);
  const payload = normalizeRequirement(req.body?.data, number);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM production_requirements WHERE requirement_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Production requirement not found.');
    assertVersion(current.rows[0], version, 'Production requirement');
    if (![REQUIREMENT_STATUS.DRAFT, REQUIREMENT_STATUS.CANCELLED].includes(current.rows[0].status))
      throw conflict('Only Draft or Cancelled requirements can be edited.');
    payload.requirementNumber = number;
    // Editing a cancelled requirement re-opens it as a Draft, matching the
    // legacy workflow used by the Item Requirements page.
    payload.status = REQUIREMENT_STATUS.DRAFT;
    payload.version = version + 1;
    payload.history = [...((current.rows[0].payload || {}).history || []), historyEntry(req, 'Requirement updated')];
    await client.query(
      `UPDATE production_requirements SET requirement_date=$2,so_number=$3,project_id=$4,customer=$5,part_name=$6,required_qty=$7,remarks=$8,payload=$9::jsonb,version=version+1,updated_at=now(),updated_by=$10 WHERE requirement_number=$1`,
      [number, payload.requirementDate, payload.soNumber, payload.projectId, payload.customer, payload.partName,
        payload.requiredQty, payload.remarks, JSON.stringify(payload), text(req.user?.email)]
    );
    await replaceRequirementItems(client, number, payload.items);
    await writeAudit(client, req, { table: 'erp_audit_log', idColumn: 'record_id', global: false, id: number, action: 'UPDATE', before: current.rows[0].payload, after: payload, module: 'production_requirements' });
    await client.query('COMMIT');
    res.json({ record: await viewRequirement(client, { ...current.rows[0], ...payload, version: version + 1 }) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const requirementTransition = async (req, res, allowed, nextStatus, action, options = {}) => {
  if (options.adminOnly && !isAdmin(req)) throw forbidden('Administrator access is required.');
  if (options.permission) requirePermissions(req, ...options.permission);
  const number = requireNumber(req.params.number, 'requirement number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM production_requirements WHERE requirement_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Production requirement not found.');
    assertVersion(current.rows[0], version, 'Production requirement');
    if (!allowed.includes(current.rows[0].status))
      throw conflict(`Requirement cannot be ${action.toLowerCase()} from ${current.rows[0].status}.`);
    const payload = {
      ...(current.rows[0].payload || {}),
      status: nextStatus,
      reason: text(req.body?.reason),
      history: [...((current.rows[0].payload || {}).history || []), historyEntry(req, action, text(req.body?.reason))]
    };
    if (action === 'REVIEW' && req.body?.storeReview) {
      payload.storeReview = {
        ...req.body.storeReview,
        reviewedBy: text(req.user?.email),
        reviewedAt: new Date().toISOString()
      };
    }
    if (Array.isArray(req.body?.lines) && req.body.lines.length) {
      const lines = req.body.lines.map((line, index) => normalizeRequirementItem(line, index));
      await replaceRequirementItems(client, number, lines);
      payload.items = lines;
    }
    await client.query(
      'UPDATE production_requirements SET status=$2,payload=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE requirement_number=$1',
      [number, nextStatus, JSON.stringify(payload), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'erp_audit_log', idColumn: 'record_id', global: false, id: number, action, before: { status: current.rows[0].status }, after: { status: nextStatus }, reason: text(req.body?.reason), module: 'production_requirements' });
    await client.query('COMMIT');
    res.json({ record: await viewRequirement(client, { ...current.rows[0], ...payload, version: version + 1 }) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

router.post('/requirements/:number/submit', (req, res) =>
  requirementTransition(req, res, [REQUIREMENT_STATUS.DRAFT], REQUIREMENT_STATUS.PENDING_REVIEW, 'SUBMIT',
    { permission: ['production.requirement.manage', 'material_request.submit'] }));
router.post('/requirements/:number/review', async (req, res) => {
  const status = text(req.body?.status);
  if (![REQUIREMENT_STATUS.STOCK_AVAILABLE, REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED, REQUIREMENT_STATUS.PURCHASE_REQUIRED].includes(status))
    throw bad('Review status must be Stock Available, Shortage Identified or Purchase Required.');
  return requirementTransition(req, res,
    [REQUIREMENT_STATUS.PENDING_REVIEW, REQUIREMENT_STATUS.STOCK_AVAILABLE, REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED], status, 'REVIEW',
    { permission: ['production.requirement.manage', 'material_request.edit', 'indent.view', 'store.module'] });
});
router.post('/requirements/:number/purchase-completed', (req, res) =>
  requirementTransition(req, res, [REQUIREMENT_STATUS.PURCHASE_REQUIRED], REQUIREMENT_STATUS.PURCHASE_COMPLETED, 'PURCHASE_COMPLETED',
    { permission: ['production.requirement.manage', 'material_request.edit', 'indent.view', 'store.module'] }));
router.post('/requirements/:number/material-available', (req, res) =>
  requirementTransition(req, res, [REQUIREMENT_STATUS.PURCHASE_COMPLETED, REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED], REQUIREMENT_STATUS.MATERIAL_AVAILABLE, 'MATERIAL_AVAILABLE',
    { permission: ['production.requirement.manage', 'material_issue.confirm', 'indent.view', 'store.module'] }));
router.post('/requirements/:number/complete', (req, res) =>
  requirementTransition(req, res, [REQUIREMENT_STATUS.STOCK_AVAILABLE, REQUIREMENT_STATUS.MATERIAL_AVAILABLE], REQUIREMENT_STATUS.COMPLETED, 'COMPLETE',
    { permission: ['production.requirement.manage', 'production.view', 'store.module'] }));
router.post('/requirements/:number/cancel', (req, res) =>
  requirementTransition(req, res,
    [REQUIREMENT_STATUS.DRAFT, REQUIREMENT_STATUS.PENDING_REVIEW, REQUIREMENT_STATUS.STOCK_AVAILABLE,
      REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED, REQUIREMENT_STATUS.PURCHASE_REQUIRED, REQUIREMENT_STATUS.PURCHASE_COMPLETED,
      REQUIREMENT_STATUS.MATERIAL_AVAILABLE],
    REQUIREMENT_STATUS.CANCELLED, 'CANCEL', { adminOnly: true }));

router.delete('/requirements/:number', requireAdmin, async (req, res) => {
  const number = requireNumber(req.params.number, 'requirement number');
  const version = readVersion(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM production_requirements WHERE requirement_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Production requirement not found.');
    assertVersion(current.rows[0], version, 'Production requirement');
    if (![REQUIREMENT_STATUS.DRAFT, REQUIREMENT_STATUS.CANCELLED].includes(current.rows[0].status))
      throw conflict('Only Draft or Cancelled requirements can be deleted.');
    await client.query(
      'UPDATE production_requirements SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE requirement_number=$1 AND version=$4',
      [number, text(req.user?.email), reason, version]
    );
    await writeAudit(client, req, { table: 'erp_audit_log', idColumn: 'record_id', global: false, id: number, action: 'SOFT_DELETE', before: current.rows[0].payload, reason, module: 'production_requirements' });
    await client.query('COMMIT');
    res.json({ deleted: number });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/requirements/:number/restore', requireAdmin, async (req, res) => {
  const number = requireNumber(req.params.number, 'requirement number');
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A restore reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM production_requirements WHERE requirement_number=$1 AND deleted_at IS NOT NULL FOR UPDATE',
      [number]
    );
    if (!current.rowCount) throw conflict('Only a deleted Production Requirement can be restored.');
    const payload = { ...(current.rows[0].payload || {}), status: REQUIREMENT_STATUS.CANCELLED,
      history: [...((current.rows[0].payload || {}).history || []), historyEntry(req, 'Requirement restored', reason)] };
    await client.query(
      `UPDATE production_requirements SET deleted_at=NULL,deleted_by=NULL,delete_reason='',status=$2,payload=$3::jsonb,
       version=version+1,updated_at=now(),updated_by=$4 WHERE requirement_number=$1`,
      [number, REQUIREMENT_STATUS.CANCELLED, JSON.stringify(payload), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'erp_audit_log', idColumn: 'record_id', global: false,
      id: number, action: 'RESTORE', after: payload, reason, module: 'production_requirements' });
    await client.query('COMMIT');
    res.json({ record: await viewRequirement(client, { ...current.rows[0], deleted_at: null, status: REQUIREMENT_STATUS.CANCELLED, payload, version: Number(current.rows[0].version) + 1 }) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/* ------------------------------------------------------------------ */
/* Job Cards                                                            */
/* ------------------------------------------------------------------ */

const normalizeJobCard = (data, fallbackNumber = '') => {
  payloadSize(data);
  const jobCardNumber = requireNumber(data?.jobCardNumber || fallbackNumber, 'job card number');
  const partName = text(data?.partName);
  if (!partName) throw bad('Part / component name is required.');
  const orderQuantity = num(data?.orderQuantity ?? data?.lotQty, 0);
  if (orderQuantity <= 0) throw bad('Order quantity must be greater than zero.');
  const status = text(data?.status, 'In Production');
  if (!['Draft', 'Ready for Production', 'In Production', 'QC Inspection', 'Completed', 'Cancelled'].includes(status))
    throw bad(`Unsupported Job Card status "${status}".`);
  return {
    ...data,
    jobCardNumber,
    jobCardDate: dateOnly(data?.jobCardDate || data?.docDate || data?.startDate, new Date().toISOString().slice(0, 10)),
    soNumber: text(data?.soNumber || data?.salesOrderRef),
    customerPoNumber: text(data?.customerPoNumber || data?.poNo),
    projectId: text(data?.projectId).toUpperCase(),
    customerName: text(data?.customerName || data?.customer),
    partCode: text(data?.partCode || data?.partNumber || data?.drawingNumber),
    partName,
    orderQuantity,
    producedQuantity: num(data?.producedQuantity, 0),
    acceptedQuantity: num(data?.acceptedQuantity, 0),
    rejectedQuantity: num(data?.rejectedQuantity, 0),
    status,
    assignedEmployeeId: text(data?.assignedEmployeeId || data?.assignedToEmpId),
    assignedEmployeeName: text(data?.assignedEmployeeName || data?.assignedTo),
    assignedMachineId: text(data?.assignedMachineId),
    assignedMachineName: text(data?.assignedMachineName),
    startDate: dateOnly(data?.startDate) || null,
    dueDate: dateOnly(data?.targetDate || data?.dueDate) || null,
    completionDate: dateOnly(data?.completionDate) || null,
    processes: Array.isArray(data?.processes) ? data.processes : []
  };
};

const cardView = (row, operations = null) => {
  const payload = { ...(row.payload || {}) };
  const ops = operations || [];
  const legacyProcesses = ops.length
    ? ops.map((op) => ({ ...op, process: op.operationName, machine: op.machineName, operator: op.operatorName }))
    : (Array.isArray(payload.processes) ? payload.processes : []);
  return {
    ...payload,
    jobCardNumber: row.job_card_number,
    jobCardDate: String(row.job_card_date).slice(0, 10),
    soNumber: row.so_number || '',
    salesOrderRef: row.so_number || '',
    customerPoNumber: row.customer_po_number || '',
    projectId: row.project_id || '',
    customerName: row.customer_name || '',
    partCode: row.part_code || '',
    partName: row.part_name,
    orderQuantity: Number(row.order_quantity),
    producedQuantity: Number(row.produced_quantity),
    acceptedQuantity: Number(row.accepted_quantity),
    rejectedQuantity: Number(row.rejected_quantity),
    status: row.status,
    assignedEmployeeId: row.assigned_employee_id || '',
    assignedEmployeeName: row.assigned_employee_name || '',
    assignedMachineId: row.assigned_machine_id || '',
    assignedMachineName: row.assigned_machine_name || '',
    startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
    targetDate: row.due_date ? String(row.due_date).slice(0, 10) : '',
    completionDate: row.completion_date ? String(row.completion_date).slice(0, 10) : '',
    bomNumber: row.bom_number || '',
    bomVersion: Number(row.bom_version),
    issuedAt: row.issued_at?.toISOString?.() || row.issued_at || null,
    version: Number(row.version),
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    processes: legacyProcesses
  };
};

const operationsFor = async (client, number) => {
  const result = await client.query(
    'SELECT * FROM job_card_operations WHERE job_card_number=$1 ORDER BY sequence_number,id', [number]
  );
  return result.rows.map(viewOperation);
};

const syncCardOperations = async (client, number, processes) => {
  if (!Array.isArray(processes)) return;
  const desiredIds = new Set();
  for (const [index, raw] of processes.entries()) {
    const operation = normalizeOperation(raw, index + 1);
    const rawId = Number(raw?.id);
    let saved;
    if (Number.isInteger(rawId) && rawId > 0) {
      const existing = await client.query('SELECT id FROM job_card_operations WHERE id=$1 AND job_card_number=$2', [rawId, number]);
      if (existing.rowCount) {
        const result = await client.query(
          `UPDATE job_card_operations SET sequence_number=$2,operation_name=$3,machine_name=$4,operator_name=$5,planned_hours=$6,actual_hours=$7,status=$8,started_at=$9,completed_at=$10,payload=$11::jsonb WHERE id=$1 RETURNING *`,
          [rawId, operation.sequenceNumber, operation.operationName, operation.machineName, operation.operatorName,
            operation.plannedHours, operation.actualHours, operation.status, operation.startedAt, operation.completedAt, JSON.stringify(operation.payload)]
        );
        saved = result.rows[0];
      }
    }
    if (!saved) {
      const result = await client.query(
        `INSERT INTO job_card_operations(job_card_number,sequence_number,operation_name,machine_name,operator_name,planned_hours,actual_hours,status,started_at,completed_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
        [number, operation.sequenceNumber, operation.operationName, operation.machineName, operation.operatorName,
          operation.plannedHours, operation.actualHours, operation.status, operation.startedAt, operation.completedAt, JSON.stringify(operation.payload)]
      );
      saved = result.rows[0];
    }
    desiredIds.add(Number(saved.id));
  }
  const existing = await client.query('SELECT id FROM job_card_operations WHERE job_card_number=$1', [number]);
  for (const row of existing.rows) {
    if (desiredIds.has(Number(row.id))) continue;
    const entries = await client.query('SELECT 1 FROM production_operation_entries WHERE operation_id=$1 LIMIT 1', [row.id]);
    if (entries.rowCount) continue;
    await client.query('DELETE FROM job_card_operations WHERE id=$1', [row.id]);
  }
};

const insertCard = async (client, req, payload, createToken = null) => {
  await client.query(
    `INSERT INTO job_cards(job_card_number,job_card_date,so_number,customer_po_number,project_id,customer_name,part_code,part_name,order_quantity,produced_quantity,accepted_quantity,rejected_quantity,status,assigned_employee_id,assigned_employee_name,assigned_machine_id,assigned_machine_name,start_date,due_date,completion_date,created_by,updated_by,payload,create_token)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22::jsonb,$23)`,
    [payload.jobCardNumber, payload.jobCardDate, payload.soNumber, payload.customerPoNumber, payload.projectId,
      payload.customerName, payload.partCode, payload.partName, payload.orderQuantity, payload.producedQuantity,
      payload.acceptedQuantity, payload.rejectedQuantity, payload.status, payload.assignedEmployeeId, payload.assignedEmployeeName,
      payload.assignedMachineId, payload.assignedMachineName, payload.startDate, payload.dueDate, payload.completionDate,
      text(req.user?.email), JSON.stringify(payload), createToken]
  );
  await syncCardOperations(client, payload.jobCardNumber, payload.processes);
};

const validateCardAssignments = async (client, payload) => {
  const employeeId = text(payload.assignedEmployeeId);
  if (employeeId) {
    const employee = await client.query(
      'SELECT employee_id FROM employees WHERE lower(employee_id)=lower($1) AND deleted_at IS NULL',
      [employeeId]
    );
    if (!employee.rowCount) throw bad(`Assigned employee "${employeeId}" does not exist or is inactive.`);
  }
  const machineId = text(payload.assignedMachineId);
  if (machineId) {
    const machine = await client.query(
      'SELECT machine_id FROM machines WHERE lower(machine_id)=lower($1) AND deleted_at IS NULL',
      [machineId]
    );
    if (!machine.rowCount) throw bad(`Assigned machine "${machineId}" does not exist or is inactive.`);
  }
};

const completionProblems = async (client, card) => {
  const payload = card.payload || {};
  const problems = [];
  const pending = await pendingOperations(client, card.job_card_number);
  for (const operation of pending) problems.push(`Operation ${operation.operationName} is not completed.`);
  const ops = payload.operations || {};
  if (ops.turning && ops.turning.status !== 'Completed') problems.push('Turning / Facing is not completed.');
  if (ops.millingGrinding && ops.millingGrinding.status !== 'Completed') problems.push('Milling / Grinding is not completed.');
  if (ops.setupApproval && !ops.setupApproval.approved) problems.push('Setup approval is pending.');
  if (ops.heatTreatment?.required) {
    if (ops.heatTreatment.status !== 'Completed' || ops.heatTreatment.disposition === 'Fail')
      problems.push('Required Heat Treatment has not passed.');
  }
  if (ops.machineProcess && ops.machineProcess.status !== 'Completed') problems.push('Machine process is not completed.');
  const finishing = payload.finishing || {};
  if (finishing.coatingRequired && finishing.status !== 'Completed') problems.push('Required surface treatment is not completed.');
  const qc = payload.qualityControl || {};
  if (qc.inProcessQC?.status === 'Rework') problems.push('In-process QC requires rework.');
  if (String(qc.finalQC?.disposition || '').toLowerCase() !== 'pass') problems.push('Final QC must PASS.');
  const accepted = num(qc.finalQC?.acceptedQty, 0);
  if (accepted <= 0) problems.push('Final QC accepted quantity must be greater than zero.');
  const accounted = accepted + num(qc.finalQC?.reworkQty, 0) + num(qc.finalQC?.scrapQty, 0);
  if (accounted > Number(card.order_quantity)) problems.push('Final QC quantity exceeds the Job Card order quantity.');
  return problems;
};

router.get('/job-cards', async (req, res) => {
  requirePermissions(req, 'job_card.view', 'job_card.create', 'production.view');
  const params = [];
  let where = 'deleted_at IS NULL';
  if (req.query.status) { params.push(text(req.query.status)); where += ` AND status=$${params.length}`; }
  if (req.query.projectId) { params.push(text(req.query.projectId)); where += ` AND lower(project_id)=lower($${params.length})`; }
  if (req.query.soNumber) { params.push(text(req.query.soNumber)); where += ` AND lower(so_number)=lower($${params.length})`; }
  const result = await getPool().query(
    `SELECT * FROM job_cards WHERE ${where} ORDER BY job_card_date DESC,job_card_number DESC`, params
  );
  res.json({ records: result.rows.map((row) => cardView(row)) });
});

router.get('/job-cards/:number/audit', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  const number = requireNumber(req.params.number, 'job card number');
  const exists = await getPool().query('SELECT 1 FROM job_cards WHERE job_card_number=$1', [number]);
  if (!exists.rowCount) throw notFound('Job Card not found.');
  res.json({ entries: await auditRows(getPool(), 'job_card_audit', 'job_card_number', number, Number(req.query.limit)) });
});

router.get('/job-cards/:number/items', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  const number = requireNumber(req.params.number, 'job card number');
  const card = await getPool().query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL', [number]);
  if (!card.rowCount) throw notFound('Job Card not found.');
  const result = await getPool().query('SELECT * FROM job_card_items WHERE job_card_number=$1 ORDER BY line_number', [number]);
  res.json({ items: result.rows.map((row) => ({ ...(row.payload || {}), ...row, lineNumber: Number(row.line_number) })) });
});

router.get('/job-cards/:number', async (req, res) => {
  requirePermissions(req, 'job_card.view', 'job_card.create', 'production.view');
  const number = requireNumber(req.params.number, 'job card number');
  const result = await getPool().query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL', [number]);
  if (!result.rowCount) throw notFound('Job Card not found.');
  const operations = await operationsFor(getPool(), number);
  res.json({ record: cardView(result.rows[0], operations) });
});

router.post('/job-cards', async (req, res) => {
  requirePermissions(req, 'job_card.create');
  const createToken = idempotencyToken(req.body?.createToken);
  const payload = normalizeJobCard(req.body?.data, 'PENDING');
  payload.history = [historyEntry(req, 'Job Card created', payload.partName)];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT * FROM job_cards WHERE create_token=$1 FOR UPDATE', [createToken]);
    if (prior.rowCount) {
      if (prior.rows[0].deleted_at) throw conflict('Deleted Job Card cannot be recreated by retry.');
      await client.query('COMMIT');
      return res.json({ record: cardView(prior.rows[0]), duplicate: true });
    }
    payload.jobCardNumber = await jobCardNumber(client);
    payload.docNo = text(payload.docNo, 'F/PROD/02');
    payload.revNo = text(payload.revNo, '00');
    await validateCardAssignments(client, payload);
    await insertCard(client, req, payload, createToken);
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: payload.jobCardNumber, action: 'CREATE', after: payload, module: 'job_cards' });
    const row = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1', [payload.jobCardNumber]);
    await client.query('COMMIT');
    res.status(201).json({ record: cardView(row.rows[0]), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.put('/job-cards/:number', async (req, res) => {
  requirePermissions(req, 'job_card.create', 'job_card.update_progress');
  const number = requireNumber(req.params.number, 'job card number');
  const version = readVersion(req.body?.version);
  const payload = normalizeJobCard(req.body?.data, number);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Job Card not found.');
    assertVersion(current.rows[0], version, 'Job Card');
    payload.jobCardNumber = number;
    payload.projectId = current.rows[0].project_id || payload.projectId;
    await validateCardAssignments(client, payload);
    payload.history = [...((current.rows[0].payload || {}).history || []), historyEntry(req, 'Job Card updated')];
    await client.query(
      `UPDATE job_cards SET job_card_date=$2,so_number=$3,customer_po_number=$4,project_id=$5,customer_name=$6,part_code=$7,part_name=$8,order_quantity=$9,produced_quantity=$10,accepted_quantity=$11,rejected_quantity=$12,status=$13,assigned_employee_id=$14,assigned_employee_name=$15,assigned_machine_id=$16,assigned_machine_name=$17,start_date=$18,due_date=$19,completion_date=$20,payload=$21::jsonb,version=version+1,updated_at=now(),updated_by=$22 WHERE job_card_number=$1`,
      [number, payload.jobCardDate, payload.soNumber, payload.customerPoNumber, payload.projectId, payload.customerName,
        payload.partCode, payload.partName, payload.orderQuantity, payload.producedQuantity, payload.acceptedQuantity,
        payload.rejectedQuantity, payload.status, payload.assignedEmployeeId, payload.assignedEmployeeName,
        payload.assignedMachineId, payload.assignedMachineName, payload.startDate, payload.dueDate, payload.completionDate,
        JSON.stringify(payload), text(req.user?.email)]
    );
    await syncCardOperations(client, number, payload.processes);
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number, action: 'UPDATE', before: current.rows[0].payload, after: payload, module: 'job_cards' });
    const row = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1', [number]);
    await client.query('COMMIT');
    res.json({ record: cardView(row.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/job-cards/:number/issue', async (req, res) => {
  requirePermissions(req, 'job_card.approve', 'job_card.create');
  const number = requireNumber(req.params.number, 'job card number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const cardResult = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!cardResult.rowCount) throw notFound('Job Card not found.');
    const card = cardResult.rows[0];
    assertVersion(card, version, 'Job Card');
    if (card.bom_number && card.issued_at) throw conflict('This Job Card already has an immutable BOM snapshot.');
    const cardPayload = card.payload || {};
    const part = text(cardPayload.partNumber || card.part_code || cardPayload.drawingNumber || card.part_name);
    const asOf = String(card.job_card_date).slice(0, 10);
    let bom;
    if (req.body?.bomNumber) {
      bom = await client.query('SELECT * FROM bom_headers WHERE bom_number=$1 AND deleted_at IS NULL AND status=$2', [requireNumber(req.body.bomNumber, 'BOM number'), 'Active']);
      if (!bom.rowCount) throw notFound('BOM not found or not active.');
      if (req.body.bomVersion && Number(req.body.bomVersion) !== Number(bom.rows[0].version))
        throw conflict('BOM version changed on the server. Reload before continuing.');
    } else {
      bom = await client.query(
        `SELECT * FROM bom_headers WHERE deleted_at IS NULL AND status IN ('Active','Superseded') AND effective_date <= $2
          AND (lower(part_code)=lower($1) OR lower(part_name)=lower($1) OR lower(payload->>'drawingNumber')=lower($1))
          ORDER BY effective_date DESC,version DESC,bom_number DESC LIMIT 1`, [part, asOf]
      );
      if (!bom.rowCount) throw notFound(`No effective, active BOM found for ${part} on ${asOf}.`);
    }
    const bomRow = bom.rows[0];
    const items = await client.query('SELECT * FROM bom_items WHERE bom_number=$1 ORDER BY line_number', [bomRow.bom_number]);
    if (!items.rowCount) throw bad('The selected BOM has no material lines.');
    for (const [index, item] of items.rows.entries()) {
      await client.query(
        `INSERT INTO job_card_items(job_card_number,line_number,item_code,material_name,required_qty,unit,bom_number,bom_version,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [number, index + 1, item.item_code, item.material_name, item.quantity_per_unit, item.unit,
          bomRow.bom_number, bomRow.version, JSON.stringify(item.payload || item)]
      );
    }
    const snapshot = {
      bomNumber: bomRow.bom_number,
      bomVersion: Number(bomRow.version),
      effectiveDate: String(bomRow.effective_date).slice(0, 10),
      issuedAt: new Date().toISOString(),
      issuedBy: text(req.user?.email),
      items: items.rows.map((item) => ({ ...(item.payload || {}), materialId: item.item_code, materialName: item.material_name, requiredQty: Number(item.quantity_per_unit), unit: item.unit }))
    };
    const nextPayload = {
      ...cardPayload,
      bomNumber: bomRow.bom_number,
      bomVersion: Number(bomRow.version),
      bomSnapshot: snapshot,
      history: [...(cardPayload.history || []), historyEntry(req, 'BOM SNAPSHOT ISSUED', `${bomRow.bom_number} v${bomRow.version}`)]
    };
    await client.query(
      `UPDATE job_cards SET bom_number=$2,bom_version=$3,issued_at=now(),issued_by=$4,payload=$5::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE job_card_number=$1`,
      [number, bomRow.bom_number, bomRow.version, text(req.user?.email), JSON.stringify(nextPayload)]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number, action: 'BOM_SNAPSHOT', before: { bomNumber: card.bom_number, bomVersion: Number(card.bom_version) }, after: snapshot, module: 'job_cards' });
    const row = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1', [number]);
    await client.query('COMMIT');
    res.json({ record: cardView(row.rows[0]), snapshot });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/job-cards/:number/complete', async (req, res) => {
  requirePermissions(req, 'job_card.update_progress', 'job_card.approve');
  const number = requireNumber(req.params.number, 'job card number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Job Card not found.');
    assertVersion(current.rows[0], version, 'Job Card');
    const operations = await operationsFor(client, number);
    const problems = await completionProblems(client, current.rows[0]);
    if (problems.length) throw bad(`Job Card cannot be completed: ${problems.join(' ')}`);
    const payload = {
      ...(current.rows[0].payload || {}),
      status: 'Completed',
      completionDate: new Date().toISOString().slice(0, 10),
      history: [...((current.rows[0].payload || {}).history || []), historyEntry(req, 'Job Card completed')]
    };
    const finalQC = payload.qualityControl?.finalQC || {};
    const acceptedQuantity = num(finalQC.acceptedQty, 0);
    const rejectedQuantity = num(finalQC.scrapQty, 0);
    const producedQuantity = acceptedQuantity + rejectedQuantity + num(finalQC.reworkQty, 0);
    await client.query(
      `UPDATE job_cards SET status='Completed',completion_date=CURRENT_DATE,produced_quantity=$2,
       accepted_quantity=$3,rejected_quantity=$4,payload=$5::jsonb,version=version+1,updated_at=now(),updated_by=$6 WHERE job_card_number=$1`,
      [number, producedQuantity, acceptedQuantity, rejectedQuantity, JSON.stringify(payload), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number, action: 'COMPLETE', before: { status: current.rows[0].status }, after: { status: 'Completed' }, module: 'job_cards' });
    const row = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1', [number]);
    await client.query('COMMIT');
    res.json({ record: cardView(row.rows[0], operations) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/job-cards/:number/dispatch-request', async (req, res) => {
  requirePermissions(req, 'job_card.dispatch_request');
  const number = requireNumber(req.params.number, 'job card number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Job Card not found.');
    assertVersion(current.rows[0], version, 'Job Card');
    const card = current.rows[0];
    if (String(card.status).toLowerCase() !== 'completed') throw bad(`Job Card ${number} is not completed.`);
    const qc = (card.payload || {}).qualityControl?.finalQC || {};
    if (String(qc.disposition || '').toLowerCase() !== 'pass') throw bad(`Job Card ${number} final QC must PASS before dispatch.`);
    const eligible = Math.min(Number(card.order_quantity), Number.isFinite(Number(qc.acceptedQty)) ? Number(qc.acceptedQty) : 0);
    if (eligible <= 0) throw bad(`Job Card ${number} has no QC-approved quantity eligible for dispatch.`);
    const payload = card.payload || {};
    const projectId = text(payload.projectId || card.project_id);
    const salesOrderNo = text(payload.salesOrderRef || payload.soNumber || card.so_number);
    const customerName = text(payload.customerName || payload.customer || card.customer_name);
    if (!projectId || !salesOrderNo || !customerName) throw bad('Project ID, Sales Order and Customer are required before dispatch can be requested.');

    const requestId = `dispatch-${number.replace(/[^A-Za-z0-9._:-]/g, '-')}`;
    const prior = await client.query("SELECT data,version FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1", [requestId]);
    if (prior.rowCount) {
      await client.query('COMMIT');
      return res.json({ record: { ...(prior.rows[0].data || {}), id: requestId, version: Number(prior.rows[0].version) }, duplicate: true });
    }
    const at = new Date().toISOString();
    const request = {
      id: requestId,
      version: 1,
      jobCardNumber: number,
      projectId,
      salesOrderNo,
      customerName,
      partName: text(payload.partName || card.part_name),
      drawingNumber: text(payload.drawingNumber),
      productionQuantity: eligible,
      eligibleQuantity: eligible,
      qcStatus: 'PASS',
      status: 'Pending',
      dispatchRequestedBy: text(req.user?.email),
      dispatchRequestedByEmployeeId: text(req.user?.employeeId),
      dispatchRequestedByDepartment: text(req.user?.department),
      requestedAt: at,
      createdAt: at,
      audit: [{ action: 'Dispatch request created', user: text(req.user?.email), at }]
    };
    await client.query(
      'INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES($1,$2,$3::jsonb,1,now(),$4)',
      ['productionDispatchRequests', requestId, JSON.stringify(request), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number, action: 'DISPATCH_REQUEST', after: { eligibleQuantity: eligible }, module: 'job_cards' });
    const nextPayload = { ...payload, history: [...(payload.history || []), historyEntry(req, 'DISPATCH REQUESTED', `${eligible} unit(s)`)] };
    await client.query('UPDATE job_cards SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE job_card_number=$1', [number, JSON.stringify(nextPayload), text(req.user?.email)]);
    const row = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1', [number]);
    await client.query('COMMIT');
    res.status(201).json({ record: cardView(row.rows[0]), request, duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.delete('/job-cards/:number', requireAdmin, async (req, res) => {
  const number = requireNumber(req.params.number, 'job card number');
  const version = readVersion(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
    if (!current.rowCount) throw notFound('Job Card not found.');
    assertVersion(current.rows[0], version, 'Job Card');
    await client.query(
      'UPDATE job_cards SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE job_card_number=$1 AND version=$4',
      [number, text(req.user?.email), reason, version]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number, action: 'SOFT_DELETE', before: current.rows[0].payload, reason, module: 'job_cards' });
    await client.query('COMMIT');
    res.json({ deleted: number });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/job-cards/:number/restore', requireAdmin, async (req, res) => {
  const number = requireNumber(req.params.number, 'job card number');
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A restore reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NOT NULL FOR UPDATE',
      [number]
    );
    if (!current.rowCount) throw conflict('Only a deleted Job Card can be restored.');
    const payload = { ...(current.rows[0].payload || {}), status: 'Cancelled',
      history: [...((current.rows[0].payload || {}).history || []), historyEntry(req, 'Job Card restored', reason)] };
    await client.query(
      `UPDATE job_cards SET deleted_at=NULL,deleted_by=NULL,delete_reason='',status='Cancelled',payload=$2::jsonb,
       version=version+1,updated_at=now(),updated_by=$3 WHERE job_card_number=$1`,
      [number, JSON.stringify(payload), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number,
      action: 'RESTORE', after: payload, reason, module: 'job_cards' });
    await client.query('COMMIT');
    const restored = await getPool().query('SELECT * FROM job_cards WHERE job_card_number=$1', [number]);
    res.json({ record: cardView(restored.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/* ------------------------------------------------------------------ */
/* HT Outsource                                                         */
/* ------------------------------------------------------------------ */

const normalizeHt = (data, fallbackNumber = '') => {
  payloadSize(data);
  const htrNumber = requireNumber(data?.htrNumber || fallbackNumber, 'HTR number');
  const jobCardNumber = text(data?.jobCardNumber);
  if (!jobCardNumber) throw bad('A Job Card number is required for an HTR.');
  const qtyRequested = num(data?.qtyRequested, 0);
  if (qtyRequested <= 0) throw bad('Qty to send must be greater than zero.');
  const status = text(data?.status, HT_STATUS.RAISED);
  if (!Object.values(HT_STATUS).includes(status)) throw bad(`Unsupported HTR status "${status}".`);
  return {
    ...data,
    htrNumber,
    htrDate: dateOnly(data?.htrDate || data?.requestDate, new Date().toISOString().slice(0, 10)),
    jobCardNumber,
    projectId: text(data?.projectId),
    partCode: text(data?.partCode),
    partName: text(data?.partName),
    processType: text(data?.processType, 'Heat Treatment'),
    processSpec: text(data?.processSpec),
    targetHardness: text(data?.targetHardness),
    qtyRequested,
    vendorId: text(data?.vendorId),
    vendorName: text(data?.vendorName),
    needByDate: dateOnly(data?.needByDate) || null,
    issuedQty: num(data?.issuedQty, 0),
    receivedQty: num(data?.receivedQty, 0),
    rejectedQty: num(data?.rejectedQty, 0),
    status,
    remarks: text(data?.remarks)
  };
};

const htView = async (client, row) => {
  const payload = { ...(row.payload || {}) };
  return {
    ...payload,
    htrNumber: row.htr_number,
    requestDate: String(row.htr_date).slice(0, 10),
    jobCardNumber: row.job_card_number || '',
    partCode: row.part_code || '',
    partName: row.part_name || '',
    processType: row.process_type || '',
    vendorId: row.vendor_id || '',
    vendorName: row.vendor_name || '',
    qtyRequested: Number(payload.qtyRequested ?? row.sent_qty),
    sentQty: Number(row.sent_qty),
    issuedQty: Number(payload.issuedQty ?? row.sent_qty),
    receivedQty: Number(row.received_qty),
    rejectedQty: Number(row.rejected_qty),
    status: row.status,
    version: Number(row.version),
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at
  };
};

const insertHt = async (client, req, payload, createToken = null) => {
  const flat = normalizeHt(payload, payload.htrNumber);
  await client.query(
    `INSERT INTO ht_outsource_requests(htr_number,htr_date,job_card_number,part_code,part_name,process_type,vendor_id,vendor_name,sent_qty,received_qty,rejected_qty,status,remarks,created_by,updated_by,payload,create_token)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15::jsonb,$16)`,
    [flat.htrNumber, flat.htrDate, flat.jobCardNumber, flat.partCode, flat.partName, flat.processType, flat.vendorId,
      flat.vendorName, Number(flat.issuedQty ?? 0), flat.receivedQty, flat.rejectedQty, flat.status, flat.remarks,
      text(req.user?.email), JSON.stringify({ ...flat.payload, ...flat }), createToken]
  );
};

const htForUpdate = async (client, number) => {
  const result = await client.query('SELECT * FROM ht_outsource_requests WHERE htr_number=$1 AND deleted_at IS NULL FOR UPDATE', [number]);
  if (!result.rowCount) throw notFound('HT Outsource Request not found.');
  return result.rows[0];
};

const syncJobCardHt = async (client, req, jobCardNumber, patch) => {
  if (!jobCardNumber) return;
  const result = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [jobCardNumber]);
  if (!result.rowCount) return;
  const payload = { ...(result.rows[0].payload || {}) };
  payload.operations = { ...(payload.operations || {}), heatTreatment: { ...(payload.operations?.heatTreatment || {}), ...patch } };
  payload.history = [...(payload.history || []), historyEntry(req, 'HT OUTSOURCE UPDATE', jobCardNumber)];
  await client.query('UPDATE job_cards SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3 WHERE job_card_number=$1',
    [jobCardNumber, JSON.stringify(payload), text(req.user?.email)]);
};

const htTransition = async (req, res, { permission, allowed, apply, action, jobCardPatch = null }) => {
  if (permission) requirePermissions(req, ...permission);
  const number = requireNumber(req.params.number, 'HTR number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await htForUpdate(client, number);
    assertVersion(row, version, 'HT Outsource Request');
    if (!allowed.includes(row.status)) throw conflict(`${number} cannot be ${action.toLowerCase()} from ${row.status}.`);
    const before = await htView(client, row);
    const next = await apply(client, row, req);
    const payload = { ...(row.payload || {}), ...next.payload, status: next.status, history: [...((row.payload || {}).history || []), historyEntry(req, action, text(req.body?.reason))] };
    await client.query(
      `UPDATE ht_outsource_requests SET htr_date=$2,job_card_number=$3,part_code=$4,part_name=$5,process_type=$6,vendor_id=$7,vendor_name=$8,sent_qty=$9,received_qty=$10,rejected_qty=$11,status=$12,remarks=$13,payload=$14::jsonb,version=version+1,updated_at=now(),updated_by=$15 WHERE htr_number=$1`,
      [number, payload.htrDate || row.htr_date, payload.jobCardNumber || row.job_card_number,
        payload.partCode || row.part_code, payload.partName || row.part_name, payload.processType || row.process_type,
        payload.vendorId || row.vendor_id, payload.vendorName || row.vendor_name, Number(payload.issuedQty ?? payload.qtyRequested ?? row.sent_qty),
        Number(payload.receivedQty ?? row.received_qty), Number(payload.rejectedQty ?? row.rejected_qty), payload.status,
        payload.remarks || '', JSON.stringify(payload), text(req.user?.email)]
    );
    if (jobCardPatch) await syncJobCardHt(client, req, row.job_card_number, jobCardPatch(payload));
    await writeAudit(client, req, { table: 'ht_outsource_audit', idColumn: 'htr_number', id: number, action, before, after: { ...payload, version: version + 1 }, reason: text(req.body?.reason), module: 'ht_outsource' });
    const saved = await client.query('SELECT * FROM ht_outsource_requests WHERE htr_number=$1', [number]);
    await client.query('COMMIT');
    res.json({ record: await htView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

router.get('/ht-outsource', async (req, res) => {
  requirePermissions(req, 'ht_outsource.view', 'production.view', 'ht_outsource.create');
  const params = [];
  let where = 'deleted_at IS NULL';
  if (req.query.status) { params.push(text(req.query.status)); where += ` AND status=$${params.length}`; }
  if (req.query.jobCardNumber) { params.push(text(req.query.jobCardNumber)); where += ` AND job_card_number=$${params.length}`; }
  const result = await getPool().query(`SELECT * FROM ht_outsource_requests WHERE ${where} ORDER BY htr_date DESC,htr_number DESC`, params);
  const records = [];
  for (const row of result.rows) records.push(await htView(getPool(), row));
  res.json({ records });
});

router.get('/ht-outsource/:number/audit', async (req, res) => {
  requirePermissions(req, 'ht_outsource.view');
  const number = requireNumber(req.params.number, 'HTR number');
  const exists = await getPool().query('SELECT 1 FROM ht_outsource_requests WHERE htr_number=$1', [number]);
  if (!exists.rowCount) throw notFound('HT Outsource Request not found.');
  res.json({ entries: await auditRows(getPool(), 'ht_outsource_audit', 'htr_number', number, Number(req.query.limit)) });
});

router.get('/ht-outsource/:number', async (req, res) => {
  requirePermissions(req, 'ht_outsource.view', 'production.view', 'ht_outsource.create');
  const result = await getPool().query(
    'SELECT * FROM ht_outsource_requests WHERE htr_number=$1 AND deleted_at IS NULL', [requireNumber(req.params.number, 'HTR number')]
  );
  if (!result.rowCount) throw notFound('HT Outsource Request not found.');
  res.json({ record: await htView(getPool(), result.rows[0]) });
});

router.post('/ht-outsource', async (req, res) => {
  requirePermissions(req, 'ht_outsource.create', 'job_card.create');
  const createToken = idempotencyToken(req.body?.createToken);
  const payload = normalizeHt(req.body?.data, 'PENDING');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query('SELECT * FROM ht_outsource_requests WHERE create_token=$1 FOR UPDATE', [createToken]);
    if (prior.rowCount) {
      if (prior.rows[0].deleted_at) throw conflict('Deleted HTR cannot be recreated by retry.');
      await client.query('COMMIT');
      return res.json({ record: await htView(client, prior.rows[0]), duplicate: true });
    }
    const card = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL', [payload.jobCardNumber]);
    if (!card.rowCount) throw notFound('Linked Job Card not found.');
    if (card.rows[0].payload?.operations?.heatTreatment?.required === false)
      throw bad('This Job Card does not have Heat Treatment marked as Required.');
    const open = await client.query(
      "SELECT 1 FROM ht_outsource_requests WHERE job_card_number=$1 AND status<>$2 AND deleted_at IS NULL LIMIT 1",
      [payload.jobCardNumber, HT_STATUS.CANCELLED]
    );
    if (open.rowCount) throw conflict('An active HT Outsource Request already exists for this Job Card.');
    payload.htrNumber = await nextNumber(client, { prefix: 'HTR-', table: 'ht_outsource_requests', column: 'htr_number', sequenceKey: 'htOutsource' });
    payload.status = payload.vendorName ? HT_STATUS.VENDOR_ASSIGNED : HT_STATUS.RAISED;
    payload.issuedQty = 0;
    payload.receivedQty = 0;
    payload.rejectedQty = 0;
    payload.projectId = payload.projectId || card.rows[0].project_id || '';
    payload.partName = payload.partName || card.rows[0].part_name || '';
    payload.partCode = payload.partCode || card.rows[0].part_code || '';
    payload.issueDate = '';
    payload.issuedBy = '';
    payload.outwardChallan = '';
    payload.vehicleNo = '';
    payload.receivedDate = '';
    payload.receivedBy = '';
    payload.inwardChallan = '';
    payload.poRef = '';
    payload.billRef = '';
    payload.rateInfo = '';
    payload.actualHardness = '';
    payload.disposition = 'Pending';
    payload.completedBy = '';
    payload.completedDate = '';
    payload.raisedBy = text(req.user?.email);
    payload.raisedByDept = text(req.user?.department);
    payload.createdAt = new Date().toISOString();
    payload.updatedAt = payload.createdAt;
    payload.history = [historyEntry(req, 'HTR CREATED', `${payload.qtyRequested} Nos`)];
    await insertHt(client, req, payload, createToken);
    await writeAudit(client, req, { table: 'ht_outsource_audit', idColumn: 'htr_number', id: payload.htrNumber, action: 'CREATE', after: payload, module: 'ht_outsource' });
    const row = await client.query('SELECT * FROM ht_outsource_requests WHERE htr_number=$1', [payload.htrNumber]);
    await client.query('COMMIT');
    res.status(201).json({ record: await htView(client, row.rows[0]), duplicate: false });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.put('/ht-outsource/:number', async (req, res) => {
  requirePermissions(req, 'ht_outsource.create', 'ht_outsource.store_action');
  const number = requireNumber(req.params.number, 'HTR number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await htForUpdate(client, number);
    assertVersion(row, version, 'HT Outsource Request');
    if ([HT_STATUS.ISSUED, HT_STATUS.RECEIVED, HT_STATUS.COMPLETED, HT_STATUS.CANCELLED].includes(row.status))
      throw conflict(`HTR cannot be edited from ${row.status}.`);
    const current = await htView(client, row);
    const patch = req.body?.data || {};
    const next = {
      ...current,
      ...patch,
      htrNumber: number,
      jobCardNumber: row.job_card_number,
      qtyRequested: num(patch.qtyRequested ?? current.qtyRequested, current.qtyRequested),
      history: [...((row.payload || {}).history || []), historyEntry(req, 'HTR UPDATED')]
    };
    if (next.qtyRequested <= 0) throw bad('Qty to send must be greater than zero.');
    await client.query(
      `UPDATE ht_outsource_requests SET part_code=$2,part_name=$3,process_type=$4,vendor_name=$5,sent_qty=$6,remarks=$7,payload=$8::jsonb,version=version+1,updated_at=now(),updated_by=$9 WHERE htr_number=$1`,
      [number, text(next.partCode), text(next.partName), text(next.processType, 'Heat Treatment'), text(next.vendorName),
        Number(next.issuedQty ?? 0), text(next.remarks), JSON.stringify(next), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'ht_outsource_audit', idColumn: 'htr_number', id: number, action: 'UPDATE', before: current, after: next, module: 'ht_outsource' });
    const saved = await client.query('SELECT * FROM ht_outsource_requests WHERE htr_number=$1', [number]);
    await client.query('COMMIT');
    res.json({ record: await htView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/ht-outsource/:number/assign-vendor', (req, res) => htTransition(req, res, {
  permission: ['ht_outsource.purchase_action', 'purchase.order'],
  allowed: [HT_STATUS.RAISED, HT_STATUS.VENDOR_ASSIGNED],
  action: 'VENDOR_ASSIGNED',
  apply: async (_client, row, request) => {
    const vendorName = text(request.body?.vendorName);
    if (!vendorName) throw bad('Select a vendor from Vendor Master.');
    const current = await htView({ query: async () => ({ rows: [row] }) }, row);
    return {
      status: HT_STATUS.VENDOR_ASSIGNED,
      payload: {
        ...current,
        vendorName,
        vendorId: text(request.body?.vendorId || row.vendor_id),
        vendorAddress: text(request.body?.vendorAddress),
        vendorPhone: text(request.body?.vendorPhone),
        vendorEmail: text(request.body?.vendorEmail),
        poRef: text(request.body?.poRef || current.poRef),
        rateInfo: text(request.body?.rateInfo || current.rateInfo)
      }
    };
  },
  jobCardPatch: (payload) => ({ vendor: payload.vendorName, poRef: payload.poRef, rateInfo: payload.rateInfo })
}));

router.post('/ht-outsource/:number/issue', (req, res) => htTransition(req, res, {
  permission: ['ht_outsource.store_action', 'material_issue.confirm'],
  allowed: [HT_STATUS.RAISED, HT_STATUS.VENDOR_ASSIGNED],
  action: 'ISSUED_TO_VENDOR',
  apply: async (client, row, request) => {
    const qty = num(request.body?.qty, 0);
    if (qty <= 0) throw bad('Enter qty to issue (must be > 0).');
    const current = await htView(client, row);
    if (qty > Number(current.qtyRequested)) throw bad(`Issue qty ${qty} exceeds requested qty ${current.qtyRequested}.`);
    if (!text(row.vendor_name)) throw bad('Purchase must assign a vendor first.');
    const movement = await moveHtStock(client, request, {
      type: 'OUT',
      quantity: qty,
      reference: row.htr_number,
      itemCode: current.inventoryItemCode || current.partCode,
      itemName: current.partName,
      vendorName: row.vendor_name,
      jobCardNumber: row.job_card_number,
      projectId: current.projectId,
      date: new Date().toISOString().slice(0, 10)
    });
    return {
      status: HT_STATUS.ISSUED,
      payload: {
        ...current,
        issuedQty: qty,
        sentQty: qty,
        issuedDate: new Date().toISOString().slice(0, 10),
        issuedBy: text(request.user?.email),
        outwardChallan: text(request.body?.outwardChallan),
        vehicleNo: text(request.body?.vehicleNo),
        stockMovement: movement
      }
    };
  },
  jobCardPatch: (payload) => ({ qtySent: payload.issuedQty, sentDate: payload.issuedDate, status: 'Sent to Vendor', vendor: payload.vendorName })
}));

router.post('/ht-outsource/:number/receive', (req, res) => htTransition(req, res, {
  permission: ['ht_outsource.store_action', 'material_issue.confirm'],
  allowed: [HT_STATUS.ISSUED],
  action: 'RECEIVED_FROM_VENDOR',
  apply: async (client, row, request) => {
    const qty = num(request.body?.qty, 0);
    if (qty <= 0) throw bad('Enter qty received (must be > 0).');
    const current = await htView(client, row);
    if (qty > Number(current.issuedQty)) throw bad(`Received qty ${qty} exceeds issued qty ${current.issuedQty}.`);
    const movement = await moveHtStock(client, request, {
      type: 'IN',
      quantity: qty,
      reference: row.htr_number,
      itemCode: current.inventoryItemCode || current.partCode,
      itemName: current.partName,
      vendorName: row.vendor_name,
      jobCardNumber: row.job_card_number,
      projectId: current.projectId,
      date: new Date().toISOString().slice(0, 10)
    });
    return {
      status: HT_STATUS.RECEIVED,
      payload: {
        ...current,
        receivedQty: qty,
        rejectedQty: Math.max(0, Number(current.issuedQty) - qty),
        receivedDate: new Date().toISOString().slice(0, 10),
        receivedBy: text(request.user?.email),
        inwardChallan: text(request.body?.inwardChallan),
        remarks: text(request.body?.remarks || current.remarks),
        stockMovement: movement
      }
    };
  },
  jobCardPatch: (payload) => ({ qtyReceived: payload.receivedQty, receivedDate: payload.receivedDate, status: 'Received', rejectedQty: payload.rejectedQty })
}));

const completeApply = async (client, row, request) => {
  if (row.status !== HT_STATUS.RECEIVED) throw bad('Goods must be Received at Store before hardness can be verified.');
  const current = await htView(client, row);
  const disposition = text(request.body?.disposition, 'Pass');
  if (!['Pass', 'Fail'].includes(disposition)) throw bad('Disposition must be Pass or Fail.');
  const actualHardness = text(request.body?.actualHardness);
  if (!actualHardness) throw bad('Actual hardness is required.');
  return {
    status: disposition === 'Pass' ? HT_STATUS.COMPLETED : HT_STATUS.RECEIVED,
    payload: {
      ...current,
      actualHardness,
      disposition,
      reworkRequired: disposition === 'Fail',
      rejectedQty: Number(current.rejectedQty),
      completedBy: text(request.user?.email),
      completedDate: new Date().toISOString().slice(0, 10),
      remarks: text(request.body?.remarks || current.remarks),
      history: [...(current.history || []), historyEntry(request, 'Hardness verified', actualHardness)]
    }
  };
};

const completePatch = (payload) => ({
  actualHardness: payload.actualHardness,
  disposition: payload.disposition,
  status: payload.disposition === 'Pass' ? 'Completed' : 'Failed / Rework',
  rejectedQty: payload.rejectedQty,
  inspector: payload.completedBy,
  remarks: payload.remarks
});

router.post('/ht-outsource/:number/complete', (req, res) => htTransition(req, res, {
  permission: ['ht_outsource.create', 'production.qc.manage', 'job_card.update_progress'],
  allowed: [HT_STATUS.RECEIVED],
  action: 'HARDNESS_VERIFIED',
  apply: completeApply,
  jobCardPatch: completePatch
}));

router.post('/ht-outsource/:number/reject', (req, res) => htTransition(req, res, {
  permission: ['ht_outsource.create', 'production.qc.manage', 'job_card.update_progress'],
  allowed: [HT_STATUS.RECEIVED],
  action: 'REJECTED_FOR_REWORK',
  apply: async (client, row, request) => {
    const current = await htView(client, row);
    const qty = num(request.body?.qty, 1);
    if (qty <= 0) throw bad('Rejected quantity must be greater than zero.');
    if (qty > Number(current.receivedQty)) throw bad('Rejected quantity cannot exceed received quantity.');
    return {
      status: HT_STATUS.RECEIVED,
      payload: {
        ...current,
        disposition: 'Fail',
        reworkRequired: true,
        rejectedQty: qty,
        rejectionReason: text(request.body?.reason),
        remarks: text(request.body?.remarks || current.remarks)
      }
    };
  },
  jobCardPatch: completePatch
}));

router.post('/ht-outsource/:number/cancel', requireAdmin, (req, res) => htTransition(req, res, {
  allowed: [HT_STATUS.RAISED, HT_STATUS.VENDOR_ASSIGNED, HT_STATUS.RECEIVED, HT_STATUS.COMPLETED],
  action: 'CANCELLED',
  apply: async (client, row, request) => {
    const reason = text(request.body?.reason);
    if (!reason) throw bad('A cancellation reason is required.');
    if (row.status === HT_STATUS.ISSUED) throw bad('Cannot cancel after material is issued to vendor. Receive goods back first.');
    const current = await htView(client, row);
    return { status: HT_STATUS.CANCELLED, payload: { ...current, cancellationReason: reason, remarks: reason, status: HT_STATUS.CANCELLED } };
  }
}));

router.delete('/ht-outsource/:number', requireAdmin, async (req, res) => {
  const number = requireNumber(req.params.number, 'HTR number');
  const version = readVersion(req.body?.version);
  const reason = text(req.body?.reason);
  if (!reason) throw bad('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = await htForUpdate(client, number);
    assertVersion(row, version, 'HT Outsource Request');
    if ([HT_STATUS.ISSUED, HT_STATUS.RECEIVED, HT_STATUS.COMPLETED].includes(row.status))
      throw conflict('Issued, received or completed HTRs cannot be deleted; cancel or reverse the movement first.');
    await client.query(
      'UPDATE ht_outsource_requests SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE htr_number=$1 AND version=$4',
      [number, text(req.user?.email), reason, version]
    );
    await writeAudit(client, req, { table: 'ht_outsource_audit', idColumn: 'htr_number', id: number, action: 'SOFT_DELETE', before: await htView(client, row), reason, module: 'ht_outsource' });
    await client.query('COMMIT');
    res.json({ deleted: number });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/* ------------------------------------------------------------------ */
/* Dispatch requests (shared with Delivery Challan)                     */
/* ------------------------------------------------------------------ */

router.get('/dispatch-requests', async (req, res) => {
  requirePermissions(req, 'job_card.dispatch_request', 'delivery.view');
  const result = await getPool().query(
    "SELECT record_id,data,version FROM module_records WHERE storage_key='productionDispatchRequests' ORDER BY updated_at DESC"
  );
  res.json({ records: result.rows.map((row) => ({ ...(row.data || {}), id: row.record_id, version: Number(row.version) })) });
});

router.post('/dispatch-requests/:id/link', async (req, res) => {
  requirePermissions(req, 'delivery.create');
  const id = text(req.params.id);
  if (!id) throw bad('Dispatch request ID is required.');
  const challanNumber = requireNumber(req.body?.challanNumber, 'Delivery Challan number');
  const quantity = num(req.body?.quantity, 0);
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      "SELECT record_id,data,version FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1 FOR UPDATE",
      [id]
    );
    if (!current.rowCount) throw notFound('Dispatch request not found.');
    assertVersion(current.rows[0], version, 'Dispatch request');
    const data = current.rows[0].data || {};
    if (data.status !== 'Pending' || data.challanNumber) throw conflict('This dispatch request already has a Delivery Challan.');
    if (quantity <= 0 || quantity > Number(data.eligibleQuantity || data.productionQuantity || 0))
      throw bad(`Dispatch quantity must be greater than zero and no more than ${Number(data.eligibleQuantity || data.productionQuantity || 0)}.`);
    const at = new Date().toISOString();
    const next = { ...data, status: 'Challan Created', challanNumber, challanQuantity: quantity,
      audit: [...(Array.isArray(data.audit) ? data.audit : []), { action: 'Delivery Challan created', user: text(req.user?.email), at, reference: challanNumber, quantity }] };
    await client.query(
      "UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key='productionDispatchRequests' AND record_id=$1 AND version=$2",
      [id, version, JSON.stringify(next), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: text(data.jobCardNumber),
      action: 'DELIVERY_CHALLAN_LINK', after: { challanNumber, quantity }, module: 'job_cards' });
    await client.query('COMMIT');
    res.json({ record: next });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/dispatch-requests/:id/dispatched', async (req, res) => {
  requirePermissions(req, 'delivery.create');
  const id = text(req.params.id);
  const challanNumber = requireNumber(req.body?.challanNumber, 'Delivery Challan number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      "SELECT record_id,data,version FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1 FOR UPDATE",
      [id]
    );
    if (!current.rowCount) throw notFound('Dispatch request not found.');
    assertVersion(current.rows[0], version, 'Dispatch request');
    const data = current.rows[0].data || {};
    if (data.status !== 'Challan Created' || String(data.challanNumber) !== challanNumber)
      throw conflict('This dispatch request does not have a matching pending Delivery Challan.');
    const at = new Date().toISOString();
    const next = { ...data, status: 'Dispatched', dispatchedAt: at, dispatchedBy: text(req.user?.email),
      audit: [...(Array.isArray(data.audit) ? data.audit : []), { action: 'Dispatch confirmed', user: text(req.user?.email), at, reference: challanNumber }] };
    await client.query(
      "UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key='productionDispatchRequests' AND record_id=$1 AND version=$2",
      [id, version, JSON.stringify(next), text(req.user?.email)]
    );
    await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: text(data.jobCardNumber),
      action: 'DISPATCH_CONFIRMED', after: { challanNumber }, module: 'job_cards' });
    await client.query('COMMIT');
    res.json({ record: next });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/dispatch-requests/:id/release', async (req, res) => {
  requirePermissions(req, 'delivery.create');
  const id = text(req.params.id);
  const challanNumber = requireNumber(req.body?.challanNumber, 'Delivery Challan number');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      "SELECT record_id,data,version FROM module_records WHERE storage_key='productionDispatchRequests' AND record_id=$1 FOR UPDATE",
      [id]
    );
    if (!current.rowCount) throw notFound('Dispatch request not found.');
    assertVersion(current.rows[0], version, 'Dispatch request');
    const data = current.rows[0].data || {};
    if (data.status !== 'Challan Created' || String(data.challanNumber) !== challanNumber)
      throw conflict('The dispatch request can no longer be released for this challan.');
    const at = new Date().toISOString();
    const { challanNumber: _challanNumber, challanQuantity: _challanQuantity, ...rest } = data;
    const next = { ...rest, status: 'Pending',
      audit: [...(Array.isArray(data.audit) ? data.audit : []), { action: 'Challan creation rolled back', user: text(req.user?.email), at, reference: challanNumber }] };
    await client.query(
      "UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key='productionDispatchRequests' AND record_id=$1 AND version=$2",
      [id, version, JSON.stringify(next), text(req.user?.email)]
    );
    await client.query('COMMIT');
    res.json({ record: next });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/* ------------------------------------------------------------------ */
/* Admin-only legacy migration preview and selected import.             */
/* ------------------------------------------------------------------ */

const migrationGroups = async () => {
  const [cards, requirements, ht] = await Promise.all([
    legacyRows(getPool(), 'productionJobCards'),
    legacyRows(getPool(), 'productionRequirements'),
    legacyRows(getPool(), 'htOutsourceRequests')
  ]);
  const current = await Promise.all([
    getPool().query('SELECT job_card_number,deleted_at FROM job_cards'),
    getPool().query('SELECT requirement_number,deleted_at FROM production_requirements'),
    getPool().query('SELECT htr_number,deleted_at FROM ht_outsource_requests')
  ]);
  const compare = (rows, idColumn, currentRows) => {
    const seen = new Set();
    const eligible = [], existing = [], conflicts = [], deleted = [];
    const byNumber = new Map(currentRows.rows.map((row) => [String(row[idColumn]).toLowerCase(), row]));
    for (const entry of rows) {
      const number = text(entry?.jobCardNumber || entry?.requirementNumber || entry?.htrNumber);
      if (!number || !SAFE_NUMBER.test(number)) { if (number) conflicts.push({ number, reason: 'Invalid document number' }); continue; }
      if (seen.has(number.toLowerCase())) { conflicts.push({ number, reason: 'Duplicate legacy ID' }); continue; }
      seen.add(number.toLowerCase());
      const row = byNumber.get(number.toLowerCase());
      if (row?.deleted_at) { deleted.push({ number }); continue; }
      if (row) existing.push({ number });
      else eligible.push({ number, payload: entry });
    }
    return { eligible, existing, conflicts, deleted };
  };
  return {
    jobCards: compare(cards, 'job_card_number', current[0]),
    requirements: compare(requirements, 'requirement_number', current[1]),
    htOutsource: compare(ht, 'htr_number', current[2])
  };
};

router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const groups = await migrationGroups();
  res.json({
    ...groups,
    counts: {
      jobCards: groups.jobCards.eligible.length,
      requirements: groups.requirements.eligible.length,
      htOutsource: groups.htOutsource.eligible.length
    }
  });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const kind = text(req.body?.kind);
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!['jobCards', 'requirements', 'htOutsource'].includes(kind)) throw bad('kind must be jobCards, requirements or htOutsource.');
  if (!records.length || records.length > 1000) throw bad('Select between 1 and 1000 records to import.');
  const client = await getPool().connect();
  const imported = [], conflicts = [];
  try {
    await client.query('BEGIN');
    for (const entry of records) {
      const number = text(entry?.jobCardNumber || entry?.requirementNumber || entry?.htrNumber);
      if (!SAFE_NUMBER.test(number)) { conflicts.push({ number, reason: 'Invalid document number' }); continue; }
      const table = kind === 'jobCards' ? 'job_cards' : kind === 'requirements' ? 'production_requirements' : 'ht_outsource_requests';
      const column = kind === 'jobCards' ? 'job_card_number' : kind === 'requirements' ? 'requirement_number' : 'htr_number';
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))`, ['production-import', number]);
      const exists = await client.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [number]);
      if (exists.rowCount) { conflicts.push({ number, reason: 'Record already exists (tombstones are protected)' }); continue; }
      try {
        if (kind === 'jobCards') {
          const payload = normalizeJobCard(entry, number);
          payload.history = [historyEntry(req, 'IMPORT', number)];
          await insertCard(client, req, payload);
          await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: number, action: 'IMPORT', after: payload, reason: 'Admin-confirmed legacy migration', module: 'job_cards' });
        } else if (kind === 'requirements') {
          const payload = normalizeRequirement(entry, number);
          payload.history = [historyEntry(req, 'IMPORT', number)];
          await insertRequirement(client, req, payload);
          await writeAudit(client, req, { table: 'erp_audit_log', idColumn: 'record_id', global: false, id: number, action: 'IMPORT', after: payload, reason: 'Admin-confirmed legacy migration', module: 'production_requirements' });
        } else {
          const payload = normalizeHt(entry, number);
          payload.history = [historyEntry(req, 'IMPORT', number)];
          await insertHt(client, req, payload);
          await writeAudit(client, req, { table: 'ht_outsource_audit', idColumn: 'htr_number', id: number, action: 'IMPORT', after: payload, reason: 'Admin-confirmed legacy migration', module: 'ht_outsource' });
        }
        imported.push(number);
      } catch (error) { conflicts.push({ number, reason: error.message }); }
    }
    await client.query('COMMIT');
    res.json({ imported, conflicts });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

export default router;
