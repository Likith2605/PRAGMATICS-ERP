import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import { generatePurchaseIndentPDF } from '../services/pdfGenerator.js';
import { getCurrentUserInfo, hasPermission, isAdmin } from '../utils/permissions.js';
import {
  getIndents,
  getIndent,
  getPOByRef,
  getPOProgress,
  canEditIndent,
  canSubmitIndent,
  updatePurchaseIndent,
  submitPurchaseIndent,
  startPurchaseIndentReview,
  approveIndentByAdmin,
  cancelIndent,
  sendIndentToQualityCheck,
  getQualityCheckForIndent,
  getQualityCheckForReceipt,
  getReceiptsForPO,
  getRejectionReportsForIndent,
  getDebitNoteContext,
  getDebitNoteSummaryForRejection,
  getDebitNotes,
  getProcurementChainForIndent,
  DEBIT_NOTE_STATUS,
  createRepurchaseIndent,
  postApprovedMaterialToInventory,
  getSalesOrderByRef,
  INDENT_STATUS,
  INDENT_QC_STATUS
} from '../utils/workflowService.js';

/**
 * Store Department staff don't raise vendor enquiries from this menu — the
 * Purchase department does. (There is no isStore() in this module; calling one
 * here used to throw "isStore is not defined" and blank the action menu.)
 */
const isStoreUser = () => {
  const info = getCurrentUserInfo();
  return String(info.employee?.department || '').trim() === 'Store Department';
};

/** Error boundary wrapper for IndentDetail to prevent blank screen */
const IndentDetailSafe = ({ children, fallback }) => {
  const [hasError, setHasError] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handleError = (event) => {
      if (event.target === window || event.target.closest('.page-section')) {
        setHasError(true);
        setError(event.error || new Error(event.message || 'Unknown error'));
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 className="page-title">Error Loading Details</h1>
            <p className="page-description">
              {error?.message || 'An unexpected error occurred while loading the Purchase Indent details.'}
            </p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={() => window.location.reload()}>
              Reload Page
            </button>
          </div>
        </div>
        <div className="content-block">
          <div className="empty-state">
            <div className="empty-state-icon">⚠</div>
            <h3>Unable to Load Purchase Indent Details</h3>
            <p>{error?.message || 'Please try refreshing the page or contact support if the issue persists.'}</p>
          </div>
        </div>
      </section>
    );
  }

  return children;
};

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const num = (v) => Number(v) || 0;

/** Rejection reports of an indent that still need a repurchase. */
const pendingRepurchaseFor = (indentNumber) =>
  getRejectionReportsForIndent(indentNumber).filter(
    (r) => !r.repurchaseIndentNumber && (r.items || []).some((i) => num(i.rejectedQty) > 0)
  );

/** Debit Note entry state for a Quality Check: only rejected material can be claimed. */
const debitNoteStateFor = (qc) => {
  try {
    const rejectedQty = num((qc?.items || []).reduce((a, i) => a + num(i.rejectedQty), 0));
    if (!qc || rejectedQty <= 0) return { canCreate: false, context: null };
    const rejection = getRejectionReportsForIndent(qc.indentNumber || '').find(
      (r) => String(r.qcNumber) === String(qc.qcNumber)
    );
    if (!rejection) return { canCreate: false, context: null };
    const context = getDebitNoteContext(rejection.rejectionNumber);
    if (!context || !context.lines.length) return { canCreate: false, context: null };
    return {
      // A Debit Note is a claim against the delivery that brought the rejected
      // material: the Material Arrival (current flow) or a legacy tax invoice /
      // material receipt. Without either source it cannot be raised.
      canCreate: context.totalRemainingQty > 0 && context.hasSource,
      awaitingReceipt: context.totalRemainingQty > 0 && !context.hasSource,
      context,
      fullyDebited: context.fullyDebited,
      summary: getDebitNoteSummaryForRejection(rejection.rejectionNumber)
    };
  } catch (err) {
    console.error('Error in debitNoteStateFor:', err);
    return { canCreate: false, context: null, fullyDebited: false, awaitingReceipt: false, summary: null };
  }
};

const PurchaseIndentsPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [openIndent, setOpenIndent] = useState(
    searchParams.get('indent') || location.state?.openIndent || null
  );
  const [statusFilter, setStatusFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);
  const [actionMenu, setActionMenu] = useState(null);

  /* Notifications deep-link with /purchase-indents?indent=IND-xxxx */
  useEffect(() => {
    const wanted = searchParams.get('indent') || location.state?.openIndent || null;
    if (wanted) {
      setOpenIndent(wanted);
      setMessage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, location.state]);

  const info = getCurrentUserInfo();
  const userDept = info.employee?.department || '';
  // Hidden for anyone working under the Production Department (admin login still sees everything).
  const isAdminAccount = info.auth?.roleKey === 'admin' || info.auth?.role === 'Administrator';
  const productionOnly = userDept === 'Production Department' && !isAdminAccount;
  const indents = useMemo(() => getIndents(), [tick]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return indents.filter((i) => {
      if (statusFilter !== 'All' && i.status !== statusFilter) return false;
      if (!q) return true;
      return [i.indentNumber, i.soNumber, i.customer, i.poNumber, i.createdBy, i.requirementNumber, i.sourceLabel].join(' ').toLowerCase().includes(q);
    });
  }, [indents, statusFilter, search, tick]);

  const indent = openIndent ? getIndent(openIndent) : null;
  const editable = indent ? canEditIndent(indent) : false;

  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 6000);
  };

  const run = (fn) => {
    try {
      fn();
      setTick((t) => t + 1);
    } catch (err) {
      flash('err', err.message);
    }
  };

  /** Admin approval of a Purchase Indent shared by Store (unlocks the vendor enquiry). */
  const canApproveIndent = hasPermission('indent.admin_approve');

  const approveIndent = async (indentNumber) => {
    const remarks = window.prompt(`Approve ${indentNumber}? Enter remarks (optional):`);
    if (remarks === null) return;
    try {
      await approveIndentByAdmin(indentNumber, remarks);
      flash('ok', `Indent ${indentNumber} approved — Purchase has been notified and can now send vendor enquiries.`);
    } catch (err) {
      flash('err', err.message);
    }
  };

  const reviewIndent = (indentNumber) => run(() => {
    startPurchaseIndentReview(indentNumber);
    flash('ok', `Indent ${indentNumber} is now under Purchase review.`);
  });

  /** Send the indent (and its PO) to Quality for material inspection. */
  const sendToQualityCheck = (indentNumber) => {
    try {
      const indent = getIndent(indentNumber);
      if (!indent) throw new Error(`Purchase Indent ${indentNumber} not found.`);

      // Once Store has recorded a delivery, Quality must inspect that receipt.
      // Sending the indent itself would lose the invoice/receipt link.
      if (indent.poNumber && getReceiptsForPO(indent.poNumber).length > 0) {
        navigate('/quality-checks');
        return;
      }

      sendIndentToQualityCheck(indentNumber);
      setTick((t) => t + 1);
      navigate('/quality-checks');
    } catch (err) {
      flash('err', err.message);
    }
  };

  /** Raise a repurchase indent for the rejected quantity of a rejection report. */
  const raiseRepurchase = (rejectionNumber) => {
    run(() => {
      const created = createRepurchaseIndent(rejectionNumber);
      flash(
        'ok',
        `Repurchase indent ${created.indentNumber} raised for ${rejectionNumber} — it now appears under Purchase Order for conversion to PO.`
      );
    });
  };

  const requireLinkedPO = (indent) => {
    if (!indent.poNumber) {
      flash('err', `Indent ${indent.indentNumber} is not linked to a Purchase Order yet.`);
      return null;
    }
    const po = getPOByRef(indent.poNumber);
    if (!po) {
      flash('err', `Purchase Order ${indent.poNumber} not found.`);
      return null;
    }
    return po;
  };

  /**
   * Record Delivery — a vendor delivery MUST be recorded on the Tax Invoice /
   * Material Receipt screen. Direct Purchase Order → Inventory is disabled
   * (NO QUALITY APPROVAL = NO INVENTORY UPDATE).
   */
  const openMaterialReceipt = (indent) => {
    if (!requireLinkedPO(indent)) return;
    const poNumber = indent.poNumber;
    const progress = getPOProgress(poNumber);
    if (progress.ordered > 0 && progress.pending === 0) {
      flash(
        'err',
        `PO ${poNumber} is already Closed — all ordered material has been received. Rejected quantity must be re-ordered on a replacement PO.`
      );
      return;
    }
    navigate('/material-receipts', { state: { newReceiptFor: poNumber } });
  };

  const toggleActionMenu = (e, indentNumber) => {
    if (actionMenu?.indentNumber === indentNumber) {
      setActionMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320));
    setActionMenu({ indentNumber, left, top: rect.bottom + 6 });
  };

  useEffect(() => {
    if (!actionMenu) return undefined;
    const close = (e) => {
      if (e.target?.closest?.('[data-action-trigger]') || e.target?.closest?.('.erp-action-menu')) return;
      setActionMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setActionMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [actionMenu]);

  const menuIndent = actionMenu ? indents.find((i) => i.indentNumber === actionMenu.indentNumber) : null;

  if (productionOnly) {
    return <Navigate to="/production" replace />;
  }

  if (indent) {
    return (
      <IndentDetailSafe
        fallback={<div>Error loading indent details</div>}
      >
        <IndentDetail
          key={`${indent.indentNumber}-${tick}`}
          indent={indent}
          editable={editable}
          userDept={userDept}
          productionOnly={productionOnly}
          message={message}
          onMessage={flash}
          onBack={() => { setOpenIndent(null); setMessage(null); setTick((t) => t + 1); }}
          onChange={() => setTick((t) => t + 1)}
          onRepurchase={raiseRepurchase}
          onSendToQC={sendToQualityCheck}
          onApprove={approveIndent}
          onReview={reviewIndent}
          run={run}
        />
      </IndentDetailSafe>
    );
  }

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Purchase Indents</h1>
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
          <h3 className="block-title">Indents ({filtered.length})</h3>
        </div>
        <div className="list-filters">
          <input
            type="text"
            className="action-select form-input search-input"
            placeholder="Search indent / SO / customer / PO..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="action-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="All">All Statuses</option>
            {Object.values(INDENT_STATUS).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Indent No</th>
                <th>Date</th>
                <th>Origin / SO</th>
                <th>Project ID</th>
                <th>Customer</th>
                <th>Materials</th>
                <th>Purchase Qty</th>
                <th>Required Date</th>
                <th>Status</th>
                <th>PO</th>
                <th>Created By</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="12" className="no-history-row">
                    No purchase indents yet.
                  </td>
                </tr>
              ) : (
                filtered.map((i) => (
                  <tr key={i.indentNumber}>
                    <td><strong>{i.indentNumber}</strong></td>
                    <td>{i.indentDate}</td>
                    <td>{i.soNumber || (i.requirementNumber ? 'Production Requirement' : '—')}</td>
                    <td>{i.projectId || '—'}</td>
                    <td>{i.customer || '—'}</td>
                    <td>{i.items?.length || 0}</td>
                    <td>{(i.items || []).reduce((a, it) => a + (Number(it.purchaseQty) || 0), 0)}</td>
                    <td>{i.requiredDate || '—'}</td>
                    <td>
                      <span className={badgeClass(i.status)}>{i.status}</span>
                      {i.adminApprovedAt ? (
                        <div style={{ fontSize: '11px', color: '#166534', fontWeight: 700, marginTop: '2px' }}>
                          ✓ Approved by {i.adminApprovedBy || 'Admin'}
                        </div>
                      ) : i.sourceType !== 'storeDirect' && i.status !== INDENT_STATUS.DRAFT && i.status !== INDENT_STATUS.CANCELLED ? (
                        <div style={{ fontSize: '11px', color: '#b45309', fontWeight: 700, marginTop: '2px' }}>
                          Admin approval pending
                        </div>
                      ) : null}
                    </td>
                    <td>{i.poNumber || '—'}</td>
                    <td>{i.createdBy}</td>
                    <td>
                      <button
                        className="button-small button-secondary"
                        data-action-trigger
                        aria-haspopup="menu"
                        title="Actions for this indent"
                        onClick={(e) => toggleActionMenu(e, i.indentNumber)}
                      >
                        Actions ▾
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {actionMenu && menuIndent &&
        createPortal(
          <div className="erp-action-menu" style={{ left: actionMenu.left, top: actionMenu.top }} role="menu">
            <button
              className="erp-action-menu-item"
              onClick={() => {
                setActionMenu(null);
                setOpenIndent(menuIndent.indentNumber);
                setMessage(null);
              }}
            >
              Open
            </button>
          </div>,
          document.body
        )}
    </section>
  );
};

const IndentDetail = ({ indent, editable, userDept, productionOnly = false, message, onMessage, onBack, onChange, onRepurchase, onSendToQC, onApprove, onReview, run }) => {
  const navigate = useNavigate();
  const historicalOnly = indent.sourceType === 'storeDirect';
  const isPurchaseDept = userDept === 'Purchase Department' || hasPermission('*');
  const isStoreDept = userDept === 'Store Department' || hasPermission('*');
  const canApprove = hasPermission('indent.admin_approve');
  const needsApproval =
    !historicalOnly &&
    !indent.adminApprovedAt &&
    indent.status !== INDENT_STATUS.DRAFT &&
    indent.status !== INDENT_STATUS.CANCELLED;

  const [items, setItems] = useState(indent.items || []);
  const [reason, setReason] = useState(indent.reason || '');
  const [storeRemarks, setStoreRemarks] = useState(indent.storeRemarks || '');
  const [purchaseRemarks, setPurchaseRemarks] = useState(indent.purchaseRemarks || '');
  const [submitRemarks, setSubmitRemarks] = useState('');
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState('');

  useEffect(() => () => {
    if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
  }, [pdfPreviewUrl]);

  const getCurrentIndentForPdf = () => ({
    ...indent,
    items: items.map((item) => ({ ...item, purchaseQty: num(item.purchaseQty) })),
    reason,
    storeRemarks,
    purchaseRemarks
  });
  const openPdfPreview = async () => {
    const url = await generatePurchaseIndentPDF(getCurrentIndentForPdf(), { preview: true });
    if (url) setPdfPreviewUrl(url);
  };

  const so = getSalesOrderByRef(indent.soNumber);
  const qc = getQualityCheckForIndent(indent.indentNumber);
  const procurementChain = getProcurementChainForIndent(indent.indentNumber);
  const receiptsForPO = indent.poNumber ? getReceiptsForPO(indent.poNumber) : [];
  const rejections = getRejectionReportsForIndent(indent.indentNumber);
  const qcSent = indent.qcStatus === INDENT_QC_STATUS.SENT || Boolean(indent.qcNumber);
  const canSendToQC =
    !historicalOnly && Boolean(indent.poNumber) && !qc && receiptsForPO.length === 0 && indent.status !== INDENT_STATUS.CANCELLED &&
    (hasPermission('indent.review') || hasPermission('receipt.create'));

  const setItem = (idx, field, value) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));

  /* Admin only: once Store has SUBMITTED an indent, the Admin may add a material
     line the Store's indent did not cover, before it becomes a Purchase Order.
     Not offered on a Draft (Store still owns it) and never once the indent has
     been converted / completed / cancelled. Store may only edit lines it
     already raised (indent.edit on a Draft) and Purchase reviews — neither is
     given this control. */
  const submittedAndOpen =
    indent.status !== INDENT_STATUS.DRAFT &&
    ![
      INDENT_STATUS.CONVERTED,
      INDENT_STATUS.CANCELLED,
      INDENT_STATUS.PO_CREATED,
      INDENT_STATUS.COMPLETED
    ].includes(indent.status);
  const canAddMaterial = editable && submittedAndOpen && hasPermission('*');
  const addMaterial = () =>
    setItems((prev) => [
      ...prev,
      {
        materialCode: '',
        materialName: '',
        unit: 'Nos',
        orderedQty: 0,
        availableQty: 0,
        purchaseQty: 0,
        requiredDate: '',
        source: 'Admin Added'
      }
    ]);

  const save = () =>
    run(() => {
      const wasDraft = indent.status === INDENT_STATUS.DRAFT;
      updatePurchaseIndent(indent.indentNumber, {
        items: items.map((it) => ({ ...it, purchaseQty: num(it.purchaseQty) })),
        reason,
        storeRemarks,
        purchaseRemarks
      });
      // Saving a Draft indent hands it over to Purchase (appears under Purchase Order → indents awaiting conversion).
      if (wasDraft && canSubmitIndent(indent)) {
        submitPurchaseIndent(indent.indentNumber, 'Submitted on save');
        onMessage({
          type: 'ok',
          text: `Indent ${indent.indentNumber} saved and submitted — it now appears in the Purchase Department for conversion to PO.`
        });
        return;
      }
      onMessage({ type: 'ok', text: `Indent ${indent.indentNumber} saved.` });
    });

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">{indent.indentNumber}</h1>
          <p className="page-description">
            {indent.requirementNumber
              ? `Requirement ${indent.requirementNumber} · ${indent.soNumber ? `Sales Order ${indent.soNumber} · ` : ''}`
              : `Sales Order ${indent.soNumber} · `}
            {indent.customer || '-'} · Created by {indent.createdBy} on {indent.createdAt}
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          <button className="button-secondary no-print" onClick={openPdfPreview}>
            View PDF
          </button>
          <button className="button-secondary no-print" onClick={() => generatePurchaseIndentPDF(getCurrentIndentForPdf())}>
            Download PDF
          </button>
          <button className="button-secondary no-print" onClick={() => generatePurchaseIndentPDF(getCurrentIndentForPdf(), { print: true })}>
            Print
          </button>
          {!historicalOnly && isPurchaseDept && indent.status === INDENT_STATUS.SUBMITTED && hasPermission('indent.review') && (
            <button className="button-primary no-print" onClick={() => onReview(indent.indentNumber)}>Start Purchase Review</button>
          )}
          {!historicalOnly && canApprove && needsApproval && (
            <button
              className="button-primary"
              style={{ background: '#16a34a' }}
              title="Approve this Purchase Indent so Purchase can raise the vendor enquiry"
              onClick={() => onApprove(indent.indentNumber)}
            >
              Approve (Admin)
            </button>
          )}
          <button className="button-secondary" onClick={onBack}>
             Back to Indents
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

      {needsApproval && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            marginBottom: '16px',
            fontWeight: 600,
            background: '#fffbeb',
            border: '1px solid #fde68a',
            color: '#92400e'
          }}
        >
          {canApprove
            ? `Purchase Indent ${indent.indentNumber} is awaiting your approval — approve it so Purchase can send the vendor enquiry.`
            : `Purchase Indent ${indent.indentNumber} is awaiting Admin approval — Purchase can raise the vendor enquiry once the Admin approves it.`}
        </div>
      )}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Indent Details</h3>
          <span className={badgeClass(indent.status)}>{indent.status}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div><strong>Indent No:</strong> {indent.indentNumber}</div>
          <div><strong>Origin:</strong> {indent.requirementNumber ? 'Production Requirement' : indent.soNumber ? 'Sales Order' : 'Historical Record'}</div>
          <div><strong>Sales Order:</strong> {indent.soNumber || '—'}</div>
          <div><strong>Requirement:</strong> {indent.requirementNumber || '—'}</div>
          <div><strong>Production Job:</strong> {indent.productionJob || '—'}</div>
          <div><strong>Customer:</strong> {indent.customer || '—'}</div>
          <div><strong>Indent Date:</strong> {indent.indentDate}</div>
          <div><strong>Required Date:</strong> {indent.requiredDate || '—'}</div>
          <div><strong>Delivery Date (SO):</strong> {indent.deliveryDate || '—'}</div>
          <div><strong>Created By:</strong> {indent.createdBy} ({indent.createdByDept})</div>
          <div><strong>Submitted At:</strong> {indent.submittedAt || '—'}</div>
          <div><strong>Linked PO:</strong> {indent.poNumber || '—'}</div>
          <div>
            <strong>Admin Approval:</strong>{' '}
            {indent.adminApprovedAt ? (
              <span style={{ color: '#166534', fontWeight: 700 }}>
                ✓ Approved by {indent.adminApprovedBy || 'Admin'} on {indent.adminApprovedAt}
              </span>
            ) : (
              <span style={{ color: '#b45309', fontWeight: 700 }}>Pending</span>
            )}
          </div>
          <div>
            <strong>Quality Check:</strong>{' '}
            {qc ? qc.qcNumber : indent.qcStatus || 'Not sent'}
          </div>
        </div>
        {indent.requirementNumber ? (
          <p style={{ marginTop: '10px', color: '#64748b', fontSize: '12.5px' }}>
            Source: Production Requirement {indent.requirementNumber} → Store Review → Purchase Indent {indent.indentNumber}
            {indent.poNumber ? ` → Purchase Order ${indent.poNumber}` : ''}
            {indent.soNumber ? ` (Sales Order ${indent.soNumber})` : ''}
          </p>
        ) : (
          so && (
            <p style={{ marginTop: '10px', color: '#64748b', fontSize: '12.5px' }}>
              Source: Sales Order {indent.soNumber} → Material Availability Check → Purchase Indent {indent.indentNumber}
              {indent.poNumber ? ` → Purchase Order ${indent.poNumber}` : ''}
            </p>
          )
        )}
        {!editable && !productionOnly && (
          <p style={{ marginTop: '10px', color: '#92400e', fontSize: '12.5px', fontWeight: 600 }}>
            Read-only for your department ({userDept}) in status "{indent.status}".
          </p>
        )}
      </div>

      {(qcSent || qc) && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              Quality Check Report
              <span className={badgeClass(qc ? qc.status : indent.qcStatus)}>{qc ? qc.status : indent.qcStatus}</span>
            </h3>
            {qc && <span className={badgeClass(qc.postedToInventory ? 'Posted' : 'Not Posted')}>{qc.postedToInventory ? 'Added to inventory' : 'Inventory pending'}</span>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '14px' }}>
            <div><strong>QC No:</strong> {qc?.qcNumber || '—'}</div>
            <div><strong>Sent On:</strong> {indent.sentToQCAt || '—'}</div>
            <div><strong>Inspector:</strong> {qc?.inspector || '—'}</div>
            <div><strong>Inspection Date:</strong> {qc?.inspectionDate || '—'}</div>
            <div><strong>Linked PO:</strong> {indent.poNumber || '—'}</div>
          </div>

          {qc ? (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                    <tr>
                      <th>SL.No</th><th>Material</th><th>Unit</th><th>Inspected Qty</th><th>Passed Qty</th><th>Rejected Qty</th><th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qc.items.map((it, idx) => (
                      <tr key={`${it.materialCode}-${idx}`}>
                        <td>{idx + 1}</td>
                        <td><strong>{it.materialName}</strong></td>
                      <td>{it.unit}</td>
                      <td>{num(it.receivedQty)}</td>
                      <td style={{ color: '#166534', fontWeight: 700 }}>{num(it.acceptedQty)}</td>
                      <td style={{ color: num(it.rejectedQty) > 0 ? '#b91c1c' : 'inherit', fontWeight: 700 }}>{num(it.rejectedQty)}</td>
                      <td><span className={badgeClass(it.result)}>{it.result}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ color: '#64748b', fontSize: '12.5px' }}>
              Awaiting inspection — Quality records the passed / rejected quantity from the Quality Checks screen.
            </p>
          )}

          {qc && isStoreDept && !qc.postedToInventory && qc.items.some((i) => num(i.acceptedQty) > 0) && (
            <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: '14px' }}>
              <button
                className="button-primary"
                onClick={() => {
                  try {
                    postApprovedMaterialToInventory(qc.qcNumber);
                    onMessage({ type: 'ok', text: `Approved quantity of ${qc.qcNumber} added to inventory.` });
                  } catch (err) {
                    onMessage({ type: 'err', text: err.message });
                  }
                }}
              >
                Store: add approved quantity to Inventory
              </button>
            </div>
          )}
          {qc?.remarks && <p style={{ marginTop: '10px' }}><strong>Inspector remarks:</strong> {qc.remarks}</p>}

          {indent.poNumber && isStoreDept && (
            receiptsForPO.length > 0 ? (
              <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: '12px' }}>
                <div role="status" style={{ flexBasis: '100%', color: '#92400e', fontSize: '13px' }}>
                  <strong>Material receipt already recorded for this PO.</strong> Do not enter the same vendor invoice again.
                  {qc && !qc.receiptNumber && (
                    <span>
                      {' '}This QC was recorded against the Purchase Indent, not a receipt
                      {qc.postedToInventory ? ' and its approved quantity is already posted to inventory' : ''}.
                      The receipt/QC records need to be reconciled before posting or claiming the rejected quantity.
                    </span>
                  )}
                </div>
                {receiptsForPO.some((receipt) => !getQualityCheckForReceipt(receipt.receiptNumber)) && (
                  <button type="button" className="button-primary" onClick={() => onSendToQC(indent.indentNumber)}>
                    Send to Quality Check
                  </button>
                )}
                {receiptsForPO.map((receipt) => {
                  const receiptQC = getQualityCheckForReceipt(receipt.receiptNumber);
                  return (
                    <button
                      key={receipt.receiptNumber}
                      type="button"
                      className="button-secondary"
                      onClick={() => navigate('/material-receipts', { state: { openReceipt: receipt.receiptNumber } })}
                    >
                      View {receipt.receiptNumber} · {receipt.invoiceNumber || 'No invoice'} · {receiptQC?.status || receipt.qcStatus || 'Pending Quality Check'}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: '12px' }}>
                <button
                  className="button-secondary"
                  title="Record a vendor invoice and received quantities for this purchase order"
                  onClick={() => navigate('/material-receipts', { state: { newReceiptFor: indent.poNumber } })}
                >
                  Record Tax Invoice / Material Receipt
                </button>
                {qc?.receiptNumber && (
                  <span className={badgeClass('Invoiced')}>Invoice stored on {qc.receiptNumber}</span>
                )}
              </div>
            )
          )}

          {qc && (() => {
            try {
              const dn = debitNoteStateFor(qc);
              const rejectedQty = num((qc.items || []).reduce((a, i) => a + num(i.rejectedQty), 0));
              if (rejectedQty <= 0 || !dn.canCreate) return null;
              return (
                <div
                  className="form-actions"
                  style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: '12px', alignItems: 'center' }}
                >
                  {dn.canCreate && hasPermission('debitnote.create') && dn.context ? (
                    <button
                      className="button-primary"
                      style={{ background: '#b45309' }}
                      title="Claim credit from the vendor for the rejected material on this quality check"
                      onClick={() =>
                        navigate('/debit-notes', { state: { newDebitNoteFor: dn.context.rejection.rejectionNumber } })
                      }
                    >
                      Create Debit Note
                    </button>
                  ) : (
                    <span style={{ color: '#92400e', fontSize: '12.5px', fontWeight: 600 }}>
                      {dn.fullyDebited
                        ? `Rejected quantity fully debited${dn.summary?.numbers?.length ? ` (${dn.summary.numbers.join(', ')})` : ''}.`
                        : dn.awaitingReceipt
                          ? 'Debit Note available once the Tax Invoice / Material Receipt is recorded above.'
                          : 'Debit Note available once the Rejection Report is raised.'}
                    </span>
                  )}
                  {dn.summary?.count > 0 && (
                    <span className={badgeClass('Invoiced')}>
                      Debited: {dn.summary.numbers.join(', ')} · {num(dn.summary.committedQty)} qty · ₹
                      {num(dn.summary.committedValue).toFixed(2)}
                    </span>
                  )}
                  {dn.canCreate && (
                    <span style={{ color: '#475569', fontSize: '12.5px' }}>
                      Rejected {rejectedQty} · Already debited {num(dn.context?.totalDebitedQty)} · Available{' '}
                      {num(dn.context?.totalRemainingQty)}
                    </span>
                  )}
                </div>
              );
            } catch (err) {
              console.error('Error rendering Debit Note section:', err);
              return (
                <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: '12px' }}>
                  <span style={{ color: '#92400e', fontSize: '12.5px' }}>
                    Unable to load Debit Note options for this Quality Check.
                  </span>
                </div>
              );
            }
          })()}
        </div>
      )}

      {(() => {
        const pendingReview = rejections.flatMap((r) =>
          getDebitNotes().filter(
            (d) =>
              d.rejectionNumber === r.rejectionNumber &&
              [DEBIT_NOTE_STATUS.REQUESTED, DEBIT_NOTE_STATUS.PURCHASE_REVIEW, DEBIT_NOTE_STATUS.ADMIN_REVIEW].includes(d.status)
          )
        );
        if (!pendingReview.length || !hasPermission('debitnote.view')) return null;
        return (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Debit Note Requests awaiting Purchase review ({pendingReview.length})</h3>
              <span className="muted-text">Requested → Purchase Review → Approved → Issued → Vendor → Closed</span>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Debit Note</th><th>Rejection Report</th><th>PO</th><th>Vendor</th><th>Qty</th>
                    <th>Value</th><th>Requested By</th><th>Requested At</th><th>Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingReview.map((d) => (
                    <tr key={d.debitNoteNumber}>
                      <td><strong>{d.debitNoteNumber}</strong></td>
                      <td>{d.rejectionNumber}</td>
                      <td>{d.poNumber || '—'}</td>
                      <td>{d.vendor || '—'}</td>
                      <td>{num(d.totalDebitQty)}</td>
                      <td>₹{num(d.grandTotal).toFixed(2)}</td>
                      <td>{d.requestedBy || '—'}</td>
                      <td>{d.requestedAt || '—'}</td>
                      <td><span className={badgeClass(d.status)}>{d.status}</span></td>
                      <td>
                        <button
                          className="button-small button-primary"
                          onClick={() => navigate('/debit-notes', { state: { openDebitNote: d.debitNoteNumber } })}
                        >
                          {d.status === DEBIT_NOTE_STATUS.REQUESTED
                            ? 'Start Review'
                            : d.status === DEBIT_NOTE_STATUS.ADMIN_REVIEW
                              ? 'View'
                              : 'Review / Authorise'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {rejections.length > 0 && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Rejection Reports → Purchase</h3>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Report No</th><th>PO</th><th>QC</th><th>Rejected Materials</th><th>Status</th><th>Repurchase Indent</th><th>Debit Note</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rejections.map((r) => {
                  let dn;
                  try {
                    dn = debitNoteStateFor({ qcNumber: r.qcNumber, indentNumber: r.indentNumber, items: r.items });
                  } catch (err) {
                    console.error('Error computing Debit Note state for rejection:', err);
                    dn = { canCreate: false, fullyDebited: false, awaitingReceipt: false, summary: null, context: null };
                  }
                  const repurchasable = !r.repurchaseIndentNumber && (r.items || []).some((i) => num(i.rejectedQty) > 0);
                  return (
                    <tr key={r.rejectionNumber}>
                      <td><strong>{r.rejectionNumber}</strong></td>
                      <td>{r.poNumber || '—'}</td>
                      <td>{r.qcNumber || '—'}</td>
                      <td>{(r.items || []).map((i) => `${i.materialName} × ${num(i.rejectedQty)}`).join(', ')}</td>
                      <td><span className={badgeClass(r.status)}>{r.status}</span></td>
                      <td>{r.repurchaseIndentNumber || '—'}</td>
                      <td>
                        {dn.summary?.count > 0 ? (
                          <button
                            className="button-small button-secondary"
                            onClick={() => navigate('/debit-notes', { state: { openDebitNote: dn.summary.numbers[0] } })}
                          >
                            {dn.summary.numbers.join(', ')}
                          </button>
                        ) : dn.canCreate && hasPermission('debitnote.create') ? (
                          <button
                            className="button-small button-primary"
                            onClick={() => navigate('/debit-notes', { state: { newDebitNoteFor: r.rejectionNumber } })}
                          >
                            Create
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {!historicalOnly && repurchasable && isPurchaseDept && hasPermission('indent.review') ? (
                          <button className="button-small button-secondary" title="Raise a Purchase Indent for the rejected quantity" onClick={() => onRepurchase(r.rejectionNumber)}>
                            Repurchase
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: '10px', color: '#64748b', fontSize: '12.5px' }}>
            The rejected quantity can be re-ordered through <strong>Repurchase</strong> — it raises a new Purchase Indent
            for Purchase to convert to a Purchase Order.
          </p>
        </div>
      )}

      {!qcSent && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              Quality Check
              <span className={badgeClass('Not sent')}>Not sent</span>
            </h3>
            {canSendToQC && (
              <button className="button-primary" title="Send the PO material for quality inspection" onClick={() => onSendToQC(indent.indentNumber)}>
                Send to Quality Check
              </button>
            )}
          </div>
          <p style={{ color: '#64748b', fontSize: '12.5px' }}>
            Once sent, Quality inspects the material and the passed / rejected report appears here for the Store to post
            the approved quantity into inventory.
          </p>
        </div>
      )}

      {!productionOnly && (
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Materials to Purchase</h3>
          {canAddMaterial && (
            <button
              className="button-primary button-small"
              title="Admin only — add a material line the Store's indent did not cover"
              onClick={addMaterial}
            >
              + Add More Material
            </button>
          )}
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material Name</th>
                <th>Unit</th>
                <th>Ordered (SO)</th>
                <th>Available</th>
                <th>Purchase Qty</th>
                <th>Required Date</th>
                <th>Source</th>
                {editable && <th>Remove</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={`${it.materialCode}-${idx}`}>
                  <td>{idx + 1}</td>
                  <td>
                    {editable ? (
                      <input className="action-select form-input" value={it.materialName || ''} onChange={(e) => setItem(idx, 'materialName', e.target.value)} />
                    ) : (
                      it.materialName
                    )}
                  </td>
                  <td>{it.unit}</td>
                  <td>{num(it.orderedQty)}</td>
                  <td>{num(it.availableQty)}</td>
                  <td>
                    {editable ? (
                      <input
                        type="number"
                        min="0"
                        className="action-select form-input"
                        value={it.purchaseQty}
                        onChange={(e) => setItem(idx, 'purchaseQty', e.target.value)}
                      />
                    ) : (
                      <strong>{num(it.purchaseQty)}</strong>
                    )}
                  </td>
                  <td>
                    {editable ? (
                      <input type="date" className="action-select form-input" value={it.requiredDate || ''} onChange={(e) => setItem(idx, 'requiredDate', e.target.value)} />
                    ) : (
                      it.requiredDate || '—'
                    )}
                  </td>
                  <td>
                    <span
                      className={badgeClass(
                        it.source === 'Admin Added'
                          ? 'Additional'
                          : it.source === 'Production Additional Requirement'
                            ? 'Additional'
                            : it.source === 'Production Requirement Shortage'
                              ? 'Requirement'
                              : 'Shortage'
                      )}
                    >
                      {it.source === 'Production Requirement Shortage'
                        ? 'Requirement Shortage'
                        : it.source || 'Shortage'}
                    </span>
                  </td>
                  {editable && (
                    <td>
                      <button className="button-small button-secondary" onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}>
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="section-grid" style={{ marginTop: '14px' }}>
          <div className="field-group">
            <label>Reason</label>
            <input value={reason} disabled={!editable} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Store remarks</label>
            <input value={storeRemarks} disabled={!editable || !isStoreDept} onChange={(e) => setStoreRemarks(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Purchase remarks</label>
            <input value={purchaseRemarks} disabled={!isPurchaseDept || indent.status === INDENT_STATUS.CONVERTED} onChange={(e) => setPurchaseRemarks(e.target.value)} />
          </div>
        </div>

        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {editable && <button className="button-primary" onClick={save}>Save Indent</button>}
          {canSubmitIndent(indent) && (
            <button
              className="button-primary"
              style={{ background: '#16a34a' }}
              onClick={() =>
                run(() => {
                  submitPurchaseIndent(indent.indentNumber, submitRemarks);
                  onMessage({ type: 'ok', text: `Indent ${indent.indentNumber} submitted to Purchase.` });
                })
              }
            >
              Submit to Purchase
            </button>
          )}
          {canSubmitIndent(indent) && (
            <input
              className="action-select form-input"
              style={{ maxWidth: '280px' }}
              placeholder="Submission remarks (optional)"
              value={submitRemarks}
              onChange={(e) => setSubmitRemarks(e.target.value)}
            />
          )}
          {isAdmin() && !historicalOnly && indent.status !== INDENT_STATUS.CONVERTED && indent.status !== INDENT_STATUS.CANCELLED && (
            <button
              className="button-secondary"
              onClick={() => {
                const reasonText = window.prompt('Cancel indent reason?');
                if (reasonText === null || !reasonText.trim()) return;
                run(() => {
                  cancelIndent(indent.indentNumber, reasonText);
                  onMessage({ type: 'ok', text: `Indent ${indent.indentNumber} cancelled.` });
                });
              }}
            >
              Cancel Indent
            </button>
          )}
        </div>
      </div>
      )}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Procurement Tracking</h3>
          <span className={badgeClass(indent.status)}>{indent.status}</span>
        </div>
        {procurementChain.enquiries.length === 0 ? <p className="muted-text">No Vendor Enquiry has been raised yet.</p> : (
          <div className="history-table-wrapper"><table className="history-table"><thead><tr><th>Vendor Enquiry</th><th>Status</th><th>Created</th><th>Quotations</th><th>Purchase Order</th></tr></thead>
            <tbody>{procurementChain.enquiries.map((enquiry) => {
              const quotes = procurementChain.quotations.filter((quote) => quote.enquiryNumber === enquiry.enquiryNumber);
              return <tr key={enquiry.enquiryNumber}><td>{enquiry.enquiryNumber}</td><td>{enquiry.status || '—'}</td><td>{enquiry.createdAt || '—'}</td><td>{quotes.length ? quotes.map((quote) => `${quote.quotationNumber} (${quote.status || '—'})`).join(', ') : '—'}</td><td>{enquiry.poNumber || indent.poNumber || '—'}</td></tr>;
            })}</tbody>
          </table></div>
        )}
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Audit Trail</h3>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr><th>Date / Time</th><th>User</th><th>Department</th><th>Action</th><th>Details</th></tr>
            </thead>
            <tbody>
              {(indent.history || []).slice().reverse().map((h, idx) => (
                <tr key={idx}>
                  <td>{h.at}</td>
                  <td>{h.name}{h.empId && h.empId !== '-' ? ` (${h.empId})` : ''}</td>
                  <td>{h.dept}</td>
                  <td><strong>{h.action}</strong></td>
                  <td>{h.details || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pdfPreviewUrl && (
        <div className="no-print" role="dialog" aria-modal="true" aria-label="Purchase Indent PDF preview" style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(15, 23, 42, 0.72)', display: 'flex', flexDirection: 'column', padding: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '10px 14px', background: '#fff', borderRadius: '10px 10px 0 0' }}>
            <strong>Purchase Indent PDF Preview</strong>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="button-secondary" onClick={() => setPdfPreviewUrl('')}>Close Preview</button>
              <button className="button-primary" onClick={() => generatePurchaseIndentPDF(getCurrentIndentForPdf())}>Download PDF</button>
            </div>
          </div>
          <iframe title="Purchase Indent PDF Preview" src={pdfPreviewUrl} style={{ flex: 1, width: '100%', border: 0, background: '#e2e8f0', borderRadius: '0 0 10px 10px' }} />
        </div>
      )}
    </section>
  );
};

export default PurchaseIndentsPage;
