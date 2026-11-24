import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import { hasPermission } from '../utils/permissions.js';
import MaterialNameSelector from '../components/MaterialNameSelector.jsx';
import {
  REQUIREMENT_STATUS,
  getRequirements,
  getRequirement,
  computeRequirementLines,
  getRequirementIndents,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  submitRequirement,
  cancelRequirement
} from '../utils/productionRequirementService.js';
import { getSalesOrders, getSalesOrderByRef } from '../utils/workflowService.js';
import { getFullProjectData } from '../utils/projectTracker.js';
import { getInventoryItems } from '../utils/storeService.js';
import { saveWorkflowDocument, deleteWorkflowDocument, openWorkflowDocument } from '../utils/workflowFiles.js';
import { getDrawingInfo, openDrawing, attachDrawing, hasEnquiryDrawing } from '../utils/drawingLookup.js';

const badgeClass = (status) =>
  `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/* Draft / Cancelled requirements can be edited and deleted outright; any other
   status has to be cancelled first (the action buttons guide the user). */
const isRequirementEditable = (rec) =>
  !!rec && (rec.status === REQUIREMENT_STATUS.DRAFT || rec.status === REQUIREMENT_STATUS.CANCELLED);

const qty = (v) => Number(v) || 0;

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Two rows reference the same material (by itemId, else item code, else name). */
const isSameMaterial = (a, b) => {
  if (a.itemId && b.itemId) return String(a.itemId) === String(b.itemId);
  if (a.itemCode && b.itemCode) return sameText(a.itemCode, b.itemCode);
  return sameText(a.itemName, b.itemName);
};

const READONLY_CELL = { background: '#f1f5f9', cursor: 'default' };

const emptyLine = () => ({
  lineId: undefined,
  itemId: '',
  itemName: '',
  itemCode: '',
  description: '',
  specification: '',
  size: '',
  purpose: '',
  quantity: '',
  unit: 'Nos',
  requiredDate: '',
  remarks: ''
});

/* Units offered in the "Unit" column (a value coming from an older record or
   the Item Master that is not listed is kept as an extra option). */
const UNIT_OPTIONS = [
  'Nos', 'Set', 'Pair', 'Kit', 'Assembly', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Bundle'
];

const blankForm = () => ({
  projectId: '',
  soNumber: '',
  jobCardNumber: '',
  customer: '',
  partName: '',
  productionJob: '',
  drawingNo: '',
  qty: '',
  requiredDate: '',
  attachments: [],
  items: [emptyLine()]
});

/** Drawing No + total enquiry quantity for a project (Enquiry / Sales Order line items). */
const enquiryDrawingInfo = (pid) => {
  const items = (pid ? getFullProjectData(pid) : null)?.items || [];
  const drawingNo = items.map((it) => String(it.drawingNo || '').trim()).find(Boolean) || '';
  const totalQty = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  return { drawingNo, qty: totalQty > 0 ? String(totalQty) : '' };
};

/** Every drawing number of a project, in enquiry order (no duplicates). */
const enquiryDrawingNumbers = (pid) => {
  const items = (pid ? getFullProjectData(pid) : null)?.items || [];
  return [...new Set(items.map((it) => String(it.drawingNo || '').trim()).filter(Boolean))];
};

const ProductionItemRequirementsPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [mode, setMode] = useState('list'); // list | form | view
  const [viewNo, setViewNo] = useState(null);
  const [editingNo, setEditingNo] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [message, setMessage] = useState(null);
  const [tick, setTick] = useState(0);

  /* Defence in depth: the route Guard and the sidebar already hide this screen
     from a Production Employee — this keeps the mutations safe if either is
     ever bypassed. Only the Production Manager (and Admin) may manage. */
  const canManage = hasPermission('production.requirement.manage');
  const denyManage = () => flash('err', 'Only the Production Manager (or an Admin) can manage Item Requirements.');

  const salesOrders = useMemo(() => getSalesOrders(), [tick]);
  const requirements = useMemo(() => getRequirements(), [tick]);
  const inventoryRecords = useMemo(() => getInventoryItems(), [tick, mode]);

  /* Drawings of the selected project: several → user picks one, one → read-only. */
  const drawingOptions = useMemo(() => {
    const list = enquiryDrawingNumbers(form.projectId);
    const current = String(form.drawingNo || '').trim();
    if (current && !list.includes(current)) list.push(current);
    return list;
  }, [form.projectId, form.drawingNo]);

  /** Item Master record for a line that was chosen via the Material Name selector. */
  const masterOf = (it) => {
    const id = String(it?.itemId || '').trim();
    if (!id) return null;
    const lower = id.toLowerCase();
    return (
      inventoryRecords.find(
        (x) => String(x.id || '').trim() === id || String(x.itemCode || '').toLowerCase() === lower
      ) || null
    );
  };

  /* Deep links: /production/item-requirements?req=PR-0001 (?edit=PR-0001 opens the form) or location state. */
  useEffect(() => {
    const wanted =
      searchParams.get('req') ||
      location.state?.openRequirement ||
      location.state?.requirementNumber;
    if (wanted && getRequirement(wanted)) {
      setViewNo(wanted);
      setMode('view');
      if (searchParams.get('req')) setSearchParams({}, { replace: true });
    }
    const wantedEdit = searchParams.get('edit');
    if (wantedEdit && getRequirement(wantedEdit)) {
      handleEditClick(wantedEdit);
      setSearchParams({}, { replace: true });
    }
    if (location.state?.newRequirement) openCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (type, text) => {
    setMessage({ type, text });
    setTick((t) => t + 1);
    setTimeout(() => setMessage(null), 6000);
  };

  const requirement = mode === 'view' && viewNo ? getRequirement(viewNo) : null;

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return requirements.filter((r) => {
      if (statusFilter !== 'All' && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.requirementNumber, r.projectId, r.productionJob, r.soNumber, r.customer, r.partName]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [requirements, search, statusFilter]);

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const setLine = (idx, key, value) =>
    setForm((f) => {
      const items = f.items.map((it, i) => (i === idx ? { ...it, [key]: value } : it));
      return { ...f, items };
    });

  const addLine = () => setForm((f) => ({ ...f, items: [...f.items, emptyLine()] }));

  const removeLine = (idx) =>
    setForm((f) => ({
      ...f,
      items: f.items.length > 1 ? f.items.filter((_, i) => i !== idx) : f.items
    }));

  /**
   * Commit an Item Master selection for a row: auto-populate the master fields
   * (item code / description / specification / unit) and store the record's
   * unique id. Returns false when the item is already in the list so the
   * selector can keep the previous value.
   */
  const handleMaterialSelect = (idx, item) => {
    const duplicate = form.items.some(
      (r, i) => i !== idx && isSameMaterial(r, { itemId: item.id || '', itemCode: item.itemCode, itemName: item.itemName })
    );
    if (duplicate) {
      flash('err', 'This item is already added to the requirement.');
      return false;
    }
    setForm((f) => ({
      ...f,
      items: f.items.map((it, i) =>
        i === idx
          ? {
              ...it,
              itemId: String(item.id || item.itemCode || ''),
              itemName: item.itemName || '',
              itemCode: item.itemCode || '',
              description: item.description || '',
              specification: item.specification || item.spec || '',
              unit: item.unit || it.unit || 'Nos'
            }
          : it
      )
    }));
    return true;
  };

  const handleMaterialClear = (idx) => {
    setForm((f) => ({
      ...f,
      items: f.items.map((it, i) =>
        i === idx
          ? { ...it, itemId: '', itemName: '', itemCode: '', description: '', specification: '', unit: 'Nos' }
          : it
      )
    }));
  };

  /**
   * Project ID / Drawing No chosen → copy the drawing PDF the Sales team
   * uploaded with the Enquiry onto the record's attachments (a previous
   * auto-fetched drawing is replaced, a file the user attached by hand is
   * never touched).
   */
  const syncDrawingPdf = async (projectId, drawingNo) => {
    const pid = String(projectId || '').trim();
    const dwg = String(drawingNo || '').trim();
    if (!pid || !dwg) return;

    /* drop the auto-fetched file of the drawing we are switching away from */
    setForm((f) => {
      const stale = (f.attachments || []).filter(
        (d) => d && d.source === 'enquiry drawing' && String(d.drawingNo) !== dwg
      );
      if (!stale.length) return f;
      stale.forEach((d) => deleteWorkflowDocument(d.id));
      return {
        ...f,
        attachments: (f.attachments || []).filter(
          (d) => !(d && d.source === 'enquiry drawing' && String(d.drawingNo) !== dwg)
        )
      };
    });

    let info = { found: false, drawingNo: dwg, fileName: '' };
    try {
      info = await getDrawingInfo(pid, dwg);
    } catch (err) {
      console.error('Drawing auto-fetch failed', err);
    }
    if (!info.found) return;

    const meta = await attachDrawing(pid, dwg);
    if (!meta) return;
    setForm((f) => {
      const current = f.attachments || [];
      const alreadyAuto = current.some(
        (d) => d && d.source === 'enquiry drawing' && String(d.drawingNo) === dwg
      );
      const sameFileManually = current.some((d) => d && d.name === meta.name);
      if (alreadyAuto || sameFileManually) {
        deleteWorkflowDocument(meta.id);
        return f;
      }
      return { ...f, attachments: [...current, meta] };
    });
  };

  const handleSOChange = (ref) => {
    const so = ref ? getSalesOrderByRef(ref) : null;
    const projectId = (so && so.payload?.soDetails?.projectId) || form.projectId;
    setForm((f) => ({
      ...f,
      soNumber: ref,
      projectId,
      customer:
        so?.payload?.customerDetails?.companyName ||
        so?.payload?.customerDetails?.customerName ||
        so?.company ||
        f.customer,
      requiredDate: f.requiredDate || so?.payload?.soDetails?.deliveryDate || '',
      partName: f.partName || (so?.payload?.items?.[0]?.itemName || ''),
      ...enquiryDrawingInfo(projectId)
    }));
    syncDrawingPdf(projectId, enquiryDrawingInfo(projectId).drawingNo);
  };

  /** Project ID typed → pull Drawing No & Qty from the enquiry automatically. */
  const handleProjectIdChange = (value) => {
    const info = enquiryDrawingInfo(value);
    setForm((f) => ({ ...f, projectId: value, ...info }));
    syncDrawingPdf(value, info.drawingNo);
  };

  /** A project holds several drawings → switch which one the requirement is for. */
  const handleDrawingChange = (drawingNo) => {
    setForm((f) => ({ ...f, drawingNo }));
    syncDrawingPdf(form.projectId, drawingNo);
  };

  /* ------------------------------ attachments ------------------------------ */
  const handleAttachmentUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    try {
      const metas = await Promise.all(files.map((file) => saveWorkflowDocument(file)));
      setForm((f) => ({ ...f, attachments: [...(f.attachments || []), ...metas] }));
      flash('ok', `${metas.length} file(s) attached.`);
    } catch (e) {
      flash('err', `Could not save the file: ${e.message}`);
    }
  };

  const removeAttachment = async (docId) => {
    await deleteWorkflowDocument(docId);
    setForm((f) => ({ ...f, attachments: (f.attachments || []).filter((d) => d.id !== docId) }));
  };

  /** Files uploaded while editing but never saved are removed from storage. */
  const discardUnsavedAttachments = () => {
    const saved = editingNo ? getRequirement(editingNo) : null;
    const savedIds = new Set((saved?.attachments || []).map((d) => d && d.id));
    (form.attachments || []).forEach((d) => {
      if (d && d.id && !savedIds.has(d.id)) deleteWorkflowDocument(d.id);
    });
  };

  const validate = () => {
    if (!form.projectId.trim()) return 'Project ID is required.';
    if (!form.items.length) return 'Add at least one item.';
    for (let i = 0; i < form.items.length; i += 1) {
      const it = form.items[i];
      const name = String(it.itemName || '').trim();
      /* New rows must be picked from the Inventory / Item Master; rows loaded
         from a saved record (legacy, no itemId) or imported from the enquiry
         keep the material typed against the drawing. */
      if (!name || (!it.itemId && !it.fromSaved && !it.fromEnquiry)) {
        return 'Please select a material/item from Inventory.';
      }
      for (let j = i + 1; j < form.items.length; j += 1) {
        if (isSameMaterial(it, form.items[j])) return 'This item is already added to the requirement.';
      }
      if (qty(it.quantity) <= 0) return `Item #${i + 1}: quantity must be greater than zero.`;
    }
    return null;
  };

  const payload = () => ({
    projectId: form.projectId.trim(),
    soNumber: form.soNumber.trim(),
    jobCardNumber: form.jobCardNumber.trim(),
    customer: form.customer.trim(),
    partName: form.partName.trim(),
    productionJob: form.productionJob.trim(),
    drawingNo: form.drawingNo.trim(),
    qty: qty(form.qty),
    requiredDate: form.requiredDate,
    attachments: form.attachments || [],
    items: form.items.map((it) => ({
      lineId: it.lineId,
      itemId: it.itemId || '',
      itemName: it.itemName,
      itemCode: it.itemCode,
      description: it.description,
      specification: it.specification,
      size: it.size,
      purpose: it.purpose,
      quantity: qty(it.quantity),
      unit: it.unit,
      requiredDate: it.requiredDate,
      remarks: it.remarks
    }))
  });

  const openCreate = () => {
    if (!canManage) return denyManage();
    setForm(blankForm());
    setEditingNo(null);
    setMode('form');
    setMessage(null);
  };

  const openEdit = (no) => {
    if (!canManage) return denyManage();
    const rec = getRequirement(no);
    if (!rec) return;
    setForm({
      projectId: rec.projectId || '',
      soNumber: rec.soNumber || '',
      jobCardNumber: rec.jobCardNumber || '',
      customer: rec.customer || '',
      partName: rec.partName || '',
      productionJob: rec.productionJob || '',
      drawingNo: rec.drawingNo || '',
      qty: rec.qty === undefined || rec.qty === null ? '' : String(rec.qty),
      requiredDate: rec.requiredDate || '',
      attachments: rec.attachments || [],
      items: (rec.items || []).map((it) => ({ ...it, quantity: String(it.quantity ?? ''), fromSaved: true }))
    });
    setEditingNo(no);
    setMode('form');
    setMessage(null);
    /* never re-attach the enquiry drawing silently when reopening a saved
       record — the copy is already on it, or the user removed it */
  };

  const openView = (no) => {
    setViewNo(no);
    setMode('view');
    setMessage(null);
  };

  const handleSave = (thenSubmit = false) => {
    if (!canManage) return denyManage();
    const err = validate();
    if (err) {
      flash('err', err);
      return;
    }
    try {
      const rec = editingNo
        ? updateRequirement(editingNo, payload())
        : createRequirement(payload());
      if (thenSubmit) {
        submitRequirement(rec.requirementNumber);
        flash('ok', `Item Requirement ${rec.requirementNumber} submitted to Store.`);
      } else {
        flash('ok', `Item Requirement ${rec.requirementNumber} saved as draft.`);
      }
      setMode('list');
      setEditingNo(null);
      setTick((t) => t + 1);
    } catch (e) {
      flash('err', e.message);
    }
  };

  const handleSubmitOnly = () => {
    if (!editingNo) {
      handleSave(true);
      return;
    }
    try {
      const err = validate();
      if (err) {
        flash('err', err);
        return;
      }
      updateRequirement(editingNo, payload());
      submitRequirement(editingNo);
      flash('ok', `Item Requirement ${editingNo} submitted to Store.`);
      setMode('list');
      setEditingNo(null);
      setTick((t) => t + 1);
    } catch (e) {
      flash('err', e.message);
    }
  };

  const handleDelete = (no) => {
    if (!canManage) return denyManage();
    const rec = getRequirement(no);
    if (!rec) return;
    if (rec.status === REQUIREMENT_STATUS.COMPLETED) {
      flash('err', `${no} is Completed and cannot be deleted.`);
      return;
    }
    const editable = isRequirementEditable(rec);
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
      if (!editable) cancelRequirement(no, 'Cancelled before deletion');
      deleteRequirement(no);
      flash('ok', `Item Requirement ${no} deleted.`);
      setMode('list');
      setTick((t) => t + 1);
    } catch (e) {
      flash('err', e.message);
      setTick((t) => t + 1);
    }
  };

  const handleEditClick = (no) => {
    if (!canManage) return denyManage();
    const rec = getRequirement(no);
    if (!rec) return;
    if (isRequirementEditable(rec)) {
      openEdit(no);
      return;
    }
    if (rec.status === REQUIREMENT_STATUS.COMPLETED) {
      flash('err', `${no} is Completed and cannot be edited.`);
      return;
    }
    const ok = window.confirm(
      `${no} is "${rec.status}".\n\nEditing will cancel this requirement and re-open it as a Draft, so Store must review it again.\n\nContinue?`
    );
    if (!ok) return;
    try {
      cancelRequirement(no, 'Editing started - re-opened for revision');
      updateRequirement(no, {});
      openEdit(no);
      setTick((t) => t + 1);
    } catch (e) {
      flash('err', e.message);
    }
  };

  const handleSubmit = (no) => {
    try {
      submitRequirement(no);
      flash('ok', `Item Requirement ${no} submitted to Store.`);
      setMode('list');
      setTick((t) => t + 1);
    } catch (e) {
      flash('err', e.message);
    }
  };

  const handleCancelRequirement = (no) => {
    try {
      cancelRequirement(no, 'Cancelled from Production screen');
      flash('ok', `Item Requirement ${no} cancelled.`);
      setTick((t) => t + 1);
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

  /* --------------------------------- form view --------------------------------- */
  if (mode === 'form') {
    return (
      <section className="page-section">
        <div className="page-header">
          <div>
            <div className="eyebrow">Production / Store</div>
            <h1 className="page-title">
              {editingNo ? `Edit Item Requirement ${editingNo}` : 'New Item Requirement (Required Item List)'}
            </h1>
            <p className="page-description">
              List every material required for this project / production job. On submit, Store is notified and
              reviews stock availability — shortages flow into Purchase Indents.
            </p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            <button className="button-secondary" onClick={() => { discardUnsavedAttachments(); setMode('list'); setMessage(null); }}>
              ← Back
            </button>
          </div>
        </div>

        {messageBox}

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Requirement Details</h3>
            <span className={badgeClass(REQUIREMENT_STATUS.DRAFT)}>Draft</span>
          </div>
          <div className="section-grid">
            <div className="field-group">
              <label>Project ID *</label>
              <input
                type="text"
                value={form.projectId}
                onChange={(e) => handleProjectIdChange(e.target.value)}
                placeholder="e.g. PRJ-2026-001"
              />
            </div>
            <div className="field-group">
              <label>Sales Order Ref</label>
              <select value={form.soNumber} onChange={(e) => handleSOChange(e.target.value)}>
                <option value="">— Select Sales Order —</option>
                {salesOrders.map((so) => (
                  <option key={so.reference} value={so.reference}>
                    {so.reference} — {so.company}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label>Customer</label>
              <input type="text" value={form.customer} onChange={(e) => setField('customer', e.target.value)} />
            </div>
            <div className="field-group">
              <label>
                Drawing No <span style={{ color: '#64748b', fontWeight: 400 }}>(from enquiry)</span>
                {drawingOptions.length > 1 && (
                  <span style={{ color: '#2563eb', fontWeight: 500 }}> · pick one</span>
                )}
              </label>
              {drawingOptions.length > 1 ? (
                <select
                  value={form.drawingNo}
                  onChange={(e) => handleDrawingChange(e.target.value)}
                  title="Choose which drawing of this project the requirement is for"
                >
                  <option value="">Select drawing</option>
                  {drawingOptions.map((dn) => (
                    <option key={dn} value={dn}>
                      {dn}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={form.drawingNo}
                  readOnly
                  placeholder="Auto-filled from enquiry"
                  style={{ background: '#f1f5f9', cursor: 'default' }}
                />
              )}
            </div>
            <div className="field-group">
              <label>Qty <span style={{ color: '#64748b', fontWeight: 400 }}>(from enquiry)</span></label>
              <input
                type="text"
                value={form.qty}
                readOnly
                placeholder="Auto-filled from enquiry"
                style={{ background: '#f1f5f9', cursor: 'default' }}
              />
            </div>
            <div className="field-group">
              <label>Required Date</label>
              <input
                type="date"
                value={form.requiredDate}
                onChange={(e) => setField('requiredDate', e.target.value)}
              />
            </div>
            <div className="field-group" style={{ gridColumn: '1 / -1' }}>
              <label>Attachment</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                <label
                  className="button-small button-secondary"
                  style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  title="Attach enquiry PDF / drawing / supporting file"
                >
                  📎 Upload File
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv"
                    style={{ display: 'none' }}
                    onChange={handleAttachmentUpload}
                  />
                </label>
                {(form.attachments || []).map((d) => (
                  <span key={d.id} className="status-badge st-attached" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => openWorkflowDocument(d)}
                      title="Open attachment"
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
                    >
                      {d.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAttachment(d.id)}
                      title="Remove attachment"
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', fontWeight: 700 }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {!(form.attachments || []).length && (
                  <span className="muted-text" style={{ fontSize: '11.5px' }}>No file attached</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Required Items ({form.items.length})</h3>
            <button className="button-small button-secondary" onClick={addLine}>+ Add Material</button>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table item-req-table">
              <thead>
                <tr>
                  <th style={{ width: '68px' }}>SL.No</th>
                  <th>Material *</th>
                  <th style={{ width: '90px' }}>Qty *</th>
                  <th style={{ width: '110px' }}>Unit</th>
                  <th style={{ width: '130px' }}>Grade / Spec</th>
                  <th style={{ width: '130px' }}>Size</th>
                  <th style={{ width: '130px' }}>Purpose</th>
                  <th style={{ width: '54px' }}></th>
                </tr>
              </thead>
              <tbody>
                {form.items.map((it, idx) => {
                  const master = masterOf(it);
                  const specFromMaster = Boolean(master && String(master.specification || master.spec || '').trim());
                  return (
                  <tr key={it.lineId || `new-${idx}`}>
                    <td style={{ textAlign: 'center', color: '#94a3b8', fontWeight: 600 }}>{idx + 1}</td>
                    <td>
                      <MaterialNameSelector
                        value={it.itemName || ''}
                        onSelect={(item) => handleMaterialSelect(idx, item)}
                        onClear={() => handleMaterialClear(idx)}
                        showAvailability={false}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        className="action-select form-input"
                        value={it.quantity}
                        onChange={(e) => setLine(idx, 'quantity', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="action-select form-input"
                        value={it.unit}
                        disabled={Boolean(it.itemId)}
                        title={it.itemId ? 'From Inventory Item Master' : ''}
                        style={it.itemId ? READONLY_CELL : undefined}
                        onChange={(e) => setLine(idx, 'unit', e.target.value)}
                      >
                        {!it.unit && <option value="">— Unit —</option>}
                        {it.unit && !UNIT_OPTIONS.includes(it.unit) && (
                          <option value={it.unit}>{it.unit}</option>
                        )}
                        {UNIT_OPTIONS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        className="action-select form-input"
                        value={it.specification}
                        readOnly={specFromMaster}
                        title={specFromMaster ? 'From Inventory Item Master' : ''}
                        style={specFromMaster ? READONLY_CELL : undefined}
                        placeholder="e.g. EN8"
                        onChange={(e) => setLine(idx, 'specification', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="action-select form-input"
                        value={it.size}
                        placeholder="e.g. 50mm dia"
                        onChange={(e) => setLine(idx, 'size', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="action-select form-input"
                        value={it.purpose}
                        placeholder="e.g. Main body"
                        onChange={(e) => setLine(idx, 'purpose', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        className="button-small button-secondary"
                        onClick={() => removeLine(idx)}
                        disabled={form.items.length === 1}
                        title="Remove item"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: '14px' }}>
            <button className="button-primary" onClick={() => handleSave(false)}>
              {editingNo ? 'Save Changes' : 'Save Draft'}
            </button>
            <button className="button-primary" onClick={handleSubmitOnly}>
              Submit to Store
            </button>
            <button
              className="button-secondary"
              onClick={() => { discardUnsavedAttachments(); setMode('list'); setMessage(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  /* --------------------------------- view --------------------------------- */
  if (mode === 'view') {
    if (!requirement) {
      setMode('list');
      return null;
    }
    const lines = computeRequirementLines(requirement);
    const indents = getRequirementIndents(requirement.requirementNumber);
    const isDraft = requirement.status === REQUIREMENT_STATUS.DRAFT;
    const shortage = lines.filter((l) => l.shortageQty > 0).length;

    return (
      <section className="page-section">
        <div className="page-header">
          <div>
            <div className="eyebrow">Production / Store</div>
            <h1 className="page-title">Item Requirement {requirement.requirementNumber}</h1>
            <p className="page-description">
              Project {requirement.projectId}
              {requirement.productionJob ? ` · Production Job: ${requirement.productionJob}` : ''} ·{' '}
              {requirement.items?.length || 0} item(s)
            </p>
          </div>
          <div className="header-actions">
            <NotificationsPanel />
            {canManage && requirement.status !== REQUIREMENT_STATUS.COMPLETED && (
              <button className="button-primary" onClick={() => handleEditClick(requirement.requirementNumber)}>
                Edit
              </button>
            )}
            {isDraft && (
              <button
                className="button-primary"
                onClick={() => handleSubmit(requirement.requirementNumber)}
              >
                Submit to Store
              </button>
            )}
            <button className="button-secondary" onClick={() => { setMode('list'); setMessage(null); }}>
              ← Back
            </button>
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
            <div><strong>Created:</strong> {requirement.requirementDate} by {requirement.createdBy}</div>
            <div><strong>Project ID:</strong> {requirement.projectId || '—'}</div>
            <div><strong>Sales Order:</strong> {requirement.soNumber || '—'}</div>
            <div><strong>Customer:</strong> {requirement.customer || '—'}</div>
            <div>
              <strong>Drawing No:</strong> {requirement.drawingNo || '—'}
              {requirement.projectId && requirement.drawingNo && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="button-small"
                    style={{ color: '#1d4ed8' }}
                    title="Open the enquiry drawing PDF for this Project ID"
                    onClick={() => openDrawing(requirement.projectId, requirement.drawingNo)}
                  >
                    ⧉ View drawing
                  </button>
                </>
              )}
            </div>
            <div><strong>Qty:</strong> {requirement.qty || '—'}</div>
            <div><strong>Part / Product:</strong> {requirement.partName || '—'}</div>
            <div><strong>Required Date:</strong> {requirement.requiredDate || '—'}</div>
            <div><strong>Submitted At:</strong> {requirement.submittedAt || '—'}</div>
            <div>
              <strong>Store Review:</strong>{' '}
              {requirement.storeReview
                ? `${requirement.storeReview.reviewedBy} · ${requirement.storeReview.reviewedAt}`
                : 'Pending'}
            </div>
            {(requirement.attachments || []).length > 0 && (
              <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                <strong>Attachments:</strong>
                {requirement.attachments.map((d) => (
                  <span key={d.id} className="status-badge st-attached">
                    <button
                      type="button"
                      onClick={() => openWorkflowDocument(d)}
                      title="Open attachment"
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
                    >
                      {d.name}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          {requirement.storeReview?.remarks && (
            <p style={{ marginTop: '10px' }}>
              <strong>Store remarks:</strong> {requirement.storeReview.remarks}
            </p>
          )}
        </div>

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">
              Required Items ({lines.length}{shortage > 0 ? ` · ${shortage} with shortage` : ''})
            </h3>
            <span className={badgeClass(shortage > 0 ? 'Shortage' : 'Available')}>
              {shortage > 0 ? `${shortage} item(s) in shortage` : 'Availability to be checked'}
            </span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Material</th>
                  <th>Grade / Spec</th>
                  <th>Size</th>
                  <th>Purpose</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Stock</th>
                  <th>Available</th>
                  <th>Shortage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>{l.lineNo}</td>
                    <td><strong>{l.itemName}</strong></td>
                    <td>{l.specification || '—'}</td>
                    <td>{l.size || '—'}</td>
                    <td>{l.purpose || '—'}</td>
                    <td>{qty(l.requiredQty)}</td>
                    <td>{l.unit}</td>
                    <td>{l.inventoryMatched ? qty(l.currentStock) : '—'}</td>
                    <td style={{ color: '#166534', fontWeight: 700 }}>{qty(l.availableQty)}</td>
                    <td style={{ color: l.shortageQty > 0 ? '#b91c1c' : '#166534', fontWeight: 700 }}>
                      {qty(l.shortageQty)}
                    </td>
                    <td><span className={badgeClass(l.lineStatus)}>{l.lineStatus}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Linked Purchase Indents ({indents.length})</h3>
          </div>
          {indents.length === 0 ? (
            <p className="muted-text">No Purchase Indent raised yet — Store raises indents for shortages.</p>
          ) : (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

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
          {requirement.status !== REQUIREMENT_STATUS.COMPLETED && (
            <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: '14px' }}>
              {requirement.status !== REQUIREMENT_STATUS.CANCELLED && (
                <button
                  className="button-secondary"
                  onClick={() => handleCancelRequirement(requirement.requirementNumber)}
                >
                  Cancel Requirement
                </button>
              )}
              <button
                className="button-secondary"
                style={{ color: '#dc2626', borderColor: '#fca5a5' }}
                onClick={() => handleDelete(requirement.requirementNumber)}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  /* --------------------------------- list --------------------------------- */
  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Production / Store</div>
          <h1 className="page-title">Item Requirements</h1>
          <p className="page-description">
            Create the Required Item List for a project / production job and submit it to Store for stock review.
            {' '}
            {getRequirementsAwaitingLabel(requirements)}
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          {canManage && (
            <button className="button-primary" onClick={openCreate}>+ New Item Requirement</button>
          )}
        </div>
      </div>

      {messageBox}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Requirements ({filtered.length})</h3>
        </div>
        <div className="list-filters">
          <input
            type="text"
            className="action-select form-input search-input"
            placeholder="Search requirement / project / production job..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="action-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="All">All Statuses</option>
            {Object.values(REQUIREMENT_STATUS).map((s) => (
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
                <th>Items</th>
                <th>Store Review</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="9" className="no-history-row">
                    No item requirements yet. Create one with “+ New Item Requirement”.
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
                    <td>{r.items?.length || 0}</td>
                    <td>
                      <span className={badgeClass(r.storeReview ? 'Reviewed' : 'Pending')}>
                        {r.storeReview ? `Reviewed ${r.storeReview.reviewedAt}` : 'Not Reviewed'}
                      </span>
                    </td>
                    <td><span className={badgeClass(r.status)}>{r.status}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <button className="button-small button-secondary" onClick={() => openView(r.requirementNumber)}>
                          View
                        </button>
                        {canManage && (
                          <button className="button-small button-secondary" onClick={() => handleEditClick(r.requirementNumber)}>
                            Edit
                          </button>
                        )}
                        {canManage && (
                          <button
                            className="button-small button-secondary"
                            style={{ color: '#dc2626', borderColor: '#fca5a5' }}
                            onClick={() => handleDelete(r.requirementNumber)}
                          >
                            Delete
                          </button>
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
    </section>
  );
};

const getRequirementsAwaitingLabel = (requirements) => {
  const pending = requirements.filter((r) => r.status === REQUIREMENT_STATUS.PENDING_REVIEW).length;
  return pending > 0 ? `${pending} requirement(s) awaiting Store review.` : '';
};

export default ProductionItemRequirementsPage;
