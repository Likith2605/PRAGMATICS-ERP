import { useMemo, useState } from 'react';
import { getStockTransactions, getInventoryItems, transactionTypeLabel } from '../utils/storeService.js';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import StoreAuditLogView from '../components/StoreAuditLogView.jsx';

const InventoryTransactionsPage = () => {
  const [tab, setTab] = useState('transactions'); // transactions | audit
  const [typeFilter, setTypeFilter] = useState('All');
  const [search, setSearch] = useState('');

  const tx = getStockTransactions();
  const inventory = getInventoryItems();

  const types = useMemo(() => {
    const set = new Set(tx.map((t) => transactionTypeLabel(t)));
    return ['All', ...Array.from(set)];
  }, [tx]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return tx
      .filter((t) => {
        if (typeFilter !== 'All' && transactionTypeLabel(t) !== typeFilter) return false;
        if (!q) return true;
        return [t.itemCode, t.itemName, t.reference, t.transactionNumber, t.mrNumber, t.jobCardNumber, t.projectId, t.issuedTo, t.issuedBy, t.reason]
          .join(' ')
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => String(b.dateTime || b.date || '').localeCompare(String(a.dateTime || a.date || '')));
  }, [tx, typeFilter, search]);

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Store / Warehouse</div>
          <h1 className="page-title">Inventory Transactions</h1>
          <p className="page-description">
            Complete read-only history of every stock movement. Transaction records are never edited or deleted.
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      <div className="tab-nav">
        <button type="button" className={`tab-link ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transaction History</button>
        <button type="button" className={`tab-link ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Trail</button>
      </div>

      {tab === 'audit' ? (
        <StoreAuditLogView />
      ) : (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Transaction History</h3>
            <span className="muted-text">{filtered.length} movement(s) · {inventory.length} items in master</span>
          </div>

          <div className="list-filters">
            <input
              type="text"
              className="action-select form-input search-input"
              placeholder="Search item / reference / SI / MR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="action-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              {types.map((t) => (
                <option key={t} value={t}>{t === 'All' ? 'All Types' : t}</option>
              ))}
            </select>
          </div>

          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Date &amp; Time</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Balance</th>
                  <th>Reference</th>
                  <th>Batch / Lot</th>
                  <th>Project ID</th>
                  <th>Issued To / From</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan="11" className="no-history-row">No inventory transactions found.</td>
                  </tr>
                ) : (
                  filtered.map((t) => (
                    <tr key={t.id}>
                      <td>{t.dateTime || t.date}</td>
                      <td><strong>{t.itemName || t.itemCode}</strong></td>
                      <td>
                        <span className={`status-badge ${t.type === 'IN' ? 'st-filled' : 'st-out'}`}>
                          {transactionTypeLabel(t)}
                        </span>
                      </td>
                      <td>{t.quantity}</td>
                      <td>{t.unit}</td>
                      <td>{t.balanceAfter ?? '—'}</td>
                      <td>{t.transactionNumber || t.reference || '—'}</td>
                      <td>
                        {t.batchNo || t.lotNumber ? (
                          <>
                            <div>{t.batchNo || '—'}</div>
                            {t.lotNumber ? (
                              <div className="muted-text" style={{ fontSize: '11px' }}>Lot {t.lotNumber}</div>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {t.projectId ? (
                          <span style={{ color: '#3730a3', fontWeight: '700', fontSize: '12px' }}>{t.projectId}</span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td>
                        {t.issuedTo ? `Issued to ${t.issuedTo} (${t.issuedToId || ''})` : ''}
                        {t.returnedBy ? `Returned by ${t.returnedBy}` : ''}
                        {t.issuedBy && !t.issuedTo && !t.returnedBy ? `By ${t.issuedBy}` : ''}
                        {!t.issuedTo && !t.returnedBy && !t.issuedBy ? '—' : ''}
                      </td>
                      <td>{t.reason || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};

export default InventoryTransactionsPage;