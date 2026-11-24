import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { getStoredAuth } from '../utils/auth.js';
import { hasPermission, isRole, getMyEmployeeId, isAdmin } from '../utils/permissions.js';
import {
  STATUS,
  SOURCE_TYPE,
  SOURCE_TYPE_LABEL,
  createMaterialRequest,
  updateMaterialRequest,
  deleteMaterialRequest,
  submitMaterialRequest,
  approveMaterialRequest,
  rejectMaterialRequest,
  cancelMaterialRequest,
  closeMaterialRequest,
  decorateMR,
  isMRStatusEditable,
  getInventoryItems,
  getJobCards,
  getMaterialRequests,
  getMaterialShortages,
  getStoreIssues,
  getBOMs,
  todayStr
} from '../utils/storeService.js';
import { getSalesOrders } from '../utils/workflowService.js';
import {
  ACK_STATUS,
  computeAckLines,
  getAcknowledgement,
  findIndentForMR
} from '../utils/materialAckService.js';
import {
  getMaterialRequestLines,
  getScopeQtyMaps
} from '../utils/materialRequestTermsService.js';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import EmployeeSearchSelect from '../components/EmployeeSearchSelect.jsx';
import MaterialStatusPanel from '../components/MaterialStatusPanel.jsx';
import MaterialNameSelector from '../components/MaterialNameSelector.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';

const EMPTY_LINE = {
  materialId: '',
  materialName: '',
  materialDesc: '',
  grade: '',
  spec: '',
  sizeDimensions: '',
  unit: '',
  requiredQty: '',
  purpose: '',
  /* Terms & Requirement traceability (spec §8) */
  sourceType: '',
  termsRequirementItemId: '',
  itemId: '',
  termsRequiredQty: '',
  reason: '',
  addedBy: '',
  addedDate: ''
};

const StatusChip = ({ status }) => {
  const cls = (status || '').toLowerCase().replace(/\s+/g, '-');
  return <span className={`status-badge st-${cls}`}>{status}</span>;
};

/* Store acknowledgement chip — colours live in quotation.css. */
const AckChip = ({ status }) => <StatusChip status={status} />;

const ProductionMaterialRequestsPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const auth = getStoredAuth();

  const [tab, setTab] = useState('requests'); // requests | audit
  const [mode, setMode] = useState('list'); // list | create | edit | view
  const [editMrNumber, setEditMrNumber] = useState(null);
  const [selectedMrNumber, setSelectedMrNumber] = useState(null);
  const [viewMrNumber, setViewMrNumber] = useState(location.state?.viewMrNumber || null);
  const [createForJobCard, setCreateForJobCard] = useState(location.state?.createForJobCard || '');
  const [statusFilter, setStatusFilter] = useState('All');
  const [projectFilter, setProjectFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const canCreate = hasPermission('material_request.create');
  const canSubmit = hasPermission('material_request.submit');
  const canCancel = isAdmin();
  const canApprove = hasPermission('material_request.approve');

  const refresh = () => setRefreshTick((t) => t + 1);

  useEffect(() => {
    if (location.state?.viewMrNumber) {
      setMode('view');
      setViewMrNumber(location.state.viewMrNumber);
    }
    if (location.state?.createForJobCard) {
      setMode('create');
      setCreateForJobCard(location.state.createForJobCard);
    }
  }, [location.state]);

  /* Deep link pushed by the Store acknowledgement notification:
     /production/material-requests?mr=MR-xxxxxx — opens the request detail so
     Production immediately sees what Stores confirmed. */
  useEffect(() => {
    const wanted = searchParams.get('mr');
    if (!wanted) return;
    const found = getMaterialRequests().find((m) => m.mrNumber === wanted);
    if (!found) return;
    setMode('view');
    setViewMrNumber(found.mrNumber);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (viewMrNumber) setTab('requests');
  }, [viewMrNumber]);

  const mrs = getMaterialRequests();
  const jobCards = getJobCards();
  const inventory = getInventoryItems();

  const isProdEmployee = isRole('production_employee');
  const myEmpId = getMyEmployeeId();

  // Production employees only see the Job Cards assigned to them (requirement: My Job Cards)
  const visibleJobCards = useMemo(() => {
    if (!isProdEmployee || !myEmpId) return jobCards;
    return jobCards.filter((j) => j.assignedToEmpId === myEmpId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProdEmployee, myEmpId, refreshTick]);

  const visibleJobCardNos = useMemo(() => new Set(visibleJobCards.map((j) => j.jobCardNumber)), [visibleJobCards]);

  const decorated = useMemo(() => {
    const dec = mrs.map((m) => decorateMR(m));
    dec.sort((a, b) => (b.mrNumber.localeCompare(a.mrNumber)));
    return dec;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrs, refreshTick]);

  const filtered = decorated.filter((mr) => {
    if (statusFilter !== 'All' && mr.status !== statusFilter) return false;
    if (projectFilter !== 'All' && (mr.projectId || '') !== projectFilter) return false;
    if (isProdEmployee && mr.jobCardNumber && !visibleJobCardNos.has(mr.jobCardNumber)) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return [mr.mrNumber, mr.jobCardNumber, mr.salesOrderRef, mr.projectId, mr.partName, mr.customer, mr.requestedBy].join(' ').toLowerCase().includes(q);
  });

  const projectFilterOptions = useMemo(() => {
    const set = new Set(decorated.map((m) => m.projectId || '').filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [decorated]);

  const selected = viewMrNumber ? decorated.find((m) => m.mrNumber === viewMrNumber) : null;

  /* ------------------------------ create form ------------------------------ */
  const [form, setForm] = useState({
    jobCardNumber: createForJobCard || '',
    salesOrderRef: '',
    customer: '',
    partName: '',
    drawingNumber: '',
    projectId: '',
    projectName: '',
    priority: 'Normal',
    requiredDate: '',
    requestedBy: '',
    requestedByEmpId: '',
    remarks: ''
  });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  /* "+ Add Item" modal (spec §6/§7) */
  const [showAddItem, setShowAddItem] = useState(false);
  const [addItem, setAddItem] = useState({ material: null, requiredQty: '', reason: '' });
  const [addItemError, setAddItemError] = useState('');

  /* Sales Order / Job Card pickers (searchable, spec §16) */
  const salesOrderOptions = useMemo(() => {
    const map = new Map();
    getSalesOrders().forEach((so) => {
      const ref = String(so.reference || '').trim();
      if (!ref || map.has(ref)) return;
      const cust = so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName || '';
      map.set(ref, { value: ref, label: ref, hint: [cust, so.date].filter(Boolean).join(' · ') });
    });
    jobCards.forEach((jc) => {
      const ref = String(jc.salesOrderRef || '').trim();
      if (!ref || map.has(ref)) return;
      map.set(ref, { value: ref, label: ref, hint: `From Job Card ${jc.jobCardNumber}` });
    });
    const current = String(form.salesOrderRef || '').trim();
    if (current && !map.has(current)) map.set(current, { value: current, label: current, hint: 'Current selection' });
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  /* Job Cards are filtered to the selected Sales Order when a match exists,
     otherwise the full list is shown (legacy Job Cards may hold a PO ref). */
  const jobCardOptions = useMemo(() => {
    const so = String(form.salesOrderRef || '').trim();
    const matching = so ? visibleJobCards.filter((j) => String(j.salesOrderRef || '').trim() === so) : [];
    const list = matching.length ? matching : visibleJobCards;
    return list.map((jc) => ({
      value: jc.jobCardNumber,
      label: jc.jobCardNumber,
      hint: [jc.partName, jc.customerName, jc.salesOrderRef].filter(Boolean).join(' · ')
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleJobCards, form.salesOrderRef, refreshTick]);

  /* Terms & Requirement lines + live quantities for the selected scope. */
  const termsLines = useMemo(() => {
    if (!form.salesOrderRef && !form.jobCardNumber) return [];
    return getMaterialRequestLines({
      salesOrderId: form.salesOrderRef,
      jobCardNumber: form.jobCardNumber,
      excludeMrNumber: mode === 'edit' ? editMrNumber : ''
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.salesOrderRef, form.jobCardNumber, mode, editMrNumber, refreshTick]);

  /* Already-requested / already-issued quantities for every line in scope. */
  const scopeQty = useMemo(() => {
    if (!form.salesOrderRef && !form.jobCardNumber) return { requested: {}, issued: {} };
    return getScopeQtyMaps({
      salesOrderRef: form.salesOrderRef,
      jobCardNumber: form.jobCardNumber,
      excludeMrNumber: mode === 'edit' ? editMrNumber : ''
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.salesOrderRef, form.jobCardNumber, mode, editMrNumber, refreshTick]);

  /* Builds the request rows straight from Terms & Requirement (spec §2/§3). */
  const buildTermsLines = (so, jc) =>
    getMaterialRequestLines({ salesOrderId: so, jobCardNumber: jc, excludeMrNumber: mode === 'edit' ? editMrNumber : '' }).map((ln) => ({
      materialId: ln.materialId,
      materialName: ln.itemName,
      materialDesc: ln.description || ln.itemName,
      grade: '',
      spec: ln.specification || '',
      sizeDimensions: ln.size || '',
      unit: ln.unit || 'Nos',
      /* Request Qty defaults to the remaining balance (spec §20). */
      requiredQty: ln.inMaster ? String(ln.balanceQty) : '0',
      purpose: ln.purpose || '',
      sourceType: SOURCE_TYPE.TERMS_REQUIREMENT,
      termsRequirementItemId: ln.termsRequirementItemId || '',
      itemId: ln.itemId || '',
      termsRequiredQty: String(ln.termsRequiredQty),
      reason: '',
      addedBy: '',
      addedDate: '',
      inMaster: Boolean(ln.inMaster),
      sourceRef: ln.sourceRef || ''
    }));

  /* Sales Order / Job Card changed → replace the rows with the new Terms.
     Rows the user added through "+ Add Item" are confirmed before dropping. */
  const applyScope = (so, jc) => {
    const manual = lines.filter((ln) => ln.materialId && ln.sourceType !== SOURCE_TYPE.TERMS_REQUIREMENT);
    if (manual.length > 0) {
      const ok = window.confirm(
        `Changing the Sales Order / Job Card reloads the Terms & Requirement items and removes ${manual.length} manually added line(s). Continue?`
      );
      if (!ok) return false;
    }
    const next = buildTermsLines(so, jc);
    setLines(next.length ? next : [{ ...EMPTY_LINE }]);
    return true;
  };

  useEffect(() => {
    const me = getEmployeesForForm();
    const jcPrefill = createForJobCard ? jobCards.find((j) => j.jobCardNumber === createForJobCard) : null;
    setForm((prev) => ({
      ...prev,
      jobCardNumber: createForJobCard || prev.jobCardNumber,
      projectId: jcPrefill?.projectId ? (jcPrefill.projectId + '').trim().toUpperCase() : prev.projectId,
      projectName: jcPrefill?.projectName || prev.projectName,
      salesOrderRef: jcPrefill?.salesOrderRef || prev.salesOrderRef,
      customer: jcPrefill?.customerName || prev.customer,
      partName: jcPrefill?.partName || prev.partName,
      drawingNumber: jcPrefill?.drawingNumber || prev.drawingNumber,
      requestedBy: prev.requestedBy || me.name,
      requestedByEmpId: prev.requestedByEmpId || me.employeeId
    }));
    if (jcPrefill && mode === 'create') setLines(buildTermsLines(jcPrefill.salesOrderRef || '', jcPrefill.jobCardNumber || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createForJobCard]);

  const handleJobCardChange = (jcNo) => {
    const jc = jobCards.find((j) => j.jobCardNumber === jcNo);
    if (!jc) {
      /* Job Card cleared (optional field) → keep the Sales Order scope and its Terms. */
      const so = String(form.salesOrderRef || '').trim();
      if (!applyScope(so, '')) return;
      setForm((prev) => ({ ...prev, jobCardNumber: '' }));
      setFormError('');
      return;
    }
    const so = String(jc.salesOrderRef || '').trim();
    if (!applyScope(so, jcNo)) return;
    setForm((prev) => ({
      ...prev,
      jobCardNumber: jcNo,
      salesOrderRef: so,
      customer: jc.customerName || '',
      partName: jc.partName || '',
      drawingNumber: jc.drawingNumber || '',
      projectId: (jc.projectId || '').trim().toUpperCase(),
      projectName: jc.projectName || ''
    }));
    setFormError('');
  };

  /* Selecting a Sales Order first: the Job Card is cleared when it belongs to
     a different Sales Order, so the two can never disagree. */
  const handleSalesOrderChange = (so) => {
    const currentJc = jobCards.find((j) => j.jobCardNumber === form.jobCardNumber);
    const keepJc = currentJc && String(currentJc.salesOrderRef || '').trim() === String(so || '').trim() ? currentJc.jobCardNumber : '';
    if (!applyScope(so, keepJc)) return;
    const soRec = getSalesOrders().find((s) => String(s.reference) === String(so));
    setForm((prev) => ({
      ...prev,
      salesOrderRef: so,
      jobCardNumber: keepJc,
      customer: keepJc ? prev.customer : (soRec?.payload?.customerDetails?.companyName || soRec?.payload?.customerDetails?.customerName || prev.customer || ''),
      partName: keepJc ? prev.partName : '',
      drawingNumber: keepJc ? prev.drawingNumber : '',
      projectId: keepJc ? prev.projectId : '',
      projectName: keepJc ? prev.projectName : ''
    }));
    setFormError('');
  };

  const removeLine = (idx) => {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

  const updateLine = (idx, Key, val) => {
    setLines((prev) => prev.map((ln, i) => (i === idx ? { ...ln, [Key]: val } : ln)));
  };

  const handleBOMSelect = (bomId) => {
    if (!bomId) return;
    const bom = getBOMs().find((b) => b.id === bomId);
    if (!bom) return;
    const toRows = () =>
      bom.items.map((it) => {
        const inv = inventory.find((i) => i.itemCode === it.materialId);
        return {
          ...EMPTY_LINE,
          ...it,
          itemId: inv?.id || '',
          requiredQty: it.requiredQty || '',
          termsRequiredQty: String(Number(it.requiredQty) || 0),
          sourceType: SOURCE_TYPE.ADDITIONAL,
          reason: `Loaded from Item List "${bom.partName || bom.drawingNumber || bom.projectId}"`,
          addedBy: getEmployeesForForm().name,
          addedDate: todayStr()
        };
      });
    if (lines.length === 1 && !lines[0].materialId) {
      setLines(toRows());
    } else {
      if (!window.confirm(`Replace current ${lines.length} material(s) with item list "${bom.partName || bom.drawingNumber || bom.projectId}" (${bom.items.length} items)?`)) return;
      setLines(toRows());
    }
  };

  /* ------------------------- "+ Add Item" (spec §6/§7) ------------------------- */
  const openAddItem = () => {
    setAddItem({ material: null, requiredQty: '', reason: '' });
    setAddItemError('');
    setShowAddItem(true);
  };

  const handleAddItemConfirm = () => {
    setAddItemError('');
    const inv = addItem.material;
    if (!inv) return setAddItemError('Search and select an item from the Item Master.');
    if (inv.active === false) return setAddItemError('Only active items can be selected.');
    const materialId = String(inv.itemCode || '').trim();
    if (!materialId) return setAddItemError('The selected item has no Item Code — it cannot be requested.');
    const dupe = lines.some((ln) => String(ln.materialId || '').trim().toLowerCase() === materialId.toLowerCase())
      || termsLines.some((t) => String(t.materialId || '').trim().toLowerCase() === materialId.toLowerCase());
    if (dupe) {
      return setAddItemError('This item is already included in the Material Request. Please update the existing request quantity.');
    }
    const qty = Number(addItem.requiredQty);
    if (!(qty > 0)) return setAddItemError('Required quantity must be greater than zero.');
    const reason = String(addItem.reason || '').trim();
    if (!reason) return setAddItemError('A reason is required for an Additional Item (why it is not in Terms & Requirement).');
    const already = (Number(scopeQty.requested[materialId]) || 0) + (Number(scopeQty.issued[materialId]) || 0);
    const balance = Math.max(0, qty - already);
    if (balance <= 0) {
      return setAddItemError(
        `"${inv.itemName}": ${qty} ${inv.unit || ''} requested — ${already} already requested or issued for this Sales Order / Job Card, so nothing is left to request.`
      );
    }
    const me = getEmployeesForForm();
    setLines((prev) => {
      const base = prev.length === 1 && !prev[0].materialId ? [] : [...prev];
      return [
        ...base,
        {
          materialId,
          materialName: inv.itemName || '',
          materialDesc: inv.hsnSac ? `${inv.hsnSac} ${inv.itemName}` : (inv.itemName || ''),
          grade: inv.grade || '',
          spec: inv.spec || inv.materialDesc || '',
          sizeDimensions: inv.sizeDimensions || '',
          unit: inv.unit || 'Nos',
          requiredQty: String(balance),
          purpose: '',
          sourceType: SOURCE_TYPE.ADDITIONAL,
          termsRequirementItemId: '',
          itemId: inv.id || '',
          termsRequiredQty: String(qty),
          reason,
          addedBy: me.name,
          addedDate: todayStr()
        }
      ];
    });
    setShowAddItem(false);
    setAddItem({ material: null, requiredQty: '', reason: '' });
  };

  /* ----------------------------- validation ----------------------------- */
  const collectReadyLines = () =>
    lines
      .filter((ln) => ln.materialId && (Number(ln.requiredQty) || 0) > 0)
      .map((ln) => ({ ...ln, requiredQty: Number(ln.requiredQty) || 0 }));

  const validateForm = () => {
    if (!String(form.salesOrderRef || '').trim()) {
      return 'Sales Order is required — pick it above. The Job Card is optional.';
    }
    if (isProdEmployee && form.jobCardNumber && !visibleJobCardNos.has(form.jobCardNumber)) {
      return 'Production employees can only request material for their own assigned Job Cards.';
    }
    const ready = collectReadyLines();
    if (ready.length === 0) return 'Add at least one material line with a request quantity greater than zero.';
    const seen = new Set();
    for (const ln of ready) {
      const key = String(ln.materialId).trim().toLowerCase();
      if (seen.has(key)) {
        return `"${ln.materialName}" is already included in the Material Request. Please update the existing request quantity.`;
      }
      seen.add(key);
    }
    for (const ln of ready) {
      const termsRequired = Number(ln.termsRequiredQty) || 0;
      if (termsRequired > 0) {
        const req = Number(scopeQty.requested[ln.materialId]) || 0;
        const iss = Number(scopeQty.issued[ln.materialId]) || 0;
        const balance = Math.max(0, termsRequired - req - iss);
        if (ln.requiredQty > balance) {
          return `"${ln.materialName}": request quantity ${ln.requiredQty} exceeds the remaining balance ${balance} (Required ${termsRequired} − Requested ${req} − Issued ${iss}).`;
        }
      }
      if (ln.sourceType === SOURCE_TYPE.ADDITIONAL && !String(ln.reason || '').trim()) {
        return `"${ln.materialName}": an Additional Item needs a reason (why it was not in Terms & Requirement).`;
      }
    }
    return '';
  };

  const handleSaveAsDraft = () => {
    setFormError('');
    const error = validateForm();
    if (error) return setFormError(error);
    const ready = collectReadyLines();
    try {
      setBusy(true);
      const mr = mode === 'edit' && editMrNumber
        ? updateMaterialRequest(editMrNumber, { ...form, items: ready })
        : createMaterialRequest({ ...form, items: ready });
      setMode('list');
      setEditMrNumber(null);
      setSelectedMrNumber(null);
      setLines([{ ...EMPTY_LINE }]);
      setBusy(false);
      navigate('/production/material-requests', { state: { viewMrNumber: mr.mrNumber } });
    } catch (err) {
      setBusy(false);
      setFormError(err.message);
    }
  };

  const handleSubmitDirect = () => {
    setFormError('');
    const error = validateForm();
    if (error) return setFormError(error);
    const ready = collectReadyLines();
    try {
      setBusy(true);
      let mr = mode === 'edit' && editMrNumber
        ? updateMaterialRequest(editMrNumber, { ...form, items: ready })
        : createMaterialRequest({ ...form, items: ready });
      mr = submitMaterialRequest(mr.mrNumber);
      setBusy(false);
      setMode('list');
      setEditMrNumber(null);
      setLines([{ ...EMPTY_LINE }]);
      setSelectedMrNumber(null);
      setViewMrNumber(mr.mrNumber);
      navigate('/production/material-requests', { state: { viewMrNumber: mr.mrNumber } });
    } catch (err) {
      setBusy(false);
      setFormError(err.message);
    }
  };

  const handleEdit = (mr) => {
    if (!isMRStatusEditable(mr.status)) {
      alert(`Cannot edit ${mr.mrNumber} — status is "${mr.status}".\nOnly Material Requests with no material issued yet can be edited.`);
      return;
    }
    setForm({
      jobCardNumber: mr.jobCardNumber || '',
      projectId: mr.projectId || '',
      projectName: mr.projectName || '',
      salesOrderRef: mr.salesOrderRef || '',
      customer: mr.customer || '',
      partName: mr.partName || '',
      drawingNumber: mr.drawingNumber || '',
      priority: mr.priority || 'Normal',
      requiredDate: mr.requiredDate || '',
      requestedBy: mr.requestedBy || '',
      requestedByEmpId: mr.requestedByEmpId || '',
      remarks: mr.remarks || ''
    });
    /* Older requests were saved before the Terms fields existed: backfill the
       Terms & Requirement link so the balance rules apply from now on. */
    const terms = getMaterialRequestLines({
      salesOrderId: mr.salesOrderRef || '',
      jobCardNumber: mr.jobCardNumber || '',
      excludeMrNumber: mr.mrNumber
    });
    const termsByCode = new Map(terms.map((t) => [String(t.materialId || '').toLowerCase(), t]));
    setLines((mr.items || []).map((it) => {
      const t = termsByCode.get(String(it.materialId || '').toLowerCase());
      return {
        materialId: it.materialId,
        materialName: it.materialName,
        materialDesc: it.materialDesc || '',
        grade: it.grade || '',
        spec: it.spec || '',
        sizeDimensions: it.sizeDimensions || '',
        unit: it.unit || '',
        requiredQty: it.requiredQty != null ? String(it.requiredQty) : '',
        purpose: it.purpose || '',
        sourceType: it.sourceType || (it.termsRequirementItemId ? SOURCE_TYPE.TERMS_REQUIREMENT : SOURCE_TYPE.ADDITIONAL),
        termsRequirementItemId: it.termsRequirementItemId || t?.termsRequirementItemId || '',
        itemId: it.itemId || t?.itemId || '',
        termsRequiredQty: it.termsRequiredQty || t?.termsRequiredQty || '',
        reason: it.reason || '',
        addedBy: it.addedBy || '',
        addedDate: it.addedDate || ''
      };
    }));
    setFormError('');
    setViewMrNumber(null);
    setCreateForJobCard('');
    setEditMrNumber(mr.mrNumber);
    setMode('edit');
  };

  const handleDelete = (mr) => {
    if (!isMRStatusEditable(mr.status)) {
      alert(`Cannot delete ${mr.mrNumber} — status is "${mr.status}".\nOnly Material Requests with no material issued yet can be deleted.`);
      return;
    }
    if (!window.confirm(`Delete ${mr.mrNumber}? This cannot be undone.`)) return;
    try {
      deleteMaterialRequest(mr.mrNumber);
      if (viewMrNumber === mr.mrNumber) {
        setViewMrNumber(null);
        setMode('list');
      }
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSubmit = (mr) => {
    try {
      submitMaterialRequest(mr.mrNumber);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleApprove = (mr) => {
    const remarks = window.prompt(`Approve ${mr.mrNumber}? Enter remarks (optional):`);
    if (remarks === null) return;
    try {
      approveMaterialRequest(mr.mrNumber, remarks);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRejectMR = (mr) => {
    const reason = window.prompt(`Reject ${mr.mrNumber}? Enter a reason (required):`);
    if (reason === null) return;
    if (!reason || !reason.trim()) { alert('Rejection reason is required.'); return; }
    try {
      rejectMaterialRequest(mr.mrNumber, reason);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCancel = (mr) => {
    const reason = window.prompt(`Cancel ${mr.mrNumber}? Enter a reason:`);
    if (reason === null || !reason.trim()) return;
    try {
      cancelMaterialRequest(mr.mrNumber, reason);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleClose = (mr) => {
    if (!window.confirm(`Close ${mr.mrNumber} now that all material is issued?`)) return;
    try {
      closeMaterialRequest(mr.mrNumber);
      refresh();
      setViewMrNumber(decorateMR(getMaterialRequests().find((m) => m.mrNumber === mr.mrNumber)).mrNumber);
    } catch (err) {
      alert(err.message);
    }
  };

  /* -------------------------------- render -------------------------------- */

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Material Requests</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          {mode === 'list' && canCreate && (
            <button type="button" className="button-primary" onClick={() => { setMode('create'); setViewMrNumber(null); }}>
              + New Material Request
            </button>
          )}
          {(mode === 'create' || mode === 'edit') && (
            <button type="button" className="button-secondary" onClick={() => { setMode('list'); setViewMrNumber(null); setEditMrNumber(null); }}>
              &larr; Back to List
            </button>
          )}
        </div>
      </div>

      {(mode === 'create' || mode === 'edit') ? (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">{mode === 'edit' ? `Edit Material Request ${editMrNumber || ''}` : 'New Material Request'}</h3>
            <span className="muted-text">{mode === 'edit' ? 'Editable until material is issued against the request' : 'Auto-numbered as MR-xxxxx on save'}</span>
          </div>

          <div className="form-grid">
            <div className="form-field">
              <label>Material Request No.</label>
              <input type="text" className="action-select form-input" value={mode === 'edit' ? (editMrNumber || '') : 'Auto on save (MR-xxxxxx)'} readOnly />
            </div>
            <div className="form-field">
              <label>Sales Order *</label>
              <SearchableSelect
                value={form.salesOrderRef || ''}
                options={salesOrderOptions}
                onChange={handleSalesOrderChange}
                placeholder="Search Sales Order / PO reference..."
                label="Sales Orders"
              />
            </div>
            <div className="form-field">
              <label>Linked Job Card <span className="muted-text" style={{ fontWeight: 400, fontSize: '11px' }}>(optional)</span></label>
              <SearchableSelect
                value={form.jobCardNumber || ''}
                options={jobCardOptions}
                onChange={handleJobCardChange}
                placeholder="Search Job Card..."
                label="Job Cards"
              />
            </div>
            <div className="form-field">
              <label>Customer</label>
              <input type="text" className="action-select form-input" value={form.customer || ''} readOnly />
            </div>
            <div className="form-field">
              <label>Requested By</label>
              <input type="text" className="action-select form-input" value={form.requestedBy} readOnly />
            </div>
            <div className="form-field">
              <label>Required Date</label>
              <input type="date" className="action-select form-input" min={todayStr()} value={form.requiredDate} onChange={(e) => setForm({ ...form, requiredDate: e.target.value })} />
            </div>
            <div className="form-field">
              <label>Priority</label>
              <select className="action-select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="Normal">Normal</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>
            <div className="form-field">
              <label>Project ID</label>
              <input type="text" className="action-select form-input" value={form.projectId || ''} readOnly placeholder="Auto from Job Card" />
            </div>
            <div className="form-field">
              <label>Project Name</label>
              <input type="text" className="action-select form-input" value={form.projectName || ''} readOnly placeholder="Auto from Job Card" />
            </div>
            <div className="form-field">
              <label>Part Name</label>
              <input type="text" className="action-select form-input" value={form.partName || ''} readOnly />
            </div>
            <div className="form-field">
              <label>Drawing Number</label>
              <input type="text" className="action-select form-input" value={form.drawingNumber || ''} readOnly />
            </div>
          </div>

          <div className="content-block nested-block">
            <div className="block-header">
              <h3 className="block-title">Materials Required</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <BOMSelector onSelect={handleBOMSelect} />
                <button type="button" className="button-secondary button-small" onClick={openAddItem}>+ Add Item</button>
              </div>
            </div>

            {termsLines.length > 0 ? (
              <div className="terms-fetch-note">
                <strong>Items from Terms &amp; Requirement —</strong> {termsLines.length} material(s) fetched
                automatically for <strong>{form.salesOrderRef || '—'}</strong>
                {form.jobCardNumber ? <> / <strong>{form.jobCardNumber}</strong></> : null}.
                Required, Requested, Issued and Balance are calculated for you — enter only the Request Qty.
              </div>
            ) : (form.salesOrderRef || form.jobCardNumber) ? (
              <div className="terms-fetch-note terms-fetch-note-empty">
                No Terms &amp; Requirement items found for this Sales Order / Job Card.
                Use <strong>+ Add Item</strong> to add materials from the Item Master.
              </div>
            ) : null}

            <div className="history-table-wrapper material-lines-wrapper">
              <table className="history-table material-lines-table mr-terms-table">
                <colgroup>
                  <col style={{ width: '4%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '5%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '5%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Material *</th>
                    <th>Source</th>
                    <th>Required</th>
                    <th>Requested</th>
                    <th>Issued</th>
                    <th>Balance</th>
                    <th>Available</th>
                    <th>Request Qty *</th>
                    <th>Unit</th>
                    <th>Grade / Spec</th>
                    <th>Size / Dimensions</th>
                    <th>Specification</th>
                    <th>Purpose</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((ln, idx) => {
                    const key = String(ln.materialId || '').trim();
                    const termsReq = Number(ln.termsRequiredQty) || 0;
                    const hasTerms = termsReq > 0;
                    const alreadyReq = Number(scopeQty.requested[key]) || 0;
                    const alreadyIss = Number(scopeQty.issued[key]) || 0;
                    const balance = hasTerms ? Math.max(0, termsReq - alreadyReq - alreadyIss) : null;
                    const invItem = key ? inventory.find((i) => i.itemCode === key) : null;
                    const available = invItem ? Number(invItem.currentQty) || 0 : 0;
                    const shortage = balance != null ? Math.max(0, balance - available) : 0;
                    const srcType = ln.sourceType || (ln.termsRequirementItemId ? SOURCE_TYPE.TERMS_REQUIREMENT : '');
                    const overLimit = balance != null && (Number(ln.requiredQty) || 0) > balance;
                    return (
                      <tr key={idx}>
                        <td>{idx + 1}</td>
                        <td>
                          {key ? (
                            <>
                              <div style={{ fontWeight: '600' }}>{ln.materialName || '—'}</div>
                              <div className="muted-text" style={{ fontSize: '11px' }}>{key}</div>
                              {!invItem && (
                                <div className="line-error">Not in Item Master — add it there first</div>
                              )}
                            </>
                          ) : (
                            <span className="muted-text">Use “+ Add Item” to select a material</span>
                          )}
                        </td>
                        <td>
                          {srcType ? (
                            <span className={`source-badge ${srcType === SOURCE_TYPE.TERMS_REQUIREMENT ? 'source-terms' : 'source-additional'}`}>
                              {SOURCE_TYPE_LABEL[srcType]}
                            </span>
                          ) : <span className="muted-text">—</span>}
                        </td>
                        <td>{hasTerms ? termsReq : '—'}</td>
                        <td>{key ? alreadyReq : '—'}</td>
                        <td>{key ? alreadyIss : '—'}</td>
                        <td>{balance != null ? balance : '—'}</td>
                        <td>
                          {key ? available : '—'}
                          {shortage > 0 && <div className="line-error">Short {shortage}</div>}
                        </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            max={balance != null ? balance : undefined}
                            disabled={!key || !invItem}
                            className="action-select form-input"
                            value={ln.requiredQty}
                            onChange={(e) => updateLine(idx, 'requiredQty', e.target.value)}
                          />
                          {overLimit && <div className="line-error">Max {balance}</div>}
                        </td>
                        <td>
                          <input type="text" className="action-select form-input" value={ln.unit} readOnly />
                        </td>
                        <td>
                          <input type="text" className="action-select form-input" value={ln.grade} onChange={(e) => updateLine(idx, 'grade', e.target.value)} placeholder="e.g. EN8" />
                        </td>
                        <td>
                          <input type="text" className="action-select form-input" value={ln.sizeDimensions} onChange={(e) => updateLine(idx, 'sizeDimensions', e.target.value)} placeholder="e.g. 50mm dia" />
                        </td>
                        <td>
                          <input type="text" className="action-select form-input" value={ln.spec} onChange={(e) => updateLine(idx, 'spec', e.target.value)} placeholder="e.g. 50mm dia" />
                        </td>
                        <td>
                          <input type="text" className="action-select form-input" value={ln.purpose} onChange={(e) => updateLine(idx, 'purpose', e.target.value)} placeholder="e.g. CNC" />
                          {ln.sourceType === SOURCE_TYPE.ADDITIONAL && ln.reason && (
                            <div className="muted-text" style={{ fontSize: '11px', marginTop: '2px' }} title={ln.reason}>
                              Reason: {ln.reason}
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <button type="button" className="button-secondary button-small" onClick={() => removeLine(idx)}>Remove</button>
                        </td>
                      </tr>
                    );
                  })}
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan="15" className="no-history-row">No material lines. Click “+ Add Item”.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="muted-text" style={{ fontSize: '11.5px', marginTop: '8px' }}>
              Balance = Required − Already Requested − Already Issued. A line with Request Qty 0 is left out of this
              request. Source: <span className="source-badge source-terms">Terms Requirement</span> is fetched
              automatically, <span className="source-badge source-additional">Additional Item</span> is added here.
            </div>
          </div>

          <div className="form-field">
            <label>Remarks (optional)</label>
            <textarea className="action-select form-input" rows="2" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </div>

          {formError && <div className="form-error">{formError}</div>}

          <div className="template-modal-actions start-actions">
            <button type="button" className="button-secondary" onClick={handleSaveAsDraft} disabled={busy}>
              {busy ? 'Saving...' : (mode === 'edit' ? 'Save Changes' : 'Save as Draft')}
            </button>
            <button type="button" className="button-primary" onClick={handleSubmitDirect} disabled={busy}>
              {busy ? 'Submitting...' : 'Save & Submit to Store'}
            </button>
          </div>

          {showAddItem && (
            <div className="template-modal-backdrop" onMouseDown={() => setShowAddItem(false)}>
              <div className="template-modal" style={{ width: 'min(560px, 95vw)' }} onMouseDown={(e) => e.stopPropagation()}>
                <div className="template-modal-header">
                  <div>
                    <h3 className="block-title">Add Additional Material</h3>
                    <p className="muted-text" style={{ margin: 0, fontSize: '12.5px' }}>
                      For materials missing from Terms &amp; Requirement. Select from the Item Master — free text is not allowed.
                    </p>
                  </div>
                  <button type="button" className="template-modal-close" onClick={() => setShowAddItem(false)} aria-label="Close">×</button>
                </div>

                <div className="form-grid">
                  <div className="form-field full-width">
                    <label>Item *</label>
                    <MaterialNameSelector
                      value={addItem.material?.itemName || ''}
                      placeholder="Search Item... (code, name, description)"
                      onSelect={(rec) => {
                        if (rec.active === false) {
                          setAddItemError('Only active items can be selected.');
                          return false;
                        }
                        setAddItem((prev) => ({ ...prev, material: rec }));
                        setAddItemError('');
                        return true;
                      }}
                      onClear={() => setAddItem((prev) => ({ ...prev, material: null }))}
                    />
                  </div>
                  <div className="form-field">
                    <label>Item Code</label>
                    <input type="text" className="action-select form-input" value={addItem.material?.itemCode || ''} readOnly placeholder="Auto from Item Master" />
                  </div>
                  <div className="form-field">
                    <label>Material Name</label>
                    <input type="text" className="action-select form-input" value={addItem.material?.itemName || ''} readOnly placeholder="Auto from Item Master" />
                  </div>
                  <div className="form-field">
                    <label>UOM</label>
                    <input type="text" className="action-select form-input" value={addItem.material?.unit || ''} readOnly placeholder="Auto from Item Master" />
                  </div>
                  <div className="form-field">
                    <label>Available Stock</label>
                    <input
                      type="text"
                      className="action-select form-input"
                      value={addItem.material ? `${Math.max(0, (Number(addItem.material.currentQty) || 0) - (Number(addItem.material.reservedQty) || 0))} ${addItem.material.unit || ''}` : ''}
                      readOnly
                      placeholder="Auto from Store Inventory"
                    />
                  </div>
                  <div className="form-field">
                    <label>Required Quantity *</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      className="action-select form-input"
                      value={addItem.requiredQty}
                      onChange={(e) => setAddItem((prev) => ({ ...prev, requiredQty: e.target.value }))}
                      placeholder="Enter quantity"
                    />
                  </div>
                  <div className="form-field full-width">
                    <label>Reason *</label>
                    <input
                      type="text"
                      className="action-select form-input"
                      value={addItem.reason}
                      onChange={(e) => setAddItem((prev) => ({ ...prev, reason: e.target.value }))}
                      placeholder="e.g. Item missed in Terms & Requirement"
                    />
                  </div>
                </div>

                {addItemError && <div className="form-error">{addItemError}</div>}

                <div className="template-modal-actions">
                  <button type="button" className="button-secondary" onClick={() => setShowAddItem(false)}>Cancel</button>
                  <button type="button" className="button-primary" onClick={handleAddItemConfirm}>Add to Material Request</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : mode === 'view' && selected ? (
        <SelectedView
          mr={selected}
          jobCards={jobCards}
          inventory={inventory}
          canSubmit={canSubmit}
          canCancel={canCancel}
          canApprove={canApprove}
          onBack={() => { setMode('list'); setViewMrNumber(null); navigate('/production/material-requests'); }}
          onSubmit={() => { handleSubmit(selected); refresh(); setViewMrNumber(decorateMR(getMaterialRequests().find((m) => m.mrNumber === selected.mrNumber)).mrNumber); }}
          onCancel={() => { handleCancel(selected); refresh(); }}
          onClose={() => handleClose(selected)}
          onApprove={() => { handleApprove(selected); refresh(); setViewMrNumber(decorateMR(getMaterialRequests().find((m) => m.mrNumber === selected.mrNumber)).mrNumber); }}
          onRejectMR={() => { handleRejectMR(selected); refresh(); setViewMrNumber(decorateMR(getMaterialRequests().find((m) => m.mrNumber === selected.mrNumber)).mrNumber); }}
        />
      ) : (
        <div>
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Material Requests</h3>
              <span className="muted-text">{filtered.length} request(s)</span>
            </div>

            <div className="list-filters">
              <input
                type="text"
                className="action-select form-input search-input"
                placeholder="Search MR / Job Card / Project / part / customer..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select className="action-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
                {projectFilterOptions.map((p) => (
                  <option key={p} value={p}>{(p === 'All' ? 'All Projects' : `Project: ${p}`)}</option>
                ))}
              </select>
              <select className="action-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="All">All Statuses</option>
                {(Object.values(STATUS)).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>MR No</th>
                    <th>Project ID</th>
                    <th>Sales Order</th>
                    <th>Job Card</th>
                    <th>Part Name</th>
                    <th>Customer</th>
                    <th>Request Date</th>
                    <th>Requested By</th>
                    <th>Lines</th>
                    <th>Status</th>
                    <th>Store Ack</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan="12" className="no-history-row">No material requests found.</td>
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
                        <td>{mr.salesOrderRef || '—'}</td>
                        <td>{mr.jobCardNumber || '—'}</td>
                        <td>{mr.partName || '—'}</td>
                        <td>{mr.customer || '—'}</td>
                        <td>{mr.requestDate}</td>
                        <td>{mr.requestedBy}</td>
                        <td>{mr.items.length}</td>
                        <td><StatusChip status={mr.status} /></td>
                        <td><AckChip status={getAcknowledgement(mr).status} /></td>
                        <td>
                          <div className="table-actions">
                            <button type="button" className="button-secondary button-small" onClick={() => { setMode('view'); setViewMrNumber(mr.mrNumber); }}>View</button>
                            <button type="button" className="button-secondary button-small" onClick={() => handleEdit(mr)}>Edit</button>
                            {isAdmin() && <button type="button" className="button-secondary button-small" style={{ color: '#dc2626', borderColor: '#fca5a5' }} onClick={() => handleDelete(mr)}>Delete</button>}
                            {canSubmit && mr.status === 'Draft' && (
                              <button type="button" className="button-primary button-small" onClick={() => handleSubmit(mr)}>Submit</button>
                            )}
                            {canCancel && ['Draft', 'Submitted', 'Pending Store', 'Partially Issued'].includes(mr.status) && (
                              <button type="button" className="button-secondary button-small" onClick={() => handleCancel(mr)}>Cancel</button>
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

          <div className="tab-nav">
            <button type="button" className={`tab-link ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit Trail</button>
          </div>
        </div>
      )}
    </section>
  );
};

function getEmployeesForForm() {
  const auth = getStoredAuth();
  try {
    const list = JSON.parse(localStorage.getItem('employees') || '[]');
    const found = list.find((e) => e.email && auth && e.email.toLowerCase() === (auth.email || '').toLowerCase());
    if (found) return { name: found.name, employeeId: found.employeeId };
  } catch {}
  return { name: auth?.username || auth?.email || 'User', employeeId: '-' };
}

/**
 * What Stores formally confirmed about this request's material — shown on the
 * Production Material Requirement detail so nobody releases a Job Card on an
 * assumption. Confirmed figures come from the stored acknowledgement; the
 * "stock now" note flags availability that moved since Stores replied.
 */
const StoreAckBlock = ({ mr, onOpenIndent }) => {
  const ack = getAcknowledgement(mr);
  const live = computeAckLines(mr);
  const indentNumber = ack.purchaseIndentNumber || findIndentForMR(mr.mrNumber)?.indentNumber || '';
  const pending = ack.status === ACK_STATUS.PENDING;

  const rows = live.map((l) => {
    const stored = (ack.lines || {})[l.materialId];
    const confirmedQty = stored ? Number(stored.acknowledgedQty) || 0 : null;
    const confirmedShortage = stored ? Number(stored.shortageQty) || 0 : null;
    return {
      ...l,
      confirmedQty,
      confirmedShortage,
      confirmedStatus: stored ? stored.status : ACK_STATUS.PENDING,
      moved: confirmedQty !== null && confirmedQty !== l.availableQty
    };
  });

  const totalShortage = rows.reduce((a, r) => a + (r.confirmedShortage ?? r.shortageQty), 0);

  const tone = pending
    ? { bg: '#fffbeb', border: '#fde68a', color: '#92400e' }
    : ack.status === ACK_STATUS.FULL
      ? { bg: '#ecfdf5', border: '#a7f3d0', color: '#047857' }
      : ack.status === ACK_STATUS.NONE
        ? { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c' }
        : { bg: '#fffbeb', border: '#fde68a', color: '#92400e' };

  const headline = pending
    ? 'Material confirmation is pending — Stores has not acknowledged this request yet.'
    : ack.status === ACK_STATUS.FULL
      ? 'Stores confirmed the full requirement is available.'
      : ack.status === ACK_STATUS.NONE
        ? `Stores reported no material available — ${totalShortage} unit(s) short.`
        : `Stores confirmed a partial supply — ${totalShortage} unit(s) short.`;

  return (
    <div className="content-block" style={{ marginTop: '4px' }}>
      <div className="block-header">
        <h3 className="block-title">Store Acknowledgement</h3>
        <AckChip status={ack.status} />
      </div>

      <div style={{ padding: '9px 12px', borderRadius: '6px', background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color, fontSize: '13px', marginBottom: '12px' }}>
        <strong>{headline}</strong>
        {!pending && ack.acknowledgedAt && (
          <div style={{ marginTop: '3px', fontSize: '12.5px' }}>
            Acknowledged by {ack.acknowledgedBy}
            {ack.acknowledgedByEmpId && ack.acknowledgedByEmpId !== '-' ? ` (${ack.acknowledgedByEmpId})` : ''} on {ack.acknowledgedAt}
          </div>
        )}
        {!pending && ack.remarks && (
          <div style={{ marginTop: '3px', fontSize: '12.5px' }}>Remarks: {ack.remarks}</div>
        )}
        {!pending && indentNumber && (
          <div style={{ marginTop: '3px', fontSize: '12.5px' }}>
            Purchase Indent: <button type="button" className="link-btn" onClick={() => onOpenIndent(indentNumber)}>{indentNumber}</button>
            {' '}— procurement is tracked there; receipt alone does not make material available (QC approval + inventory posting required).
          </div>
        )}
      </div>

      <div className="history-table-wrapper">
        <table className="history-table">
          <thead>
            <tr>
              <th>Material</th>
              <th>Unit</th>
              <th>Required</th>
              <th>Store Confirmed</th>
              <th>Shortage</th>
              <th>Store Status</th>
              <th>Stock Now</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan="7" className="no-history-row">No material lines on this request.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.materialId}>
                  <td>
                    <strong>{r.materialName}</strong>
                    <div className="muted-text" style={{ fontSize: '11px' }}>{r.materialId}</div>
                  </td>
                  <td>{r.unit}</td>
                  <td style={{ fontWeight: 700 }}>{r.requiredQty}</td>
                  <td style={{ fontWeight: 700 }}>
                    {pending ? '—' : r.confirmedQty}
                  </td>
                  <td style={{ fontWeight: 700, color: (r.confirmedShortage ?? r.shortageQty) > 0 ? '#dc2626' : '#166534' }}>
                    {pending ? r.shortageQty : r.confirmedShortage}
                  </td>
                  <td><AckChip status={r.confirmedStatus} /></td>
                  <td>
                    {r.availableQty}
                    {r.moved && (
                      <div className="muted-text" style={{ fontSize: '11px' }}>
                        {r.availableQty > (r.confirmedQty ?? 0) ? '▲ rose since acknowledgement' : '▼ fell since acknowledgement'}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="muted-text" style={{ fontSize: '12px', marginTop: '8px' }}>
        Confirmed = the quantity Stores formally acknowledged. Stock Now = current unreserved, QC-approved inventory
        (on-hand less reserves and anything already committed to other projects). Partial availability is never shown as full.
      </div>
    </div>
  );
};

const SelectedView = ({ mr, canSubmit, canCancel, canApprove, onBack, onSubmit, onCancel, onClose, onApprove, onRejectMR }) => {
  const navigate = useNavigate();
  const shortages = getMaterialShortages(mr);
  const issues = getStoreIssues().filter((i) => i.mrNumber === mr.mrNumber);

  return (
    <div>
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Material Request {mr.mrNumber}</h3>
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
          <div><strong>Created:</strong> {mr.createdAt}</div>
        </div>

        <StoreAckBlock
          mr={mr}
          onOpenIndent={(n) => navigate(`/purchase-indents?indent=${encodeURIComponent(n)}`)}
        />

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
                <th>Issued</th>
                <th>Balance</th>
                <th>Shortage</th>
                <th>Line Status</th>
              </tr>
            </thead>
            <tbody>
              {mr.items.map((it, idx) => {
                const short = shortages.find((s) => s.materialId === it.materialId);
                const srcType = it.sourceType || (it.termsRequirementItemId ? SOURCE_TYPE.TERMS_REQUIREMENT : SOURCE_TYPE.ADDITIONAL);
                return (
                  <tr key={it.materialId}>
                    <td>{idx + 1}</td>
                    <td>
                      {it.materialName}
                      <div className="muted-text" style={{ fontSize: '11px' }}>{it.materialId}{it.itemId ? ` · item id ${it.itemId}` : ''}</div>
                    </td>
                    <td>
                      <span className={`source-badge ${srcType === SOURCE_TYPE.TERMS_REQUIREMENT ? 'source-terms' : 'source-additional'}`}>
                        {SOURCE_TYPE_LABEL[srcType]}
                      </span>
                      {srcType === SOURCE_TYPE.ADDITIONAL && it.reason && (
                        <div className="muted-text" style={{ fontSize: '11px', marginTop: '2px' }} title={it.reason}>
                          {it.reason} {it.addedBy ? `(${it.addedBy}${it.addedDate ? `, ${it.addedDate}` : ''})` : ''}
                        </div>
                      )}
                      {srcType === SOURCE_TYPE.TERMS_REQUIREMENT && it.termsRequirementItemId && (
                        <div className="muted-text" style={{ fontSize: '11px', marginTop: '2px' }}>
                          terms ref: {it.termsRequirementItemId}
                        </div>
                      )}
                    </td>
                    <td>{it.spec || it.sizeDimensions || it.grade || '—'}</td>
                    <td>{it.requiredQty} {it.unit}</td>
                    <td>{short ? short.available : '—'}</td>
                    <td>{it.issuedQty} {it.unit}</td>
                    <td>{it.balanceQty} {it.unit}</td>
                    <td>
                      {short && short.shortage > 0 ? (
                        <span className="status-badge st-rejected">{short.shortage} {it.unit}</span>
                      ) : (
                        <span className="status-badge st-active">None</span>
                      )}
                    </td>
                    <td><StatusChip status={it.lineStatus} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {issues.length > 0 && (
          <div className="block-note">
            <strong>Store Issues against this request: </strong>
            {issues.map((si) => (
              <button key={si.issueNumber} type="button" className="link-btn" onClick={() => navigate('/store/issues', { state: { viewIssue: si.issueNumber } })}>
                {si.issueNumber}
              </button>
            ))}
          </div>
        )}

        {mr.status === STATUS.DRAFT && canSubmit && (
          <div className="template-modal-actions start-actions">
            <button type="button" className="button-primary" onClick={onSubmit}>Submit to Store</button>
          </div>
        )}
        {mr.status === STATUS.SUBMITTED && canApprove && (
          <div className="template-modal-actions start-actions">
            <button type="button" className="button-primary" onClick={onApprove} style={{ background: '#16a34a' }}>Approve & Send to Store</button>
            <button type="button" className="button-secondary" onClick={onRejectMR} style={{ color: '#dc2626', borderColor: '#fca5a5' }}>Reject</button>
          </div>
        )}
        {canCancel && ['Draft', 'Submitted', 'Pending Store', 'Partially Issued'].includes(mr.status) && (
          <div className="template-modal-actions start-actions">
            <button type="button" className="button-secondary" onClick={onCancel}>Cancel Request</button>
          </div>
        )}
        {mr.status === STATUS.FULL && (
          <div className="template-modal-actions start-actions">
            <button type="button" className="button-primary" onClick={onClose}>Close Request</button>
          </div>
        )}

        <div className="template-modal-actions">
          <button type="button" className="button-secondary" onClick={onBack}>&larr; Back to List</button>
        </div>
      </div>
    </div>
  );
};

const BOMSelector = ({ onSelect }) => {
  const boms = getBOMs();
  if (boms.length === 0) return null;
  return (
    <select className="action-select" style={{ width: 'auto', minWidth: '180px' }} onChange={(e) => { onSelect(e.target.value); e.target.value = ''; }}>
      <option value="">Load from Item List...</option>
      {boms.map((b) => (
        <option key={b.id} value={b.id}>{b.drawingNumber || b.projectId || 'Untitled'} — {b.customerName || 'Unknown'} ({b.items.length} items)</option>
      ))}
    </select>
  );
};

export default ProductionMaterialRequestsPage;
