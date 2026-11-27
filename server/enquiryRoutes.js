import express from 'express';
import { createHash } from 'node:crypto';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';
import { findChangedContactValidationError } from '../shared/fieldValidation.js';

const router = express.Router();
const KEY = 'projectRequests';
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const TOKEN_RE = /^[A-Za-z0-9._:-]{8,120}$/;
const MAX_RECORD_BYTES = Number(process.env.MAX_RECORD_ITEM_BYTES || 2 * 1024 * 1024);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const view = (row) => ({ ...row.data, projectId: row.record_id, version: Number(row.version), updatedAt: row.updated_at?.toISOString?.() || row.updated_at });
const canonicalJSON = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
};
const drawingFileId = (projectId, drawingNo) =>
    `drawing::${encodeURIComponent(projectId)}::${encodeURIComponent(drawingNo)}`;

const validateDrawingReferences = async (client, projectId, data) => {
    for (const item of data.items || []) {
        const fileId = String(item?.drawingFileId || '').trim();
        if (!fileId) continue;
        const drawingNo = String(item?.drawingNo || '').trim();
        if (!drawingNo || fileId !== drawingFileId(projectId, drawingNo)) {
            throw badRequest(`Drawing attachment reference for '${drawingNo || 'unknown drawing'}' is invalid.`);
        }

        const result = await client.query(
            `SELECT file_name,size_bytes,metadata,content,checksum_sha256
             FROM file_blobs WHERE id=$1 AND scope='drawing' FOR SHARE`,
            [fileId]
        );
        if (!result.rowCount) throw badRequest(`Drawing attachment '${drawingNo}' must be uploaded before it can be linked.`);
        const file = result.rows[0];
        const metadata = typeof file.metadata === 'string' ? JSON.parse(file.metadata) : file.metadata;
        const bytes = Buffer.from(file.content || []);
        const checksum = createHash('sha256').update(bytes).digest('hex');
        if (String(metadata?.projectId || '') !== String(projectId) ||
            String(metadata?.drawingNo || '') !== drawingNo ||
            bytes.length === 0 ||
            bytes.length !== Number(file.size_bytes) ||
            !file.checksum_sha256 ||
            String(file.checksum_sha256).toLowerCase() !== checksum) {
            throw badRequest(`Drawing attachment '${drawingNo}' failed its PostgreSQL linkage or integrity check.`);
        }
    }
};
router.use((req, res, next) => {
    if (req.user?.roleKey === 'admin' || req.user?.role === 'Administrator') return next();
    const required = ['GET', 'HEAD'].includes(req.method)
        ? ['sales.enquiry', 'job_card.view']
        : ['sales.enquiry', 'job_card.create'];
    if (req.user?.department && hasPermissionForRole(req.user.roleKey, required, req.user.rolePermissions)) return next();
    return res.status(403).json({ error: 'Your selected department role does not allow this Enquiry operation.' });
});

const validateEnquiry = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('Enquiry data is required.');
    if (JSON.stringify(data).length > MAX_RECORD_BYTES) throw Object.assign(new Error('Enquiry exceeds the configured record size limit.'), { status: 413 });
    if (!String(data.customerName || '').trim() || !String(data.companyName || '').trim()) throw badRequest('Customer and company names are required.');
    if (!String(data.requestedDate || '').trim() || !String(data.address || '').trim()) throw badRequest('Requested date and address are required.');
    if (!Array.isArray(data.items) || !data.items.some((item) => String(item?.itemName || '').trim() && Number(item?.quantity) > 0)) throw badRequest('At least one enquiry item with a name and positive quantity is required.');
    const contactError = findChangedContactValidationError(data);
    if (contactError) throw badRequest(contactError);
};

const audit = (client, req, { id, action, before = null, after = null, reason = '' }) => client.query(
    `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES ($1,$2,$3,'projectRequests',$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING id`,
    [req.user.id, req.user.email, req.user.role, id, after?.companyName || before?.companyName || id, action, reason,
        before == null ? null : JSON.stringify(safeAuditValues(before)),
        after == null ? null : JSON.stringify(safeAuditValues(after))]
);

router.get('/', async (_req, res) => {
    const result = await getPool().query(
        'SELECT record_id, data, version, updated_at FROM module_records WHERE storage_key=$1 ORDER BY updated_at DESC, record_id', [KEY]
    );
    res.json({ records: result.rows.map(view) });
});

// Side-by-side migration input only. Neither source is imported until the user
// reviews the preview and explicitly confirms the missing-record import.
router.get('/migration-preview', async (_req, res) => {
    const pool = getPool();
    const [active, legacy] = await Promise.all([
        pool.query('SELECT record_id, data, version, updated_at FROM module_records WHERE storage_key=$1 ORDER BY record_id', [KEY]),
        pool.query("SELECT data,updated_at FROM erp_state WHERE storage_key=$1", [KEY])
    ]);
    const legacyRecords = Array.isArray(legacy.rows[0]?.data) ? legacy.rows[0].data : [];
    const tombstones = await pool.query('SELECT record_id,deleted_at FROM enquiry_tombstones ORDER BY deleted_at DESC');
    const activeById = new Map(active.rows.map((row) => [row.record_id, row]));
    const candidates = new Map();
    const conflicts = [];
    const deletedIds = new Set(tombstones.rows.map((row) => row.record_id));
    for (const item of legacyRecords) {
        const id = String(item?.projectId || item?.id || '').trim();
        if (!id) continue;
        const current = activeById.get(id);
        if (deletedIds.has(id)) continue;
        if (current) {
            const data = { ...item }; delete data.projectId; delete data.id; delete data.version; delete data.updatedAt;
            if (canonicalJSON(current.data) !== canonicalJSON(data)) conflicts.push({ id, serverVersion: Number(current.version) });
            continue;
        }
        if (!candidates.has(id)) candidates.set(id, item);
        else if (canonicalJSON(candidates.get(id)) !== canonicalJSON(item)) conflicts.push({ id, reason: 'duplicate_legacy_id' });
    }
    res.json({ records: active.rows.map(view), eligible: [...candidates.values()], existing: active.rows.map((row) => row.record_id), conflicts, deleted: tombstones.rows, legacyRecords, legacyUpdatedAt: legacy.rows[0]?.updated_at || null });
});

router.get('/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) throw badRequest('Invalid enquiry ID.');
    const result = await getPool().query(
        'SELECT record_id,data,version,updated_at FROM module_records WHERE storage_key=$1 AND record_id=$2',
        [KEY, id]
    );
    if (!result.rowCount) throw notFound(`Enquiry '${id}' was not found in PostgreSQL.`);
    res.json({ record: view(result.rows[0]) });
});

router.post('/migration-preview/import-missing', requireAdmin, async (req, res) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    if (records.length > 2000) throw badRequest('Migration preview is limited to 2000 records per import.');
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        // Serialize imports with ID allocation so an imported legacy number
        // cannot race a new enquiry and collide with its sequence.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('projectRequests-sequence'))");
        const imported = [];
        const existing = [];
        const conflicts = [];
        const deleted = [];
        for (const item of records) {
            const id = String(item?.projectId || item?.id || '').trim();
            const data = { ...item };
            delete data.version;
            delete data.updatedAt;
            delete data.projectId;
            delete data.id;
            if (!ID_RE.test(id)) throw badRequest(`Invalid enquiry ID '${id.slice(0, 60)}'.`);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest(`Invalid enquiry data for '${id}'.`);
            if (JSON.stringify(data).length > MAX_RECORD_BYTES) throw Object.assign(new Error(`Enquiry '${id}' exceeds the migration size limit.`), { status: 413 });
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`projectRequests-id:${id}`]);
            const tombstone = await client.query('SELECT 1 FROM enquiry_tombstones WHERE record_id=$1', [id]);
            if (tombstone.rowCount) { deleted.push(id); continue; }
            const current = await client.query('SELECT data,version FROM module_records WHERE storage_key=$1 AND record_id=$2 FOR UPDATE', [KEY, id]);
            if (current.rowCount) {
                if (canonicalJSON(current.rows[0].data) === canonicalJSON(data)) existing.push(id);
                else conflicts.push({ id, serverVersion: Number(current.rows[0].version) });
                continue;
            }
            await validateDrawingReferences(client, id, data);
            await client.query('INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by) VALUES($1,$2,$3::jsonb,1,now(),$4)', [KEY, id, JSON.stringify(data), String(req.user.email || 'unknown').slice(0, 120)]);
            await audit(client, req, { id, action: 'MIGRATE_IMPORT', after: data });
            imported.push(id);
        }
        await client.query('COMMIT');
        res.json({ imported, alreadyPresent: existing, conflicts, deleted });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.post('/', async (req, res) => {
    const data = { ...(req.body?.data || {}) };
    const createToken = String(req.body?.createToken || '').trim();
    if (!TOKEN_RE.test(createToken)) throw badRequest('A valid enquiry create token is required.');
    validateEnquiry(data);
    const sequenceHint = Math.max(0, Math.floor(Number(req.body?.sequenceHint) || 0));
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('projectRequests-sequence'))");
        const usedToken = await client.query('SELECT record_id FROM enquiry_tombstones WHERE create_token=$1', [createToken]);
        if (usedToken.rowCount) throw Object.assign(new Error('This create token belongs to a permanently deleted Enquiry and cannot be reused.'), { status: 409 });
        const retry = await client.query('SELECT record_id,data,version,updated_at FROM module_records WHERE storage_key=$1 AND create_token=$2 FOR UPDATE', [KEY, createToken]);
        if (retry.rowCount) {
            await client.query('COMMIT');
            return res.json({ record: view(retry.rows[0]), idempotentReplay: true });
        }
        const maxResult = await client.query(
            `SELECT COALESCE(MAX(n),0) AS max_seq FROM (
               SELECT NULLIF(regexp_replace(record_id, '^.*-', ''), '')::bigint AS n
                 FROM module_records WHERE storage_key=$1 AND record_id ~ '-[0-9]+$'
               UNION ALL
               SELECT NULLIF(regexp_replace(elem->>'projectId', '^.*-', ''), '')::bigint AS n
                 FROM erp_state e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data)='array' THEN e.data ELSE '[]'::jsonb END) elem
                WHERE e.storage_key=$1 AND COALESCE(elem->>'projectId','') ~ '-[0-9]+$'
               UNION ALL
               SELECT NULLIF(regexp_replace(record_id, '^.*-', ''), '')::bigint AS n
                 FROM enquiry_tombstones WHERE record_id ~ '-[0-9]+$'
             ) ids`, [KEY]
        );
        const seq = Math.max(Number(maxResult.rows[0]?.max_seq || 0), sequenceHint) + 1;
        const now = new Date();
        const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric' })
            .formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
        const fyStart = dateParts.month >= 4 ? dateParts.year : dateParts.year - 1;
        const projectId = `PE-${String(fyStart).slice(-2)}${String(fyStart + 1).slice(-2)}-${String(seq).padStart(4, '0')}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`projectRequests-id:${projectId}`]);
        const reserved = await client.query('SELECT 1 FROM enquiry_tombstones WHERE record_id=$1', [projectId]);
        if (reserved.rowCount) throw Object.assign(new Error('Generated Enquiry ID is permanently reserved. Retry the create operation.'), { status: 409 });
        const validationError = findChangedContactValidationError(data);
        if (validationError) throw badRequest(validationError);
        const inserted = await client.query(
            `INSERT INTO module_records(storage_key,record_id,data,version,updated_at,updated_by,create_token)
             VALUES($1,$2,$3::jsonb,1,now(),$4,$5) RETURNING record_id,data,version,updated_at`,
            [KEY, projectId, JSON.stringify(data), String(req.user.email || 'unknown').slice(0, 120), createToken]
        );
        await audit(client, req, { id: projectId, action: 'CREATE', after: data });
        await client.query('COMMIT');
        res.status(201).json({ record: view(inserted.rows[0]), idempotentReplay: false });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.put('/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) throw badRequest('Invalid enquiry ID.');
    const version = Math.max(0, Math.floor(Number(req.body?.version) || 0));
    const data = { ...(req.body?.data || {}) };
    validateEnquiry(data);
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`projectRequests-id:${id}`]);
        const current = await client.query('SELECT data,version FROM module_records WHERE storage_key=$1 AND record_id=$2 FOR UPDATE', [KEY, id]);
        if (!current.rowCount) throw notFound('Enquiry not found. Refresh the list and try again.');
        if (Number(current.rows[0].version) !== version) {
            if (canonicalJSON(current.rows[0].data) === canonicalJSON(data)) {
                await client.query('COMMIT');
                return res.json({ record: { ...current.rows[0].data, projectId: id, version: Number(current.rows[0].version) }, idempotentReplay: true });
            }
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This enquiry changed in another session. Reload it and retry.', current: { ...current.rows[0].data, projectId: id, version: Number(current.rows[0].version) } });
        }
        const validationError = findChangedContactValidationError(data, current.rows[0].data);
        if (validationError) throw badRequest(validationError);
        await validateDrawingReferences(client, id, data);
        const saved = await client.query(
            'UPDATE module_records SET data=$3::jsonb,version=version+1,updated_at=now(),updated_by=$4 WHERE storage_key=$1 AND record_id=$2 RETURNING record_id,data,version,updated_at',
            [KEY, id, JSON.stringify(data), String(req.user.email || 'unknown').slice(0, 120)]
        );
        await audit(client, req, { id, action: 'UPDATE', before: current.rows[0].data, after: data });
        await client.query('COMMIT');
        res.json({ record: view(saved.rows[0]) });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) throw badRequest('Invalid enquiry ID.');
    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw badRequest('A reason is required to delete an enquiry.');
    const version = Math.max(0, Math.floor(Number(req.body?.version) || 0));
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const current = await client.query('SELECT data,version FROM module_records WHERE storage_key=$1 AND record_id=$2 FOR UPDATE', [KEY, id]);
        if (!current.rowCount) {
            await client.query('COMMIT');
            return res.json({ success: true, id, alreadyDeleted: true });
        }
        if (Number(current.rows[0].version) !== version) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'This enquiry changed in another session. Refresh before deleting.' });
        }
        const pattern = `%${id}%`;
        const refs = await client.query(
            `SELECT EXISTS(SELECT 1 FROM erp_state WHERE storage_key <> $1 AND data::text LIKE $2)
                  OR EXISTS(SELECT 1 FROM module_records WHERE storage_key <> $1 AND data::text LIKE $2)
                  OR EXISTS(SELECT 1 FROM customer_purchase_orders WHERE header_data::text LIKE $2)
                  OR EXISTS(SELECT 1 FROM customer_purchase_order_items WHERE item_data::text LIKE $2) AS referenced`, [KEY, pattern]
        );
        if (refs.rows[0]?.referenced) throw Object.assign(new Error('This enquiry is referenced by another business record and cannot be deleted.'), { status: 409 });
        const before = await client.query('SELECT create_token FROM module_records WHERE storage_key=$1 AND record_id=$2', [KEY, id]);
        const auditResult = await audit(client, req, { id, action: 'DELETE', reason, before: current.rows[0].data });
        await client.query(
            `INSERT INTO enquiry_tombstones(record_id,deleted_at,deleted_by,deleted_by_email,reason,before_values,create_token,audit_id)
             VALUES($1,now(),$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(record_id) DO NOTHING`,
            [id, String(req.user.id), String(req.user.email), reason, JSON.stringify(safeAuditValues(current.rows[0].data)), before.rows[0]?.create_token || null, auditResult.rows[0].id]
        );
        await client.query('DELETE FROM module_records WHERE storage_key=$1 AND record_id=$2 AND version=$3', [KEY, id, version]);
        await client.query('COMMIT');
        res.json({ success: true, id });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
});

export default router;
export { router };
