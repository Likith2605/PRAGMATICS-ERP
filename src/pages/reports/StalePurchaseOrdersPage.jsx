import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getStalePurchaseOrderRows, purchaseOrderFilters } from '../../utils/purchaseReportData.js';
import { listPurchaseOrders, shortClosePurchaseOrderApi } from '../../services/procurementIntakeApi.js';
import { hasPermission } from '../../utils/permissions.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const REASONS = [
  'Vendor unable to supply',
  'Customer order cancelled',
  'Material requirement reduced',
  'Alternative supplier selected',
  'Remaining quantity no longer required'
];
const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const StalePurchaseOrdersPage = () => {
  const [serverOrders, setServerOrders] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [remarks, setRemarks] = useState('');
  const [message, setMessage] = useState('');

  /* The report is derived from PostgreSQL-confirmed Purchase Orders. A failed
   * load shows an error instead of silently falling back to a browser cache. */
  const loadOrders = useCallback(async () => {
    const orders = await listPurchaseOrders();
    setServerOrders(orders);
    setLoadError('');
  }, []);
  useEffect(() => {
    loadOrders().catch((error) => setLoadError(`Purchase Orders could not be loaded from PostgreSQL: ${error.message}`));
  }, [loadOrders]);

  const rows = useMemo(() => getStalePurchaseOrderRows(undefined, serverOrders), [serverOrders]);
  const filters = purchaseOrderFilters(rows);
  const canShortClose = hasPermission('purchase.order.short_close');

  const submitShortClose = async (event) => {
    event.preventDefault();
    try {
      const closed = await shortClosePurchaseOrderApi(selected.poNumber, selected.version, reason, remarks);
      setMessage(`PO ${closed.record.reference} was short-closed. Its original ordered and receipt quantities were preserved.`);
      setSelected(null);
      setReason(REASONS[0]);
      setRemarks('');
      await loadOrders();
    } catch (error) {
      setMessage(error.message || 'Unable to short-close this Purchase Order.');
    }
  };

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      {message && <div className="field-hint" role="status" style={{ marginBottom: 12 }}>{message}</div>}
      {loadError && <div role="alert" className="form-error" style={{ marginBottom: 12 }}>{loadError}</div>}
      <ReportRegister
        title="Stale Purchase Order Report"
        subTitle="Open and partially received POs past their expected delivery dates. Overdue is derived separately from the actual PO status."
        filename={`Stale-Purchase-Orders-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        rows={rows}
        columns={[
          { key: 'poNumber', label: 'PO Number' },
          { key: 'supplier', label: 'Supplier' },
          { key: 'date', label: 'PO Date' },
          { key: 'dueDate', label: 'Expected Delivery' },
          { key: 'item', label: 'Material / Item' },
          { key: 'unit', label: 'Unit' },
          { key: 'orderedQty', label: 'Ordered Qty', align: 'right', render: (row) => qty(row.orderedQty) },
          { key: 'receivedQty', label: 'Received Qty', align: 'right', render: (row) => qty(row.receivedQty) },
          { key: 'pendingQty', label: 'Pending Qty', align: 'right', render: (row) => qty(row.pendingQty) },
          { key: 'daysOverdue', label: 'Days Overdue', align: 'right' },
          { key: 'status', label: 'PO Status' },
          ...(canShortClose ? [{ key: 'action', label: 'Action', render: (row) => <button type="button" className="button-secondary button-small" onClick={() => { setSelected(row); setMessage(''); }}>Short Close</button>, renderText: () => '' }] : [])
        ]}
        filters={[
          { key: 'supplier', placeholder: 'All Suppliers', options: filters.suppliers.map((value) => ({ value, label: value })) },
          { key: 'item', placeholder: 'All Materials', options: filters.items.map((value) => ({ value, label: value })) },
          { key: 'status', placeholder: 'All PO Statuses', options: filters.statuses.map((value) => ({ value, label: value })) }
        ]}
        totals={[
          { colKey: 'orderedQty', render: (items) => formatQuantityByUnit(items, 'orderedQty') },
          { colKey: 'receivedQty', render: (items) => formatQuantityByUnit(items, 'receivedQty') },
          { colKey: 'pendingQty', render: (items) => formatQuantityByUnit(items, 'pendingQty') }
        ]}
      />
      {selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <form className="content-block" role="dialog" aria-modal="true" aria-labelledby="short-close-title" onSubmit={submitShortClose} style={{ maxWidth: 560, margin: '10vh auto', padding: 22 }}>
            <h2 id="short-close-title" className="block-title">Short-close PO {selected.poNumber}</h2>
            <p className="muted-text">Supplier: {selected.supplier}. The PO and receipt history stay unchanged. Remaining open balance: {qty(selected.pendingQty)}.</p>
            <label className="field-group" style={{ display: 'block', marginTop: 16 }}>
              <span>Closure reason</span>
              <select className="action-select" value={reason} onChange={(event) => setReason(event.target.value)} required>
                {REASONS.map((entry) => <option key={entry}>{entry}</option>)}
              </select>
            </label>
            <label className="field-group" style={{ display: 'block', marginTop: 12 }}>
              <span>Remarks (required)</span>
              <textarea className="form-input" rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} required />
            </label>
            <div className="form-actions" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="button-secondary" onClick={() => setSelected(null)}>Cancel</button>
              <button type="submit" className="button-primary">Approve & Short Close</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default StalePurchaseOrdersPage;
