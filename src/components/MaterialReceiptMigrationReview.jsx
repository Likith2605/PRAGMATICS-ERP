import { useState } from 'react';
import { isAdmin } from '../utils/auth.js';
import { getMaterialReceiptMigrationPreviewApi, importMaterialReceiptsApi } from '../services/materialReceiptApi.js';

export default function MaterialReceiptMigrationReview({ onImported }) {
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  if (!isAdmin()) return null;
  const review = async () => {
    setBusy(true); setMessage('');
    try { const result = await getMaterialReceiptMigrationPreviewApi(); setPreview(result); setSelected([]); }
    catch (error) { setMessage(`Preview failed: ${error.message}`); }
    finally { setBusy(false); }
  };
  const importSelected = async () => {
    if (!selected.length || !window.confirm(`Import ${selected.length} selected Material Receipt(s) into PostgreSQL?`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await importMaterialReceiptsApi(selected);
      setMessage(`Imported ${result.imported.length}; existing/skipped ${result.skipped.length}; conflicts ${result.conflicts.length}.`);
      setPreview(await getMaterialReceiptMigrationPreviewApi()); setSelected([]); await onImported?.();
    } catch (error) { setMessage(`Import failed: ${error.message}`); }
    finally { setBusy(false); }
  };
  return <div className="content-block no-print">
    <div className="block-header"><h3 className="block-title">Legacy Material Receipt reconciliation</h3><button className="button-secondary" disabled={busy} onClick={review}>Preview preserved records</button></div>
    <p>Preview is read-only. Legacy browser-state rows remain preserved. Only individually selected records are imported after Admin confirmation.</p>
    {message && <p role="status">{message}</p>}
    {preview && <>
      <p>Eligible: {preview.counts?.eligible || 0} · Existing: {preview.counts?.existing || 0} · Conflicts: {preview.counts?.conflicts || 0} · Invalid: {preview.counts?.invalid || 0}</p>
      <div style={{ maxHeight: 260, overflow: 'auto' }}>{(preview.eligible || []).map((record) => <label key={record.receiptNumber} style={{ display: 'block', padding: 5 }}>
        <input type="checkbox" checked={selected.includes(record.receiptNumber)} onChange={(event) => setSelected((rows) => event.target.checked ? [...rows, record.receiptNumber] : rows.filter((id) => id !== record.receiptNumber))} />{' '}
        {record.receiptNumber} · PO {record.poNumber} · invoice {record.invoiceNumber}
      </label>)}</div>
      {(preview.conflicts || []).map((entry) => <p key={`conflict-${entry.record.receiptNumber}`} role="status">Conflict left unchanged: {entry.record.receiptNumber}</p>)}
      {(preview.invalid || []).map((entry, index) => <p key={`invalid-${index}`} role="status">Invalid and preserved: {entry.record?.receiptNumber || 'unidentified'} — {entry.reason}</p>)}
      <button className="button-primary" disabled={busy || !selected.length} onClick={importSelected}>Import selected ({selected.length})</button>
    </>}
  </div>;
}
