import React, { useEffect, useState } from 'react';
import {
  getSyncStatus,
  syncERPState,
  flushERPState
} from '../services/erpStateSync.js';
import { flushRecords } from '../services/recordsSync.js';
import '../styles/sync-status.css';

/**
 * PostgreSQL connection banner (bottom-right).
 *
 * Driven by the `erp-sync-status` events emitted from erpStateSync.js and the
 * `erp-records-*` events from recordsSync.js (per-record modules) so the
 * company's users always know whether their work is reaching the server:
 *
 *   green  — everything confirmed saved in PostgreSQL
 *   amber  — N change(s) in flight (normal for a moment after each edit)
 *   red    — server unreachable; N change(s) queued and auto-retrying
 *   grey   — first connection attempt in progress
 *   amber  — "Sync conflict" notice: another user saved the same record first;
 *            the server copy was applied (nothing was lost silently)
 *
 * Clicking the pill opens a detail card with a manual "Retry now" action.
 */
const SyncStatusBar = () => {
  const [status, setStatus] = useState(() => getSyncStatus());
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const onChange = (event) => setStatus({ ...getSyncStatus(), ...(event.detail || {}) });
    const onConflict = (event) => {
      const conflicts = event.detail?.conflicts || [];
      if (!conflicts.length) return;
      setNotice({
        key: event.detail?.key,
        count: conflicts.length,
        sample: conflicts[0]
      });
      window.setTimeout(() => setNotice(null), 15000);
    };
    window.addEventListener('erp-sync-status', onChange);
    window.addEventListener('erp-records-conflict', onConflict);
    return () => {
      window.removeEventListener('erp-sync-status', onChange);
      window.removeEventListener('erp-records-conflict', onConflict);
    };
  }, []);

  const connected = status.connected;
  const pending = Number(status.pending || 0);

  let mode = 'connecting';
  let label = 'Connecting to PostgreSQL…';
  if (connected === true && pending > 0) {
    mode = 'saving';
    label = `Saving ${pending} change${pending === 1 ? '' : 's'}…`;
  } else if (connected === true) {
    mode = 'ok';
    label = 'PostgreSQL connected';
  } else if (connected === false) {
    mode = 'offline';
    label = pending > 0
      ? `Offline — ${pending} change${pending === 1 ? '' : 's'} queued`
      : 'Offline — not saving to server';
  }

  const retry = async () => {
    setRetrying(true);
    try {
      await Promise.all([flushERPState(), flushRecords()]);
      await syncERPState();
      setStatus(getSyncStatus());
    } finally {
      setRetrying(false);
    }
  };

  const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : null;

  return (
    <div className={`sync-status sync-status--${mode}`} title="PostgreSQL sync status">
      {notice && (
        <div className="sync-status__conflict" role="status">
          <strong>Sync conflict — latest server copy applied</strong>
          <div>
            {notice.count} record{notice.count === 1 ? ' was' : 's were'} changed by another
            user first. Your screen now shows the newest data; re-apply your edit if needed.
          </div>
          <button type="button" className="sync-status__retry" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <button
        type="button"
        className="sync-status__pill"
        onClick={() => setOpen((value) => !value)}
        aria-live="polite"
      >
        <span className="sync-status__dot" aria-hidden="true" />
        {label}
      </button>

      {open && (
        <div className="sync-status__detail">
          <div><strong>Server:</strong> {connected === false ? 'unreachable' : connected === true ? 'connected' : 'connecting…'}</div>
          <div><strong>Queued changes:</strong> {pending}</div>
          {lastSync && <div><strong>Last confirmed save:</strong> {lastSync}</div>}
          {status.lastError && <div><strong>Last error:</strong> {status.lastError}</div>}
          <button type="button" className="sync-status__retry" onClick={retry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry now'}
          </button>
        </div>
      )}
    </div>
  );
};

export default SyncStatusBar;
