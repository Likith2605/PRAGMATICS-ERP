import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import {
  getSalesOrders,
  getSalesOrderByRef,
  previewAvailability,
  saveMaterialAvailabilityCheck,
  getAvailabilityCheck,
  createPurchaseIndent,
  getIndentForSO,
  getSalesOrderMaterialStatus,
  getSalesOrdersAwaitingCheck,
  getDocumentChain,
  hydrateAvailabilityChecks
} from '../utils/workflowService.js';

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

const qty = (v) => Number(v) || 0;

const StoreSalesOrderReviewPage = () => {
  const navigate = useNavigate();
  const [viewSO, setViewSO] = useState(null);
  const [search, setSearch] = useState('');
  const [remarks, setRemarks] = useState('');
  const [indentReason, setIndentReason] = useState('Shortage against Sales Order');
  const [indentRemarks, setIndentRemarks] = useState('');
  const [indentRequiredDate, setIndentRequiredDate] = useState('');
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    hydrateAvailabilityChecks()
      .then(() => { if (active) setTick((value) => value + 1); })
      .catch((error) => {
        if (active) setMessage({ type: 'err', text: `Availability checks could not be loaded from PostgreSQL: ${error.message}` });
      });
    const refresh = () => setTick((value) => value + 1);
    window.addEventListener('availability-checks-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('availability-checks-updated', refresh);
    };
  }, []);

  const salesOrders = useMemo(() => getSalesOrders(), [tick]);
  const awaiting = useMemo(() => getSalesOrdersAwaitingCheck(), [tick]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return salesOrders;
    return salesOrders.filter((so) =>
      [so.reference, so.company, so.quotationRef, so.status].join(' ').toLowerCase().includes(q)
    );
  }, [salesOrders, search]);

  const so = viewSO ? getSalesOrderByRef(viewSO) : null;
  const savedCheck = so ? getAvailabilityCheck(so.reference) : null;
  const liveAvailability = so ? previewAvailability(so.reference) : null;
  const availability = liveAvailability ? {
    ...liveAvailability,
    lines: savedCheck?.lines || liveAvailability.lines,
    checked: Boolean(savedCheck),
    savedRecord: savedCheck
  } : null;
  const materialStatus = so ? getSalesOrderMaterialStatus(so.reference) : null;
  const indents = so ? getIndentForSO(so.reference) : [];
  const chain = so ? getDocumentChain(so.reference) : null;

  const shortageLines = (availability?.lines || []).filter((l) => qty(l.shortageQty) > 0);
  const linesToIndent = shortageLines.filter(
    (l) => selectedCodes.length === 0 || selectedCodes.includes(l.materialCode || l.materialName)
  );

  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 6000);
  };

  const handleSaveCheck = async () => {
    try {
      await saveMaterialAvailabilityCheck({ soNumber: so.reference, remarks });
      flash('ok', `Material availability check saved for ${so.reference}.`);
    } catch (err) {
      flash('err', err.message);
    }
  };

  const handleCreateIndent = async () => {
    try {
      const indent = await createPurchaseIndent({
        soNumber: so.reference,
        reason: indentReason,
        remarks: indentRemarks,
        requiredDate: indentRequiredDate,
        selectedCodes: selectedCodes.length ? selectedCodes : null,
        persistToPostgres: true
      });
      setSelectedCodes([]);
      setIndentRemarks('');
      flash('ok', `Purchase Indent ${indent.indentNumber} created.`);
      navigate('/purchase-indents', { state: { openIndent: indent.indentNumber } });
    } catch (err) {
      flash('err', err.message);
    }
  };

  const openSO = (ref) => {
    setViewSO(ref);
    setSelectedCodes([]);
    setMessage(null);
    const check = getAvailabilityCheck(ref);
    setRemarks(check?.remarks || '');
    setIndentReason('Shortage against Sales Order');
    const soRec = getSalesOrderByRef(ref);
    setIndentRequiredDate(soRec?.payload?.soDetails?.deliveryDate || '');
  };

  if (so) {
    return (
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 className="page-title">Review Sales Order {so.reference}</h1>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={() => { setViewSO(null); setTick((t) => t + 1); }}>
              ← Back to Sales Orders
            </button>
          </div>
        </div>

        {message && (
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
        )}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Sales Order Details</h3>
            <span className={badgeClass(materialStatus?.overallStatus || 'Pending')}>
              {materialStatus?.overallStatus === 'COMPLETED' ? 'MATERIALS COMPLETE' : 'MATERIALS PENDING'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            <div><strong>Sales Order No:</strong> {so.reference}</div>
            <div><strong>Customer:</strong> {so.payload?.customerDetails?.companyName || so.company || '—'}</div>
            <div><strong>Order Date:</strong> {so.payload?.soDetails?.soDate || so.date || '—'}</div>
            <div><strong>Required Delivery Date:</strong> {so.payload?.soDetails?.deliveryDate || '—'}</div>
            <div><strong>Project ID:</strong> {so.payload?.soDetails?.projectId || '—'}</div>
            <div><strong>Order Status:</strong> {so.status}</div>
          </div>
        </div>

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Material Availability Check</h3>
            {savedCheck ? (
              <span className={badgeClass('Checked')}>Checked · {savedCheck.checkedBy} · {savedCheck.checkedDate}</span>
            ) : (
              <span className={badgeClass('Pending')}>Awaiting Store Check</span>
            )}
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Material Name</th>
                  <th>Ordered Qty</th>
                  <th>Available Stock</th>
                  <th>Required Qty</th>
                  <th>Available Qty</th>
                  <th>Shortage Qty</th>
                  <th>Unit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(availability?.lines || []).map((l, idx) => (
                  <tr key={`${l.materialCode}-${idx}`}>
                    <td>{idx + 1}</td>
                    <td>{l.materialName}</td>
                    <td>{qty(l.orderedQty)}</td>
                    <td>{qty(l.availableStock)}</td>
                    <td>{qty(l.requiredQty)}</td>
                    <td style={{ color: '#166534', fontWeight: 700 }}>{qty(l.availableQty)}</td>
                    <td style={{ color: qty(l.shortageQty) > 0 ? '#b91c1c' : '#166534', fontWeight: 700 }}>
                      {qty(l.shortageQty)}
                    </td>
                    <td>{l.unit}</td>
                    <td><span className={badgeClass(l.status)}>{l.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="field-group full-width" style={{ marginTop: '14px' }}>
            <label>Store remarks</label>
            <textarea
              rows="2"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Observations during the availability check..."
            />
          </div>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="button-primary" onClick={handleSaveCheck}>
              {savedCheck ? 'Re-save Availability Check' : 'Save Availability Check'}
            </button>
          </div>
        </div>

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Procurement Status (Required | Available | Purchased | Received | Pending)</h3>
            <span className={badgeClass(materialStatus?.overallStatus || 'Pending')}>
              {materialStatus?.overallStatus}
            </span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Material</th>
                  <th>Required</th>
                  <th>Available</th>
                  <th>Purchased</th>
                  <th>Received</th>
                  <th>Pending</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(materialStatus?.lines || []).map((l, idx) => (
                  <tr key={`${l.materialCode}-${idx}`}>
                    <td>{idx + 1}</td>
                    <td><strong>{l.materialName}</strong></td>
                    <td>{qty(l.required)}</td>
                    <td>{qty(l.available)}</td>
                    <td>{qty(l.purchased)}</td>
                    <td>{qty(l.received)}</td>
                    <td style={{ fontWeight: 700, color: qty(l.pending) > 0 ? '#b91c1c' : '#166534' }}>{qty(l.pending)}</td>
                    <td><span className={badgeClass(l.status)}>{l.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {shortageLines.length > 0 && (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Create Purchase Indent ({shortageLines.length} material(s) with shortage)</h3>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th style={{ width: '40px' }}>Select</th>
                    <th>Material</th>
                    <th>Unit</th>
                    <th>Required</th>
                    <th>Available</th>
                    <th>Shortage / Purchase Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {shortageLines.map((l, idx) => {
                    const key = l.materialCode || l.materialName;
                    const checked = selectedCodes.length === 0 || selectedCodes.includes(key);
                    return (
                      <tr key={key}>
                        <td>{idx + 1}</td>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedCodes((prev) => {
                                const allKeys = shortageLines.map((s) => s.materialCode || s.materialName);
                                const current = prev.length === 0 ? allKeys : prev;
                                if (e.target.checked) return Array.from(new Set([...current, key]));
                                return current.filter((k) => k !== key);
                              });
                            }}
                          />
                        </td>
                        <td><strong>{l.materialName}</strong></td>
                        <td>{l.unit}</td>
                        <td>{qty(l.requiredQty)}</td>
                        <td>{qty(l.availableStock)}</td>
                        <td><strong style={{ color: '#b91c1c' }}>{qty(l.shortageQty)}</strong></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="section-grid" style={{ marginTop: '14px' }}>
              <div className="field-group">
                <label>Reason</label>
                <input
                  type="text"
                  value={indentReason}
                  onChange={(e) => setIndentReason(e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Required Date</label>
                <input type="date" value={indentRequiredDate} onChange={(e) => setIndentRequiredDate(e.target.value)} />
              </div>
              <div className="field-group full-width">
                <label>Store remarks</label>
                <textarea rows="2" value={indentRemarks} onChange={(e) => setIndentRemarks(e.target.value)} />
              </div>
            </div>

            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="button-primary" onClick={handleCreateIndent}>
                Create Purchase Indent ({linesToIndent.length} material(s))
              </button>
            </div>
          </div>
        )}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Document Chain</h3>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <span className={badgeClass('Sales Order')}>{so.reference}</span>
            <span>→</span>
            <span className={badgeClass('Check')}>{savedCheck ? `Checked ${savedCheck.checkedDate}` : 'Not Checked'}</span>
            <span>→</span>
            {indents.length === 0 ? (
              <span className={badgeClass('Pending')}>No Indent</span>
            ) : (
              indents.map((i) => (
                <span key={i.indentNumber} className={badgeClass(i.status)}>
                  {i.indentNumber} · {i.status}
                </span>
              ))
            )}
            {chain?.purchaseOrders?.map((p) => (
              <span key={p.reference} className={badgeClass(p.status)}>{p.reference} · {p.status}</span>
            ))}
            {chain?.receipts?.map((r) => (
              <span key={r.receiptNumber} className={badgeClass('Received')}>{r.receiptNumber}</span>
            ))}
            {chain?.qualityChecks?.map((q) => (
              <span key={q.qcNumber} className={badgeClass(q.status)}>{q.qcNumber} · {q.status}</span>
            ))}
            {chain?.rejections?.map((r) => (
              <span key={r.rejectionNumber} className={badgeClass('Rejected')}>{r.rejectionNumber}</span>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Orders — Material Availability</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      {message && (
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
      )}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Sales Orders ({filtered.length})</h3>
        </div>
        <div className="list-filters">
          <input
            type="text"
            className="action-select form-input search-input"
            placeholder="Search SO number / customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>SO Number</th>
                <th>Customer</th>
                <th>Delivery Date</th>
                <th>Materials</th>
                <th>Availability Check</th>
                <th>Material Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="8" className="no-history-row">No Sales Orders found.</td>
                </tr>
              ) : (
                filtered.map((row) => {
                  const check = getAvailabilityCheck(row.reference);
                  const status = getSalesOrderMaterialStatus(row.reference);
                  return (
                    <tr key={row.reference}>
                      <td>{row.date}</td>
                      <td><strong>{row.reference}</strong></td>
                      <td>{row.company}</td>
                      <td>{row.payload?.soDetails?.deliveryDate || '—'}</td>
                      <td>{row.payload?.items?.length || 0}</td>
                      <td>
                        <span className={badgeClass(check ? 'Checked' : 'Pending')}>
                          {check ? `Checked ${check.checkedDate}` : 'Awaiting Check'}
                        </span>
                      </td>
                      <td>
                        <span className={badgeClass(status?.overallStatus || 'Pending')}>
                          {status?.overallStatus || '—'}
                        </span>
                      </td>
                      <td>
                        <button className="button-small button-secondary" onClick={() => openSO(row.reference)}>
                          Review
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

export default StoreSalesOrderReviewPage;
