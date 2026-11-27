import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import {
  REQUIREMENT_STATUS,
  computeRequirementLines,
  getRequirementIndents,
  createIndentFromRequirement
} from '../utils/productionRequirementService.js';
import {
  listRequirements,
  getRequirement as getRequirementApi,
  deleteRequirement as deleteRequirementApi,
  requirementAction
} from '../services/productionApi.js';
import { hasPermission, isAdmin } from '../utils/permissions.js';
import { getAvailabilityChecks, hydrateAvailabilityChecks } from '../utils/workflowService.js';
import { listProcurementRecords } from '../services/procurementIntakeApi.js';
import { importLegacyAvailabilityChecks, previewLegacyAvailabilityChecks } from '../services/availabilityCheckApi.js';

const badgeClass = (status) =>
  `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

const qty = (v) => Number(v) || 0;

const StoreItemRequirementsPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [viewNo, setViewNo] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);
  const [indentSyncReady, setIndentSyncReady] = useState(false);
  const [availabilityPreview, setAvailabilityPreview] = useState(null);
  const [selectedLegacyChecks, setSelectedLegacyChecks] = useState([]);
  const [availabilityImportBusy, setAvailabilityImportBusy] = useState(false);
  const [requirements, setRequirements] = useState([]);
  const [requirementsLoading, setRequirementsLoading] = useState(true);
  const [requirementsError, setRequirementsError] = useState('');

  // review state
  const [reviewRemarks, setReviewRemarks] = useState('');
  const [lineRemarks, setLineRemarks] = useState({});
  // indent state
  const [selectedLineIds, setSelectedLineIds] = useState([]);
  const [qtyInputs, setQtyInputs] = useState({});
  const [indentReason, setIndentReason] = useState('');
  const [indentRemarks, setIndentRemarks] = useState('');
  const [indentRequiredDate, setIndentRequiredDate] = useState('');

  useEffect(() => {
    let active = true;
    setRequirementsLoading(true);
    setRequirementsError('');
    Promise.all([listProcurementRecords('purchaseIndent'), hydrateAvailabilityChecks(), listRequirements()]).then(([, , requirementRows]) => {
        if (!active) return;
        setRequirements(requirementRows);
        setIndentSyncReady(true);
        setTick((value) => value + 1);
      }).catch((error) => {
        if (!active) return;
        setRequirements([]);
        setRequirementsError(error.message || 'Could not load Production Requirements from PostgreSQL.');
        setMessage({ type: 'err', text: `PostgreSQL workflow data could not be refreshed: ${error.message}` });
      }).finally(() => { if (active) setRequirementsLoading(false); });
    return () => { active = false; };
  }, []);

  const loadAvailabilityPreview = async () => {
    try {
      const preview = await previewLegacyAvailabilityChecks();
      setAvailabilityPreview(preview);
      setSelectedLegacyChecks([]);
    } catch (error) {
      setMessage({ type: 'err', text: `Legacy availability preview failed: ${error.message}` });
    }
  };

  const importSelectedAvailabilityChecks = async () => {
    if (!selectedLegacyChecks.length || !window.confirm(`Import ${selectedLegacyChecks.length} selected availability check(s) into PostgreSQL? Legacy records will be preserved.`)) return;
    setAvailabilityImportBusy(true);
    try {
      const result = await importLegacyAvailabilityChecks(selectedLegacyChecks);
      setAvailabilityPreview(null);
      setSelectedLegacyChecks([]);
      setMessage({ type: 'ok', text: `${result.imported.length} selected availability check(s) imported. Legacy data was preserved.` });
      await hydrateAvailabilityChecks();
      setTick((value) => value + 1);
      try {
        setAvailabilityPreview(await previewLegacyAvailabilityChecks());
      } catch (previewError) {
        setMessage({ type: 'err', text: `${result.imported.length} check(s) were imported, but the preview could not be refreshed: ${previewError.message}` });
      }
    } catch (error) {
      setMessage({ type: 'err', text: `Availability check import failed: ${error.message}` });
    } finally {
      setAvailabilityImportBusy(false);
    }
  };

  const authoritativeRequirements = useMemo(
    () => requirements.filter((r) => r.status !== REQUIREMENT_STATUS.DRAFT),
    [requirements]
  );
  const legacyChecks = useMemo(() => getAvailabilityChecks(), [tick]);

  /* Deep links: /store/item-requirements?req=PR-0001 or location state.openRequirement. */
  useEffect(() => {
    const wanted =
      searchParams.get('req') || location.state?.openRequirement || location.state?.requirementNumber;
    if (wanted && requirements.some((r) => r.requirementNumber === wanted)) {
      openRequirement(wanted);
      if (searchParams.get('req')) setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 6000);
  };

  const requirement = viewNo ? requirements.find((r) => r.requirementNumber === viewNo) || null : null;
  const lines = requirement ? computeRequirementLines(requirement) : [];
  const indents = requirement ? getRequirementIndents(requirement.requirementNumber) : [];
  const shortageLines = lines.filter((l) => l.remainingShortageQty > 0);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return authoritativeRequirements.filter((r) => {
      if (statusFilter !== 'All' && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.requirementNumber, r.projectId, r.productionJob, r.soNumber, r.customer]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [authoritativeRequirements, search, statusFilter]);

  const openRequirement = (no) => {
    const rec = requirements.find((r) => r.requirementNumber === no);
    if (!rec) return;
    setViewNo(no);
    setMessage(null);
    setReviewRemarks(rec.storeReview?.remarks || '');
    const remarksByLine = {};
    Object.entries(rec.storeReview?.lines || {}).forEach(([lineId, l]) => {
      remarksByLine[lineId] = l.remarks || '';
    });
    setLineRemarks(remarksByLine);
    // default indent selections to every remaining-shortage line
    const computed = computeRequirementLines(rec).filter((l) => l.remainingShortageQty > 0);
    setSelectedLineIds(computed.map((l) => l.lineId));
    const qtyByLine = {};
    computed.forEach((l) => {
      qtyByLine[l.lineId] = String(l.remainingShortageQty);
    });
    setQtyInputs(qtyByLine);
    setIndentReason(`Shortage from Production Requirement ${no}`);
    setIndentRemarks('');
    setIndentRequiredDate(rec.requiredDate || '');
  };

  const backToList = () => {
    setViewNo(null);
    setMessage(null);
  };

  const canManageRequirements = hasPermission('production.requirement.manage');

  const handleEdit = (no) => {
    if (!canManageRequirements) {
      flash('err', 'Only the Production Manager (or an Admin) can edit an Item Requirement.');
      return;
    }
    navigate(`/production/item-requirements?edit=${encodeURIComponent(no)}`);
  };

  const handleDelete = async (no) => {
    if (!canManageRequirements) {
      flash('err', 'Only the Production Manager (or an Admin) can delete an Item Requirement.');
      return;
    }
    const rec = requirements.find((r) => r.requirementNumber === no);
    if (!rec) return;
    if (rec.status === REQUIREMENT_STATUS.COMPLETED) {
      flash('err', `${no} is Completed and cannot be deleted.`);
      return;
    }
    const editable =
      rec.status === REQUIREMENT_STATUS.DRAFT || rec.status === REQUIREMENT_STATUS.CANCELLED;
    const linkedIndent = (rec.indentNumbers || [])[0];
    if (!editable && linkedIndent) {
      flash('err', `Cannot delete ${no} - Purchase Indent ${linkedIndent} was raised from it.`);
      return;
    }
    const confirmMsg = editable
      ? `Delete ${no}? This cannot be undone.`
      : `${no} is "${rec.status}".\n\nThe requirement will be cancelled and then deleted.\n\nContinue?`;
    if (!window.confirm(confirmMsg)) return;
    try {
      const rec = requirements.find((row) => row.requirementNumber === no);
      let version = Number(rec?.version) || 1;
      if (!editable) {
        const cancelled = await requirementAction(no, 'cancel', version, { reason: 'Cancelled before deletion' });
        version = Number(cancelled.record.version) || version + 1;
      }
      await deleteRequirementApi(no, version, 'Deleted by Admin from Store Item Requirements');
      const rows = await listRequirements();
      setRequirements(rows);
      flash('ok', `Item Requirement ${no} deleted.`);
      setTick((t) => t + 1);
    } catch (e) {
      flash('err', e.message);
      setTick((t) => t + 1);
    }
  };

  const handleSaveReview = async () => {
    try {
      const shortageCount = lines.filter((l) => l.shortageQty > 0).length;
      const status = shortageCount > 0 ? REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED : REQUIREMENT_STATUS.STOCK_AVAILABLE;
      const result = await requirementAction(requirement.requirementNumber, 'review', Number(requirement.version) || 1, {
        status,
        storeReview: { remarks: reviewRemarks, lines: Object.fromEntries(lines.map((line) => [line.lineId, {
          availableQty: line.availableQty,
          shortageQty: line.shortageQty,
          status: line.lineStatus,
          remarks: lineRemarks[line.lineId] || ''
        }])) }
      });
      const reviewedRecord = result.record;
      setRequirements((rows) => rows.map((row) => row.requirementNumber === reviewedRecord.requirementNumber ? reviewedRecord : row));
      const reviewed = lines;
      const shortage = reviewed.filter((l) => l.shortageQty > 0).length;
      flash(
        'ok',
        shortage > 0
          ? `Review saved — ${shortage} item(s) with shortage. Raise a Purchase Indent below.`
          : 'Review saved — all items are available in stock.'
      );
      // refresh default indent selections after review
      const remaining = reviewed.filter((l) => l.remainingShortageQty > 0);
      setSelectedLineIds(remaining.map((l) => l.lineId));
      setQtyInputs((prev) => {
        const next = { ...prev };
        remaining.forEach((l) => {
          if (next[l.lineId] === undefined) next[l.lineId] = String(l.remainingShortageQty);
        });
        return next;
      });
    } catch (e) {
      flash('err', e.message);
    }
  };

  const handleCreateIndent = async () => {
    if (!indentSyncReady) { flash('err', 'Purchase Indents are not refreshed from PostgreSQL yet. Retry after the server connection is restored.'); return; }
    try {
      const indent = await createIndentFromRequirement({
        requirementNumber: requirement.requirementNumber,
        lineIds: selectedLineIds.length ? selectedLineIds : null,
        quantities: qtyInputs,
        reason: indentReason,
        remarks: indentRemarks,
        requiredDate: indentRequiredDate
      });
      let refreshedRequirements;
      try {
        refreshedRequirements = await listRequirements();
      } catch (refreshError) {
        flash('err', `Purchase Indent ${indent.indentNumber} was created, but the requirement list could not be refreshed: ${refreshError.message}`);
        return;
      }
      setRequirements(refreshedRequirements);
      setSelectedLineIds([]);
      setIndentRemarks('');
      flash('ok', `Purchase Indent ${indent.indentNumber} created.`);
      setTick((t) => t + 1);
      navigate('/purchase-indents', { state: { openIndent: indent.indentNumber } });
    } catch (e) {
      flash('err', e.message);
    }
  };

  const runStatusAction = async (action, label) => {
    try {
      const actionName = action === 'purchaseCompleted' ? 'purchase-completed'
        : action === 'materialAvailable' ? 'material-available'
          : action === 'complete' ? 'complete' : action;
      const result = await requirementAction(requirement.requirementNumber, actionName, Number(requirement.version) || 1);
      setRequirements((rows) => rows.map((row) => row.requirementNumber === result.record.requirementNumber ? result.record : row));
      flash('ok', `${label} updated for ${requirement.requirementNumber}.`);
    } catch (e) {
      flash('err', e.message);
    }
  };

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

  /* --------------------------------- detail view --------------------------------- */
  if (requirement) {
    const reviewed = Boolean(requirement.storeReview);
    const canReview =
      requirement.status !== REQUIREMENT_STATUS.DRAFT &&
      requirement.status !== REQUIREMENT_STATUS.COMPLETED &&
      requirement.status !== REQUIREMENT_STATUS.CANCELLED;
    const shortage = lines.filter((l) => l.shortageQty > 0).length;

    return (
      <section className="page-section">
        <div className="page-header">
          <div>
            <h1 className="page-title">Item Requirement {requirement.requirementNumber}</h1>
            <p className="page-description">
              Project {requirement.projectId}
              {requirement.productionJob ? ` · Production Job: ${requirement.productionJob}` : ''} ·
              submitted by {requirement.createdBy}
              {requirement.submittedAt ? ` on ${requirement.submittedAt}` : ''}
            </p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={backToList}>← Back to Items to Review</button>
          </div>
        </div>

        {messageBox}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Requirement Details</h3>
            <span className={badgeClass(requirement.status)}>{requirement.status}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            <div><strong>Requirement No:</strong> {requirement.requirementNumber}</div>
            <div><strong>Project ID:</strong> {requirement.projectId || '—'}</div>
            <div><strong>Sales Order:</strong> {requirement.soNumber || '—'}</div>
            <div><strong>Job Card:</strong> {requirement.jobCardNumber || '—'}</div>
            <div><strong>Customer:</strong> {requirement.customer || '—'}</div>
            <div><strong>Part / Product:</strong> {requirement.partName || '—'}</div>
            <div><strong>Production Job:</strong> {requirement.productionJob || '—'}</div>
            <div><strong>Required Date:</strong> {requirement.requiredDate || '—'}</div>
            <div>
              <strong>Store Review:</strong>{' '}
              {reviewed
                ? `${requirement.storeReview.reviewedBy} · ${requirement.storeReview.reviewedAt}`
                : 'Not reviewed yet'}
            </div>
            <div><strong>Created By:</strong> {requirement.createdBy} ({requirement.createdByDept})</div>
          </div>
        </div>

        {canReview && (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Stock Availability Check</h3>
              <span className={badgeClass(shortage > 0 ? 'Shortage Identified' : 'Stock Available')}>
                {shortage > 0 ? `${shortage} item(s) in shortage` : 'All available'}
              </span>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Material</th>
                    <th>Required</th>
                    <th>Unit</th>
                    <th>Current Stock</th>
                    <th>Reserved</th>
                    <th>Available</th>
                    <th>Shortage</th>
                    <th>Already Indented</th>
                    <th>To Purchase</th>
                    <th>Status</th>
                    <th>Store Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.lineId}>
                      <td>{l.lineNo}</td>
                      <td>
                        <strong>{l.itemName}</strong>
                        {!l.inventoryMatched && <span className={badgeClass('Not In Stock')}>Not in inventory</span>}
                      </td>
                      <td>{qty(l.requiredQty)}</td>
                      <td>{l.unit}</td>
                      <td>{qty(l.currentStock)}</td>
                      <td>{qty(l.reservedQty)}</td>
                      <td style={{ color: '#166534', fontWeight: 700 }}>{qty(l.availableQty)}</td>
                      <td style={{ color: l.shortageQty > 0 ? '#b91c1c' : '#166534', fontWeight: 700 }}>
                        {qty(l.shortageQty)}
                      </td>
                      <td>{qty(l.indentedQty) || '—'}</td>
                      <td style={{ fontWeight: 700, color: l.remainingShortageQty > 0 ? '#b91c1c' : '#166534' }}>
                        {qty(l.remainingShortageQty)}
                      </td>
                      <td><span className={badgeClass(l.lineStatus)}>{l.lineStatus}</span></td>
                      <td>
                        <input
                          type="text"
                          className="form-input"
                          value={lineRemarks[l.lineId] || ''}
                          onChange={(e) =>
                            setLineRemarks((prev) => ({ ...prev, [l.lineId]: e.target.value }))
                          }
                          placeholder="Remarks"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="field-group full-width" style={{ marginTop: '14px' }}>
              <label>Store remarks</label>
              <textarea
                rows="2"
                value={reviewRemarks}
                onChange={(e) => setReviewRemarks(e.target.value)}
                placeholder="Observations during the stock review..."
              />
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="button-primary" onClick={handleSaveReview}>
                {reviewed ? 'Re-save Stock Review' : 'Save Stock Review'}
              </button>
            </div>
          </div>
        )}

        {canReview && shortageLines.length > 0 && (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">
                Create Purchase Indent ({shortageLines.length} item(s) with pending shortage)
              </h3>
              <span className={badgeClass('Purchase Required')}>Shortage only</span>
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
                    <th>Shortage</th>
                    <th>Already Indented</th>
                    <th>Purchase Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {shortageLines.map((l, idx) => {
                    const checked = selectedLineIds.includes(l.lineId);
                    return (
                      <tr key={l.lineId}>
                        <td>{idx + 1}</td>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setSelectedLineIds((prev) =>
                                e.target.checked
                                  ? [...prev.filter((id) => id !== l.lineId), l.lineId]
                                  : prev.filter((id) => id !== l.lineId)
                              )
                            }
                          />
                        </td>
                        <td>
                          <strong>{l.itemName}</strong>
                        </td>
                        <td>{l.unit}</td>
                        <td>{qty(l.requiredQty)}</td>
                        <td>{qty(l.availableQty)}</td>
                        <td style={{ color: '#b91c1c', fontWeight: 700 }}>{qty(l.shortageQty)}</td>
                        <td>{qty(l.indentedQty) || '—'}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            max={l.remainingShortageQty}
                            className="form-input"
                            style={{ width: '90px' }}
                            value={qtyInputs[l.lineId] ?? String(l.remainingShortageQty)}
                            onChange={(e) =>
                              setQtyInputs((prev) => ({ ...prev, [l.lineId]: e.target.value }))
                            }
                            disabled={!checked}
                          />
                          <div className="muted-text">max {l.remainingShortageQty}</div>
                        </td>
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
                <input
                  type="date"
                  value={indentRequiredDate}
                  onChange={(e) => setIndentRequiredDate(e.target.value)}
                />
              </div>
              <div className="field-group full-width">
                <label>Store remarks</label>
                <textarea rows="2" value={indentRemarks} onChange={(e) => setIndentRemarks(e.target.value)} />
              </div>
            </div>

            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="button-primary" onClick={handleCreateIndent} disabled={!indentSyncReady}>
                Create Purchase Indent ({selectedLineIds.length} item(s))
              </button>
            </div>
          </div>
        )}

        {indents.length > 0 && (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Linked Purchase Indents ({indents.length})</h3>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Indent No</th>
                    <th>Date</th>
                    <th>Materials</th>
                    <th>Purchase Qty</th>
                    <th>Status</th>
                    <th>PO</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {indents.map((i) => (
                    <tr key={i.indentNumber}>
                      <td><strong>{i.indentNumber}</strong></td>
                      <td>{i.indentDate}</td>
                      <td>{i.items}</td>
                      <td>{i.purchaseQty}</td>
                      <td><span className={badgeClass(i.status)}>{i.status}</span></td>
                      <td>{i.poNumber || '—'}</td>
                      <td>
                        <button
                          className="button-small button-secondary"
                          onClick={() =>
                            navigate('/purchase-indents', { state: { openIndent: i.indentNumber } })
                          }
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {canReview && (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Progress Actions</h3>
            </div>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              {requirement.status === REQUIREMENT_STATUS.PURCHASE_REQUIRED && (
                <button
                  className="button-primary"
                  onClick={() => runStatusAction('purchaseCompleted', 'Purchase completed')}
                >
                  Mark Purchase Completed
                </button>
              )}
              {[
                REQUIREMENT_STATUS.PURCHASE_COMPLETED,
                REQUIREMENT_STATUS.STOCK_AVAILABLE,
                REQUIREMENT_STATUS.SHORTAGE_IDENTIFIED,
                REQUIREMENT_STATUS.PURCHASE_REQUIRED
              ].includes(requirement.status) && (
                <button
                  className="button-primary"
                  onClick={() => runStatusAction('materialAvailable', 'Material available')}
                >
                  Mark Material Available
                </button>
              )}
              {requirement.status === REQUIREMENT_STATUS.MATERIAL_AVAILABLE && (
                <button
                  className="button-primary"
                  onClick={() => runStatusAction('complete', 'Requirement completed')}
                >
                  Mark Completed (hand over to Production)
                </button>
              )}
            </div>
          </div>
        )}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">History</h3>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Details</th>
                  <th>By</th>
                  <th>At</th>
                </tr>
              </thead>
              <tbody>
                {(requirement.history || []).map((h, idx) => (
                  <tr key={`${h.at}-${idx}`}>
                    <td><strong>{h.action}</strong></td>
                    <td>{h.details || '—'}</td>
                    <td>{h.name || '—'}</td>
                    <td>{h.at || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    );
  }

  /* --------------------------------- list view --------------------------------- */
  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Items to Review</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      {messageBox}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Item Requirements ({filtered.length})</h3>
        </div>
        <div className="list-filters">
          <input
            type="text"
            className="action-select form-input search-input"
            placeholder="Search requirement / project / production job / customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="action-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="All">All Statuses</option>
            {Object.values(REQUIREMENT_STATUS)
              .filter((s) => s !== REQUIREMENT_STATUS.DRAFT)
              .map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
          </select>
        </div>

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Req No</th>
                <th>Date</th>
                <th>Project ID</th>
                <th>Production Job</th>
                <th>Sales Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Submitted By</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="10" className="no-history-row">
                    No Item Requirements awaiting Store action.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.requirementNumber}>
                    <td><strong>{r.requirementNumber}</strong></td>
                    <td>{r.requirementDate}</td>
                    <td>{r.projectId || '—'}</td>
                    <td>{r.productionJob || '—'}</td>
                    <td>{r.soNumber || '—'}</td>
                    <td>{r.customer || '—'}</td>
                    <td>{r.items?.length || 0}</td>
                    <td>{r.createdBy || '—'}</td>
                    <td><span className={badgeClass(r.status)}>{r.status}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                          className="button-small button-secondary"
                          onClick={() => openRequirement(r.requirementNumber)}
                        >
                          {r.status === REQUIREMENT_STATUS.PENDING_REVIEW ? 'Review' : 'View'}
                        </button>
                        <button
                          className="button-small button-secondary"
                          onClick={() => handleEdit(r.requirementNumber)}
                        >
                          Edit
                        </button>
                        {isAdmin() && <button
                          className="button-small button-secondary"
                          style={{ color: '#dc2626', borderColor: '#fca5a5' }}
                          onClick={() => handleDelete(r.requirementNumber)}
                        >
                          Delete
                        </button>}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isAdmin() && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Availability check legacy reconciliation</h3>
            <button type="button" className="button-secondary" onClick={loadAvailabilityPreview}>Preview legacy records</button>
          </div>
          <p className="muted-text">Preview and selectively import eligible legacy checks. Conflicts are not imported, and the legacy snapshot is preserved.</p>
          {availabilityPreview && (
            <>
              <p className="muted-text">
                Eligible: {availabilityPreview.counts?.eligible || 0} · Already present: {availabilityPreview.counts?.existing || 0} · Conflicts: {availabilityPreview.counts?.conflicts || 0}
              </p>
              <div className="history-table-wrapper">
                <table className="history-table">
                  <thead><tr><th>Select</th><th>Sales Order</th><th>Checked By</th><th>Checked At</th><th>Remarks</th></tr></thead>
                  <tbody>
                    {(availabilityPreview.eligible || []).map(({ soNumber, record }) => (
                      <tr key={soNumber}>
                        <td><input aria-label={`Select ${soNumber}`} type="checkbox" checked={selectedLegacyChecks.includes(soNumber)} onChange={(event) => setSelectedLegacyChecks((items) => event.target.checked ? [...items, soNumber] : items.filter((item) => item !== soNumber))} /></td>
                        <td><strong>{soNumber}</strong></td><td>{record.checkedBy || '—'}</td><td>{record.checkedDate || record.checkedAt || '—'}</td><td>{record.remarks || '—'}</td>
                      </tr>
                    ))}
                    {(availabilityPreview.conflicts || []).map((item, index) => (
                      <tr key={`conflict-${item.soNumber}-${index}`}><td>—</td><td>{item.soNumber || '—'}</td><td colSpan="3">{item.reason}</td></tr>
                    ))}
                    {!(availabilityPreview.eligible || []).length && !(availabilityPreview.conflicts || []).length && (
                      <tr><td colSpan="5" className="no-history-row">No legacy availability checks need reconciliation.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <button type="button" className="button-primary" disabled={!selectedLegacyChecks.length || availabilityImportBusy} onClick={importSelectedAvailabilityChecks}>
                {availabilityImportBusy ? 'Importing…' : `Import selected (${selectedLegacyChecks.length})`}
              </button>
            </>
          )}
        </div>
      )}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Legacy — Sales Order material checks (read-only)</h3>
          <span className={badgeClass('Archived')}>Old workflow · data preserved</span>
        </div>
        <p className="muted-text" style={{ marginBottom: '10px' }}>
          Sales Order availability checks created before the Item Requirement workflow. Existing records are kept
          for traceability; new checks now originate from Production Item Requirements.
        </p>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SO Number</th>
                <th>Checked By</th>
                <th>Checked At</th>
                <th>Lines</th>
                <th>With Shortage</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {legacyChecks.length === 0 ? (
                <tr>
                  <td colSpan="6" className="no-history-row">No legacy Sales Order checks recorded.</td>
                </tr>
              ) : (
                legacyChecks.map((c, idx) => (
                  <tr key={`${c.soNumber || 'so'}-${idx}`}>
                    <td><strong>{c.soNumber || '—'}</strong></td>
                    <td>{c.checkedBy || '—'}</td>
                    <td>{c.checkedDate || c.checkedAt || '—'}</td>
                    <td>{(c.lines || []).length}</td>
                    <td>
                      {(c.lines || []).filter((l) => qty(l.shortageQty) > 0).length}
                    </td>
                    <td>{c.remarks || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

export default StoreItemRequirementsPage;
