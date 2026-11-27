import React, { useState } from 'react';
import { getProcurementMigrationPreview, importMissingProcurementRecords } from '../services/procurementIntakeApi.js';
import { isAdmin } from '../utils/auth.js';

export default function ProcurementMigrationReview({ kinds, onImported }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previews, setPreviews] = useState({});
  if (!isAdmin()) return null;
  const preview = async () => {
    setBusy(true); setError('');
    try {
      const pairs = await Promise.all(kinds.map(async (kind) => [kind, await getProcurementMigrationPreview(kind)]));
      setPreviews(Object.fromEntries(pairs)); setOpen(true);
    } catch (err) { setError(`Legacy migration preview failed: ${err.message}`); }
    finally { setBusy(false); }
  };
  const importKind = async (kind) => {
    const rows = previews[kind]?.eligible || [];
    if (!rows.length) return;
    if (!window.confirm(`Import ${rows.length} reviewed ${kind} record(s) to PostgreSQL? Existing and conflicting records will remain unchanged.`)) return;
    setBusy(true); setError('');
    try {
      const result = await importMissingProcurementRecords(kind, rows);
      setError(`${kind}: imported ${result.imported?.length || 0}; conflicts ${result.conflicts?.length || 0}.`);
      const pairs = await Promise.all(kinds.map(async (entity) => [entity, await getProcurementMigrationPreview(entity)]));
      setPreviews(Object.fromEntries(pairs));
      await onImported?.(kind);
    } catch (err) { setError(`${kind} import failed: ${err.message}`); }
    finally { setBusy(false); }
  };
  return <div className="no-print" style={{ marginBottom: 12 }}>
    <button className="button-secondary" type="button" disabled={busy} onClick={preview}>{busy ? 'Loading…' : 'Review legacy PostgreSQL migration'}</button>
    {error && <p role="status">{error}</p>}
    {open && <div role="dialog" aria-modal="true" aria-label="Legacy procurement migration review" className="content-block" style={{ marginTop: 12 }}>
      <div className="block-header"><h3 className="block-title">Review before import</h3><button className="button-secondary" onClick={() => setOpen(false)}>Close</button></div>
      <p>Preview is read-only. Nothing is imported until you use an Import button. Import each record type in dependency order: Purchase Indents, Vendor Enquiries, then Vendor Quotations.</p>
      {kinds.map((kind) => {
        const data = previews[kind]; if (!data) return null;
        return <section key={kind} style={{ margin: '12px 0' }}>
          <h4>{kind}</h4>
          <p>Eligible: {data.counts?.eligible || 0} · Existing: {data.counts?.existing || 0} · Conflicts: {data.counts?.conflicts || 0} · Deleted: {data.counts?.deleted || 0}</p>
          <details><summary>Eligible records ({data.eligible?.length || 0})</summary><ul>{(data.eligible || []).map((row) => <li key={row.indentNumber || row.enquiryNumber || row.quotationNumber}>{row.indentNumber || row.enquiryNumber || row.quotationNumber} — {row.status || 'No status'}</li>)}</ul></details>
          {(data.conflicts?.length || data.deleted?.length) > 0 && <details><summary>Conflicts / deleted identifiers</summary><ul>{[...(data.conflicts || []), ...(data.deleted || [])].map((row, i) => <li key={`${row.id || row.indentNumber || row.enquiryNumber || row.quotationNumber}-${i}`}>{row.id || row.indentNumber || row.enquiryNumber || row.quotationNumber}: {row.reason || 'Conflict'}</li>)}</ul></details>}
          <button className="button-primary" disabled={busy || !data.eligible?.length} onClick={() => importKind(kind)}>Import reviewed {kind} records</button>
        </section>;
      })}
    </div>}
  </div>;
}
