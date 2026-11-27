import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAuditLog } from '../utils/storeService.js';

const StoreAuditLogView = ({ limit = 200 }) => {
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('All');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError('');
      setLogs(await getAuditLog(undefined, limit));
    } catch (requestError) {
      setLogs([]);
      setError(requestError.message || 'Store audit history could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    refresh();
    window.addEventListener('erp-store-audit-updated', refresh);
    return () => window.removeEventListener('erp-store-audit-updated', refresh);
  }, [refresh]);

  const actions = useMemo(() => {
    const set = new Set(logs.map((l) => l.action));
    return ['All', ...Array.from(set)];
  }, [logs]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return logs
      .filter((l) => (actionFilter === 'All' ? true : l.action === actionFilter))
      .filter((l) =>
        !q
          ? true
          : [l.user, l.reference, l.action, l.details, l.employeeId, l.department]
              .join(' ')
              .toLowerCase()
              .includes(q)
      )
      .slice(0, limit);
  }, [logs, search, actionFilter, limit]);

  return (
    <div>
      <div className="block-header">
        <h3 className="block-title">Store Audit Trail</h3>
        <span className="muted-text">Immutably recorded. Every material transaction is logged.</span>
      </div>

      <div className="audit-filters">
        <input
          type="text"
          className="action-select form-input"
          placeholder="Search audit trail..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="action-select" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="history-table-wrapper">
        <table className="history-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Time</th>
              <th>Employee</th>
              <th>Department</th>
              <th>Action</th>
              <th>Reference</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="7" className="no-history-row">Loading audit entries...</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan="7" className="no-history-row">No audit entries found.</td>
              </tr>
            ) : (
              filtered.map((l) => (
                <tr key={l.id}>
                  <td>{l.date}</td>
                  <td>{l.time}</td>
                  <td>{l.user}</td>
                  <td>{l.department}</td>
                  <td><span className={`status-badge st-${l.action.split(' ').join('-').toLowerCase()}`}>{l.action}</span></td>
                  <td>{l.reference || '—'}</td>
                  <td className="audit-details-cell">{l.details || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default StoreAuditLogView;