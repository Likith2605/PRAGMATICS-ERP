import express from 'express';
import { getPool } from './database.js';
import { findChangedContactValidationError } from '../shared/fieldValidation.js';
import { hasPermissionForRole } from './departmentAccess.js';

/**
 * Per-record API for shared modules (Phase 2: true multi-user safety).
 *
 * Each record is its own row in `module_records` with a version counter.
 * Clients send the version they last saw; the server only accepts a write
 * when the client's version is still current, otherwise it reports a conflict
 * and keeps the server copy. Two people editing DIFFERENT records can never
 * overwrite each other; editing the SAME record produces a visible conflict
 * instead of silent data loss.
 *
 *   GET  /api/records/:key          -> all records of a module list (with versions)
 *   PUT  /api/records/:key          -> save changed records + confirm deletes
 *        body: { records:[{id,data,version}], deletes:[{id,version}], updatedBy }
 *        response: { saved:[{id,version}], deleted:[id], conflicts:[{id,data,version,...}] }
 *
 * New modules are onboarded by adding their storage key to RECORD_KEYS below.
 */

const router = express.Router();

// Whitelist: only module-owned list keys live here (one authority per module).
const RECORD_KEYS = new Set(['inventoryItems', 'stockTransactions', 'productionDispatchRequests']);

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_ITEM_BYTES = Number(process.env.MAX_RECORD_ITEM_BYTES || 2 * 1024 * 1024);
const MAX_ITEMS_PER_PUT = Number(process.env.MAX_RECORD_ITEMS || 2000);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const admin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';
const requireRecordPermission = (req, res, key, mutation = false) => {
    if (admin(req)) return true;
    const required = key === 'inventoryItems'
        ? (mutation ? ['inventory.adjust'] : ['inventory.view'])
        : key === 'stockTransactions'
            ? (mutation ? ['inventory.adjust','material_issue.create','material_return.create','receipt.create','production.entry.create'] : ['inventory.transaction.view','material_issue.view'])
            : (mutation ? ['job_card.dispatch_request','delivery.create'] : ['job_card.view','delivery.view']);
    if (!hasPermissionForRole(req.user?.roleKey, required, req.user?.rolePermissions)) {
        res.status(403).json({ error: 'Your selected department role does not allow this record operation.' });
        return false;
    }
    return true;
};

const isSalesDispatchEditor = (req, key) => key === 'productionDispatchRequests' &&
    req.user?.department === 'Sales Department' && hasPermissionForRole(req.user?.roleKey, 'delivery.create', req.user?.rolePermissions);
const validateSalesDispatchEdit = (current, next) => {
    const workflowFields = new Set(['status','challanNumber','challanQuantity','dispatchedAt','dispatchedBy','audit']);
    const keys = new Set([...Object.keys(current || {}), ...Object.keys(next || {})]);
    for (const field of keys) {
        if (!workflowFields.has(field) && JSON.stringify(current?.[field]) !== JSON.stringify(next?.[field])) {
            return 'Sales may only update Delivery Challan and dispatch workflow fields on a Production Dispatch Request.';
        }
    }
    const allowedTransitions = { Pending: ['Challan Created'], 'Challan Created': ['Dispatched','Pending'] };
    if (next?.status !== current?.status && !allowedTransitions[current?.status]?.includes(next?.status)) {
        return 'This Production Dispatch Request cannot make that Sales workflow status transition.';
    }
    return null;
};

const validateKey = (raw) => {
    const key = String(raw || '');
    if (!SAFE_KEY.test(key) || !RECORD_KEYS.has(key)) {
        throw badRequest(`Unknown record key '${key}'. Allowed: ${[...RECORD_KEYS].join(', ')}`);
    }
    return key;
};

const validateId = (raw) => {
    const id = String(raw || '');
    if (!SAFE_ID.test(id)) throw badRequest(`Invalid record id '${id.slice(0, 40)}'`);
    return id;
};

const toVersion = (value) => {
    const version = Number(value);
    return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0;
};
const sensitiveStatusChange = (before, after) => {
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
    if (Array.isArray(before) || Array.isArray(after)) return false;
    for (const [key, value] of Object.entries(after)) {
        const prior = before[key];
        const field = key.toLowerCase();
        if ((field === 'status' && String(prior ?? '') !== String(value ?? '') && /cancel|reverse|deactivat|inactive|void/i.test(String(value))) ||
            (['active','isactive','enabled'].includes(field) && prior === true && value === false) ||
            (['cancelledat','canceledat','reversedat','deactivatedat','voidedat'].includes(field) && !prior && Boolean(value))) return true;
        if (value && prior && typeof value === 'object' && typeof prior === 'object' && sensitiveStatusChange(prior, value)) return true;
    }
    return false;
};
const insertAudit = async (client, req, { key, id, label, action, reason = '', before, after }) => client.query(
    `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [req.user.id, req.user.email, req.user.role, key, id, label || id, action, reason,
        before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)]
);

const view = (row) => ({
    id: row.record_id,
    data: row.data,
    version: Number(row.version),
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    updatedBy: row.updated_by
});

router.get('/:key', async(req, res) => {
    const key = validateKey(req.params.key);
    if (!requireRecordPermission(req, res, key, false)) return;
    const result = await getPool().query(
        'SELECT record_id, data, version, updated_at, updated_by FROM module_records WHERE storage_key = $1 ORDER BY record_id',
        [key]
    );
    res.json({
        key,
        records: result.rows.map(view),
        updatedAt: result.rows.at(-1)?.updated_at?.toISOString?.() || null
    });
});

router.put('/:key', async(req, res) => {
    const key = validateKey(req.params.key);
    const body = req.body || {};
    const records = Array.isArray(body.records) ? body.records : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    const updatedBy = String(req.user?.email || 'unknown').slice(0, 120);

    if (records.length + deletes.length === 0) {
        return res.json({ key, saved: [], deleted: [], conflicts: [] });
    }
    if (!requireRecordPermission(req, res, key, true)) return;
    if (records.length + deletes.length > MAX_ITEMS_PER_PUT) {
        throw badRequest(`Too many records in one save (max ${MAX_ITEMS_PER_PUT})`);
    }

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');

        const saved = [];
        const deleted = [];
        const conflicts = [];

        for (const entry of records) {
            const id = validateId(entry?.id);
            if (entry.data === undefined || entry.data === null) {
                throw badRequest(`Record '${id}' is missing data`);
            }
            const serialized = JSON.stringify(entry.data);
            if (serialized.length > MAX_ITEM_BYTES) {
                throw Object.assign(new Error(`Record '${id}' exceeds the size limit`), { status: 413 });
            }
            const incoming = toVersion(entry.version);

            if (isSalesDispatchEditor(req, key)) {
                const existing = await client.query('SELECT data FROM module_records WHERE storage_key = $1 AND record_id = $2', [key, id]);
                if (!existing.rowCount) throw Object.assign(new Error('Sales cannot create Production Dispatch Requests.'), { status: 403 });
                const salesError = validateSalesDispatchEdit(existing.rows[0].data, entry.data);
                if (salesError) throw Object.assign(new Error(salesError), { status: 403 });
            }

            // Absent -> insert. Version keeps increasing even across a
            // delete/recreate so an offline device can never "resurrect" a
            // record at an older version.
            const inserted = await client.query(
                `INSERT INTO module_records (storage_key, record_id, data, version, updated_at, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, now(), $5)
         ON CONFLICT (storage_key, record_id) DO NOTHING
         RETURNING version`,
                [key, id, serialized, incoming + 1, updatedBy]
            );
            if (inserted.rowCount) {
                const validationError = findChangedContactValidationError(entry.data);
                if (validationError) throw badRequest(validationError);
                await insertAudit(client, req, { key, id, label: entry.data?.itemName || entry.data?.name || id, action: 'CREATE', after: entry.data });
                saved.push({ id, version: Number(inserted.rows[0].version) });
                continue;
            }

            const current = await client.query(
                'SELECT data, version, updated_at, updated_by FROM module_records WHERE storage_key = $1 AND record_id = $2',
                [key, id]
            );
            const serverVersion = Number(current.rows[0].version);
            const afterData = entry.data;
            const sensitive = sensitiveStatusChange(current.rows[0].data, afterData);
            const reason = String(body.reasons?.[id] || entry.reason || body.reason || '').trim();
            if (sensitive && (req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator')) {
                throw Object.assign(new Error('Administrator access is required for cancellation, reversal, or deactivation.'), { status: 403 });
            }
            if (sensitive && !reason) throw Object.assign(new Error(`A reason is required to change this record status (${id}).`), { status: 400 });
            if (incoming < serverVersion) {
                // Someone else saved this record first — keep the server copy
                // and tell the client so it can show the latest data.
                conflicts.push(view({ record_id: id, ...current.rows[0] }));
                continue;
            }
            const validationError = findChangedContactValidationError(entry.data, current.rows[0].data);
            if (validationError) throw badRequest(validationError);
            const updated = await client.query(
                `UPDATE module_records SET data = $3::jsonb, version = version + 1, updated_at = now(), updated_by = $4
         WHERE storage_key = $1 AND record_id = $2 AND version = $5
         RETURNING version`,
                [key, id, serialized, updatedBy, incoming]
            );
            if (!updated.rowCount) {
                const latest = await client.query(
                    'SELECT record_id, data, version, updated_at, updated_by FROM module_records WHERE storage_key = $1 AND record_id = $2',
                    [key, id]
                );
                if (latest.rowCount) conflicts.push(view(latest.rows[0]));
                continue;
            }
            await insertAudit(client, req, { key, id, label: afterData?.itemName || afterData?.name || id, action: sensitive ? 'CONTROLLED_STATUS_CHANGE' : 'UPDATE', reason, before: current.rows[0].data, after: afterData });
            saved.push({ id, version: Number(updated.rows[0].version) });
        }

        for (const entry of deletes) {
            if (key === 'stockTransactions' || key === 'productionDispatchRequests') {
                throw Object.assign(new Error('This record type must be reversed or cancelled through its controlled workflow; permanent deletion is not allowed.'), { status: 409 });
            }
            if (req.user?.roleKey !== 'admin' && req.user?.role !== 'Administrator') {
                throw Object.assign(new Error('Administrator access is required to delete shared records.'), { status: 403 });
            }
            const id = validateId(entry?.id);
            const reason = String(entry?.reason || body.reasons?.[id] || body.reason || '').trim();
            if (!reason) throw Object.assign(new Error(`A reason is required to delete record '${id}'.`), { status: 400 });
            const incoming = toVersion(entry?.version);
            const result = await client.query(
                'SELECT data,version FROM module_records WHERE storage_key = $1 AND record_id = $2',
                [key, id]
            );
            if (!result.rowCount) {
                deleted.push(id); // already gone — nothing to do
                continue;
            }
            const serverVersion = Number(result.rows[0].version);
            if (incoming < serverVersion) {
                const full = await client.query(
                    'SELECT record_id, data, version, updated_at, updated_by FROM module_records WHERE storage_key = $1 AND record_id = $2',
                    [key, id]
                );
                conflicts.push(view(full.rows[0]));
                continue;
            }
            if (key === 'inventoryItems') {
                const item = result.rows[0].data || {};
                if (Number(item.currentQty || 0) !== 0 || Number(item.reservedQty || 0) !== 0) {
                    throw Object.assign(new Error('Inventory items with stock or reserved quantity cannot be deleted.'), { status: 409 });
                }
                const history = await client.query("SELECT data FROM erp_state WHERE storage_key = ANY($1::text[])", [['stockIssueHistory','stockReturnHistory','materialReceipts','purchaseOrders','salesOrders','productionJobCards','qualityChecks','inventoryBatches']]);
                const tx = await client.query("SELECT data FROM module_records WHERE storage_key='stockTransactions'");
                const needles = [id, item.itemCode, item.code, item.itemName, item.name].filter(Boolean).map(String);
                const refers = (value, parentKey = '') => {
                    if (Array.isArray(value)) return value.some((v) => refers(v, parentKey));
                    if (!value || typeof value !== 'object') return ['itemid','inventoryitemid','materialid','itemcode','materialcode','itemname','materialname','item'].includes(parentKey.toLowerCase()) && needles.includes(String(value));
                    return Object.entries(value).some(([field, child]) => refers(child, field));
                };
                if ([...history.rows.map((row) => row.data), ...tx.rows.map((row) => row.data)].some((value) => refers(value))) {
                    throw Object.assign(new Error('Inventory items referenced by transaction, purchase, sales, production, or quality history cannot be deleted.'), { status: 409 });
                }
            }
            const before = result.rows[0].data;
            await client.query('DELETE FROM module_records WHERE storage_key = $1 AND record_id = $2', [key, id]);
            await insertAudit(client, req, { key, id, label: before?.itemName || before?.itemCode || before?.name || id, action: 'DELETE', reason, before });
            deleted.push(id);
        }

        await client.query('COMMIT');
        res.json({ key, saved, deleted, conflicts });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

export default router;
export { router, RECORD_KEYS };
