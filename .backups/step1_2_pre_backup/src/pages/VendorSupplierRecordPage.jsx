import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import { hasPermission } from '../utils/permissions.js';
import { getPurchaseOrders, getPOProgress, getReceiptsForPO } from '../utils/workflowService.js';
import { ReceiptForm } from './MaterialReceiptsPage.jsx';

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const num = (v) => Number(v) || 0;

/**
 * Store → Vendor / Supplier Record
 * ---------------------------------------------------------------------------
 * Every Purchase Order raised for a vendor with what the vendor has delivered so
 * far. Opening a PO shows its full material list and lets Store record the
 * delivery the vendor physically sent (tax invoice no., DC, vehicle + files) for
 * whatever quantity arrived — the balance stays visible as Pending.
 */
const VendorSupplierRecordPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedPO, setSelectedPO] = useState(location.state?.poNumber || '');
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);

  const canCreate = hasPermission('receipt.create');

  const pos = useMemo(
    () => getPurchaseOrders().filter((p) => !['Cancelled'].includes(p.status)),
    [tick]
  );

  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 8000);
  };

  const selected = selectedPO ? pos.find((p) => String(p.reference) === String(selectedPO)) || null : null;
  const progress = selected ? getPOProgress(selected.reference) : null;
  const receipts = useMemo(
    () => (selectedPO ? getReceiptsForPO(selectedPO) : []),
    [selectedPO, tick]
  );

  const messageBox = message && (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: '8px',
        marginBottom: '16px',
        fontWeight: 600,
        background: message.type === 'ok' ? '#dcfce7' : '#fee2e2',
        color: message.type === 'ok' ? '#166534' : '#b91c1c'
      }}
    >
      {message.text}
    </div>
  );

  /* ------------------------------- PO record ------------------------------- */
  if (selected && progress) {
    return (
      <section className="page-section">
        <div className="page-header">
          <div>
            <div className="eyebrow">Store / Vendor Supplier Record</div>
            <h1 className="page-title">{selected.reference}</h1>
            <p className="page-description">
              {selected.vendor} · Ordered {progress.ordered} | Received {progress.received} | Pending {progress.pending}
              {progress.fullyReceived ? ' — PO CLOSED – FULLY RECEIVED' : ''}
            </p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={() => setSelectedPO('')}>← Back to Vendor Records</button>
          </div>
        </div>

        {messageBox}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">PO Details — {selected.reference}</h3>
            <span className={badgeClass(progress.computedStatus || selected.status)}>{progress.computedStatus || selected.status}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '14px' }}>
            <div><strong>Vendor / Supplier:</strong> {selected.vendor}</div>
            <div><strong>PO Date:</strong> {selected.date || selected.payload?.poDetails?.poDate || '—'}</div>
            <div><strong>Sales Order:</strong> {selected.payload?.poDetails?.salesOrderRef || '—'}</div>
            <div><strong>Materials:</strong> {progress.lines.length}</div>
            <div><strong>Receipts recorded:</strong> {progress.receiptCount}</div>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th><th>Material</th><th>Unit</th>
                  <th>Ordered Qty</th><th>Received Qty</th><th>Pending Qty</th>
                </tr>
              </thead>
              <tbody>
                {progress.lines.map((l, idx) => (
                  <tr key={`${l.materialCode}-${idx}`}>
                    <td>{idx + 1}</td>
                    <td><strong>{l.materialName}</strong></td>
                    <td>{l.unit}</td>
                    <td>{num(l.orderedQty)}</td>
                    <td>{num(l.receivedQty)}</td>
                    <td>
                      <strong style={{ color: l.pendingQty > 0 ? '#b91c1c' : '#166534' }}>{num(l.pendingQty)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {canCreate ? (
          <ReceiptForm
            key={`${selected.reference}-${tick}`}
            initialPO={selected.reference}
            onDone={(receiptNumber) => {
              setSelectedPO('');
              flash('ok', `Material Receipt ${receiptNumber} recorded for ${selected.reference} — the delivered quantity is updated and the balance stays pending.`);
            }}
            onCancel={() => setSelectedPO('')}
            onError={(err) => flash('err', err.message)}
          />
        ) : (
          <div className="content-block">
            <p style={{ color: '#92400e', fontSize: '13px', fontWeight: 600 }}>
              Your department can view the vendor record but only the Store Department can enter a delivery.
            </p>
          </div>
        )}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Vendor Delivery Records ({receipts.length})</h3>
          </div>
          {receipts.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              No delivery recorded against this PO yet — enter the vendor's tax invoice above.
            </p>
          ) : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Receipt No</th><th>Date</th><th>Invoice No</th><th>DC No</th><th>Vehicle</th>
                    <th>Delivered By</th><th>Qty Received</th><th>Quality Check</th><th>Documents</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.receiptNumber}>
                      <td><strong>{r.receiptNumber}</strong></td>
                      <td>{r.receiptDate}</td>
                      <td>{r.invoiceNumber || '—'}</td>
                      <td>{r.dcNumber || '—'}</td>
                      <td>{r.vehicleNumber || '—'}</td>
                      <td>{r.deliveredBy ? `${r.deliveredBy}${r.contactNumber ? ` · ${r.contactNumber}` : ''}` : '—'}</td>
                      <td>{num((r.items || []).reduce((a, i) => a + num(i.receivedQty), 0))}</td>
                      <td><span className={badgeClass(r.qcStatus || 'Pending')}>{r.qcStatus || 'Pending Quality Check'}</span></td>
                      <td>{(r.documents || []).length} file(s)</td>
                      <td>
                        <button
                          className="button-small button-secondary"
                          onClick={() => navigate('/material-receipts', { state: { openReceipt: r.receiptNumber } })}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    );
  }

  /* ------------------------------ vendor list ------------------------------ */
  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Store</div>
          <h1 className="page-title">Vendor / Supplier Record</h1>
          <p className="page-description">
            Purchase Orders fetched per vendor/supplier with the material the vendor has delivered so far. Open a PO to
            record what arrived (tax invoice no., DC, vehicle + files) — delivered quantity is updated and the balance
            stays pending until the vendor sends the rest.
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          <button className="button-secondary" onClick={() => navigate('/material-receipts')}>Material Receipts</button>
        </div>
      </div>

      {messageBox}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Vendor Purchase Orders ({pos.length})</h3>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>PO Number</th><th>Vendor / Supplier</th><th>PO Date</th><th>Sales Order</th>
                <th>Materials</th><th>Ordered</th><th>Received</th><th>Pending</th><th>Status</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {pos.length === 0 ? (
                <tr><td colSpan="10" className="no-history-row">No Purchase Orders yet.</td></tr>
              ) : (
                pos.map((p) => {
                  const prog = getPOProgress(p.reference);
                  return (
                    <tr key={p.reference}>
                      <td><strong>{p.reference}</strong></td>
                      <td>{p.vendor || p.payload?.vendorDetails?.companyName || '—'}</td>
                      <td>{p.date || p.payload?.poDetails?.poDate || '—'}</td>
                      <td>{p.payload?.poDetails?.salesOrderRef || '—'}</td>
                      <td>{prog.lines.length}</td>
                      <td>{prog.ordered}</td>
                      <td>{prog.received}</td>
                      <td><strong style={{ color: prog.pending > 0 ? '#b91c1c' : '#166534' }}>{prog.pending}</strong></td>
                      <td><span className={badgeClass(prog.computedStatus || p.status)}>{prog.computedStatus || p.status}</span></td>
                      <td>
                        <button className="button-small button-secondary" onClick={() => setSelectedPO(p.reference)}>
                          {canCreate ? 'Receive Materials' : 'View'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

export default VendorSupplierRecordPage;
