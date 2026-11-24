/**
 * Reverse sync: mobile QC server -> ERP Quality Module.
 *
 * Ownership model (no conflicts by design):
 *   - ERP owns drawings + dimensions: pulled rows are INSERTED ONLY when the
 *     ERP does not already have them (the ERP never overwrites its own copy).
 *   - Mobile owns inspection results: checks, measurements, dispatches and
 *     instruments recorded on the phone are upserted into the ERP as-is.
 *   - Tombstones (deletions made on the phone) are applied last.
 *
 * Identity mapping:
 *   - quality_checks.id      = QC check client_id (text PK - no migration)
 *   - quality_dispatches     = keyed by dispatch_no
 *   - quality_instruments    = keyed by name
 *   - drawings/dimensions    = keyed by drawing_no / (drawing_id, dim_no)
 *   - measurements           = delete+reinsert per check (only rewritten when
 *                              the values actually changed - no 30s churn)
 *
 * Runs on a timer started from server.js (QC_PULL_INTERVAL_MS, default 30s).
 */

import { randomUUID } from 'node:crypto';
import { getPool } from './database.js';
import { getQcServerUrl, pullFromQualityServer } from './qcSyncClient.js';

const str = (v) => (v == null ? '' : String(v));
export const normalizeQualityNumber = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const num = normalizeQualityNumber;
const num0 = (v) => num(v) ?? 0;
const int = (v) => {
  const n = num(v);
  return n == null ? 0 : Math.trunc(n);
};
const intOrNull = (v) => {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
};
const SAMPLE_COLS = ['sample1', 'sample2', 'sample3', 'sample4', 'sample5', 'sample6', 'sample7', 'sample8', 'sample9', 'sample10'];

/* ------------------------------------------------------------------ */
/* One sync pass                                                       */
/* ------------------------------------------------------------------ */

export async function syncInspectionResultsOnce() {
  const payload = await pullFromQualityServer();

  const employees = new Map((payload.employees || []).map((e) => [Number(e.id), e]));
  const measurementsByCheck = new Map();
  for (const m of payload.measurements || []) {
    const key = Number(m.check_id);
    if (!measurementsByCheck.has(key)) measurementsByCheck.set(key, []);
    measurementsByCheck.get(key).push(m);
  }

  const stats = {
    server: getQcServerUrl(),
    drawings: 0,       // newly inserted (ERP-owned, insert-if-missing)
    dimensions: 0,     // newly inserted
    checksInserted: 0,
    checksUpdated: 0,
    measurements: 0,   // rows actually written (rewritten or new)
    dispatchesInserted: 0,
    dispatchesUpdated: 0,
    instrumentsInserted: 0,
    instrumentsUndeleted: 0,
    deleted: 0,        // tombstones applied
  };

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    /* 1. Drawings: insert-if-missing (ERP owns these). */
    const drawingIdByQcId = new Map();
    const drawingIdByNo = new Map();
    for (const dw of payload.drawings || []) {
      const drawingNo = str(dw.drawing_no).trim();
      if (!drawingNo) continue;
      let row = (await client.query('SELECT id FROM quality_drawings WHERE drawing_no=$1', [drawingNo])).rows[0];
      if (!row) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO quality_drawings (id, drawing_no, part_name, customer, revision, material, unit, notes, po_no, qty, treatment, hardness, image_uri)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id, drawingNo, str(dw.part_name), str(dw.customer), str(dw.revision), str(dw.material),
            str(dw.unit) || 'mm', str(dw.notes), str(dw.po_no), int(dw.qty), str(dw.treatment),
            str(dw.hardness), str(dw.image_uri),
          ]
        );
        stats.drawings++;
        row = { id };
      }
      drawingIdByQcId.set(Number(dw.id), row.id);
      drawingIdByNo.set(drawingNo, row.id);
    }

    /* 2. Dimensions: insert-if-missing (ERP owns these). */
    const dimIdByQcId = new Map();
    for (const dim of payload.dimensions || []) {
      const erpDrawingId = drawingIdByQcId.get(Number(dim.drawing_id));
      const dimNo = intOrNull(dim.dim_no);
      if (!erpDrawingId || dimNo == null) continue;
      let row = (
        await client.query('SELECT id FROM quality_dimensions WHERE drawing_id=$1 AND dim_no=$2', [erpDrawingId, dimNo])
      ).rows[0];
      if (!row) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO quality_dimensions (id, drawing_id, dim_no, description, nominal, nominal_text, tol_upper, tol_lower)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id, erpDrawingId, dimNo, str(dim.description), num0(dim.nominal), str(dim.nominal_text),
            num0(dim.tol_upper), num0(dim.tol_lower),
          ]
        );
        stats.dimensions++;
        row = { id };
      }
      dimIdByQcId.set(Number(dim.id), row.id);
    }

    /* 3. Checks (mobile owns) - upsert by client_id, only write when changed. */
    const checkIds = [];
    for (const chk of payload.checks || []) {
      const clientId =
        str(chk.client_id).trim() || (chk.id != null && chk.id !== '' ? `qc-${int(chk.id)}` : '');
      const erpDrawingId = drawingIdByQcId.get(Number(chk.drawing_id));
      if (!clientId || !erpDrawingId) continue;

      const emp = employees.get(Number(chk.checked_by));
      const values = {
        drawing_id: erpDrawingId,
        checked_by: emp ? str(emp.employee_id) : str(chk.checked_by),
        inspector_name: str(chk.inspector_name) || (emp ? str(emp.name) : ''),
        checked_at: str(chk.checked_at) || new Date().toISOString(),
        result: str(chk.result) || 'Pending',
        instrument: str(chk.instrument),
        inspector_notes: str(chk.inspector_notes),
      };

      const existing = (
        await client.query(
          `SELECT drawing_id, checked_by, inspector_name, checked_at, result, instrument, inspector_notes, deleted
           FROM quality_checks WHERE id=$1`,
          [clientId]
        )
      ).rows[0];

      if (!existing) {
        await client.query(
          `INSERT INTO quality_checks (id, drawing_id, checked_by, inspector_name, checked_at, result, instrument, inspector_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [clientId, values.drawing_id, values.checked_by, values.inspector_name, values.checked_at,
            values.result, values.instrument, values.inspector_notes]
        );
        stats.checksInserted++;
      } else if (
        existing.deleted !== 0 ||
        existing.drawing_id !== values.drawing_id ||
        existing.checked_by !== values.checked_by ||
        existing.inspector_name !== values.inspector_name ||
        new Date(existing.checked_at).getTime() !== new Date(values.checked_at).getTime() ||
        existing.result !== values.result ||
        existing.instrument !== values.instrument ||
        existing.inspector_notes !== values.inspector_notes
      ) {
        await client.query(
          `UPDATE quality_checks SET drawing_id=$2, checked_by=$3, inspector_name=$4, checked_at=$5,
             result=$6, instrument=$7, inspector_notes=$8, deleted=0, updated_at=now()
           WHERE id=$1`,
          [clientId, values.drawing_id, values.checked_by, values.inspector_name, values.checked_at,
            values.result, values.instrument, values.inspector_notes]
        );
        stats.checksUpdated++;
      }
      checkIds.push({ clientId, qcId: Number(chk.id) });
    }

    /* 4. Measurements: per check, delete+reinsert - but skip when unchanged. */
    for (const { clientId, qcId } of checkIds) {
      const incoming = measurementsByCheck.get(qcId) || [];
      const rows = [];
      for (const m of incoming) {
        const erpDimId = dimIdByQcId.get(Number(m.dimension_id));
        if (!erpDimId) continue; // dimension unknown to the ERP - cannot attach
        rows.push({
          id: randomUUID(),
          check_id: clientId,
          dimension_id: erpDimId,
          samples: SAMPLE_COLS.map((col) => num(m[col])),
          remarks: str(m.remarks),
          pass: intOrNull(m.pass),
          instrument: str(m.instrument),
          sample_status: str(m.sample_status),
        });
      }

      const existing = (
        await client.query(
          `SELECT id, dimension_id, ${SAMPLE_COLS.join(', ')}, remarks, pass, instrument, sample_status
           FROM quality_measurements WHERE check_id=$1`,
          [clientId]
        )
      ).rows;

      if (existing.length || rows.length) {
        const same =
          existing.length === rows.length &&
          rows.every((r) => {
            const old = existing.find((e) => e.id === r.id || e.dimension_id === r.dimension_id);
            if (!old) return false;
            if (str(old.remarks) !== r.remarks || str(old.instrument) !== r.instrument ||
                str(old.sample_status) !== r.sample_status) return false;
            if ((old.pass ?? null) !== r.pass) return false;
            return SAMPLE_COLS.every((col, i) => (old[col] ?? null) === r.samples[i]);
          });

        if (!same) {
          await client.query('DELETE FROM quality_measurements WHERE check_id=$1', [clientId]);
          for (const r of rows) {
            await client.query(
              `INSERT INTO quality_measurements (id, check_id, dimension_id, ${SAMPLE_COLS.join(', ')}, remarks, pass, instrument, sample_status)
               VALUES ($1,$2,$3,${SAMPLE_COLS.map((_, i) => `$${i + 4}`).join(',')},$14,$15,$16,$17)`,
              [r.id, r.check_id, r.dimension_id, ...r.samples, r.remarks, r.pass, r.instrument, r.sample_status]
            );
            stats.measurements++;
          }
        }
      }
    }

    /* 5. Dispatches (mobile owns) - keyed by dispatch_no. */
    for (const dp of payload.dispatches || []) {
      const dispatchNo = str(dp.dispatch_no).trim();
      const erpDrawingId =
        drawingIdByQcId.get(Number(dp.drawing_id)) ||
        drawingIdByNo.get(str(dp.drawing_no).trim());
      if (!dispatchNo || !erpDrawingId) continue;

      const values = {
        drawing_id: erpDrawingId,
        drawing_no: str(dp.drawing_no),
        part_name: str(dp.part_name),
        po_no: str(dp.po_no),
        invoice_no: str(dp.invoice_no),
        qty: int(dp.qty),
        dispatched_by: str(dp.dispatched_by),
        dispatched_at: str(dp.dispatched_at) || new Date().toISOString(),
        notes: str(dp.notes),
      };

      const existing = (
        await client.query(
          `SELECT id, drawing_id, drawing_no, part_name, po_no, invoice_no, qty, dispatched_by, dispatched_at, notes, deleted
           FROM quality_dispatches WHERE dispatch_no=$1`,
          [dispatchNo]
        )
      ).rows[0];

      if (!existing) {
        await client.query(
          `INSERT INTO quality_dispatches (id, dispatch_no, drawing_id, drawing_no, part_name, po_no, invoice_no, qty, dispatched_by, dispatched_at, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [randomUUID(), dispatchNo, values.drawing_id, values.drawing_no, values.part_name, values.po_no,
            values.invoice_no, values.qty, values.dispatched_by, values.dispatched_at, values.notes]
        );
        stats.dispatchesInserted++;
      } else if (
        existing.deleted !== 0 ||
        existing.drawing_id !== values.drawing_id ||
        existing.drawing_no !== values.drawing_no ||
        existing.part_name !== values.part_name ||
        existing.po_no !== values.po_no ||
        existing.invoice_no !== values.invoice_no ||
        int(existing.qty) !== values.qty ||
        existing.dispatched_by !== values.dispatched_by ||
        new Date(existing.dispatched_at).getTime() !== new Date(values.dispatched_at).getTime() ||
        existing.notes !== values.notes
      ) {
        await client.query(
          `UPDATE quality_dispatches SET drawing_id=$3, drawing_no=$4, part_name=$5, po_no=$6, invoice_no=$7,
             qty=$8, dispatched_by=$9, dispatched_at=$10, notes=$11, deleted=0, updated_at=now()
           WHERE id=$1 AND dispatch_no=$2`,
          [existing.id, dispatchNo, values.drawing_id, values.drawing_no, values.part_name, values.po_no,
            values.invoice_no, values.qty, values.dispatched_by, values.dispatched_at, values.notes]
        );
        stats.dispatchesUpdated++;
      }
    }

    /* 6. Instruments (mobile owns) - keyed by name. */
    for (const ins of payload.instruments || []) {
      const name = str(ins.name).trim();
      if (!name) continue;
      const existing = (
        await client.query('SELECT id, deleted FROM quality_instruments WHERE name=$1', [name])
      ).rows[0];
      if (!existing) {
        await client.query('INSERT INTO quality_instruments (id, name) VALUES ($1,$2)', [randomUUID(), name]);
        stats.instrumentsInserted++;
      } else if (existing.deleted !== 0) {
        await client.query(
          'UPDATE quality_instruments SET deleted=0, updated_at=now() WHERE id=$1',
          [existing.id]
        );
        stats.instrumentsUndeleted++;
      }
    }

    /* 7. Tombstones - deletions made on the phone (applied last). */
    const delChecks = (payload.deleted_checks || []).map((v) => str(v).trim()).filter(Boolean);
    if (delChecks.length) {
      const r = await client.query(
        'UPDATE quality_checks SET deleted=1, updated_at=now() WHERE id = ANY($1) AND deleted=0',
        [delChecks]
      );
      stats.deleted += r.rowCount;
    }
    const delDispatches = (payload.deleted_dispatches || []).map((v) => str(v).trim()).filter(Boolean);
    if (delDispatches.length) {
      const r = await client.query(
        'UPDATE quality_dispatches SET deleted=1, updated_at=now() WHERE dispatch_no = ANY($1) AND deleted=0',
        [delDispatches]
      );
      stats.deleted += r.rowCount;
    }
    const delDrawings = (payload.deleted_drawings || []).map((v) => str(v).trim()).filter(Boolean);
    if (delDrawings.length) {
      const r = await client.query(
        'UPDATE quality_drawings SET deleted=1, updated_at=now() WHERE drawing_no = ANY($1) AND deleted=0',
        [delDrawings]
      );
      stats.deleted += r.rowCount;
    }
    const delInstruments = (payload.deleted_instruments || []).map((v) => str(v).trim()).filter(Boolean);
    if (delInstruments.length) {
      const r = await client.query(
        'UPDATE quality_instruments SET deleted=1, updated_at=now() WHERE name = ANY($1) AND deleted=0',
        [delInstruments]
      );
      stats.deleted += r.rowCount;
    }
    const delDims = (payload.deleted_dimensions || []).filter((d) => d && d.drawing_no != null && d.dim_no != null);
    if (delDims.length) {
      const r = await client.query(
        `UPDATE quality_dimensions d SET deleted=1, updated_at=now()
         FROM quality_drawings dw
         WHERE dw.id = d.drawing_id AND d.deleted = 0
           AND (dw.drawing_no, d.dim_no) IN (
             SELECT unnest($1::text[]), unnest($2::int[])
           )`,
        [delDims.map((d) => str(d.drawing_no)), delDims.map((d) => int(d.dim_no))]
      );
      stats.deleted += r.rowCount;
    }

    await client.query('COMMIT');
    return stats;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

let intervalHandle = null;
let initialHandle = null;
let running = false;
let lastError = '';
let lastLog = '';

const changed = (s) =>
  s.drawings + s.dimensions + s.checksInserted + s.checksUpdated + s.measurements +
  s.dispatchesInserted + s.dispatchesUpdated + s.instrumentsInserted +
  s.instrumentsUndeleted + s.deleted;

async function tick() {
  if (running) return; // never overlap sync passes
  running = true;
  try {
    const stats = await syncInspectionResultsOnce();
    if (lastError) {
      console.log(`[QC-PULL] recovered: mobile QC server (${stats.server}) reachable again`);
      lastError = '';
    }
    // Silent when nothing new happened; log only real changes (rate-limited
    // so a chatty source cannot flood the log).
    const summary =
      `drawings +${stats.drawings} dims +${stats.dimensions} checks ${stats.checksInserted} ins/${stats.checksUpdated} upd` +
      ` meas ${stats.measurements} dispatches ${stats.dispatchesInserted} ins/${stats.dispatchesUpdated} upd` +
      ` instruments +${stats.instrumentsInserted} tombstones ${stats.deleted}`;
    if (changed(stats) > 0 && summary !== lastLog) {
      console.log(`[QC-PULL] synced from ${stats.server}: ${summary}`);
      lastLog = summary;
    } else if (changed(stats) > 0) {
      lastLog = summary;
    }
  } catch (err) {
    const message = err?.message || String(err);
    if (message !== lastError) {
      console.log(`[QC-PULL] sync with mobile QC server (${getQcServerUrl()}) failed: ${message}`);
      lastError = message;
    }
  } finally {
    running = false;
  }
}

/**
 * Start the periodic QC -> ERP pull. Idempotent: safe to call once from
 * server.js after migrations. Set QC_PULL_ENABLED=0 to disable, and
 * QC_PULL_INTERVAL_MS to change the period (default 30000).
 */
export function startQualityPullSync() {
  if (intervalHandle || initialHandle) return;
  const intervalMs = Number(process.env.QC_PULL_INTERVAL_MS || 30000);
  if (!Number.isFinite(intervalMs) || intervalMs < 5000) {
    console.log(`[QC-PULL] disabled: invalid QC_PULL_INTERVAL_MS (${process.env.QC_PULL_INTERVAL_MS})`);
    return;
  }
  initialHandle = setTimeout(() => {
    initialHandle = null;
    tick();
  }, 3000);
  intervalHandle = setInterval(tick, intervalMs);
  // Never keep the process alive just for the sync timer.
  initialHandle.unref?.();
  intervalHandle.unref?.();
  console.log(`[QC-PULL] started: pulling inspection results every ${intervalMs}ms from ${getQcServerUrl()}`);
}
