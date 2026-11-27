import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';
import { postStockMovement } from './stockLedger.js';

const router = express.Router();
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message, current = null) => Object.assign(new Error(message), { status: 409, current });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const text = (value, fallback = '') => String(value ?? fallback).trim();
const today = () => new Date().toISOString().slice(0, 10);
const dateText = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const closedStatuses = new Set(['Cancelled', 'Closed', 'Rejected', 'Fully Issued']);
const issuableStatuses = new Set(['Submitted', 'Approved', 'Pending Store', 'Partially Issued']);
/* Mirrors MR_EDITABLE_STATUSES in src/utils/storeService.js. */
const editableStatuses = new Set(['Draft', 'Submitted', 'Approved', 'Pending Store', 'Cancelled', 'Rejected']);

const WRITE_PERMISSIONS = [
  'store.module', 'material_issue.create', 'material_issue.confirm', 'material_request.create',
  'material_request.edit', 'material_return.create'
];
const VIEW_PERMISSIONS = ['store.module', 'material_issue.view', 'inventory.view', 'production.view'];

const authorizeStore = (req, res, next) => {
  if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
  const permissions = req.user?.rolePermissions || [];
  if (hasPermissionForRole(req.user?.roleKey, WRITE_PERMISSIONS, permissions)) return next();
  if (req.method === 'GET' && hasPermissionForRole(req.user?.roleKey, VIEW_PERMISSIONS, permissions)) return next();
  return res.status(403).json({ error: 'Your department role does not allow this Store operation.' });
};
const requirePermission = (permission, adminOnly = false) => (req, res, next) => {
  if (adminOnly && (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator')) return next();
  if (adminOnly) return res.status(403).json({ error: 'Administrator access is required.' });
  if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
  if (hasPermissionForRole(req.user?.roleKey, [permission], req.user?.rolePermissions || [])) return next();
  return res.status(403).json({ error: `Permission denied: ${permission}` });
};
router.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/audit') return next();
  return authorizeStore(req, res, next);
});

const auditIssue = (client, req, issueNumber, action, before, after, reason = '') => client.query(
  `INSERT INTO material_issue_audit (issue_number, action, actor_id, actor_email, actor_role, reason, before_values, after_values)
   VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
  [issueNumber, action, req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '', reason,
    before ? JSON.stringify(safeAuditValues(before)) : null, after ? JSON.stringify(safeAuditValues(after)) : null]
);

/** PostgreSQL sequence mirrors the established MR-000001 / SI-000001 format. */
const sequenceNext = async (client, prefix, key, table, column) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('store-seq:' || $1))", [key]);
  const row = await client.query('SELECT last_number FROM store_sequences WHERE sequence_key=$1 FOR UPDATE', [key]);
  let next = (Number(row.rows[0]?.last_number) || 0) + 1;
  const active = await client.query(`SELECT COALESCE(max(substring(${column} from '(\\d+)$')::bigint),0)::bigint AS n FROM ${table}`);
  next = Math.max(next, Number(active.rows[0]?.n) + 1);
  await client.query(
    `INSERT INTO store_sequences (sequence_key,last_number,updated_at) VALUES ($1,$2,now())
     ON CONFLICT (sequence_key) DO UPDATE SET last_number=EXCLUDED.last_number,updated_at=now()`,
    [key, next]
  );
  return `${prefix}-${String(next).padStart(6, '0')}`;
};

const requestItems = async (client, mrNumber) => {
  const result = await client.query(
    'SELECT * FROM material_request_items WHERE mr_number=$1 ORDER BY line_number FOR UPDATE',
    [mrNumber]
  );
  return result.rows;
};

const requestView = async (client, row) => {
  const items = (await requestItems(client, row.mr_number)).map((item) => ({
    ...item,
    ...(item.payload || {}),
    issuedQty: num(item.issued_qty),
    balanceQty: Math.max(0, num(item.required_qty) - num(item.issued_qty))
  }));
  return { ...(row.payload || {}), ...row, mrNumber: row.mr_number, recordVersion: Number(row.version), items };
};

router.post('/sequences/next', async (req, res) => {
  const prefix = text(req.body?.prefix, 'SI');
  const key = text(req.body?.key, 'storeIssue');
  const table = prefix === 'MR' ? 'material_requests' : prefix === 'SR' ? 'store_returns' : 'store_issues';
  const column = prefix === 'MR' ? 'mr_number' : prefix === 'SR' ? 'return_number' : 'issue_number';
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const nextNumber = await sequenceNext(client, prefix, key, table, column);
    await client.query('COMMIT');
    res.json({ nextNumber, sequence: Number(nextNumber.split('-').pop()) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/requests', async (req, res) => {
  const client = await getPool().connect();
  try {
    const rows = (await client.query(
      'SELECT * FROM material_requests WHERE deleted_at IS NULL ORDER BY mr_date DESC,created_at DESC'
    )).rows;
    const records = [];
    for (const row of rows) records.push(await requestView(client, row));
    res.json({ records });
  } finally { client.release(); }
});

const insertRequestItems = async (client, mrNumber, items) => {
  for (const [index, item] of items.entries()) {
    await client.query(
      `INSERT INTO material_request_items (mr_number,line_number,material_id,material_name,required_qty,issued_qty,unit,batch_no,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [mrNumber, index + 1, text(item.materialId || item.itemCode || item.materialCode),
        text(item.materialName || item.itemName), Math.abs(num(item.requiredQty ?? item.quantity)),
        num(item.issuedQty || 0), text(item.unit, 'Nos'), text(item.batchNo), JSON.stringify(item)]
    );
  }
};

router.post('/requests', requirePermission('material_request.create'), async (req, res) => {
  const data = req.body?.data || req.body || {};
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw badRequest('At least one item line is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const mrNumber = text(data.mrNumber) || await sequenceNext(client, 'MR', 'materialRequest', 'material_requests', 'mr_number');
    const duplicate = await client.query('SELECT 1 FROM material_requests WHERE mr_number=$1 FOR UPDATE', [mrNumber]);
    if (duplicate.rowCount) throw conflict(`Material Request ${mrNumber} already exists.`);
    await client.query(
      `INSERT INTO material_requests (mr_number,mr_date,department,requested_by,status,job_card_number,sales_order_ref,
        project_id,project_name,customer,remarks,created_by,updated_by,version,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,1,$13::jsonb)`,
      [mrNumber, data.date || data.mrDate || today(), text(data.department, req.user?.department || 'Production'),
        text(data.requestedBy, req.user?.name || req.user?.email || 'User'), text(data.status, 'Submitted'),
        data.jobCardNumber || null, data.salesOrderRef || null, data.projectId || null, data.projectName || null,
        data.customer || null, text(data.remarks), req.user?.email || 'System', JSON.stringify(data)]
    );
    await insertRequestItems(client, mrNumber, items);
    await auditIssue(client, req, mrNumber, 'MATERIAL_REQUEST_CREATED', null, data, 'Created through PostgreSQL API');
    await client.query('COMMIT');
    res.status(201).json({ record: await requestView(client, (await getPool().query('SELECT * FROM material_requests WHERE mr_number=$1', [mrNumber])).rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.put('/requests/:mrNumber', requirePermission('material_request.edit'), async (req, res) => {
  const mrNumber = req.params.mrNumber;
  const data = req.body?.data || req.body || {};
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) throw badRequest('The current PostgreSQL version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM material_requests WHERE mr_number=$1 AND deleted_at IS NULL FOR UPDATE', [mrNumber]);
    if (!current.rowCount) throw notFound(`Material Request ${mrNumber} not found.`);
    if (Number(current.rows[0].version) !== version) throw conflict('Material Request changed on the server. Reload before editing.', await requestView(client, current.rows[0]));
    if (closedStatuses.has(String(current.rows[0].status))) throw conflict(`Material Request ${mrNumber} is ${current.rows[0].status} and cannot be edited.`);
    const payload = { ...(current.rows[0].payload || {}), ...data, mrNumber };
    const saved = await client.query(
      `UPDATE material_requests SET mr_date=$2,department=$3,status=$4,job_card_number=$5,sales_order_ref=$6,
        project_id=$7,project_name=$8,customer=$9,remarks=$10,updated_by=$11,version=version+1,payload=$12::jsonb
       WHERE mr_number=$1 RETURNING *`,
      [mrNumber, data.date || data.mrDate || current.rows[0].mr_date, data.department || current.rows[0].department,
        data.status || current.rows[0].status, data.jobCardNumber || current.rows[0].job_card_number,
        data.salesOrderRef || current.rows[0].sales_order_ref, data.projectId || current.rows[0].project_id,
        data.projectName || current.rows[0].project_name, data.customer || current.rows[0].customer,
        data.remarks ?? current.rows[0].remarks, req.user?.email || 'System', JSON.stringify(payload)]
    );
    if (Array.isArray(data.items)) {
      await client.query('DELETE FROM material_request_items WHERE mr_number=$1', [mrNumber]);
      await insertRequestItems(client, mrNumber, data.items);
    }
    await auditIssue(client, req, mrNumber, 'MATERIAL_REQUEST_UPDATED', current.rows[0], saved.rows[0], text(req.body?.reason));
    await client.query('COMMIT');
    res.json({ record: await requestView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

/** Authoritative soft delete. Linked issue history is retained, never rewritten. */
router.delete('/requests/:mrNumber', requireAdmin, async (req, res) => {
  const mrNumber = req.params.mrNumber;
  const version = Number(req.body?.version);
  const reason = text(req.body?.reason);
  if (!Number.isInteger(version) || version < 1) throw badRequest('The current PostgreSQL version is required.');
  if (!reason) throw badRequest('A deletion reason is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM material_requests WHERE mr_number=$1 AND deleted_at IS NULL FOR UPDATE', [mrNumber]);
    if (!current.rowCount) throw notFound(`Material Request ${mrNumber} not found.`);
    if (Number(current.rows[0].version) !== version) throw conflict('Material Request changed on the server. Reload before deleting.', await requestView(client, current.rows[0]));
    if (!editableStatuses.has(String(current.rows[0].status))) throw conflict(`Material Request ${mrNumber} cannot be deleted in status ${current.rows[0].status}.`);
    const items = await requestItems(client, mrNumber);
    if (items.some((item) => num(item.issued_qty) > 0)) throw conflict('Material has already been issued against this request.');
    const issue = await client.query('SELECT 1 FROM store_issues WHERE mr_number=$1 AND deleted_at IS NULL LIMIT 1', [mrNumber]);
    if (issue.rowCount) throw conflict('A Store Issue references this Material Request.');
    const payload = { ...(current.rows[0].payload || {}), deletedBy: req.user?.email || '', deletedAt: new Date().toISOString() };
    const deleted = await client.query(
      `UPDATE material_requests SET deleted_at=now(),deleted_by=$2,delete_reason=$3,version=version+1,updated_at=now(),payload=$4::jsonb
        WHERE mr_number=$1 RETURNING *`,
      [mrNumber, req.user?.email || 'System', reason, JSON.stringify(payload)]
    );
    await auditIssue(client, req, mrNumber, 'MATERIAL_REQUEST_DELETED', current.rows[0], deleted.rows[0], reason);
    await client.query('COMMIT');
    res.json({ record: await requestView(client, deleted.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const transitionRequest = (target, action) => async (req, res) => {
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) throw badRequest('The current PostgreSQL version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM material_requests WHERE mr_number=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.mrNumber]);
    if (!current.rowCount) throw notFound('Material Request not found.');
    if (Number(current.rows[0].version) !== version) throw conflict('Material Request changed on the server. Reload before retrying.');
    if (closedStatuses.has(String(current.rows[0].status))) throw conflict(`Material Request ${current.rows[0].status} cannot be ${action}.`);
    const payload = { ...(current.rows[0].payload || {}), status: target, decisionReason: text(req.body?.reason), decidedBy: req.user?.email || '', decidedAt: new Date().toISOString() };
    const saved = await client.query(
      'UPDATE material_requests SET status=$2,payload=$3::jsonb,version=version+1,updated_by=$4,updated_at=now() WHERE mr_number=$1 RETURNING *',
      [req.params.mrNumber, target, JSON.stringify(payload), req.user?.email || 'System']
    );
    await auditIssue(client, req, req.params.mrNumber, action, current.rows[0], saved.rows[0], text(req.body?.reason));
    await client.query('COMMIT');
    res.json({ record: await requestView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};
router.post('/requests/:mrNumber/submit', requirePermission('material_request.edit'), transitionRequest('Submitted', 'MATERIAL_REQUEST_SUBMITTED'));
router.post('/requests/:mrNumber/approve', requirePermission('material_request.edit'), transitionRequest('Approved', 'MATERIAL_REQUEST_APPROVED'));
router.post('/requests/:mrNumber/reject', requirePermission('material_request.edit'), transitionRequest('Rejected', 'MATERIAL_REQUEST_REJECTED'));

const selectBatch = async (client, materialId, requested, batchInfo) => {
  const batches = (await client.query(
    `SELECT * FROM inventory_batches WHERE item_code=$1 AND available_qty>0 ORDER BY expiry_date NULLS LAST,batch_number`,
    [materialId]
  )).rows;
  const explicit = text(batchInfo?.receiptBatchId);
  const supplierBatch = text(batchInfo?.batchNo);
  let selected = null;
  if (explicit) {
    selected = batches.find((row) => row.id === explicit);
    if (!selected) throw badRequest(`Selected receipt batch is unavailable for material ${materialId}.`);
  } else if (supplierBatch) {
    const matches = batches.filter((row) =>
      row.batch_number === supplierBatch || text(row.payload?.supplierBatchNumber) === supplierBatch);
    if (matches.length > 1) throw badRequest(`Supplier batch ${supplierBatch} is ambiguous for material ${materialId}. Select its receipt batch ID.`);
    selected = matches[0] || null;
  } else if (batches.length === 1) selected = batches[0];
  else if (batches.length > 1) throw badRequest(`Select the receipt batch for material ${materialId} before issuing stock.`);
  if (selected && num(selected.available_qty) < requested) {
    throw badRequest(`Selected batch ${selected.batch_number} has only ${selected.available_qty} available; issue a smaller quantity.`);
  }
  return selected;
};

router.post('/issue', requirePermission('material_issue.confirm'), async (req, res) => {
  const body = req.body || {};
  const mrNumber = text(body.mrNumber);
  if (!mrNumber) throw badRequest('Material Request number is required.');
  const receiver = body.receiver || {};
  if (!text(receiver.name) || !text(receiver.employeeId)) throw badRequest('Receiver employee name and employee ID are required.');
  if (!receiver.acknowledged) throw badRequest('Employee acknowledgement is required before issuing.');
  const issueQtyById = body.issueQtyById || {};
  const batchInfo = body.batchInfo || {};
  const issueRefs = body.issueRefs || {};
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const mrResult = await client.query('SELECT * FROM material_requests WHERE mr_number=$1 AND deleted_at IS NULL FOR UPDATE', [mrNumber]);
    if (!mrResult.rowCount) throw notFound(`Material Request ${mrNumber} not found.`);
    const mr = mrResult.rows[0];
    if (!issuableStatuses.has(String(mr.status))) throw conflict(`Cannot issue material: request status is ${mr.status}.`);
    const mrItems = await requestItems(client, mrNumber);
    if (!mrItems.length) throw badRequest('Material Request has no item lines.');

    const jobCardNumber = text(issueRefs.jobCardNumber) || text(mr.job_card_number);
    if (jobCardNumber && jobCardNumber !== text(mr.job_card_number)) {
      const entered = await client.query('SELECT project_id FROM job_cards WHERE job_card_number=$1', [jobCardNumber]);
      if (entered.rowCount && text(mr.project_id) && text(entered.rows[0].project_id) &&
          text(mr.project_id).toUpperCase() !== text(entered.rows[0].project_id).toUpperCase()) {
        throw badRequest(`Cross-project linkage blocked: Job Card ${jobCardNumber} belongs to project ${entered.rows[0].project_id}, but Material Request ${mrNumber} belongs to ${mr.project_id}.`);
      }
    }

    const issueNumber = text(body.issueNumber) || await sequenceNext(client, 'SI', 'storeIssue', 'store_issues', 'issue_number');
    const existingIssueResult = await client.query('SELECT * FROM store_issues WHERE issue_number=$1 FOR UPDATE', [issueNumber]);
    const existingIssue = existingIssueResult.rows[0];

    const prepared = [];
    for (const [index, mrItem] of mrItems.entries()) {
      const materialId = text(mrItem.material_id);
      const requested = num(issueQtyById[materialId]);
      if (requested <= 0) continue;
      const balance = Math.max(0, num(mrItem.required_qty) - num(mrItem.issued_qty));
      const inventory = await client.query('SELECT * FROM inventory_items WHERE item_code=$1 AND deleted_at IS NULL FOR UPDATE', [materialId]);
      const available = num(inventory.rows[0]?.current_qty);
      if (requested > balance || requested > available) {
        throw badRequest(`Issue exceeds the permitted limit for "${mrItem.material_name || materialId}": available ${available}, remaining to be issued ${balance}, but ${requested} was entered.`);
      }
      if (inventory.rows[0]?.shelf_life_managed) {
        const nearest = (await client.query(
          `SELECT * FROM inventory_batches WHERE item_code=$1 AND available_qty>0 AND expiry_date IS NOT NULL
            ORDER BY expiry_date LIMIT 1`,
          [materialId]
        )).rows[0];
        if (nearest && dateText(nearest.expiry_date) < today()) {
          throw conflict(`FEFO blocked for "${mrItem.material_name || materialId}": batch ${nearest.batch_number} expired on ${nearest.expiry_date}. Write it off before issuing.`);
        }
      }
      const selected = await selectBatch(client, materialId, requested, batchInfo[materialId]);
      const batchNo = text(batchInfo[materialId]?.batchNo) || text(selected?.batch_number) || text(mrItem.payload?.batchNo);
      const lotNumber = text(batchInfo[materialId]?.lotNumber) || text(selected?.payload?.lotNumber);
      const line = {
        lineNumber: index + 1,
        materialId,
        materialName: text(mrItem.material_name),
        unit: text(mrItem.payload?.unit || inventory.rows[0]?.unit, 'Nos'),
        requestedQty: num(mrItem.required_qty),
        previouslyIssued: num(mrItem.issued_qty),
        currentIssueQty: requested,
        totalIssued: num(mrItem.issued_qty) + requested,
        remainingQty: Math.max(0, balance - requested),
        batchNo,
        receiptBatchId: selected?.id || '',
        batchId: selected?.id || '',
        lotNumber,
        heatNumber: text(batchInfo[materialId]?.heatNumber),
        serialNumber: text(batchInfo[materialId]?.serialNumber)
      };
      prepared.push(line);
    }
    if (!prepared.length) throw badRequest('Enter an issue quantity for at least one material.');

    const fingerprint = JSON.stringify({
      mrNumber,
      receiver: { name: receiver.name, employeeId: receiver.employeeId },
      lines: prepared.map((line) => ({ materialId: line.materialId, quantity: line.currentIssueQty }))
    });
    if (existingIssue) {
      const token = text(body.createToken);
      const previousToken = text(existingIssue.payload?.createToken);
      if (token && previousToken && token !== previousToken) throw conflict(`Store Issue ${issueNumber} already exists for a different request.`);
      if (text(existingIssue.payload?.fingerprint) !== fingerprint) throw conflict(`Store Issue ${issueNumber} already exists for a different request.`);
      await client.query('COMMIT');
      return res.json({ duplicate: true, record: await issueView(client, existingIssue), stockMovements: [] });
    }

    for (const line of prepared) {
      await postStockMovement(client, req, {
        ledgerId: `issue-${issueNumber}-${line.lineNumber}`,
        itemCode: line.materialId,
        materialName: line.materialName,
        movementType: 'OUT',
        quantity: line.currentIssueQty,
        unit: line.unit,
        entryDate: text(body.issueDate) || today(),
        sourceDocType: 'Store Issue',
        sourceDocRef: issueNumber,
        batchNo: line.batchNo,
        batchId: line.batchId,
        lotNumber: line.lotNumber,
        reason: `Store Issue against ${mrNumber}`,
        payload: { ...line, mrNumber, jobCardNumber, receiver }
      });
    }

    const payload = {
      issueNumber,
      fingerprint,
      createToken: text(body.createToken),
      issueDate: text(body.issueDate) || today(),
      mrNumber,
      jobCardNumber,
      poNumber: text(issueRefs.poNumber),
      customer: text(issueRefs.customer) || text(mr.customer),
      salesOrderRef: text(mr.sales_order_ref),
      projectId: text(mr.project_id),
      receiver,
      remarks: text(body.remarks),
      items: prepared,
      issuedBy: req.user?.name || req.user?.email || 'Store'
    };
    await client.query(
      `INSERT INTO store_issues (issue_number,issue_date,mr_number,job_card_number,sales_order_ref,project_id,
        receiver_name,receiver_employee_id,acknowledged,issued_by,issued_by_dept,remarks,status,version,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Issued',1,$13::jsonb)`,
      [issueNumber, payload.issueDate, mrNumber, jobCardNumber || null, payload.salesOrderRef || null,
        payload.projectId || null, receiver.name, receiver.employeeId, true, payload.issuedBy,
        text(req.user?.department, 'Store Department'), payload.remarks, JSON.stringify(payload)]
    );
    for (const line of prepared) {
      await client.query(
        `INSERT INTO store_issue_items (issue_number,line_number,material_id,material_name,quantity,unit,batch_no,lot_number,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [issueNumber, line.lineNumber, line.materialId, line.materialName, line.currentIssueQty, line.unit,
          line.batchNo, line.lotNumber, JSON.stringify(line)]
      );
    }

    let fullyIssued = true;
    let anyIssued = false;
    for (const mrItem of mrItems) {
      const issued = num(mrItem.issued_qty) + num(prepared.find((line) => line.materialId === mrItem.material_id)?.currentIssueQty || 0);
      await client.query('UPDATE material_request_items SET issued_qty=$1 WHERE id=$2', [issued, mrItem.id]);
      if (issued < num(mrItem.required_qty)) fullyIssued = false;
      if (issued > 0) anyIssued = true;
    }
    const status = fullyIssued ? 'Fully Issued' : anyIssued ? 'Partially Issued' : mr.status;
    await client.query('UPDATE material_requests SET status=$1,version=version+1,updated_at=now(),updated_by=$2 WHERE mr_number=$3', [status, req.user?.email || 'System', mrNumber]);
    if (jobCardNumber) {
      const jobCard = await client.query(
        'SELECT job_card_number,payload,version FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE',
        [jobCardNumber]
      );
      if (!jobCard.rowCount) throw conflict(`Linked Job Card ${jobCardNumber} does not exist in PostgreSQL.`);
      const payload = { ...(jobCard.rows[0].payload || {}),
        materialStatus: status,
        lastMaterialUpdate: new Date().toISOString()
      };
      await client.query(
        `UPDATE job_cards SET payload=$2::jsonb,version=version+1,updated_at=now(),updated_by=$3
         WHERE job_card_number=$1`,
        [jobCardNumber, JSON.stringify(payload), req.user?.email || 'System']
      );
      await auditIssue(client, req, jobCardNumber, 'JOB_CARD_MATERIAL_STATUS', null, payload,
        `Material status ${status} after Store Issue ${issueNumber}`);
    }
    await auditIssue(client, req, issueNumber, 'MATERIAL_ISSUE', null, payload, `Issued ${prepared.length} line(s) against ${mrNumber}`);
    await client.query('COMMIT');
    res.status(201).json({ success: true, issueNumber, record: payload, stockMovements: prepared.map((line) => ({ itemCode: line.materialId, quantity: line.currentIssueQty })) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const issueView = async (client, row) => {
  const items = (await client.query('SELECT * FROM store_issue_items WHERE issue_number=$1 ORDER BY line_number', [row.issue_number])).rows;
  return { ...(row.payload || {}), ...row, issueNumber: row.issue_number, recordVersion: Number(row.version), items };
};

router.get('/issues', async (_req, res) => {
  const client = await getPool().connect();
  try {
    const rows = (await client.query('SELECT * FROM store_issues WHERE deleted_at IS NULL ORDER BY issue_date DESC,created_at DESC')).rows;
    const records = [];
    for (const row of rows) records.push(await issueView(client, row));
    res.json({ records });
  } finally { client.release(); }
});

router.get('/issues/:issueNumber', async (req, res) => {
  const client = await getPool().connect();
  try {
    const row = (await client.query('SELECT * FROM store_issues WHERE issue_number=$1 AND deleted_at IS NULL', [req.params.issueNumber])).rows[0];
    if (!row) throw notFound('Store Issue not found.');
    res.json({ record: await issueView(client, row) });
  } finally { client.release(); }
});

router.post('/issues/:issueNumber/acknowledge', requirePermission('material_issue.confirm'), async (req, res) => {
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) throw badRequest('The current PostgreSQL version is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM store_issues WHERE issue_number=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.issueNumber]);
    if (!current.rowCount) throw notFound('Store Issue not found.');
    if (Number(current.rows[0].version) !== version) throw conflict('Store Issue changed on the server. Reload before acknowledging.');
    const payload = { ...(current.rows[0].payload || {}), acknowledged: true, acknowledgedAt: new Date().toISOString(), acknowledgedBy: req.user?.email || '' };
    const saved = await client.query('UPDATE store_issues SET acknowledged=true,payload=$2::jsonb,version=version+1,updated_by=$3 WHERE issue_number=$1 RETURNING *', [req.params.issueNumber, JSON.stringify(payload), req.user?.email || 'System']);
    await auditIssue(client, req, req.params.issueNumber, 'ACKNOWLEDGED', current.rows[0], saved.rows[0], text(req.body?.remarks));
    await client.query('COMMIT');
    res.json({ record: await issueView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/issues/:issueNumber/cancel', requireAdmin, async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM store_issues WHERE issue_number=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.issueNumber]);
    if (!current.rowCount) throw notFound('Store Issue not found.');
    if (!text(req.body?.reason)) throw badRequest('Cancellation reason is required.');
    const payload = { ...(current.rows[0].payload || {}), status: 'Cancelled', reason: text(req.body.reason) };
    const saved = await client.query('UPDATE store_issues SET status=$2,payload=$3::jsonb,version=version+1,updated_by=$4 WHERE issue_number=$1 RETURNING *', [req.params.issueNumber, 'Cancelled', JSON.stringify(payload), req.user?.email || 'System']);
    await auditIssue(client, req, req.params.issueNumber, 'CANCELLED', current.rows[0], saved.rows[0], text(req.body.reason));
    await client.query('COMMIT');
    res.json({ record: await issueView(client, saved.rows[0]) });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/returns', requirePermission('material_return.create'), async (req, res) => {
  const body = req.body || {};
  const issueNumber = text(body.issueNumber);
  const receiver = body.receiver || {};
  if (!text(receiver.name) || !receiver.acknowledged) throw badRequest('Return acknowledgement by the employee is required.');
  const returnItems = Array.isArray(body.returnItems || body.items) ? (body.returnItems || body.items) : [];
  if (!returnItems.length) throw badRequest('At least one return line is required.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const issue = (await client.query('SELECT * FROM store_issues WHERE issue_number=$1 AND deleted_at IS NULL FOR UPDATE', [issueNumber])).rows[0];
    if (!issue) throw notFound('Store Issue not found.');
    const issuedLines = (await client.query('SELECT * FROM store_issue_items WHERE issue_number=$1', [issueNumber])).rows;
    const priorReturns = await client.query(
      `SELECT ri.material_id, COALESCE(sum(ri.quantity),0) AS returned
        FROM store_return_items ri JOIN store_returns r ON r.return_number=ri.return_number
        WHERE r.issue_number=$1 AND r.deleted_at IS NULL GROUP BY ri.material_id`,
      [issueNumber]
    );
    const alreadyReturned = new Map(priorReturns.rows.map((row) => [row.material_id, num(row.returned)]));
    const prepared = [];
    for (const line of returnItems) {
      const materialId = text(line.materialId || line.itemCode);
      const quantity = num(line.quantity ?? line.quantityReturned);
      if (quantity <= 0) continue;
      const issuedLine = issuedLines.find((row) => row.material_id === materialId);
      if (!issuedLine) throw badRequest(`Material "${line.materialName || materialId}" was not part of Store Issue ${issueNumber}.`);
      const maxReturnable = Math.max(0, num(issuedLine.quantity) - (alreadyReturned.get(materialId) || 0));
      if (quantity > maxReturnable) throw badRequest(`Cannot return ${quantity} of "${issuedLine.material_name || materialId}" — only ${maxReturnable} can be returned.`);
      prepared.push({
        materialId,
        materialName: text(line.materialName || issuedLine.material_name),
        quantity,
        quantityReturned: quantity,
        unit: text(line.unit || issuedLine.unit, 'Nos'),
        batchNo: text(line.batchNo || issuedLine.batch_no),
        batchId: text(line.batchId || issuedLine.payload?.batchId || issuedLine.payload?.receiptBatchId),
        lotNumber: text(line.lotNumber || issuedLine.lot_number),
        reason: text(line.reason || line.returnReason)
      });
    }
    if (!prepared.length) throw badRequest('Enter a return quantity for at least one material.');

    const returnNumber = text(body.returnNumber) || await sequenceNext(client, 'SR', 'storeReturn', 'store_returns', 'return_number');
    const existingReturnResult = await client.query('SELECT * FROM store_returns WHERE return_number=$1 FOR UPDATE', [returnNumber]);
    const existingReturn = existingReturnResult.rows[0];
    const fingerprint = JSON.stringify({
      issueNumber,
      returnedBy: { name: receiver.name, employeeId: receiver.employeeId },
      lines: prepared.map((line) => ({ materialId: line.materialId, quantity: line.quantity }))
    });
    if (existingReturn) {
      const token = text(body.createToken);
      const previousToken = text(existingReturn.payload?.createToken);
      if (token && previousToken && token !== previousToken) throw conflict(`Store Return ${returnNumber} already exists for a different request.`);
      if (text(existingReturn.payload?.fingerprint) !== fingerprint) throw conflict(`Store Return ${returnNumber} already exists for a different request.`);
      await client.query('COMMIT');
      return res.json({ duplicate: true, returnNumber, record: existingReturn.payload, stockMovements: [] });
    }
    const payload = {
      returnNumber, fingerprint, createToken: text(body.createToken),
      returnDate: text(body.returnDate) || today(), issueNumber, mrNumber: text(issue.mr_number),
      returnedBy: receiver.name, returnedById: receiver.employeeId, receivedBy: text(body.receivedBy, req.user?.name || req.user?.email || 'Store'),
      reason: text(body.reason), acknowledged: true, items: prepared
    };
    await client.query(
      `INSERT INTO store_returns (return_number,return_date,issue_number,mr_number,returned_by,returned_by_id,received_by,reason,status,version,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Received',1,$9::jsonb)`,
      [returnNumber, payload.returnDate, issueNumber, issue.mr_number || null, receiver.name,
        text(receiver.employeeId), payload.receivedBy, payload.reason, JSON.stringify(payload)]
    );
    for (const [index, line] of prepared.entries()) {
      await client.query(
        `INSERT INTO store_return_items (return_number,line_number,material_id,material_name,quantity,unit,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [returnNumber, index + 1, line.materialId, line.materialName, line.quantity, line.unit, JSON.stringify(line)]
      );
      await postStockMovement(client, req, {
        ledgerId: `return-${returnNumber}-${index + 1}`,
        itemCode: line.materialId,
        materialName: line.materialName,
        movementType: 'RETURN',
        quantity: line.quantity,
        unit: line.unit,
        entryDate: payload.returnDate,
        sourceDocType: 'Store Return',
        sourceDocRef: returnNumber,
        batchNo: line.batchNo,
        batchId: line.batchId,
        lotNumber: line.lotNumber,
        reason: payload.reason || 'Store Return',
        payload: { ...line, issueNumber, mrNumber: issue.mr_number }
      });
    }
    await auditIssue(client, req, issueNumber, 'MATERIAL_RETURNED', null, payload, `Return ${returnNumber}`);
    await client.query('COMMIT');
    res.status(201).json({ success: true, returnNumber, record: payload });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/returns', async (_req, res) => {
  const result = await getPool().query('SELECT * FROM store_returns WHERE deleted_at IS NULL ORDER BY return_date DESC,created_at DESC');
  res.json({ records: result.rows.map((row) => ({ ...(row.payload || {}), ...row, returnNumber: row.return_number })) });
});

router.get('/audit', async (req, res) => {
  const issueNumber = text(req.query.issueNumber);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 500));
  const result = await getPool().query(
    `SELECT id::text AS id,created_at,actor_email AS email,actor_role AS role,action,
            issue_number AS record_id,reason,before_values,after_values,'storeIssues' AS module
       FROM material_issue_audit
      WHERE ($1='' OR issue_number=$1)
     UNION ALL
     SELECT id::text AS id,created_at,email,role,action,record_id,reason,before_values,after_values,module
       FROM erp_audit_log
      WHERE module IN ('inventoryItems','stockTransfers','stockVerifications','storeClientEvents')
        AND ($1='' OR record_id=$1)
     ORDER BY created_at DESC LIMIT $2`,
    [issueNumber, limit]
  );
  res.json({
    records: result.rows.map((row) => {
      const after = row.after_values && typeof row.after_values === 'object' ? row.after_values : {};
      const timestamp = new Date(row.created_at);
      return {
        id: row.id,
        timestamp: row.created_at,
        date: timestamp.toLocaleDateString('en-IN'),
        time: timestamp.toLocaleTimeString('en-IN'),
        user: row.email || 'System',
        employeeId: '',
        department: row.module,
        action: after.clientAction ? `Client-reported: ${after.clientAction}` : row.action,
        reference: row.record_id,
        details: after.clientDetails || row.reason || JSON.stringify(after) || '',
        role: row.role,
        before: row.before_values,
        after
      };
    })
  });
});

router.post('/audit', async (req, res) => {
  const action = text(req.body?.action);
  const reference = text(req.body?.reference);
  const details = text(req.body?.details);
  if (!action) throw badRequest('Audit action is required.');
  const client = await getPool().connect();
  try {
    const saved = await client.query(
      `INSERT INTO erp_audit_log
       (user_id,email,role,module,record_id,record_label,action,reason,after_values)
       VALUES($1,$2,$3,'storeClientEvents',$4,$5,'CLIENT_REPORTED',$6,$7::jsonb)
       RETURNING id,created_at,email,role,module,record_id,action,reason,after_values`,
      [req.user?.id || '', req.user?.email || '', req.user?.role || req.user?.roleKey || '',
        reference || `client-event-${Date.now()}`, reference, details,
        JSON.stringify(safeAuditValues({ clientAction: action, clientDetails: details }))]
    );
    res.status(201).json({ record: saved.rows[0] });
  } finally { client.release(); }
});

router.get('/migration-preview', requireAdmin, async (_req, res) => {
  const [activeRequests, activeIssues, legacy] = await Promise.all([
    getPool().query('SELECT mr_number,payload FROM material_requests'),
    getPool().query('SELECT issue_number,payload FROM store_issues'),
    getPool().query("SELECT storage_key,data FROM erp_state WHERE storage_key IN ('materialRequests','storeIssueHistory','materialReturnHistory')")
  ]);
  const requestNumbers = new Set(activeRequests.rows.map((row) => row.mr_number));
  const issueNumbers = new Set(activeIssues.rows.map((row) => row.issue_number));
  const eligible = [];
  const identical = [];
  const conflicting = [];
  for (const row of legacy.rows) {
    for (const item of Array.isArray(row.data) ? row.data : []) {
      const number = text(item.mrNumber || item.issueNumber || item.returnNumber || item.id);
      if (!number) continue;
      const activeSet = row.storage_key === 'materialRequests' ? requestNumbers : issueNumbers;
      const payload = { ...item, storageKey: row.storage_key };
      if (!activeSet.has(number)) eligible.push(payload);
      else identical.push(payload);
    }
  }
  res.json({ eligible, identical, conflicting, invalid: [] });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length) throw badRequest('Select at least one legacy record to import.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const imported = [];
    for (const item of records) {
      const mrNumber = text(item.mrNumber || item.id);
      if (!mrNumber || item.storageKey !== 'materialRequests') continue;
      const exists = await client.query('SELECT 1 FROM material_requests WHERE mr_number=$1 FOR UPDATE', [mrNumber]);
      if (exists.rowCount) continue;
      await client.query(
        `INSERT INTO material_requests (mr_number,mr_date,department,requested_by,status,job_card_number,sales_order_ref,
          project_id,project_name,customer,remarks,created_by,updated_by,version,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Migration','Migration',1,$12::jsonb)`,
        [mrNumber, item.date || item.mrDate || today(), text(item.department, 'Production'),
          text(item.requestedBy, 'Legacy User'), text(item.status, 'Draft'), item.jobCardNumber || null,
          item.salesOrderRef || null, item.projectId || null, item.projectName || null, item.customer || null,
          text(item.remarks), JSON.stringify(item)]
      );
      await insertRequestItems(client, mrNumber, Array.isArray(item.items) ? item.items : []);
      await auditIssue(client, req, mrNumber, 'MIGRATION_IMPORT', null, item, 'Explicit Admin import');
      imported.push(mrNumber);
    }
    await client.query('COMMIT');
    res.json({ imported, count: imported.length });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

export default router;
