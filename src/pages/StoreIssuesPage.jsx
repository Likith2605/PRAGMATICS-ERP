import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  STATUS,
  getStoreIssues,
  getMaterialRequests,
  getMaterialShortages,
  getInventoryBatches,
  decorateMR,
  issueMaterial,
  todayStr,
  nowTimeStr
} from '../utils/storeService.js';
import { getSalesOrders } from '../utils/workflowService.js';
import { getAcknowledgement } from '../utils/materialAckService.js';
import { hasPermission } from '../utils/permissions.js';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import StoreAuditLogView from '../components/StoreAuditLogView.jsx';
import EmployeeSearchSelect from '../components/EmployeeSearchSelect.jsx';

/* Material Request states a store person may issue against. Draft has not
   reached the Store yet; Fully Issued / Closed / Rejected / Cancelled have
   nothing left to hand out. */
const ISSUABLE_STATUSES = new Set([
  STATUS.SUBMITTED,
  STATUS.APPROVED,
  STATUS.PENDING,
  STATUS.PARTIAL
]);

const StatusChip = ({ status }) => {
  const cls = (status || '').toLowerCase().replace(/\s+/g, '-');
  return <span className={`status-badge st-${cls}`}>{status}</span>;
};

/* Store acknowledgement chip — colours live in quotation.css. */
const AckChip = ({ status }) => <StatusChip status={status} />;

/* Best-effort Customer PO for the issue form: an explicit poNumber wins, then
   a "PO: xxx" Sales Order reference, then the linked Sales Order record.
   The field stays editable so the store person can always correct it. */
const derivePoNumber = (mr) => {
  if (mr.poNumber) return String(mr.poNumber);
  const ref = String(mr.salesOrderRef || '').trim();
  if (/^PO:/i.test(ref)) return ref.replace(/^PO:\s*/i, '').trim();
  if (!ref) return '';
  const so = getSalesOrders().find((s) => String(s.reference || '') === ref);
  return so?.payload?.soDetails?.customerPoNumber || '';
};

const StoreIssuesPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState('register');
  const [viewIssueNumber, setViewIssueNumber] = useState(location.state?.viewIssue || null);
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('All');
  const [refreshTick, setRefreshTick] = useState(0);

  /* -------- incoming Material Requests awaiting store issue -------- */
  const [pendingSearch, setPendingSearch] = useState('');
  const [issuingMrNumber, setIssuingMrNumber] = useState(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState('');
  const [issueFlash, setIssueFlash] = useState('');

  const canIssue = hasPermission('material_issue.confirm');
  const issues = getStoreIssues();

  useEffect(() => {
    if (location.state?.viewIssue) setViewIssueNumber(location.state.viewIssue);
  }, [location.state]);

  useEffect(() => {
    if (viewIssueNumber) setTab('register');
  }, [viewIssueNumber]);

  const projectFilterOptions = useMemo(() => {
    const set = new Set(issues.map((i) => i.projectId || '').filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [issues]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return issues
      .filter((i) => {
        if (projectFilter !== 'All' && (i.projectId || '') !== projectFilter) return false;
        return !q
          ? true
          : [i.issueNumber, i.mrNumber, i.jobCardNumber, i.projectId, i.partName, i.customer, i.receivedBy, i.issuedBy]
              .join(' ')
              .toLowerCase()
              .includes(q);
      })
      .sort((a, b) => b.issueNumber.localeCompare(a.issueNumber));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, search, projectFilter, refreshTick]);

  const selected = viewIssueNumber ? issues.find((i) => i.issueNumber === viewIssueNumber) : null;

  /* Material Requests Production has sent to the Store that still have a
     balance to hand out — the queue shown on the "Pending Requests" tab. */
  const pendingMrs = useMemo(() => {
    return getMaterialRequests()
      .map((m) => decorateMR(m))
      .filter((m) => ISSUABLE_STATUSES.has(m.status))
      .filter((m) => getMaterialShortages(m).some((s) => s.balance > 0))
      .sort((a, b) => String(b.requestDate || '').localeCompare(String(a.requestDate || '')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const filteredPending = pendingMrs.filter((mr) => {
    const q = pendingSearch.toLowerCase().trim();
    if (!q) return true;
    return [mr.mrNumber, mr.jobCardNumber, mr.customer, mr.partName, mr.projectId, mr.salesOrderRef, mr.requestedBy]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  const issuingMr = useMemo(() => {
    if (!issuingMrNumber) return null;
    const queued = pendingMrs.find((m) => m.mrNumber === issuingMrNumber);
    if (queued) return queued;
    const raw = getMaterialRequests().find((m) => m.mrNumber === issuingMrNumber);
    return raw ? decorateMR(raw) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuingMrNumber, pendingMrs]);

  const startIssue = (mrNumber) => {
    setIssuingMrNumber(mrNumber);
    setIssueError('');
    setIssueFlash('');
  };

  const handleIssue = ({ issueQtyById, receiver, remarks, batchInfo, issueRefs }) => {
    if (!issuingMrNumber) return;
    try {
      setIssueBusy(true);
      const si = issueMaterial({ mrNumber: issuingMrNumber, issueQtyById, receiver, remarks, batchInfo, issueRefs });
      setIssueBusy(false);
      setIssueFlash(`Store Issue ${si.issueNumber} created for ${issuingMrNumber} — Production has been notified.`);
      setIssuingMrNumber(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setIssueBusy(false);
      setIssueError(err.message);
    }
  };

  return (
    <section className="page-section store-screen">
      <div className="page-header">
        <div>
          <h1 className="page-title">Store Issues Register</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      <div className="tab-nav">
        <button type="button" className={`tab-link ${tab === 'pending' ? 'active' : ''}`} onClick={() => { setTab('pending'); setIssuingMrNumber(null); }}>
          Pending Requests{pendingMrs.length ? ` (${pendingMrs.length})` : ''}
        </button>
        <button type="button" className={`tab-link ${tab === 'register' ? 'active' : ''}`} onClick={() => setTab('register')}>Register</button>
        <button type="button" className={`tab-link ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Trail</button>
      </div>

      {issueFlash && tab !== 'pending' ? (
        <div className="form-success-message" style={{ marginBottom: '12px' }}>{issueFlash}</div>
      ) : null}

      {tab === 'audit' ? (
        <StoreAuditLogView />
      ) : tab === 'pending' ? (
        issuingMr ? (
          <IssueForm
            mr={issuingMr}
            busy={issueBusy}
            error={issueError}
            canSubmit={canIssue}
            onBack={() => { setIssuingMrNumber(null); setIssueError(''); }}
            onSubmit={handleIssue}
          />
        ) : (
          <PendingRequestsView
            mrs={filteredPending}
            totalCount={pendingMrs.length}
            search={pendingSearch}
            onSearch={setPendingSearch}
            canIssue={canIssue}
            flash={issueFlash}
            onIssue={startIssue}
          />
        )
      ) : selected ? (
        <SelectedSI si={selected} onBack={() => { setViewIssueNumber(null); setRefreshTick((t) => t + 1); }} />
      ) : (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Store Issue Register</h3>
            <span className="muted-text">{filtered.length} issue(s)</span>
          </div>

          <div className="list-filters">
            <input
              type="text"
              className="action-select form-input search-input"
              placeholder="Search SI / MR / Job Card / project / receiver..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="action-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              {projectFilterOptions.map((p) => (
                <option key={p} value={p}>{p === 'All' ? 'All Projects' : `Project: ${p}`}</option>
              ))}
            </select>
          </div>

          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Issue No</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>MR No</th>
                  <th>Job Card</th>
                  <th>PO No</th>
                  <th>Project ID</th>
                  <th>Part Name</th>
                  <th>Received By</th>
                  <th>Issued By</th>
                  <th>Items</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan="12" className="no-history-row">No store issues recorded yet.</td>
                  </tr>
                ) : (
                  filtered.map((si) => (
                    <tr key={si.issueNumber}>
                      <td><strong>{si.issueNumber}</strong></td>
                      <td>{si.issueDate}</td>
                      <td>{si.issueTime}</td>
                      <td>{si.mrNumber || '—'}</td>
                      <td>{si.jobCardNumber || '—'}</td>
                      <td>{si.poNumber || '—'}</td>
                      <td>
                        {si.projectId ? (
                          <span style={{ color: '#3730a3', fontWeight: '700', fontSize: '12px' }}>{si.projectId}</span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                      <td>{si.partName || '—'}</td>
                      <td>{si.receivedBy} {si.receivedByEmpId ? `(${si.receivedByEmpId})` : ''}</td>
                      <td>{si.issuedBy || '—'}</td>
                      <td>{Array.isArray(si.items) ? si.items.length : 0}</td>
                      <td>
                        <button type="button" className="button-secondary button-small" onClick={() => setViewIssueNumber(si.issueNumber)}>View</button>
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

const SelectedSI = ({ si, onBack }) => {
  return (
    <div>
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Store Issue {si.issueNumber}</h3>
          <span className="status-badge st-filled">Acknowledged</span>
        </div>

        <div className="si-document">
          <div className="si-doc-head">
            <h2>STORE ISSUE SLIP</h2>
            <div className="si-doc-ref">
              <div><strong>SI No:</strong> {si.issueNumber}</div>
              <div><strong>Date:</strong> {si.issueDate} · {si.issueTime}</div>
            </div>
          </div>

          <div className="si-parties">
            <div className="si-party">
              <div className="si-party-title">ISSUED BY (STORE)</div>
              <div className="si-party-name">{si.issuedBy}</div>
              <div>{si.issuedById || ''} · {si.issuedByDept || 'Stores'}</div>
            </div>
            <div className="si-party">
              <div className="si-party-title">RECEIVED BY (EMPLOYEE)</div>
              <div className="si-party-name">{si.receivedBy}</div>
              <div>{si.receivedByEmpId}{si.receivedByDept ? ` · ${si.receivedByDept}` : ''}{si.receivedByDesignation ? ` · ${si.receivedByDesignation}` : ''}{si.receivedByMobile ? ` · ${si.receivedByMobile}` : ''}</div>
            </div>
          </div>

          <div className="si-meta">
            <div><strong>MR No:</strong> {si.mrNumber || '—'}</div>
            <div><strong>Job Card:</strong> {si.jobCardNumber || '—'}</div>
            <div><strong>PO No:</strong> {si.poNumber || '—'}</div>
            <div><strong>Project ID:</strong> <span style={{ color: '#3730a3', fontWeight: '700' }}>{si.projectId || '—'}</span></div>
            <div><strong>Project Name:</strong> {si.projectName || '—'}</div>
            <div><strong>Sales Order:</strong> {si.salesOrderRef || '—'}</div>
            <div><strong>Customer:</strong> {si.customer || '—'}</div>
            <div><strong>Part Name:</strong> {si.partName || '—'}</div>
            <div><strong>Requested By:</strong> {si.requestedBy} {si.requestedByEmpId ? `(${si.requestedByEmpId})` : ''}</div>
          </div>

          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material</th>
                <th>Spec</th>
                <th>Required</th>
                <th>Issued Now</th>
                <th>Total Issued</th>
                <th>Balance</th>
                <th>Batch</th>
                <th>Lot No</th>
                <th>Heat No</th>
                <th>Serial No</th>
              </tr>
            </thead>
            <tbody>
              {(Array.isArray(si.items) ? si.items : []).map((it, idx) => (
                <tr key={`${si.issueNumber}-${it.materialId}`}>
                  <td>{idx + 1}</td>
                  <td>{it.materialName}</td>
                  <td>{it.spec || '—'}</td>
                  <td>{it.requestedQty} {it.unit}</td>
                  <td><strong>{it.currentIssueQty} {it.unit}</strong></td>
                  <td>{it.totalIssued} {it.unit}</td>
                  <td>{it.remainingQty} {it.unit}</td>
                  <td>{it.batchNo || '—'}</td>
                  <td>{it.lotNumber || '—'}</td>
                  <td>{it.heatNumber || '—'}</td>
                  <td>{it.serialNumber || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="si-ack">
            <strong>Acknowledgement:</strong> {si.acknowledgementText}
            <div className="si-ack-sign"></div>
          </div>

          {si.remarks && (
            <div className="si-remarks"><strong>Remarks:</strong> {si.remarks}</div>
          )}

          <div className="si-footer">
            Acknowledged at {si.acknowledgedAt} · Recorded by {si.issuedBy}
          </div>
        </div>

        <div className="template-modal-actions">
          <button type="button" className="button-primary" onClick={onBack}>&larr; Back to Register</button>
        </div>
      </div>
    </div>
  );
};

export default StoreIssuesPage;

/* ---------------------------------------------------------------------------
   Pending Material Requests — the queue Production has sent to the Store.
   Opening a row hands over to IssueForm where the store person records who
   took the material, the Job Card / PO / Customer it went against, and how
   much of each line is being issued.
--------------------------------------------------------------------------- */
const PendingRequestsView = ({ mrs, totalCount, search, onSearch, canIssue, flash, onIssue }) => (
  <div className="content-block">
    <div className="block-header">
      <h3 className="block-title">Pending Material Requests</h3>
      <span className="muted-text">{mrs.length} of {totalCount} request(s) awaiting issue</span>
    </div>

    {flash ? <div className="form-success-message" style={{ marginBottom: '12px' }}>{flash}</div> : null}

    <div className="list-filters">
      <input
        type="text"
        className="action-select form-input search-input"
        placeholder="Search MR / Job Card / PO / Customer / part / project / requester..."
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>

    <div className="history-table-wrapper">
      <table className="history-table">
        <thead>
          <tr>
            <th>MR No</th>
            <th>Job Card</th>
            <th>PO No</th>
            <th>Customer</th>
            <th>Part Name</th>
            <th>Project</th>
            <th>Requested By</th>
            <th>Required Date</th>
            <th>Pending Items</th>
            <th>Store Ack</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {mrs.length === 0 ? (
            <tr>
              <td colSpan="11" className="no-history-row">No pending material requests.</td>
            </tr>
          ) : (
            mrs.map((mr) => {
              const rows = getMaterialShortages(mr);
              const pendingLines = rows.filter((r) => r.balance > 0);
              const ack = getAcknowledgement(mr.mrNumber);
              return (
                <tr key={mr.mrNumber}>
                  <td><strong>{mr.mrNumber}</strong></td>
                  <td>{mr.jobCardNumber || '—'}</td>
                  <td>{derivePoNumber(mr) || '—'}</td>
                  <td>{mr.customer || '—'}</td>
                  <td>{mr.partName || '—'}</td>
                  <td>{mr.projectId || '—'}</td>
                  <td>{mr.requestedBy || '—'}{mr.requestedByEmpId ? ` (${mr.requestedByEmpId})` : ''}</td>
                  <td>{mr.requiredDate || '—'}</td>
                  <td>
                    {pendingLines.length} line(s)
                    <div className="muted-text" style={{ fontSize: '11px' }}>
                      {pendingLines.map((p) => `${p.materialName} · bal ${p.balance} ${p.unit}`).join(' · ')}
                    </div>
                  </td>
                  <td>{ack ? <AckChip status={ack.status} /> : <span className="muted-text">—</span>}</td>
                  <td>
                    <button
                      type="button"
                      className="button-primary button-small"
                      disabled={!canIssue}
                      title={canIssue ? 'Issue material against this request' : 'Permission material_issue.confirm required'}
                      onClick={() => onIssue(mr.mrNumber)}
                    >
                      Issue
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>

    {!canIssue ? (
      <div className="muted-text" style={{ marginTop: '8px' }}>
        You can view this queue, but issuing requires the <strong>material_issue.confirm</strong> permission.
      </div>
    ) : null}
  </div>
);

/* ---------------------------------------------------------------------------
   Issue entry form: quantities + batch details, receiver name (Employee
   Master), and the Job Card / PO Number / Customer Name the store person
   confirms at hand-over. Those three references are stamped onto the Store
   Issue slip and the stock transaction only — never back onto the MR.
--------------------------------------------------------------------------- */
const IssueForm = ({ mr, busy, error, canSubmit, onBack, onSubmit }) => {
  const shortages = useMemo(() => getMaterialShortages(mr), [mr]);
  const inventoryBatches = getInventoryBatches();
  const anyIssuable = shortages.some((s) => s.canIssuePartially);

  const [issueQty, setIssueQty] = useState({});
  const [batchInfo, setBatchInfo] = useState({});
  const [receiver, setReceiver] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [localError, setLocalError] = useState('');
  const [refs, setRefs] = useState({ jobCardNumber: '', poNumber: '', customer: '' });

  useEffect(() => {
    const prefill = {};
    shortages.forEach((s) => {
      prefill[s.materialId] = s.balance > 0 ? Math.min(s.balance, s.available) : 0;
    });
    setIssueQty(prefill);
    setBatchInfo({});
    setReceiver(null);
    setAcknowledged(false);
    setRemarks('');
    setLocalError('');
    setRefs({
      jobCardNumber: mr.jobCardNumber || '',
      poNumber: derivePoNumber(mr),
      customer: mr.customer || ''
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mr.mrNumber]);

  const setQty = (materialId, val) => {
    const n = Number(val);
    setIssueQty((prev) => ({ ...prev, [materialId]: Number.isNaN(n) || n < 0 ? 0 : n }));
  };

  const setBatchField = (materialId, field, val) => {
    setBatchInfo((prev) => ({ ...prev, [materialId]: { ...(prev[materialId] || {}), [field]: val } }));
  };

  const selectReceiptBatch = (materialId, receiptBatchId) => {
    const selectedBatch = inventoryBatches.find((batch) => batch.id === receiptBatchId);
    setBatchInfo((prev) => ({ ...prev, [materialId]: {
      ...(prev[materialId] || {}), receiptBatchId,
      batchNo: selectedBatch?.supplierBatchNumber || selectedBatch?.batchNumber || '',
      lotNumber: selectedBatch?.lotNumber || ''
    } }));
  };

  const setRef = (field, val) => setRefs((prev) => ({ ...prev, [field]: val }));

  const submit = () => {
    setLocalError('');
    if (!receiver) return setLocalError('Select the employee receiving the material from the Employee Master.');
    if (!acknowledged) return setLocalError('The receiver must tick the acknowledgement checkbox before material is issued.');
    const qtyById = {};
    let anyQty = false;
    shortages.forEach((s) => {
      const q = Number(issueQty[s.materialId] || 0);
      if (q > 0) anyQty = true;
      qtyById[s.materialId] = q;
    });
    if (!anyIssuable) return setLocalError('Nothing can be issued — no stock available against this request.');
    if (!anyQty) return setLocalError('Enter the quantity to issue for at least one material line.');
    const over = shortages.find((s) => Number(issueQty[s.materialId] || 0) > Math.min(s.available, s.balance));
    if (over) return setLocalError(`Issue quantity for ${over.materialName} exceeds the limit (max ${Math.min(over.available, over.balance)} ${over.unit}).`);

    onSubmit({
      issueQtyById: qtyById,
      receiver: { ...receiver, acknowledged },
      remarks,
      batchInfo,
      issueRefs: {
        jobCardNumber: refs.jobCardNumber,
        poNumber: refs.poNumber,
        customer: refs.customer
      }
    });
  };

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">Issue Material — {mr.mrNumber}</h3>
        <StatusChip status={mr.status} />
      </div>

      <div className="detail-grid">
        <div><strong>Material Request:</strong> {mr.mrNumber}</div>
        <div><strong>Sales Order:</strong> {mr.salesOrderRef || '—'}</div>
        <div><strong>Project ID:</strong> <span style={{ color: '#3730a3', fontWeight: '700' }}>{mr.projectId || '—'}</span></div>
        <div><strong>Project Name:</strong> {mr.projectName || '—'}</div>
        <div><strong>Part Name:</strong> {mr.partName || '—'}</div>
        <div><strong>Requested By:</strong> {mr.requestedBy} {mr.requestedByEmpId ? `(${mr.requestedByEmpId})` : ''}</div>
        <div><strong>Request Date:</strong> {mr.requestDate || '—'}</div>
        <div><strong>Required Date:</strong> {mr.requiredDate || '—'}</div>
      </div>

      <div className="block-header">
        <h3 className="block-title">Issue References</h3>
        <span className="muted-text">Confirmed by Stores at hand-over · printed on the Store Issue slip</span>
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label>Job Card</label>
          <input
            type="text"
            className="action-select form-input"
            value={refs.jobCardNumber}
            disabled={!canSubmit || busy}
            onChange={(e) => setRef('jobCardNumber', e.target.value)}
            placeholder="e.g. JC-0001"
          />
        </div>
        <div className="form-field">
          <label>PO Number</label>
          <input
            type="text"
            className="action-select form-input"
            value={refs.poNumber}
            disabled={!canSubmit || busy}
            onChange={(e) => setRef('poNumber', e.target.value)}
            placeholder="Customer PO number"
          />
        </div>
        <div className="form-field">
          <label>Customer Name</label>
          <input
            type="text"
            className="action-select form-input"
            value={refs.customer}
            disabled={!canSubmit || busy}
            onChange={(e) => setRef('customer', e.target.value)}
            placeholder="Customer the material is going out for"
          />
        </div>
        <div className="form-field">
          <label>Request Date</label>
          <input type="date" className="action-select form-input" value={todayStr()} readOnly />
        </div>
        <div className="form-field">
          <label>Issue Time</label>
          <input type="text" className="action-select form-input" value={nowTimeStr()} readOnly />
        </div>
      </div>

      <div className="block-header">
        <h3 className="block-title">Quantities &amp; Batch</h3>
        <span className="muted-text">Issue quantity cannot exceed available stock or the balance still due.</span>
      </div>

      <div className="history-table-wrapper">
        <table className="history-table">
          <thead>
            <tr>
              <th>SL.No</th>
              <th>Material</th>
              <th>Required</th>
              <th>Available</th>
              <th>Already Issued</th>
              <th>Balance</th>
              <th>Issue Qty</th>
              <th>Batch No</th>
              <th>Lot No</th>
              <th>Heat No</th>
              <th>Serial No</th>
            </tr>
          </thead>
          <tbody>
            {shortages.map((s, idx) => (
              <tr key={s.materialId}>
                <td>{idx + 1}</td>
                <td>{s.materialName}</td>
                <td>{s.required} {s.unit}</td>
                <td>
                  {s.available} {s.unit}
                  {s.shortage > 0 && <div className="badge-short">SHORTAGE</div>}
                </td>
                <td>{s.issued} {s.unit}</td>
                <td>{s.balance} {s.unit}</td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    disabled={!canSubmit || busy || s.balance <= 0}
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
                  <select className="issue-qty-input" disabled={!canSubmit || busy} value={batchInfo[s.materialId]?.receiptBatchId || ''} onChange={(e) => selectReceiptBatch(s.materialId, e.target.value)}>
                    <option value="">Select receipt batch</option>
                    {inventoryBatches.filter((batch) => String(batch.itemCode || '').toLowerCase() === String(s.materialId || '').toLowerCase() && Number(batch.availableQty) > 0)
                      .map((batch) => <option key={batch.id} value={batch.id}>{batch.supplierBatchNumber || batch.batchNumber || 'No supplier batch'} / {batch.internalBatchId || batch.id} — {batch.availableQty} available</option>)}
                  </select>
                  <div className="muted-text">Supplier batch: {batchInfo[s.materialId]?.batchNo || 'Not recorded'}</div>
                </td>
                <td>
                  <input
                    type="text"
                    className="issue-qty-input"
                    disabled={!canSubmit || busy}
                    value={batchInfo[s.materialId]?.lotNumber || ''}
                    onChange={(e) => setBatchField(s.materialId, 'lotNumber', e.target.value)}
                    placeholder="Lot No"
                    title="Lot number for this issue — taken from the batch register when left blank"
                  />
                </td>
                <td><input type="text" className="issue-qty-input" disabled={!canSubmit || busy} value={batchInfo[s.materialId]?.heatNumber || ''} onChange={(e) => setBatchField(s.materialId, 'heatNumber', e.target.value)} /></td>
                <td><input type="text" className="issue-qty-input" disabled={!canSubmit || busy} value={batchInfo[s.materialId]?.serialNumber || ''} onChange={(e) => setBatchField(s.materialId, 'serialNumber', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="block-header">
        <h3 className="block-title">Issued To (Employee)</h3>
        <span className="muted-text">Receiver must be a verified employee from the Employee Master. Free-text not allowed.</span>
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label>Receiver Name / ID *</label>
          <EmployeeSearchSelect value={receiver} onChange={setReceiver} />
        </div>
        <div className="form-field">
          <label>Receiver ID</label>
          <input type="text" className="action-select form-input" value={receiver?.employeeId || ''} readOnly placeholder="Auto-filled from Employee Master" />
        </div>
        <div className="form-field">
          <label>Receiver Department</label>
          <input type="text" className="action-select form-input" value={receiver?.department || ''} readOnly placeholder="Auto-filled from Employee Master" />
        </div>
      </div>

      <label className="acknowledgement-box">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={!canSubmit || busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>
          I confirm that I have received the above material
          {receiver ? ` — ${receiver.name} (${receiver.employeeId})` : ''}. This is a mandatory acknowledgement.
        </span>
      </label>

      <div className="form-field">
        <label>Remarks / Notes</label>
        <textarea
          className="action-select form-input"
          rows="2"
          value={remarks}
          disabled={!canSubmit || busy}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Any notes for this issue..."
        />
      </div>

      {(localError || error) ? <div className="form-error">{localError || error}</div> : null}

      <div className="template-modal-actions start-actions">
        <button type="button" className="button-primary" disabled={!canSubmit || busy || !anyIssuable} onClick={submit}>
          {busy ? 'Processing...' : `Issue Material ${receiver ? `to ${receiver.name}` : ''}`}
        </button>
        <button type="button" className="button-secondary" disabled={busy} onClick={onBack}>&larr; Back to Queue</button>
      </div>
    </div>
  );
};
