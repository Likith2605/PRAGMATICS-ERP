import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../utils/permissions.js';
import {
  STATUS,
  SOURCE_TYPE,
  SOURCE_TYPE_LABEL,
  decorateMR,
  getInventoryItems,
  getInventoryBatches,
  getMaterialRequests,
  getMaterialShortages,
  issueMaterial,
  markPendingStore,
  rejectMaterialRequest,
  closeMaterialRequest,
  createPurchaseRequestForShortage,
  approvePurchaseRequest,
  rejectPurchaseRequest,
  updateMaterialRequest,
  deleteMaterialRequest,
  isMRStatusEditable,
  resolveSourceType,
  getExpiryWatchList,
  todayStr,
  nowTimeStr
} from '../utils/storeService.js';
import {
  ACK_STATUS,
  ACK_FILTERS,
  ackStatusForLines,
  computeAckLines,
  getAcknowledgement,
  getAckQueue,
  matchesAckFilter,
  submitAcknowledgement,
  linkPurchaseIndent,
  findIndentForMR,
  getLinkableIndents,
  lineStatusFor
} from '../utils/materialAckService.js';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import StoreAuditLogView from '../components/StoreAuditLogView.jsx';
import EmployeeSearchSelect from '../components/EmployeeSearchSelect.jsx';

const StatusChip = ({ status }) => {
  const cls = (status || '').toLowerCase().replace(/\s+/g, '-');
  return <span className={`status-badge st-${cls}`}>{status}</span>;
};

/* Acknowledgement chips reuse the .status-badge base — colour variants for the
   ack statuses live in quotation.css (st-fully-available, st-partially-…). */
const AckChip = ({ status }) => <StatusChip status={status} />;

const QUEUE_STATUSES = [STATUS.APPROVED, STATUS.PENDING, STATUS.PARTIAL, STATUS.FULL];

const StoreMaterialRequestsPage = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('queue');
  const [mode, setMode] = useState('list');
  const [viewNumber, setViewNumber] = useState(null);
  const [statusFilter, setStatusFilter] = useState(STATUS.APPROVED);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [deptFilter, setDeptFilter] = useState('All');
  const [jcFilter, setJcFilter] = useState('');
  const [empFilter, setEmpFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const canIssue = hasPermission('material_issue.confirm');
  const canCreatePR = hasPermission('purchase_request.create');
  const canApprovePR = hasPermission('purchase_request.approve');
  const canEditMR = hasPermission('material_request.edit') || hasPermission('material_request.create');
  /* Acknowledgement gates — same permission Stores already uses to confirm an
     issue, so no new role or capability is invented. */
  const canAcknowledge = canIssue;
  const canIndent = hasPermission('indent.create');

  /* ------------------ Store → Production acknowledgement state ------------------ */
  const [ackFilter, setAckFilter] = useState('Pending Acknowledgement');
  const [ackSearch, setAckSearch] = useState('');
  const [ackMrNumber, setAckMrNumber] = useState(null);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState('');
  const [ackFlash, setAckFlash] = useState('');

  const refresh = () => {
    setRefreshTick((t) => t + 1);
    if (mode !== 'list') setMode('list');
    setViewNumber(null);
    setEditMr(null);
    setFormError('');
  };

  /* Re-render only — keeps the acknowledgement screen open while it reloads. */
  const bumpRefresh = () => {
    setRefreshTick((t) => t + 1);
    setAckError('');
  };

  const allMrs = getMaterialRequests();
  const decorated = useMemo(() => {
    const dec = allMrs.map((m) => decorateMR(m));
    dec.sort((a, b) => (b.requestDate.localeCompare(a.requestDate)));
    return dec;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMrs, refreshTick]);

  const active = decorated.filter((m) => QUEUE_STATUSES.includes(m.status));

  const filtered = active.filter((mr) => {
    if (statusFilter !== 'All' && mr.status !== statusFilter) return false;
    if (dateFrom && mr.requestDate < dateFrom) return false;
    if (dateTo && mr.requestDate > dateTo) return false;
    if (deptFilter !== 'All' && mr.productionDepartment !== deptFilter) return false;
    if (jcFilter && mr.jobCardNumber !== jcFilter) return false;
    if (projectFilter !== 'All' && (mr.projectId || '') !== projectFilter) return false;
    if (empFilter && !(mr.requestedBy || '').toLowerCase().includes(empFilter.toLowerCase())) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return [mr.mrNumber, mr.jobCardNumber, mr.projectId, mr.partName, mr.customer, mr.requestedBy].join(' ').toLowerCase().includes(q);
  });

  const selected = viewNumber ? decorated.find((m) => m.mrNumber === viewNumber) : null;

  const departments = useMemo(() => {
    const set = new Set(active.map((m) => m.productionDepartment).filter(Boolean));
    return ['All', ...Array.from(set)];
  }, [active]);

  const projectFilterOptions = useMemo(() => {
    const set = new Set(active.map((m) => m.projectId || '').filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [active]);

  /* Rebuilt whenever anything writes to the ERP state (refreshTick). */
  const ackQueueRows = useMemo(() => getAckQueue(), [refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingAckCount = ackQueueRows.filter((r) => r.ack.status === ACK_STATUS.PENDING).length;

  const openDetail = (mr) => {
    if (mr.status === STATUS.SUBMITTED) {
      markPendingStore(mr.mrNumber);
      setRefreshTick((t) => t + 1);
    }
    setViewNumber(mr.mrNumber);
    setMode('detail');
  };

  /* ------------------- edit / delete request state ------------------- */
  const [editMr, setEditMr] = useState(null);
  const [form, setForm] = useState(null);
  const [lines, setLines] = useState([]);
  const [formError, setFormError] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const setFormField = (field, val) => setForm((prev) => ({ ...prev, [field]: val }));

  const startEdit = (mr) => {
    const raw = getMaterialRequests().find((m) => m.mrNumber === mr.mrNumber) || mr;
    setForm({
      jobCardNumber: raw.jobCardNumber || '',
      salesOrderRef: raw.salesOrderRef || '',
      customer: raw.customer || '',
      partName: raw.partName || '',
      drawingNumber: raw.drawingNumber || '',
      projectId: raw.projectId || '',
      projectName: raw.projectName || '',
      priority: raw.priority || 'Normal',
      requiredDate: raw.requiredDate || '',
      requestedBy: raw.requestedBy || '',
      requestedByEmpId: raw.requestedByEmpId || '',
      remarks: raw.remarks || ''
    });
    setLines((raw.items || []).map((it) => ({
      materialId: it.materialId || '',
      materialName: it.materialName || '',
      materialDesc: it.materialDesc || '',
      grade: it.grade || '',
      spec: it.spec || '',
      sizeDimensions: it.sizeDimensions || '',
      unit: it.unit || '',
      requiredQty: String(it.requiredQty != null ? it.requiredQty : ''),
      termsRequiredQty: Number(it.termsRequiredQty) || 0,
      termsRequirementItemId: it.termsRequirementItemId || '',
      itemId: it.itemId || '',
      sourceType: resolveSourceType(it),
      reason: it.reason || '',
      addedBy: it.addedBy || '',
      addedDate: it.addedDate || '',
      purpose: it.purpose || '',
      batchNo: it.batchNo || '',
      heatNumber: it.heatNumber || '',
      serialNumber: it.serialNumber || ''
    })));
    setFormError('');
    setFlash('');
    setEditMr(raw);
    setMode('edit');
  };

  const setLineQty = (idx, val) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, requiredQty: val } : l)));
  };

  const setLineField = (idx, field, val) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: val } : l)));
  };

  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const addLine = () => {
    setLines((prev) => [...prev, {
      materialId: '',
      materialName: '',
      materialDesc: '',
      grade: '',
      spec: '',
      sizeDimensions: '',
      unit: '',
      requiredQty: '',
      termsRequiredQty: 0,
      termsRequirementItemId: '',
      itemId: '',
      sourceType: SOURCE_TYPE.ADDITIONAL,
      reason: '',
      addedBy: '',
      addedDate: '',
      purpose: '',
      batchNo: '',
      heatNumber: '',
      serialNumber: ''
    }]);
  };

  const pickMaterial = (idx, itemCode) => {
    const inv = getInventoryItems().find((i) => i.itemCode === itemCode);
    setLines((prev) => prev.map((l, i) => (i === idx ? {
      ...l,
      materialId: itemCode,
      materialName: inv?.itemName || itemCode,
      materialDesc: inv?.itemDesc || inv?.description || '',
      grade: inv?.grade || l.grade || '',
      spec: inv?.spec || l.spec || '',
      sizeDimensions: inv?.sizeDimensions || l.sizeDimensions || '',
      unit: inv?.unit || l.unit || 'Nos',
      itemId: inv?.id || l.itemId || ''
    } : l)));
  };

  const handleSave = () => {
    if (!editMr) return;
    setFormError('');
    if (!String(form.partName || '').trim()) return setFormError('Part Name is required.');
    if (lines.length === 0) return setFormError('At least one material line is required.');
    try {
      setEditBusy(true);
      updateMaterialRequest(editMr.mrNumber, { ...form, items: lines });
      setEditBusy(false);
      setFlash(`Material Request ${editMr.mrNumber} updated.`);
      setEditMr(null);
      setForm(null);
      setLines([]);
      setMode('list');
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setEditBusy(false);
      setFormError(err.message);
    }
  };

  const handleDeleteMR = (mr) => {
    if (!window.confirm(`Delete ${mr.mrNumber}? This cannot be undone.`)) return;
    try {
      deleteMaterialRequest(mr.mrNumber);
      setFlash(`Material Request ${mr.mrNumber} deleted.`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      window.alert(err.message);
    }
  };

  /* ------------------- issue form state ------------------- */
  const [issueQty, setIssueQty] = useState({});
  const [batchInfo, setBatchInfo] = useState({});
  const [receiver, setReceiver] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [issueError, setIssueError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'detail' || !selected) return;
    const shortages = getMaterialShortages(selected);
    const prefill = {};
    shortages.forEach((s) => {
      prefill[s.materialId] = s.balance > 0 ? Math.min(s.balance, s.available) : 0;
    });
    setIssueQty(prefill);
    setBatchInfo({});
    setReceiver(null);
    setAcknowledged(false);
    setRemarks('');
    setIssueError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewNumber, mode]);

  const setQty = (materialId, val) => {
    const n = Number(val);
    setIssueQty((prev) => ({ ...prev, [materialId]: Number.isNaN(n) || n < 0 ? 0 : n }));
  };

  const setBatchField = (materialId, field, val) => {
    setBatchInfo((prev) => ({ ...prev, [materialId]: { ...(prev[materialId] || {}), [field]: val } }));
  };

  /* FEFO hint: for shelf-life-managed materials show the nearest-expiry open
     batch (the one that MUST go out first) right under the batch input. */
  const fefoByItem = useMemo(() => {
    const map = {};
    try {
      // getExpiryWatchList is already FEFO-sorted (soonest expiry first).
      getExpiryWatchList().forEach((b) => {
        if (!b.expiryDate) return;
        const key = String(b.itemCode || '').toLowerCase();
        if (key && !map[key]) map[key] = b;
      });
    } catch {
      /* shelf-life data unavailable — no hints */
    }
    return map;
  }, []);

  const handleIssue = () => {
    if (!selected) return;
    setIssueError('');
    if (!receiver) return setIssueError('Select the employee who is receiving the material (from Employee Master).');
    if (!acknowledged) return setIssueError('The receiver must tick the acknowledgement checkbox before material is issued.');
    try {
      setBusy(true);
      const si = issueMaterial({
        mrNumber: selected.mrNumber,
        issueQtyById: issueQty,
        receiver: { ...receiver, acknowledged },
        remarks,
        batchInfo
      });
      setBusy(false);
      navigate('/store/issues', { state: { viewIssue: si.issueNumber, justIssued: true } });
    } catch (err) {
      setBusy(false);
      setIssueError(err.message);
    }
  };

  const handleCreatePR = () => {
    if (!selected) return;
    const shortages = getMaterialShortages(selected).filter((s) => s.shortage > 0);
    if (shortages.length === 0) return alert('No shortage found for this request.');
    if (!window.confirm(`Create Purchase Request for ${shortages.length} short material(s) against ${selected.mrNumber}?`)) return;
    try {
      setBusy(true);
      const pr = createPurchaseRequestForShortage({ mrNumber: selected.mrNumber, items: shortages });
      setBusy(false);
      alert(`Purchase Request ${pr.prNumber} created.`);
      refresh();
    } catch (err) {
      setBusy(false);
      setIssueError(err.message);
    }
  };

  const handleReject = () => {
    if (!selected) return;
    const reason = window.prompt(`Reject ${selected.mrNumber}? Enter the rejection reason:`);
    if (reason === null) return;
    try {
      rejectMaterialRequest(selected.mrNumber, reason);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleClose = () => {
    if (!selected) return;
    if (!window.confirm(`Close ${selected.mrNumber} now that all material is issued?`)) return;
    try {
      closeMaterialRequest(selected.mrNumber);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleApprovePR = (prNumber) => {
    const remarks = window.prompt(`Approve ${prNumber}? Enter remarks (optional):`);
    if (remarks === null) return;
    try {
      approvePurchaseRequest(prNumber, remarks);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRejectPR = (prNumber) => {
    const reason = window.prompt(`Reject ${prNumber}? Enter a reason (required):`);
    if (reason === null) return;
    if (!reason || !reason.trim()) { alert('Rejection reason is required.'); return; }
    try {
      rejectPurchaseRequest(prNumber, reason);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  /* ------------------- Store → Production acknowledgement ------------------- */
  const openAck = (mrNumber) => {
    setAckMrNumber(mrNumber);
    setAckError('');
    setAckFlash('');
  };

  const handleSubmitAck = ({ lines, remarks }) => {
    if (!ackMrNumber) return;
    try {
      setAckBusy(true);
      const res = submitAcknowledgement({ mrNumber: ackMrNumber, lines, remarks });
      setAckBusy(false);
      setAckFlash(
        res.changed
          ? `Acknowledgement for ${ackMrNumber} submitted — Production has been notified.`
          : `No change — ${ackMrNumber} was already acknowledged with these figures.`
      );
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setAckBusy(false);
      setAckError(err.message);
    }
  };

  const handleLinkIndent = ({ indentNumber = '' }) => {
    if (!ackMrNumber) return;
    try {
      setAckBusy(true);
      const res = linkPurchaseIndent({ mrNumber: ackMrNumber, indentNumber });
      setAckBusy(false);
      setAckFlash(
        res.created
          ? `Purchase Indent ${res.indent.indentNumber} created for the shortage and linked to ${ackMrNumber}.`
          : res.changed
            ? `Purchase Indent ${res.indent.indentNumber} linked to ${ackMrNumber}.`
            : `Purchase Indent ${res.indent.indentNumber} is already linked to ${ackMrNumber} — no duplicate created.`
      );
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setAckBusy(false);
      setAckError(err.message);
    }
  };

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Store / Warehouse</div>
          <h1 className="page-title">Material Requests</h1>
          <p className="page-description">
            Store queue of material requests raised by Production. Verify stock, issue to a verified employee and
            generate an auto Store Issue (SI) number. Shortages can be raised as Purchase Requests.
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      <div className="tab-nav">
        <button type="button" className={`tab-link ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>Request Queue</button>
        <button
          type="button"
          className={`tab-link ${tab === 'ack' ? 'active' : ''}`}
          onClick={() => { setTab('ack'); setAckMrNumber(null); setAckError(''); setAckFlash(''); }}
        >
          Pending Material Acknowledgements
          {pendingAckCount > 0 && (
            <span className="count-badge" style={{ marginLeft: '6px', padding: '2px 7px', fontSize: '11px' }}>{pendingAckCount}</span>
          )}
        </button>
        {canApprovePR && <button type="button" className={`tab-link ${tab === 'purchase-requests' ? 'active' : ''}`} onClick={() => setTab('purchase-requests')}>Purchase Requests</button>}
        <button type="button" className={`tab-link ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Trail</button>
      </div>

      {tab === 'audit' ? (
        <StoreAuditLogView />
      ) : tab === 'ack' ? (
        ackMrNumber ? (
          <AckScreen
            mrNumber={ackMrNumber}
            refreshTick={refreshTick}
            canAcknowledge={canAcknowledge}
            canIndent={canIndent}
            busy={ackBusy}
            error={ackError}
            flash={ackFlash}
            onSubmit={handleSubmitAck}
            onLinkIndent={handleLinkIndent}
            onRefresh={bumpRefresh}
            onBack={() => { setAckMrNumber(null); setAckError(''); setAckFlash(''); }}
          />
        ) : (
          <AckQueueView
            rows={ackQueueRows}
            filter={ackFilter}
            setFilter={setAckFilter}
            search={ackSearch}
            setSearch={setAckSearch}
            canAcknowledge={canAcknowledge}
            onOpen={openAck}
          />
        )
      ) : tab === 'purchase-requests' ? (
        <PurchaseRequestsView canApprovePR={canApprovePR} onApprovePR={handleApprovePR} onRejectPR={handleRejectPR} refreshTick={refreshTick} />
      ) : mode === 'edit' && editMr && form ? (
        <EditView
          mr={editMr}
          form={form}
          setFormField={setFormField}
          lines={lines}
          setLineQty={setLineQty}
          setLineField={setLineField}
          removeLine={removeLine}
          addLine={addLine}
          pickMaterial={pickMaterial}
          error={formError}
          busy={editBusy}
          onSave={handleSave}
          onCancel={() => { setEditMr(null); setForm(null); setLines([]); setFormError(''); setMode('list'); }}
        />
      ) : mode === 'detail' && selected ? (
        <DetailView
          mr={selected}
          inventory={getInventoryItems()}
          issueQty={issueQty}
          setQty={setQty}
          batchInfo={batchInfo}
          setBatchField={setBatchField}
          receiver={receiver}
          setReceiver={setReceiver}
          acknowledged={acknowledged}
          setAcknowledged={setAcknowledged}
          remarks={remarks}
          setRemarks={setRemarks}
          issueError={issueError}
          busy={busy}
          canIssue={canIssue}
          canCreatePR={canCreatePR}
          onIssue={handleIssue}
          onCreatePR={handleCreatePR}
          onReject={handleReject}
          onClose={handleClose}
          onBack={() => { setMode('list'); setViewNumber(null); }}
        />
      ) : (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Request Queue</h3>
            <span className="muted-text">Draft requests are not visible to the Store department.</span>
          </div>

          {flash && (
            <div style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '6px', background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#047857', fontSize: '13px', display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
              <span>{flash}</span>
              <button type="button" className="button-secondary button-small" onClick={() => setFlash('')}>Dismiss</button>
            </div>
          )}

          <div className="filters-grid">
            <select className="action-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="All">All Statuses</option>
              {QUEUE_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input type="date" className="action-select form-input" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From" />
            <input type="date" className="action-select form-input" value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="To" />
            <select className="action-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
              {departments.map((d) => (
                <option key={d} value={d}>{d === 'All' ? 'All Departments' : d}</option>
              ))}
            </select>
            <select className="action-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              {projectFilterOptions.map((p) => (
                <option key={p} value={p}>{p === 'All' ? 'All Projects' : `Project: ${p}`}</option>
              ))}
            </select>
            <input type="text" className="action-select form-input" value={jcFilter} onChange={(e) => setJcFilter(e.target.value)} placeholder="Job Card No" />
            <input type="text" className="action-select form-input" value={empFilter} onChange={(e) => setEmpFilter(e.target.value)} placeholder="Requested by" />
            <input type="text" className="action-select form-input search-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search MR / part / customer" />
          </div>

          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>MR No</th>
                  <th>Project ID</th>
                  <th>Job Card</th>
                  <th>Sales Order</th>
                  <th>Part Name</th>
                  <th>Department</th>
                  <th>Requested By</th>
                  <th>Required Date</th>
                  <th>Priority</th>
                  <th>Lines</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan="12" className="no-history-row">No material requests in the queue.</td>
                  </tr>
                ) : (
                  filtered.map((mr) => (
                    <tr key={mr.mrNumber}>
                      <td><strong>{mr.mrNumber}</strong></td>
                      <td>
                        {mr.projectId ? (
                          <span style={{ color: '#3730a3', fontWeight: '700', fontSize: '12px' }}>{mr.projectId}</span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td>{mr.jobCardNumber || '—'}</td>
                      <td>{mr.salesOrderRef || '—'}</td>
                      <td>{mr.partName || '—'}</td>
                      <td>{mr.productionDepartment || '—'}</td>
                      <td>{mr.requestedBy}</td>
                      <td>{mr.requiredDate || '—'}</td>
                      <td><span className={`priority-badge ${(mr.priority || '').toLowerCase()}`}>{mr.priority || 'Normal'}</span></td>
                      <td>{mr.items.length}</td>
                      <td><StatusChip status={mr.status} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                          <button type="button" className="button-primary button-small" onClick={() => openDetail(mr)}>View</button>
                          {canEditMR && isMRStatusEditable(mr.status) && (
                            <>
                              <button type="button" className="button-secondary button-small" onClick={() => startEdit(mr)}>Edit</button>
                              <button type="button" className="button-secondary button-small" style={{ color: '#dc2626', borderColor: '#fca5a5' }} onClick={() => handleDeleteMR(mr)}>Delete</button>
                            </>
                          )}
                        </div>
                      </td>
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

const EditView = ({
  mr,
  form,
  setFormField,
  lines,
  setLineQty,
  setLineField,
  removeLine,
  addLine,
  pickMaterial,
  error,
  busy,
  onSave,
  onCancel
}) => {
  const inventory = getInventoryItems();

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">Edit Material Request {mr.mrNumber}</h3>
        <StatusChip status={mr.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        <label>
          <div className="field-label">Part Name</div>
          <input type="text" className="form-input" value={form.partName} onChange={(e) => setFormField('partName', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Customer</div>
          <input type="text" className="form-input" value={form.customer} onChange={(e) => setFormField('customer', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Drawing No</div>
          <input type="text" className="form-input" value={form.drawingNumber} onChange={(e) => setFormField('drawingNumber', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Project ID</div>
          <input type="text" className="form-input" value={form.projectId} onChange={(e) => setFormField('projectId', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Project Name</div>
          <input type="text" className="form-input" value={form.projectName} onChange={(e) => setFormField('projectName', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Job Card No</div>
          <input type="text" className="form-input" value={form.jobCardNumber} onChange={(e) => setFormField('jobCardNumber', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Sales Order Ref</div>
          <input type="text" className="form-input" value={form.salesOrderRef} onChange={(e) => setFormField('salesOrderRef', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Required Date</div>
          <input type="date" className="form-input" value={form.requiredDate} onChange={(e) => setFormField('requiredDate', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Priority</div>
          <select className="form-input" value={form.priority} onChange={(e) => setFormField('priority', e.target.value)}>
            <option>Normal</option>
            <option>High</option>
            <option>Urgent</option>
          </select>
        </label>
        <label>
          <div className="field-label">Requested By</div>
          <input type="text" className="form-input" value={form.requestedBy} onChange={(e) => setFormField('requestedBy', e.target.value)} />
        </label>
        <label>
          <div className="field-label">Remarks</div>
          <input type="text" className="form-input" value={form.remarks} onChange={(e) => setFormField('remarks', e.target.value)} />
        </label>
      </div>

      <div className="block-header">
        <h3 className="block-title">Material Lines</h3>
        <button type="button" className="button-secondary button-small" onClick={addLine}>+ Add Material</button>
      </div>

      <table className="history-table">
        <thead>
          <tr>
            <th>SL.No</th>
            <th>Material</th>
            <th>Unit</th>
            <th>Required Qty</th>
            <th>Source</th>
            <th>Reason (Additional)</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr><td colSpan="7" className="no-history-row">No material lines.</td></tr>
          ) : lines.map((l, idx) => (
            <tr key={`${l.materialId || 'new'}-${idx}`}>
              <td>{idx + 1}</td>
              <td>
                <select className="form-input" value={l.materialId} onChange={(e) => pickMaterial(idx, e.target.value)}>
                  <option value="">— select material —</option>
                  {inventory.map((i) => (
                    <option key={i.itemCode} value={i.itemCode}>{i.itemCode} - {i.itemName}</option>
                  ))}
                </select>
              </td>
              <td>{l.unit || '—'}</td>
              <td>
                <input type="number" min="0" className="form-input" style={{ width: '110px' }} value={l.requiredQty} onChange={(e) => setLineQty(idx, e.target.value)} />
              </td>
              <td>{SOURCE_TYPE_LABEL[l.sourceType] || l.sourceType}</td>
              <td>
                {l.sourceType === SOURCE_TYPE.ADDITIONAL ? (
                  <input type="text" className="form-input" placeholder="Why is this needed?" value={l.reason} onChange={(e) => setLineField(idx, 'reason', e.target.value)} />
                ) : '—'}
              </td>
              <td>
                <button type="button" className="button-secondary button-small" style={{ color: '#dc2626', borderColor: '#fca5a5' }} onClick={() => removeLine(idx)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div style={{ marginTop: '12px', padding: '8px 12px', borderRadius: '6px', background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '13px' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
        <button type="button" className="button-primary" disabled={busy} onClick={onSave}>Save Changes</button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onCancel}>&larr; Back to Queue</button>
      </div>
    </div>
  );
};

const DetailView = ({
  mr,
  issueQty,
  setQty,
  batchInfo,
  setBatchField,
  receiver,
  setReceiver,
  acknowledged,
  setAcknowledged,
  remarks,
  setRemarks,
  issueError,
  busy,
  canIssue,
  canCreatePR,
  onIssue,
  onCreatePR,
  onReject,
  onClose,
  onBack
}) => {
  const shortages = getMaterialShortages(mr);
  const totalShortages = shortages.filter((s) => s.shortage > 0);
  const anyIssuable = shortages.some((s) => s.canIssuePartially);
  const completed = mr.status === STATUS.FULL;

  return (
    <div>
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Process {mr.mrNumber}</h3>
          <StatusChip status={mr.status} />
        </div>

        <div className="detail-grid">
          <div><strong>Job Card:</strong> {mr.jobCardNumber || '—'}</div>
          <div><strong>Project ID:</strong> <span style={{ color: '#3730a3', fontWeight: '700' }}>{mr.projectId || '—'}</span></div>
          <div><strong>Project Name:</strong> {mr.projectName || '—'}</div>
          <div><strong>Sales Order:</strong> {mr.salesOrderRef || '—'}</div>
          <div><strong>Customer:</strong> {mr.customer || '—'}</div>
          <div><strong>Part Name:</strong> {mr.partName || '—'}</div>
          <div><strong>Drawing No:</strong> {mr.drawingNumber || '—'}</div>
          <div><strong>Request Date:</strong> {mr.requestDate}</div>
          <div><strong>Required Date:</strong> {mr.requiredDate || '—'}</div>
          <div><strong>Priority:</strong> {mr.priority || 'Normal'}</div>
          <div><strong>Requested By:</strong> {mr.requestedBy} ({mr.requestedByEmpId || '—'})</div>
          <div><strong>Remarks:</strong> {mr.remarks || '—'}</div>
        </div>

        <div className="block-header">
          <h3 className="block-title">Stock Check &amp; Issue</h3>
          <span className="muted-text">Issue quantity cannot exceed available stock or the balance still due.</span>
        </div>

        {totalShortages.length > 0 && (
          <div className="shortage-banner">
            <strong>Shortage detected:</strong>{' '}
            {totalShortages.map((s) => `${s.materialName} (need ${s.shortage} ${s.unit})`).join(', ')}{' '}
            — Raise a Purchase Request to procure.
          </div>
        )}

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material</th>
                <th>Source</th>
                <th>Spec / Size</th>
                <th>Required</th>
                <th>Available</th>
                <th>Already Issued</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Issue Qty</th>
                <th>Batch No</th>
                <th>Lot No</th>
                <th>Heat No</th>
                <th>Serial No</th>
              </tr>
            </thead>
            <tbody>
              {shortages.map((s, idx) => {
                const mrItem = mr.items.find((it) => it.materialId === s.materialId) || {};
                const srcType = mrItem.sourceType || (mrItem.termsRequirementItemId ? SOURCE_TYPE.TERMS_REQUIREMENT : SOURCE_TYPE.ADDITIONAL);
                return (
                <tr key={s.materialId}>
                  <td>{idx + 1}</td>
                  <td>{s.materialName}</td>
                  <td>
                    <span className={`source-badge ${srcType === SOURCE_TYPE.TERMS_REQUIREMENT ? 'source-terms' : 'source-additional'}`}>
                      {SOURCE_TYPE_LABEL[srcType]}
                    </span>
                  </td>
                  <td>{mrItem.spec || mrItem.grade || '—'}</td>
                  <td>{s.required} {s.unit}</td>
                  <td>
                    {s.available} {s.unit}
                    {s.shortage > 0 && <div className="badge-short">SHORTAGE</div>}
                  </td>
                  <td>{s.issued} {s.unit}</td>
                  <td>{s.balance} {s.unit}</td>
                  <td><StatusChip status={mrItem.lineStatus || 'Pending'} /></td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      disabled={!canIssue || completed}
                      className="issue-qty-input"
                      value={issueQty[s.materialId] ?? ''}
                      onChange={(e) => setQty(s.materialId, e.target.value)}
                      placeholder="0"
                    />
                    {Number(issueQty[s.materialId] || 0) > Math.min(s.available, s.balance) && (
                      <div className="line-error">Exceeds limit (max {Math.min(s.available, s.balance)})</div>
                    )}
                  </td>
                  <td>
                    <select className="issue-qty-input" disabled={!canIssue} value={batchInfo[s.materialId]?.receiptBatchId || ''} onChange={(e) => {
                      const batch = getInventoryBatches().find((candidate) => candidate.id === e.target.value);
                      setBatchField(s.materialId, 'receiptBatchId', e.target.value);
                      setBatchField(s.materialId, 'batchNo', batch?.supplierBatchNumber || batch?.batchNumber || '');
                      setBatchField(s.materialId, 'lotNumber', batch?.lotNumber || '');
                    }}>
                      <option value="">Select receipt batch</option>
                      {getInventoryBatches().filter((batch) => String(batch.itemCode || '').toLowerCase() === String(s.materialId || '').toLowerCase() && Number(batch.availableQty) > 0)
                        .map((batch) => <option key={batch.id} value={batch.id}>{batch.supplierBatchNumber || batch.batchNumber || 'No supplier batch'} / {batch.internalBatchId || batch.id} — {batch.availableQty} available</option>)}
                    </select>
                    <div className="muted-text">Supplier batch: {batchInfo[s.materialId]?.batchNo || 'Not recorded'}</div>
                    {(() => {
                      const fefo = fefoByItem[String(s.materialId || '').toLowerCase()];
                      if (!fefo) return null;
                      const expired = fefo.status === 'EXPIRED';
                      const near = fefo.status === 'NEAR';
                      const color = expired ? '#b91c1c' : near ? '#b45309' : '#15803d';
                      return (
                        <div style={{ fontSize: '10px', fontWeight: 700, color, marginTop: '3px', whiteSpace: 'nowrap' }}>
                          FEFO: {fefo.batchNumber} · exp {fefo.expiryDate} ({fefo.daysLeft ?? '?'}d)
                          {!expired && !near && (
                            <button
                              type="button"
                              disabled={!canIssue}
                              onClick={() => setBatchField(s.materialId, 'batchNo', fefo.batchNumber)}
                              style={{
                                marginLeft: '5px',
                                border: '1px solid #cbd5e1',
                                background: '#f8fafc',
                                borderRadius: '5px',
                                fontSize: '9.5px',
                                fontWeight: 700,
                                color: '#334155',
                                padding: '1px 6px',
                                cursor: canIssue ? 'pointer' : 'not-allowed'
                              }}
                              title="Fill the batch that expires first (FEFO)"
                            >
                              Use
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    <input
                      type="text"
                      className="issue-qty-input"
                      disabled={!canIssue}
                      value={batchInfo[s.materialId]?.lotNumber || ''}
                      onChange={(e) => setBatchField(s.materialId, 'lotNumber', e.target.value)}
                      placeholder="Lot No"
                      title="Lot number for this issue — taken from the batch register when left blank"
                    />
                  </td>
                  <td><input type="text" className="issue-qty-input" disabled={!canIssue} value={batchInfo[s.materialId]?.heatNumber || ''} onChange={(e) => setBatchField(s.materialId, 'heatNumber', e.target.value)} /></td>
                  <td><input type="text" className="issue-qty-input" disabled={!canIssue} value={batchInfo[s.materialId]?.serialNumber || ''} onChange={(e) => setBatchField(s.materialId, 'serialNumber', e.target.value)} /></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="block-header">
          <h3 className="block-title">Material Received By</h3>
          <span className="muted-text">Receiver must be a verified employee from the Employee Master. Free-text not allowed.</span>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <label>Receiver (Employee) *</label>
            <EmployeeSearchSelect value={receiver} onChange={setReceiver} />
          </div>
          <div className="form-field">
            <label>Received Date</label>
            <input type="date" className="action-select form-input" value={todayStr()} readOnly />
          </div>
          <div className="form-field">
            <label>Received Time</label>
            <input type="text" className="action-select form-input" value={nowTimeStr()} readOnly />
          </div>
        </div>

        <label className="acknowledgement-box">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={!canIssue || completed}
          />
          <span>
            I confirm that I have received the above material
            {receiver ? ` — ${receiver.name} (${receiver.employeeId})` : ''}. This is a mandatory acknowledgement.
          </span>
        </label>

        <div className="form-field">
          <label>Remarks / Notes</label>
          <textarea className="action-select form-input" rows="2" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Any notes for this issue..." />
        </div>

        {issueError && <div className="form-error">{issueError}</div>}

        <div className="template-modal-actions start-actions">
          {canIssue && !completed && (
            <button type="button" className="button-primary" disabled={busy || !anyIssuable} onClick={onIssue}>
              {busy ? 'Processing...' : `Issue Material ${receiver ? `to ${receiver.name}` : ''}`}
            </button>
          )}
          {canCreatePR && totalShortages.length > 0 && (
            <button type="button" className="button-secondary" disabled={busy} onClick={onCreatePR}>
              Create Purchase Request for Shortage
            </button>
          )}
          {canIssue && ['Submitted', 'Pending Store', 'Partially Issued'].includes(mr.status) && (
            <button type="button" className="button-secondary" disabled={busy} onClick={onReject}>Reject Request</button>
          )}
          {mr.status === STATUS.FULL && (
            <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>Close Request</button>
          )}
        </div>

        <div className="template-modal-actions">
          <button type="button" className="button-secondary" onClick={onBack}>&larr; Back to Queue</button>
        </div>
      </div>
    </div>
  );
};

const PurchaseRequestsView = ({ canApprovePR, onApprovePR, onRejectPR, refreshTick }) => {
  const [prs, setPrs] = useState([]);
  const [filter, setFilter] = useState('All');
  const [viewPR, setViewPR] = useState(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('storePurchaseRequests');
      setPrs(raw ? JSON.parse(raw) : []);
    } catch { setPrs([]); }
  }, [refreshTick]);

  const filtered = filter === 'All' ? prs : prs.filter((p) => p.status === filter);

  if (viewPR) {
    const pr = prs.find((p) => p.prNumber === viewPR) || {};
    return (
      <div className="content-block" style={{ marginTop: '16px' }}>
        <div className="block-header">
          <div>
            <h3 className="block-title">Purchase Request: {pr.prNumber}</h3>
            <div className="muted-text" style={{ fontSize: '13px' }}>
              Created on {pr.prDate || '-'} &bull; Status: {pr.status || '-'}
            </div>
          </div>
          <button type="button" className="button-secondary button-small" onClick={() => setViewPR(null)}>← Back to List</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px' }}>
          <div>
            <div className="field-label">PR Number</div>
            <div style={{ fontWeight: 600 }}>{pr.prNumber}</div>
          </div>
          <div>
            <div className="field-label">Date</div>
            <div>{pr.prDate || '-'}</div>
          </div>
          <div>
            <div className="field-label">MR Reference</div>
            <div>{pr.mrNumber || '-'}</div>
          </div>
          <div>
            <div className="field-label">Project ID</div>
            <div>{pr.projectId || '-'}</div>
          </div>
          <div>
            <div className="field-label">Project Name</div>
            <div>{pr.projectName || '-'}</div>
          </div>
          <div>
            <div className="field-label">Job Card</div>
            <div>{pr.jobCardNumber || '-'}</div>
          </div>
          <div>
            <div className="field-label">Part Name</div>
            <div>{pr.partName || '-'}</div>
          </div>
          <div>
            <div className="field-label">Priority</div>
            <div>{pr.priority || 'Normal'}</div>
          </div>
          <div>
            <div className="field-label">Requested By</div>
            <div>{pr.requestedBy || '-'}</div>
          </div>
          <div>
            <div className="field-label">Department</div>
            <div>{pr.department || '-'}</div>
          </div>
          <div>
            <div className="field-label">Status</div>
            <div><StatusChip status={pr.status} /></div>
          </div>
          {pr.remarks && (
            <div>
              <div className="field-label">Remarks</div>
              <div>{pr.remarks}</div>
            </div>
          )}
        </div>

        <h4 style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Materials Requested</h4>
        <table className="history-table">
          <thead>
            <tr>
              <th>SL.No</th>
              <th>Material</th>
              <th>Unit</th>
              <th>Required</th>
              <th>Available</th>
              <th>Already Issued</th>
              <th>Balance</th>
              <th>Shortage</th>
            </tr>
          </thead>
          <tbody>
            {(pr.items || []).map((item, idx) => (
              <tr key={idx}>
                <td>{idx + 1}</td>
                <td><strong>{item.materialName || item.materialId || '-'}</strong></td>
                <td>{item.unit || '-'}</td>
                <td>{item.requiredQty || 0}</td>
                <td>{item.availableQty || 0}</td>
                <td>{item.issuedQty || 0}</td>
                <td>{item.balanceQty || 0}</td>
                <td style={{ color: Number(item.shortageQty) > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{item.shortageQty || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="content-block" style={{ marginTop: '16px' }}>
      <div className="block-header">
        <h3 className="block-title">Purchase Requests</h3>
        <span className="muted-text">{prs.length} total</span>
      </div>
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
        <select className="action-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="All">All Statuses</option>
          <option value="Pending Approval">Pending Approval</option>
          <option value="Approved">Approved</option>
          <option value="Rejected">Rejected</option>
          <option value="Converted to PO">Converted to PO</option>
        </select>
      </div>
      {filtered.length === 0 ? (
        <p style={{ color: '#6b7280', padding: '20px' }}>No purchase requests found.</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>PR No</th>
              <th>Date</th>
              <th>MR Ref</th>
              <th>Project</th>
              <th>Short Items</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((pr) => (
              <tr key={pr.prNumber}>
                <td><strong>{pr.prNumber}</strong></td>
                <td>{pr.prDate}</td>
                <td>{pr.mrNumber}</td>
                <td>{pr.projectId || '-'}</td>
                <td>{pr.items?.length || 0} material(s)</td>
                <td>{pr.priority || 'Normal'}</td>
                <td><StatusChip status={pr.status} /></td>
                <td>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <button type="button" className="button-secondary button-small" onClick={() => setViewPR(pr.prNumber)}>View</button>
                    {pr.status === 'Pending Approval' && canApprovePR && (
                      <>
                        <button type="button" className="button-primary button-small" onClick={() => onApprovePR(pr.prNumber)} style={{ background: '#16a34a' }}>Approve</button>
                        <button type="button" className="button-secondary button-small" onClick={() => onRejectPR(pr.prNumber)} style={{ color: '#dc2626' }}>Reject</button>
                      </>
                    )}
                    {pr.status === 'Approved' && <span style={{ color: '#16a34a', fontWeight: 600, fontSize: '12px' }}>✓ Ready for PO</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/* ==========================================================================
   Store → Production material acknowledgement
   ========================================================================== */

const AckQueueView = ({ rows, filter, setFilter, search, setSearch, canAcknowledge, onOpen }) => {
  const visible = rows.filter((row) => {
    if (!matchesAckFilter(row, filter)) return false;
    const q = String(search || '').toLowerCase().trim();
    if (!q) return true;
    return [row.mr.mrNumber, row.mr.salesOrderRef, row.mr.projectId, row.mr.projectName, row.mr.partName, row.mr.requestedBy, row.indentNumber]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  const pending = rows.filter((r) => r.ack.status === ACK_STATUS.PENDING).length;

  return (
    <div className="content-block">
      <div className="block-header">
        <div>
          <h3 className="block-title">Pending Material Acknowledgements</h3>
          <div className="muted-text" style={{ fontSize: '13px' }}>
            {rows.length} open request(s) &bull; {pending} awaiting a Store response
          </div>
        </div>
        <span className="muted-text">Acknowledge availability before Production releases a Job Card.</span>
      </div>

      <div className="filters-grid">
        <select className="action-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="All">All Acknowledgements</option>
          {ACK_FILTERS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <input
          type="text"
          className="action-select form-input search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search MR / SO / project / part"
        />
      </div>

      <div className="history-table-wrapper">
        <table className="history-table">
          <thead>
            <tr>
              <th>MR No</th>
              <th>Sales Order</th>
              <th>Project</th>
              <th>Requested By</th>
              <th>Request Date</th>
              <th>Items</th>
              <th>Shortage</th>
              <th>Purchase Indent</th>
              <th>Acknowledgement Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan="10" className="no-history-row">No material requests match this filter.</td>
              </tr>
            ) : (
              visible.map((row) => {
                const shortage = row.lines.reduce((a, l) => a + (Number(l.shortageQty) || 0), 0);
                return (
                  <tr key={row.mr.mrNumber}>
                    <td><strong>{row.mr.mrNumber}</strong></td>
                    <td>{row.mr.salesOrderRef || '—'}</td>
                    <td>
                      {row.mr.projectId ? (
                        <div style={{ fontSize: '12px' }}>
                          <span style={{ color: '#3730a3', fontWeight: 700 }}>{row.mr.projectId}</span>
                          {row.mr.projectName && <div className="muted-text">{row.mr.projectName}</div>}
                        </div>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>
                    <td>{row.mr.requestedBy || '—'}</td>
                    <td>{row.mr.requestDate || '—'}</td>
                    <td>{row.mr.items?.length || 0}</td>
                    <td style={{ color: shortage > 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
                      {shortage > 0 ? `${shortage} short` : 'None'}
                    </td>
                    <td>
                      {row.indentNumber ? (
                        <div style={{ fontSize: '12px' }}>
                          <span style={{ fontWeight: 700 }}>{row.indentNumber}</span>
                          {row.phase && <div className="muted-text">{row.phase}</div>}
                        </div>
                      ) : (
                        <span className="muted-text">—</span>
                      )}
                    </td>
                    <td><AckChip status={row.ack.status} /></td>
                    <td>
                      <button
                        type="button"
                        className={canAcknowledge ? 'button-primary button-small' : 'button-secondary button-small'}
                        onClick={() => onOpen(row.mr.mrNumber)}
                      >
                        {canAcknowledge ? 'View / Acknowledge' : 'View'}
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
  );
};

const AckScreen = ({
  mrNumber,
  refreshTick,
  canAcknowledge,
  canIndent,
  busy,
  error,
  flash,
  onSubmit,
  onLinkIndent,
  onRefresh,
  onBack
}) => {
  const mr = useMemo(
    () => getMaterialRequests().find((m) => m.mrNumber === mrNumber) || null,
    [mrNumber, refreshTick] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const liveLines = useMemo(() => (mr ? computeAckLines(mr) : []), [mr, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkable = useMemo(() => getLinkableIndents(mrNumber), [mrNumber, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const ack = mr ? getAcknowledgement(mr) : null;
  const indent = mr ? findIndentForMR(mrNumber) : null;
  const indentNumber = (ack && ack.purchaseIndentNumber) || (indent && indent.indentNumber) || '';

  const [draft, setDraft] = useState({});
  const [remarks, setRemarks] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkChoice, setLinkChoice] = useState('');
  const navigate = useNavigate();

  /* Re-seed the working copy whenever the request or the ERP state changes
     (explicit stock refresh, or a submit that stored new figures). */
  useEffect(() => {
    const stored = ack || { lines: {}, remarks: '' };
    const next = {};
    liveLines.forEach((l) => {
      const prev = (stored.lines || {})[l.materialId];
      const seeded =
        prev && prev.verifiedQty !== undefined && prev.verifiedQty !== null && prev.verifiedQty !== ''
          ? String(prev.verifiedQty)
          : String(l.availableQty);
      next[l.materialId] = { verifiedQty: seeded, remarks: (prev && prev.remarks) || '' };
    });
    setDraft(next);
    setRemarks(stored.remarks || '');
    setLinkOpen(false);
    setLinkChoice('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrNumber, refreshTick]);

  const setVerified = (materialId, val) =>
    setDraft((prev) => ({ ...prev, [materialId]: { ...(prev[materialId] || {}), verifiedQty: val } }));

  const setLineRemarks = (materialId, val) =>
    setDraft((prev) => ({ ...prev, [materialId]: { ...(prev[materialId] || {}), remarks: val } }));

  if (!mr) {
    return (
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Material Request {mrNumber}</h3>
        </div>
        <div className="empty-state">
          <p>This Material Request is no longer available.</p>
          <button type="button" className="button-secondary" onClick={onBack}>&larr; Back to Acknowledgements</button>
        </div>
      </div>
    );
  }

  /* Per line: verified qty is capped at min(required, real unreserved stock) so
     a typed figure can never claim inventory that does not exist. */
  const rows = liveLines.map((l) => {
    const d = draft[l.materialId] || {};
    const cap = Math.min(l.requiredQty, l.effectiveAvailable);
    const raw = d.verifiedQty;
    const blank = raw === '' || raw === undefined || raw === null || Number.isNaN(Number(raw));
    const typed = blank ? cap : Number(raw);
    const clamped = Math.min(cap, Math.max(0, typed));
    return {
      ...l,
      cap,
      overCap: !blank && typed > cap,
      verifiedQty: clamped,
      lineRemarks: d.remarks || '',
      shortageQty: Math.max(0, l.requiredQty - clamped),
      status: lineStatusFor(l.requiredQty, clamped)
    };
  });

  const totalRequired = rows.reduce((a, r) => a + r.requiredQty, 0);
  const totalAvailable = rows.reduce((a, r) => a + r.verifiedQty, 0);
  const totalShortage = rows.reduce((a, r) => a + r.shortageQty, 0);
  const nextStatus = rows.length > 0 ? ackStatusForLines(rows) : ACK_STATUS.PENDING;
  const overCapRows = rows.filter((r) => r.overCap);

  const handleSubmit = () => {
    onSubmit({
      lines: rows.map((r) => ({
        materialId: r.materialId,
        verifiedQty: r.verifiedQty,
        remarks: r.lineRemarks
      })),
      remarks
    });
  };

  return (
    <div>
      <div className="content-block">
        <div className="block-header">
          <div>
            <h3 className="block-title">Acknowledge {mr.mrNumber}</h3>
            <div className="muted-text" style={{ fontSize: '13px' }}>
              {mr.partName || '—'} &bull; {mr.customer || '—'} &bull; raised by {mr.requestedBy || '—'} on {mr.requestDate || '—'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusChip status={mr.status} />
            <AckChip status={ack.status} />
          </div>
        </div>

        {flash && (
          <div style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '6px', background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#047857', fontSize: '13px' }}>
            {flash}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px', marginBottom: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px', fontSize: '13px' }}>
          <div><div className="field-label">Sales Order</div><div style={{ fontWeight: 600 }}>{mr.salesOrderRef || '—'}</div></div>
          <div><div className="field-label">Project</div><div style={{ fontWeight: 600, color: '#3730a3' }}>{mr.projectId || '—'}{mr.projectName ? ` · ${mr.projectName}` : ''}</div></div>
          <div><div className="field-label">Job Card</div><div style={{ fontWeight: 600 }}>{mr.jobCardNumber || '—'}</div></div>
          <div><div className="field-label">Required Date</div><div style={{ fontWeight: 600 }}>{mr.requiredDate || '—'}</div></div>
          <div><div className="field-label">Priority</div><div><span className={`priority-badge ${(mr.priority || '').toLowerCase()}`}>{mr.priority || 'Normal'}</span></div></div>
          <div>
            <div className="field-label">Purchase Indent</div>
            <div style={{ fontWeight: 600 }}>
              {indentNumber ? (
                <button
                  type="button"
                  className="link-button"
                  style={{ border: 'none', background: 'none', padding: 0, color: '#2563eb', fontWeight: 700, cursor: 'pointer', fontSize: '13px' }}
                  onClick={() => navigate(`/purchase-indents?indent=${encodeURIComponent(indentNumber)}`)}
                >
                  {indentNumber} ↗
                </button>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>

        {ack.acknowledgedAt && (
          <div className="muted-text" style={{ fontSize: '12.5px', marginBottom: '12px' }}>
            Last acknowledged by <strong>{ack.acknowledgedBy}</strong> on {ack.acknowledgedAt}
            {ack.remarks ? ` — ${ack.remarks}` : ''}
          </div>
        )}

        {totalShortage > 0 ? (
          <div style={{ marginBottom: '12px', padding: '9px 12px', borderRadius: '6px', background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: '13px' }}>
            <strong>Shortage: {totalShortage} unit(s)</strong> across {rows.filter((r) => r.shortageQty > 0).length} material(s).
            Raise or link a Purchase Indent so procurement can close the gap. Production is shown these figures as-is —
            partial availability is never reported as full.
          </div>
        ) : (
          <div style={{ marginBottom: '12px', padding: '9px 12px', borderRadius: '6px', background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#047857', fontSize: '13px' }}>
            <strong>Fully Available</strong> — every requested material is covered by unreserved, QC-approved stock.
          </div>
        )}

        <div className="block-header">
          <h3 className="block-title">Material-wise Availability</h3>
          <span className="muted-text">Available = on-hand − reserved − already committed to other projects</span>
        </div>

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Material</th>
                <th>Unit</th>
                <th>Required Qty</th>
                <th>Available Qty</th>
                <th>Verified Qty</th>
                <th>Shortage Qty</th>
                <th>Store Status</th>
                <th>Line Remarks</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan="8" className="no-history-row">This request has no material lines.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.materialId}>
                    <td>
                      <strong>{r.materialName}</strong>
                      <div className="muted-text" style={{ fontSize: '11.5px' }}>{r.materialId}</div>
                    </td>
                    <td>{r.unit}</td>
                    <td style={{ fontWeight: 700 }}>{r.requiredQty}</td>
                    <td>
                      <div style={{ fontWeight: 700, color: r.availableQty > 0 ? '#166534' : '#94a3b8' }}>{r.availableQty}</div>
                      <div className="muted-text" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                        {r.currentQty} on hand &middot; {r.reservedQty} reserved &middot; {r.blockedQty} committed
                      </div>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max={r.cap}
                        step="any"
                        className="issue-qty-input"
                        style={{ width: '84px', borderColor: r.overCap ? '#fca5a5' : undefined }}
                        disabled={!canAcknowledge}
                        value={draft[r.materialId]?.verifiedQty ?? ''}
                        onChange={(e) => setVerified(r.materialId, e.target.value)}
                        title={`Cannot exceed ${r.cap} — the real unreserved stock for this material`}
                      />
                      {r.overCap && (
                        <div style={{ color: '#dc2626', fontSize: '10.5px', fontWeight: 700 }}>capped at {r.cap}</div>
                      )}
                    </td>
                    <td style={{ fontWeight: 700, color: r.shortageQty > 0 ? '#dc2626' : '#166534' }}>{r.shortageQty}</td>
                    <td><AckChip status={r.status} /></td>
                    <td>
                      <input
                        type="text"
                        className="issue-qty-input"
                        style={{ width: '150px' }}
                        disabled={!canAcknowledge}
                        placeholder="optional"
                        value={r.lineRemarks}
                        onChange={(e) => setLineRemarks(r.materialId, e.target.value)}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ background: '#f8fafc', fontWeight: 700 }}>
                  <td colSpan="2">Totals</td>
                  <td>{totalRequired}</td>
                  <td>{rows.reduce((a, r) => a + r.availableQty, 0)}</td>
                  <td>{totalAvailable}</td>
                  <td style={{ color: totalShortage > 0 ? '#dc2626' : '#166534' }}>{totalShortage}</td>
                  <td colSpan="2"><AckChip status={nextStatus} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {overCapRows.length > 0 && (
          <div style={{ marginTop: '10px', padding: '8px 12px', borderRadius: '6px', background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '12.5px' }}>
            {overCapRows.length} entr{overCapRows.length === 1 ? 'y exceeds' : 'ies exceed'} the real available stock and will be
            clamped on submit. Stores can never acknowledge more than unreserved, QC-approved inventory.
          </div>
        )}

        <div className="form-field" style={{ marginTop: '16px' }}>
          <label>Overall Remarks (sent to Production)</label>
          <textarea
            className="action-select form-input"
            rows="2"
            disabled={!canAcknowledge}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="e.g. Steel and bolts on hand, paint to be procured against PI-0007."
          />
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="template-modal-actions start-actions">
          <button type="button" className="button-secondary" disabled={busy} onClick={onRefresh}>
            Refresh Stock
          </button>
          {canAcknowledge && (
            <button type="button" className="button-primary" disabled={busy || rows.length === 0} onClick={handleSubmit}>
              {busy ? 'Submitting...' : `Submit Acknowledgement (${nextStatus})`}
            </button>
          )}
          {canIndent && totalShortage > 0 && !indentNumber && (
            <button type="button" className="button-secondary" disabled={busy} onClick={() => onLinkIndent({})}>
              Create Purchase Indent for Shortage
            </button>
          )}
          {canIndent && !indentNumber && linkable.length > 0 && (
            <button type="button" className="button-secondary" disabled={busy} onClick={() => setLinkOpen((v) => !v)}>
              Link Existing Purchase Indent
            </button>
          )}
        </div>

        {linkOpen && !indentNumber && (
          <div className="filters-grid" style={{ marginTop: '10px' }}>
            <select className="action-select" value={linkChoice} onChange={(e) => setLinkChoice(e.target.value)}>
              <option value="">-- Select Purchase Indent --</option>
              {linkable.map((i) => (
                <option key={i.indentNumber} value={i.indentNumber}>
                  {i.indentNumber} · {i.status} · {(i.items || []).length} line(s)
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button-primary button-small"
              disabled={busy || !linkChoice}
              onClick={() => onLinkIndent({ indentNumber: linkChoice })}
            >
              Link Indent
            </button>
          </div>
        )}

        <div className="template-modal-actions">
          <button type="button" className="button-secondary" onClick={onBack}>&larr; Back to Acknowledgements</button>
        </div>
      </div>

      {ack.history?.length > 0 && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Acknowledgement History</h3>
            <span className="muted-text">{ack.history.length} entry/entries</span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Acknowledged By</th>
                  <th>Acknowledged At</th>
                  <th>Previous Status</th>
                  <th>New Status</th>
                  <th>Available Qty</th>
                  <th>Shortage Qty</th>
                  <th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {[...ack.history].reverse().map((h, i) => (
                  <tr key={`${h.at}-${i}`}>
                    <td>{h.by}{h.byEmpId && h.byEmpId !== '-' ? ` (${h.byEmpId})` : ''}</td>
                    <td>{h.at}</td>
                    <td><AckChip status={h.previousStatus} /></td>
                    <td><AckChip status={h.newStatus} /></td>
                    <td style={{ fontWeight: 700 }}>{h.availableQty}</td>
                    <td style={{ fontWeight: 700, color: Number(h.shortageQty) > 0 ? '#dc2626' : '#166534' }}>{h.shortageQty}</td>
                    <td>{h.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default StoreMaterialRequestsPage;
