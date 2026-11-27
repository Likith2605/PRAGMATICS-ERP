import React, { useState } from 'react';
import { isAdmin } from '../utils/auth.js';
import { base64ToBlob, confirmFileChecksum, getFileChecksumReview, getMissingChecksumInventory } from '../services/fileApi.js';

const sha256 = async (blob) => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

const FileChecksumReviewPanel = () => {
  const [inventory, setInventory] = useState(null);
  const [review, setReview] = useState(null);
  const [trustedHash, setTrustedHash] = useState('');
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  if (!isAdmin()) return null;
  const matches = Boolean(review && trustedHash && trustedHash === review.candidateChecksumSha256);

  const loadInventory = async (offset = 0) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await getMissingChecksumInventory({ limit: 100, offset });
      setInventory((current) => offset && current
        ? { ...result, files: [...current.files, ...result.files] }
        : result);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };

  const openReview = async (file) => {
    setBusy(true); setError(''); setMessage(''); setTrustedHash(''); setReference(''); setConfirmed(false);
    try { setReview(await getFileChecksumReview(file.id)); }
    catch (requestError) { setError(requestError.message); setReview(null); }
    finally { setBusy(false); }
  };

  const downloadReviewedBytes = () => {
    const blob = base64ToBlob(review.contentBase64, review.mimeType);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = review.fileName || 'attachment'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const compareTrustedOriginal = async (event) => {
    const file = event.target.files?.[0];
    setTrustedHash(''); setError(''); setConfirmed(false);
    if (!file) return;
    try { setTrustedHash(await sha256(file)); }
    catch (hashError) { setError(`Could not hash the trusted original: ${hashError.message}`); }
    event.target.value = '';
  };

  const verify = async () => {
    if (!review || !matches || !reference.trim() || !confirmed || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await confirmFileChecksum(review.id, {
        trustedOriginalSha256: trustedHash,
        verificationMethod: 'trusted_original_sha256',
        verificationReference: reference.trim(),
        confirmed: true
      });
      setReview(null); setTrustedHash(''); setReference(''); setConfirmed(false);
      await loadInventory(0);
      setMessage(`Verified ${result.id}: ${result.checksumSha256}`);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };

  return (
    <section className="content-block" aria-label="Attachment checksum review" style={{ marginTop: 16 }}>
      <h3>Attachment checksum review</h3>
      <p>Enquiry drawing attachments without a checksum are never approved automatically. Compare the PostgreSQL copy with a trusted original before confirming.</p>
      {!inventory ? (
        <button className="button-secondary" type="button" disabled={busy} onClick={() => loadInventory(0)}>
          {busy ? 'Loading…' : 'Review missing-checksum inventory'}
        </button>
      ) : (
        <>
          <p>{inventory.total} attachment(s) currently have no stored checksum.</p>
          {inventory.files.length > 0 && <div className="history-table-wrapper"><table className="history-table">
            <thead><tr><th>File</th><th>Scope</th><th>Size</th><th>Identity</th><th>Action</th></tr></thead>
            <tbody>{inventory.files.map((file) => <tr key={file.id}>
              <td>{file.fileName}<br /><small>{file.id}</small></td>
              <td>{file.scope}</td><td>{file.sizeBytes} bytes</td>
              <td><small>{JSON.stringify(file.metadata || {})}</small></td>
              <td><button className="button-small" type="button" disabled={busy} onClick={() => openReview(file)}>Review content</button></td>
            </tr>)}</tbody>
          </table></div>}
          {inventory.files.length < inventory.total && <button className="button-secondary" type="button" disabled={busy} onClick={() => loadInventory(inventory.files.length)}>Load more</button>}
          <button className="button-small" type="button" disabled={busy} onClick={() => loadInventory(0)}>Refresh inventory</button>
        </>
      )}
      {review && <div className="content-block" style={{ marginTop: 12 }}>
        <h4>Review: {review.fileName}</h4>
        <p>ID: {review.id} · {review.mimeType} · {review.sizeBytes} bytes</p>
        <p>Metadata: {JSON.stringify(review.metadata || {})}</p>
        <p>SHA-256 calculated from PostgreSQL bytes: <code>{review.candidateChecksumSha256}</code></p>
        <button className="button-small" type="button" onClick={downloadReviewedBytes}>Download PostgreSQL copy for review</button>
        <label style={{ display: 'block', marginTop: 10 }}>Trusted original file
          <input type="file" onChange={compareTrustedOriginal} />
        </label>
        {trustedHash && <p>Trusted original SHA-256: <code>{trustedHash}</code> — {matches ? 'MATCH' : 'DOES NOT MATCH'}</p>}
        <label style={{ display: 'block', marginTop: 10 }}>Trusted original reference
          <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Original filename, source, or archive reference" />
        </label>
        <label style={{ display: 'block', marginTop: 10 }}>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I compared this PostgreSQL attachment with the identified trusted original.
        </label>
        <button className="button-primary" type="button" disabled={busy || !matches || !reference.trim() || !confirmed} onClick={verify}>
          {busy ? 'Saving verification…' : 'Confirm comparison and backfill checksum'}
        </button>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
};

export default FileChecksumReviewPanel;
