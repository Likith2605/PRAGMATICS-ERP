import React, { useEffect, useRef, useState } from 'react';
import { Check, Cloud, CloudOff, LoaderCircle } from 'lucide-react';
import {
  getSyncStatus,
  syncERPState,
  flushERPState
} from '../services/erpStateSync.js';
import { flushRecords, getRecordsStatus, pullRecordsFromServer, RECORD_MODULE_KEYS } from '../services/recordsSync.js';
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
  const [health, setHealth] = useState({ server: null, database: null, error: null });
  const recoveryCheckInFlight = useRef(false);
  const wasDatabaseHealthy = useRef(false);
  const [recordStatuses, setRecordStatuses] = useState(() =>
    Object.fromEntries(RECORD_MODULE_KEYS.map((key) => [key, getRecordsStatus(key)]))
  );

  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      const base = window.location.port === '5173'
        ? `http://${window.location.hostname || 'localhost'}:3001`
        : '';
      try {
        const response = await fetch(`${base}/api/health`);
        const payload = await response.json().catch(() => ({}));
        const nextHealth = { server: true, database: response.ok && payload.database?.connected === true, error: payload.database?.error || (!response.ok ? `Health check returned HTTP ${response.status}.` : null) };
        const recovered = nextHealth.database && !wasDatabaseHealthy.current;
        wasDatabaseHealthy.current = nextHealth.database;
        if (active) setHealth(nextHealth);
        if (active && nextHealth.database && !recoveryCheckInFlight.current) {
          const sync = getSyncStatus();
          const modules = RECORD_MODULE_KEYS.map((key) => getRecordsStatus(key));
          const staleOffline = sync.connected !== true || modules.some((item) => item.connected !== true && !item.permissionDenied);
          if (recovered || staleOffline) {
            recoveryCheckInFlight.current = true;
            try {
              const stateSynced = await syncERPState({ force: true });
              if (stateSynced) {
                await pullRecordsFromServer();
                await flushRecords();
                if (active) setRecordStatuses(Object.fromEntries(RECORD_MODULE_KEYS.map((key) => [key, getRecordsStatus(key)])));
              }
            } finally {
              recoveryCheckInFlight.current = false;
            }
          }
        }
      } catch (error) {
        wasDatabaseHealthy.current = false;
        if (active) setHealth({ server: false, database: false, error: error.message });
      }
    };
    checkHealth();
    const healthTimer = window.setInterval(checkHealth, 15000);
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
    const onRecordsStatus = (event) => {
      const { key, ...nextStatus } = event.detail || {};
      if (key) setRecordStatuses((current) => ({ ...current, [key]: nextStatus }));
    };
    window.addEventListener('erp-sync-status', onChange);
    window.addEventListener('erp-records-status', onRecordsStatus);
    window.addEventListener('erp-records-conflict', onConflict);
    return () => {
      active = false;
      window.clearInterval(healthTimer);
      window.removeEventListener('erp-sync-status', onChange);
      window.removeEventListener('erp-records-status', onRecordsStatus);
      window.removeEventListener('erp-records-conflict', onConflict);
    };
  }, []);

  const recordEntries = Object.entries(recordStatuses);
  const offlineRecords = recordEntries.filter(([, recordStatus]) => recordStatus.connected === false && !recordStatus.permissionDenied);
  const healthUnavailable = health.server === false || health.database === false;
  const connectionVerified = health.server === true && health.database === true;
  const modulesVerified = recordEntries.every(([, item]) => item.connected === true || item.permissionDenied);
  const connected = healthUnavailable || offlineRecords.length
    ? false
    : connectionVerified && status.connected === true && modulesVerified
    ? true
    : null;
  const pending = Number(status.pending || 0) + recordEntries.reduce((sum, [, recordStatus]) => sum + Number(recordStatus.pending || 0), 0);
  const permissionDenied = Boolean(status.permissionDenied || (pending > 0 && recordEntries.some(([, item]) => item.permissionDenied)));

  let mode = 'connecting';
  let label = 'Connecting to PostgreSQL…';
  if (permissionDenied) {
    mode = 'permission';
    label = pending > 0 ? `Permission required — ${pending} change${pending === 1 ? '' : 's'} retained` : 'Permission required for this operation';
  } else if (connected === true && pending > 0) {
    mode = 'saving';
    label = `Saving ${pending} change${pending === 1 ? '' : 's'}…`;
  } else if (connected === true) {
    mode = 'ok';
    label = 'PostgreSQL connected';
  } else if (connected === false) {
    mode = 'offline';
    label = offlineRecords.length
      ? `Server unavailable — ${offlineRecords.map(([key]) => key).join(', ')} not syncing`
      : pending > 0
      ? `Offline — ${pending} change${pending === 1 ? '' : 's'} queued`
      : 'Server unavailable — not saving to server';
  }

  const retry = async () => {
    setRetrying(true);
    try {
      await Promise.all([flushERPState(), flushRecords()]);
      await syncERPState({ force: true });
      await pullRecordsFromServer();
      setStatus(getSyncStatus());
      setRecordStatuses(Object.fromEntries(RECORD_MODULE_KEYS.map((key) => [key, getRecordsStatus(key)])));
    } finally {
      setRetrying(false);
    }
  };

  const lastSync = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : null;
  const hasRetryableError = healthUnavailable || status.connected === false || offlineRecords.length > 0;
  const StatusIcon = mode === 'offline' ? CloudOff : mode === 'ok' ? Check : mode === 'saving' ? Cloud : LoaderCircle;

  return (
    <div className={`sync-status sync-status--${mode}`} title={label}>
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
        aria-expanded={open}
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        <span className="sync-status__dot" aria-hidden="true" />
        <span className="sync-status__label">{mode === 'ok' ? 'Synced' : mode === 'saving' ? 'Saving' : mode === 'offline' ? 'Offline' : mode === 'permission' ? 'Permission' : 'Connecting'}</span>
        <StatusIcon className="sync-status__icon" size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open && (
        <div className="sync-status__detail">
          <div><strong>Server:</strong> {health.server === false ? 'unreachable' : health.server === true ? 'connected' : connected === false ? 'unreachable' : connected === true ? 'connected' : 'checking…'}</div>
          <div><strong>Database:</strong> {health.database === true ? 'connected' : health.database === false ? (health.error || 'unavailable') : 'checking…'}</div>
          <div><strong>Queued changes:</strong> {pending}</div>
          {lastSync && <div><strong>Last confirmed save:</strong> {lastSync}</div>}
          {status.lastError && <div><strong>Last error:</strong> {status.lastError}</div>}
          {recordEntries.map(([key, recordStatus]) => recordStatus.lastError && (
            <div key={key}><strong>{recordStatus.permissionDenied ? 'Permission' : key + ' API error'}:</strong> {recordStatus.lastError}</div>
          ))}
          {status.permissionDenied && <div><strong>Permission:</strong> {status.lastError}</div>}
          {hasRetryableError && <button type="button" className="sync-status__retry" onClick={retry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry now'}
          </button>}
        </div>
      )}
    </div>
  );
};

export default SyncStatusBar;
