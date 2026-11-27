import { useMemo, useState, useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Pencil } from 'lucide-react';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterMaterialRecords } from '../utils/historySearch.js';
import { hasPermission } from '../utils/permissions.js';
import {
  getPOByRef,
  getPOProgress,
  createMaterialReceipt,
  updateMaterialReceipt,
  getRejectionReports,
  getRejectionReport,
  getDebitNoteSummaryForRejection,
  getDebitNoteContext,
  forwardRejectionToPurchase,
  sendRejectionToVendor,
  getQualityCheck,
  getQualityCheckForReceipt,
  getUnlinkedQualityCheckForPO,
  getDebitNotesForReceipt,
  postApprovedMaterialToInventory} from '../utils/workflowService.js';
import { saveWorkflowDocument, openWorkflowDocument } from '../utils/workflowFiles.js';
import { generateMaterialReceiptPDF } from '../services/pdfGenerator.js';
import { deleteMaterialReceiptApi, listMaterialReceiptsApi } from '../services/materialReceiptApi.js';
import { listPurchaseOrders } from '../services/procurementIntakeApi.js';
import { flushErpStateSync } from '../services/erpStateSync.js';
import MaterialReceiptMigrationReview from '../components/MaterialReceiptMigrationReview.jsx';

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const num = (v) => Number(v) || 0;

/** Purchase Order PDF that Purchase sent to the Store Department on save. */
const poDocumentsFor = (ref) => {
  if (!ref) return [];
  try {
    const docs = getPOByRef(ref)?.payload?.poDocuments;
    return Array.isArray(docs) ? docs : [];
  } catch {
    return [];
  }
};

/**
 * Line rows for the receipt form in edit mode: the receipt's own quantities are
 * shown against the PO progress *without* this receipt, so "Previously Received"
 * and "Balance" describe the state the pending save will produce. Quantity caps
 * follow the same sources as a new receipt (rejection report → inspection → PO
 * pending), with this receipt's own booking counted back in where the report
 * already includes it.
 */
const buildEditLines = (rec) => {
  const prog = getPOProgress(rec.poNumber, { excludeReceipt: rec.receiptNumber });
  const qcRec = getQualityCheckForReceipt(rec.receiptNumber);
  const report = rec.rejectionNumber ? getRejectionReport(rec.rejectionNumber) : null;
  const match = (rows, it) =>
    (rows || []).find(
      (i) =>
        (it.materialCode && String(i.materialCode || '').toLowerCase() === String(it.materialCode).toLowerCase()) ||
        (!it.materialCode && i.materialName === it.materialName)
    );
  return (rec.items || []).map((it) => {
    const pl = match(prog.lines, it);
    const qcLine = qcRec ? match(qcRec.items, it) : null;
    const reportLine = report ? match(report.items, it) : null;
    const own = num(it.receivedQty);
    const outstanding = reportLine
      ? Math.max(0, num(reportLine.rejectedQty) - num(reportLine.replacementQty)) + own
      : 0;
    const receivedAlready = reportLine
      ? Math.max(0, num(reportLine.replacementQty) - own)
      : pl ? num(pl.originalArrivedQty) : 0;
    const pendingQty = pl ? num(pl.pendingQty) : Math.max(0, num(it.orderedQty) - own);
    const cap = report ? outstanding : qcLine ? num(qcLine.acceptedQty) : pendingQty;
    return {
      materialCode: it.materialCode || '',
      materialName: it.materialName || '',
      unit: it.unit || 'Nos',
      orderedQty: num(it.orderedQty) || (pl ? num(pl.orderedQty) : 0),
      receivedAlready,
      pendingQty,
      outstandingRejected: outstanding,
      replacementReceivedAlready: receivedAlready,
      maxQty: Math.max(cap, own),
      receivedQty: String(own),
      batchNumber: it.batchNumber || '',
      internalBatchId: it.internalBatchId || qcLine?.internalBatchId || reportLine?.internalBatchId || '',
      lotNumber: it.lotNumber || '',
      mfgDate: it.mfgDate || '',
      expiryDate: it.expiryDate || '',
      remarks: it.remarks || ''
    };
  });
};

const MaterialReceiptsPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState('receipts');
  const [openReceipt, setOpenReceipt] = useState(location.state?.openReceipt || null);
  const [creating, setCreating] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState(null);
  const [initialPO, setInitialPO] = useState(location.state?.newReceiptFor || '');
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);
  const [serverReceipts, setServerReceipts] = useState([]);
  const [serverPOs, setServerPOs] = useState([]);
  const [poLoadError, setPoLoadError] = useState('');
  const [receiptsError, setReceiptsError] = useState('');
  const [receiptsLoading, setReceiptsLoading] = useState(true);
  const [receiptSearch, setReceiptSearch] = useState('');
  const [awaitingSearch, setAwaitingSearch] = useState('');
  const [rejectionSearch, setRejectionSearch] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  // Notification / dashboard deep links carry ?po= (open the receipt form for
  // that PO) or ?receipt= (open a recorded receipt). Applied once, then cleared
  // so a reload or "back" does not replay them.
  useEffect(() => {
    const po = searchParams.get('po');
    const rec = searchParams.get('receipt');
    if (!po && !rec) return;
    if (po) {
      setTab('receipts');
      setOpenReceipt(null);
      setInitialPO(po);
      setCreating(true);
    } else {
      setTab('receipts');
      setCreating(false);
      setOpenReceipt(rec);
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Deep links (Purchase Order / Store / Purchase Indents → "record delivery") arrive as
  // route state. Re-apply on every navigation so the form pre-fills even when the user is
  // already on this page.
  useEffect(() => {
    const s = location.state;
    if (!s) return;
    if (s.newReceiptFor) {
      setTab('receipts');
      setOpenReceipt(null);
      setInitialPO(s.newReceiptFor);
      setCreating(true);
    } else if (s.openReceipt) {
      setTab('receipts');
      setCreating(false);
      setOpenReceipt(s.openReceipt);
    }
  }, [location.state]);

  const refreshReceipts = async () => {
    setReceiptsLoading(true);
    try {
      const [records, orders] = await Promise.all([listMaterialReceiptsApi(), listPurchaseOrders()]);
      setServerReceipts(records);
      setServerPOs(orders);
      setPoLoadError('');
      setReceiptsError('');
      return records;
    } catch (error) {
      setServerReceipts([]);
      setReceiptsError(`Material Receipts could not be loaded from PostgreSQL: ${error.message}`);
      throw error;
    } finally { setReceiptsLoading(false); }
  };
  useEffect(() => { refreshReceipts().catch(() => {}); }, []);
  const receipts = useMemo(() => serverReceipts, [serverReceipts, tick]);
  const rejections = useMemo(() => getRejectionReports(), [tick]);
  const canCreate = hasPermission('receipt.create');
  const canViewRejections = hasPermission('rejection.view');
  const isStoreUser = hasPermission('store.module') && !hasPermission('purchase.order');

  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 7000);
  };

  /* Receipts and Purchase Orders are resolved only from PostgreSQL responses;
   * a failed API load is shown as an error, not silently replaced by a cache. */
  const receiptFromServer = (id) => serverReceipts.find((row) => String(row.receiptNumber) === String(id)) || null;
  const receipt = openReceipt ? receiptFromServer(openReceipt) : null;

  // Purchase Orders still awaiting a material receipt (spec: pending > 0, not cancelled/closed)
  const awaitingPOs = useMemo(
    () =>
      serverPOs
        .map((po) => {
          const progress = po.progress && typeof po.progress === 'object' ? po.progress : null;
          if (!progress) return null;
          return { poNumber: po.reference, ...progress, poStatus: po.status };
        })
        .filter((p) => p && p.ordered > 0 && p.pending > 0 && p.poStatus !== 'Cancelled'),
    [serverPOs]
  );

  const createdPOs = useMemo(
    () => serverPOs.map((po) => ({ ...po, progress: po.progress && typeof po.progress === 'object' ? po.progress : null })),
    [serverPOs]
  );
  const searchedReceipts = filterMaterialRecords(receipts, receiptSearch, ['receiptNumber','poNumber','soNumber','vendor','invoiceNumber','receiptDate',(r) => r.receiptType || (r.isReplacement ? 'Replacement' : 'Original'),'qcStatus']);
  const searchedAwaitingPOs = filterMaterialRecords(awaitingPOs, awaitingSearch, ['poNumber','soNumber','vendor','dueDate','status']);
  const searchedRejections = filterMaterialRecords(rejections, rejectionSearch, ['rejectionNumber','poNumber','qcNumber','receiptNumber','vendor','rejectionDate','status']);

  const openPurchaseOrders = () => {
    if (isStoreUser) {
      setTab('purchaseOrders');
      setCreating(false);
      setEditingReceipt(null);
      setOpenReceipt(null);
      return;
    }
    navigate('/purchase-order');
  };

  return (
    <section className={`page-section${isStoreUser ? ' store-screen' : ''}`}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tax Invoice / Material Receipts</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          <button className="button-secondary" onClick={openPurchaseOrders}>Purchase Orders</button>
        </div>
      </div>

      <div className="tab-nav">
        <button type="button" className={`tab-link ${tab === 'receipts' ? 'active' : ''}`} onClick={() => { setTab('receipts'); setCreating(false); setEditingReceipt(null); setOpenReceipt(null); }}>
          Material Receipts ({receipts.length})
        </button>
        <button type="button" className={`tab-link ${tab === 'awaiting' ? 'active' : ''}`} onClick={() => { setTab('awaiting'); setCreating(false); setEditingReceipt(null); setOpenReceipt(null); }}>
          POs Awaiting Material Receipt ({awaitingPOs.length})
        </button>
        {isStoreUser && (
          <button type="button" className={`tab-link ${tab === 'purchaseOrders' ? 'active' : ''}`} onClick={() => { setTab('purchaseOrders'); setCreating(false); setEditingReceipt(null); setOpenReceipt(null); }}>
            Created Purchase Orders ({createdPOs.length})
          </button>
        )}
        {canViewRejections && (
          <button type="button" className={`tab-link ${tab === 'rejections' ? 'active' : ''}`} onClick={() => { setTab('rejections'); setEditingReceipt(null); setOpenReceipt(null); }}>
            Rejection Reports ({rejections.length})
          </button>
        )}
      </div>

      {tab === 'receipts' && <MaterialReceiptMigrationReview onImported={refreshReceipts} />}
      {receiptsLoading && <p role="status">Loading Material Receipts from PostgreSQL…</p>}

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

      {tab === 'purchaseOrders' && isStoreUser && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Created Purchase Orders ({createdPOs.length})</h3>
            <span className="muted-text">Purchase Orders issued by Purchase for Store receipt tracking.</span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>PO Date</th><th>PO Number</th><th>Supplier / Vendor</th><th>Project / SO Ref</th>
                  <th>Due Date</th><th>Total Value</th><th>Status</th><th>Ordered</th><th>Received</th><th>Balance</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {createdPOs.length ? createdPOs.map((po) => {
                  const progress = po.progress;
                  const balance = Number(progress?.pending) || 0;
                  const canReceive = canCreate && balance > 0 && po.status !== 'Cancelled';
                  return (
                    <tr key={po.reference}>
                      <td>{po.date || '—'}</td>
                      <td><strong>{po.reference}</strong></td>
                      <td>{po.vendor || '—'}</td>
                      <td>{po.projectRef || progress?.projectId || '—'}{po.soRef ? ` / ${po.soRef}` : ''}</td>
                      <td>{po.dueDate || '—'}</td>
                      <td>{po.total || '—'}</td>
                      <td>
                        <span className={badgeClass(po.status || progress?.status)}>{po.status || progress?.status || '—'}</span>
                        {progress?.fulfillmentStatus && <div className="muted-text" style={{ marginTop: 4 }}>{progress.fulfillmentStatus}</div>}
                      </td>
                      <td>{progress?.ordered ?? '—'}</td>
                      <td>{progress?.received ?? '—'}</td>
                      <td>{progress ? balance : '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {poDocumentsFor(po.reference).map((document) => (
                            <button key={document.id} type="button" className="button-small" onClick={() => openWorkflowDocument(document)}>PO PDF</button>
                          ))}
                          {canReceive && <button type="button" className="button-small button-primary" onClick={() => { setTab('receipts'); setInitialPO(po.reference); setCreating(true); setEditingReceipt(null); setOpenReceipt(null); }}>Record Receipt</button>}
                        </div>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td colSpan={11} className="no-history-row">No Purchase Orders have been created yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'awaiting' && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Purchase Orders Awaiting Material Receipt ({awaitingPOs.length})</h3>
            {canCreate && (
              <button className="button-primary" onClick={() => { setEditingReceipt(null); setCreating(true); }}>
                + New Tax Invoice / Material Receipt
              </button>
            )}
          </div>
          <RecordSearchBar value={awaitingSearch} onChange={setAwaitingSearch} placeholder="Search PO, SO, Vendor, Due Date, Status..." label="Search purchase orders awaiting receipt" />
          <p style={{ margin: '0 0 16px', color: '#4b5563', fontSize: '13.5px', lineHeight: '1.6' }}>
            Partial deliveries are allowed up to the original PO delivery balance. Replacement quantities are tracked against rejection reports and do not reduce that balance. Fulfillment status updates after inspection; inventory is only updated after Quality approval.
          </p>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Project ID</th>
                  <th>PO No</th>
                  <th>Sales Order</th>
                  <th>Vendor</th>
                  <th>Due Date</th>
                  <th>Ordered</th>
                  <th>Received</th>
                  <th>QC Pending</th>
                  <th>Accepted</th>
                  <th>Rejected</th>
                  <th>Replacement</th>
                  <th>Balance</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {searchedAwaitingPOs.length > 0 ? (
                  searchedAwaitingPOs.map((p) => (
                    <tr key={p.poNumber}>
                      <td>{p.projectId || '—'}</td>
                      <td><strong>{p.poNumber}</strong></td>
                      <td>{p.soNumber || '—'}</td>
                      <td>{p.vendor || '—'}</td>
                      <td>{p.dueDate || '—'}</td>
                      <td style={{ fontWeight: 700, color: '#1d4ed8' }}>{p.ordered}</td>
                      <td style={{ fontWeight: 700, color: '#166534' }}>{p.received}</td>
                      <td>{p.qcPending}</td>
                      <td style={{ color: '#166534' }}>{p.creditedAccepted}</td>
                      <td style={{ color: p.rejected > 0 ? '#b91c1c' : '#9ca3af' }}>{p.rejected}</td>
                      <td style={{ color: p.pendingReplacement > 0 ? '#6b21a8' : '#9ca3af' }}>
                        {p.pendingReplacement > 0
                          ? `${p.replacementArrived} received · ${p.pendingReplacement} pending`
                          : '—'}
                      </td>
                      <td style={{ fontWeight: 700, color: p.pending > 0 ? '#92400e' : '#9ca3af' }}>{p.pending}</td>
                      <td>
                        <span className={badgeClass(p.status)}>{p.status}</span>
                        <div style={{ marginTop: 4, fontSize: 11, color: '#64748b' }}>
                          Fulfillment: {p.fulfillmentStatus}
                        </div>
                      </td>
                      <td>
                        {poDocumentsFor(p.poNumber).map((d) => (
                          <button
                            key={d.id}
                            className="button-small"
                            style={{ color: '#1d4ed8', borderColor: '#bfdbfe', display: 'block', marginBottom: 4 }}
                            onClick={() => openWorkflowDocument(d)}
                            title={`Sent to the Store Department on save — ${d.name}`}
                          >
                            <FileText size={14} aria-hidden="true" /> PO PDF
                          </button>
                        ))}
                        {canCreate && (
                          <button
                            className="button-small"
                            style={{ color: '#16a34a', borderColor: '#bbf7d0' }}
                            onClick={() => { setTab('receipts'); setEditingReceipt(null); setInitialPO(p.poNumber); setCreating(true); }}
                          >
                            Create Tax Invoice / Material Receipt
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="no-history-row">
                      {awaitingPOs.length ? 'No purchase orders match your search.' : 'No Purchase Orders are awaiting delivery. Every PO with ordered material has been fully received and closed.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {receiptsError && <div className="alert alert-error" role="alert">{receiptsError}</div>}
      {poLoadError && <div className="alert alert-error" role="alert">{poLoadError}</div>}
      {tab === 'receipts' &&
        (creating ? (
          <ReceiptForm
            key={editingReceipt ? `edit-${editingReceipt}` : `po-${initialPO}`}
            initialPO={initialPO}
            editing={editingReceipt ? receiptFromServer(editingReceipt) : null}
            onDone={async (receiptNumber) => {
              try { await refreshReceipts(); } catch { return; }
              const wasEditing = Boolean(editingReceipt);
              setCreating(false);
              setEditingReceipt(null);
              setOpenReceipt(receiptNumber);
              flash('ok', wasEditing ? `Receipt ${receiptNumber} updated.` : `Receipt ${receiptNumber} saved.`);
            }}
            onCancel={() => { setCreating(false); setEditingReceipt(null); }}
            onError={(err) => flash('err', err.message)}
          />
        ) : receipt ? (
          <ReceiptDetail
            key={`${receipt.receiptNumber}-${tick}`}
            receipt={receipt}
            onBack={() => { setOpenReceipt(null); setTick((t) => t + 1); }}
            onEdit={(receiptNumber) => {
              setEditingReceipt(receiptNumber);
              setOpenReceipt(null);
              setCreating(true);
            }}
            onDelete={(receiptNumber) => {
              (async () => {
                try {
                  const current = receipts.find((row) => String(row.receiptNumber) === String(receiptNumber));
                  if (!current) throw new Error('Receipt is missing from the current PostgreSQL list. Refresh before deleting.');
                  await deleteMaterialReceiptApi(receiptNumber, current.version || current.recordVersion, 'Deleted by Store');
                  await refreshReceipts();
                  setOpenReceipt(null);
                  setTick((t) => t + 1);
                  flash('ok', `Receipt ${receiptNumber} deleted.`);
                } catch (err) { flash('err', err.message); }
              })();
            }}
            flash={flash}
            canCreate={canCreate}
          />
        ) : (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Receipts ({receipts.length})</h3>
              {canCreate && (
                <button className="button-primary" onClick={() => { setEditingReceipt(null); setCreating(true); }}>+ New Tax Invoice / Material Receipt</button>
              )}
            </div>
            <RecordSearchBar value={receiptSearch} onChange={setReceiptSearch} placeholder="Search receipt, PO, SO, vendor, invoice..." label="Search material receipts" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Receipt No</th>
                    <th>Type</th>
                    <th>Date</th>
                    <th>PO No</th>
                    <th>SO</th>
                    <th>Vendor</th>
                    <th>Invoice No</th>
                    <th>Materials</th>
                    <th>Quality Status</th>
                    <th>Inventory Posted</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {searchedReceipts.length === 0 ? (
                    <tr><td colSpan="11" className="no-history-row">{receipts.length ? 'No material receipts match your search.' : 'No material receipts recorded yet.'}</td></tr>
                  ) : (
                    searchedReceipts.map((r) => (
                      <tr key={r.receiptNumber}>
                        <td><strong>{r.receiptNumber}</strong></td>
                        <td>
                          {r.isReplacement ? (
                            <span className="status-badge st-replacement" title={`Replaces rejected quantity on ${r.rejectionNumber}`}>
                              Replacement
                            </span>
                          ) : (
                            <span className="status-badge st-received">Original</span>
                          )}
                        </td>
                        <td>{r.receiptDate}</td>
                        <td>{r.poNumber}</td>
                        <td>{r.soNumber || '—'}</td>
                        <td>{r.vendor}</td>
                        <td>{r.invoiceNumber}</td>
                        <td>{r.items?.length || 0}</td>
                        <td><span className={badgeClass(r.qcStatus || 'Pending')}>{r.qcStatus || 'Pending Quality Check'}</span></td>
                        <td><span className={badgeClass(r.postedToInventory ? 'Posted' : 'Pending')}>{r.postedToInventory ? 'Posted' : 'Pending'}</span></td>
                        <td>
                          <button className="button-small button-secondary" onClick={() => setOpenReceipt(r.receiptNumber)}>View</button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))}

      {tab === 'rejections' && <RejectionsTab flash={flash} tick={tick} onTick={() => setTick((t) => t + 1)} />}
    </section>
  );
};

/* ------------------------------- receipt form ------------------------------- */

export const ReceiptForm = ({ onDone, onCancel, onError, initialPO = '', editing = null }) => {
  const [formPOs, setFormPOs] = useState([]);
  useEffect(() => {
    let active = true;
    listPurchaseOrders()
      .then((orders) => { if (active) setFormPOs(orders); })
      .catch(() => { if (active) setFormPOs([]); });
    return () => { active = false; };
  }, []);
  const pos = useMemo(
    () => formPOs.filter((p) => !['Cancelled'].includes(p.status)),
    [formPOs]
  );
  const [poNumber, setPoNumber] = useState(editing?.poNumber || '');
  const [invoiceNumber, setInvoiceNumber] = useState(editing?.invoiceNumber || '');
  const [invoiceDate, setInvoiceDate] = useState(editing?.invoiceDate || new Date().toISOString().slice(0, 10));
  const [dcNumber, setDcNumber] = useState(editing?.dcNumber || '');
  const [dcDate, setDcDate] = useState(editing?.dcDate || '');
  const [vehicleNumber, setVehicleNumber] = useState(editing?.vehicleNumber || '');
  const [deliveredBy, setDeliveredBy] = useState(editing?.deliveredBy || '');
  const [contactNumber, setContactNumber] = useState(editing?.contactNumber || '');
  const [transporter, setTransporter] = useState(editing?.transporter || '');
  const [remarks, setRemarks] = useState(editing?.remarks || '');
  const [lines, setLines] = useState(() => (editing ? buildEditLines(editing) : []));
  const [docs, setDocs] = useState(editing?.documents || []);
  const [uploading, setUploading] = useState(false);
  const [linkedQc, setLinkedQc] = useState(() =>
    editing ? getQualityCheckForReceipt(editing.receiptNumber) : null
  );
  const [replacementFor, setReplacementFor] = useState(editing?.rejectionNumber || '');

  // While editing, the receipt's own quantities are excluded from the progress
  // so "Previously Received" / "Balance" describe the state after this save.
  const progress = poNumber
    ? getPOProgress(poNumber, editing ? { excludeReceipt: editing.receiptNumber } : {})
    : null;
  /* PO PDF sent to Store by Purchase when the Purchase Order was saved. */
  const poDocuments = poDocumentsFor(poNumber);

  /* Rejection Reports on this PO that still have rejected quantity to replace. */
  const openRejections = poNumber
    ? getRejectionReports().filter((r) => String(r.poNumber) === String(poNumber) && num(r.pendingReplacementQty) > 0)
    : [];
  const replacementReport = replacementFor
    ? openRejections.find((r) => r.rejectionNumber === replacementFor) || getRejectionReport(replacementFor)
    : null;
  const isReplacement = Boolean(replacementReport);

  /** One row per PO material, with the cap that applies to the selected source. */
  const buildLines = (prog, qc, report) =>
    (prog?.lines || []).map((l) => {
      const matchLine = (rows) =>
        (rows || []).find(
          (i) =>
            (l.materialCode && String(i.materialCode || '').toLowerCase() === String(l.materialCode).toLowerCase()) ||
            (!l.materialCode && i.materialName === l.materialName)
        );
      const reportLine = report ? matchLine(report.items) : null;
      const outstanding = reportLine
        ? Math.max(0, num(reportLine.rejectedQty) - num(reportLine.replacementQty))
        : 0;
      const qcLine = qc ? matchLine(qc.items) : null;
      const passedQty = qcLine ? num(qcLine.acceptedQty) : 0;
      const maxQty = report ? outstanding : qc ? passedQty : l.pendingQty;
      return {
        materialCode: l.materialCode,
        materialName: l.materialName,
        unit: l.unit,
        orderedQty: l.orderedQty,
        receivedAlready: reportLine ? num(reportLine.replacementQty) : l.originalArrivedQty,
        pendingQty: l.pendingQty,
        outstandingRejected: outstanding,
        replacementReceivedAlready: reportLine ? num(reportLine.replacementQty) : 0,
        maxQty,
        receivedQty: report || qc ? (maxQty > 0 ? String(maxQty) : '') : '',
        // Carried forward from the inspection (or from the rejection report's
        // original delivery) so the store confirms rather than re-types it.
        batchNumber: qcLine?.batchNumber || reportLine?.batchNumber || '',
        lotNumber: qcLine?.lotNumber || reportLine?.lotNumber || '',
        mfgDate: '',
        expiryDate: '',
        remarks: ''
      };
    });

  const selectPO = (ref) => {
    setPoNumber(ref);
    setReplacementFor('');
    const prog = getPOProgress(ref);
    // A completed inspection on this PO still waiting for its tax invoice:
    // link the receipt to it and pre-fill the passed quantity.
    const qc = getUnlinkedQualityCheckForPO(ref);
    setLinkedQc(qc);
    setLines(buildLines(prog, qc, null));
  };

  /** Switch between an original delivery and a replacement against a rejection. */
  const selectReplacement = (rejectionNumber) => {
    setReplacementFor(rejectionNumber);
    const report = rejectionNumber ? getRejectionReport(rejectionNumber) : null;
    const qc = report ? null : getUnlinkedQualityCheckForPO(poNumber);
    setLinkedQc(qc);
    setLines(buildLines(progress, qc, report));
  };

  useEffect(() => {
    if (initialPO && !poNumber) selectPO(initialPO);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLine = (idx, field, value) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));

  const handleFiles = async (kind, fileList) => {
    setUploading(true);
    try {
      const added = [];
      for (const file of Array.from(fileList || [])) {
        const meta = await saveWorkflowDocument(file);
        added.push({ ...meta, kind });
      }
      setDocs((prev) => [...prev, ...added]);
    } catch (err) {
      onError(err);
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        const result = await updateMaterialReceipt(editing.receiptNumber, {
          invoiceNumber,
          invoiceDate,
          dcNumber,
          dcDate,
          vehicleNumber,
          deliveredBy,
          contactNumber,
          transporter,
          remarks,
          items: lines,
          documents: docs
        });
        onDone(result.receipt.receiptNumber);
        return;
      }
      const result = await createMaterialReceipt({
        poNumber,
        invoiceNumber,
        invoiceDate,
        dcNumber,
        dcDate,
        vehicleNumber,
        deliveredBy,
        contactNumber,
        transporter,
        remarks,
        items: lines,
        documents: docs,
        linkedQcNumber: linkedQc ? linkedQc.qcNumber : '',
        replacementForRejection: replacementFor
      });
      onDone(result.receipt.receiptNumber);
    } catch (err) {
      onError(err);
    }
  };

  return (
    <form className="quotation-form" onSubmit={submit}>
      {editing && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: '10px',
            marginBottom: '14px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e3a8a',
            fontSize: '13px',
            fontWeight: 600
          }}
        >
          <Pencil size={14} aria-hidden="true" /> Editing receipt {editing.receiptNumber} against PO {editing.poNumber} — the Purchase Order and
          receipt type cannot be changed. Invoice details, received quantity, Batch / Lot, dates and
          documents can be corrected until the material is added to inventory.
        </div>
      )}
      <div className="form-section">
        <div className="section-heading">
          <h3>Receipt Header</h3>
        </div>
        <div className="section-grid">
          <div className="field-group">
            <label>Purchase Order *</label>
            <select
              required
              value={poNumber}
              disabled={Boolean(editing)}
              title={editing ? 'The Purchase Order of a recorded receipt cannot be changed' : ''}
              onChange={(e) => selectPO(e.target.value)}
            >
              <option value="">-- Select PO --</option>
              {pos.map((p) => {
                const prog = getPOProgress(p.reference);
                return (
                  <option key={p.reference} value={p.reference}>
                    {p.reference} — {p.vendor} (Pending {prog.pending}
                    {prog.pendingReplacement > 0 ? ` · Replacement ${prog.pendingReplacement}` : ''})
                  </option>
                );
              })}
            </select>
          </div>
          <div className="field-group">
            <label>Receipt Type *</label>
            <select
              required
              value={replacementFor || 'original'}
              disabled={!poNumber || Boolean(editing)}
              onChange={(e) => selectReplacement(e.target.value === 'original' ? '' : e.target.value)}
            >
              {/* "original" (not "") — a required select whose option has an empty
                  value is treated by the browser as "nothing selected" and blocks
                  the whole form with "Please select an item in the list." */}
              <option value="original">Original delivery</option>
              {openRejections.map((r) => (
                <option key={r.rejectionNumber} value={r.rejectionNumber}>
                  Replacement — {r.rejectionNumber} ({num(r.pendingReplacementQty)} outstanding)
                </option>
              ))}
            </select>
          </div>
          {poDocuments.length > 0 && (
            <div className="field-group">
              <label>Purchase Order Document</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {poDocuments.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="button-secondary button-small"
                    onClick={() => openWorkflowDocument(d)}
                    title={`Sent to the Store Department on save — ${d.name}`}
                  >
                    <FileText size={14} aria-hidden="true" /> {d.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field-group">
            <label>Project ID</label>
            <input readOnly value={(getPOByRef(poNumber) || {}).projectRef || progress?.projectId || '—'} />
          </div>
          <div className="field-group">
            <label>Invoice Number *</label>
            <input required value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Vendor tax invoice no" />
          </div>
          <div className="field-group">
            <label>Invoice Date *</label>
            <input type="date" required value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <div className="field-group">
            <label>DC Number</label>
            <input value={dcNumber} onChange={(e) => setDcNumber(e.target.value)} />
          </div>
          <div className="field-group">
            <label>DC Date</label>
            <input type="date" value={dcDate} onChange={(e) => setDcDate(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Vehicle Details</label>
            <input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="Vehicle / LR no" />
          </div>
        </div>
      </div>

      {isReplacement && replacementReport && (
        <div className="form-section">
          <div className="section-heading">
            <h3>
              Replacement against {replacementReport.rejectionNumber} — ordered quantity on PO {poNumber} is not
              changed
            </h3>
          </div>
          <div className="section-grid">
            <div className="field-group">
              <label>Rejected Quantity</label>
              <input readOnly value={(replacementReport.items || []).reduce((a, i) => a + num(i.rejectedQty), 0)} />
            </div>
            <div className="field-group">
              <label>Still to Replace</label>
              <input readOnly value={num(replacementReport.pendingReplacementQty)} />
            </div>
            <div className="field-group">
              <label>Original Material Receipt</label>
              <input readOnly value={replacementReport.receiptNumber || '—'} />
            </div>
            <div className="field-group">
              <label>Original Quality Check</label>
              <input readOnly value={replacementReport.qcNumber || '—'} />
            </div>
            <div className="field-group">
              <label>Debit Note</label>
              <input readOnly value={(replacementReport.debitNoteNumbers || []).join(', ') || '—'} />
            </div>
            <div className="field-group">
              <label>Vendor</label>
              <input readOnly value={(getPOByRef(poNumber) || {}).vendor || ''} />
            </div>
          </div>
          <p style={{ color: '#92400e', fontSize: '12.5px', fontWeight: 600, marginTop: '10px' }}>
            ⚠ Replacement material is capped by the outstanding rejected quantity, is booked against the same PO and
            is only added to inventory after Quality approves it.
          </p>
        </div>
      )}

      <div className="form-section">
        <div className="section-heading">
          <h3>Supplier / Delivery Details {`(recorded before Quality Check)`}</h3>
        </div>
        <div className="section-grid">
          <div className="field-group">
            <label>Delivered By (supplier person)</label>
            <input value={deliveredBy} onChange={(e) => setDeliveredBy(e.target.value)} placeholder="Name of the person who delivered" />
          </div>
          <div className="field-group">
            <label>Contact Number</label>
            <input value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} placeholder="Mobile / phone" />
          </div>
          <div className="field-group">
            <label>Supplier / Transporter</label>
            <input value={transporter} onChange={(e) => setTransporter(e.target.value)} placeholder="Supplier firm or transporter" />
          </div>
          <div className="field-group full-width">
            <label>Remarks</label>
            <textarea rows="2" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </div>
      </div>

      {!progress && (
        <div className="form-section">
          <div className="section-heading">
            <h3>Material Lines — Batch No &amp; Lot No</h3>
          </div>
          <p style={{ margin: '0', fontSize: '13px', color: '#475569', lineHeight: 1.6 }}>
            Select a <strong>Purchase Order</strong> above to list the materials being received. Each line then shows{' '}
            <strong>Receive Now</strong>, <strong>Batch No</strong> and a manual <strong>Lot No</strong> box
            (highlighted amber), followed by Mfg Date and Expiry Date. The Batch / Lot you type here is printed on
            the receipt and carried into Quality Check, the stock ledger and the Store Issue slip.
          </p>
        </div>
      )}

      {progress && (
        <div className="form-section">
          <div className="section-heading">
            <h3>
              {isReplacement ? `Replacement Receipt — ${replacementReport.rejectionNumber}` : `PO ${progress.poNumber}`} —
              Ordered Quantity {progress.ordered} | Physical Receipt Balance {progress.physicalReceiptBalance} | Accepted Quantity Shortage {progress.acceptedQuantityShortage}
              {progress.openRejected > 0 ? ` | Unresolved Rejected ${progress.openRejected}` : ''}
              {!isReplacement && (progress.status === 'Fully Received' ? ' — Fully Received' : progress.status === 'Received / Awaiting QC' ? ' — Awaiting Quality Check' : '')}
            </h3>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Material</th>
                  <th>Unit</th>
                  <th>PO Qty</th>
                  <th>{isReplacement ? 'Previously Replaced' : 'Previously Received'}</th>
                  <th>Receive Now</th>
                  <th>Batch No</th>
                  <th>Lot No</th>
                  <th>{isReplacement ? 'Total Replacement Received' : 'Total Received'}</th>
                  <th>{isReplacement ? 'Rejected Balance' : 'Balance Qty'}</th>
                  <th>Mfg Date</th>
                  <th>Expiry Date</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const current = num(l.receivedQty);
                  const totalReceived = isReplacement
                    ? num(l.replacementReceivedAlready) + current
                    : num(l.receivedAlready) + current;
                  const balance = Math.max(
                    0,
                    isReplacement ? num(l.outstandingRejected) - current : num(l.pendingQty) - current
                  );
                  return (
                    <tr key={`${l.materialCode}-${idx}`}>
                      <td>{idx + 1}</td>
                      <td>
                        {l.materialName}
                        {isReplacement && num(l.outstandingRejected) === 0 && (
                          <span className="muted-text"> (nothing outstanding)</span>
                        )}
                      </td>
                      <td>{l.unit}</td>
                      <td>{num(l.orderedQty)}</td>
                      <td>{num(l.receivedAlready)}</td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          max={num(l.maxQty)}
                          className="action-select form-input"
                          value={l.receivedQty}
                          placeholder={`max ${num(l.maxQty)}`}
                          onChange={(e) => setLine(idx, 'receivedQty', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="action-select form-input"
                          value={l.batchNumber}
                          onChange={(e) => setLine(idx, 'batchNumber', e.target.value)}
                          placeholder="Batch No"
                        />
                      </td>
                      <td>
                        <input
                          className="action-select form-input"
                          value={l.lotNumber}
                          onChange={(e) => setLine(idx, 'lotNumber', e.target.value)}
                          placeholder="Lot No (manual)"
                          style={{ background: '#fffbeb', borderColor: '#fcd34d' }}
                          title="Lot / heat lot number as printed on the supplier's label — printed on the receipt, carried to QC, inventory and the issue slip"
                        />
                      </td>
                      <td>
                        <strong>{totalReceived}</strong>
                      </td>
                      <td>
                        <strong style={{ color: balance > 0 ? '#b91c1c' : '#166534' }}>{balance}</strong>
                      </td>
                      <td>
                        <input
                          type="date"
                          className="action-select form-input"
                          value={l.mfgDate || ''}
                          onChange={(e) => {
                            setLine(idx, 'mfgDate', e.target.value);
                            // Shelf-life-managed items: suggest expiry = Mfg date + item's
                            // standard shelf life (the operator can still override it).
                            try {
                              const inv = JSON.parse(localStorage.getItem('inventoryItems') || '[]');
                              const item = (Array.isArray(inv) ? inv : []).find(
                                (it) =>
                                  l.materialCode &&
                                  String(it.itemCode || '').toLowerCase() === String(l.materialCode).toLowerCase()
                              );
                              const months = Number(item?.shelfLifeMonths) || 0;
                              if (e.target.value && months > 0 && !l.expiryDate) {
                                const d = new Date(`${e.target.value}T00:00:00`);
                                d.setMonth(d.getMonth() + months);
                                setLine(idx, 'expiryDate', d.toISOString().slice(0, 10));
                              }
                            } catch {
                              /* no item master data — manual entry only */
                            }
                          }}
                          title="Manufacturing date (from the supplier's label)"
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          className="action-select form-input"
                          value={l.expiryDate || ''}
                          onChange={(e) => setLine(idx, 'expiryDate', e.target.value)}
                          title="Expiry date (from the supplier's label) — expired material is refused"
                        />
                        {l.expiryDate && (
                          <div
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              marginTop: '3px',
                              color:
                                new Date(`${l.expiryDate}T23:59:59`) < new Date()
                                  ? '#b91c1c'
                                  : Math.ceil((new Date(`${l.expiryDate}T23:59:59`) - new Date()) / 86400000) <= 30
                                    ? '#b45309'
                                    : '#15803d'
                            }}
                          >
                            {new Date(`${l.expiryDate}T23:59:59`) < new Date()
                              ? 'EXPIRED — will be refused'
                              : `${Math.ceil((new Date(`${l.expiryDate}T23:59:59`) - new Date()) / 86400000)} day(s) left`}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="form-section">
        <div className="section-heading">
          <h3>Documents {uploading ? '(uploading…)' : ''}</h3>
        </div>
        <div className="section-grid">
          <div className="field-group">
            <label>Tax Invoice file</label>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => handleFiles('Tax Invoice', e.target.files)} />
          </div>
          <div className="field-group">
            <label>Delivery Challan (DC) file</label>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => handleFiles('Delivery Challan', e.target.files)} />
          </div>
          <div className="field-group">
            <label>Supporting documents</label>
            <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => handleFiles('Supporting Document', e.target.files)} />
          </div>
        </div>
        {docs.length > 0 && (
          <ul style={{ marginTop: '10px', fontSize: '13px' }}>
            {docs.map((d) => (
              <li key={d.id}>{d.kind}: {d.name} ({Math.max(1, Math.round((d.size || 0) / 1024))} KB)</li>
            ))}
          </ul>
        )}
        {docs.length === 0 && poNumber && (
          <p style={{ color: '#92400e', fontSize: '12.5px', fontWeight: 600, marginTop: '10px' }}>
            ⚠ No invoice/DC document attached — the receipt will be flagged as missing documents.
          </p>
        )}
      </div>

      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="button-primary">
          {editing
            ? 'Save Changes'
            : isReplacement
              ? 'Save Replacement Receipt'
              : 'Save Material Receipt'}
        </button>
      </div>
    </form>
  );
};

/* ------------------------------ receipt detail ------------------------------ */

const ReceiptDetail = ({ receipt, onBack, onEdit, onDelete, flash, canCreate }) => {
  const navigate = useNavigate();
  const progress = getPOProgress(receipt.poNumber);
  const qc = getQualityCheckForReceipt(receipt.receiptNumber);
  const receiptDebitNotes = getDebitNotesForReceipt(receipt.receiptNumber);
  const canPost = canCreate && qc && !receipt.postedToInventory && num(qc.items?.reduce((a, i) => a + num(i.acceptedQty), 0)) > 0;

  /* A receipt that downstream teams already depend on is never edited or
     removed — the lock says exactly which document holds it. */
  const lockReason = receipt.postedToInventory || receipt.inventoryPosted
    ? 'Added to inventory — this receipt can no longer be edited or deleted'
    : String(receipt.supplierInvoiceNumber || '').trim()
      ? `Supplier Invoice ${receipt.supplierInvoiceNumber} recorded by Purchase — void it with Purchase first`
      : receiptDebitNotes.length > 0
        ? `Debit Note ${receiptDebitNotes.map((d) => d.debitNoteNumber).join(', ')} depends on this receipt — cancel it first`
        : '';
  const locked = Boolean(lockReason);

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete receipt ${receipt.receiptNumber}?\n\nThis removes the tax invoice record for PO ${receipt.poNumber} (invoice ${receipt.invoiceNumber || '—'}) and cannot be undone.`
      )
    )
      return;
    onDelete(receipt.receiptNumber);
  };

  return (
    <div>
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Receipt {receipt.receiptNumber}</h3>
          <span className={badgeClass(receipt.qcStatus || 'Pending')}>{receipt.qcStatus || 'Pending Quality Check'}</span>
          {receipt.isReplacement && (
            <span className="status-badge st-replacement">Replacement Receipt</span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '8px', flexWrap: 'wrap' }}>
            {canCreate && (
              <button
                type="button"
                className="button-secondary button-small"
                disabled={locked}
                title={locked || 'Correct the invoice, material lines, Batch / Lot and documents'}
                onClick={() => onEdit(receipt.receiptNumber)}
              >
                <Pencil size={14} aria-hidden="true" /> Edit
              </button>
            )}
            {canCreate && (
              <button
                type="button"
                className="button-secondary button-small"
                disabled={locked}
                title={locked || 'Delete this receipt (it is not yet in inventory)'}
                style={{ color: '#b91c1c', borderColor: '#fecaca' }}
                onClick={handleDelete}
              >
                🗑 Delete
              </button>
            )}
            <button
              type="button"
              className="button-secondary button-small"
              title="Open the formatted Material Receipt / Tax Invoice report for printing"
              onClick={() => generateMaterialReceiptPDF(receipt, { print: true })}
            >
              🖨 Print / View PDF
            </button>
            <button
              type="button"
              className="button-secondary button-small"
              title="Download the formatted Material Receipt / Tax Invoice report (PDF)"
              onClick={() => generateMaterialReceiptPDF(receipt)}
            >
              ⬇ Download PDF
            </button>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div><strong>PO Number:</strong> {receipt.poNumber}</div>
          <div><strong>Indent:</strong> {receipt.indentNumber || '—'}</div>
          <div><strong>Sales Order:</strong> {receipt.soNumber || '—'}</div>
          <div><strong>Vendor:</strong> {receipt.vendor}</div>
          <div><strong>Invoice No:</strong> {receipt.invoiceNumber}</div>
          <div><strong>Invoice Date:</strong> {receipt.invoiceDate}</div>
          <div>
            <strong>Invoice shared with:</strong>{' '}
            {receipt.invoiceSharedAt
              ? `Quality & Purchase · ${receipt.invoiceSharedAt}`
              : 'Quality & Purchase'}
          </div>
          <div>
            <strong>Supplier Invoice:</strong>{' '}
            {receipt.supplierInvoiceNumber || <span className="status-badge st-pending-store">Not recorded</span>}
          </div>
          <div><strong>Quality Check:</strong> {receipt.qcNumber || '—'}</div>
          <div><strong>DC No / Date:</strong> {receipt.dcNumber || '—'} {receipt.dcDate || ''}</div>
          <div><strong>Vehicle:</strong> {receipt.vehicleNumber || '—'}</div>
          <div><strong>Delivered By:</strong> {receipt.deliveredBy || '—'}</div>
          <div><strong>Contact:</strong> {receipt.contactNumber || '—'}</div>
          <div><strong>Supplier / Transporter:</strong> {receipt.transporter || '—'}</div>
          <div><strong>Entered By:</strong> {receipt.createdBy} · {receipt.createdAt}</div>
        </div>

      {receipt.isReplacement && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: '10px',
            marginBottom: '16px',
            background: '#fef3c7',
            border: '1px solid #fcd34d',
            color: '#92400e',
            fontSize: '13px',
            fontWeight: 600
          }}
        >
          Replacement delivery booked against the same PO — the ordered quantity is unchanged.
          {' '}Rejection Report {receipt.rejectionNumber || '—'}
          {' '}· Original receipt {receipt.originalReceiptNumber || '—'}
          {' '}· Original inspection {receipt.originalQcNumber || '—'}
          {' '}· Debit Note {receipt.debitNoteNumber || '—'}.
          {' '}Only the quantity Quality approves is added to inventory.
        </div>
      )}
      {qc && (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: '10px',
            marginBottom: '16px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e3a8a',
            fontSize: '13px',
            fontWeight: 600
          }}
        >
          Quality Check {qc.qcNumber} for PO {qc.poNumber} is completed —{' '}
          {qc.status}. Passed{' '}
          {num(qc.items.reduce((a, i) => a + num(i.acceptedQty), 0))} | Rejected{' '}
          {num(qc.items.reduce((a, i) => a + num(i.rejectedQty), 0))}. The tax invoice number, DC, vehicle and
          documents entered here are stored on the material receipt linked to {qc.qcNumber}, and only the passed
          quantity can be received.
        </div>
      )}

      {receiptDebitNotes.length > 0 && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Debit Notes (read-only)</h3>
            <span className="muted-text">Rejected material claimed from the vendor</span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Debit Note</th>
                  <th>Date</th>
                  <th>Rejection Report</th>
                  <th>Qty</th>
                  <th>Debit Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {receiptDebitNotes.map((d) => (
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
                    <td>
                      <strong>₹{num(d.grandTotal).toFixed(2)}</strong>
                    </td>
                    <td>
                      <span className={badgeClass(d.status)}>{d.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: '10px', color: '#475569', fontSize: '12.5px' }}>
            This receipt is unchanged by the Debit Note — rejected quantity was never added to inventory and the
            stored invoice, DC and vehicle details remain exactly as entered.
          </p>
        </div>
      )}

      {progress && (
          <p style={{ marginTop: '10px', fontWeight: 700 }}>
            PO {progress.poNumber}: Ordered Quantity {progress.ordered} | Original Received {progress.originalArrived} | Original Accepted {progress.originalAccepted} | Rejected {progress.rejected} | Replacement Received {progress.replacementArrived} | Replacement Accepted {progress.replacementAccepted} | Total Accepted {progress.totalAccepted} | Physical Receipt Balance {progress.physicalReceiptBalance} | Accepted Quantity Shortage {progress.acceptedQuantityShortage} | QC Pending {progress.qcPending}
            {progress.status === 'Fully Received' ? ' — Fully Received' : ''}
          </p>
        )}
        {receipt.remarks && <p style={{ marginTop: '6px' }}><strong>Remarks:</strong> {receipt.remarks}</p>}
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Materials</h3>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th><th>Material</th><th>Unit</th><th>Ordered</th><th>Received Now</th><th>Batch No</th><th>Lot No</th><th>Expiry</th><th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((it, idx) => (
                <tr key={idx}>
                  <td>{idx + 1}</td>
                  <td>{it.materialName}</td>
                  <td>{it.unit}</td>
                  <td>{num(it.orderedQty)}</td>
                  <td><strong>{num(it.receivedQty)}</strong></td>
                  <td>{it.batchNumber || '—'}</td>
                  <td>{it.lotNumber || '—'}</td>
                  <td>
                    {it.expiryDate ? (
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '11.5px',
                          color:
                            new Date(`${it.expiryDate}T23:59:59`) < new Date()
                              ? '#b91c1c'
                              : Math.ceil((new Date(`${it.expiryDate}T23:59:59`) - new Date()) / 86400000) <= 30
                                ? '#b45309'
                                : '#15803d'
                        }}
                      >
                        {it.expiryDate}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{it.remarks || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Documents</h3>
          {receipt.documents?.length ? (
            <span className={badgeClass('Attached')}>{receipt.documents.length} file(s)</span>
          ) : (
            <span className={badgeClass('Missing')}>Missing documents</span>
          )}
        </div>
        {receipt.documents?.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {receipt.documents.map((d) => (
              <button key={d.id} type="button" className="button-secondary button-small" onClick={() => openWorkflowDocument(d)}>
                <FileText size={14} aria-hidden="true" /> {d.kind}: {d.name}
              </button>
            ))}
          </div>
        ) : (
          <p style={{ color: '#92400e', fontSize: '13px', fontWeight: 600 }}>
            ⚠ No Tax Invoice / DC uploaded for this receipt.
          </p>
        )}
      </div>

      {qc && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Quality Check {qc.qcNumber}</h3>
            <span className={badgeClass(qc.status)}>{qc.status}</span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr><th>SL.No</th><th>Material</th><th>Received</th><th>Accepted</th><th>Rejected</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {qc.items.map((it, idx) => (
                  <tr key={idx}>
                    <td>{idx + 1}</td>
                    <td>{it.materialName}</td>
                    <td>{num(it.receivedQty)}</td>
                    <td style={{ color: '#166534', fontWeight: 700 }}>{num(it.acceptedQty)}</td>
                    <td style={{ color: num(it.rejectedQty) > 0 ? '#b91c1c' : 'inherit', fontWeight: 700 }}>{num(it.rejectedQty)}</td>
                    <td>{it.rejectionReason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            {canPost && (
              <button
                className="button-primary"
                style={{ background: '#16a34a' }}
                onClick={async () => {
                  try {
                    /* postApprovedMaterialToInventory returns the server
                     * confirmation: only then is the success message truthful. */
                    const res = await postApprovedMaterialToInventory(qc.qcNumber);
                    flash('ok', res.duplicate
                      ? 'Approved material was already posted to inventory.'
                      : `${res.movements?.length || 0} material line(s) added to inventory.`);
                  } catch (err) {
                    flash('err', err.message);
                  }
                }}
              >
                Confirm Approved Material into Inventory
              </button>
            )}
            {receipt.postedToInventory && <span className={badgeClass('Posted')}>Added to Inventory</span>}
          </div>
        </div>
      )}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">History</h3>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead><tr><th>Date / Time</th><th>User</th><th>Department</th><th>Action</th></tr></thead>
            <tbody>
              {(receipt.history || []).slice().reverse().map((h, idx) => (
                <tr key={idx}><td>{h.at}</td><td>{h.name}</td><td>{h.dept}</td><td>{h.action} — {h.details}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="button-secondary" onClick={onBack}>← Back to Receipts</button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------ rejections tab ------------------------------ */

const RejectionsTab = ({ flash, tick, onTick }) => {
  const navigate = useNavigate();
  const [openNo, setOpenNo] = useState(null);
  const [search, setSearch] = useState('');
  const reports = useMemo(() => getRejectionReports(), [tick]);
  const filteredReports = filterMaterialRecords(reports, search, ['rejectionNumber','rejectionDate','poNumber','qcNumber','receiptNumber','vendor','status']);
  const report = openNo ? getRejectionReport(openNo) : null;

  const [dcNumber, setDcNumber] = useState('');
  const [dcDate, setDcDate] = useState('');
  const [forwardRemarks, setForwardRemarks] = useState('');
  const [vendorRemarks, setVendorRemarks] = useState('');

  if (report) {
    const canForward = hasPermission('rejection.forward') && ['Raised', 'With Store'].includes(report.status);
    const canSendVendor =
      hasPermission('indent.review') && ['Forwarded to Purchase', 'With Store'].includes(report.status);
    const dnSummary = getDebitNoteSummaryForRejection(report.rejectionNumber);
    const dnContext = getDebitNoteContext(report.rejectionNumber);
    const canDebit = Boolean(
      dnContext && dnContext.hasSource && dnContext.totalRemainingQty > 0 && hasPermission('debitnote.create')
    );
    const rejectedQtyAll = report.items.reduce((a, i) => a + num(i.rejectedQty), 0);
    const replQty = report.items.reduce((a, i) => a + num(i.replacementQty), 0);
    const pendingRepl = Math.max(0, rejectedQtyAll - replQty);
    return (
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Rejection Report {report.rejectionNumber}</h3>
          <span className={badgeClass(report.status)}>{report.status}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div><strong>QC No:</strong> {report.qcNumber}</div>
          <div><strong>Receipt:</strong> {report.receiptNumber}</div>
          <div><strong>PO:</strong> {report.poNumber}</div>
          <div><strong>Sales Order:</strong> {report.soNumber || '—'}</div>
          <div><strong>Vendor:</strong> {report.vendor || '—'}</div>
          <div><strong>Inspector:</strong> {report.inspector} · {report.inspectionDate}</div>
          <div><strong>DC:</strong> {report.dcNumber || '—'} {report.dcDate || ''}</div>
          <div>
            <strong>Replacement:</strong>{' '}
            {pendingRepl > 0
              ? `${replQty} of ${rejectedQtyAll} replaced · ${pendingRepl} still outstanding`
              : replQty > 0
                ? `All ${replQty} units replaced${report.replacementReceiptNumber ? ` (${report.replacementReceiptNumber})` : ''}`
                : 'Not replaced yet'}
          </div>
          <div><strong>Quality remarks:</strong> {report.qualityRemarks || '—'}</div>
        </div>

        <div
          style={{
            padding: '12px 14px',
            borderRadius: '10px',
            marginTop: '14px',
            background: '#fffbeb',
            border: '1px solid #fde68a',
            color: '#92400e',
            fontSize: '13px'
          }}
        >
          <strong>Debit Note:</strong>{' '}
          {dnContext && dnContext.totalRemainingQty > 0
            ? `Rejected ${num(dnContext.totalRejectedQty)} · Already debited ${num(dnContext.totalDebitedQty)} · Available to claim ${num(dnContext.totalRemainingQty)}`
            : dnSummary.count > 0
              ? 'All rejected quantity on this report has been debited.'
              : 'No rejected quantity available to debit.'}
          {dnSummary.count > 0 && (
            <div style={{ marginTop: '6px' }}>
              Issued: {dnSummary.numbers.join(', ')} · {num(dnSummary.committedQty)} qty · ₹
              {num(dnSummary.committedValue).toFixed(2)}
            </div>
          )}
          {dnContext && !dnContext.hasSource && (
            <div style={{ marginTop: '6px', fontWeight: 600, color: '#b91c1c' }}>
              A Debit Note requires the Material Arrival (or a material receipt / tax invoice) for this rejection first.
            </div>
          )}
        </div>

        <div className="history-table-wrapper" style={{ marginTop: '14px' }}>
          <table className="history-table">
            <thead>
              <tr><th>SL.No</th><th>Material</th><th>Received Qty</th><th>Rejected Qty</th><th>Reason</th><th>Remarks</th></tr>
            </thead>
            <tbody>
              {report.items.map((it, idx) => (
                <tr key={idx}>
                  <td>{idx + 1}</td>
                  <td><strong>{it.materialName}</strong></td>
                  <td>{num(it.receivedQty)}</td>
                  <td style={{ color: '#b91c1c', fontWeight: 700 }}>{num(it.rejectedQty)}</td>
                  <td>{it.reason}</td>
                  <td>{it.remarks || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {(report.documents || []).map((d) => (
            <button key={d.id} type="button" className="button-secondary button-small" onClick={() => openWorkflowDocument(d)}>
              <FileText size={14} aria-hidden="true" /> {d.name}
            </button>
          ))}
        </div>

        {canForward && (
          <div className="section-grid" style={{ marginTop: '16px' }}>
            <div className="field-group">
              <label>Delivery Challan (DC) Number</label>
              <input value={dcNumber} onChange={(e) => setDcNumber(e.target.value)} placeholder="DC no for returning rejected material" />
            </div>
            <div className="field-group">
              <label>DC Date</label>
              <input type="date" value={dcDate} onChange={(e) => setDcDate(e.target.value)} />
            </div>
            <div className="field-group full-width">
              <label>Store remarks</label>
              <input value={forwardRemarks} onChange={(e) => setForwardRemarks(e.target.value)} />
            </div>
          </div>
        )}
        {canSendVendor && (
          <div className="section-grid" style={{ marginTop: '10px' }}>
            <div className="field-group full-width">
              <label>Vendor communication remarks</label>
              <input value={vendorRemarks} onChange={(e) => setVendorRemarks(e.target.value)} />
            </div>
          </div>
        )}

        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          <button className="button-secondary" onClick={() => setOpenNo(null)}>← Back</button>
          {canForward && (
            <button
              className="button-primary"
              onClick={async () => {
                try {
                  forwardRejectionToPurchase(report.rejectionNumber, { dcNumber, dcDate, forwardRemarks });
                  /* The report is stored through the PostgreSQL state mirror:
                   * wait for the server confirmation before reporting success. */
                  const synced = await flushErpStateSync();
                  if (!synced.ok) throw new Error(synced.error || 'The server has not confirmed this change yet.');
                  flash('ok', 'Rejection Report + DC forwarded to Purchase.');
                  onTick();
                } catch (err) {
                  flash('err', err.message);
                }
              }}
            >
              Forward Rejection + DC to Purchase
            </button>
          )}
          {canSendVendor && (
            <button
              className="button-primary"
              style={{ background: '#b45309' }}
              onClick={async () => {
                try {
                  sendRejectionToVendor(report.rejectionNumber, { vendorRemarks });
                  const synced = await flushErpStateSync();
                  if (!synced.ok) throw new Error(synced.error || 'The server has not confirmed this change yet.');
                  flash('ok', 'Rejection documents sent to vendor.');
                  onTick();
                } catch (err) {
                  flash('err', err.message);
                }
              }}
            >
              Send Rejection Report to Vendor
            </button>
          )}
          <button className="button-secondary" onClick={() => navigate('/quality-checks')}>
            Open Quality Check {report.qcNumber}
          </button>
          {canDebit && (
            <button
              className="button-primary"
              style={{ background: '#b45309' }}
              title="Claim credit from the vendor for the rejected material on this report"
              onClick={() => navigate('/debit-notes', { state: { newDebitNoteFor: report.rejectionNumber } })}
            >
              Create Debit Note
            </button>
          )}
          {dnSummary.count > 0 && (
            <button
              className="button-secondary"
              onClick={() => navigate('/debit-notes', { state: { openDebitNote: dnSummary.numbers[0] } })}
            >
              View Debit Note {dnSummary.numbers[0]}
            </button>
          )}
        </div>

        <div className="history-table-wrapper" style={{ marginTop: '16px' }}>
          <table className="history-table">
            <thead><tr><th>Date / Time</th><th>User</th><th>Department</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {(report.history || []).slice().reverse().map((h, idx) => (
                <tr key={idx}><td>{h.at}</td><td>{h.name}</td><td>{h.dept}</td><td>{h.action}</td><td>{h.details || '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">Rejection Reports ({reports.length})</h3>
        <span className="muted-text">Quality Check → Rejection Report → Store → Purchase → Vendor</span>
      </div>
      <RecordSearchBar value={search} onChange={setSearch} placeholder="Search rejection report, PO, QC, receipt, vendor..." label="Search rejection reports" />
      <div className="history-table-wrapper">
        <table className="history-table">
            <thead>
              <tr>
                <th>Report No</th><th>Date</th><th>QC No</th><th>Receipt</th><th>PO</th><th>Vendor</th><th>Rejected Qty</th><th>Debited Qty</th><th>Debit Note</th><th>Replacement</th><th>Status</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredReports.length === 0 ? (
                <tr><td colSpan="12" className="no-history-row">{reports.length ? 'No rejection reports match your search.' : 'No rejection reports yet.'}</td></tr>
              ) : (
                filteredReports.map((r) => {
                  const dn = getDebitNoteSummaryForRejection(r.rejectionNumber);
                  const rejectedQty = r.items.reduce((a, i) => a + num(i.rejectedQty), 0);
                  const replacementQty = r.items.reduce((a, i) => a + num(i.replacementQty), 0);
                  const pendingReplacement = Math.max(0, rejectedQty - replacementQty);
                  return (
                    <tr key={r.rejectionNumber}>
                      <td><strong>{r.rejectionNumber}</strong></td>
                      <td>{r.rejectionDate}</td>
                      <td>{r.qcNumber}</td>
                      <td>{r.receiptNumber}</td>
                      <td>{r.poNumber}</td>
                      <td>{r.vendor || '—'}</td>
                      <td style={{ color: '#b91c1c', fontWeight: 700 }}>{rejectedQty}</td>
                      <td>{num(dn.committedQty)}</td>
                      <td>
                        {dn.count > 0 ? (
                          <button
                            className="button-small button-secondary"
                            onClick={() => navigate('/debit-notes', { state: { openDebitNote: dn.numbers[0] } })}
                          >
                            {dn.numbers.join(', ')}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {pendingReplacement > 0 ? (
                          <span className="status-badge st-replacement">
                            {replacementQty} received · {pendingReplacement} pending
                          </span>
                        ) : replacementQty > 0 ? (
                          <span className="status-badge st-approved">Replaced ({replacementQty})</span>
                        ) : (
                          <span className="status-badge st-draft">Not replaced</span>
                        )}
                        {r.replacementReceiptNumber && (
                          <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
                            {r.replacementReceiptNumber}
                          </div>
                        )}
                      </td>
                      <td><span className={badgeClass(r.status)}>{r.status}</span></td>
                      <td><button className="button-small button-secondary" onClick={() => setOpenNo(r.rejectionNumber)}>Open</button></td>
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

export default MaterialReceiptsPage;
