import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { hasPermission, isAdmin } from '../utils/permissions.js';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import {
  listJobCards,
  listHtOutsource,
  createHtOutsource,
  assignHtVendor,
  issueHt,
  receiveHt,
  completeHt,
  cancelHt
} from '../services/productionApi.js';

const HT_OUTSOURCE_STATUS = Object.freeze({
  RAISED: 'Raised',
  VENDOR_ASSIGNED: 'Vendor Assigned',
  ISSUED: 'Issued to Vendor',
  RECEIVED: 'Received at Store',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
});

const todayStr = () => new Date().toISOString().slice(0, 10);
const newCreateToken = () => globalThis.crypto?.randomUUID?.() || `htr-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const StatusChip = ({ status }) => {
  const cls = (status || '').toLowerCase().replace(/\s+/g, '-');
  return <span className={`status-badge st-${cls}`}>{status}</span>;
};

const fieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  minWidth: 0
};

const labelStyle = { fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em' };

const inputStyle = {
  border: '1px solid #d1d5db',
  borderRadius: '7px',
  padding: '8px 10px',
  font: 'inherit',
  fontSize: '13px',
  background: '#fff',
  width: '100%',
  boxSizing: 'border-box'
};

const acInputStyle = { ...inputStyle, width: '100%' };

const HTOutsourcePage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [viewNumber, setViewNumber] = useState(location.state?.viewHtrNumber || null);
  const [mode, setMode] = useState(location.state?.createForJobCard || location.state?.viewHtrNumber ? (location.state?.viewHtrNumber ? 'list' : 'create') : 'list');

  const canPurchase = hasPermission('ht_outsource.purchase_action') || hasPermission('purchase.order');
  const canStore = hasPermission('ht_outsource.store_action') || hasPermission('material_issue.confirm');
  const canComplete = hasPermission('ht_outsource.create') || hasPermission('production.qc.manage') || hasPermission('job_card.update_progress');
  const canCancel = isAdmin();
  const canCreate = hasPermission('ht_outsource.create') || hasPermission('job_card.create');


  useEffect(() => {
    if (location.state?.viewHtrNumber) {
      setMode('list');
      setViewNumber(location.state.viewHtrNumber);
    }
    if (location.state?.createForJobCard) {
      setMode('create');
      setForm((prev) => ({ ...prev, jobCardNumber: location.state.createForJobCard }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const [all, setAll] = useState([]);
  const [jobCards, setJobCards] = useState([]);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const [requests, cards] = await Promise.all([listHtOutsource(), listJobCards()]);
      setAll(requests.slice().sort((a, b) => String(b.requestDate).localeCompare(String(a.requestDate))));
      setJobCards(cards.slice().sort((a, b) => String(b.jobCardNumber).localeCompare(String(a.jobCardNumber))));
    } catch (err) {
      setError(err.message || 'Could not load HT outsource data from PostgreSQL.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const activeHTRByJc = useMemo(() => {
    const map = {};
    all.forEach((r) => {
      if (r.status === HT_OUTSOURCE_STATUS.CANCELLED) return;
      if (!map[r.jobCardNumber]) map[r.jobCardNumber] = r;
    });
    return map;
  }, [all]);

  /* ---- create form (Job Card dropdown — no typing) ---- */
  const emptyCreate = {
    jobCardNumber: '',
    processType: '',
    processSpec: '',
    targetHardness: '',
    qtyRequested: '',
    vendorName: '',
    needByDate: '',
    remarks: ''
  };
  const [form, setForm] = useState(emptyCreate);
  const [formErr, setFormErr] = useState('');

  useEffect(() => {
    if (location.state?.createForJobCard) {
      const jc = jobCards.find((j) => j.jobCardNumber === location.state.createForJobCard);
      if (jc) prefillFromJobCard(jc, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.createForJobCard, jobCards.length]);

  const prefillFromJobCard = (jc, keepMode = false) => {
    if (!jc) {
      setForm((prev) => ({ ...prev, jobCardNumber: '' }));
      return;
    }
    const ht = jc.operations?.heatTreatment || {};
    const existing = activeHTRByJc[jc.jobCardNumber];
    setForm({
      jobCardNumber: jc.jobCardNumber,
      processType: ht.processType || '',
      processSpec: ht.process || '',
      targetHardness: ht.targetHardness || '',
      qtyRequested: String(ht.qtySent || jc.orderQuantity || ''),
      vendorName: ht.vendor && ht.vendor !== 'Vendor name pending' ? ht.vendor : '',
      needByDate: jc.targetDate || '',
      remarks: ht.remarks || (existing ? `Linked existing ${existing.htrNumber}` : '')
    });
    setFormErr(existing ? `${existing.htrNumber} already open for this Job Card (${existing.status}).` : '');
    if (keepMode) setMode('create');
  };

  const handleCreateHTR = async () => {
    setFormErr('');
    if (!form.jobCardNumber) return setFormErr('Select a Job Card from the dropdown (do not type).');
    if (activeHTRByJc[form.jobCardNumber]) {
      return setFormErr(`${activeHTRByJc[form.jobCardNumber].htrNumber} already exists for this Job Card.`);
    }
    const jc = jobCards.find((j) => j.jobCardNumber === form.jobCardNumber);
    if (!jc) return setFormErr('Selected Job Card not found.');
    if (!jc.operations?.heatTreatment?.required) {
      return setFormErr('This Job Card does not have Heat Treatment marked as Required.');
    }
    if (!Number(form.qtyRequested) || Number(form.qtyRequested) <= 0) {
      return setFormErr('Qty to send must be greater than 0.');
    }
    try {
      const result = await createHtOutsource({
        jobCardNumber: form.jobCardNumber,
        projectId: jc.projectId || '',
        partCode: jc.partNumber || jc.drawingNumber || '',
        partName: jc.partName || '',
        drawingNumber: jc.drawingNumber || '',
        processType: form.processType,
        processSpec: form.processSpec,
        targetHardness: form.targetHardness,
        qtyRequested: Number(form.qtyRequested),
        vendorName: form.vendorName || '',
        needByDate: form.needByDate || jc.targetDate || '',
        remarks: form.remarks || ''
      }, newCreateToken());
      const rec = result.record;
      setForm(emptyCreate);
      setMode('list');
      setViewNumber(rec.htrNumber);
      await refresh();
    } catch (e) {
      setFormErr(e.message || 'Could not create the HTR.');
    }
  };

  const openJobCard = (jobCardNumber) => {
    const jc = jobCards.find((j) => j.jobCardNumber === jobCardNumber);
    if (!jc) {
      alert(`Job Card ${jobCardNumber} not found.`);
      return;
    }
    navigate('/production', { state: { viewJobCard: jc } });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (statusFilter !== 'All' && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.htrNumber, r.jobCardNumber, r.partName, r.vendorName, r.projectId, r.raisedBy]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [all, statusFilter, search]);

  const selected = viewNumber ? all.find((r) => r.htrNumber === viewNumber) : null;

  const atVendor = (r) => Math.max(0, (Number(r.issuedQty) || 0) - (Number(r.receivedQty) || 0));

  /* ---- store issue ---- */
  const [issueQty, setIssueQty] = useState('');
  const [outwardChallan, setOutwardChallan] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [issueErr, setIssueErr] = useState('');

  const openDetail = (r) => {
    setViewNumber(r.htrNumber);
    setIssueQty(String(r.qtyRequested || ''));
    setOutwardChallan('');
    setVehicleNo('');
    setIssueErr('');
  };

  const handleIssue = async () => {
    if (!selected) return;
    setIssueErr('');
    try {
      await issueHt(selected.htrNumber, Number(selected.version) || 1, {
        qty: Number(issueQty), outwardChallan, vehicleNo
      });
      await refresh();
    } catch (e) {
      setIssueErr(e.message || 'Could not issue stock.');
    }
  };

  /* ---- store receive ---- */
  const [recvQty, setRecvQty] = useState('');
  const [inwardChallan, setInwardChallan] = useState('');
  const [recvErr, setRecvErr] = useState('');

  const handleReceive = async () => {
    if (!selected) return;
    setRecvErr('');
    try {
      await receiveHt(selected.htrNumber, Number(selected.version) || 1, {
        qty: Number(recvQty), inwardChallan
      });
      await refresh();
    } catch (e) {
      setRecvErr(e.message || 'Could not receive stock.');
    }
  };

  /* ---- purchase assign ---- */
  const [venName, setVenName] = useState('');
  const [venAddr, setVenAddr] = useState('');
  const [venPhone, setVenPhone] = useState('');
  const [venEmail, setVenEmail] = useState('');
  const [poRef, setPoRef] = useState('');
  const [rateInfo, setRateInfo] = useState('');
  const [venErr, setVenErr] = useState('');

  const handleAssignVendor = async () => {
    if (!selected) return;
    setVenErr('');
    try {
      await assignHtVendor(selected.htrNumber, Number(selected.version) || 1, {
        vendorName: venName,
        vendorAddress: venAddr,
        vendorPhone: venPhone,
        vendorEmail: venEmail,
        poRef,
        rateInfo
      });
      await refresh();
    } catch (e) {
      setVenErr(e.message || 'Could not assign vendor.');
    }
  };

  /* ---- production complete ---- */
  const [actualHrc, setActualHrc] = useState('');
  const [disp, setDisp] = useState('Pass');
  const [compRemarks, setCompRemarks] = useState('');
  const [compErr, setCompErr] = useState('');

  const handleComplete = async () => {
    if (!selected) return;
    setCompErr('');
    try {
      await completeHt(selected.htrNumber, Number(selected.version) || 1, {
        actualHardness: actualHrc,
        disposition: disp,
        remarks: compRemarks
      });
      await refresh();
    } catch (e) {
      setCompErr(e.message || 'Could not save hardness result.');
    }
  };

  const handleCancel = async () => {
    if (!selected) return;
    const reason = window.prompt(`Cancel ${selected.htrNumber}? Enter reason:`);
    if (reason === null || !reason.trim()) return;
    try {
      await cancelHt(selected.htrNumber, Number(selected.version) || 1, reason.trim());
      await refresh();
    } catch (e) {
      setError(e.message || 'Could not cancel this HTR.');
    }
  };

  const openWithPurchaseForm = (r) => {
    openDetail(r);
    setVenName(r.vendorName || '');
    setVenAddr(r.vendorAddress || '');
    setVenPhone(r.vendorPhone || '');
    setVenEmail(r.vendorEmail || '');
    setPoRef(r.poRef || '');
    setRateInfo(r.rateInfo || '');
    setVenErr('');
  };

  const openWithRecv = (r) => {
    openDetail(r);
    setRecvQty(String(atVendor(r) || r.issuedQty || ''));
    setInwardChallan('');
    setRecvErr('');
  };

  const openWithComplete = (r) => {
    openDetail(r);
    setActualHrc(r.actualHardness || '');
    setDisp(r.disposition || 'Pass');
    setCompRemarks(r.remarks || '');
    setCompErr('');
  };

  const statuses = [
    'All',
    HT_OUTSOURCE_STATUS.RAISED,
    HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED,
    HT_OUTSOURCE_STATUS.ISSUED,
    HT_OUTSOURCE_STATUS.RECEIVED,
    HT_OUTSOURCE_STATUS.COMPLETED,
    HT_OUTSOURCE_STATUS.CANCELLED
  ];

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Heat Treatment Outsource Requests (HTR)</h1>
        </div>

      </div>

      {loading && <div className="form-error" style={{ marginBottom: '12px' }}>Loading HT outsource requests from PostgreSQL…</div>}
      {error && <div className="form-error" style={{ marginBottom: '12px' }}>{error}</div>}

      {mode === 'create' ? (
        <div className="form-section" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div>
              <div className="eyebrow">Linked to Job Card (dropdown — no typing)</div>
              <h2 style={{ margin: 0 }}>Raise HT Outsource Request</h2>
            </div>
            <button type="button" className="action-select" style={{ width: 'auto' }} onClick={() => { setMode('list'); setFormErr(''); }}>
              ← Cancel
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Job Card * (select only)</span>
              <select
                style={inputStyle}
                value={form.jobCardNumber}
                onChange={(e) => {
                  const jc = jobCards.find((j) => j.jobCardNumber === e.target.value);
                  prefillFromJobCard(jc);
                }}
              >
                <option value="">— Select Job Card —</option>
                {jobCards.map((jc) => {
                  const ht = jc.operations?.heatTreatment || {};
                  const open = activeHTRByJc[jc.jobCardNumber];
                  const label = ht.required
                    ? `${jc.jobCardNumber} · ${jc.partName || '—'} · HT ${ht.processType || 'yes'}${open ? ` · ${open.htrNumber} open` : ''}`
                    : `${jc.jobCardNumber} · ${jc.partName || '—'} · HT not required`;
                  return (
                    <option key={jc.jobCardNumber} value={jc.jobCardNumber} disabled={Boolean(open) || !ht.required}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Process Type *</span>
              <select style={inputStyle} value={form.processType} onChange={(e) => setForm((p) => ({ ...p, processType: e.target.value }))}>
                <option value="">—</option>
                {['Hardening', 'Tempering', 'Annealing', 'Case Hardening', 'Induction Hardening', 'Stress Relieving', 'Normalizing', 'Other'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Target Hardness *</span>
              <input type="text" style={inputStyle} value={form.targetHardness} onChange={(e) => setForm((p) => ({ ...p, targetHardness: e.target.value }))} placeholder="e.g. 52-55 HRC" />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Qty to Send *</span>
              <input type="number" min="1" style={inputStyle} value={form.qtyRequested} onChange={(e) => setForm((p) => ({ ...p, qtyRequested: e.target.value }))} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Need By</span>
              <input type="date" style={inputStyle} value={form.needByDate} onChange={(e) => setForm((p) => ({ ...p, needByDate: e.target.value }))} />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Vendor (optional — Purchase can assign)</span>
              <VendorMasterAutocomplete value={form.vendorName} onChange={(v) => setForm((p) => ({ ...p, vendorName: v }))} placeholder="Search Vendor Master..." style={acInputStyle} />
            </label>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Spec / Recipe</span>
              <input type="text" style={inputStyle} value={form.processSpec} onChange={(e) => setForm((p) => ({ ...p, processSpec: e.target.value }))} />
            </label>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span style={labelStyle}>Remarks</span>
              <textarea rows="2" style={inputStyle} value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} />
            </label>
          </div>

          {form.jobCardNumber && (
            <div style={{ marginTop: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', fontSize: '13px' }}>
              <strong>Linked Job Card:</strong> {form.jobCardNumber}
              {(() => {
                const jc = jobCards.find((j) => j.jobCardNumber === form.jobCardNumber);
                if (!jc) return null;
                return (
                  <span>
                    {' · '}Part: {jc.partName || '—'} · Drawing: {jc.drawingNumber || '—'} · Customer: {jc.customerName || '—'}
                    <button type="button" className="button-secondary" style={{ marginLeft: '10px', fontSize: '11px', padding: '3px 8px' }} onClick={() => openJobCard(form.jobCardNumber)}>
                      Open Job Card
                    </button>
                  </span>
                );
              })()}
            </div>
          )}

          {formErr && <div style={{ color: '#b91c1c', fontSize: '13px', marginTop: '10px' }}>{formErr}</div>}

          <div style={{ marginTop: '14px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" className="button-primary" onClick={handleCreateHTR}>
              Create HTR → send to Store
            </button>
          </div>
        </div>
      ) : selected ? (
        <div className="form-section" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div>
              <h2 style={{ margin: 0 }}>{selected.htrNumber}</h2>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusChip status={selected.status} />
              <button
                type="button"
                className="button-secondary"
                onClick={() => openJobCard(selected.jobCardNumber)}
                title="Open linked Job Card"
              >
                Open Job Card {selected.jobCardNumber}
              </button>
              <button type="button" className="action-select" style={{ width: 'auto' }} onClick={() => setViewNumber(null)}>
                ← Back to list
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '18px' }}>
            <div style={fieldStyle}>
              <span style={labelStyle}>Job Card (linked)</span>
              <button type="button" className="button-secondary" style={{ width: 'fit-content', fontSize: '13px' }} onClick={() => openJobCard(selected.jobCardNumber)}>
                {selected.jobCardNumber} →
              </button>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Part / Drawing</span>
              <span>{selected.partName || '—'} {selected.drawingNumber ? `· ${selected.drawingNumber}` : ''}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Process</span>
              <span>{selected.processType || '—'} {selected.processSpec ? `· ${selected.processSpec}` : ''}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Target Hardness</span>
              <strong>{selected.targetHardness || '—'}</strong>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Qty Requested</span>
              <span>{selected.qtyRequested} Nos</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Need By</span>
              <span>{selected.needByDate || '—'}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Raised By</span>
              <span>{selected.raisedBy} · {selected.requestDate}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Stock at Vendor</span>
              <strong style={{ color: atVendor(selected) > 0 ? '#c2410c' : '#166534' }}>{atVendor(selected)} Nos</strong>
            </div>
          </div>

          {/* Vendor contact card — Store reads this, not memory */}
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
            <strong style={{ color: '#1e293b' }}>Vendor (assigned by Purchase from Vendor Master)</strong>
            {selected.vendorName ? (
              <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', fontSize: '13px' }}>
                <div><strong>Name:</strong> {selected.vendorName}</div>
                <div><strong>Phone:</strong> {selected.vendorPhone || '—'}</div>
                <div><strong>Email:</strong> {selected.vendorEmail || '—'}</div>
                <div style={{ gridColumn: '1 / -1' }}><strong>Address:</strong> {selected.vendorAddress || '—'}</div>
                <div><strong>PO Ref:</strong> {selected.poRef || '—'}</div>
                <div><strong>Rate / Bill:</strong> {selected.rateInfo || '—'} {selected.billRef ? ` · Bill: ${selected.billRef}` : ''}</div>
              </div>
            ) : (
              <p style={{ margin: '8px 0 0', color: '#92400e', fontSize: '13px' }}>
                Vendor not assigned yet. Purchase must assign vendor before Store can issue material.
              </p>
            )}
          </div>

          {/* Store movements */}
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '14px', marginBottom: '14px' }}>
            <strong style={{ color: '#1e3a8a' }}>Store — Material Movement</strong>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: '10px', fontSize: '13px' }}>
              <div><strong>Issued:</strong> {selected.issuedQty || 0} Nos {selected.issuedDate ? `on ${selected.issuedDate}` : ''}</div>
              <div><strong>Out Challan:</strong> {selected.outwardChallan || '—'} {selected.vehicleNo ? `· ${selected.vehicleNo}` : ''}</div>
              <div><strong>Received back:</strong> {selected.receivedQty || 0} Nos {selected.receivedDate ? `on ${selected.receivedDate}` : ''}</div>
              <div><strong>In Challan:</strong> {selected.inwardChallan || '—'}</div>
              <div><strong>Issued By:</strong> {selected.issuedBy || '—'}</div>
              <div><strong>Received By:</strong> {selected.receivedBy || '—'}</div>
            </div>

            {canStore && selected.status === HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED && (
              <div style={{ marginTop: '12px', borderTop: '1px dashed #93c5fd', paddingTop: '12px' }}>
                <div style={{ fontWeight: 700, marginBottom: '8px', color: '#1e40af' }}>Issue to vendor (Stock OUT)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Qty Out</span>
                    <input type="number" min="1" style={inputStyle} value={issueQty} onChange={(e) => setIssueQty(e.target.value)} />
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Outward Challan No</span>
                    <input type="text" style={inputStyle} value={outwardChallan} onChange={(e) => setOutwardChallan(e.target.value)} placeholder="GC-001" />
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Vehicle No</span>
                    <input type="text" style={inputStyle} value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} />
                  </label>
                </div>
                {issueErr && <div style={{ color: '#b91c1c', fontSize: '12px', marginTop: '8px' }}>{issueErr}</div>}
                <button type="button" className="action-select" style={{ width: 'auto', marginTop: '10px', background: '#2563eb', color: '#fff', border: 'none', fontWeight: 700 }} onClick={handleIssue}>
                  Confirm Stock OUT to Vendor
                </button>
              </div>
            )}

            {canStore && selected.status === HT_OUTSOURCE_STATUS.ISSUED && (
              <div style={{ marginTop: '12px', borderTop: '1px dashed #93c5fd', paddingTop: '12px' }}>
                <div style={{ fontWeight: 700, marginBottom: '8px', color: '#1e40af' }}>Receive back from vendor (Stock IN)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Qty In</span>
                    <input type="number" min="1" style={inputStyle} value={recvQty} onChange={(e) => setRecvQty(e.target.value)} />
                  </label>
                  <label style={fieldStyle}>
                    <span style={labelStyle}>Inward Challan No</span>
                    <input type="text" style={inputStyle} value={inwardChallan} onChange={(e) => setInwardChallan(e.target.value)} placeholder="Vendor challan" />
                  </label>
                </div>
                {recvErr && <div style={{ color: '#b91c1c', fontSize: '12px', marginTop: '8px' }}>{recvErr}</div>}
                <button type="button" className="action-select" style={{ width: 'auto', marginTop: '10px', background: '#16a34a', color: '#fff', border: 'none', fontWeight: 700 }} onClick={handleReceive}>
                  Confirm Stock IN at Store
                </button>
              </div>
            )}
          </div>

          {/* Purchase assign */}
          {canPurchase && (selected.status === HT_OUTSOURCE_STATUS.RAISED || selected.status === HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED) && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '14px', marginBottom: '14px' }}>
              <strong style={{ color: '#92400e' }}>Purchase — Assign Vendor (from Vendor Master)</strong>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginTop: '10px' }}>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>Vendor Name *</span>
                  <VendorMasterAutocomplete
                    value={venName}
                    onChange={setVenName}
                    onSelect={(v) => {
                      setVenName(v.name || '');
                      setVenAddr(v.address || '');
                      setVenPhone(v.phone || '');
                      setVenEmail(v.email || '');
                    }}
                    placeholder="Search heat-treat vendor from master..."
                    style={acInputStyle}
                  />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Phone (from master)</span>
                  <input type="text" style={inputStyle} value={venPhone} onChange={(e) => setVenPhone(e.target.value)} />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Email</span>
                  <input type="text" style={inputStyle} value={venEmail} onChange={(e) => setVenEmail(e.target.value)} />
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>Address</span>
                  <input type="text" style={inputStyle} value={venAddr} onChange={(e) => setVenAddr(e.target.value)} />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Job-Work PO Ref</span>
                  <input type="text" style={inputStyle} value={poRef} onChange={(e) => setPoRef(e.target.value)} placeholder="PO-xxx (optional)" />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Rate / Estimate</span>
                  <input type="text" style={inputStyle} value={rateInfo} onChange={(e) => setRateInfo(e.target.value)} placeholder="e.g. ₹250/kg or ₹80/pc" />
                </label>
              </div>
              {venErr && <div style={{ color: '#b91c1c', fontSize: '12px', marginTop: '8px' }}>{venErr}</div>}
              <button type="button" className="action-select" style={{ width: 'auto', marginTop: '10px', background: '#d97706', color: '#fff', border: 'none', fontWeight: 700 }} onClick={handleAssignVendor}>
                Assign Vendor → notify Store
              </button>
            </div>
          )}

          {/* Purchase bill note */}
          {canPurchase && selected.poRef !== undefined && (
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', marginBottom: '14px', fontSize: '13px', color: '#475569' }}>
              <strong>Purchase note:</strong> When the heat-treat vendor bills this job work, enter bill no. on Supplier Invoice and mention HTR number in remarks
              (link: {selected.htrNumber}{selected.poRef ? ` · PO ${selected.poRef}` : ''}).
            </div>
          )}

          {/* Production hardness result */}
          {canComplete && selected.status === HT_OUTSOURCE_STATUS.RECEIVED && (
            <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', padding: '14px', marginBottom: '14px' }}>
              <strong style={{ color: '#065f46' }}>Production / QC — Target vs Actual Hardness</strong>
              <div style={{ marginTop: '6px', fontSize: '13px', color: '#047857' }}>
                Target: <strong>{selected.targetHardness || '—'}</strong>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: '10px' }}>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Actual Hardness *</span>
                  <input type="text" style={inputStyle} value={actualHrc} onChange={(e) => setActualHrc(e.target.value)} placeholder="e.g. 53.5 HRC" />
                </label>
                <label style={fieldStyle}>
                  <span style={labelStyle}>Pass / Fail *</span>
                  <select style={inputStyle} value={disp} onChange={(e) => setDisp(e.target.value)}>
                    <option value="Pass">🟢 PASS</option>
                    <option value="Fail">🔴 FAIL (Re-HT / Scrap)</option>
                  </select>
                </label>
                <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
                  <span style={labelStyle}>Remarks</span>
                  <textarea rows="2" style={inputStyle} value={compRemarks} onChange={(e) => setCompRemarks(e.target.value)} />
                </label>
              </div>
              {compErr && <div style={{ color: '#b91c1c', fontSize: '12px', marginTop: '8px' }}>{compErr}</div>}
              <button type="button" className="action-select" style={{ width: 'auto', marginTop: '10px', background: '#059669', color: '#fff', border: 'none', fontWeight: 700 }} onClick={handleComplete}>
                Save Hardness Result
              </button>
            </div>
          )}

          {selected.disposition && selected.disposition !== 'Pending' && (
            <div style={{ background: selected.disposition === 'Pass' ? '#f0fdf4' : '#fef2f2', border: '1px solid ' + (selected.disposition === 'Pass' ? '#bbf7d0' : '#fecaca'), borderRadius: '8px', padding: '12px 14px', marginBottom: '14px', fontSize: '13px' }}>
              <strong>Hardness result:</strong> {selected.disposition} · Actual: {selected.actualHardness || '—'} · By {selected.completedBy || '—'} on {selected.completedDate || '—'}
              {selected.remarks ? ` · ${selected.remarks}` : ''}
            </div>
          )}

          {canCancel && [HT_OUTSOURCE_STATUS.RAISED, HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED, HT_OUTSOURCE_STATUS.RECEIVED, HT_OUTSOURCE_STATUS.COMPLETED].includes(selected.status) && (
            <div>
              <button type="button" className="action-select" style={{ width: 'auto', color: '#b91c1c' }} onClick={handleCancel}>
                Cancel {selected.htrNumber}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="filters-grid">
            <select className="action-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              className="search-input"
              type="search"
              placeholder="Search HTR / Job Card / Part / Vendor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>HTR No</th>
                  <th>Date</th>
                  <th>Job Card</th>
                  <th>Part</th>
                  <th>Process / Target</th>
                  <th>Qty</th>
                  <th>At Vendor</th>
                  <th>Vendor</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan="10" style={{ textAlign: 'center', color: '#94a3b8', padding: '28px' }}>
                      No HT outsource requests yet. Raise one from Job Card → Heat Treatment → “Raise Outsource Request”.
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => (
                    <tr key={r.htrNumber}>
                      <td><strong>{r.htrNumber}</strong></td>
                      <td>{r.requestDate}</td>
                      <td>
                        <button type="button" className="button-secondary" style={{ fontSize: '12px', padding: '3px 8px' }} onClick={() => openJobCard(r.jobCardNumber)} title="Open linked Job Card">
                          {r.jobCardNumber} ↗
                        </button>
                      </td>
                      <td>{r.partName || '—'}</td>
                      <td style={{ fontSize: '12px' }}>
                        {r.processType || '—'}
                        {r.targetHardness ? <div style={{ color: '#92400e', fontWeight: 700 }}>Target {r.targetHardness}</div> : null}
                      </td>
                      <td>{r.qtyRequested}</td>
                      <td style={{ color: atVendor(r) > 0 ? '#c2410c' : '#166534', fontWeight: 700 }}>{atVendor(r)}</td>
                      <td style={{ fontSize: '12px' }}>{r.vendorName || <span style={{ color: '#92400e' }}>Pending</span>}</td>
                      <td><StatusChip status={r.status} /></td>
                      <td>
                        <button type="button" className="action-select" style={{ width: 'auto' }} onClick={() => openDetail(r)}>
                          View
                        </button>{' '}
                        {canStore && r.status === HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED && (
                          <button type="button" className="action-select" style={{ width: 'auto', background: '#2563eb', color: '#fff', border: 'none' }} onClick={() => openDetail(r)}>
                            Issue
                          </button>
                        )}
                        {canStore && r.status === HT_OUTSOURCE_STATUS.ISSUED && (
                          <button type="button" className="action-select" style={{ width: 'auto', background: '#16a34a', color: '#fff', border: 'none' }} onClick={() => openWithRecv(r)}>
                            Receive
                          </button>
                        )}
                        {canPurchase && (r.status === HT_OUTSOURCE_STATUS.RAISED || r.status === HT_OUTSOURCE_STATUS.VENDOR_ASSIGNED) && (
                          <button type="button" className="action-select" style={{ width: 'auto', background: '#d97706', color: '#fff', border: 'none' }} onClick={() => openWithPurchaseForm(r)}>
                            Vendor
                          </button>
                        )}
                        {canComplete && r.status === HT_OUTSOURCE_STATUS.RECEIVED && (
                          <button type="button" className="action-select" style={{ width: 'auto', background: '#059669', color: '#fff', border: 'none' }} onClick={() => openWithComplete(r)}>
                            Hardness
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '14px', fontSize: '12px', color: '#64748b', display: 'grid', gap: '4px' }}>
            <div><strong>Flow:</strong> Production raises HTR → Purchase assigns Vendor (Master contact auto-filled) → Store Stock OUT → vendor HT → Store Stock IN → Production enters Actual HRC.</div>
            <div>Vendor phone/address live on the HTR document — Store does not need to remember contacts.</div>
          </div>
        </>
      )}
    </section>
  );
};

export default HTOutsourcePage;
