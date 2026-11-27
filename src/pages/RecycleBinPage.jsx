import { useCallback, useEffect, useMemo, useState } from 'react';
import { listRecycleBin, getRecycleBinEntry, restoreRecycleBinEntry, purgeRecycleBinEntry } from '../services/recycleBinApi.js';

const EMPTY_FILTERS = { module: '', search: '', deletedBy: '', from: '', to: '' };

const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-IN');
};

const RecycleBinPage = () => {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [data, setData] = useState({ entries: [], total: 0, modules: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [auditView, setAuditView] = useState(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listRecycleBin(filters);
      setData({ entries: result.entries || [], total: result.total || 0, modules: result.modules || [] });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((value) => String(value || '').trim()).length,
    [filters]
  );

  const openAction = (mode, entry) => {
    setAction({ mode, entry });
    setReason('');
    setConfirmation('');
    setError('');
    setNotice('');
  };

  const closeAction = () => {
    if (saving) return;
    setAction(null);
    setReason('');
    setConfirmation('');
  };

  const submitAction = async (event) => {
    event.preventDefault();
    if (!action) return;
    setSaving(true);
    setError('');
    try {
      if (action.mode === 'restore') {
        await restoreRecycleBinEntry(action.entry.entity, action.entry.recordId, reason);
        setNotice(`Restored ${action.entry.documentNumber || action.entry.recordId}.`);
      } else {
        await purgeRecycleBinEntry(action.entry.entity, action.entry.recordId, reason, confirmation);
        setNotice(`Permanently deleted ${action.entry.documentNumber || action.entry.recordId}.`);
      }
      setAction(null);
      setReason('');
      setConfirmation('');
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const openAudit = async (entry) => {
    setError('');
    try {
      const result = await getRecycleBinEntry(entry.entity, entry.recordId);
      setAuditView(result);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const confirmMatches = action
    ? confirmation.trim() === String(action.entry.documentNumber || action.entry.recordId)
    : false;

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recycle Bin</h1>
          <p className="muted-text">
            Deleted records stay in PostgreSQL until an authorised user restores them. Permanent deletion is Admin-only and audited.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="button-secondary" onClick={load} disabled={loading}>Refresh</button>
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Deleted records</h3>
          <span className="muted-text">
            {loading ? 'Loading…' : `${data.total} record(s)`}
            {activeFilterCount ? ` · ${activeFilterCount} filter(s)` : ''}
          </span>
        </div>

        <div className="list-filters">
          <select
            className="action-select"
            value={filters.module}
            onChange={(event) => setFilters((current) => ({ ...current, module: event.target.value }))}
            aria-label="Filter by module"
          >
            <option value="">All modules</option>
            {data.modules.map((module) => <option key={module.key} value={module.key}>{module.label}</option>)}
          </select>
          <input
            type="text"
            className="action-select form-input search-input"
            placeholder="Search document number, label or deleted by…"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
          />
          <input
            type="text"
            className="action-select form-input"
            placeholder="Deleted by"
            value={filters.deletedBy}
            onChange={(event) => setFilters((current) => ({ ...current, deletedBy: event.target.value }))}
          />
          <label className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            From
            <input
              type="date"
              className="action-select"
              value={filters.from}
              onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
            />
          </label>
          <label className="muted-text" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            To
            <input
              type="date"
              className="action-select"
              value={filters.to}
              onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
            />
          </label>
          {activeFilterCount > 0 && (
            <button type="button" className="button-secondary" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
          )}
        </div>

        {error && <div className="status-badge st-out" style={{ display: 'block', margin: '10px 0' }}>{error}</div>}
        {notice && <div className="status-badge st-filled" style={{ display: 'block', margin: '10px 0' }}>{notice}</div>}

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Document</th>
                <th>Record</th>
                <th>Deleted on</th>
                <th>Deleted by</th>
                <th>Reason</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && data.entries.length === 0 ? (
                <tr><td colSpan="7" className="no-history-row">Loading deleted records…</td></tr>
              ) : data.entries.length === 0 ? (
                <tr><td colSpan="7" className="no-history-row">No deleted records match the current filters.</td></tr>
              ) : data.entries.map((entry) => (
                <tr key={`${entry.entity}:${entry.recordId}`}>
                  <td>{entry.moduleLabel}</td>
                  <td><strong>{entry.documentNumber || '—'}</strong><div className="muted-text" style={{ fontSize: 11 }}>{entry.label}</div></td>
                  <td>{entry.entity}</td>
                  <td>{formatDateTime(entry.deletedAt)}</td>
                  <td>{entry.deletedBy || '—'}</td>
                  <td>{entry.deleteReason || '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="button-secondary button-small" onClick={() => openAudit(entry)}>Audit</button>
                      {entry.canRestore && (
                        <button type="button" className="button-secondary button-small" onClick={() => openAction('restore', entry)}>Restore</button>
                      )}
                      {entry.canPurge && (
                        <button type="button" className="button-secondary button-small" onClick={() => openAction('purge', entry)}>Delete permanently</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {action && (
        <div className="template-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAction(); }}>
          <form className="template-modal" style={{ width: 'min(560px, 95vw)' }} onSubmit={submitAction}>
            <div className="template-modal-header">
              <h3>{action.mode === 'restore' ? 'Restore record' : 'Permanently delete record'}</h3>
              <button type="button" className="button-secondary button-small" onClick={closeAction} disabled={saving}>✕ Close</button>
            </div>
            <p className="muted-text">
              <strong>{action.entry.documentNumber || action.entry.recordId}</strong> · {action.entry.moduleLabel}
            </p>
            {action.mode === 'purge' && (
              <p className="muted-text">
                This removes the tombstoned row from PostgreSQL. The action cannot be undone and is recorded in the audit log.
                It is blocked while other ERP records still reference it.
              </p>
            )}
            {error && <div className="status-badge st-out" style={{ display: 'block', margin: '10px 0' }}>{error}</div>}
            <label className="field-group" style={{ display: 'block', marginTop: 12 }}>
              <span>Reason (required)</span>
              <textarea
                className="form-input"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                disabled={saving}
              />
            </label>
            {action.mode === 'purge' && (
              <label className="field-group" style={{ display: 'block', marginTop: 12 }}>
                <span>Type <strong>{action.entry.documentNumber || action.entry.recordId}</strong> to confirm</span>
                <input
                  type="text"
                  className="form-input"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={saving}
                  autoComplete="off"
                />
              </label>
            )}
            <div className="form-actions" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="button-secondary" onClick={closeAction} disabled={saving}>Cancel</button>
              <button
                type="submit"
                className="button-primary"
                disabled={saving || !reason.trim() || (action.mode === 'purge' && !confirmMatches)}
              >
                {saving ? 'Working…' : action.mode === 'restore' ? 'Restore' : 'Delete permanently'}
              </button>
            </div>
          </form>
        </div>
      )}

      {auditView && (
        <div className="template-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuditView(null); }}>
          <div className="template-modal" style={{ width: 'min(760px, 95vw)' }}>
            <div className="template-modal-header">
              <h3>Audit trail · {auditView.entry.documentNumber || auditView.entry.recordId}</h3>
              <button type="button" className="button-secondary button-small" onClick={() => setAuditView(null)}>✕ Close</button>
            </div>
            <p className="muted-text">
              Deleted by <strong>{auditView.entry.deletedBy || '—'}</strong> on {formatDateTime(auditView.entry.deletedAt)}.
              Reason: {auditView.entry.deleteReason || '—'}
            </p>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr><th>When</th><th>Action</th><th>Actor</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {(auditView.audit || []).length === 0 ? (
                    <tr><td colSpan="4" className="no-history-row">No audit rows found.</td></tr>
                  ) : auditView.audit.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.created_at)}</td>
                      <td>{row.action}</td>
                      <td>{row.email || row.role || '—'}</td>
                      <td>{row.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default RecycleBinPage;
