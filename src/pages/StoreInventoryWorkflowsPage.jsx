import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { hasPermission } from '../utils/permissions.js';
import { isAdmin } from '../utils/auth.js';
import {
  createStockTransfer,
  createStockVerification,
  listInventoryItems,
  listInventoryLocationBalances,
  listInventoryLocationBatchBalances,
  listStockTransfers,
  listStockVerifications,
  resolveStockTransfer,
  resolveStockVerification
} from '../services/inventoryApi.js';

const today = () => new Date().toISOString().slice(0, 10);
const makeKey = (prefix) => `store-${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const quantity = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const emptyLine = () => ({ itemCode: '', batchId: '', quantity: '', physicalQty: '', remarks: '' });
const userCanWrite = () => isAdmin() || ['store.module', 'inventory.manage', 'inventory.adjust'].some(hasPermission);

const StockTransferForm = ({ items, locations, balances, batchBalances, onSave, onCancel }) => {
  const [fromLocation, setFromLocation] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [transferDate, setTransferDate] = useState(today());
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeKey('transfer'));

  const updateLine = (index, patch) => setLines((current) => current.map((line, at) => at === index ? { ...line, ...patch } : line));
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!fromLocation || !toLocation) return setError('Source and destination locations are required.');
    if (fromLocation.toLocaleLowerCase() === toLocation.toLocaleLowerCase()) return setError('Source and destination locations must be different.');
    const itemsToTransfer = lines.map((line) => {
      const item = items.find((candidate) => candidate.itemCode === line.itemCode);
      return item && Number(line.quantity) > 0
        ? { itemCode: item.itemCode, unit: item.unit, quantity: Number(line.quantity), batchId: line.batchId || '' }
        : null;
    });
    if (itemsToTransfer.some((line) => !line)) return setError('Choose an item and positive quantity for every transfer line.');
    setBusy(true);
    try {
      const result = await onSave({
        transferDate,
        fromLocation,
        toLocation,
        remarks,
        items: itemsToTransfer
      }, idempotencyKey);
      setIdempotencyKey(makeKey('transfer'));
      onCancel();
      return result;
    } catch (requestError) {
      setError(requestError.message || 'Stock Transfer could not be saved to PostgreSQL.');
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <form className="content-block" onSubmit={submit}>
      <div className="block-header"><h3 className="block-title">New Stock Transfer</h3></div>
      <div className="form-grid">
        <div className="form-field">
          <label>Source Location *</label>
          <select className="action-select" required value={fromLocation} onChange={(event) => setFromLocation(event.target.value)}>
            <option value="">Select location</option>
            {locations.map((location) => <option key={location} value={location}>{location}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label>Destination Location *</label>
          <input className="action-select form-input" required value={toLocation} onChange={(event) => setToLocation(event.target.value)} list="transfer-destination-locations" />
          <datalist id="transfer-destination-locations">{locations.map((location) => <option key={location} value={location} />)}</datalist>
        </div>
        <div className="form-field">
          <label>Transfer Date *</label>
          <input type="date" className="action-select form-input" required value={transferDate} onChange={(event) => setTransferDate(event.target.value)} />
        </div>
        <div className="form-field">
          <label>Remarks</label>
          <input className="action-select form-input" value={remarks} onChange={(event) => setRemarks(event.target.value)} />
        </div>
      </div>
      <div className="history-table-wrapper">
        <table className="history-table">
          <thead><tr><th>Item *</th><th>Batch / Lot</th><th>Available at Source</th><th>Quantity *</th><th>Unit</th><th /></tr></thead>
          <tbody>
            {lines.map((line, index) => {
              const item = items.find((candidate) => candidate.itemCode === line.itemCode);
              const batches = batchBalances.filter((batch) => batch.item_code === line.itemCode && batch.location === fromLocation);
              const itemBalance = quantity(balances.find((balance) => balance.item_code === line.itemCode && balance.location === fromLocation)?.quantity);
              return (
                <tr key={index}>
                  <td>
                    <select className="action-select" required value={line.itemCode} onChange={(event) => updateLine(index, { itemCode: event.target.value, batchId: '' })}>
                      <option value="">Select item</option>
                      {items.map((entry) => <option key={entry.itemCode} value={entry.itemCode}>{entry.itemCode} · {entry.materialName || entry.itemName}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="action-select" value={line.batchId} onChange={(event) => updateLine(index, { batchId: event.target.value })}>
                      <option value="">Any / unbatched stock</option>
                      {batches.map((batch) => <option key={batch.batch_id} value={batch.batch_id}>{batch.batch_number} · {batch.lot_number || 'No lot'} · {quantity(batch.quantity)} available</option>)}
                    </select>
                  </td>
                  <td>{line.batchId ? quantity(batches.find((batch) => batch.batch_id === line.batchId)?.quantity) : itemBalance}</td>
                  <td><input type="number" min="0.0001" step="any" required className="issue-qty-input" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></td>
                  <td>{item?.unit || '—'}</td>
                  <td><button type="button" className="button-secondary button-small" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, at) => at !== index))}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="template-modal-actions start-actions">
        <button type="button" className="button-secondary" onClick={() => setLines((current) => [...current, emptyLine()])}>Add line</button>
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Saving…' : 'Create Transfer'}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
};

const StockVerificationForm = ({ items, locations, balances, batchBalances, onSave, onCancel }) => {
  const [location, setLocation] = useState('');
  const [verificationDate, setVerificationDate] = useState(today());
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => makeKey('verification'));
  const updateLine = (index, patch) => setLines((current) => current.map((line, at) => at === index ? { ...line, ...patch } : line));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!location) return setError('Select a stock location.');
    const verificationItems = lines.map((line) => {
      const item = items.find((candidate) => candidate.itemCode === line.itemCode);
      return item && line.physicalQty !== ''
        ? { itemCode: item.itemCode, batchId: line.batchId || '', physicalQty: Number(line.physicalQty), unit: item.unit, remarks: line.remarks }
        : null;
    });
    if (verificationItems.some((line) => !line) || verificationItems.some((line) => !Number.isFinite(line.physicalQty) || line.physicalQty < 0)) {
      return setError('Choose an item and enter a non-negative physical quantity for every line.');
    }
    setBusy(true);
    try {
      await onSave({ date: verificationDate, location, remarks, items: verificationItems }, idempotencyKey);
      setIdempotencyKey(makeKey('verification'));
      onCancel();
    } catch (requestError) {
      setError(requestError.message || 'Stock Verification could not be saved to PostgreSQL.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="content-block" onSubmit={submit}>
      <div className="block-header"><h3 className="block-title">New Stock Verification</h3></div>
      <div className="form-grid">
        <div className="form-field">
          <label>Location *</label>
          <select className="action-select" required value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="">Select location</option>
            {locations.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div className="form-field">
          <label>Verification Date *</label>
          <input type="date" className="action-select form-input" required value={verificationDate} onChange={(event) => setVerificationDate(event.target.value)} />
        </div>
        <div className="form-field">
          <label>Remarks</label>
          <input className="action-select form-input" value={remarks} onChange={(event) => setRemarks(event.target.value)} />
        </div>
      </div>
      <div className="history-table-wrapper">
        <table className="history-table">
          <thead><tr><th>Item *</th><th>Batch / Lot</th><th>System Quantity</th><th>Physical Quantity *</th><th>Unit</th><th>Line Remarks</th><th /></tr></thead>
          <tbody>
            {lines.map((line, index) => {
              const item = items.find((candidate) => candidate.itemCode === line.itemCode);
              const batches = batchBalances.filter((batch) => batch.item_code === line.itemCode && batch.location === location);
              const batch = batches.find((entry) => entry.batch_id === line.batchId);
              const balance = balances.find((entry) => entry.item_code === line.itemCode && entry.location === location);
              const systemQuantity = line.batchId ? quantity(batch?.quantity) : quantity(balance?.quantity);
              return (
                <tr key={index}>
                  <td>
                    <select className="action-select" required value={line.itemCode} onChange={(event) => updateLine(index, { itemCode: event.target.value, batchId: '' })}>
                      <option value="">Select item</option>
                      {items.map((entry) => <option key={entry.itemCode} value={entry.itemCode}>{entry.itemCode} · {entry.materialName || entry.itemName}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="action-select" value={line.batchId} onChange={(event) => updateLine(index, { batchId: event.target.value })}>
                      <option value="">Whole item balance</option>
                      {batches.map((entry) => <option key={entry.batch_id} value={entry.batch_id}>{entry.batch_number} · {entry.lot_number || 'No lot'}</option>)}
                    </select>
                  </td>
                  <td>{line.itemCode ? systemQuantity : '—'}</td>
                  <td><input type="number" min="0" step="any" required className="issue-qty-input" value={line.physicalQty} onChange={(event) => updateLine(index, { physicalQty: event.target.value })} /></td>
                  <td>{item?.unit || '—'}</td>
                  <td><input className="issue-qty-input wide" value={line.remarks} onChange={(event) => updateLine(index, { remarks: event.target.value })} /></td>
                  <td><button type="button" className="button-secondary button-small" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, at) => at !== index))}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="template-modal-actions start-actions">
        <button type="button" className="button-secondary" onClick={() => setLines((current) => [...current, emptyLine()])}>Add line</button>
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Saving…' : 'Submit Verification'}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
};

const StoreInventoryWorkflowsPage = () => {
  const [tab, setTab] = useState('transfers');
  const [createMode, setCreateMode] = useState(false);
  const [items, setItems] = useState([]);
  const [balances, setBalances] = useState([]);
  const [batchBalances, setBatchBalances] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [verifications, setVerifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canWrite = userCanWrite();
  const canResolve = isAdmin() || hasPermission('inventory.adjust');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [itemRows, locationRows, batchRows, transferRows, verificationRows] = await Promise.all([
        listInventoryItems(),
        listInventoryLocationBalances(),
        listInventoryLocationBatchBalances(),
        listStockTransfers(),
        listStockVerifications()
      ]);
      setItems(itemRows);
      setBalances(locationRows);
      setBatchBalances(batchRows);
      setTransfers(transferRows);
      setVerifications(verificationRows);
    } catch (requestError) {
      setItems([]);
      setBalances([]);
      setBatchBalances([]);
      setTransfers([]);
      setVerifications([]);
      setError(`Store transfer and verification data could not be loaded from PostgreSQL: ${requestError.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const locations = useMemo(() => [...new Set(balances.map((row) => row.location).filter(Boolean))].sort(), [balances]);
  const saveTransfer = async (data, idempotencyKey) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await createStockTransfer(data, idempotencyKey);
      setNotice(`Stock Transfer ${result.record.transferNumber} created in PostgreSQL.`);
      await refresh();
      return result;
    } finally { setBusy(false); }
  };
  const saveVerification = async (data, idempotencyKey) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await createStockVerification(data, idempotencyKey);
      setNotice(`Stock Verification ${result.record.verificationNumber} submitted for approval.`);
      await refresh();
      return result;
    } finally { setBusy(false); }
  };
  const resolveDocument = async (kind, record, action) => {
    const reason = action === 'reject' ? window.prompt(`Reason for rejecting ${kind === 'transfer' ? record.transferNumber : record.verificationNumber}:`)?.trim() : '';
    if (action === 'reject' && !reason) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const number = kind === 'transfer' ? record.transferNumber : record.verificationNumber;
      const payload = { version: record.recordVersion, idempotencyKey: makeKey(`${kind}-${action}`), ...(reason ? { reason } : {}) };
      if (kind === 'transfer') await resolveStockTransfer(number, action, payload);
      else await resolveStockVerification(number, action, payload);
      setNotice(`${kind === 'transfer' ? 'Stock Transfer' : 'Stock Verification'} ${number} ${action === 'approve' ? 'approved' : 'rejected'}.`);
      await refresh();
    } catch (requestError) {
      setError(`The record could not be ${action === 'approve' ? 'approved' : 'rejected'}: ${requestError.message}`);
    } finally { setBusy(false); }
  };

  return (
    <section className="page-section">
      <div className="page-header">
        <div><h1 className="page-title">Stock Transfers &amp; Verification</h1></div>
        <div className="header-actions">
          {canWrite && !createMode && <button type="button" className="button-primary" onClick={() => setCreateMode(true)}>+ New {tab === 'transfers' ? 'Transfer' : 'Verification'}</button>}
          <button type="button" className="button-secondary" onClick={refresh} disabled={loading || busy}>Refresh</button>
        </div>
      </div>
      {loading && <p className="muted" role="status">Loading stock workflows from PostgreSQL…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="success-message" role="status">{notice}</p>}
      <div className="tab-nav">
        <button type="button" className={`tab-link ${tab === 'transfers' ? 'active' : ''}`} onClick={() => { setTab('transfers'); setCreateMode(false); }}>Stock Transfers ({transfers.length})</button>
        <button type="button" className={`tab-link ${tab === 'verifications' ? 'active' : ''}`} onClick={() => { setTab('verifications'); setCreateMode(false); }}>Stock Verification ({verifications.length})</button>
      </div>
      {createMode && canWrite ? (
        tab === 'transfers'
          ? <StockTransferForm items={items} locations={locations} balances={balances} batchBalances={batchBalances} onSave={saveTransfer} onCancel={() => setCreateMode(false)} />
          : <StockVerificationForm items={items} locations={locations} balances={balances} batchBalances={batchBalances} onSave={saveVerification} onCancel={() => setCreateMode(false)} />
      ) : tab === 'transfers' ? (
        <div className="content-block">
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead><tr><th>Transfer No.</th><th>Date</th><th>From</th><th>To</th><th>Items</th><th>Requested By</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {transfers.map((record) => (
                  <tr key={record.transferNumber}>
                    <td>{record.transferNumber}</td><td>{record.transferDate}</td><td>{record.fromLocation}</td><td>{record.toLocation}</td>
                    <td>{(record.items || []).map((line) => `${line.itemName} ${line.quantity} ${line.unit}${line.batchNumber ? ` (${line.batchNumber})` : ''}`).join('; ')}</td>
                    <td>{record.requestedBy}</td><td>{record.status}</td>
                    <td>{record.status === 'Pending' && canResolve && <><button type="button" className="button-primary button-small" disabled={busy} onClick={() => resolveDocument('transfer', record, 'approve')}>Approve &amp; Post</button> <button type="button" className="button-secondary button-small" disabled={busy} onClick={() => resolveDocument('transfer', record, 'reject')}>Reject</button></>}</td>
                  </tr>
                ))}
                {!transfers.length && !loading && <tr><td colSpan="8">No Stock Transfers found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="content-block">
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead><tr><th>Verification No.</th><th>Date</th><th>Location</th><th>Items / Variance</th><th>Verified By</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {verifications.map((record) => (
                  <tr key={record.verificationNumber}>
                    <td>{record.verificationNumber}</td><td>{record.verificationDate}</td><td>{record.location}</td>
                    <td>{(record.items || []).map((line) => `${line.itemName}: ${line.systemQty} → ${line.physicalQty} (${line.difference})`).join('; ')}</td>
                    <td>{record.verifiedBy}</td><td>{record.status}</td>
                    <td>{record.status === 'Pending Approval' && canResolve && <><button type="button" className="button-primary button-small" disabled={busy} onClick={() => resolveDocument('verification', record, 'approve')}>Approve &amp; Adjust Ledger</button> <button type="button" className="button-secondary button-small" disabled={busy} onClick={() => resolveDocument('verification', record, 'reject')}>Reject</button></>}</td>
                  </tr>
                ))}
                {!verifications.length && !loading && <tr><td colSpan="7">No Stock Verifications found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};

export default StoreInventoryWorkflowsPage;
