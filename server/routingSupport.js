// Operation-routing helpers shared by the /api/routing router and the Job Card
// completion validator in productionRoutes.js.

import {
  bad, conflict, notFound, text, num, dateOnly, readVersion, assertVersion,
  writeAudit, historyEntry
} from './productionSupport.js';

const OPERATION_STATUSES = new Set(['Pending', 'In Progress', 'Completed', 'Sent to Vendor', 'Received', 'Failed / Rework']);

export const viewOperation = (row) => ({
  id: Number(row.id),
  jobCardNumber: row.job_card_number,
  sequenceNumber: Number(row.sequence_number),
  operationName: row.operation_name,
  machineName: row.machine_name || '',
  machineId: String((row.payload || {}).machineId || ''),
  operatorName: row.operator_name || '',
  operatorId: String((row.payload || {}).operatorId || ''),
  plannedHours: Number(row.planned_hours),
  actualHours: Number(row.actual_hours),
  status: row.status,
  startedAt: row.started_at?.toISOString?.() || row.started_at || null,
  completedAt: row.completed_at?.toISOString?.() || row.completed_at || null,
  ...(row.payload || {})
});

export const normalizeOperation = (raw, sequence) => {
  const operation = raw || {};
  const operationName = text(operation.operationName || operation.process);
  if (!operationName) throw bad('An operation name is required.');
  const status = text(operation.status, 'Pending');
  if (!OPERATION_STATUSES.has(status)) throw bad(`Unsupported operation status "${status}".`);
  const plannedHours = num(operation.plannedHours ?? operation.planned_hours, 0);
  const actualHours = num(operation.actualHours ?? operation.actual_hours, 0);
  if (plannedHours < 0 || actualHours < 0) throw bad('Operation hours cannot be negative.');
  return {
    sequenceNumber: Number.isInteger(Number(operation.sequenceNumber)) && Number(operation.sequenceNumber) > 0 ? Number(operation.sequenceNumber) : sequence,
    operationName,
    machineName: text(operation.machineName || operation.machine),
    operatorName: text(operation.operatorName || operation.operator),
    plannedHours,
    actualHours,
    status,
    startedAt: operation.startedAt || (status === 'Pending' ? null : new Date().toISOString()),
    completedAt: status === 'Completed' ? (operation.completedAt || new Date().toISOString()) : (operation.completedAt || null),
    payload: {
      ...operation,
      machineId: text(operation.machineId),
      operatorId: text(operation.operatorId || operation.inspectorId),
      inspectorId: text(operation.inspectorId),
      inspector: text(operation.inspector),
      plannedQty: num(operation.plannedQty ?? operation.inputQty, 0),
      outputQty: num(operation.outputQty, 0),
      reworkQty: num(operation.reworkQty, 0),
      rejectQty: num(operation.rejectQty, 0),
      required: operation.required !== false
    }
  };
};

const insertOperation = async (client, jobCardNumber, operation) => client.query(
  `INSERT INTO job_card_operations(job_card_number,sequence_number,operation_name,machine_name,operator_name,planned_hours,actual_hours,status,started_at,completed_at,payload)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
  [jobCardNumber, operation.sequenceNumber, operation.operationName, operation.machineName,
    operation.operatorName, operation.plannedHours, operation.actualHours, operation.status,
    operation.startedAt, operation.completedAt, JSON.stringify(operation.payload)]
);

const touchJobCard = async (client, jobCardNumber, version, actor = '') => {
  const result = await client.query(
    'UPDATE job_cards SET version=version+1,updated_at=now(),updated_by=$3 WHERE job_card_number=$1 AND version=$2 RETURNING version',
    [jobCardNumber, version, String(actor || '')]
  );
  if (!result.rowCount) throw conflict('Job Card changed on the server. Reload before continuing.');
  return Number(result.rows[0].version);
};

export const addOperation = async (client, req, jobCardNumber, raw, version, { bumpVersion = true } = {}) => {
  const card = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [jobCardNumber]);
  if (!card.rowCount) throw notFound('Job Card not found.');
  assertVersion(card.rows[0], version, 'Job Card');
  const existing = await client.query('SELECT COALESCE(MAX(sequence_number),0) AS next FROM job_card_operations WHERE job_card_number=$1', [jobCardNumber]);
  const operation = normalizeOperation(raw, Number(existing.rows[0].next) + 1);
  const inserted = await insertOperation(client, jobCardNumber, operation);
  if (bumpVersion) await touchJobCard(client, jobCardNumber, version, req.user?.email);
  await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: jobCardNumber, action: 'OPERATION_ADDED', after: viewOperation(inserted.rows[0]), module: 'job_cards' });
  return viewOperation(inserted.rows[0]);
};

export const updateOperation = async (client, req, operationId, patch, version) => {
  const current = await client.query('SELECT * FROM job_card_operations WHERE id=$1 FOR UPDATE', [operationId]);
  if (!current.rowCount) throw notFound('Operation not found.');
  const jobCardNumber = current.rows[0].job_card_number;
  const card = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [jobCardNumber]);
  if (!card.rowCount) throw notFound('Job Card not found.');
  assertVersion(card.rows[0], version, 'Job Card');
  const merged = { ...(current.rows[0].payload || {}), ...(patch || {}) };
  const operation = normalizeOperation({
    ...merged,
    operationName: patch?.operationName ?? current.rows[0].operation_name,
    status: patch?.status ?? current.rows[0].status,
    machineName: patch?.machineName ?? current.rows[0].machine_name,
    operatorName: patch?.operatorName ?? current.rows[0].operator_name,
    plannedHours: patch?.plannedHours ?? current.rows[0].planned_hours,
    actualHours: patch?.actualHours ?? current.rows[0].actual_hours,
    sequenceNumber: patch?.sequenceNumber ?? current.rows[0].sequence_number
  }, Number(current.rows[0].sequence_number));
  const saved = await client.query(
    `UPDATE job_card_operations SET sequence_number=$2,operation_name=$3,machine_name=$4,operator_name=$5,planned_hours=$6,actual_hours=$7,status=$8,started_at=$9,completed_at=$10,payload=$11::jsonb WHERE id=$1 RETURNING *`,
    [operationId, operation.sequenceNumber, operation.operationName, operation.machineName, operation.operatorName,
      operation.plannedHours, operation.actualHours, operation.status, operation.startedAt, operation.completedAt, JSON.stringify(operation.payload)]
  );
  await touchJobCard(client, jobCardNumber, version, req.user?.email);
  await writeAudit(client, req, {
    table: 'job_card_audit', idColumn: 'job_card_number', id: jobCardNumber, action: 'OPERATION_UPDATED',
    before: viewOperation(current.rows[0]), after: viewOperation(saved.rows[0]), module: 'job_cards'
  });
  return viewOperation(saved.rows[0]);
};

export const deleteOperation = async (client, req, operationId, version) => {
  const current = await client.query('SELECT * FROM job_card_operations WHERE id=$1 FOR UPDATE', [operationId]);
  if (!current.rowCount) throw notFound('Operation not found.');
  const jobCardNumber = current.rows[0].job_card_number;
  const entries = await client.query('SELECT 1 FROM production_operation_entries WHERE operation_id=$1 LIMIT 1', [operationId]);
  if (entries.rowCount) throw conflict('An operation with production entries cannot be deleted; cancel or reverse the entries first.');
  const card = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [jobCardNumber]);
  if (!card.rowCount) throw notFound('Job Card not found.');
  assertVersion(card.rows[0], version, 'Job Card');
  await client.query('DELETE FROM job_card_operations WHERE id=$1', [operationId]);
  await touchJobCard(client, jobCardNumber, version, req.user?.email);
  await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: jobCardNumber, action: 'OPERATION_DELETED', before: viewOperation(current.rows[0]), module: 'job_cards' });
  return { deleted: Number(operationId) };
};

export const recordEntry = async (client, req, jobCardNumber, raw, version) => {
  const cardResult = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL FOR UPDATE', [jobCardNumber]);
  if (!cardResult.rowCount) throw notFound('Job Card not found.');
  const card = cardResult.rows[0];
  assertVersion(card, version, 'Job Card');
  const entry = raw || {};
  const operationId = Number(entry.operationId);
  let operation = null;
  if (Number.isInteger(operationId) && operationId > 0) {
    const result = await client.query('SELECT * FROM job_card_operations WHERE id=$1 AND job_card_number=$2 FOR UPDATE', [operationId, jobCardNumber]);
    if (!result.rowCount) throw notFound('Operation not found on this Job Card.');
    operation = result.rows[0];
  }
  const operationName = text(entry.operationName || operation?.operation_name, 'Production');
  const plannedQty = num(entry.plannedQty ?? (operation?.payload || {}).plannedQty, 0);
  const producedQty = num(entry.producedQty ?? entry.produced_qty, 0);
  const acceptedQty = num(entry.acceptedQty ?? entry.accepted_qty, 0);
  const rejectedQty = num(entry.rejectedQty ?? entry.rejected_qty, 0);
  const reworkQty = num(entry.reworkQty ?? entry.rework_qty, 0);
  if (plannedQty < 0 || producedQty < 0 || acceptedQty < 0 || rejectedQty < 0 || reworkQty < 0) throw bad('Production quantities cannot be negative.');
  if (acceptedQty + rejectedQty > producedQty && producedQty > 0) throw bad('Accepted + rejected quantity cannot exceed produced quantity.');
  const entryDate = dateOnly(entry.entryDate, new Date().toISOString().slice(0, 10));
  const employeeId = text(entry.employeeId || entry.operatorId || (operation?.payload || {}).operatorId);
  const employeeName = text(entry.employeeName || entry.operatorName || operation?.operator_name);
  const machineId = text(entry.machineId || (operation?.payload || {}).machineId);
  const machineName = text(entry.machineName || operation?.machine_name);
  const inserted = await client.query(
    `INSERT INTO production_operation_entries(job_card_number,operation_id,sequence_number,entry_date,operation_name,planned_qty,produced_qty,accepted_qty,rejected_qty,rework_qty,employee_id,employee_name,machine_id,machine_name,remarks,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [jobCardNumber, operationId || null, operation ? Number(operation.sequence_number) : 0, entryDate, operationName,
      plannedQty, producedQty, acceptedQty, rejectedQty, reworkQty, employeeId, employeeName, machineId, machineName,
      text(entry.remarks), String(req.user?.email || '')]
  );
  // Keep the legacy production_entries projection in step for existing reports.
  await client.query(
    `INSERT INTO production_entries(job_card_number,entry_date,operation_name,produced_qty,accepted_qty,rejected_qty,rework_qty,operator_name,machine_name,remarks,employee_id,machine_id,planned_qty)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [jobCardNumber, entryDate, operationName, producedQty, acceptedQty, rejectedQty, reworkQty, employeeName, machineName,
      text(entry.remarks), employeeId, machineId, plannedQty]
  );
  const payload = {
    ...(card.payload || {}),
    producedQuantity: Number(card.produced_quantity || 0) + producedQty,
    acceptedQuantity: Number(card.accepted_quantity || 0) + acceptedQty,
    rejectedQuantity: Number(card.rejected_quantity || 0) + rejectedQty,
    history: [...((card.payload || {}).history || []), historyEntry(req, 'Production entry recorded', `${operationName}: ${producedQty} produced / ${acceptedQty} accepted`)]
  };
  await client.query(
    `UPDATE job_cards SET produced_quantity=produced_quantity+$2,accepted_quantity=accepted_quantity+$3,rejected_quantity=rejected_quantity+$4,payload=$5::jsonb,version=version+1,updated_at=now(),updated_by=$6 WHERE job_card_number=$1`,
    [jobCardNumber, producedQty, acceptedQty, rejectedQty, JSON.stringify(payload), String(req.user?.email || '')]
  );
  await writeAudit(client, req, { table: 'job_card_audit', idColumn: 'job_card_number', id: jobCardNumber, action: 'PRODUCTION_ENTRY', before: { produced: Number(card.produced_quantity), accepted: Number(card.accepted_quantity) }, after: { ...inserted.rows[0] }, module: 'job_cards' });
  return { ...inserted.rows[0] };
};

export const pendingOperations = async (client, jobCardNumber) => {
  const result = await client.query(
    'SELECT * FROM job_card_operations WHERE job_card_number=$1 AND status <> $2 AND COALESCE((payload->>\'required\')::boolean,true)=true ORDER BY sequence_number',
    [jobCardNumber, 'Completed']
  );
  return result.rows.map(viewOperation);
};

export const operationHistory = async (client, jobCardNumber, req) => client.query(
  'SELECT * FROM job_card_audit WHERE job_card_number=$1 AND action LIKE $2 ORDER BY created_at DESC,id DESC LIMIT 200',
  [jobCardNumber, 'OPERATION%']
);

export { OPERATION_STATUSES, readVersion };
