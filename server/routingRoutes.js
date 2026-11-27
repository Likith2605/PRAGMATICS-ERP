import express from 'express';
import { getPool } from './database.js';
import { requireAdmin } from './auth.js';
import {
  bad, notFound, readVersion, dateOnly, requirePermissions, auditRows
} from './productionSupport.js';
import {
  viewOperation, addOperation, updateOperation, deleteOperation, recordEntry
} from './routingSupport.js';

const router = express.Router();

const cardOf = async (client, number) => {
  const result = await client.query('SELECT * FROM job_cards WHERE job_card_number=$1 AND deleted_at IS NULL', [String(number || '')]);
  if (!result.rowCount) throw notFound('Job Card not found.');
  return result.rows[0];
};

router.get('/job-cards/:number/operations', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  await cardOf(getPool(), req.params.number);
  const result = await getPool().query(
    'SELECT * FROM job_card_operations WHERE job_card_number=$1 ORDER BY sequence_number,id', [req.params.number]
  );
  res.json({ operations: result.rows.map(viewOperation) });
});

router.post('/job-cards/:number/operations', async (req, res) => {
  requirePermissions(req, 'job_card.update_progress');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const operation = await addOperation(client, req, req.params.number, req.body?.operation || req.body?.data, version);
    await client.query('COMMIT');
    res.status(201).json({ operation });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/operations/:id', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  const result = await getPool().query('SELECT * FROM job_card_operations WHERE id=$1', [Number(req.params.id)]);
  if (!result.rowCount) throw notFound('Operation not found.');
  res.json({ operation: viewOperation(result.rows[0]) });
});

router.put('/operations/:id', async (req, res) => {
  requirePermissions(req, 'job_card.update_progress');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const operation = await updateOperation(client, req, Number(req.params.id), req.body?.operation || req.body?.data, version);
    await client.query('COMMIT');
    res.json({ operation });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/operations/:id/start', async (req, res) => {
  requirePermissions(req, 'job_card.update_progress');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const operation = await updateOperation(client, req, Number(req.params.id), {
      status: 'In Progress',
      startedAt: new Date().toISOString(),
      completedAt: null,
      ...(req.body?.employeeId ? { operatorId: req.body.employeeId } : {}),
      ...(req.body?.employeeName ? { operatorName: req.body.employeeName } : {}),
      ...(req.body?.machineId ? { machineId: req.body.machineId } : {}),
      ...(req.body?.machineName ? { machineName: req.body.machineName } : {})
    }, version);
    await client.query('COMMIT');
    res.json({ operation });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.post('/operations/:id/complete', async (req, res) => {
  requirePermissions(req, 'job_card.update_progress');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const operation = await updateOperation(client, req, Number(req.params.id), {
      status: 'Completed',
      completedAt: new Date().toISOString(),
      ...(req.body?.actualHours !== undefined ? { actualHours: Number(req.body.actualHours) || 0 } : {}),
      ...(req.body?.outputQty !== undefined ? { outputQty: Number(req.body.outputQty) || 0 } : {})
    }, version);
    await client.query('COMMIT');
    res.json({ operation });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.delete('/operations/:id', requireAdmin, async (req, res) => {
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await deleteOperation(client, req, Number(req.params.id), version);
    await client.query('COMMIT');
    res.json(result);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/operations/:id/entries', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  const result = await getPool().query(
    'SELECT * FROM production_operation_entries WHERE operation_id=$1 ORDER BY entry_date DESC,id DESC', [Number(req.params.id)]
  );
  res.json({ entries: result.rows });
});

router.post('/operations/:id/entries', async (req, res) => {
  requirePermissions(req, 'production.entry.create');
  const version = readVersion(req.body?.version);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const operation = await client.query('SELECT * FROM job_card_operations WHERE id=$1', [Number(req.params.id)]);
    if (!operation.rowCount) throw notFound('Operation not found.');
    const entry = await recordEntry(client, req, operation.rows[0].job_card_number, {
      ...(req.body?.entry || req.body?.data), operationId: Number(req.params.id)
    }, version);
    await client.query('COMMIT');
    res.status(201).json({ entry });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

router.get('/job-cards/:number/entries', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  await cardOf(getPool(), req.params.number);
  const result = await getPool().query(
    'SELECT * FROM production_operation_entries WHERE job_card_number=$1 ORDER BY entry_date DESC,id DESC', [req.params.number]
  );
  res.json({ entries: result.rows });
});

router.get('/job-cards/:number/audit', async (req, res) => {
  requirePermissions(req, 'job_card.view');
  await cardOf(getPool(), req.params.number);
  res.json({ entries: await auditRows(getPool(), 'job_card_audit', 'job_card_number', req.params.number, Number(req.query.limit)) });
});

export default router;
