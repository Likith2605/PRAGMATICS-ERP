import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, auditSensitiveAction } from './auth.js';

const router = express.Router();

const generateId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * GET /api/tally-export/history
 * List all Tally export history records.
 */
router.get('/tally-export/history', async (_req, res) => {
  const result = await getPool().query(
    `SELECT id, export_date, export_type, date_from, date_to,
            transaction_types, masters_included, record_counts,
            file_names, export_status, generated_by,
            validation_summary, notes, total_amount, created_at, updated_at
     FROM tally_export_history
     ORDER BY export_date DESC, created_at DESC`
  );
  res.json({ exports: result.rows });
});

/**
 * GET /api/tally-export/history/:id
 * Get a single export record with its files.
 */
router.get('/tally-export/history/:id', async (req, res) => {
  const { id } = req.params;
  const exportResult = await getPool().query(
    `SELECT * FROM tally_export_history WHERE id = $1`,
    [id]
  );
  if (!exportResult.rowCount) {
    return res.status(404).json({ error: 'Export record not found' });
  }

  const filesResult = await getPool().query(
    `SELECT id, file_name, file_type, content_type, size_bytes, created_at
     FROM tally_export_files
     WHERE export_id = $1
     ORDER BY file_type, file_name`,
    [id]
  );

  res.json({
    export: exportResult.rows[0],
    files: filesResult.rows
  });
});

/**
 * GET /api/tally-export/file/:exportId/:fileType
 * Download a generated XML file (master or voucher).
 */
router.get('/tally-export/file/:exportId/:fileType', async (req, res) => {
  const { exportId, fileType } = req.params;
  if (!['master', 'voucher'].includes(fileType)) {
    return res.status(400).json({ error: 'Invalid file type' });
  }

  const result = await getPool().query(
    `SELECT f.file_name, f.content_type, f.content, f.size_bytes
     FROM tally_export_files f
     JOIN tally_export_history h ON h.id = f.export_id
     WHERE f.export_id = $1 AND f.file_type = $2`,
    [exportId, fileType]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'Export file not found' });
  }

  const row = result.rows[0];
  const buffer = Buffer.from(row.content); // bytea comes back as Buffer

  res.setHeader('Content-Type', row.content_type || 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
  res.setHeader('Content-Length', row.size_bytes);
  res.send(buffer);
});

/**
 * POST /api/tally-export/history
 * Save a completed export record (called after XML generation on the server,
 * or after client-side generation when the server stores metadata).
 */
router.post('/tally-export/history', async (req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const {
      date_from,
      date_to,
      transaction_types = [],
      masters_included = [],
      record_counts = {},
      file_names = [],
      export_status = 'generated',
      generated_by = '',
      validation_summary = {},
      notes = '',
      total_amount = 0
    } = req.body || {};

    const requestedVoucherKeys = Array.isArray(validation_summary?.voucherKeys) ? validation_summary.voucherKeys : [];
    if (requestedVoucherKeys.length) {
      // Serialize export reservations without a schema change so two browser tabs
      // cannot concurrently reserve the same voucher references.
      await client.query('SELECT pg_advisory_xact_lock(739251, 1)');
      const priorExports = await client.query(
        `SELECT validation_summary->'voucherKeys' AS voucher_keys
         FROM tally_export_history
         WHERE export_status NOT IN ('failed', 'import_failed')
           AND (export_status <> 'pending' OR export_date > now() - interval '30 minutes')`
      );
      const exportedKeys = new Set(priorExports.rows.flatMap((row) => {
        if (Array.isArray(row.voucher_keys)) return row.voucher_keys;
        if (typeof row.voucher_keys === 'string') {
          try { return JSON.parse(row.voucher_keys); } catch { return []; }
        }
        return [];
      }));
      const duplicates = requestedVoucherKeys.filter((key) => exportedKeys.has(key));
      if (duplicates.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DUPLICATE_VOUCHERS',
          error: `Export blocked: ${duplicates.length} voucher(s) were already generated successfully.`,
          duplicates
        });
      }
    }

    const id = generateId();

    await client.query(
      `INSERT INTO tally_export_history
        (id, date_from, date_to, transaction_types, masters_included,
         record_counts, file_names, export_status, generated_by,
         validation_summary, notes, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        date_from,
        date_to,
        JSON.stringify(transaction_types),
        JSON.stringify(masters_included),
        JSON.stringify(record_counts),
        JSON.stringify(file_names),
        export_status,
        generated_by,
        JSON.stringify(validation_summary),
        notes,
        total_amount
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, id, export_date: new Date().toISOString() });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

/**
 * POST /api/tally-export/files
 * Store generated XML file content for an export record.
 */
router.post('/tally-export/files', async (req, res) => {
  const {
    export_id,
    file_name,
    file_type,
    content_base64,
    content_type = 'application/xml'
  } = req.body || {};

  if (!export_id || !file_name || !file_type || !content_base64) {
    return res.status(400).json({ error: 'export_id, file_name, file_type, and content_base64 are required' });
  }

  if (!['master', 'voucher'].includes(file_type)) {
    return res.status(400).json({ error: 'file_type must be master or voucher' });
  }

  const id = generateId();
  const buffer = Buffer.from(content_base64, 'base64');

  await getPool().query(
    `INSERT INTO tally_export_files
       (id, export_id, file_name, file_type, content, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, export_id, file_name, file_type, buffer, content_type, buffer.length]
  );

  res.status(201).json({ success: true, id, size_bytes: buffer.length });
});

/**
 * PATCH /api/tally-export/history/:id
 * Update export status (e.g. mark as downloaded).
 */
router.patch('/tally-export/history/:id', async (req, res) => {
  const { id } = req.params;
  const { export_status, notes } = req.body || {};

  const result = await getPool().query(
    `UPDATE tally_export_history
     SET export_status = COALESCE($1, export_status),
         notes = COALESCE($2, notes),
         updated_at = now()
     WHERE id = $3
     RETURNING id, export_status, notes, updated_at`,
    [export_status, notes, id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'Export record not found' });
  }

  res.json({ success: true, export: result.rows[0] });
});

/**
 * DELETE /api/tally-export/history/:id
 * Delete an export record and its files.
 */
router.delete('/tally-export/history/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to delete export history.' });
  const prior = await getPool().query('SELECT export_date,export_type,export_status FROM tally_export_history WHERE id=$1', [id]);
  if (!prior.rowCount) return res.json({ success: true, deleted: false });
  if (!['failed', 'import_failed'].includes(String(prior.rows[0].export_status).toLowerCase())) return res.status(409).json({ error: 'Completed export history is retained and cannot be deleted.' });
  const result = await getPool().query(
    'DELETE FROM tally_export_history WHERE id = $1 RETURNING id',
    [id]
  );
  await auditSensitiveAction(req, { module: 'Tally Export', recordId: id, action: 'DELETE', reason, before: prior.rows[0] });
  res.json({ success: true, deleted: result.rowCount > 0 });
});

export default router;
