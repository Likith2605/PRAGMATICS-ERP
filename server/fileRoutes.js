import express from 'express';
import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, auditSensitiveAction } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';

/**
 * Central file storage API (Phase 1 of PG-first hardening).
 *
 * Stores binary attachments (project drawings, workflow documents) in the
 * `file_blobs` table so a database backup captures the complete ERP.
 * The `/content` endpoint streams the original bytes with their stored MIME.
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
const SHA256_RE = /^[a-f0-9]{64}$/i;
const FILE_READ_PERMISSIONS = ['sales.enquiry', 'job_card.view'];
const FILE_WRITE_PERMISSIONS = ['sales.enquiry', 'job_card.create'];

// Accepts URL-encoded ids (encodeURIComponent output may contain %XX).
const SAFE_ID = /^[A-Za-z0-9._:%-]{1,160}$/;

const validateId = (raw) => {
    const id = String(raw || '');
    if (!SAFE_ID.test(id)) throw badRequest('Invalid file id');
    return id;
};

const isAdministrator = (user) => user?.roleKey === 'admin' || user?.role === 'Administrator';

const ensureDrawingReference = async(req, id, metadata, { allowAdminOrphan = false } = {}) => {
    if (!metadata || typeof metadata !== 'object') throw notFound('Enquiry drawing not found');
    const projectId = String(metadata.projectId || '').trim();
    const drawingNo = String(metadata.drawingNo || '').trim();
    if (!projectId || !drawingNo ||
        id !== `drawing::${encodeURIComponent(projectId)}::${encodeURIComponent(drawingNo)}`) {
        throw notFound('Enquiry drawing not found');
    }

    const administrator = isAdministrator(req.user);
    if (!administrator && !hasPermissionForRole(req.user?.roleKey, FILE_READ_PERMISSIONS, req.user?.rolePermissions)) {
        throw Object.assign(new Error('Your selected department role cannot access Enquiry drawings.'), { status: 403 });
    }
    if (administrator && allowAdminOrphan) return;
    if (!administrator && !hasPermissionForRole(req.user?.roleKey, FILE_WRITE_PERMISSIONS, req.user?.rolePermissions) &&
        req.method !== 'GET' && req.method !== 'HEAD') {
        throw Object.assign(new Error('Your selected department role cannot upload Enquiry drawings.'), { status: 403 });
    }

    const project = await getPool().query(
        "SELECT data FROM module_records WHERE storage_key='projectRequests' AND record_id=$1",
        [projectId]
    );
    const items = project.rows[0]?.data?.items;
    const linkedItem = Array.isArray(items)
        ? items.find((item) => String(item?.drawingNo || '').trim() === drawingNo)
        : null;
    if (!linkedItem) {
        throw notFound('This drawing is not linked to an active Enquiry.');
    }
    if (linkedItem.drawingFileId && String(linkedItem.drawingFileId) !== id) {
        throw notFound('This file is not the attachment linked to the Enquiry drawing.');
    }
};

const view = (row, { includeContent }) => {
    const base = {
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        scope: row.scope,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        checksumSha256: row.checksum_sha256 || null,
        uploadedBy: row.uploaded_by || null,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at
    };
    if (includeContent) {
        base.contentBase64 = Buffer.from(row.content).toString('base64');
    }
    return base;
};

// List file metadata (no content payloads) — health/inspection/backup checks.
router.get('/', requireAdmin, async(_req, res) => {
    const result = await getPool().query(
        'SELECT id, file_name, mime_type, size_bytes, scope, metadata, checksum_sha256, uploaded_by, created_at, updated_at FROM file_blobs ORDER BY updated_at DESC LIMIT 500'
    );
    res.json({ files: result.rows.map((row) => view(row, { includeContent: false })) });
});

// Admin-only, read-only inventory for files whose existing bytes have not yet
// received a persisted checksum. The candidate hash is never approved here.
router.get('/integrity/checksum-review/inventory', requireAdmin, async(req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const pool = getPool();
    const [count, rows] = await Promise.all([
        pool.query("SELECT count(*)::integer AS total FROM file_blobs WHERE checksum_sha256 IS NULL AND scope='drawing' AND (metadata ? 'projectId' OR id LIKE 'drawing::%')"),
        pool.query(
            `SELECT id,file_name,mime_type,size_bytes,scope,metadata,created_at,updated_at
             FROM file_blobs WHERE checksum_sha256 IS NULL AND scope='drawing'
               AND (metadata ? 'projectId' OR id LIKE 'drawing::%')
             ORDER BY id LIMIT $1 OFFSET $2`, [limit, offset]
        )
    ]);
    res.json({ total: count.rows[0].total, limit, offset, files: rows.rows.map((row) => view(row, { includeContent: false })) });
});

// Admin reviews the exact PostgreSQL bytes and identity; this endpoint is
// read-only and returns a candidate SHA-256 without changing the row.
router.get('/integrity/checksum-review/:id', requireAdmin, async(req, res) => {
    const id = validateId(req.params.id);
    const result = await getPool().query('SELECT * FROM file_blobs WHERE id=$1', [id]);
    if (!result.rowCount) throw notFound(`File '${id}' not found`);
    const row = result.rows[0];
    if (row.scope !== 'drawing' || (!row.metadata?.projectId && !id.startsWith('drawing::'))) throw notFound(`Enquiry drawing '${id}' not found`);
    if (row.checksum_sha256) return res.status(409).json({ error: 'This attachment already has a checksum.' });
    const candidateChecksumSha256 = createHash('sha256').update(row.content).digest('hex');
    res.json({ ...view(row, { includeContent: true }), candidateChecksumSha256 });
});

// Checksum approval requires the Admin to supply a hash calculated from a
// trusted original and explicitly confirm the comparison. Only checksum and
// verification/audit metadata are written; content and updated_at are intact.
router.post('/integrity/checksum-review/:id/verify', requireAdmin, async(req, res) => {
    const id = validateId(req.params.id);
    const expected = String(req.body?.trustedOriginalSha256 || '').trim().toLowerCase();
    const method = String(req.body?.verificationMethod || '').trim();
    const reference = String(req.body?.verificationReference || '').trim().slice(0, 500);
    if (req.body?.confirmed !== true) throw badRequest('Explicit Admin confirmation is required.');
    if (!SHA256_RE.test(expected)) throw badRequest('A valid SHA-256 from the trusted original is required.');
    if (method !== 'trusted_original_sha256') throw badRequest('Verification must use a SHA-256 calculated from a trusted original.');
    if (!reference) throw badRequest('Identify the trusted original used for comparison.');

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT id,file_name,size_bytes,checksum_sha256,content FROM file_blobs
             WHERE id=$1 AND scope='drawing' AND (metadata ? 'projectId' OR id LIKE 'drawing::%') FOR UPDATE`, [id]
        );
        if (!current.rowCount) throw notFound(`File '${id}' not found`);
        if (current.rows[0].checksum_sha256) throw Object.assign(new Error('Attachment already has a checksum; no backfill was performed.'), { status: 409 });
        const actual = createHash('sha256').update(current.rows[0].content).digest('hex');
        if (actual !== expected) throw Object.assign(new Error('Trusted-original hash does not match PostgreSQL attachment content; no backfill was performed.'), { status: 409 });

        const updated = await client.query(
            `UPDATE file_blobs SET checksum_sha256=$2 WHERE id=$1 AND checksum_sha256 IS NULL
             AND scope='drawing' AND (metadata ? 'projectId' OR id LIKE 'drawing::%') RETURNING id,checksum_sha256`, [id, actual]
        );
        if (!updated.rowCount) throw Object.assign(new Error('Attachment checksum changed during review; reload the inventory.'), { status: 409 });
        await client.query(
            `INSERT INTO file_checksum_verifications(file_id,content_checksum_sha256,verified_by,verified_by_email,verification_method,verification_reference)
             VALUES($1,$2,$3,$4,$5,$6)`,
            [id, actual, String(req.user.id), String(req.user.email), method, reference]
        );
        await client.query(
            `INSERT INTO erp_audit_log(user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
             VALUES($1,$2,$3,'Files',$4,$5,'CHECKSUM_VERIFIED','Compared PostgreSQL attachment with trusted original',$6::jsonb,$7::jsonb)`,
            [String(req.user.id), String(req.user.email), String(req.user.role), id, current.rows[0].file_name,
                JSON.stringify({ checksumSha256: null, sizeBytes: Number(current.rows[0].size_bytes) }),
                JSON.stringify({ checksumSha256: actual, verificationMethod: method, verificationReference: reference })]
        );
        await client.query('COMMIT');
        res.json({ success: true, id, checksumSha256: actual, verifiedAt: new Date().toISOString() });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.get('/:id/content', async(req, res) => {
    const id = validateId(req.params.id);
    const result = await getPool().query('SELECT * FROM file_blobs WHERE id=$1', [id]);
    if (!result.rowCount) throw notFound(`File '${id}' not found`);
    const row = result.rows[0];
    if (row.scope === 'drawing') {
        await ensureDrawingReference(req, id, row.metadata, { allowAdminOrphan: true });
    }

    const content = Buffer.from(row.content);
    if (content.length !== Number(row.size_bytes)) {
        throw Object.assign(new Error(`Stored file '${id}' failed its size integrity check.`), { status: 409 });
    }
    const fileName = String(row.file_name || 'document');
    const asciiFileName = fileName.replace(/[^\x20-\x7e]|["\\;]/g, '_');
    const inline = String(row.mime_type || '').toLowerCase() === 'application/pdf';
    res.set({
        'Content-Type': String(row.mime_type || 'application/octet-stream').replace(/[\r\n]/g, ''),
        'Content-Length': String(content.length),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, no-store',
        'X-File-Id': row.id,
        'X-File-Metadata': Buffer.from(JSON.stringify(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {})).toString('base64url'),
        'X-File-Checksum-Sha256': row.checksum_sha256 || '',
        'X-File-Size-Bytes': String(content.length)
    });
    res.send(content);
});

router.get('/:id', async(req, res) => {
    const id = validateId(req.params.id);
    const result = await getPool().query('SELECT * FROM file_blobs WHERE id = $1', [id]);
    if (!result.rowCount) throw notFound(`File '${id}' not found`);
    const row = result.rows[0];
    if (row.scope === 'drawing') {
        await ensureDrawingReference(req, id, row.metadata, { allowAdminOrphan: true });
    }
    res.json(view(row, { includeContent: true }));
});

const upsert = async(req, res) => {
    const id = validateId(req.params.id);
    const body = req.body || {};
    if (body.ifAbsent === true && req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') {
        return res.status(403).json({ error: 'Administrator access is required for legacy attachment migration.' });
    }
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
    const fileMetadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    if (mimeType.toLowerCase() === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
        const header = content.subarray(0, Math.min(content.length, 1024)).indexOf(Buffer.from('%PDF-'));
        const eof = content.subarray(Math.max(0, content.length - 1024)).indexOf(Buffer.from('%%EOF'));
        if (mimeType.toLowerCase() !== 'application/pdf' || header < 0 || eof < 0) {
            throw badRequest('PDF attachments must have application/pdf MIME type and valid PDF signature markers.');
        }
    }
    if (scope === 'drawing') await ensureDrawingReference(req, id, fileMetadata);
    const metadata = JSON.stringify(fileMetadata);
    const checksum = createHash('sha256').update(content).digest('hex');
    const uploadedBy = String(req.user?.username || req.user?.email || req.user?.id || 'unknown').slice(0, 160);

    if (body.ifAbsent === true) {
        const inserted = await getPool().query(
            `INSERT INTO file_blobs (id,file_name,mime_type,size_bytes,scope,metadata,content,checksum_sha256,uploaded_by,created_at,updated_at)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::bytea,$8,$9,now(),now()) ON CONFLICT(id) DO NOTHING
             RETURNING id,file_name,mime_type,size_bytes,scope,metadata,checksum_sha256,uploaded_by,created_at,updated_at`,
            [id,fileName,mimeType,bytes,scope,metadata,content,checksum,uploadedBy]
        );
        if (!inserted.rowCount) return res.status(409).json({ error: 'A server attachment already exists; legacy import did not overwrite it.' });
        return res.json({ success: true, file: view(inserted.rows[0], { includeContent: false }) });
    }
    const result = await getPool().query(
        `INSERT INTO file_blobs (id, file_name, mime_type, size_bytes, scope, metadata, content, checksum_sha256, uploaded_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bytea, $8, $9, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           file_name = EXCLUDED.file_name,
           mime_type = EXCLUDED.mime_type,
           size_bytes = EXCLUDED.size_bytes,
           scope = EXCLUDED.scope,
           metadata = EXCLUDED.metadata,
           content = EXCLUDED.content,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           uploaded_by = EXCLUDED.uploaded_by,
           updated_at = now()
         WHERE file_blobs.checksum_sha256 IS NOT NULL
            OR NOT (file_blobs.scope='drawing' AND (file_blobs.metadata ? 'projectId' OR file_blobs.id LIKE 'drawing::%'))
         RETURNING id, file_name, mime_type, size_bytes, scope, metadata, checksum_sha256, uploaded_by, created_at, updated_at`,
        [id, fileName, mimeType, bytes, scope, metadata, content, checksum, uploadedBy]
    );
    if (!result.rowCount) return res.status(409).json({ error: 'This existing attachment has no verified checksum and cannot be replaced until it is reviewed.' });
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
