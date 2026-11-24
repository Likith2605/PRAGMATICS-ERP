import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterMaterialRecords } from '../utils/historySearch.js';
import { hasPermission } from '../utils/permissions.js';
import {
  getReceipts,
  getReceiptsForPO,
  getReceipt,
  getQualityChecks,
  getQualityCheck,
  getQualityCheckForReceipt,
  getQualityCheckForIndent,
  getDebitNotesForQualityCheck,
  getIndentsAwaitingQualityCheck,
  getIndent,
  getPOProgress,
  saveQualityCheck,
  postApprovedMaterialToInventory,
  QC_STATUS
} from '../utils/workflowService.js';
import { openWorkflowDocument } from '../utils/workflowFiles.js';

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const num = (v) => Number(v) || 0;

const QualityCheckPage = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('queue');
  const [queueSearch, setQueueSearch] = useState('');
  const [indentSearch, setIndentSearch] = useState('');
  const [inspectionSearch, setInspectionSearch] = useState('');
  const [inspectReceipt, setInspectReceipt] = useState(null);
  const [inspectIndent, setInspectIndent] = useState(null);
  const [openQC, setOpenQC] = useState(null);
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();

  /* Notification deep link: /quality-checks?receipt=MR-xxxx opens the
     inspection (or the saved Quality Check when it already exists). */
  useEffect(() => {
    const rec = searchParams.get('receipt');
    const indentNo = searchParams.get('indent');
    if (rec) {
      const receipt = getReceipt(rec);
      if (!receipt) {
        setSearchParams({}, { replace: true });
        setMessage({ type: 'err', text: `Material Receipt ${rec} could not be found. Refresh the receipt list and try again.` });
        return;
      }
      const existing = getQualityCheckForReceipt(rec);
      setTab('queue');
      if (existing) {
        setInspectReceipt(null);
        setOpenQC(existing.qcNumber);
      } else {
        setOpenQC(null);
        setInspectReceipt(rec);
      }
      setSearchParams({}, { replace: true });
      return;
    }
    if (indentNo) {
      const indent = getIndent(indentNo);
      if (!indent) {
        setSearchParams({}, { replace: true });
        setMessage({ type: 'err', text: `Purchase Indent ${indentNo} could not be found.` });
        return;
      }
      const existing = getQualityCheckForIndent(indentNo);
      setTab('queue');
      if (existing) {
        setInspectIndent(null);
        setOpenQC(existing.qcNumber);
      } else {
        setOpenQC(null);
        setInspectIndent(indentNo);
      }
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const receipts = useMemo(() => getReceipts(), [tick]);
  const qcs = useMemo(() => getQualityChecks(), [tick]);
  const indentQueue = useMemo(() => getIndentsAwaitingQualityCheck(), [tick]);
  const canManage = hasPermission('production.qc.manage');
  const isStoreUser = hasPermission('store.module') && !hasPermission('purchase.order');

  const queue = receipts.filter((r) => !r.qcNumber);
  const filteredQueue = filterMaterialRecords(queue, queueSearch, ['receiptNumber','projectId','poNumber','soNumber','indentNumber','vendor','invoiceNumber','qcStatus','inspectionStatus','receiptDate']);
  const filteredIndentQueue = filterMaterialRecords(indentQueue, indentSearch, ['indentNumber','projectId','poNumber','soNumber','customer','sentToQCAt','status']);
  const filteredQcs = filterMaterialRecords(qcs, inspectionSearch, ['qcNumber','receiptNumber','indentNumber','projectId','poNumber','inspector','inspectionDate','status','vendor','invoiceNumber','soNumber']);
  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 7000);
  };

  const qc = openQC ? getQualityCheck(openQC) : null;

  if (inspectReceipt || inspectIndent) {
    const inspectTarget = inspectReceipt || inspectIndent;
    return (
      <section className={`page-section${isStoreUser ? ' store-screen' : ''}`}>
        <div className="page-header">
          <div>
            <h1 className="page-title">
              {inspectReceipt ? `Inspect Receipt ${inspectReceipt}` : `Inspect Purchase Indent ${inspectIndent}`}
            </h1>
            <p className="page-description">Accepted + Rejected must equal the received quantity.</p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={() => { setInspectReceipt(null); setInspectIndent(null); }}>← Back</button>
          </div>
        </div>

        {/* Errors must stay visible here. The key deliberately excludes `tick`
            so a failed save does NOT remount the form and wipe what was typed. */}
        {message && (
          <div
            role="alert"
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

        {canManage ? (
          <InspectionForm
            key={inspectTarget}
            receiptNumber={inspectReceipt || ''}
            indentNumber={inspectIndent || ''}
            onDone={(qcNumber) => { setInspectReceipt(null); setInspectIndent(null); setOpenQC(qcNumber); flash('ok', `Quality check ${qcNumber} saved.`); }}
            onError={(err) => flash('err', err.message)}
          />
        ) : (
          <div role="alert" className="content-block" style={{ color: '#92400e' }}>
            Quality inspections can only be entered by Production / Quality. This page is read-only for your account.
          </div>
        )}
      </section>
    );
  }

  if (qc) {
    const posted = qc.postedToInventory;
    const qcDebitNotes = getDebitNotesForQualityCheck(qc.qcNumber);
    return (
      <section className={`page-section${isStoreUser ? ' store-screen' : ''}`}>
        <div className="page-header">
          <div>
            <h1 className="page-title">Quality Check {qc.qcNumber}</h1>
            <p className="page-description">
              PO {qc.poNumber} · {qc.receiptNumber ? `Receipt ${qc.receiptNumber}` : `Purchase Indent ${qc.indentNumber || '—'}`} · SO {qc.soNumber || '—'}
            </p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={() => { setOpenQC(null); setTick((t) => t + 1); }}>← Back</button>
          </div>
        </div>

        {message && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontWeight: 600, background: '#fee2e2', color: '#b91c1c' }}>
            {message.text}
          </div>
        )}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Inspection Summary</h3>
            <span className={badgeClass(qc.status)}>{qc.status}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
            <div><strong>PO:</strong> {qc.poNumber}</div>
            <div><strong>Receipt:</strong> {qc.receiptNumber || '—'}</div>
            <div><strong>Purchase Indent:</strong> {qc.indentNumber || '—'}</div>
            <div><strong>Sales Order:</strong> {qc.soNumber || '—'}</div>
            <div><strong>Vendor:</strong> {qc.vendor || '—'}</div>
            <div><strong>Delivered By:</strong> {qc.deliveredBy || '—'}</div>
            <div><strong>Contact:</strong> {qc.contactNumber || '—'}</div>
            <div><strong>Transporter:</strong> {qc.transporter || '—'}</div>
            <div><strong>Inspector:</strong> {qc.inspector}</div>
            <div><strong>Inspection Date:</strong> {qc.inspectionDate}</div>
            <div><strong>Inventory Posted:</strong> {posted ? 'Yes' : 'No'}</div>
          </div>
          {qc.remarks && <p style={{ marginTop: '8px' }}><strong>Remarks:</strong> {qc.remarks}</p>}
        </div>

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Received | Accepted | Rejected</h3>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Material</th><th>Batch / Lot</th><th>Unit</th><th>Received</th><th>Accepted</th><th>Rejected</th>
                  <th>Quality Parameters</th><th>Result</th><th>Rejection Reason</th>
                </tr>
              </thead>
              <tbody>
                {qc.items.map((it, idx) => (
                  <tr key={idx}>
                    <td>{idx + 1}</td>
                    <td><strong>{it.materialName}</strong></td>
                    <td>
                      {it.batchNumber || it.lotNumber ? (
                        <>
                          {it.batchNumber || '—'}
                          {it.lotNumber ? <div className="muted-text" style={{ fontSize: '11px' }}>Lot {it.lotNumber}</div> : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{it.unit}</td>
                    <td>{num(it.receivedQty)}</td>
                    <td style={{ color: '#166534', fontWeight: 700 }}>{num(it.acceptedQty)}</td>
                    <td style={{ color: num(it.rejectedQty) > 0 ? '#b91c1c' : 'inherit', fontWeight: 700 }}>{num(it.rejectedQty)}</td>
                    <td>{it.parameters || '—'}</td>
                    <td><span className={badgeClass(it.result)}>{it.result}</span></td>
                    <td>{it.rejectionReason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {qc.receiptNumber && (
              <button className="button-secondary" onClick={() => navigate('/material-receipts', { state: { openReceipt: qc.receiptNumber } })}>
                Open Receipt {qc.receiptNumber}
              </button>
            )}
            {qc.indentNumber && (
              <button className="button-secondary" onClick={() => navigate('/purchase-indents', { state: { openIndent: qc.indentNumber } })}>
                Open Purchase Indent {qc.indentNumber}
              </button>
            )}
            {canManage && !posted && num(qc.items.reduce((a, i) => a + num(i.acceptedQty), 0)) > 0 && (
              <button
                className="button-primary"
                onClick={() => {
                  try {
                    postApprovedMaterialToInventory(qc.qcNumber);
                    flash('ok', 'Approved quantity added to inventory.');
                  } catch (err) {
                    flash('err', err.message);
                  }
                }}
              >
                Store: Confirm into Inventory
              </button>
            )}
            {posted && <span className={badgeClass('Posted')}>Added to inventory</span>}
          </div>
        </div>

        {qcDebitNotes.length > 0 && (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Debit Notes (read-only)</h3>
              <span className="muted-text">Rejected material claimed from the vendor</span>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr><th>Debit Note</th><th>Date</th><th>Rejection Report</th><th>Qty</th><th>Debit Value</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {qcDebitNotes.map((d) => (
                    <tr key={d.debitNoteNumber}>
                      <td>
                        <button
                          className="button-small button-secondary"
                          onClick={() => navigate('/debit-notes', { state: { openDebitNote: d.debitNoteNumber } })}
                        >
                          {d.debitNoteNumber}
                        </button>
                      </td>
                      <td>{d.debitNoteDate}</td>
                      <td>{d.rejectionNumber || '—'}</td>
                      <td>{num(d.totalDebitQty)}</td>
                      <td><strong>₹{num(d.grandTotal).toFixed(2)}</strong></td>
                      <td><span className={badgeClass(d.status)}>{d.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: '10px', color: '#475569', fontSize: '12.5px' }}>
              A Debit Note only records the credit due for rejected material. Accepted quantities, this inspection and
              inventory are unchanged.
            </p>
          </div>
        )}

        <div className="content-block">
          <div className="block-header"><h3 className="block-title">History</h3></div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead><tr><th>Date / Time</th><th>User</th><th>Department</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>
                {(qc.history || []).slice().reverse().map((h, idx) => (
                  <tr key={idx}><td>{h.at}</td><td>{h.name}</td><td>{h.dept}</td><td>{h.action}</td><td>{h.details || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`page-section${isStoreUser ? ' store-screen' : ''}`}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Quality Check</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      <div className="tab-nav">
        <button className={`tab-link ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>
          Awaiting Inspection ({queue.length})
        </button>
        <button className={`tab-link ${tab === 'inspections' ? 'active' : ''}`} onClick={() => setTab('inspections')}>
          Inspections ({qcs.length})
        </button>
      </div>

      {message && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontWeight: 600, background: '#fee2e2', color: '#b91c1c' }}>
          {message.text}
        </div>
      )}

      <div className="content-block">
        {tab === 'queue' ? (
          <>
            <div className="block-header">
              <h3 className="block-title">Material awaiting quality inspection</h3>
            </div>
            <RecordSearchBar value={queueSearch} onChange={setQueueSearch} placeholder="Search receipt, project, PO, SO, indent, vendor..." label="Search awaiting inspections" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Receipt No</th><th>Date</th><th>Project ID</th><th>PO</th><th>SO</th><th>Indent</th><th>Vendor</th><th>Invoice</th><th>Materials</th><th>QC Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQueue.length === 0 ? (
                    <tr><td colSpan="11" className="no-history-row">{queue.length ? 'No awaiting inspections match your search.' : 'No material awaiting quality check.'}</td></tr>
                  ) : (
                    filteredQueue.map((r) => (
                      <tr key={r.receiptNumber}>
                        <td><strong>{r.receiptNumber}</strong></td>
                        <td>{r.receiptDate}</td>
                        <td>{r.projectId || '—'}</td>
                        <td>{r.poNumber}</td>
                        <td>{r.soNumber || '—'}</td>
                        <td>{r.indentNumber || '—'}</td>
                        <td>{r.vendor}</td>
                        <td>{r.invoiceNumber}</td>
                        <td>{r.items?.length || 0}</td>
                        <td>
                          <span className={badgeClass(r.qcStatus || 'Pending')}>{r.qcStatus || 'Pending'}</span>
                        </td>
                        <td>
                          <button className="button-small button-secondary" disabled={!canManage || !Array.isArray(r.items) || r.items.length === 0} onClick={() => setInspectReceipt(r.receiptNumber)}>
                            {!Array.isArray(r.items) || r.items.length === 0 ? 'No Materials' : canManage ? 'Start Inspection' : 'View'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="block-header" style={{ marginTop: '28px' }}>
              <h3 className="block-title">Purchase Indents sent to Quality Check ({indentQueue.length})</h3>
            </div>
            <RecordSearchBar value={indentSearch} onChange={setIndentSearch} placeholder="Search indent, project, PO, SO, customer..." label="Search purchase indents sent to quality check" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Indent No</th><th>Sent On</th><th>Project ID</th><th>PO</th><th>SO</th><th>Customer</th><th>Pending Qty</th><th>QC Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIndentQueue.length === 0 ? (
                    <tr><td colSpan="9" className="no-history-row">{indentQueue.length ? 'No purchase indents match your search.' : 'No Purchase Indent has been sent for quality inspection.'}</td></tr>
                  ) : (
                    filteredIndentQueue.map((i) => {
                      const progress = i.poNumber ? getPOProgress(i.poNumber) : null;
                      const receiptsForPO = i.poNumber ? getReceiptsForPO(i.poNumber) : [];
                      const receiptAlreadyRecorded = receiptsForPO.length > 0;
                      return (
                        <tr key={i.indentNumber}>
                          <td><strong>{i.indentNumber}</strong></td>
                          <td>{i.sentToQCAt || '—'}</td>
                          <td>{i.projectId || '—'}</td>
                          <td>{i.poNumber || '—'}</td>
                          <td>{i.soNumber || '—'}</td>
                          <td>{i.customer || '—'}</td>
                          <td>{progress ? progress.pending : '—'}</td>
                          <td>
                            <span className={badgeClass(receiptAlreadyRecorded ? 'Receipt Required' : 'Awaiting Inspection')}>
                              {receiptAlreadyRecorded
                                ? `Receipt recorded: ${receiptsForPO.map((r) => r.receiptNumber).join(', ')}`
                                : 'Awaiting Inspection'}
                            </span>
                          </td>
                          <td>
                            <button
                              className="button-small button-secondary"
                              disabled={!canManage || receiptAlreadyRecorded}
                              onClick={() => setInspectIndent(i.indentNumber)}
                              title={receiptAlreadyRecorded ? 'Inspect the specific Material Receipt in the receipt queue above.' : ''}
                            >
                              {receiptAlreadyRecorded ? 'Inspect Receipt Instead' : canManage ? 'Start Inspection' : 'View'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="block-header">
              <h3 className="block-title">Inspections</h3>
            </div>
            <RecordSearchBar value={inspectionSearch} onChange={setInspectionSearch} placeholder="Search QC, receipt, project, PO, indent, status..." label="Search inspections" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>QC No</th><th>Date</th><th>Receipt / Indent</th><th>Project ID</th><th>PO</th><th>Indent</th><th>Inspector</th><th>Accepted</th><th>Rejected</th><th>Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQcs.length === 0 ? (
                    <tr><td colSpan="11" className="no-history-row">{qcs.length ? 'No inspections match your search.' : 'No inspections recorded yet.'}</td></tr>
                  ) : (
                    filteredQcs.map((q) => {
                      const accepted = q.items.reduce((a, i) => a + num(i.acceptedQty), 0);
                      const rejected = q.items.reduce((a, i) => a + num(i.rejectedQty), 0);
                      return (
                        <tr key={q.qcNumber}>
                          <td><strong>{q.qcNumber}</strong></td>
                          <td>{q.inspectionDate}</td>
                          <td>{q.receiptNumber || q.indentNumber || '—'}</td>
                          <td>{q.projectId || '—'}</td>
                          <td>{q.poNumber}</td>
                          <td>{q.indentNumber || '—'}</td>
                          <td>{q.inspector}</td>
                          <td style={{ color: '#166534', fontWeight: 700 }}>{accepted}</td>
                          <td style={{ color: rejected > 0 ? '#b91c1c' : 'inherit', fontWeight: 700 }}>{rejected}</td>
                          <td><span className={badgeClass(q.status)}>{q.status}</span></td>
                          <td><button className="button-small button-secondary" onClick={() => setOpenQC(q.qcNumber)}>View</button></td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
};

/* ------------------------------ inspection form ------------------------------ */

const InspectionForm = ({ receiptNumber = '', indentNumber = '', onDone, onError }) => {
  const receipt = receiptNumber ? getReceipt(receiptNumber) : null;
  const indent = indentNumber ? getIndent(indentNumber) : null;
  const existing = receiptNumber ? getQualityCheckForReceipt(receiptNumber) : getQualityCheckForIndent(indentNumber);
  const progress = !receipt && indent?.poNumber ? getPOProgress(indent.poNumber) : null;
  const receiptItems = Array.isArray(receipt?.items) ? receipt.items : [];
  const existingItems = Array.isArray(existing?.items) ? existing.items : [];

  const sourceLines = receiptItems.length
    ? receiptItems
    : existingItems.length
      ? existingItems
      : (progress?.lines || [])
          .filter((l) => l.pendingQty > 0)
          .map((l) => ({
            materialCode: l.materialCode || '',
            materialName: l.materialName || '',
            unit: l.unit || 'Nos',
            batchNumber: '',
            internalBatchId: '',
            lotNumber: '',
            receivedQty: l.pendingQty
          }));

  const [inspectionDate, setInspectionDate] = useState(existing?.inspectionDate || new Date().toISOString().slice(0, 10));
  const [inspector, setInspector] = useState(existing?.inspector || '');
  const [remarks, setRemarks] = useState(existing?.remarks || '');
  const [docs, setDocs] = useState(existing?.documents || []);
  const [lines, setLines] = useState(
    sourceLines.map((r) => {
      const prev = existingItems.find(
        (i) => (r.internalBatchId && i.internalBatchId === r.internalBatchId) ||
          (r.batchNumber && i.batchNumber === r.batchNumber && i.materialCode === r.materialCode) ||
          (!r.internalBatchId && !r.batchNumber && ((r.materialCode && i.materialCode === r.materialCode) || (!r.materialCode && i.materialName === r.materialName)))
      );
      return {
        materialCode: r.materialCode || '',
        materialName: r.materialName || '',
        unit: r.unit || 'Nos',
        batchNumber: r.batchNumber || '',
        internalBatchId: r.internalBatchId || '',
        lotNumber: r.lotNumber || '',
        receivedQty: num(r.receivedQty),
        acceptedQty: prev ? num(prev.acceptedQty) : num(r.receivedQty),
        rejectedQty: prev ? num(prev.rejectedQty) : 0,
        parameters: prev?.parameters || '',
        rejectionReason: prev?.rejectionReason || '',
        remarks: prev?.remarks || ''
      };
    })
  );

  /**
   * Text/flag fields are edited directly. Quantities are kept consistent with
   * the backend rule "Accepted + Rejected === Received": editing one side
   * derives the other, so entering 2 rejected on 4 received immediately shows
   * 2 accepted (and the section totals can never contradict each other).
   */
  const setLine = (idx, field, value) =>
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        if (field !== 'acceptedQty' && field !== 'rejectedQty') return { ...l, [field]: value };

        const received = num(l.receivedQty);
        const typed = Math.min(Math.max(Number(value) || 0, 0), received);
        const next =
          field === 'rejectedQty'
            ? { rejectedQty: typed, acceptedQty: received - typed }
            : { acceptedQty: typed, rejectedQty: received - typed };
        return { ...l, ...next };
      })
    );

  const totalReceived = lines.reduce((a, l) => a + num(l.receivedQty), 0);
  const totalAccepted = lines.reduce((a, l) => a + num(l.acceptedQty), 0);
  const totalRejected = lines.reduce((a, l) => a + num(l.rejectedQty), 0);
  const totalsBalanced = totalAccepted + totalRejected === totalReceived;
  const undecidedLine = lines.find((l) => num(l.acceptedQty) + num(l.rejectedQty) !== num(l.receivedQty));

  const submit = (e) => {
    e.preventDefault();
    try {
      const result = saveQualityCheck({
        receiptNumber,
        indentNumber,
        inspectionDate,
        inspector,
        remarks,
        items: lines,
        documents: docs
      });
      onDone(result.qcNumber);
    } catch (err) {
      onError(err);
    }
  };

  if (!receipt && !indent) {
    return (
      <div role="alert" className="content-block" style={{ color: '#b91c1c' }}>
        This receipt or purchase indent is no longer available. Return to the inspection queue and reopen the record.
      </div>
    );
  }

  if (sourceLines.length === 0) {
    return (
      <div role="alert" className="content-block" style={{ color: '#92400e' }}>
        No material lines are recorded for {receipt ? `receipt ${receipt.receiptNumber}` : `purchase indent ${indent.indentNumber}`}.
        Add the received material quantities before starting a Quality Check.
      </div>
    );
  }

  return (
    <form className="quotation-form" onSubmit={submit}>
      <div className="form-section">
        <div className="section-heading"><h3>Inspection Details</h3></div>
        <div className="section-grid">
          <div className="field-group">
            <label>{receipt ? 'Receipt No' : 'Purchase Indent No'}</label>
            <input value={receipt ? receipt.receiptNumber : indent.indentNumber} readOnly />
          </div>
          <div className="field-group">
            <label>PO Number</label>
            <input value={receipt ? receipt.poNumber : indent.poNumber} readOnly />
          </div>
          <div className="field-group">
            <label>Sales Order</label>
            <input value={(receipt ? receipt.soNumber : indent.soNumber) || '—'} readOnly />
          </div>
          <div className="field-group">
            <label>Delivered By</label>
            <input
              value={
                receipt?.deliveredBy
                  ? `${receipt.deliveredBy}${receipt.contactNumber ? ` · ${receipt.contactNumber}` : ''}${receipt.transporter ? ` (${receipt.transporter})` : ''}`
                  : '—'
              }
              readOnly
            />
          </div>
          <div className="field-group">
            <label>Inspection Date *</label>
            <input type="date" required value={inspectionDate} onChange={(e) => setInspectionDate(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Inspector Name *</label>
            <input required value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="Quality inspector" />
          </div>
          <div className="field-group full-width">
            <label>Inspection remarks</label>
            <textarea rows="2" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="section-heading">
          <h3>
            Received {totalReceived} | Accepted {totalAccepted} | Rejected {totalRejected}
          </h3>
          {!totalsBalanced && (
            <p role="alert" style={{ margin: '6px 0 0', fontSize: '13px', fontWeight: 700, color: '#b91c1c' }}>
              Accepted + Rejected must equal Received
              {undecidedLine ? ` — check "${undecidedLine.materialName}"` : ''}.
            </p>
          )}
          {totalsBalanced && (
            <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#64748b' }}>
              Accepted = Received − Rejected (updates automatically).
            </p>
          )}
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material</th><th>Lot No</th><th>Unit</th><th>Received Qty</th><th>Accepted Qty</th><th>Rejected Qty</th>
                <th>Quality Parameters</th><th>Rejection Reason</th><th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={`${l.materialCode}-${idx}`}>
                  <td>{idx + 1}</td>
                  <td>
                    <strong>{l.materialName}</strong>
                    {l.batchNumber ? (
                      <>
                        <br />
                        <small>Batch {l.batchNumber}</small>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <input
                      className="action-select form-input"
                      value={l.lotNumber || ''}
                      onChange={(e) => setLine(idx, 'lotNumber', e.target.value)}
                      placeholder="Lot No"
                      title="Lot number carried from the receipt / supplier label — posted to inventory with the accepted quantity"
                    />
                  </td>
                  <td>{l.unit}</td>
                  <td>{num(l.receivedQty)}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max={num(l.receivedQty)}
                      className="action-select form-input"
                      value={l.acceptedQty}
                      onChange={(e) => setLine(idx, 'acceptedQty', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max={num(l.receivedQty)}
                      className="action-select form-input"
                      value={l.rejectedQty}
                      onChange={(e) => setLine(idx, 'rejectedQty', e.target.value)}
                    />
                  </td>
                  <td>
                    <input className="action-select form-input" value={l.parameters} onChange={(e) => setLine(idx, 'parameters', e.target.value)} placeholder="e.g. hardness, dims" />
                  </td>
                  <td>
                    <input className="action-select form-input" value={l.rejectionReason} onChange={(e) => setLine(idx, 'rejectionReason', e.target.value)} placeholder="If rejected" />
                  </td>
                  <td>
                    <input className="action-select form-input" value={l.remarks} onChange={(e) => setLine(idx, 'remarks', e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: '10px', fontSize: '12.5px', color: '#64748b' }}>
          Saving with a rejected quantity automatically creates a Rejection Report and notifies the Store Department.
          Status: {totalRejected === 0 ? QC_STATUS.APPROVED : totalAccepted === 0 ? QC_STATUS.REJECTED : QC_STATUS.PARTIAL}
        </p>
        {Array.isArray(receipt?.documents) && receipt.documents.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
            {receipt.documents.map((d) => (
              <button key={d.id} type="button" className="button-secondary button-small" onClick={() => openWorkflowDocument(d)}>
                <FileText size={14} aria-hidden="true" /> {d.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="form-actions">
        <button type="submit" className="button-primary">{existing ? 'Update Inspection' : 'Save Inspection'}</button>
      </div>
    </form>
  );
};

export default QualityCheckPage;
