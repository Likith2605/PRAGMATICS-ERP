import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, auditSensitiveAction } from './auth.js';

/**
 * Central file storage API (Phase 1 of PG-first hardening).
 *
 * Stores binary attachments (project drawings, workflow documents) in the
 * `file_blobs` table so a database backup captures the complete ERP.
 * Browser-side IndexedDB remains as a fast local cache; this API is the
 * authoritative copy.
 *
 * Payloads are base64 inside JSON to stay consistent with the existing
 * Express json pipeline; MAX_FILE_BYTES limits the decoded size.
 */

const router = express.Router();
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 50 * 1024 * 1024);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

// Accepts URL-encoded ids (encodeURIComponent output may contain %XX).
const SAFE_ID = /^[A-Za-z0-9._:%-]{1,160}$/;

const validateId = (raw) => {
    const id = String(raw || '');
    if (!SAFE_ID.test(id)) throw badRequest('Invalid file id');
    return id;
};

const view = (row, { includeContent }) => {
    const base = {
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        scope: row.scope,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at
    };
    if (includeContent) {
        base.contentBase64 = Buffer.from(row.content).toString('base64');
    }
    return base;
};

// List file metadata (no content payloads) — health/inspection/backup checks.
router.get('/', async(_req, res) => {
    const result = await getPool().query(
        'SELECT id, file_name, mime_type, size_bytes, scope, metadata, created_at, updated_at FROM file_blobs ORDER BY updated_at DESC LIMIT 500'
    );
    res.json({ files: result.rows.map((row) => view(row, { includeContent: false })) });
});

router.get('/:id', async(req, res) => {
    const id = validateId(req.params.id);
    const result = await getPool().query('SELECT * FROM file_blobs WHERE id = $1', [id]);
    if (!result.rowCount) throw notFound(`File '${id}' not found`);
    res.json(view(result.rows[0], { includeContent: true }));
});

const upsert = async(req, res) => {
    const id = validateId(req.params.id);
    const body = req.body || {};
    const contentBase64 = body.contentBase64;
    if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
        throw badRequest('contentBase64 (string) is required');
    }
    // Decode here: `::bytea` would otherwise store the ASCII base64 *text*.
    const content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const bytes = content.length;
    if (bytes > MAX_FILE_BYTES) {
        throw Object.assign(new Error(`File exceeds the ${MAX_FILE_BYTES} byte limit`), { status: 413 });
    }
    const fileName = String(body.fileName || 'document').slice(0, 300);
    const mimeType = String(body.mimeType || 'application/octet-stream').slice(0, 150);
    const scope = String(body.scope || 'generic').slice(0, 60);
    const metadata = JSON.stringify(body.metadata && typeof body.metadata === 'object' ? body.metadata : {});

    const result = await getPool().query(
        `INSERT INTO file_blobs (id, file_name, mime_type, size_bytes, scope, metadata, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bytea, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           file_name = EXCLUDED.file_name,
           mime_type = EXCLUDED.mime_type,
           size_bytes = EXCLUDED.size_bytes,
           scope = EXCLUDED.scope,
           metadata = EXCLUDED.metadata,
           content = EXCLUDED.content,
           updated_at = now()
         RETURNING id, file_name, mime_type, size_bytes, scope, metadata, created_at, updated_at`,
        [id, fileName, mimeType, bytes, scope, metadata, content]
    );
    res.json({ success: true, file: view(result.rows[0], { includeContent: false }) });
};

router.put('/:id', upsert);
router.post('/:id', upsert);

router.delete('/:id', requireAdmin, async(req, res) => {
    const id = validateId(req.params.id);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw badRequest('A reason is required to delete a stored file.');
    const prior = await getPool().query('SELECT file_name FROM file_blobs WHERE id=$1', [id]);
    if (!prior.rowCount) return res.json({ success: true, deleted: false });
    const references = await getPool().query(
        `SELECT EXISTS(SELECT 1 FROM erp_state WHERE data::text LIKE $1) OR
                EXISTS(SELECT 1 FROM module_records WHERE data::text LIKE $1) AS referenced`, [`%${id}%`]
    );
    if (references.rows[0].referenced) return res.status(409).json({ error: 'This file is referenced by an ERP record and cannot be deleted.' });
    const result = await getPool().query('DELETE FROM file_blobs WHERE id = $1 RETURNING id', [id]);
    await auditSensitiveAction(req, { module: 'Files', recordId: id, recordLabel: prior.rows[0].file_name, action: 'DELETE', reason, before: prior.rows[0] });
    res.json({ success: true, deleted: result.rowCount > 0 });
});

export default router;
export { router };
