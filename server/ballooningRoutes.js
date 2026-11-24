import { randomUUID } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import express from 'express';
import multer from 'multer';
import { getPool } from './database.js';
import { requireAdmin, auditSensitiveAction } from './auth.js';
import { findChangedContactValidationError } from '../shared/fieldValidation.js';

const router = express.Router();
const storageDir = join(process.env.FILE_STORAGE_DIR || join(process.cwd(), 'storage'), 'drawings');
await mkdir(storageDir, { recursive: true });
const upload = multer({
    dest: storageDir,
    limits: { fileSize: Number(process.env.MAX_DRAWING_BYTES || 50 * 1024 * 1024) }
});

const now = () => new Date().toISOString();
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const json = (value) => (value && typeof value === 'object' ? value : {});
const projectView = (row) => ({ _id: row.id, ...json(row.data), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const drawingView = (row) => ({
    _id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    drawingNo: row.drawing_no,
    filePath: `/api/ballooning/drawings/${encodeURIComponent(row.id)}/file`,
    pageCount: row.page_count,
    uploadedAt: row.uploaded_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
});
const balloonView = (row) => ({ _id: row.id, projectId: row.project_id, ...json(row.data), number: row.number, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const characteristicView = (row) => ({ _id: row.id, projectId: row.project_id, ...json(row.data), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });

const project = async(id, client = getPool()) => {
    const result = await client.query('SELECT * FROM ballooning_projects WHERE id = $1', [id]);
    if (!result.rowCount) throw notFound('Project not found');
    return result.rows[0];
};

router.get('/health', async(_req, res) => {
    const result = await getPool().query('SELECT 1 AS connected');
    res.json({ status: 'ok', database: result.rows[0].connected === 1 });
});

router.get('/projects', async(_req, res) => {
    const result = await getPool().query('SELECT * FROM ballooning_projects ORDER BY created_at DESC');
    res.json(result.rows.map(projectView));
});

router.post('/projects', async(req, res) => {
    const body = json(req.body);
    const validationError = findChangedContactValidationError(body);
    if (validationError) throw badRequest(validationError);
    const id = randomUUID();
    const timestamp = now();
    const data = {...body, createdBy: body.createdBy || 'Admin' };
    if (data.unit == null) data.unit = 'mm';
    if (data.status == null) data.status = 'Draft';
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            'INSERT INTO ballooning_projects (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $3) RETURNING *', [id, JSON.stringify(data), timestamp]
        );
        await client.query(
            'INSERT INTO ballooning_inspections (id, project_id, data, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $4)', [randomUUID(), id, JSON.stringify({ inspector: data.inspector, reviewer: data.reviewer, status: 'Draft', comments: '', approvedBy: '', approvedDate: null }), timestamp]
        );
        await client.query('COMMIT');
        res.status(201).json(projectView(inserted.rows[0]));
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.post('/projects/:id/duplicate', async(req, res) => {
    const source = await project(req.params.id);
    const client = await getPool().connect();
    const timestamp = now();
    const copyId = randomUUID();
    const drawingIds = new Map();
    const balloonIds = new Map();
    try {
        await client.query('BEGIN');
        const data = {...json(source.data), status: 'Draft' };
        await client.query('INSERT INTO ballooning_projects (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $3)', [copyId, JSON.stringify(data), timestamp]);
        await client.query('INSERT INTO ballooning_inspections (id, project_id, data, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $4)', [randomUUID(), copyId, JSON.stringify({ status: 'Draft', comments: '', approvedBy: '', approvedDate: null }), timestamp]);

        const drawings = await client.query('SELECT * FROM ballooning_drawings WHERE project_id = $1', [source.id]);
        for (const drawing of drawings.rows) {
            const newId = randomUUID();
            drawingIds.set(drawing.id, newId);
            await copyFile(join(storageDir, drawing.storage_name), join(storageDir, `${newId}${extname(drawing.storage_name)}`));
            await client.query('INSERT INTO ballooning_drawings (id, project_id, file_name, drawing_no, storage_name, page_count, uploaded_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)', [newId, copyId, drawing.file_name, drawing.drawing_no, `${newId}${extname(drawing.storage_name)}`, drawing.page_count, timestamp]);
        }
        const balloons = await client.query('SELECT * FROM ballooning_balloons WHERE project_id = $1', [source.id]);
        for (const balloon of balloons.rows) {
            const newId = randomUUID();
            balloonIds.set(balloon.id, newId);
            await client.query('INSERT INTO ballooning_balloons (id, project_id, drawing_id, number, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)', [newId, copyId, drawingIds.get(balloon.drawing_id) || null, balloon.number, JSON.stringify(balloon.data), timestamp]);
        }
        const characteristics = await client.query('SELECT * FROM ballooning_characteristics WHERE project_id = $1', [source.id]);
        for (const item of characteristics.rows) {
            await client.query('INSERT INTO ballooning_characteristics (id, project_id, drawing_id, balloon_id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)', [randomUUID(), copyId, drawingIds.get(item.drawing_id) || null, balloonIds.get(item.balloon_id) || null, JSON.stringify(item.data), timestamp]);
        }
        await client.query('COMMIT');
        res.status(201).json(projectView(await project(copyId)));
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.get('/projects/:id', async(req, res) => res.json(projectView(await project(req.params.id))));

router.put('/projects/:id', async(req, res) => {
    const current = await project(req.params.id);
    const validationError = findChangedContactValidationError(req.body, json(current.data));
    if (validationError) throw badRequest(validationError);
    const result = await getPool().query(
        'UPDATE ballooning_projects SET data = data || $2::jsonb, updated_at = $3 WHERE id = $1 RETURNING *', [req.params.id, JSON.stringify(json(req.body)), now()]
    );
    res.json(projectView(result.rows[0]));
});

router.delete('/projects/:id', requireAdmin, async(req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw badRequest('A reason is required to delete a Ballooning project.');
    const current = await project(req.params.id);
    const related = await getPool().query('SELECT (SELECT count(*) FROM ballooning_approvals WHERE project_id=$1) AS approvals, (SELECT count(*) FROM ballooning_inspections WHERE project_id=$1) AS inspections, (SELECT count(*) FROM ballooning_balloons WHERE project_id=$1) AS balloons, (SELECT count(*) FROM ballooning_characteristics WHERE project_id=$1) AS characteristics, (SELECT count(*) FROM ballooning_drawings WHERE project_id=$1) AS drawings', [req.params.id]);
    if (Object.values(related.rows[0]).some((count) => Number(count) > 0) || !['Draft', 'New'].includes(String(current.data?.status || 'Draft'))) return res.status(409).json({ error: 'This Ballooning project has workflow or drawing history and cannot be permanently deleted.' });
    await getPool().query('DELETE FROM ballooning_projects WHERE id = $1', [req.params.id]);
    await auditSensitiveAction(req, { module: 'Ballooning', recordId: req.params.id, recordLabel: current.data?.projectId || current.data?.projectNumber || req.params.id, action: 'DELETE_PROJECT', reason, before: current.data });
    res.json({ success: true });
});

router.post('/projects/:id/drawing', upload.single('drawing'), async(req, res) => {
    await project(req.params.id);
    if (!req.file) throw badRequest('No file uploaded');
    const id = randomUUID();
    const timestamp = now();
    const result = await getPool().query(
        `INSERT INTO ballooning_drawings (id, project_id, file_name, drawing_no, storage_name, page_count, uploaded_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6) RETURNING *`, [id, req.params.id, req.file.originalname || 'drawing.pdf', String(req.body.drawingNo || '').trim(), req.file.filename, timestamp]
    );
    res.status(201).json(drawingView(result.rows[0]));
});

router.get('/projects/:id/drawings', async(req, res) => {
    await project(req.params.id);
    const result = await getPool().query('SELECT * FROM ballooning_drawings WHERE project_id = $1 ORDER BY uploaded_at DESC', [req.params.id]);
    res.json(result.rows.map(drawingView));
});

router.get('/projects/:id/drawing', async(req, res) => {
    await project(req.params.id);
    const result = await getPool().query('SELECT * FROM ballooning_drawings WHERE project_id = $1 ORDER BY uploaded_at DESC LIMIT 1', [req.params.id]);
    if (!result.rowCount) throw notFound('Drawing not found');
    res.json(drawingView(result.rows[0]));
});

router.put('/projects/:projectId/drawings/:drawingId', async(req, res) => {
    const result = await getPool().query('UPDATE ballooning_drawings SET file_name = COALESCE($3, file_name), drawing_no = COALESCE($4, drawing_no), updated_at = $5 WHERE id = $1 AND project_id = $2 RETURNING *', [req.params.drawingId, req.params.projectId, req.body.fileName, req.body.drawingNo, now()]);
    if (!result.rowCount) throw notFound('Drawing not found');
    res.json(drawingView(result.rows[0]));
});

router.delete('/projects/:projectId/drawings/:drawingId', requireAdmin, async(req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw badRequest('A reason is required to delete a drawing.');
    const prior = await getPool().query('SELECT * FROM ballooning_drawings WHERE id=$1 AND project_id=$2', [req.params.drawingId, req.params.projectId]);
    if (!prior.rowCount) throw notFound('Drawing not found');
    const deps = await getPool().query('SELECT (SELECT count(*) FROM ballooning_balloons WHERE drawing_id=$1) AS balloons, (SELECT count(*) FROM ballooning_characteristics WHERE drawing_id=$1) AS characteristics', [req.params.drawingId]);
    if (Object.values(deps.rows[0]).some((count) => Number(count) > 0)) return res.status(409).json({ error: 'This drawing has balloon or characteristic records and cannot be deleted.' });
    const result = await getPool().query('DELETE FROM ballooning_drawings WHERE id = $1 AND project_id = $2 RETURNING id', [req.params.drawingId, req.params.projectId]);
    if (!result.rowCount) throw notFound('Drawing not found');
    await auditSensitiveAction(req, { module: 'Ballooning', recordId: req.params.drawingId, recordLabel: prior.rows[0].drawing_no || prior.rows[0].file_name, action: 'DELETE_DRAWING', reason, before: { drawingNo: prior.rows[0].drawing_no, fileName: prior.rows[0].file_name } });
    res.json({ success: true });
});

router.get('/drawings/:id/file', async(req, res) => {
    const result = await getPool().query('SELECT file_name, storage_name FROM ballooning_drawings WHERE id = $1', [req.params.id]);
    if (!result.rowCount) throw notFound('Drawing not found');
    res.download(join(storageDir, result.rows[0].storage_name), result.rows[0].file_name);
});

router.get('/projects/:id/balloons', async(req, res) => {
    await project(req.params.id);
    const params = [req.params.id];
    let sql = 'SELECT * FROM ballooning_balloons WHERE project_id = $1';
    if (req.query.drawingId) { params.push(req.query.drawingId);
        sql += ' AND drawing_id = $2'; }
    sql += ' ORDER BY number';
    const result = await getPool().query(sql, params);
    res.json(result.rows.map(balloonView));
});

router.post('/projects/:id/balloons', async(req, res) => {
    await project(req.params.id);
    const body = json(req.body);
    const count = await getPool().query('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM ballooning_balloons WHERE project_id = $1', [req.params.id]);
    const id = randomUUID();
    const timestamp = now();
    const number = Number(body.number || count.rows[0].next);
    const data = {...body };
    delete data.number;
    delete data.projectId;
    const result = await getPool().query('INSERT INTO ballooning_balloons (id, project_id, drawing_id, number, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) RETURNING *', [id, req.params.id, body.drawingId || null, number, JSON.stringify({...data, status: body.status || 'Draft' }), timestamp]);
    res.status(201).json(balloonView(result.rows[0]));
});

router.put('/balloons/:id', async(req, res) => {
    const old = await getPool().query('SELECT * FROM ballooning_balloons WHERE id = $1', [req.params.id]);
    if (!old.rowCount) throw notFound('Balloon not found');
    const body = json(req.body);
    const data = {...json(old.rows[0].data), ...body };
    delete data.number;
    delete data.projectId;
    const result = await getPool().query('UPDATE ballooning_balloons SET number = COALESCE($2, number), drawing_id = COALESCE($3, drawing_id), data = $4::jsonb, updated_at = $5 WHERE id = $1 RETURNING *', [req.params.id, body.number, body.drawingId, JSON.stringify(data), now()]);
    res.json(balloonView(result.rows[0]));
});

router.delete('/balloons/:id', requireAdmin, async(req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw badRequest('A reason is required to delete a balloon.');
    const prior = await getPool().query('SELECT * FROM ballooning_balloons WHERE id=$1', [req.params.id]);
    if (!prior.rowCount) throw notFound('Balloon not found');
    const deps = await getPool().query('SELECT count(*) FROM ballooning_characteristics WHERE balloon_id=$1', [req.params.id]);
    if (Number(deps.rows[0].count)) return res.status(409).json({ error: 'This balloon has characteristic history and cannot be deleted.' });
    const result = await getPool().query('DELETE FROM ballooning_balloons WHERE id = $1 RETURNING *', [req.params.id]);
    if (!result.rowCount) throw notFound('Balloon not found');
    await auditSensitiveAction(req, { module: 'Ballooning', recordId: req.params.id, recordLabel: String(result.rows[0].number), action: 'DELETE_BALLOON', reason, before: result.rows[0].data });
    res.json({ success: true, balloon: balloonView(result.rows[0]) });
});

router.get('/projects/:id/characteristics', async(req, res) => {
    await project(req.params.id);
    const params = [req.params.id];
    let sql = 'SELECT * FROM ballooning_characteristics WHERE project_id = $1';
    if (req.query.drawingId) { params.push(req.query.drawingId);
        sql += ' AND drawing_id = $2'; }
    const result = await getPool().query(`${sql} ORDER BY created_at`, params);
    res.json(result.rows.map(characteristicView));
});

router.post('/projects/:id/characteristics', async(req, res) => {
    await project(req.params.id);
    const body = json(req.body);
    const id = randomUUID();
    const timestamp = now();
    const data = { status: 'NOT INSPECTED', ...body };
    delete data.projectId;
    const result = await getPool().query('INSERT INTO ballooning_characteristics (id, project_id, drawing_id, balloon_id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) RETURNING *', [id, req.params.id, body.drawingId || null, body.balloonId || null, JSON.stringify(data), timestamp]);
    res.status(201).json(characteristicView(result.rows[0]));
});

router.put('/characteristics/:id', async(req, res) => {
    const old = await getPool().query('SELECT * FROM ballooning_characteristics WHERE id = $1', [req.params.id]);
    if (!old.rowCount) throw notFound('Characteristic not found');
    const result = await getPool().query('UPDATE ballooning_characteristics SET data = data || $2::jsonb, updated_at = $3 WHERE id = $1 RETURNING *', [req.params.id, JSON.stringify(json(req.body)), now()]);
    res.json(characteristicView(result.rows[0]));
});

router.delete('/characteristics/:id', requireAdmin, async(req, res) => { const reason = String(req.body?.reason || '').trim(); if (!reason) throw badRequest('A reason is required to delete a characteristic.'); const prior = await getPool().query('SELECT data FROM ballooning_characteristics WHERE id=$1', [req.params.id]); if (!prior.rowCount) throw notFound('Characteristic not found'); const result = await getPool().query('DELETE FROM ballooning_characteristics WHERE id = $1 RETURNING id', [req.params.id]); if (!result.rowCount) throw notFound('Characteristic not found'); await auditSensitiveAction(req, { module: 'Ballooning', recordId: req.params.id, action: 'DELETE_CHARACTERISTIC', reason, before: prior.rows[0].data });
    res.json({ success: true }); });

router.post('/projects/:id/approval', async(req, res) => {
    await project(req.params.id);
    const body = json(req.body);
    const timestamp = now();
    const status = body.status || 'Submitted for Review';
    const result = await getPool().query('INSERT INTO ballooning_approvals (id, project_id, data, created_at) VALUES ($1, $2, $3::jsonb, $4) RETURNING *', [randomUUID(), req.params.id, JSON.stringify({...body, status }), timestamp]);
    await getPool().query('UPDATE ballooning_projects SET data = data || $2::jsonb, updated_at = $3 WHERE id = $1', [req.params.id, JSON.stringify({ status: body.status || 'Under Review' }), timestamp]);
    res.status(201).json({ _id: result.rows[0].id, projectId: result.rows[0].project_id, ...json(result.rows[0].data), createdAt: result.rows[0].created_at.toISOString() });
});

router.post('/projects/:id/export', async(req, res) => { await project(req.params.id);
    res.json({ success: true, message: 'Export placeholder ready' }); });

export default router;
