import { useState } from 'react';
import { getPurchaseRequestMigrationPreviewApi, importPurchaseRequestsApi } from '../services/purchaseRequestApi.js';
import { isAdmin } from '../utils/auth.js';

const idOf = (record) => String(record?.prNumber || '');

export default function PurchaseRequestMigrationReview({ onImported }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  if (!isAdmin()) return null;

  const loadPreview = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await getPurchaseRequestMigrationPreviewApi();
      setPreview(result);
      setSelected((current) => current.filter((id) => result.eligible.some((record) => idOf(record) === id)));
      setOpen(true);
    } catch (requestError) {
      setError(`Purchase Request migration preview failed: ${requestError.message}`);
    } finally {
      setBusy(false);
    }
  };

  const importSelected = async () => {
    if (!selected.length) return;
    if (!window.confirm(`Import ${selected.length} selected Purchase Request(s) into PostgreSQL? Legacy records and conflicts will remain unchanged.`)) return;
    setBusy(true);
    setError('');
    try {
      const result = await importPurchaseRequestsApi(selected);
      setError(`Imported ${result.imported?.length || 0}; conflicts ${result.conflicts?.length || 0}.`);
      setSelected([]);
      setPreview(await getPurchaseRequestMigrationPreviewApi());
      await onImported?.();
    } catch (requestError) {
      setError(`Purchase Request import failed: ${requestError.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id) => setSelected((current) =>
    current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
  );

  return (
    <div className="no-print" style={{ marginBottom: 12 }}>
      <button className="button-secondary" type="button" disabled={busy} onClick={loadPreview}>
        {busy ? 'Loading…' : 'Review legacy Purchase Requests'}
      </button>
      {error && <p role="status">{error}</p>}
      {open && preview && (
        <div role="dialog" aria-modal="true" aria-label="Purchase Request migration review" className="content-block" style={{ marginTop: 12 }}>
          <div className="block-header">
            <h3 className="block-title">Purchase Request migration review</h3>
            <button className="button-secondary" type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
          <p>Read-only preview. PostgreSQL conflicts are preserved; only individually selected eligible records are imported.</p>
          <p>Eligible: {preview.counts?.eligible || 0} · Existing: {preview.counts?.existing || 0} · Conflicts: {preview.counts?.conflicts || 0} · Deleted: {preview.counts?.deleted || 0}</p>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead><tr><th>Select</th><th>PR Number</th><th>Date</th><th>Material Request</th><th>Status</th></tr></thead>
              <tbody>
                {(preview.eligible || []).map((record) => (
                  <tr key={idOf(record)}>
                    <td><input aria-label={`Select ${idOf(record)}`} type="checkbox" checked={selected.includes(idOf(record))} onChange={() => toggle(idOf(record))} /></td>
                    <td>{idOf(record)}</td><td>{record.prDate || '-'}</td><td>{record.mrNumber || '-'}</td><td>{record.status || '-'}</td>
                  </tr>
                ))}
                {!preview.eligible?.length && <tr><td colSpan="5">No eligible legacy Purchase Requests.</td></tr>}
              </tbody>
            </table>
          </div>
          {(preview.conflicts?.length || preview.deleted?.length) > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary>Conflicts / protected deleted records</summary>
              <ul>{[...(preview.conflicts || []), ...(preview.deleted || [])].map((row, index) => <li key={`${row.id}-${index}`}>{row.id || '(missing number)'}: {row.reason}</li>)}</ul>
            </details>
          )}
          <button className="button-primary" type="button" disabled={busy || !selected.length} onClick={importSelected}>
            {busy ? 'Importing…' : `Import ${selected.length} selected record(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
