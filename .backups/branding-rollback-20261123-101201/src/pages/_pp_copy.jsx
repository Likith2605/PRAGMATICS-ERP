import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { generateRouteCardPDF } from '../services/pdfGenerator.js';
import { getFullProjectData, getProjectNameForId } from '../utils/projectTracker.js';
import { hasPermission, getMyEmployeeId, isRole } from '../utils/permissions.js';

import { normalizeRouteCard, routeCardBlank, emptyProcess, formatDateDMY } from '../utils/routeCard.js';
import WorkflowNavigator from '../components/WorkflowNavigator.jsx';
import MaterialStatusPanel from '../components/MaterialStatusPanel.jsx';
import ProjectIdAutocomplete from '../components/ProjectIdAutocomplete.jsx';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import {
  createHTOutsourceRequest,
  getHTOutsourceRequests
} from '../utils/storeService.js';

const generateJobCardNumber = () => {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const serial = Math.floor(100 + Math.random() * 900);
  return `JC-${year}${month}${day}-${serial}`;
};

const makeInitialFormData = () => ({
  jobCardNumber: generateJobCardNumber(),
  projectId: '',
  projectName: '',
  salesOrderRef: '',
  customerName: '',
  partName: '',
  drawingNumber: '',
  orderQuantity: 1,
  poDate: '',
  startDate: new Date().toISOString().slice(0, 10),
  targetDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
  status: 'In Production',
  ...routeCardBlank(),
  rawMaterial: {
    type: 'Round Material Type',
    grade: 'SS 304 / EN8 / EN24',
    dimensions: 'Dia 50mm x 200mm',
    issuedQty: '1 Nos',
    heatNumber: '',
    issueSlipNo: ''
  },
  operations: {
    turning: { status: 'Pending', machine: 'CNC Lathe 1', operator: '', notes: '' },
    millingGrinding: { status: 'Pending', machine: 'VMC Machine 1', operator: '', notes: '' },
    setupApproval: { approved: false, approvedBy: '', approvalDate: '' },
    machineProcess: { status: 'Pending', processType: 'Drilling / Wire Cutting', details: '' },
    heatTreatment: {
      required: false,
      processType: 'Hardening',
      process: 'Vacuum Hardening',
      targetHardness: '52-55 HRC',
      outsourceMode: 'In-house',
      vendor: '',
      qtySent: 0,
      qtyReceived: 0,
      sentDate: '',
      receivedDate: '',
      status: 'Pending',
      actualHardness: '',
      testMethod: 'Rockwell (HRC)',
      disposition: 'Pending',
      inspector: '',
      remarks: ''
    }
  },
  qualityControl: {
    inProcessQC: { status: 'Pending', inspector: '', remarks: '' },
    finalQC: { disposition: 'Pending', acceptedQty: 0, reworkQty: 0, scrapQty: 0, remarks: '' }
  },
  finishing: {
    coatingRequired: false,
    coatingType: 'Blackening / Anodizing / Plating',
    status: 'Pending',
    packingStatus: 'Pending'
  }
});

const INITIAL_JOB_CARDS = [];

const ProductionPage = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [jobCards, setJobCards] = useState([]);
  const [salesOrders, setSalesOrders] = useState([]);
  const [customerPOs, setCustomerPOs] = useState([]);
  const [selectedJC, setSelectedJC] = useState(null);
  const [activeTab, setActiveTab] = useState('ALL'); // 'ALL' | 'IN_PRODUCTION' | 'QC_INSPECTION' | 'COMPLETED'
  const [projectFilter, setProjectFilter] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [customerFilter, setCustomerFilter] = useState('All');
  const [soFilter, setSoFilter] = useState('All');
  const [jcSearch, setJcSearch] = useState('');

  // Form State for Create / Edit Job Card
  const [formData, setFormData] = useState(makeInitialFormData());

  // Role context (requirement: department/role-based permissions enforced in logic)
  const isProdEmployee = isRole('production_employee');
  const myEmpId = getMyEmployeeId();
  const canCreateJourney = hasPermission('job_card.create');
  const scopedJobCards = useMemo(() => {
    if (!isProdEmployee || !myEmpId) return jobCards;
    return jobCards.filter((j) => j.assignedToEmpId === myEmpId);
  }, [jobCards, isProdEmployee, myEmpId]);

  // Load from localStorage
  useEffect(() => {
    try {
      const storedJC = localStorage.getItem('productionJobCards');
      setJobCards(storedJC ? JSON.parse(storedJC) : []);
    } catch {
      setJobCards([]);
    }

    try {
      const storedSO = localStorage.getItem('salesOrderHistory');
      if (storedSO) setSalesOrders(JSON.parse(storedSO));
    } catch {
      setSalesOrders([]);
    }

    try {
      const storedPO = localStorage.getItem('customerPOHistory');
      if (storedPO) setCustomerPOs(JSON.parse(storedPO));
    } catch {
      setCustomerPOs([]);
    }
  }, []);

  useEffect(() => {
    if (location.state?.fromSalesOrder && location.state?.salesOrder) {
      const p = location.state.salesOrder;
      const firstItem = p.items?.[0] || {};
      const inheritedProjectId = p.soDetails?.projectId || '';
      const inheritedProjectName = getProjectNameForId(inheritedProjectId) || '';
      setFormData((prev) => ({
        ...prev,
        projectId: inheritedProjectId || prev.projectId,
        projectName: inheritedProjectName || prev.projectName,
        salesOrderRef: p.soDetails?.soNumber || '',
        customerName: p.customerDetails?.companyName || p.customerDetails?.customerName || '',
        partName: firstItem.itemName || '',
        drawingNumber: firstItem.drawingNo || '',
        orderQuantity: firstItem.quantity || 1,
        invNo: prev.invNo || p.soDetails?.invNo || '',
        partNumber: prev.partNumber || firstItem.itemCode || '',
        drawingRev: prev.drawingRev || firstItem.drawingRev || '',
        material: prev.material || firstItem.materialSpec || '',
        lotQty: prev.lotQty || firstItem.quantity || 1,
        rawMaterial: {
          ...prev.rawMaterial,
          dimensions: firstItem.itemCode ? `Spec for ${firstItem.itemCode}` : prev.rawMaterial.dimensions,
          issuedQty: `${firstItem.quantity || 1} ${firstItem.unit || 'Nos'}`
        }
      }));
      setMode('create');
    } else if (location.state?.fromCustomerPO && location.state?.customerPO) {
      const p = location.state.customerPO;
      const firstItem = p.items?.[0] || {};
      const inheritedProjectId = p.poDetails?.projectId || '';
      const inheritedProjectName = getProjectNameForId(inheritedProjectId) || '';
      setFormData((prev) => ({
        ...prev,
        projectId: inheritedProjectId || prev.projectId,
        projectName: inheritedProjectName || prev.projectName,
        salesOrderRef: `PO: ${p.poDetails?.customerPoNumber || ''}`,
        customerName: p.customerDetails?.companyName || p.customerDetails?.customerName || '',
        partName: firstItem.itemName || '',
        drawingNumber: firstItem.drawingNo || '',
        orderQuantity: firstItem.quantity || 1,
        poNo: p.poDetails?.customerPoNumber || '',
        partNumber: firstItem.itemCode || '',
        drawingRev: firstItem.drawingRev || '',
        material: firstItem.materialSpec || '',
        lotQty: firstItem.quantity || p.poDetails?.quantity || 1,
        rawMaterial: {
          ...prev.rawMaterial,
          issuedQty: `${firstItem.quantity || 1} ${firstItem.unit || 'Nos'}`
        }
      }));
      setMode('create');
    } else if (location.state?.viewJobCard) {
      setSelectedJC(normalizeRouteCard(location.state.viewJobCard));
      setMode('view');
    }
  }, [location.state]);

  const [projectAutoLinkMsg, setProjectAutoLinkMsg] = useState('');

  const handleProjectLookup = (pid) => {
    if (!pid || !pid.trim()) {
      setProjectAutoLinkMsg('');
      return;
    }

    const data = getFullProjectData(pid);
    if (data) {
      const firstItem = data.items?.[0] || {};
      setFormData((prev) => ({
        ...prev,
        projectId: data.projectId || pid.trim().toUpperCase(),
        projectName: firstItem.itemName || data.customerDetails?.companyName || data.customerDetails?.customerName || '',
        salesOrderRef: data.soNumber || (data.customerPoNumber ? `PO: ${data.customerPoNumber}` : prev.salesOrderRef),
        customerName: data.customerDetails?.companyName || data.customerDetails?.customerName || prev.customerName,
        partName: firstItem.itemName || prev.partName,
        drawingNumber: firstItem.drawingNo || prev.drawingNumber,
        orderQuantity: firstItem.quantity || prev.orderQuantity,
        poNo: prev.poNo || data.customerPoNumber || firstItem.poNo || '',
        partNumber: prev.partNumber || firstItem.itemCode || '',
        drawingRev: prev.drawingRev || firstItem.drawingRev || '',
        material: prev.material || firstItem.materialSpec || firstItem.material || '',
        lotQty: prev.lotQty || firstItem.quantity || prev.orderQuantity,
        rawMaterial: {
          ...prev.rawMaterial,
          dimensions: firstItem.materialSpec || prev.rawMaterial.dimensions,
          issuedQty: `${firstItem.quantity || 1} ${firstItem.unit || 'Nos'}`
        }
      }));
      setProjectAutoLinkMsg(`✓ Auto-linked to Project: ${data.projectId} — ${firstItem.itemName || data.customerDetails?.companyName || data.customerDetails?.customerName || ''}`);
    } else {
      setProjectAutoLinkMsg('');
    }
  };

  const handleSelectCustomerPO = (poRef) => {
    if (!poRef) return;
    const match = customerPOs.find((c) => (c.reference || c.payload?.poDetails?.customerPoNumber) === poRef);
    if (match && match.payload) {
      const p = match.payload;
      const firstItem = p.items?.[0] || {};
      const inheritedProjectId = p.poDetails?.projectId || '';
      setFormData((prev) => ({
        ...prev,
        poNo: p.poDetails?.customerPoNumber || '',
        projectId: inheritedProjectId || prev.projectId,
        projectName: inheritedProjectId ? getProjectNameForId(inheritedProjectId) || prev.projectName : prev.projectName,
        salesOrderRef: `PO: ${p.poDetails?.customerPoNumber || ''}`,
        customerName: p.customerDetails?.companyName || p.customerDetails?.customerName || '',
        partName: firstItem.itemName || '',
        drawingNumber: firstItem.drawingNo || '',
        orderQuantity: firstItem.quantity || 1,
        partNumber: firstItem.itemCode || '',
        drawingRev: firstItem.drawingRev || '',
        material: firstItem.materialSpec || firstItem.material || '',
        lotQty: firstItem.quantity || 1,
        docDate: p.poDetails?.customerPoDate || prev.docDate,
        rawMaterial: {
          ...prev.rawMaterial,
          issuedQty: `${firstItem.quantity || 1} ${firstItem.unit || 'Nos'}`
        }
      }));
    }
  };

  const saveJobCardsToStorage = (updated) => {
    setJobCards(updated);
    localStorage.setItem('productionJobCards', JSON.stringify(updated));
  };

  const handleSelectSalesOrder = (soRef) => {
    const match = salesOrders.find((s) => s.reference === soRef);
    if (match && match.payload) {
      const p = match.payload;
      const firstItem = p.items?.[0] || {};
      const inheritedProjectId = p.soDetails?.projectId || '';
      setFormData((prev) => ({
        ...prev,
        salesOrderRef: soRef,
        projectId: inheritedProjectId || prev.projectId,
        projectName: inheritedProjectId ? getProjectNameForId(inheritedProjectId) || prev.projectName : prev.projectName,
        customerName: p.customerDetails?.companyName || p.customerDetails?.customerName || '',
        partName: firstItem.itemName || '',
        drawingNumber: firstItem.drawingNo || '',
        orderQuantity: firstItem.quantity || 1,
        partNumber: firstItem.itemCode || '',
        drawingRev: firstItem.drawingRev || '',
        material: firstItem.materialSpec || firstItem.material || '',
        lotQty: firstItem.quantity || 1,
        rawMaterial: {
          ...prev.rawMaterial,
          dimensions: firstItem.itemCode ? `Spec for ${firstItem.itemCode}` : prev.rawMaterial.dimensions,
          issuedQty: `${firstItem.quantity || 1} ${firstItem.unit || 'Nos'}`
        }
      }));
    }
  };

  const handleAddProcess = () => {
    setFormData((prev) => ({
      ...prev,
      processes: [...(Array.isArray(prev.processes) ? prev.processes : []), emptyProcess()]
    }));
  };

  const handleProcessChange = (idx, field, value) => {
    setFormData((prev) => {
      const list = Array.isArray(prev.processes) ? [...prev.processes] : [];
      if (!list[idx]) list[idx] = emptyProcess();
      list[idx] = { ...list[idx], [field]: value };

      // §10 / §17 — Route Card Quantity Flow:
      // The next operation's Input QTY must equal the previous operation's Output QTY (auto cascade).
      // Only apply when the next row exists and hasn't been manually overridden with a different value.
      if (field === 'outputQty') {
        const outVal = String(value || '').trim();
        if (outVal !== '') {
          const nextRow = list[idx + 1];
          if (nextRow) {
            const nextInput = String(nextRow.inputQty ?? '').trim();
            if (nextInput === '' || nextInput === String(list[idx].inputQty ?? '').trim()) {
              list[idx + 1] = { ...nextRow, inputQty: outVal };
            }
          }
        }
      }

      return { ...prev, processes: list };
    });
  };

  const handleDeleteProcess = (idx) => {
    setFormData((prev) => {
      const list = Array.isArray(prev.processes) ? [...prev.processes] : [];
      list.splice(idx, 1);
      return { ...prev, processes: list.length ? list : [emptyProcess()] };
    });
  };

  const handleSaveJobCard = (e) => {
    e.preventDefault();
    if (!formData.partName.trim()) {
      alert('Please enter Part / Component Name.');
      return;
    }

    if (!canCreateJourney && !jobCards.some((j) => j.jobCardNumber === formData.jobCardNumber)) {
      alert('Only a Production Manager can create a new Job Card.');
      return;
    }

    const normalizedProjectId = (formData.projectId || '').trim().toUpperCase();
    const normalizedForm = normalizeRouteCard({
      ...formData,
      lotQty: formData.lotQty === '' || formData.lotQty === undefined ? formData.orderQuantity : formData.lotQty
    });

    let updated;
    const existingIndex = jobCards.findIndex((j) => j.jobCardNumber === formData.jobCardNumber);
    if (existingIndex !== -1) {
      // Project ID is read-only after creation — never allow it to change on an existing Job Card.
      const existing = jobCards[existingIndex];
      const record = {
        ...normalizedForm,
        projectId: existing.projectId || normalizedProjectId,
        projectName: existing.projectId
          ? existing.projectName || getProjectNameForId(existing.projectId)
          : normalizedForm.projectName
      };
      updated = [...jobCards];
      updated[existingIndex] = record;
      setSelectedJC(normalizeRouteCard(record));
    } else {
      const record = {
        ...normalizedForm,
        projectId: normalizedProjectId,
        projectName: normalizedForm.projectName || (normalizedProjectId ? getProjectNameForId(normalizedProjectId) : '')
      };
      updated = [record, ...jobCards];
      setSelectedJC(normalizeRouteCard(record));
    }

    saveJobCardsToStorage(updated);
    setMode('view');
  };

  // Convert to Delivery Challan when ready
  const handleDispatchToChallan = (jc) => {
    navigate('/delivery-challan', {
      state: {
        fromSalesOrder: true,
        salesOrder: {
          soDetails: {
            soNumber: jc.salesOrderRef || jc.jobCardNumber,
            quotationRef: `Job Card: ${jc.jobCardNumber}`,
            projectId: jc.drawingNumber || ''
          },
          customerDetails: {
            customerName: jc.customerName,
            companyName: jc.customerName,
            address: 'Customer Plant'
          },
          companyDetails: {
            companyName: 'PRAGMATIC ENGINEERS'
          },
          items: [
            {
              itemCode: jc.jobCardNumber,
              itemName: jc.partName,
              drawingNo: jc.drawingNumber,
              hsnSac: '8483',
              quantity: jc.qualityControl?.finalQC?.acceptedQty || jc.orderQuantity,
              unit: 'Nos',
              unitPrice: 0,
              gst: '18'
            }
          ]
        }
      }
    });
  };

  // Filtered Job Cards
  const filteredJobCards = useMemo(() => {
    let base = scopedJobCards;
    if (activeTab === 'IN_PRODUCTION') base = scopedJobCards.filter((j) => j.status === 'In Production');
    else if (activeTab === 'QC_INSPECTION') base = scopedJobCards.filter((j) => j.status === 'QC Inspection');
    else if (activeTab === 'COMPLETED') base = scopedJobCards.filter((j) => j.status === 'Completed');
    if (projectFilter !== 'All') base = base.filter((j) => (j.projectId || '') === projectFilter);
    if (customerFilter !== 'All') base = base.filter((j) => (j.customerName || '') === customerFilter);
    if (soFilter !== 'All') base = base.filter((j) => (j.salesOrderRef || '') === soFilter);
    if (dateFrom) base = base.filter((j) => (j.startDate || '') >= dateFrom);
    if (dateTo) base = base.filter((j) => (j.startDate || '') <= dateTo);
    if (jcSearch.trim()) {
      const q = jcSearch.toLowerCase().trim();
      base = base.filter((j) =>
        [j.jobCardNumber, j.projectId, j.projectName, j.partName, j.customerName, j.salesOrderRef, j.drawingNumber]
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
    return base;
  }, [scopedJobCards, activeTab, projectFilter, customerFilter, soFilter, dateFrom, dateTo, jcSearch]);

  const projectFilterOptions = useMemo(() => {
    const set = new Set(scopedJobCards.map((j) => j.projectId || '').filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [scopedJobCards]);

  const customerFilterOptions = useMemo(() => {
    const set = new Set(scopedJobCards.map((j) => j.customerName || '').filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [scopedJobCards]);

  const soFilterOptions = useMemo(() => {
    const set = new Set(scopedJobCards.map((j) => j.salesOrderRef || '').filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [scopedJobCards]);

  // Project-level production stats for the dashboard (applies to job cards after status/date filter)
  const projectStats = useMemo(() => {
    const base = scopedJobCards;
    const scope = projectFilter !== 'All' ? base.filter((j) => (j.projectId || '') === projectFilter) : base;
    const projectsSet = new Set(scope.map((j) => j.projectId || '').filter(Boolean));
    const stats = {
      totalJobCards: scope.length,
      plannedQty: 0,
      producedQty: 0,
      reworkQty: 0,
      scrapQty: 0,
      wip: 0,
      materialPending: 0,
      qcPending: 0,
      completed: 0,
      inProduction: 0,
      projects: projectsSet.size
    };
    scope.forEach((j) => {
      const planned = Number(j.orderQuantity) || 0;
      const acc = Number(j.qualityControl?.finalQC?.acceptedQty) || 0;
      const rework = Number(j.qualityControl?.finalQC?.reworkQty) || 0;
      const scrap = Number(j.qualityControl?.finalQC?.scrapQty) || 0;
      stats.plannedQty += planned;
      stats.producedQty += acc;
      stats.reworkQty += rework;
      stats.scrapQty += scrap;
      if (j.status === 'In Production') stats.inProduction += 1;
      if (j.status === 'Completed') stats.completed += 1;
      const ms = j.materialStatus || '';
      if (j.status !== 'Completed' && (ms === 'Draft' || ms === 'Submitted' || ms === 'Pending Store' || ms === 'Partially Issued' || (!ms && !j.rawMaterial?.issueSlipNo))) stats.materialPending += 1;
      if (j.status === 'QC Inspection' || !j.operations?.setupApproval?.approved) stats.qcPending += 1;
    });
    stats.wip = stats.inProduction;
    return stats;
  }, [scopedJobCards, projectFilter]);

  const isExistingJobCard = useMemo(() => jobCards.some((j) => j.jobCardNumber === formData.jobCardNumber), [jobCards, formData.jobCardNumber]);

  const isHTOutsourced =
    formData.operations?.heatTreatment?.required &&
    (formData.operations.heatTreatment.outsourceMode === 'Outsourced' ||
      (!formData.operations.heatTreatment.outsourceMode && (formData.operations.heatTreatment.vendor || '').trim() !== '' && formData.operations.heatTreatment.vendor !== 'In-house' && formData.operations.heatTreatment.vendor !== 'Vendor name pending'));

  const linkedHTR = useMemo(() => {
    void jobCards;
    const list = getHTOutsourceRequests();
    const jcNo = mode === 'view' ? selectedJC?.jobCardNumber : formData.jobCardNumber;
    if (!jcNo) return null;
    return list.find((r) => r.jobCardNumber === jcNo && r.status !== 'Cancelled') || null;
  }, [mode, selectedJC, formData.jobCardNumber, jobCards]);

  const handleRaiseHTR = () => {
    const ht = formData.operations?.heatTreatment;
    if (!ht?.required) {
      alert('Heat Treatment is not marked as required on this Job Card.');
      return;
    }
    if (ht.outsourceMode !== 'Outsourced' && !(ht.vendor && ht.vendor.trim() && ht.vendor !== 'Vendor name pending')) {
      alert('Select In-house / Vendor = “Outsourced to Vendor” (and optionally pick the vendor) before raising an HT Outsource Request.');
      return;
    }
    if (!isExistingJobCard) {
      alert('Save the Job Card first, then raise the HT Outsource Request so Store can trace the JC number.');
      return;
    }
    if (linkedHTR) {
      navigate('/ht-outsource', { state: { viewHtrNumber: linkedHTR.htrNumber, fromJobCard: formData.jobCardNumber } });
      return;
    }
    if (!Number(formData.operations.heatTreatment.qtySent) || Number(formData.operations.heatTreatment.qtySent) <= 0) {
      alert('Enter Qty Sent (qty to send to heat-treat vendor) before raising the request.');
      return;
    }
    try {
      const vendorName = (ht.vendor || '').trim() === 'Vendor name pending' ? '' : (ht.vendor || '').trim();
      const rec = createHTOutsourceRequest({
        jobCardNumber: formData.jobCardNumber,
        projectId: formData.projectId || '',
        partName: formData.partName || '',
        drawingNumber: formData.drawingNumber || '',
        processType: ht.processType || '',
        processSpec: ht.process || '',
        targetHardness: ht.targetHardness || '',
        qtyRequested: Number(ht.qtySent) || 0,
        vendorName,
        needByDate: formData.targetDate || '',
        remarks: ht.remarks || ''
      });
      navigate('/ht-outsource', { state: { viewHtrNumber: rec.htrNumber, fromJobCard: formData.jobCardNumber } });
    } catch (e) {
      alert(e.message);
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">Shop Floor & Quality Engineering</p>
          <h1>
            {mode === 'create'
              ? 'Issue Production Job Card'
              : mode === 'view'
              ? `Job Card: ${selectedJC?.jobCardNumber || ''}`
              : 'Production & Quality Control (QC)'}
          </h1>
          {mode === 'list' && (
            <p className="page-description">
              Track manufacturing routing stages, operator assignments, raw material issues, and in-process/final quality inspections.
            </p>
          )}
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to Job Cards
            </button>
          ) : (
            canCreateJourney && (
            <button
              className="button-primary"
              onClick={() => {
                setFormData(makeInitialFormData());
                setMode('create');
              }}
            >
              + Issue Production Job Card
            </button>
            )
          )}
          <button
            className="button-secondary"
            onClick={() => navigate('/production/material-requests')}
          >
            Material Requests
          </button>
        </div>
      </div>

      {(mode !== 'list' || selectedJC?.drawingNumber || formData?.drawingNumber) && (
        <WorkflowNavigator
          projectId={selectedJC?.drawingNumber || formData?.drawingNumber}
          currentStage="production"
        />
      )}

      {/* Production KPIs */}
      {mode === 'list' && (
        <div className="kpi-grid" style={{ marginBottom: '24px' }}>
          <div className="kpi-card">
            <span className="kpi-title">Active Job Cards on Floor</span>
            <div className="kpi-value" style={{ color: '#2563eb' }}>
              {scopedJobCards.filter((j) => j.status === 'In Production').length} Batches
            </div>
            <span className="kpi-delta positive">Turning & Machining active</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Awaiting QC & Setup Sign-off</span>
            <div className="kpi-value" style={{ color: '#d97706' }}>
              {scopedJobCards.filter((j) => !j.operations?.setupApproval?.approved || j.status === 'QC Inspection').length} Orders
            </div>
            <span className="kpi-delta neutral">Setup / In-Process QC check</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Coating & Packing Stage</span>
            <div className="kpi-value">
              {scopedJobCards.filter((j) => j.finishing?.coatingRequired && j.finishing?.status !== 'Completed').length} Batches
            </div>
            <span className="kpi-delta positive">Surface treatment & preservation</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Passed & Ready for Dispatch</span>
            <div className="kpi-value" style={{ color: '#166534' }}>
              {scopedJobCards.filter((j) => j.qualityControl?.finalQC?.disposition === 'Pass' || j.status === 'Completed').length} Batches
            </div>
            <span className="kpi-delta positive">100% Inspected & Approved</span>
          </div>
        </div>
      )}

      {/* Project-level Production Insights */}
      {mode === 'list' && (
        <div className="content-block" style={{ marginBottom: '22px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">
              {projectFilter === 'All' ? 'Production Pipeline — All Projects' : `Project Pipeline — ${projectFilter}`}
            </h3>
            <span className="muted-text">{projectStats.totalJobCards} Job Card(s) · {projectStats.projects} project(s) in scope</span>
          </div>
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className="kpi-card">
              <span className="kpi-title">Total Job Cards</span>
              <div className="kpi-value" style={{ color: '#1e293b' }}>{projectStats.totalJobCards} Cards</div>
              <span className="kpi-delta neutral">{projectStats.inProduction} currently on the floor</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">Planned Quantity</span>
              <div className="kpi-value" style={{ color: '#2563eb' }}>{projectStats.plannedQty} Nos</div>
              <span className="kpi-delta positive">Across all routes</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">Produced / Accepted</span>
              <div className="kpi-value" style={{ color: '#166534' }}>{projectStats.producedQty} Nos</div>
              <span className="kpi-delta positive">Final QC accepted</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">WIP</span>
              <div className="kpi-value" style={{ color: '#d97706' }}>{projectStats.wip} Batches</div>
              <span className="kpi-delta neutral">In Production now</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">Material Pending</span>
              <div className="kpi-value" style={{ color: projectStats.materialPending > 0 ? '#b91c1c' : '#166534' }}>{projectStats.materialPending} Cards</div>
              <span className="kpi-delta negative">Awaiting store issue</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">QC Pending</span>
              <div className="kpi-value" style={{ color: projectStats.qcPending > 0 ? '#b45309' : '#166534' }}>{projectStats.qcPending} Cards</div>
              <span className="kpi-delta neutral">Inspection / sign-off due</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">Completed</span>
              <div className="kpi-value" style={{ color: '#166534' }}>{projectStats.completed} Cards</div>
              <span className="kpi-delta positive">Ready for dispatch</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-title">Rework / Scrap</span>
              <div className="kpi-value" style={{ color: projectStats.scrapQty + projectStats.reworkQty > 0 ? '#b91c1c' : '#166534' }}>
                {projectStats.reworkQty + projectStats.scrapQty} Nos
              </div>
              <span className="kpi-delta negative">QC rejects (Rework {projectStats.reworkQty} / Scrap {projectStats.scrapQty})</span>
            </div>
          </div>
        </div>
      )}

      <div className="content-block">
        {mode === 'list' && (
          <>
            {/* Filter Tabs */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', borderBottom: '1px solid #e5e7eb', paddingBottom: '14px', marginBottom: '20px', alignItems: 'center' }}>
              <button
                className={activeTab === 'ALL' ? 'button-primary' : 'button-secondary'}
                onClick={() => setActiveTab('ALL')}
                style={{ padding: '8px 16px' }}
              >
                All Job Cards ({scopedJobCards.length})
              </button>
              <button
                className={activeTab === 'IN_PRODUCTION' ? 'button-primary' : 'button-secondary'}
                onClick={() => setActiveTab('IN_PRODUCTION')}
                style={{ padding: '8px 16px' }}
              >
                In Production ({scopedJobCards.filter((j) => j.status === 'In Production').length})
              </button>
              <button
                className={activeTab === 'QC_INSPECTION' ? 'button-primary' : 'button-secondary'}
                onClick={() => setActiveTab('QC_INSPECTION')}
                style={{ padding: '8px 16px' }}
              >
                QC Inspection Stage ({scopedJobCards.filter((j) => j.status === 'QC Inspection').length})
              </button>
              <button
                className={activeTab === 'COMPLETED' ? 'button-primary' : 'button-secondary'}
                onClick={() => setActiveTab('COMPLETED')}
                style={{ padding: '8px 16px' }}
              >
                Completed & Packed ({scopedJobCards.filter((j) => j.status === 'Completed').length})
              </button>
              <span style={{ flex: 1 }} />
              <input
                type="text"
                className="action-select form-input"
                style={{ width: '190px' }}
                placeholder="Search JC / project / part / SO..."
                value={jcSearch}
                onChange={(e) => setJcSearch(e.target.value)}
              />
              <select
                className="action-select"
                style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
              >
                {projectFilterOptions.map((p) => (
                  <option key={p} value={p}>{p === 'All' ? 'All Projects' : `Project: ${p}`}</option>
                ))}
              </select>
              <select
                className="action-select"
                style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
              >
                {customerFilterOptions.map((c) => (
                  <option key={c} value={c}>{c === 'All' ? 'All Customers' : c}</option>
                ))}
              </select>
              <select
                className="action-select"
                style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                value={soFilter}
                onChange={(e) => setSoFilter(e.target.value)}
              >
                {soFilterOptions.map((s) => (
                  <option key={s} value={s}>{s === 'All' ? 'All SO Refs' : s}</option>
                ))}
              </select>
              <input
                type="date"
                className="action-select form-input"
                style={{ width: '150px' }}
                title="Start date from"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
              <input
                type="date"
                className="action-select form-input"
                style={{ width: '150px' }}
                title="Start date to"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>

            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Job Card No.</th>
                    <th>Project ID</th>
                    <th>SO Ref</th>
                    <th>Component / Part</th>
                    <th>Drawing No.</th>
                    <th>Material Type</th>
                    <th>Qty</th>
                    <th>Current Operation</th>
                    <th>QC Status</th>
                    <th>Status</th>
                    <th>Assigned To</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobCards.length > 0 ? (
                    filteredJobCards.map((jc) => {
                      let currentOp = 'Turning';
                      if (jc.operations?.turning?.status === 'Completed') currentOp = 'Milling / Grinding';
                      if (jc.operations?.millingGrinding?.status === 'Completed') currentOp = 'Setup Approval';
                      if (jc.operations?.setupApproval?.approved) {
                        currentOp = jc.operations?.heatTreatment?.required ? 'Heat Treatment' : 'Wire Cutting / Drilling / Sparking';
                        const htDone =
                          !jc.operations?.heatTreatment?.required ||
                          (jc.operations.heatTreatment.status === 'Completed' && jc.operations.heatTreatment.disposition !== 'Fail');
                        if (htDone) {
                          currentOp = 'Wire Cutting / Drilling / Sparking';
                        }
                        if (jc.operations?.heatTreatment?.status === 'Failed / Rework' || jc.operations?.heatTreatment?.disposition === 'Fail') {
                          currentOp = 'Heat Treatment (Rework)';
                        }
                        if (htDone && jc.operations?.machineProcess?.status === 'Completed') {
                          currentOp = jc.finishing?.coatingRequired ? 'Surface Treatment' : 'Quality Inspection';
                          if (jc.finishing?.status === 'Completed' || !jc.finishing?.coatingRequired) {
                            currentOp = 'Quality Inspection';
                          }
                          if (jc.qualityControl?.finalQC?.disposition === 'Pass') currentOp = 'Coating / Packing';
                        }
                      }

                      return (
                        <tr key={jc.jobCardNumber}>
                          <td><strong>{jc.jobCardNumber}</strong></td>
                          <td>
                            {jc.projectId ? (
                              <>
                                <strong style={{ color: '#3730a3' }}>{jc.projectId}</strong>
                                {jc.projectName && (
                                  <div style={{ fontSize: '11px', color: '#64748b' }}>{jc.projectName}</div>
                                )}
                              </>
                            ) : (
                              <span style={{ color: '#94a3b8' }}>-</span>
                            )}
                          </td>
                          <td>{jc.salesOrderRef || '-'}</td>
                          <td>
                            <strong>{jc.partName}</strong>
                            <div style={{ fontSize: '11px', color: '#64748b' }}>{jc.customerName}</div>
                          </td>
                          <td>{jc.drawingNumber || '-'}</td>
                          <td>
                            <span style={{ fontSize: '12px', color: '#334155' }}>
                              {jc.rawMaterial?.type === 'Round Material Type' ? '🔵 Round' : '🟨 Square/Rect'}
                            </span>
                          </td>
                          <td><strong>{jc.orderQuantity} Nos</strong></td>
                          <td>
                            <span style={{ fontSize: '12px', fontWeight: '600', color: '#1e293b' }}>
                              {currentOp}
                            </span>
                          </td>
                          <td>
                            <span
                              style={{
                                padding: '3px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: '700',
                                background:
                                  jc.qualityControl?.finalQC?.disposition === 'Pass'
                                    ? '#dcfce7'
                                    : jc.qualityControl?.finalQC?.disposition === 'Rework'
                                    ? '#fef3c7'
                                    : '#f1f5f9',
                                color:
                                  jc.qualityControl?.finalQC?.disposition === 'Pass'
                                    ? '#166534'
                                    : jc.qualityControl?.finalQC?.disposition === 'Rework'
                                    ? '#92400e'
                                    : '#475569'
                              }}
                            >
                              {jc.qualityControl?.finalQC?.disposition || 'In-Process'}
                            </span>
                          </td>
                          <td>
                            <span
                              style={{
                                padding: '4px 10px',
                                borderRadius: '20px',
                                fontSize: '11.5px',
                                fontWeight: '700',
                                background:
                                  jc.status === 'Completed'
                                    ? '#dcfce7'
                                    : jc.status === 'In Production'
                                    ? '#e0e7ff'
                                    : '#fef3c7',
                                color:
                                  jc.status === 'Completed'
                                    ? '#166534'
                                    : jc.status === 'In Production'
                                    ? '#3730a3'
                                    : '#92400e'
                              }}
                            >
                              {jc.status}
                            </span>
                          </td>
                          <td>
                            {jc.assignedTo ? (
                              <>
                                <span style={{ fontSize: '12px', fontWeight: '600', color: '#1e293b' }}>{jc.assignedTo}</span>
                                <div style={{ fontSize: '11px', color: '#64748b' }}>{jc.assignedToEmpId}</div>
                              </>
                            ) : (
                              <span style={{ fontSize: '12px', color: '#94a3b8' }}>Unassigned</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                className="button-small"
                                onClick={() => {
                                  setSelectedJC(normalizeRouteCard(jc));
                                  setMode('view');
                                }}
                              >
                                View Route Card
                              </button>
                              <button
                                className="button-small"
                                onClick={() => {
                                  setFormData(normalizeRouteCard(jc));
                                  setMode('create');
                                }}
                              >
                                Update Stage
                              </button>
                              {canCreateJourney && jc.qualityControl?.finalQC?.disposition === 'Pass' && (
                                <button
                                  className="button-small"
                                  style={{ color: '#16a34a', borderColor: '#bbf7d0' }}
                                  onClick={() => handleDispatchToChallan(jc)}
                                  title="Dispatch in Delivery Challan"
                                >
                                  Dispatch
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={12} className="no-history-row">
                        No Job Cards found in this status. Click "+ Issue Production Job Card".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {mode === 'create' && (
          <form className="quotation-form" onSubmit={handleSaveJobCard}>
            {/* 1. Job Card Details (merged header + print document) */}
            <div className="form-section">
              <div className="section-heading">
                <h3>1. Job Card Details</h3>
              </div>
              <div className="section-grid">
                {/* Auto-fill from Customer PO (spans all rows) */}
                <div className="field-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Auto-fill from Customer PO</label>
                  <select
                    value={formData.poNo || ''}
                    onChange={(e) => handleSelectCustomerPO(e.target.value)}
                  >
                    <option value="">-- Select Customer PO --</option>
                    {customerPOs.map((c) => {
                      const ref = c.reference || c.payload?.poDetails?.customerPoNumber || '';
                      return (
                        <option key={ref} value={ref}>
                          {ref} · {c.company || c.payload?.customerDetails?.companyName || '-'}
                        </option>
                      );
                    })}
                  </select>
                  <span className="field-hint">Selecting a Customer PO pulls PO No, PO Date, Part, Drawing Rev, Material & Lot Qty.</span>
                </div>

                {/* ROW 1: Job Card Number | Link to Sales Order | Project ID */}
                <div className="field-group">
                  <label>Job Card Number</label>
                  <input
                    type="text"
                    value={formData.jobCardNumber}
                    readOnly
                    style={{ background: '#f1f5f9', color: '#334155', fontWeight: '600' }}
                  />
                </div>
                <div className="field-group">
                  <label>Link to Sales Order</label>
                  <select
                    value={formData.salesOrderRef}
                    onChange={(e) => handleSelectSalesOrder(e.target.value)}
                  >
                    <option value="">-- Select Sales Order --</option>
                    {salesOrders.map((so) => (
                      <option key={so.reference} value={so.reference}>
                        {so.reference} - {so.company}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-group">
                  <label>Project ID {isExistingJobCard && <span style={{ fontSize: '11px', color: '#64748b' }}>(locked after creation)</span>}</label>
                  <ProjectIdAutocomplete
                    value={formData.projectId}
                    onChange={(val) => setFormData((prev) => ({ ...prev, projectId: val }))}
                    onSelectProject={(pid) => handleProjectLookup(pid)}
                    placeholder="Search Project ID / Customer / PO..."
                    autoLinkMsg={projectAutoLinkMsg}
                    disabled={isExistingJobCard}
                  />
                </div>

                {/* ROW 2: Project Name | Customer Name | Part / Component Name */}
                <div className="field-group">
                  <label>Project Name</label>
                  <input
                    type="text"
                    value={formData.projectName}
                    readOnly
                    placeholder="Auto-derived from Project ID"
                    style={{ background: '#f1f5f9', color: '#334155', fontWeight: '600' }}
                  />
                </div>
                <div className="field-group">
                  <label>Customer Name</label>
                  <input
                    type="text"
                    value={formData.customerName}
                    onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Part / Component Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.partName}
                    onChange={(e) => setFormData({ ...formData, partName: e.target.value })}
                  />
                </div>

                {/* ROW 3: Drawing Number | Part Number | Production / Lot Quantity */}
                <div className="field-group">
                  <label>Drawing Number</label>
                  <input
                    type="text"
                    value={formData.drawingNumber}
                    onChange={(e) => setFormData({ ...formData, drawingNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Part Number</label>
                  <input
                    type="text"
                    value={formData.partNumber}
                    onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Production / Lot Quantity *</label>
                  <input
                    type="number"
                    min="1"
                    value={formData.orderQuantity}
                    onChange={(e) => setFormData({ ...formData, orderQuantity: Number(e.target.value) })}
                  />
                </div>

                {/* ROW 4: Customer PO Number | PO Date | Production Start Date */}
                <div className="field-group">
                  <label>Customer PO Number</label>
                  <input
                    type="text"
                    value={formData.poNo || ''}
                    onChange={(e) => setFormData({ ...formData, poNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>PO Date</label>
                  <input
                    type="date"
                    value={formData.poDate || ''}
                    onChange={(e) => setFormData({ ...formData, poDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Production Start Date</label>
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                  />
                </div>

                {/* ROW 5: Target Completion Date | Overall Status | INV / GRN Number */}
                <div className="field-group">
                  <label>Target Completion Date</label>
                  <input
                    type="date"
                    value={formData.targetDate}
                    onChange={(e) => setFormData({ ...formData, targetDate: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Overall Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  >
                    <option value="Draft">Draft</option>
                    <option value="Ready for Production">Ready for Production</option>
                    <option value="In Production">In Production</option>
                    <option value="QC Pending">QC Pending</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>INV / GRN Number</label>
                  <input
                    type="text"
                    value={formData.invNo || ''}
                    onChange={(e) => setFormData({ ...formData, invNo: e.target.value })}
                  />
                </div>

                {/* ROW 6: Material | Drawing Revision | Material Test Certificate No */}
                <div className="field-group">
                  <label>Material</label>
                  <input
                    type="text"
                    placeholder="e.g. Aluminium 6061 T6"
                    value={formData.material || ''}
                    onChange={(e) => setFormData({ ...formData, material: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Drawing Revision</label>
                  <input
                    type="text"
                    value={formData.drawingRev || ''}
                    onChange={(e) => setFormData({ ...formData, drawingRev: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Material Test Certificate No</label>
                  <input
                    type="text"
                    value={formData.materialCertNo || ''}
                    onChange={(e) => setFormData({ ...formData, materialCertNo: e.target.value })}
                  />
                </div>

                {/* ROW 7: Document Number | Revision Number | Document Date */}
                <div className="field-group">
                  <label>Document Number</label>
                  <input
                    type="text"
                    value={formData.docNo || ''}
                    onChange={(e) => setFormData({ ...formData, docNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Revision Number</label>
                  <input
                    type="text"
                    value={formData.revNo || ''}
                    onChange={(e) => setFormData({ ...formData, revNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Document Date</label>
                  <input
                    type="date"
                    value={formData.docDate || ''}
                    onChange={(e) => setFormData({ ...formData, docDate: e.target.value })}
                  />
                </div>
              </div>
            </div>

            {/* Route Card Document Details */}
            <div className="form-section">
              <div className="section-heading">
                <h3>2. Route Card (Print Document) Details</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Auto-fill from Customer PO</label>
                  <select
                    value={formData.poNo || ''}
                    onChange={(e) => handleSelectCustomerPO(e.target.value)}
                  >
                    <option value="">-- Select Customer PO --</option>
                    {customerPOs.map((c) => {
                      const ref = c.reference || c.payload?.poDetails?.customerPoNumber || '';
                      return (
                        <option key={ref} value={ref}>
                          {ref} · {c.company || c.payload?.customerDetails?.companyName || '-'}
                        </option>
                      );
                    })}
                  </select>
                  <span className="field-hint">Selecting a Customer PO pulls PO No, Part, Drawing Rev, Material & Lot Qty.</span>
                </div>
                <div className="field-group">
                  <label>PO No</label>
                  <input
                    type="text"
                    value={formData.poNo || ''}
                    onChange={(e) => setFormData({ ...formData, poNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>INV No</label>
                  <input
                    type="text"
                    value={formData.invNo || ''}
                    onChange={(e) => setFormData({ ...formData, invNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Part Number</label>
                  <input
                    type="text"
                    value={formData.partNumber || ''}
                    onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Drawing Rev</label>
                  <input
                    type="text"
                    value={formData.drawingRev || ''}
                    onChange={(e) => setFormData({ ...formData, drawingRev: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Lot Qty (Nos)</label>
                  <input
                    type="number"
                    min="1"
                    value={formData.lotQty || ''}
                    onChange={(e) => setFormData({ ...formData, lotQty: Number(e.target.value) })}
                  />
                </div>
                <div className="field-group">
                  <label>Material</label>
                  <input
                    type="text"
                    placeholder="e.g. Aluminium 6061 T6"
                    value={formData.material || ''}
                    onChange={(e) => setFormData({ ...formData, material: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Material Test Certificate No</label>
                  <input
                    type="text"
                    value={formData.materialCertNo || ''}
                    onChange={(e) => setFormData({ ...formData, materialCertNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Document No</label>
                  <input
                    type="text"
                    value={formData.docNo || ''}
                    onChange={(e) => setFormData({ ...formData, docNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Revision No</label>
                  <input
                    type="text"
                    value={formData.revNo || ''}
                    onChange={(e) => setFormData({ ...formData, revNo: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Document Date</label>
                  <input
                    type="date"
                    value={formData.docDate || ''}
                    onChange={(e) => setFormData({ ...formData, docDate: e.target.value })}
                  />
                </div>
              </div>
            </div>

            {/* Process Routing Table (Route Card) */}
            <div className="form-section">
              <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>3. Process Routing (Route Card Table)</h3>
                <button type="button" className="button-small" onClick={handleAddProcess} style={{ color: '#1d4ed8', borderColor: '#93c5fd' }}>
                  + Add Process
                </button>
              </div>
              <div className="route-form-table-wrapper">
                <table className="route-form-table">
                  <thead>
                    <tr>
                      <th style={{ width: '64px' }}>#</th>
                      <th>Process</th>
                      <th>Machine No</th>
                      <th>Input QTY</th>
                      <th>Output QTY</th>
                      <th>Rework QTY</th>
                      <th>Reject QTY</th>
                      <th>Start Time</th>
                      <th>End Time</th>
                      <th>Operator / Inspector</th>
                      <th style={{ width: '52px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(formData.processes) ? formData.processes : [emptyProcess()]).map((proc, idx) => (
                      <tr key={proc.id || idx}>
                        <td className="text-center">{idx + 1}</td>
                        <td>
                          <input
                            type="text"
                            placeholder="e.g. 1-a (FACE E)"
                            value={proc.process || ''}
                            onChange={(e) => handleProcessChange(idx, 'process', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="e.g. VMC 540"
                            value={proc.machineNo || ''}
                            onChange={(e) => handleProcessChange(idx, 'machineNo', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={proc.inputQty || ''}
                            onChange={(e) => handleProcessChange(idx, 'inputQty', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={proc.outputQty || ''}
                            onChange={(e) => handleProcessChange(idx, 'outputQty', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={proc.reworkQty || ''}
                            onChange={(e) => handleProcessChange(idx, 'reworkQty', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={proc.rejectQty || ''}
                            onChange={(e) => handleProcessChange(idx, 'rejectQty', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="e.g. 8th Jan"
                            value={proc.startTime || ''}
                            onChange={(e) => handleProcessChange(idx, 'startTime', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="e.g. 13th Jan"
                            value={proc.endTime || ''}
                            onChange={(e) => handleProcessChange(idx, 'endTime', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="e.g. Somashekar & Basavaraj"
                            value={proc.operator || ''}
                            onChange={(e) => handleProcessChange(idx, 'operator', e.target.value)}
                          />
                        </td>
                        <td className="text-center">
                          <button
                            type="button"
                            className="button-small"
                            style={{ color: '#b91c1c', borderColor: '#fecaca', padding: '2px 8px', height: '26px' }}
                            onClick={() => handleDeleteProcess(idx)}
                            title="Delete process row"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Raw Material Issue */}
            <div className="form-section">
              <div className="section-heading">
                <h3>4. Raw Material Specification & Issue Slip</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Raw Material Form Type</label>
                  <select
                    value={formData.rawMaterial.type}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rawMaterial: { ...formData.rawMaterial, type: e.target.value }
                      })
                    }
                  >
                    <option value="Round Material Type">Round Material Type (Bar / Rod)</option>
                    <option value="Square / Rectangle Material Type">Square / Rectangle Material Type (Block / Plate)</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>Material Grade</label>
                  <input
                    type="text"
                    placeholder="e.g. EN24, SS 304, AL 6061, Mild Steel"
                    value={formData.rawMaterial.grade}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rawMaterial: { ...formData.rawMaterial, grade: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Raw Material Cut Dimensions</label>
                  <input
                    type="text"
                    placeholder="e.g. Dia 60mm x 320mm or 100x80x50mm"
                    value={formData.rawMaterial.dimensions}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rawMaterial: { ...formData.rawMaterial, dimensions: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Heat / Melt / Lot No.</label>
                  <input
                    type="text"
                    placeholder="e.g. HT-9821"
                    value={formData.rawMaterial.heatNumber}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        rawMaterial: { ...formData.rawMaterial, heatNumber: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Raw Material Status</label>
                  <input
                    type="text"
                    className="readonly-field"
                    placeholder="Auto-link to Store Issues"
                    value="Auto-tracked via Material Requests & Store Issues"
                    readOnly
                  />
                  <span className="field-hint">Store Issue (SI) numbers are auto-generated when the Store issues material.</span>
                </div>
              </div>
            </div>

            {/* Machining Routing Operations */}
            <div className="form-section">
              <div className="section-heading">
                <h3>5. Machining Operations & Setup Approvals</h3>
              </div>

              {/* Turning Stage */}
              <div style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #e2e8f0' }}>
                <strong style={{ color: '#1e293b' }}>Operation 10: Turning (CNC / Lathe)</strong>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Turning Status</label>
                    <select
                      value={formData.operations.turning.status}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            turning: { ...formData.operations.turning, status: e.target.value }
                          }
                        })
                      }
                    >
                      <option value="Pending">Pending</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Machine Name / No.</label>
                    <input
                      type="text"
                      value={formData.operations.turning.machine}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            turning: { ...formData.operations.turning, machine: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>Operator Name</label>
                    <input
                      type="text"
                      value={formData.operations.turning.operator}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            turning: { ...formData.operations.turning, operator: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                  <div className="field-group full-width">
                    <label>Turning Notes / Parameters</label>
                    <input
                      type="text"
                      placeholder="e.g. Rough turn OD 58mm, face length 318mm"
                      value={formData.operations.turning.notes}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            turning: { ...formData.operations.turning, notes: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Milling / Grinding Stage */}
              <div style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #e2e8f0' }}>
                <strong style={{ color: '#1e293b' }}>Operation 20: Milling / Grinding (VMC / Surface Grinder)</strong>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Milling/Grinding Status</label>
                    <select
                      value={formData.operations.millingGrinding.status}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            millingGrinding: { ...formData.operations.millingGrinding, status: e.target.value }
                          }
                        })
                      }
                    >
                      <option value="Pending">Pending</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Machine Station</label>
                    <input
                      type="text"
                      value={formData.operations.millingGrinding.machine}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            millingGrinding: { ...formData.operations.millingGrinding, machine: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>Operator Name</label>
                    <input
                      type="text"
                      value={formData.operations.millingGrinding.operator}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            millingGrinding: { ...formData.operations.millingGrinding, operator: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                  <div className="field-group full-width">
                    <label>Milling Notes / Program No.</label>
                    <input
                      type="text"
                      placeholder="e.g. Program O0024 - Slot milling and surface grinding to 0.8 Ra"
                      value={formData.operations.millingGrinding.notes}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            millingGrinding: { ...formData.operations.millingGrinding, notes: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Setup Approval Stage */}
              <div style={{ background: '#f0fdf4', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #bbf7d0' }}>
                <strong style={{ color: '#166534' }}>✓ Setup Approval (First Piece Inspection Sign-off)</strong>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Setup Approved?</label>
                    <select
                      value={formData.operations.setupApproval.approved ? 'YES' : 'NO'}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            setupApproval: {
                              ...formData.operations.setupApproval,
                              approved: e.target.value === 'YES',
                              approvalDate: e.target.value === 'YES' ? new Date().toLocaleString() : ''
                            }
                          }
                        })
                      }
                    >
                      <option value="NO">❌ Not Approved (Setup In Progress)</option>
                      <option value="YES">✅ Approved by Quality / Supervisor</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Approved By (Quality Lead / Supervisor)</label>
                    <input
                      type="text"
                      placeholder="e.g. G. Sharma"
                      value={formData.operations.setupApproval.approvedBy}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            setupApproval: { ...formData.operations.setupApproval, approvedBy: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Heat Treatment Stage */}
              <div style={{ background: '#fffbeb', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #fde68a' }}>
                <strong style={{ color: '#92400e' }}>Operation 30: Heat Treatment</strong>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Heat Treatment Required?</label>
                    <select
                      value={formData.operations.heatTreatment.required ? 'YES' : 'NO'}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            heatTreatment: {
                              ...formData.operations.heatTreatment,
                              required: e.target.value === 'YES'
                            }
                          }
                        })
                      }
                    >
                      <option value="NO">No Heat Treatment</option>
                      <option value="YES">Yes (Hardening / Tempering / Annealing)</option>
                    </select>
                  </div>
                  {formData.operations.heatTreatment.required && (
                    <>
                      <div className="field-group">
                        <label>Process Type *</label>
                        <select
                          value={formData.operations.heatTreatment.processType || 'Hardening'}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, processType: e.target.value }
                              }
                            })
                          }
                        >
                          <option value="Hardening">Hardening</option>
                          <option value="Tempering">Tempering</option>
                          <option value="Annealing">Annealing</option>
                          <option value="Case Hardening">Case Hardening / Carburizing</option>
                          <option value="Induction Hardening">Induction Hardening</option>
                          <option value="Stress Relieving">Stress Relieving</option>
                          <option value="Normalizing">Normalizing</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div className="field-group">
                        <label>Spec / Recipe (Temp & Cycle)</label>
                        <input
                          type="text"
                          placeholder="e.g. Austenitize 850°C, Oil Quench, Temper 180°C x 2hrs"
                          value={formData.operations.heatTreatment.process || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, process: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>Target Hardness *</label>
                        <input
                          type="text"
                          placeholder="e.g. 52-55 HRC"
                          value={formData.operations.heatTreatment.targetHardness || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, targetHardness: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>In-house / Vendor</label>
                        <select
                          value={formData.operations.heatTreatment.outsourceMode || (formData.operations.heatTreatment.vendor ? 'Outsourced' : 'In-house')}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: {
                                  ...formData.operations.heatTreatment,
                                  outsourceMode: e.target.value,
                                  vendor: e.target.value === 'In-house' ? '' : formData.operations.heatTreatment.vendor
                                }
                              }
                            })
                          }
                        >
                          <option value="In-house">In-house Furnace</option>
                          <option value="Outsourced">Outsourced to Vendor</option>
                        </select>
                      </div>
                      {(formData.operations.heatTreatment.outsourceMode || (formData.operations.heatTreatment.vendor ? 'Outsourced' : 'In-house')) === 'Outsourced' && (
                        <div className="field-group">
                          <label>Heat Treat Vendor (optional — Purchase can assign)</label>
                          <VendorMasterAutocomplete
                            value={formData.operations.heatTreatment.vendor === 'Vendor name pending' ? '' : formData.operations.heatTreatment.vendor || ''}
                            onChange={(val) =>
                              setFormData({
                                ...formData,
                                operations: {
                                  ...formData.operations,
                                  heatTreatment: { ...formData.operations.heatTreatment, vendor: val }
                                }
                              })
                            }
                            onSelect={(v) =>
                              setFormData({
                                ...formData,
                                operations: {
                                  ...formData.operations,
                                  heatTreatment: {
                                    ...formData.operations.heatTreatment,
                                    vendor: v.name || '',
                                    vendorAddress: v.address || '',
                                    vendorPhone: v.phone || '',
                                    vendorEmail: v.email || ''
                                  }
                                }
                              })
                            }
                            placeholder="Search Vendor Master..."
                          />
                        </div>
                      )}
                      <div className="field-group">
                        <label>{isHTOutsourced ? 'Qty to Send to Vendor (Nos)' : 'Qty Sent (Nos)'}</label>
                        <input
                          type="number"
                          min="0"
                          value={formData.operations.heatTreatment.qtySent ?? 0}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, qtySent: Number(e.target.value) }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>Qty Received Back (Nos)</label>
                        <input
                          type="number"
                          min="0"
                          value={formData.operations.heatTreatment.qtyReceived ?? 0}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, qtyReceived: Number(e.target.value) }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>Sent Date</label>
                        <input
                          type="date"
                          value={formData.operations.heatTreatment.sentDate || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, sentDate: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>Received Date</label>
                        <input
                          type="date"
                          value={formData.operations.heatTreatment.receivedDate || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, receivedDate: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>Status</label>
                        <select
                          value={formData.operations.heatTreatment.status}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, status: e.target.value }
                              }
                            })
                          }
                        >
                          <option value="Pending">Pending</option>
                          <option value="Sent to Vendor">Sent to Vendor</option>
                          <option value="Received">Received Back</option>
                          <option value="Completed">Completed & Hardness Verified</option>
                          <option value="Failed / Rework">Failed / Re-heat Treatment</option>
                        </select>
                      </div>
                      <div className="field-group">
                        <label>Actual Hardness Result</label>
                        <input
                          type="text"
                          placeholder="e.g. 53.5 HRC"
                          value={formData.operations.heatTreatment.actualHardness || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, actualHardness: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group">
                        <label>Hardness Test Method</label>
                        <select
                          value={formData.operations.heatTreatment.testMethod || 'Rockwell (HRC)'}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, testMethod: e.target.value }
                              }
                            })
                          }
                        >
                          <option value="Rockwell (HRC)">Rockwell (HRC)</option>
                          <option value="Rockwell (HRB)">Rockwell (HRB)</option>
                          <option value="Vickers (HV)">Vickers (HV)</option>
                          <option value="Brinell (HB)">Brinell (HB)</option>
                          <option value="UCI Portable">UCI Portable</option>
                        </select>
                      </div>
                      <div className="field-group">
                        <label>Hardness Pass / Fail *</label>
                        <select
                          value={formData.operations.heatTreatment.disposition || 'Pending'}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, disposition: e.target.value }
                              }
                            })
                          }
                        >
                          <option value="Pending">Inspection Pending</option>
                          <option value="Pass">🟢 PASS (Within Target HRC)</option>
                          <option value="Fail">🔴 FAIL (Outside Target — Rework/Scrap)</option>
                        </select>
                      </div>
                      <div className="field-group">
                        <label>Verified By (Inspector)</label>
                        <input
                          type="text"
                          placeholder="e.g. QC Inspector name"
                          value={formData.operations.heatTreatment.inspector || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, inspector: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group full-width">
                        <label>HT Remarks (Distortion / Soft Spots / Re-HT)</label>
                        <textarea
                          rows="2"
                          placeholder="e.g. Minor scale observed, size stable after HT, hardness 53.5 HRC at 3 points OK"
                          value={formData.operations.heatTreatment.remarks || ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              operations: {
                                ...formData.operations,
                                heatTreatment: { ...formData.operations.heatTreatment, remarks: e.target.value }
                              }
                            })
                          }
                        />
                      </div>
                      <div className="field-group full-width">
                        {linkedHTR ? (
                          <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', padding: '12px 14px' }}>
                            <strong style={{ color: '#065f46' }}>Outsource Request: {linkedHTR.htrNumber}</strong>
                            <div style={{ fontSize: '12px', color: '#047857', marginTop: '4px' }}>
                              Status: {linkedHTR.status} · Vendor: {linkedHTR.vendorName || 'Pending (Purchase to assign)'} ·
                              Issued {linkedHTR.issuedQty || 0} / Received {linkedHTR.receivedQty || 0} of {linkedHTR.qtyRequested} Nos
                              {' · '}Stock at vendor: {Math.max(0, (linkedHTR.issuedQty || 0) - (linkedHTR.receivedQty || 0))}
                            </div>
                            <button
                              type="button"
                              className="button-secondary"
                              style={{ marginTop: '8px' }}
                              onClick={() => navigate('/ht-outsource', { state: { viewHtrNumber: linkedHTR.htrNumber, fromJobCard: formData.jobCardNumber } })}
                            >
                              Open HTR {linkedHTR.htrNumber} (Store / Purchase)
                            </button>
                          </div>
                        ) : isHTOutsourced ? (
                          <button type="button" className="button-primary" onClick={handleRaiseHTR}>
                            📨 Raise Outsource Request → Store (HTR)
                          </button>
                        ) : null}
                        {!isHTOutsourced && formData.operations.heatTreatment.required && (
                          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                            In-house HT: no Store letter needed. Switch to “Outsourced to Vendor” to raise HTR.
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Wire Cutting / Drilling / Sparking */}
              <div style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <strong style={{ color: '#1e293b' }}>Operation 40: Wire Cutting / Drilling / Sparking</strong>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Process Type</label>
                    <input
                      type="text"
                      placeholder="e.g. Wire EDM / Sparking / Deep Hole Drilling"
                      value={formData.operations.machineProcess.processType}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            machineProcess: { ...formData.operations.machineProcess, processType: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>Process Status</label>
                    <select
                      value={formData.operations.machineProcess.status}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            machineProcess: { ...formData.operations.machineProcess, status: e.target.value }
                          }
                        })
                      }
                    >
                      <option value="Pending">Pending</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div className="field-group full-width">
                    <label>Process Details / Notes</label>
                    <input
                      type="text"
                      placeholder="e.g. Wire cut profile, drill Ø6 through, spark EDM pocket"
                      value={formData.operations.machineProcess.details || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            machineProcess: { ...formData.operations.machineProcess, details: e.target.value }
                          }
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Surface Treatment (before Quality) */}
            <div className="form-section">
              <div className="section-heading">
                <h3>6. Surface Treatment (Coating/Plating) & Packing</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Coating / Plating Required?</label>
                  <select
                    value={formData.finishing.coatingRequired ? 'YES' : 'NO'}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        finishing: { ...formData.finishing, coatingRequired: e.target.value === 'YES' }
                      })
                    }
                  >
                    <option value="NO">No Coating (Self Finish)</option>
                    <option value="YES">Yes (Blackening / Plating / Anodizing)</option>
                  </select>
                </div>
                {formData.finishing.coatingRequired && (
                  <>
                    <div className="field-group">
                      <label>Coating Type</label>
                      <input
                        type="text"
                        placeholder="e.g. Hard Chrome Plating / Anodizing / Black Oxide"
                        value={formData.finishing.coatingType}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            finishing: { ...formData.finishing, coatingType: e.target.value }
                          })
                        }
                      />
                    </div>
                    <div className="field-group">
                      <label>Coating Status</label>
                      <select
                        value={formData.finishing.status}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            finishing: { ...formData.finishing, status: e.target.value }
                          })
                        }
                      >
                        <option value="Pending">Pending</option>
                        <option value="Sent Out">Sent Out</option>
                        <option value="Completed">Completed & Visual Check OK</option>
                      </select>
                    </div>
                  </>
                )}
                <div className="field-group">
                  <label>Packing & Preservation Status</label>
                  <select
                    value={formData.finishing.packingStatus}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        finishing: { ...formData.finishing, packingStatus: e.target.value }
                      })
                    }
                  >
                    <option value="Pending">Pending</option>
                    <option value="Packed & Labeled">Packed, Rust-Proofed & Labeled (Ready for Dispatch)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Quality Control (after Surface Treatment) */}
            <div className="form-section">
              <div className="section-heading">
                <h3>7. Quality Control (In-Process & Final Inspection)</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>In-Process QC Status</label>
                  <select
                    value={formData.qualityControl.inProcessQC.status}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        qualityControl: {
                          ...formData.qualityControl,
                          inProcessQC: { ...formData.qualityControl.inProcessQC, status: e.target.value }
                        }
                      })
                    }
                  >
                    <option value="Pending">Pending</option>
                    <option value="Passed">Passed (Dimensions OK)</option>
                    <option value="Rework">Rework Required</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>In-Process QC Inspector</label>
                  <input
                    type="text"
                    value={formData.qualityControl.inProcessQC.inspector}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        qualityControl: {
                          ...formData.qualityControl,
                          inProcessQC: { ...formData.qualityControl.inProcessQC, inspector: e.target.value }
                        }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Final Inspection 3-Way Disposition *</label>
                  <select
                    value={formData.qualityControl.finalQC.disposition}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        qualityControl: {
                          ...formData.qualityControl,
                          finalQC: { ...formData.qualityControl.finalQC, disposition: e.target.value }
                        }
                      })
                    }
                  >
                    <option value="Pending">Inspection Pending</option>
                    <option value="Pass">🟢 PASS (Accepted for Coating/Packing)</option>
                    <option value="Rework">🟡 REWORK (Return to Machine Station)</option>
                    <option value="Scrap">🔴 SCRAP (Rejected)</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>Accepted Quantity (Nos)</label>
                  <input
                    type="number"
                    value={formData.qualityControl.finalQC.acceptedQty}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        qualityControl: {
                          ...formData.qualityControl,
                          finalQC: { ...formData.qualityControl.finalQC, acceptedQty: Number(e.target.value) }
                        }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Scrap / Rejected Quantity (Nos)</label>
                  <input
                    type="number"
                    value={formData.qualityControl.finalQC.scrapQty}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        qualityControl: {
                          ...formData.qualityControl,
                          finalQC: { ...formData.qualityControl.finalQC, scrapQty: Number(e.target.value) }
                        }
                      })
                    }
                  />
                </div>
                <div className="field-group full-width">
                  <label>QC Final Inspection Remarks & Measured Dimensions</label>
                  <textarea
                    rows="2"
                    placeholder="e.g. Critical OD 50.00 +/- 0.005mm measured 50.002mm. Surface finish 0.4 Ra OK."
                    value={formData.qualityControl.finalQC.remarks}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        qualityControl: {
                          ...formData.qualityControl,
                          finalQC: { ...formData.qualityControl.finalQC, remarks: e.target.value }
                        }
                      })
                    }
                  />
                </div>
              </div>
            </div>

            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setMode('list')}>
                Cancel
              </button>
              <button type="submit" className="button-primary">
                Save & Update Route Card
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedJC && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
              {canCreateJourney && selectedJC.qualityControl?.finalQC?.disposition === 'Pass' && (
                <button
                  className="button-primary"
                  onClick={() => handleDispatchToChallan(selectedJC)}
                  style={{ background: '#16a34a' }}
                >
                  Generate Delivery Challan
                </button>
              )}
              <button
                className="button-secondary"
                onClick={() => window.print()}
                title="Print the Route Card in landscape (F/PROD/02)"
              >
                Print Route Card
              </button>
              <button
                className="button-secondary"
                onClick={() => generateRouteCardPDF(selectedJC)}
                title="Download the Route Card as a landscape PDF"
              >
                Download PDF
              </button>
              <button
                className="button-secondary"
                onClick={() => {
                  setFormData(normalizeRouteCard(selectedJC));
                  setMode('create');
                }}
              >
                Update Operations
              </button>
            </div>

            <div className="no-print" style={{ marginBottom: '14px' }}>
              <MaterialStatusPanel jobCardNumber={selectedJC.jobCardNumber} />

              <div className="content-block" style={{ padding: '14px', marginTop: '14px' }}>
                <div style={{ marginBottom: '14px' }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#1e293b' }}>Manufacturing Steps (Job Card / Route Card)</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12.5px', color: '#334155' }}>
                    <span><strong>Project:</strong> {selectedJC.projectId ? `${selectedJC.projectId}${selectedJC.projectName ? ` — ${selectedJC.projectName}` : ''}` : '-'}</span>
                    <span><strong>Customer:</strong> {selectedJC.customer || selectedJC.customerName || '-'}</span>
                    <span><strong>Part:</strong> {selectedJC.partName || '-'}</span>
                    <span><strong>Drawing No:</strong> {selectedJC.drawingNumber || '-'}</span>
                    <span><strong>Qty:</strong> {selectedJC.orderQuantity} Nos</span>
                  </div>
                </div>

                {/* Step 1 — Turning */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">1</span>
                    <span className="jc-step-name">Turning (CNC / Lathe)</span>
                    <span className={`jc-step-status ${selectedJC.operations?.turning?.status === 'Completed' ? 'st-done' : selectedJC.operations?.turning?.status === 'In Progress' ? 'st-active' : 'st-pending'}`}>
                      {selectedJC.operations?.turning?.status || 'Pending'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Machine:</strong> {selectedJC.operations?.turning?.machine || '-'}</div>
                    <div><strong>Operator:</strong> {selectedJC.operations?.turning?.operator || '-'}</div>
                    {selectedJC.operations?.turning?.notes && <div><strong>Notes:</strong> {selectedJC.operations.turning.notes}</div>}
                  </div>
                </div>

                {/* Step 2 — Milling / Grinding */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">2</span>
                    <span className="jc-step-name">Milling / Grinding (VMC / Surface Grinder)</span>
                    <span className={`jc-step-status ${selectedJC.operations?.millingGrinding?.status === 'Completed' ? 'st-done' : selectedJC.operations?.millingGrinding?.status === 'In Progress' ? 'st-active' : 'st-pending'}`}>
                      {selectedJC.operations?.millingGrinding?.status || 'Pending'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Machine:</strong> {selectedJC.operations?.millingGrinding?.machine || '-'}</div>
                    <div><strong>Operator:</strong> {selectedJC.operations?.millingGrinding?.operator || '-'}</div>
                    {selectedJC.operations?.millingGrinding?.notes && <div><strong>Notes:</strong> {selectedJC.operations.millingGrinding.notes}</div>}
                  </div>
                </div>

                {/* Step 3 — Setup Approval */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">3</span>
                    <span className="jc-step-name">Setup Approval (First Piece Inspection)</span>
                    <span className={`jc-step-status ${selectedJC.operations?.setupApproval?.approved ? 'st-done' : 'st-pending'}`}>
                      {selectedJC.operations?.setupApproval?.approved ? 'Approved' : 'Pending'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Approved:</strong> {selectedJC.operations?.setupApproval?.approved ? 'Yes' : 'No'}</div>
                    <div><strong>Approved By:</strong> {selectedJC.operations?.setupApproval?.approvedBy || '-'}</div>
                    {selectedJC.operations?.setupApproval?.approvalDate && <div><strong>Date:</strong> {selectedJC.operations.setupApproval.approvalDate}</div>}
                  </div>
                </div>

                {/* Step 4 — Heat Treatment */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">4</span>
                    <span className="jc-step-name">Heat Treatment</span>
                    <span className={`jc-step-status ${selectedJC.operations?.heatTreatment?.disposition === 'Pass' && selectedJC.operations?.heatTreatment?.status === 'Completed' ? 'st-done' : selectedJC.operations?.heatTreatment?.status === 'Failed / Rework' || selectedJC.operations?.heatTreatment?.disposition === 'Fail' ? 'st-warn' : selectedJC.operations?.heatTreatment?.status === 'Sent to Vendor' || selectedJC.operations?.heatTreatment?.status === 'Received' ? 'st-active' : 'st-pending'}`}>
                      {selectedJC.operations?.heatTreatment?.required ? (selectedJC.operations?.heatTreatment?.status || 'Pending') : 'Not Required'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Required:</strong> {selectedJC.operations?.heatTreatment?.required ? 'Yes' : 'No'}</div>
                    {selectedJC.operations?.heatTreatment?.required && (
                      <>
                        <div><strong>Process:</strong> {[selectedJC.operations.heatTreatment.processType, selectedJC.operations.heatTreatment.process].filter(Boolean).join(' — ') || '-'}</div>
                        <div><strong>Target Hardness:</strong> {selectedJC.operations.heatTreatment.targetHardness || '-'}</div>
                        <div><strong>Actual Hardness:</strong> {selectedJC.operations.heatTreatment.actualHardness || '-'} {selectedJC.operations.heatTreatment.testMethod ? `(${selectedJC.operations.heatTreatment.testMethod})` : ''}</div>
                        <div><strong>Pass/Fail:</strong> {selectedJC.operations.heatTreatment.disposition || 'Pending'}</div>
                        <div><strong>Qty:</strong> Sent {selectedJC.operations.heatTreatment.qtySent ?? 0} / Received {selectedJC.operations.heatTreatment.qtyReceived ?? 0}</div>
                        <div><strong>Vendor:</strong> {selectedJC.operations.heatTreatment.vendor || 'In-house'}</div>
                        <div><strong>Status:</strong> {selectedJC.operations.heatTreatment.status || 'Pending'}</div>
                        {(() => {
                          const htr = getHTOutsourceRequests().find((r) => r.jobCardNumber === selectedJC.jobCardNumber && r.status !== 'Cancelled');
                          if (!htr) return null;
                          return (
                            <div>
                              <strong>HTR:</strong> {htr.htrNumber} · {htr.status} · At vendor {Math.max(0, (htr.issuedQty || 0) - (htr.receivedQty || 0))} Nos{' '}
                              <button type="button" className="button-secondary" style={{ marginLeft: '8px', fontSize: '11px', padding: '3px 8px' }} onClick={() => navigate('/ht-outsource', { state: { viewHtrNumber: htr.htrNumber, fromJobCard: selectedJC.jobCardNumber } })}>
                                Open HTR
                              </button>
                            </div>
                          );
                        })()}
                        {selectedJC.operations.heatTreatment.inspector && <div><strong>Verified By:</strong> {selectedJC.operations.heatTreatment.inspector}</div>}
                        {selectedJC.operations.heatTreatment.remarks && <div><strong>Remarks:</strong> {selectedJC.operations.heatTreatment.remarks}</div>}
                      </>
                    )}
                  </div>
                </div>

                {/* Step 5 — Wire Cutting / Drilling / Sparking */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">5</span>
                    <span className="jc-step-name">Wire Cutting / Drilling / Sparking</span>
                    <span className={`jc-step-status ${selectedJC.operations?.machineProcess?.status === 'Completed' ? 'st-done' : selectedJC.operations?.machineProcess?.status === 'In Progress' ? 'st-active' : 'st-pending'}`}>
                      {selectedJC.operations?.machineProcess?.status || 'Pending'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Process Type:</strong> {selectedJC.operations?.machineProcess?.processType || '-'}</div>
                    {selectedJC.operations?.machineProcess?.details && <div><strong>Details:</strong> {selectedJC.operations.machineProcess.details}</div>}
                  </div>
                </div>

                {/* Step 6 — Surface Treatment & Packing */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">6</span>
                    <span className="jc-step-name">Surface Treatment (Coating/Plating) & Packing</span>
                    <span className={`jc-step-status ${selectedJC.finishing?.packingStatus === 'Packed & Labeled' ? 'st-done' : selectedJC.finishing?.status === 'Completed' ? 'st-active' : 'st-pending'}`}>
                      {selectedJC.finishing?.coatingRequired ? (selectedJC.finishing?.status || 'Pending') : (selectedJC.finishing?.packingStatus || 'Pending')}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Coating:</strong> {selectedJC.finishing?.coatingRequired ? `${selectedJC.finishing.coatingType || '-'} (${selectedJC.finishing.status || 'Pending'})` : 'Not Required'}</div>
                    <div><strong>Packing:</strong> {selectedJC.finishing?.packingStatus || 'Pending'}</div>
                  </div>
                </div>

                {/* Step 7 — In-Process QC */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">7</span>
                    <span className="jc-step-name">In-Process QC Inspection</span>
                    <span className={`jc-step-status ${selectedJC.qualityControl?.inProcessQC?.status === 'Passed' ? 'st-done' : selectedJC.qualityControl?.inProcessQC?.status === 'Rework' ? 'st-warn' : 'st-pending'}`}>
                      {selectedJC.qualityControl?.inProcessQC?.status || 'Pending'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div><strong>Inspector:</strong> {selectedJC.qualityControl?.inProcessQC?.inspector || '-'}</div>
                    {selectedJC.qualityControl?.inProcessQC?.remarks && <div><strong>Remarks:</strong> {selectedJC.qualityControl.inProcessQC.remarks}</div>}
                  </div>
                </div>

                {/* Step 8 — Final QC */}
                <div className="jc-step-card">
                  <div className="jc-step-header">
                    <span className="jc-step-num">8</span>
                    <span className="jc-step-name">Final QC Inspection</span>
                    <span className={`jc-step-status ${selectedJC.qualityControl?.finalQC?.disposition === 'Pass' ? 'st-done' : selectedJC.qualityControl?.finalQC?.disposition === 'Rework' ? 'st-warn' : 'st-pending'}`}>
                      {selectedJC.qualityControl?.finalQC?.disposition || 'Pending'}
                    </span>
                  </div>
                  <div className="jc-step-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div>
                        <strong>Accepted Qty:</strong> {selectedJC.qualityControl?.finalQC?.acceptedQty || 0} Nos
                      </div>
                      <div>
                        <strong>Rework Qty:</strong> {selectedJC.qualityControl?.finalQC?.reworkQty || 0} Nos
                      </div>
                      <div>
                        <strong>Scrap Qty:</strong> {selectedJC.qualityControl?.finalQC?.scrapQty || 0} Nos
                      </div>
                      <div>
                        <strong>Coating:</strong> {selectedJC.finishing?.coatingRequired ? `${selectedJC.finishing.coatingType || '-'} (${selectedJC.finishing.status || 'Pending'})` : 'Not Required'}
                      </div>
                      <div>
                        <strong>Packing:</strong> {selectedJC.finishing?.packingStatus || 'Pending'}
                      </div>
                    </div>
                    {selectedJC.qualityControl?.finalQC?.remarks && <div style={{ marginTop: '6px' }}><strong>Remarks:</strong> {selectedJC.qualityControl.finalQC.remarks}</div>}
                  </div>
                </div>
              </div>
            </div>

            {/* Landscape page setup for the Route Card print (only mounted in view mode) */}
            <style>{`@media print {
  @page { size: A4 landscape; margin: 8mm; }
  .route-card-page { padding: 0 !important; margin: 0 !important; }
}`}</style>

            <div className="doc-page-container route-card-page">
              <div className="route-card-sheet printable">
                <table className="route-header-table">
                  <tbody>
                    <tr>
                      <td className="route-header-logo">
                        <img src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
                      </td>
                      <td className="route-header-title">ROUTE CARD</td>
                      <td className="route-header-docinfo">
                        <div><span>Doc No:</span> <b>{selectedJC.docNo || 'F/PROD/02'}</b></div>
                        <div><span>Rev No:</span> <b>{selectedJC.revNo || '00'}</b></div>
                        <div><span>Date:</span> <b>{formatDateDMY(selectedJC.docDate) || '-'}</b></div>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <table className="route-info-table">
                  <tbody>
                    <tr>
                      <td>
                        <div className="route-cell-label">PO NO</div>
                        <div className="route-cell-value">{selectedJC.poNo || '-'}</div>
                      </td>
                      <td>
                        <div className="route-cell-label">PART NAME</div>
                        <div className="route-cell-value">{selectedJC.partName || '-'}</div>
                      </td>
                      <td>
                        <div className="route-cell-label">DRAWING REV</div>
                        <div className="route-cell-value">{selectedJC.drawingRev || '-'}</div>
                      </td>
                      <td>
                        <div className="route-cell-label">CUSTOMER</div>
                        <div className="route-cell-value">{selectedJC.customer || selectedJC.customerName || '-'}</div>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <div className="route-cell-label">INV NO</div>
                        <div className="route-cell-value">{selectedJC.invNo || '-'}</div>
                      </td>
                      <td>
                        <div className="route-cell-label">PART NUMBER</div>
                        <div className="route-cell-value">{selectedJC.partNumber || '-'}</div>
                      </td>
                      <td>
                        <div className="route-cell-label">LOT QTY</div>
                        <div className="route-cell-value">{selectedJC.lotQty || '-'}</div>
                      </td>
                      <td>
                        <div className="route-cell-label">MATERIAL</div>
                        <div className="route-cell-value">{selectedJC.material || '-'}</div>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <table className="route-cert-table">
                  <tbody>
                    <tr>
                      <td>
                        <span className="route-cert-label">MATERIAL TEST CERTIFICATE NO-&nbsp;</span>
                        <span className="route-cert-value">{selectedJC.materialCertNo || '-'}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>

                <table className="route-process-table">
                  <thead>
                    <tr>
                      <th>Process</th>
                      <th>Machine No</th>
                      <th>Input QTY</th>
                      <th>Output QTY</th>
                      <th>Rework QTY</th>
                      <th>Reject QTY</th>
                      <th>Start Time</th>
                      <th>End Time</th>
                      <th>Operator / Inspector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(selectedJC.processes) ? selectedJC.processes : []).length > 0 &&
                      (Array.isArray(selectedJC.processes) ? selectedJC.processes : []).map((p, idx) => (
                        <tr key={p.id || idx}>
                          <td>{p.process || '-'}</td>
                          <td>{p.machineNo || '-'}</td>
                          <td>{p.inputQty === '' || p.inputQty === undefined ? '-' : p.inputQty}</td>
                          <td>{p.outputQty === '' || p.outputQty === undefined ? '-' : p.outputQty}</td>
                          <td>{p.reworkQty === '' || p.reworkQty === undefined ? '-' : p.reworkQty}</td>
                          <td>{p.rejectQty === '' || p.rejectQty === undefined ? '-' : p.rejectQty}</td>
                          <td>{p.startTime || '-'}</td>
                          <td>{p.endTime || '-'}</td>
                          <td>{p.operator || '-'}</td>
                        </tr>
                      ))}
                    {(Array.isArray(selectedJC.processes) ? selectedJC.processes : []).length === 0 && (
                      <tr>
                        <td className="text-center" colSpan="9">-</td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <div className="route-sheet-footer">
                  <span>PRAGMATIC ENGINEERS — Route Card</span>
                  <span>Page 1 of 1</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProductionPage;

