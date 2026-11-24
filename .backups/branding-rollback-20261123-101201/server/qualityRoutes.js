import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { getPool } from './database.js';
import { requireAdmin, auditSensitiveAction } from './auth.js';
import { pushToQualityServer, uploadDrawingToQualityServer } from './qcSyncClient.js';
import { parseCalloutText } from '../src/utils/ballooning/calloutFormat.js';

const router = express.Router();
const balloonedPdfUpload = multer({
  storage: multer.memoryStorage(),
  // The mobile server's JSON body limit is 50 MB; base64 expands the PDF by a third.
  limits: { fileSize: Number(process.env.MAX_QC_PDF_BYTES || 35 * 1024 * 1024) },
}).single('drawingPdf');

const now = () => new Date().toISOString();
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const json = (value) => (value && typeof value === 'object' ? value : {});
const str = (v) => (v == null ? '' : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

const drawingView = (row) => ({
  id: row.id,
  drawing_no: row.drawing_no,
  part_name: row.part_name,
  customer: row.customer,
  revision: row.revision,
  material: row.material,
  unit: row.unit,
  notes: row.notes,
  po_no: row.po_no,
  qty: row.qty,
  treatment: row.treatment,
  hardness: row.hardness,
  image_uri: row.image_uri,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const dimensionView = (row) => ({
  id: row.id,
  drawing_id: row.drawing_id,
  dim_no: row.dim_no,
  description: row.description,
  nominal: row.nominal,
  nominal_text: row.nominal_text,
  tol_upper: row.tol_upper,
  tol_lower: row.tol_lower,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const checkView = (row) => ({
  id: row.id,
  drawing_id: row.drawing_id,
  checked_by: row.checked_by,
  inspector_name: row.inspector_name,
  checked_at: row.checked_at,
  result: row.result,
  instrument: row.instrument,
  inspector_notes: row.inspector_notes,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const measurementView = (row) => ({
  id: row.id,
  check_id: row.check_id,
  dimension_id: row.dimension_id,
  sample1: row.sample1,
  sample2: row.sample2,
  sample3: row.sample3,
  sample4: row.sample4,
  sample5: row.sample5,
  sample6: row.sample6,
  sample7: row.sample7,
  sample8: row.sample8,
  sample9: row.sample9,
  sample10: row.sample10,
  remarks: row.remarks,
  pass: row.pass,
  instrument: row.instrument,
  sample_status: row.sample_status,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const dispatchView = (row) => ({
  id: row.id,
  dispatch_no: row.dispatch_no,
  drawing_id: row.drawing_id,
  drawing_no: row.drawing_no,
  part_name: row.part_name,
  po_no: row.po_no,
  invoice_no: row.invoice_no,
  qty: row.qty,
  dispatched_by: row.dispatched_by,
  dispatched_at: row.dispatched_at,
  notes: row.notes,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const instrumentView = (row) => ({
  id: row.id,
  name: row.name,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

router.get('/health', async (_req, res) => {
  const result = await getPool().query('SELECT 1 AS connected');
  res.json({ status: 'ok', database: result.rows[0].connected === 1 });
});

/* ------------------------------------------------------------------ */
/* Drawings                                                            */
/* ------------------------------------------------------------------ */

router.get('/drawings', async (req, res) => {
  const search = str(req.query.search || '').trim();
  let sql = 'SELECT * FROM quality_drawings WHERE deleted = 0';
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (drawing_no ILIKE $${params.length} OR part_name ILIKE $${params.length} OR customer ILIKE $${params.length})`;
  }
  sql += ' ORDER BY drawing_no ASC';
  const result = await getPool().query(sql, params);
  res.json(result.rows.map(drawingView));
});

router.get('/drawings/:id', async (req, res) => {
  const result = await getPool().query('SELECT * FROM quality_drawings WHERE id = $1 AND deleted = 0', [req.params.id]);
  if (!result.rowCount) throw notFound('Drawing not found');
  const dims = await getPool().query(
    'SELECT * FROM quality_dimensions WHERE drawing_id = $1 AND deleted = 0 ORDER BY dim_no ASC',
    [req.params.id]
  );
  res.json({ ...drawingView(result.rows[0]), dimensions: dims.rows.map(dimensionView) });
});

router.post('/drawings', async (req, res) => {
  const body = json(req.body);
  const drawingNo = str(body.drawing_no || body.drawing_no).trim();
  const partName = str(body.part_name).trim();
  if (!drawingNo) throw badRequest('drawing_no is required');
  if (!partName) throw badRequest('part_name is required');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Upsert on drawing_no
    const existing = await client.query('SELECT id FROM quality_drawings WHERE drawing_no = $1', [drawingNo]);
    let id;
    if (existing.rowCount) {
      id = existing.rows[0].id;
      await client.query(
        `UPDATE quality_drawings SET part_name=$2, customer=$3, revision=$4, material=$5, unit=$6, notes=$7, po_no=$8, qty=$9, treatment=$10, hardness=$11, image_uri=$12, deleted=0, updated_at=now() WHERE id=$1`,
        [id, partName, str(body.customer), str(body.revision), str(body.material), str(body.unit || 'mm'), str(body.notes), str(body.po_no), num(body.qty), str(body.treatment), str(body.hardness), str(body.image_uri)]
      );
    } else {
      id = randomUUID();
      await client.query(
        `INSERT INTO quality_drawings (id, drawing_no, part_name, customer, revision, material, unit, notes, po_no, qty, treatment, hardness, image_uri) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, drawingNo, partName, str(body.customer), str(body.revision), str(body.material), str(body.unit || 'mm'), str(body.notes), str(body.po_no), num(body.qty), str(body.treatment), str(body.hardness), str(body.image_uri)]
      );
    }
    await client.query('COMMIT');
    const result = await client.query('SELECT * FROM quality_drawings WHERE id = $1', [id]);
    res.status(201).json(drawingView(result.rows[0]));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.put('/drawings/:id', async (req, res) => {
  const body = json(req.body);
  const result = await getPool().query(
    `UPDATE quality_drawings SET part_name=COALESCE($2,part_name), customer=COALESCE($3,customer), revision=COALESCE($4,revision), material=COALESCE($5,material), unit=COALESCE($6,unit), notes=COALESCE($7,notes), po_no=COALESCE($8,po_no), qty=COALESCE($9,qty), treatment=COALESCE($10,treatment), hardness=COALESCE($11,hardness), image_uri=COALESCE($12,image_uri), updated_at=now() WHERE id=$1 AND deleted=0 RETURNING *`,
    [req.params.id, body.part_name ?? null, body.customer ?? null, body.revision ?? null, body.material ?? null, body.unit ?? null, body.notes ?? null, body.po_no ?? null, body.qty ?? null, body.treatment ?? null, body.hardness ?? null, body.image_uri ?? null]
  );
  if (!result.rowCount) throw notFound('Drawing not found');
  res.json(drawingView(result.rows[0]));
});

router.delete('/drawings/:id', requireAdmin, async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw badRequest('A reason is required to remove a Quality drawing.');
  const pool = getPool();
  const prior = await pool.query('SELECT * FROM quality_drawings WHERE id=$1 AND deleted=0', [req.params.id]);
  if (!prior.rowCount) throw notFound('Drawing not found');
  const dependency = await pool.query('SELECT (SELECT count(*) FROM quality_checks WHERE drawing_id=$1 AND deleted=0) AS checks, (SELECT count(*) FROM quality_dispatches WHERE drawing_id=$1 AND deleted=0) AS dispatches', [req.params.id]);
  if (Number(dependency.rows[0].checks) || Number(dependency.rows[0].dispatches)) return res.status(409).json({ error: 'This Quality drawing has inspection or dispatch history and must be retained.' });
  await pool.query('UPDATE quality_drawings SET deleted=1, updated_at=now() WHERE id=$1 AND deleted=0', [req.params.id]);
  await auditSensitiveAction(req, { module: 'Quality', recordId: req.params.id, recordLabel: prior.rows[0].drawing_no, action: 'DEACTIVATE_DRAWING', reason, before: prior.rows[0], after: { deleted: 1 } });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Dimensions                                                          */
/* ------------------------------------------------------------------ */

router.get('/drawings/:id/dimensions', async (req, res) => {
  const result = await getPool().query(
    'SELECT * FROM quality_dimensions WHERE drawing_id = $1 AND deleted = 0 ORDER BY dim_no ASC',
    [req.params.id]
  );
  res.json(result.rows.map(dimensionView));
});

router.post('/drawings/:id/dimensions', async (req, res) => {
  const body = json(req.body);
  const dimNo = num(body.dim_no);
  const nominal = num(body.nominal);
  if (dimNo == null || dimNo === 0) throw badRequest('dim_no is required');

  const client = await getPool().connect();
  try {
    const existing = await client.query('SELECT id FROM quality_dimensions WHERE drawing_id=$1 AND dim_no=$2', [req.params.id, dimNo]);
    let id;
    if (existing.rowCount) {
      id = existing.rows[0].id;
      await client.query(
        `UPDATE quality_dimensions SET description=$3, nominal=$4, nominal_text=$5, tol_upper=$6, tol_lower=$7, deleted=0, updated_at=now() WHERE id=$1 AND drawing_id=$2`,
        [id, req.params.id, str(body.description), nominal, str(body.nominal_text), num(body.tol_upper), num(body.tol_lower)]
      );
    } else {
      id = randomUUID();
      await client.query(
        `INSERT INTO quality_dimensions (id, drawing_id, dim_no, description, nominal, nominal_text, tol_upper, tol_lower) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, req.params.id, dimNo, str(body.description), nominal, str(body.nominal_text), num(body.tol_upper), num(body.tol_lower)]
      );
    }
    const result = await client.query('SELECT * FROM quality_dimensions WHERE id=$1', [id]);
    res.status(201).json(dimensionView(result.rows[0]));
  } finally {
    client.release();
  }
});

router.put('/dimensions/:id', async (req, res) => {
  const body = json(req.body);
  const result = await getPool().query(
    `UPDATE quality_dimensions SET description=COALESCE($2,description), nominal=COALESCE($3,nominal), nominal_text=COALESCE($4,nominal_text), tol_upper=COALESCE($5,tol_upper), tol_lower=COALESCE($6,tol_lower), updated_at=now() WHERE id=$1 AND deleted=0 RETURNING *`,
    [req.params.id, body.description ?? null, body.nominal ?? null, body.nominal_text ?? null, body.tol_upper ?? null, body.tol_lower ?? null]
  );
  if (!result.rowCount) throw notFound('Dimension not found');
  res.json(dimensionView(result.rows[0]));
});

router.delete('/dimensions/:id', requireAdmin, async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw badRequest('A reason is required to correct a Quality dimension.');
  const pool = getPool();
  const prior = await pool.query('SELECT * FROM quality_dimensions WHERE id=$1 AND deleted=0', [req.params.id]);
  if (!prior.rowCount) throw notFound('Dimension not found');
  const measurements = await pool.query('SELECT count(*) FROM quality_measurements WHERE dimension_id=$1', [req.params.id]);
  if (Number(measurements.rows[0].count)) return res.status(409).json({ error: 'This dimension has measurement history and must be corrected through a controlled workflow.' });
  await pool.query('UPDATE quality_dimensions SET deleted=1, updated_at=now() WHERE id=$1 AND deleted=0', [req.params.id]);
  await auditSensitiveAction(req, { module: 'Quality', recordId: req.params.id, recordLabel: String(prior.rows[0].dim_no), action: 'DEACTIVATE_DIMENSION', reason, before: prior.rows[0], after: { deleted: 1 } });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Checks (Inspections)                                                */
/* ------------------------------------------------------------------ */

router.get('/checks', async (req, res) => {
  const drawingId = str(req.query.drawing_id || '').trim();
  let sql = `SELECT c.*, d.drawing_no, d.part_name FROM quality_checks c JOIN quality_drawings d ON d.id = c.drawing_id WHERE c.deleted = 0 AND d.deleted = 0`;
  const params = [];
  if (drawingId) {
    params.push(drawingId);
    sql += ` AND c.drawing_id = $${params.length}`;
  }
  sql += ' ORDER BY c.checked_at DESC';
  const result = await getPool().query(sql, params);
  res.json(result.rows.map((r) => ({
    ...checkView(r),
    drawing_no: r.drawing_no,
    part_name: r.part_name,
  })));
});

router.get('/checks/:id', async (req, res) => {
  const checkResult = await getPool().query(
    `SELECT c.*, d.drawing_no, d.part_name FROM quality_checks c JOIN quality_drawings d ON d.id = c.drawing_id WHERE c.id = $1 AND c.deleted = 0`,
    [req.params.id]
  );
  if (!checkResult.rowCount) throw notFound('Check not found');
  const check = checkResult.rows[0];

  const dims = await getPool().query(
    'SELECT * FROM quality_dimensions WHERE drawing_id = $1 AND deleted = 0 ORDER BY dim_no ASC',
    [check.drawing_id]
  );

  const meas = await getPool().query(
    'SELECT * FROM quality_measurements WHERE check_id = $1 ORDER BY dimension_id ASC',
    [req.params.id]
  );

  const measByDim = new Map(meas.rows.map((m) => [m.dimension_id, m]));

  res.json({
    ...checkView(check),
    drawing_no: check.drawing_no,
    part_name: check.part_name,
    dimensions: dims.rows.map((d) => ({
      ...dimensionView(d),
      measurement: measByDim.get(d.id) ? measurementView(measByDim.get(d.id)) : null,
    })),
  });
});

router.post('/checks', async (req, res) => {
  const body = json(req.body);
  const drawingId = str(body.drawing_id).trim();
  if (!drawingId) throw badRequest('drawing_id is required');

  const id = randomUUID();
  await getPool().query(
    `INSERT INTO quality_checks (id, drawing_id, checked_by, inspector_name, instrument, inspector_notes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, drawingId, str(body.checked_by), str(body.inspector_name), str(body.instrument), str(body.inspector_notes)]
  );
  const result = await getPool().query('SELECT * FROM quality_checks WHERE id=$1', [id]);
  res.status(201).json(checkView(result.rows[0]));
});

router.put('/checks/:id', async (req, res) => {
  const body = json(req.body);
  const result = await getPool().query(
    `UPDATE quality_checks SET checked_by=COALESCE($2,checked_by), inspector_name=COALESCE($3,inspector_name), result=COALESCE($4,result), instrument=COALESCE($5,instrument), inspector_notes=COALESCE($6,inspector_notes), updated_at=now() WHERE id=$1 AND deleted=0 RETURNING *`,
    [req.params.id, body.checked_by ?? null, body.inspector_name ?? null, body.result ?? null, body.instrument ?? null, body.inspector_notes ?? null]
  );
  if (!result.rowCount) throw notFound('Check not found');
  res.json(checkView(result.rows[0]));
});

router.put('/checks/:id/complete', async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Compute overall result from measurements
    const meas = await client.query('SELECT pass FROM quality_measurements WHERE check_id = $1', [req.params.id]);
    const passes = meas.rows.filter((m) => m.pass === 1).length;
    const fails = meas.rows.filter((m) => m.pass === 0).length;
    const total = meas.rows.length;
    const result = fails > 0 ? 'Fail' : passes === total && total > 0 ? 'Pass' : 'Pending';

    const updated = await client.query(
      `UPDATE quality_checks SET result=$2, checked_at=now(), updated_at=now() WHERE id=$1 AND deleted=0 RETURNING *`,
      [req.params.id, result]
    );
    if (!updated.rowCount) throw notFound('Check not found');
    await client.query('COMMIT');
    res.json(checkView(updated.rows[0]));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.delete('/checks/:id', requireAdmin, async (req, res) => {
  return res.status(409).json({ error: 'Quality inspection history cannot be deleted. Use the controlled correction workflow.' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Measurements                                                        */
/* ------------------------------------------------------------------ */

const SAMPLE_FIELDS = ['sample1','sample2','sample3','sample4','sample5','sample6','sample7','sample8','sample9','sample10'];

const computePass = (dim, samples) => {
  const lower = dim.nominal + dim.tol_lower;
  const upper = dim.nominal + dim.tol_upper;
  const valid = samples.filter((s) => s != null && Number.isFinite(Number(s))).map(Number);
  if (valid.length === 0) return null;
  return valid.every((s) => s >= lower && s <= upper) ? 1 : 0;
};

router.put('/measurements/:dimensionId', async (req, res) => {
  const body = json(req.body);
  const checkId = str(body.check_id).trim();
  const dimensionId = req.params.dimensionId;
  if (!checkId) throw badRequest('check_id is required');

  const client = await getPool().connect();
  try {
    // Load dimension for pass/fail computation
    const dimResult = await client.query('SELECT * FROM quality_dimensions WHERE id=$1 AND deleted=0', [dimensionId]);
    if (!dimResult.rowCount) throw notFound('Dimension not found');
    const dim = dimResult.rows[0];

    const samples = SAMPLE_FIELDS.map((f) => {
      const v = body[f];
      return v == null || v === '' ? null : Number(v);
    });
    const pass = computePass(dim, samples);

    const sampleStatus = pass === null ? 'Not Measured' : pass === 1 ? 'Pass' : 'Fail';

    const existing = await client.query('SELECT id FROM quality_measurements WHERE check_id=$1 AND dimension_id=$2', [checkId, dimensionId]);
    let id;
    if (existing.rowCount) {
      id = existing.rows[0].id;
      await client.query(
        `UPDATE quality_measurements SET sample1=$3,sample2=$4,sample3=$5,sample4=$6,sample5=$7,sample6=$8,sample7=$9,sample8=$10,sample9=$11,sample10=$12, remarks=$13, pass=$14, instrument=$15, sample_status=$16, updated_at=now() WHERE id=$1`,
        [id, checkId, ...samples, str(body.remarks), pass, str(body.instrument), sampleStatus]
      );
    } else {
      id = randomUUID();
      await client.query(
        `INSERT INTO quality_measurements (id, check_id, dimension_id, sample1,sample2,sample3,sample4,sample5,sample6,sample7,sample8,sample9,sample10, remarks, pass, instrument, sample_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, checkId, dimensionId, ...samples, str(body.remarks), pass, str(body.instrument), sampleStatus]
      );
    }
    const result = await client.query('SELECT * FROM quality_measurements WHERE id=$1', [id]);
    res.json(measurementView(result.rows[0]));
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ */
/* Dispatches                                                          */
/* ------------------------------------------------------------------ */

router.get('/dispatches', async (req, res) => {
  const result = await getPool().query(
    `SELECT d.*, dw.drawing_no, dw.part_name FROM quality_dispatches d JOIN quality_drawings dw ON dw.id = d.drawing_id WHERE d.deleted = 0 AND dw.deleted = 0 ORDER BY d.dispatched_at DESC`
  );
  res.json(result.rows.map(dispatchView));
});

router.post('/dispatches', async (req, res) => {
  const body = json(req.body);
  const drawingId = str(body.drawing_id).trim();
  if (!drawingId) throw badRequest('drawing_id is required');

  const id = randomUUID();
  await getPool().query(
    `INSERT INTO quality_dispatches (id, dispatch_no, drawing_id, drawing_no, part_name, po_no, invoice_no, qty, dispatched_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, str(body.dispatch_no), drawingId, str(body.drawing_no), str(body.part_name), str(body.po_no), str(body.invoice_no), num(body.qty), str(body.dispatched_by), str(body.notes)]
  );
  const result = await getPool().query('SELECT * FROM quality_dispatches WHERE id=$1', [id]);
  res.status(201).json(dispatchView(result.rows[0]));
});

router.delete('/dispatches/:id', requireAdmin, async (req, res) => {
  return res.status(409).json({ error: 'Quality dispatch history must be retained.' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

router.get('/instruments', async (_req, res) => {
  const result = await getPool().query('SELECT * FROM quality_instruments WHERE deleted = 0 ORDER BY name ASC');
  res.json(result.rows.map(instrumentView));
});

router.post('/instruments', async (req, res) => {
  const body = json(req.body);
  const name = str(body.name).trim();
  if (!name) throw badRequest('name is required');
  const id = randomUUID();
  await getPool().query('INSERT INTO quality_instruments (id, name) VALUES ($1, $2)', [id, name]);
  const result = await getPool().query('SELECT * FROM quality_instruments WHERE id=$1', [id]);
  res.status(201).json(instrumentView(result.rows[0]));
});

router.delete('/instruments/:id', requireAdmin, async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw badRequest('A reason is required to deactivate an instrument.');
  const prior = await getPool().query('SELECT * FROM quality_instruments WHERE id=$1 AND deleted=0', [req.params.id]);
  if (!prior.rowCount) throw notFound('Instrument not found');
  await getPool().query('UPDATE quality_instruments SET deleted=1, updated_at=now() WHERE id=$1 AND deleted=0', [req.params.id]);
  await auditSensitiveAction(req, { module: 'Quality', recordId: req.params.id, recordLabel: prior.rows[0].name, action: 'DEACTIVATE_INSTRUMENT', reason, before: prior.rows[0], after: { deleted: 1 } });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Import from Ballooning                                              */
/* ------------------------------------------------------------------ */

router.post('/import/ballooning/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  const pool = getPool();

  // Load ballooning project data
  const projResult = await pool.query('SELECT * FROM ballooning_projects WHERE id = $1', [projectId]);
  if (!projResult.rowCount) throw notFound('Ballooning project not found');
  const projData = json(projResult.rows[0].data);

  // Load drawings
  const drawingsResult = await pool.query('SELECT * FROM ballooning_drawings WHERE project_id = $1', [projectId]);

  // Load characteristics (these hold the dimension data)
  const charsResult = await pool.query('SELECT * FROM ballooning_characteristics WHERE project_id = $1', [projectId]);

  const client = await pool.connect();
  const imported = [];
  // Payload for the mobile QC sync server - built alongside the local import
  // so one click sends the same drawing + dimensions to every phone.
  const qcDrawings = [];
  const qcDimensions = [];
  try {
    await client.query('BEGIN');

    for (const drawRow of drawingsResult.rows) {
      const chars = charsResult.rows.filter((c) => c.drawing_id === drawRow.id);
      const drawingNo = str(drawRow.drawing_no || projData.drawingNumber || '').trim();
      const partName = str(projData.partName || '').trim();
      if (!drawingNo) continue;

      // Same mapping as the local import, in the mobile sync server's format.
      qcDrawings.push({
        drawing_no: drawingNo,
        part_name: partName || drawingNo,
        customer: str(projData.customerName),
        revision: str(projData.revision) || 'A',
        material: str(projData.material),
        unit: str(projData.unit || 'mm'),
        notes: str(projData.remarks),
        po_no: str(projData.poNumber || projData.po_no || ''),
        qty: str(projData.qty || ''),
        treatment: str(projData.treatment || ''),
        hardness: str(projData.hardness || ''),
      });

      // Upsert drawing
      let drawingId;
      const existing = await client.query('SELECT id FROM quality_drawings WHERE drawing_no = $1', [drawingNo]);
      if (existing.rowCount) {
        drawingId = existing.rows[0].id;
        await client.query(
          `UPDATE quality_drawings SET part_name=$2, customer=$3, revision=$4, material=$5, unit=$6, notes=$7, deleted=0, updated_at=now() WHERE id=$1`,
          [drawingId, partName, str(projData.customerName), str(projData.revision), str(projData.material), str(projData.unit || 'mm'), str(projData.remarks)]
        );
      } else {
        drawingId = randomUUID();
        await client.query(
          `INSERT INTO quality_drawings (id, drawing_no, part_name, customer, revision, material, unit, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [drawingId, drawingNo, partName, str(projData.customerName), str(projData.revision), str(projData.material), str(projData.unit || 'mm'), str(projData.remarks)]
        );
      }

      // Import dimensions from characteristics
      let dimCount = 0;
      for (const charRow of chars) {
        const charData = json(charRow.data);
        // Whole numbers only: dim_no is an integer column (here and on the
        // mobile QC server) - a decimal like 10.1 would fail the import and
        // the push to the phone with a Postgres cast error.
        const dimNo = Math.round(num(charData.number));
        if (!dimNo) continue;

        const valueStr = str(charData.value || '');
        const parsedCallout = parseCalloutText(valueStr);
        const nominalNum =
          parsedCallout.confident && Number.isFinite(parsedCallout.nominalNum)
            ? parsedCallout.nominalNum
            : 0;

        const plusTol = Number.parseFloat(str(charData.plusTolerance).replace(/[^\d.\-]/g, '')) || 0;
        const minusTol = Number.parseFloat(str(charData.minusTolerance).replace(/[^\d.\-]/g, '')) || 0;

        const existingDim = await client.query('SELECT id FROM quality_dimensions WHERE drawing_id=$1 AND dim_no=$2', [drawingId, dimNo]);
        if (existingDim.rowCount) {
          await client.query(
            `UPDATE quality_dimensions SET description=$3, nominal=$4, nominal_text=$5, tol_upper=$6, tol_lower=$7, deleted=0, updated_at=now() WHERE id=$1 AND drawing_id=$2`,
            [existingDim.rows[0].id, drawingId, str(charData.specification), nominalNum, valueStr, Math.abs(plusTol), -Math.abs(minusTol)]
          );
        } else {
          await client.query(
            `INSERT INTO quality_dimensions (id, drawing_id, dim_no, description, nominal, nominal_text, tol_upper, tol_lower) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [randomUUID(), drawingId, dimNo, str(charData.specification), nominalNum, valueStr, Math.abs(plusTol), -Math.abs(minusTol)]
          );
        }
        qcDimensions.push({
          drawing_no: drawingNo,
          dim_no: dimNo,
          description: str(charData.specification),
          nominal: nominalNum,
          nominal_text: valueStr,
          tol_upper: Math.abs(plusTol),
          tol_lower: -Math.abs(minusTol),
        });
        dimCount++;
      }

      imported.push({ drawingId, drawingNo, partName, dimensions: dimCount });
    }

    await client.query('COMMIT');

    // Local import is durable - now mirror it to the mobile QC sync server so
    // phones pick it up live (socket.io) or on their next sync pull. Never
    // fails the ERP import: the response reports the mobile status separately.
    const mobileSync = await pushToQualityServer({ drawings: qcDrawings, dimensions: qcDimensions });
    res.json({ ok: true, imported, mobileSync });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

router.post('/import/ballooning/:projectId/drawing-file', (req, res, next) => {
  balloonedPdfUpload(req, res, (error) => {
    if (error) {
      if (error.code === 'LIMIT_FILE_SIZE') error.status = 413;
      next(error);
      return;
    }
    next();
  });
}, async (req, res) => {
  const drawingNo = str(req.body?.drawingNo).trim();
  const file = req.file;
  if (!file || file.mimetype !== 'application/pdf' || !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw badRequest('A valid ballooned PDF is required');
  }
  if (!drawingNo) throw badRequest('drawingNo is required');

  const pool = getPool();
  const projectResult = await pool.query('SELECT data FROM ballooning_projects WHERE id = $1', [req.params.projectId]);
  if (!projectResult.rowCount) throw notFound('Ballooning project not found');
  const drawingResult = await pool.query(
    'SELECT drawing_no FROM ballooning_drawings WHERE project_id = $1',
    [req.params.projectId]
  );
  const projectDrawingNo = str(json(projectResult.rows[0].data).drawingNumber).trim();
  const belongsToProject = drawingResult.rows.some(
    (row) => str(row.drawing_no || projectDrawingNo).trim() === drawingNo
  );
  if (!belongsToProject) throw badRequest('Drawing does not belong to this ballooning project');

  const safeDrawingNo = drawingNo.replace(/[^A-Za-z0-9._-]/g, '_');
  const filename = `Ballooned-${safeDrawingNo}-${Date.now()}.pdf`;
  const mobileSync = await uploadDrawingToQualityServer({
    drawing_no: drawingNo,
    filename,
    data: file.buffer.toString('base64'),
  });
  res.json({ ok: mobileSync.ok, mobileSync });
});

export default router;
