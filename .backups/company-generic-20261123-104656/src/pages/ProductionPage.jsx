import React, { useState, useEffect, useMemo, useRef } from 'react';
import { UserRound, ClipboardList, CircleCheck, Settings2, ChevronDown, ChevronUp, Clock3 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import defaultLogoUrl from '../assets/logo.png';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { generateRouteCardPDF } from '../services/pdfGenerator.js';
import { getFullProjectData, getProjectNameForId } from '../utils/projectTracker.js';
import { hasPermission, getMyEmployeeId, isRole, getCurrentUserInfo, isAdmin } from '../utils/permissions.js';

import { normalizeRouteCard, routeCardBlank, emptyProcess, formatDateDMY, toDateTimeLocalValue, formatDateTimeDMY, STANDARD_PROCESSES } from '../utils/routeCard.js';
import MachineSearchSelect from '../components/MachineSearchSelect.jsx';
import EmployeeSearchSelect from '../components/EmployeeSearchSelect.jsx';
import WorkflowNavigator from '../components/WorkflowNavigator.jsx';
import MaterialStatusPanel from '../components/MaterialStatusPanel.jsx';
import ProjectIdAutocomplete from '../components/ProjectIdAutocomplete.jsx';
import { getDrawingInfo, openDrawing, attachDrawing } from '../utils/drawingLookup.js';
import { deleteWorkflowDocument, openWorkflowDocument } from '../utils/workflowFiles.js';
import { getProductionDispatchRequests, requestProductionDispatch } from '../utils/productionDispatchService.js';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import {
  createHTOutsourceRequest,
  getHTOutsourceRequests,
  findMachine,
  machineDisplay
} from '../utils/storeService.js';
import {
  ACK_STATUS,
  getProductionAckSummary,
  getProcurementPhase
} from '../utils/materialAckService.js';

/**
 * Production dashboard — "Store Material Acknowledgement".
 * Read-only mirror of what Stores confirmed: pending requests, store responses,
 * available vs. short material, Purchase Indent status, expected availability
 * and the last acknowledgement date.
 */
const StoreAckDashboard = () => {
  const navigate = useNavigate();
  const [nonce, setNonce] = useState(0);
  const rows = useMemo(() => getProductionAckSummary(), [nonce]);

  const count = (status) => rows.filter((r) => r.ack.status === status).length;
  const pending = count(ACK_STATUS.PENDING);
  const full = count(ACK_STATUS.FULL);
  const partial = count(ACK_STATUS.PARTIAL);
  const none = count(ACK_STATUS.NONE);
  const indentPending = rows.filter((r) => getProcurementPhase(r.mr.mrNumber) === 'Purchase Indent Pending').length;
  const awaitingReceipt = rows.filter((r) => getProcurementPhase(r.mr.mrNumber) === 'Awaiting Material Receipt').length;
  const shortMaterials = rows.reduce(
    (a, r) => a + r.lines.filter((l) => Number(l.shortageQty) > 0).length,
    0
  );
  const lastAck = rows.map((r) => r.lastAcknowledgedAt).filter(Boolean).sort().pop() || '—';

  const expectedAvailability = (row) => {
    if (row.totalShortage <= 0) return 'Available now';
    if (row.indentNumber) return `${row.indentNumber} · ${row.indentStatus || 'In procurement'}`;
    return row.mr.requiredDate ? `Required by ${row.mr.requiredDate}` : 'Not scheduled';
  };

  return (
    <div className="content-block" style={{ marginBottom: '22px' }} data-testid="store-ack-dashboard">
      <div className="block-header" style={{ marginBottom: '12px' }}>
        <h3 className="block-title">Store Material Acknowledgement</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span className="muted-text">Last acknowledgement: {lastAck}</span>
          <button type="button" className="button-secondary button-small" onClick={() => setNonce((n) => n + 1)}>
            Refresh
          </button>
        </div>
      </div>

      <div className="kpi-grid" style={{ marginBottom: '16px' }}>
        <div className="kpi-card">
          <span className="kpi-title">Pending Requests</span>
          <div className="kpi-value" style={{ color: pending > 0 ? '#2563eb' : '#166534' }}>{pending}</div>
          <span className="kpi-delta neutral">Awaiting Store response</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Store Responses</span>
          <div className="kpi-value" style={{ color: '#1e293b' }}>{rows.length - pending}</div>
          <span className="kpi-delta neutral">{partial} partial · {none} unavailable</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Available Materials</span>
          <div className="kpi-value" style={{ color: full > 0 ? '#166534' : '#94a3b8' }}>{full}</div>
          <span className="kpi-delta positive">Fully available requests</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Shortage Materials</span>
          <div className="kpi-value" style={{ color: shortMaterials > 0 ? '#b91c1c' : '#166534' }}>{shortMaterials}</div>
          <span className="kpi-delta negative">Lines still short</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Purchase Indent Pending</span>
          <div className="kpi-value" style={{ color: indentPending > 0 ? '#d97706' : '#166534' }}>{indentPending}</div>
          <span className="kpi-delta neutral">Indent raised / awaiting PO</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Awaiting Material Receipt</span>
          <div className="kpi-value" style={{ color: awaitingReceipt > 0 ? '#b45309' : '#166534' }}>{awaitingReceipt}</div>
          <span className="kpi-delta neutral">QC approval + posting required</span>
        </div>
      </div>

      <div className="history-table-wrapper">
        <table className="history-table">
          <thead>
            <tr>
              <th>MR No</th>
              <th>Sales Order</th>
              <th>Project</th>
              <th>Store Response</th>
              <th>Available</th>
              <th>Shortage</th>
              <th>Purchase Indent</th>
              <th>Expected Availability</th>
              <th>Last Acknowledged</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan="10" className="no-history-row">No material requests are awaiting a Store acknowledgement.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.mr.mrNumber}>
                  <td><strong>{row.mr.mrNumber}</strong></td>
                  <td>{row.mr.salesOrderRef || '—'}</td>
                  <td>
                    <span style={{ color: '#3730a3', fontWeight: 700, fontSize: '12px' }}>{row.mr.projectId || '—'}</span>
                    {row.mr.projectName && <div className="muted-text" style={{ fontSize: '11px' }}>{row.mr.projectName}</div>}
                  </td>
                  <td>
                    <span className={`status-badge st-${row.ack.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.ack.status}</span>
                    {row.ack.acknowledgedAt && (
                      <div className="muted-text" style={{ fontSize: '11px' }}>{row.ack.acknowledgedAt}</div>
                    )}
                  </td>
                  <td style={{ fontWeight: 700, color: row.totalShortage > 0 ? '#d97706' : '#166534' }}>
                    {row.totalAvailable}
                    <div className="muted-text" style={{ fontSize: '11px', fontWeight: 400 }}>of {row.totalRequired}</div>
                  </td>
                  <td style={{ fontWeight: 700, color: row.totalShortage > 0 ? '#dc2626' : '#166534' }}>{row.totalShortage}</td>
                  <td>{row.indentNumber ? (
                    <div style={{ fontSize: '12px' }}>
                      <span style={{ fontWeight: 700 }}>{row.indentNumber}</span>
                      {row.indentStatus && <div className="muted-text">{row.indentStatus}</div>}
                    </div>
                  ) : '—'}</td>
                  <td>{expectedAvailability(row)}</td>
                  <td>{row.lastAcknowledgedAt || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => navigate(`/production/material-requests?mr=${encodeURIComponent(row.mr.mrNumber)}`)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * Job Card creation screen — surfaces the Store acknowledgement so nobody
 * releases a job against material Stores have not confirmed. The existing
 * workflow has no hard release gate, so this is a prominent warning plus
 * deep links rather than a new blocking rule (permissions unchanged).
 */
const CreateAckNotice = ({ projectId }) => {
  const navigate = useNavigate();
  const outstanding = useMemo(
    () =>
      getProductionAckSummary().filter(
        (r) => r.ack.status !== ACK_STATUS.FULL && (!projectId || (r.mr.projectId || '') === projectId)
      ),
    [projectId]
  );

  const pending = outstanding.filter((r) => r.ack.status === ACK_STATUS.PENDING).length;
  const clear = outstanding.length === 0;

  return (
    <div
      data-testid="create-jobcard-ack-notice"
      style={{
        margin: '0 0 18px',
        padding: '10px 14px',
        borderRadius: '6px',
        background: clear ? '#ecfdf5' : '#fffbeb',
        border: `1px solid ${clear ? '#a7f3d0' : '#fde68a'}`,
        color: clear ? '#047857' : '#92400e',
        fontSize: '13px'
      }}
    >
      <strong>Store Material Acknowledgement — </strong>
      {clear ? (
        <span>
          no outstanding acknowledgements{projectId ? ` for project ${projectId}` : ''}. Material availability is
          confirmed by Stores against each Material Request before work is released.
        </span>
      ) : (
        <span>
          {outstanding.length} material request(s){projectId ? ` for project ${projectId}` : ''} are not yet fully
          available{pending > 0 ? ` (${pending} still pending a Store response)` : ''}. Review availability and shortage
          before creating this Job Card — partial supply must not be treated as full.
        </span>
      )}

      {!clear && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
          {outstanding.map((row) => (
            <button
              key={row.mr.mrNumber}
              type="button"
              className="button-secondary button-small"
              onClick={() => navigate(`/production/material-requests?mr=${encodeURIComponent(row.mr.mrNumber)}`)}
              title={`${row.mr.mrNumber}: ${row.ack.status} · available ${row.totalAvailable} · short ${row.totalShortage}`}
            >
              {row.mr.mrNumber} · {row.ack.status}
              {row.totalShortage > 0 ? ` · ${row.totalShortage} short` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const PROCESS_SECTION_MAP = {
  'Turning / Facing (CNC / Lathe)': 'op-turning',
  'Milling (VMC)': 'op-milling',
  'Surface Grinding': 'op-milling',
  'Cylindrical Grinding': 'op-milling',
  'Drilling / Reaming / Tapping': 'op-wirecut',
  'Wire Cutting / Sparking (EDM)': 'op-wirecut',
  'Deburring / Chamfering': 'op-wirecut',
  'Heat Treatment': 'op-heattreat',
  'Surface Treatment / Coating / Plating': 'sec-surface-treatment',
  'In-Process Inspection': 'sec-qc',
  'Final Inspection & Packing': 'sec-qc'
};

const scrollToSection = (targetId) => {
  if (!targetId) return;
  setTimeout(() => {
    const el = document.getElementById(targetId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-section-flash');
      setTimeout(() => el.classList.remove('highlight-section-flash'), 1800);
    }
  }, 80);
};

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
  attachments: [],
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
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [jobCards, setJobCards] = useState([]);
  const [dispatchRequests, setDispatchRequests] = useState(() => getProductionDispatchRequests());
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

  // Role context & employee identity
  const currentUserInfo = getCurrentUserInfo();
  const myEmpId = getMyEmployeeId();
  const myName = currentUserInfo.employee?.name || currentUserInfo.auth?.username || '';
  const isProdEmployee = isRole('production_employee');
  const canCreateJourney = hasPermission('job_card.create');
  const canRequestDispatch = hasPermission('job_card.dispatch_request');
  const isEmployeeView = isProdEmployee || (!canCreateJourney && !isAdmin());

  const isProcessAssignedToMe = (proc) => {
    if (!proc) return false;
    if (myEmpId && (proc.operatorId === myEmpId || proc.operatorEmpId === myEmpId)) return true;
    if (myName && proc.operator && proc.operator.trim().toLowerCase() === myName.trim().toLowerCase()) return true;
    return false;
  };

  const isJobCardAssignedToMe = (j) => {
    if (!j) return false;
    // 1. Overall assignee
    if (myEmpId && j.assignedToEmpId === myEmpId) return true;
    if (myName && j.assignedTo && j.assignedTo.trim().toLowerCase() === myName.trim().toLowerCase()) return true;

    // 2. Assigned in Process Routing Table
    if (Array.isArray(j.processes) && j.processes.some(isProcessAssignedToMe)) return true;

    // 3. Assigned in Machining Operations
    const ops = j.operations || {};
    if (myEmpId) {
      if (ops.turning?.operatorId === myEmpId) return true;
      if (ops.millingGrinding?.operatorId === myEmpId) return true;
      if (ops.heatTreatment?.inspectorId === myEmpId) return true;
      if (ops.setupApproval?.approvedById === myEmpId) return true;
      if (ops.machineProcess?.operatorId === myEmpId) return true;
    }
    if (myName) {
      const matchOpName = (name) => name && name.trim().toLowerCase() === myName.trim().toLowerCase();
      if (matchOpName(ops.turning?.operator)) return true;
      if (matchOpName(ops.millingGrinding?.operator)) return true;
      if (matchOpName(ops.heatTreatment?.inspector)) return true;
      if (matchOpName(ops.setupApproval?.approvedBy)) return true;
    }

    // 4. Assigned in QC
    const qc = j.qualityControl || {};
    if (myEmpId) {
      if (qc.inProcessQC?.inspectorId === myEmpId) return true;
      if (qc.finalQC?.inspectorId === myEmpId) return true;
    }
    if (myName) {
      const matchQcName = (name) => name && name.trim().toLowerCase() === myName.trim().toLowerCase();
      if (matchQcName(qc.inProcessQC?.inspector)) return true;
      if (matchQcName(qc.finalQC?.inspector)) return true;
    }

    return false;
  };

  const scopedJobCards = useMemo(() => {
    if (!isEmployeeView || (!myEmpId && !myName)) return jobCards;
    return jobCards.filter(isJobCardAssignedToMe);
  }, [jobCards, isEmployeeView, myEmpId, myName]);

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
    const refreshRequests = () => setDispatchRequests(getProductionDispatchRequests());
    window.addEventListener('erp-state-change', refreshRequests);
    window.addEventListener('erp-records-synced', refreshRequests);
    return () => {
      window.removeEventListener('erp-state-change', refreshRequests);
      window.removeEventListener('erp-records-synced', refreshRequests);
    };
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

  /* ---------------- Enquiry drawing: auto-fetch + view link ---------------- */
  const [drawingPdf, setDrawingPdf] = useState(null); // { found, drawingNo, fileName }
  const drawingSyncKey = useRef('');

  const syncDrawingPdf = async (pid, dwg, attach) => {
    /* drop the auto-fetched file of the drawing we are switching away from
       (a file the user attached by hand is never touched) */
    if (attach) {
      setFormData((f) => {
        const current = f.attachments || [];
        const isStaleAuto = (d) =>
          d && d.source === 'enquiry drawing' && String(d.drawingNo) !== String(dwg);
        const stale = current.filter(isStaleAuto);
        if (!stale.length) return f;
        stale.forEach((d) => deleteWorkflowDocument(d.id));
        return { ...f, attachments: current.filter((d) => !isStaleAuto(d)) };
      });
    }

    let info = { found: false, drawingNo: dwg, fileName: '' };
    try {
      info = await getDrawingInfo(pid, dwg);
    } catch (err) {
      console.error('Drawing auto-fetch failed', err);
    }
    setDrawingPdf({ found: info.found, drawingNo: info.drawingNo, fileName: info.fileName });
    if (!info.found || !attach) return;

    const meta = await attachDrawing(pid, dwg);
    if (!meta) return;
    setFormData((f) => {
      const current = f.attachments || [];
      const alreadyAuto = current.some(
        (d) => d && d.source === 'enquiry drawing' && String(d.drawingNo) === String(dwg)
      );
      if (alreadyAuto || current.some((d) => d && d.name === meta.name)) {
        deleteWorkflowDocument(meta.id);
        return f;
      }
      return { ...f, attachments: [...current, meta] };
    });
  };

  /* Any screen change that fills in Project ID + Drawing Number (project picker,
     Sales Order / Customer PO pickers, deep links, edit) fetches the drawing PDF
     that Sales uploaded with the Enquiry and copies it onto the Job Card. */
  useEffect(() => {
    if (mode === 'list') {
      setDrawingPdf(null);
      drawingSyncKey.current = '';
      return;
    }
    const src = mode === 'view' ? selectedJC : formData;
    const pid = String(src?.projectId || '').trim();
    const dwg = String(src?.drawingNumber || '').trim();
    if (!pid || !dwg) {
      setDrawingPdf(null);
      drawingSyncKey.current = '';
      return;
    }
    const attach = mode !== 'view';
    const key = `${src?.jobCardNumber || ''}::${pid}::${dwg}`;
    if (attach && drawingSyncKey.current === key) return;
    if (attach) drawingSyncKey.current = key;
    syncDrawingPdf(pid, dwg, attach);
  }, [mode, formData.projectId, formData.drawingNumber, formData.jobCardNumber, selectedJC]);

  /* Drawings of the linked project: several → the user picks one, one → free text
     (a legacy Job Card may keep a drawing number the enquiry never listed). */
  const drawingOptions = useMemo(() => {
    const pid = String(formData.projectId || '').trim();
    const items = pid ? getFullProjectData(pid)?.items || [] : [];
    const list = [...new Set(items.map((i) => String(i.drawingNo || '').trim()).filter(Boolean))];
    const current = String(formData.drawingNumber || '').trim();
    if (current && !list.includes(current)) list.push(current);
    return list;
  }, [formData.projectId, formData.drawingNumber]);


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

  // Two-way sync: Update Section 3, 4, 5 and mirror to Process Routing Table
  const updateOperationWithSync = (opKey, updates) => {
    setFormData((prev) => {
      const nextOperations = {
        ...prev.operations,
        [opKey]: { ...prev.operations[opKey], ...updates }
      };

      const matchesOp = (pName) => {
        if (opKey === 'turning') return pName === 'Turning / Facing (CNC / Lathe)';
        if (opKey === 'millingGrinding') return pName === 'Milling (VMC)' || pName === 'Surface Grinding' || pName === 'Cylindrical Grinding';
        if (opKey === 'heatTreatment') return pName === 'Heat Treatment';
        if (opKey === 'machineProcess') return pName === 'Wire Cutting / Sparking (EDM)' || pName === 'Drilling / Reaming / Tapping' || pName === 'Deburring / Chamfering';
        return false;
      };

      const nextProcesses = (Array.isArray(prev.processes) ? [...prev.processes] : []).map((p) => {
        if (matchesOp(p.process)) {
          const synced = { ...p };
          if (updates.status !== undefined) {
            if (opKey === 'heatTreatment') {
              if (updates.status === 'Completed') synced.status = 'Completed';
              else if (updates.status === 'Sent to Vendor' || updates.status === 'Received') synced.status = 'In Progress';
              else if (updates.status === 'Pending') synced.status = 'Pending';
            } else {
              synced.status = updates.status;
            }
          }
          if (updates.machineId !== undefined) synced.machineId = updates.machineId;
          if (updates.operatorId !== undefined) synced.operatorId = updates.operatorId;
          if (updates.operator !== undefined) synced.operator = updates.operator;
          if (updates.inspectorId !== undefined) synced.operatorId = updates.inspectorId;
          if (updates.inspector !== undefined) synced.operator = updates.inspector;
          return synced;
        }
        return p;
      });

      return {
        ...prev,
        operations: nextOperations,
        processes: nextProcesses
      };
    });
  };

  const updateFinishingWithSync = (updates) => {
    setFormData((prev) => {
      const nextFinishing = { ...prev.finishing, ...updates };
      const nextProcesses = (Array.isArray(prev.processes) ? [...prev.processes] : []).map((p) => {
        if (p.process === 'Surface Treatment / Coating / Plating') {
          const synced = { ...p };
          if (updates.status !== undefined) synced.status = updates.status;
          return synced;
        }
        return p;
      });
      return { ...prev, finishing: nextFinishing, processes: nextProcesses };
    });
  };

  const updateQCWithSync = (qcType, updates) => {
    setFormData((prev) => {
      const nextQC = {
        ...prev.qualityControl,
        [qcType]: { ...prev.qualityControl[qcType], ...updates }
      };
      const nextProcesses = (Array.isArray(prev.processes) ? [...prev.processes] : []).map((p) => {
        if (qcType === 'inProcessQC' && p.process === 'In-Process Inspection') {
          const synced = { ...p };
          if (updates.status !== undefined) {
            synced.status = updates.status === 'Passed' ? 'Completed' : updates.status === 'Rework' ? 'In Progress' : 'Pending';
          }
          if (updates.inspectorId !== undefined) synced.operatorId = updates.inspectorId;
          if (updates.inspector !== undefined) synced.operator = updates.inspector;
          return synced;
        }
        if (qcType === 'finalQC' && p.process === 'Final Inspection & Packing') {
          const synced = { ...p };
          if (updates.disposition !== undefined) {
            synced.status = updates.disposition === 'Pass' ? 'Completed' : updates.disposition === 'Rework' ? 'In Progress' : 'Pending';
          }
          if (updates.inspectorId !== undefined) synced.operatorId = updates.inspectorId;
          if (updates.inspector !== undefined) synced.operator = updates.inspector;
          return synced;
        }
        return p;
      });
      return { ...prev, qualityControl: nextQC, processes: nextProcesses };
    });
  };

  const handleProcessChange = (idx, field, value) => {
    setFormData((prev) => {
      const list = Array.isArray(prev.processes) ? [...prev.processes] : [];
      if (!list[idx]) list[idx] = emptyProcess();
      let updatedRow = { ...list[idx], [field]: value };

      // When selecting a process, if row has no machine/operator, auto-pull from section
      if (field === 'process' && value) {
        if (value === 'Turning / Facing (CNC / Lathe)') {
          if (prev.operations?.turning?.machineId && !updatedRow.machineId) {
            updatedRow.machineId = prev.operations.turning.machineId;
          }
          if (prev.operations?.turning?.operatorId && !updatedRow.operatorId) {
            updatedRow.operatorId = prev.operations.turning.operatorId;
            updatedRow.operator = prev.operations.turning.operator;
          }
          if (prev.operations?.turning?.status && (!updatedRow.status || updatedRow.status === 'Pending')) {
            updatedRow.status = prev.operations.turning.status;
          }
        } else if (value === 'Milling (VMC)' || value === 'Surface Grinding' || value === 'Cylindrical Grinding') {
          if (prev.operations?.millingGrinding?.machineId && !updatedRow.machineId) {
            updatedRow.machineId = prev.operations.millingGrinding.machineId;
          }
          if (prev.operations?.millingGrinding?.operatorId && !updatedRow.operatorId) {
            updatedRow.operatorId = prev.operations.millingGrinding.operatorId;
            updatedRow.operator = prev.operations.millingGrinding.operator;
          }
          if (prev.operations?.millingGrinding?.status && (!updatedRow.status || updatedRow.status === 'Pending')) {
            updatedRow.status = prev.operations.millingGrinding.status;
          }
        }
      }

      list[idx] = updatedRow;

      // Auto cascade outputQty -> next inputQty
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

      // Sync changes from table to operations/finishing/qualityControl
      let nextOperations = prev.operations ? { ...prev.operations } : {};
      let nextFinishing = prev.finishing ? { ...prev.finishing } : {};
      let nextQC = prev.qualityControl ? { ...prev.qualityControl } : {};

      const procName = updatedRow.process;
      if (procName === 'Turning / Facing (CNC / Lathe)') {
        nextOperations.turning = {
          ...nextOperations.turning,
          ...(field === 'status' ? { status: value } : {}),
          ...(field === 'machineId' ? { machineId: value, machine: value ? `${value} - ${findMachine(value)?.name || value}` : '' } : {}),
          ...(field === 'operatorId' ? { operatorId: value } : {}),
          ...(field === 'operator' ? { operator: value } : {})
        };
      } else if (procName === 'Milling (VMC)' || procName === 'Surface Grinding' || procName === 'Cylindrical Grinding') {
        nextOperations.millingGrinding = {
          ...nextOperations.millingGrinding,
          ...(field === 'status' ? { status: value } : {}),
          ...(field === 'machineId' ? { machineId: value, machine: value ? `${value} - ${findMachine(value)?.name || value}` : '' } : {}),
          ...(field === 'operatorId' ? { operatorId: value } : {}),
          ...(field === 'operator' ? { operator: value } : {})
        };
      } else if (procName === 'Heat Treatment') {
        if (field === 'status') {
          nextOperations.heatTreatment = {
            ...nextOperations.heatTreatment,
            status: value === 'Completed' ? 'Completed' : value === 'In Progress' ? 'Sent to Vendor' : 'Pending'
          };
        }
        if (field === 'operatorId' || field === 'operator') {
          nextOperations.heatTreatment = {
            ...nextOperations.heatTreatment,
            ...(field === 'operatorId' ? { inspectorId: value } : {}),
            ...(field === 'operator' ? { inspector: value } : {})
          };
        }
      } else if (procName === 'Wire Cutting / Sparking (EDM)' || procName === 'Drilling / Reaming / Tapping' || procName === 'Deburring / Chamfering') {
        if (field === 'status') {
          nextOperations.machineProcess = {
            ...nextOperations.machineProcess,
            status: value
          };
        }
      } else if (procName === 'Surface Treatment / Coating / Plating') {
        if (field === 'status') {
          nextFinishing = {
            ...nextFinishing,
            status: value
          };
        }
      } else if (procName === 'In-Process Inspection') {
        if (field === 'status') {
          nextQC.inProcessQC = {
            ...nextQC.inProcessQC,
            status: value === 'Completed' ? 'Passed' : value === 'In Progress' ? 'Rework' : 'Pending'
          };
        }
        if (field === 'operatorId' || field === 'operator') {
          nextQC.inProcessQC = {
            ...nextQC.inProcessQC,
            ...(field === 'operatorId' ? { inspectorId: value } : {}),
            ...(field === 'operator' ? { inspector: value } : {})
          };
        }
      } else if (procName === 'Final Inspection & Packing') {
        if (field === 'status') {
          nextQC.finalQC = {
            ...nextQC.finalQC,
            disposition: value === 'Completed' ? 'Pass' : value === 'In Progress' ? 'Rework' : 'Pending'
          };
        }
        if (field === 'operatorId' || field === 'operator') {
          nextQC.finalQC = {
            ...nextQC.finalQC,
            ...(field === 'operatorId' ? { inspectorId: value } : {}),
            ...(field === 'operator' ? { inspector: value } : {})
          };
        }
      }

      return {
        ...prev,
        processes: list,
        operations: nextOperations,
        finishing: nextFinishing,
        qualityControl: nextQC
      };
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

  // Production only raises the persistent request; Sales owns challan creation.
  const handleDispatchRequest = async(jc) => {
    try {
      const request = await requestProductionDispatch(jc.jobCardNumber);
      setDispatchRequests(getProductionDispatchRequests());
      window.alert('Dispatch request sent successfully to the Sales Department.');
      return request;
    } catch (error) {
      window.alert(error.message || 'Could not send the dispatch request.');
      return null;
    }
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
    <div className="page-section production-page">
      <div className="page-header">
        <div>
          <h1>
            {mode === 'create'
              ? 'Issue Production Job Card'
              : mode === 'view'
              ? `Job Card: ${selectedJC?.jobCardNumber || ''}`
              : 'Production & Quality Control (QC)'}
          </h1>
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
          {hasPermission('production.requirement.manage') && (
            <button
              className="button-secondary"
              onClick={() => navigate('/production/item-requirements')}
            >
              Item Requirements
            </button>
          )}
        </div>
      </div>

      {(mode !== 'list' || selectedJC?.drawingNumber || formData?.drawingNumber) && (
        <WorkflowNavigator
          projectId={selectedJC?.drawingNumber || formData?.drawingNumber}
          currentStage="production"
        />
      )}

      {/* Employee Workspace Banner (When logged in as Production Employee) */}
      {mode === 'list' && isEmployeeView && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '14px 18px', marginBottom: '18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: '700', color: '#1e40af' }}>
              <UserRound size={15} aria-hidden="true" /> Welcome, {myName || 'Production Employee'}
            </div>
            <div style={{ fontSize: '12.5px', color: '#2563eb', marginTop: '2px' }}>
              Showing only the Job Cards and process routing stages assigned to you ({myEmpId ? `ID: ${myEmpId}` : myName}).
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <span style={{ background: '#ffffff', color: '#1e40af', padding: '5px 12px', borderRadius: '14px', fontSize: '12.5px', fontWeight: '700', border: '1px solid #bfdbfe' }}>
              <ClipboardList size={15} aria-hidden="true" /> {scopedJobCards.length} Assigned Job Card{scopedJobCards.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
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

      {/* Store → Production material acknowledgement */}
      {mode === 'list' && <StoreAckDashboard />}

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
                            {(() => {
                              const procs = Array.isArray(jc.processes) ? jc.processes : [];
                              if (procs.length === 0) return null;
                              const done = procs.filter((p) => p.status === 'Completed').length;
                              return (
                                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                                  {done}/{procs.length} steps ({Math.round((done / procs.length) * 100)}%)
                                </div>
                              );
                            })()}
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
                            {(() => {
                              const myAssignedProcesses = (jc.processes || []).filter(isProcessAssignedToMe);
                              return (
                                <>
                                  {jc.assignedTo ? (
                                    <>
                                      <span style={{ fontSize: '12px', fontWeight: '600', color: '#1e293b' }}>{jc.assignedTo}</span>
                                      <div style={{ fontSize: '11px', color: '#64748b' }}>{jc.assignedToEmpId}</div>
                                    </>
                                  ) : (
                                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>Unassigned (Lead)</span>
                                  )}
                                  {myAssignedProcesses.length > 0 && (
                                    <div style={{ marginTop: '4px' }}>
                                      <span style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe', padding: '2px 6px', borderRadius: '8px', fontSize: '11px', fontWeight: '700', display: 'inline-block' }}>
                                        <UserRound size={14} aria-hidden="true" /> Your Task: {myAssignedProcesses.map((p) => p.process).join(', ')}
                                      </span>
                                    </div>
                                  )}
                                  {!isEmployeeView && jc.processes && jc.processes.some((p) => p.operator) && (
                                    <div style={{ fontSize: '11px', color: '#475569', marginTop: '3px' }}>
                                      {jc.processes.filter((p) => p.operator).map((p) => `${p.operator} (${p.process ? p.process.split(' ')[0] : 'Op'})`).slice(0, 3).join(', ')}
                                      {jc.processes.filter((p) => p.operator).length > 3 && '...'}
                                    </div>
                                  )}
                                </>
                              );
                            })()}
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
                                    View Job Card
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
                              {canRequestDispatch && jc.status === 'Completed' && String(jc.qualityControl?.finalQC?.disposition || '').toLowerCase() === 'pass' && !dispatchRequests.some((request) => request.jobCardNumber === jc.jobCardNumber) && (
                                <button
                                  className="button-small"
                                  style={{ color: '#16a34a', borderColor: '#bbf7d0' }}
                                  onClick={() => handleDispatchRequest(jc)}
                                  title="Send a dispatch request to Sales"
                                >
                                  Dispatch Request
                                </button>
                              )}
                              {dispatchRequests.find((request) => request.jobCardNumber === jc.jobCardNumber) && (
                                <span className="muted-text">{dispatchRequests.find((request) => request.jobCardNumber === jc.jobCardNumber).status}</span>
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
            <CreateAckNotice projectId={formData.projectId || ''} />
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
                  <label>
                    Drawing Number
                    {drawingOptions.length > 1 && (
                      <span style={{ color: '#2563eb', fontWeight: 500 }}> · pick one</span>
                    )}
                  </label>
                  {drawingOptions.length > 1 ? (
                    <select
                      value={formData.drawingNumber}
                      onChange={(e) => setFormData({ ...formData, drawingNumber: e.target.value })}
                      title="Choose which drawing of this project the Job Card is for"
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
                      value={formData.drawingNumber}
                      onChange={(e) => setFormData({ ...formData, drawingNumber: e.target.value })}
                    />
                  )}
                  <div style={{ marginTop: '6px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="button-small button-secondary"
                      disabled={!formData.projectId || !formData.drawingNumber}
                      title="Fetch the drawing PDF stored with the Enquiry for this Project ID"
                      onClick={() => syncDrawingPdf(formData.projectId, formData.drawingNumber, true)}
                    >
                      ⧉ Fetch drawing PDF
                    </button>
                    {drawingPdf?.found ? (
                      <button
                        type="button"
                        className="button-small"
                        style={{ color: '#1d4ed8' }}
                        title="Open the enquiry drawing PDF"
                        onClick={() => openDrawing(formData.projectId, formData.drawingNumber)}
                      >
                        View {drawingPdf.fileName || `${drawingPdf.drawingNo}.pdf`}
                      </button>
                    ) : drawingPdf ? (
                      <span className="muted-text" style={{ fontSize: '11.5px' }}>
                        No PDF stored — upload it from the Enquiry screen
                      </span>
                    ) : null}
                  </div>
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


            {/* Process Routing Table (Job Card) */}
            <div id="sec-routing-table" className="form-section">
              <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <h3 style={{ margin: 0 }}>2. Process Routing (Job Card Table)</h3>
                  {(() => {
                    const allProcs = Array.isArray(formData.processes) ? formData.processes : [];
                    const procs = isEmployeeView ? allProcs.filter(isProcessAssignedToMe) : allProcs;
                    const total = procs.length;
                    const completed = procs.filter((p) => p.status === 'Completed').length;
                    const inProg = procs.filter((p) => p.status === 'In Progress').length;
                    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
                    return (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                        <span style={{ background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', padding: '3px 10px', borderRadius: '12px', fontWeight: '600' }}>
                          <CircleCheck size={14} aria-hidden="true" /> {completed}/{total} {isEmployeeView ? 'Your Tasks' : 'Completed'} ({pct}%)
                        </span>
                        {inProg > 0 && (
                          <span style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '3px 10px', borderRadius: '12px', fontWeight: '600' }}>
                            <Settings2 size={14} aria-hidden="true" /> {inProg} In Progress
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
                {!isEmployeeView && (
                <button type="button" className="button-small" onClick={handleAddProcess} style={{ color: '#1d4ed8', borderColor: '#93c5fd' }}>
                  + Add Process
                </button>
                )}
              </div>
              <div className="route-form-table-wrapper">
                <table className="route-form-table">
                  <thead>
                    <tr>
                      <th style={{ width: '48px' }}>SL.No</th>
                      <th style={{ minWidth: '200px' }}>Process</th>
                      <th>Machine Name</th>
                      <th>Input QTY</th>
                      <th>Output QTY</th>
                      <th>Rework QTY</th>
                      <th>Reject QTY</th>
                      <th style={{ minWidth: '170px' }}>Start Date &amp; Time</th>
                      <th style={{ minWidth: '170px' }}>End Date &amp; Time</th>
                      <th>Operator / Inspector</th>
                      <th style={{ minWidth: '130px' }}>Status</th>
                      {!isEmployeeView && <th style={{ width: '52px' }}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(formData.processes) ? formData.processes : [emptyProcess()])
                      .map((proc, idx) => ({ proc, idx }))
                      .filter(({ proc }) => !isEmployeeView || isProcessAssignedToMe(proc))
                      .map(({ proc, idx }) => (
                      <tr
                        key={proc.id || idx}
                        style={isProcessAssignedToMe(proc) ? { background: '#f0f9ff' } : (isEmployeeView ? { opacity: 0.5, pointerEvents: 'none' } : {})}
                      >
                        <td className="text-center">
                          {idx + 1}
                          {isProcessAssignedToMe(proc) && (
                            <div style={{ fontSize: '9px', background: '#2563eb', color: '#fff', padding: '1px 3px', borderRadius: '4px', fontWeight: '700', marginTop: '2px' }}>
                              YOU
                            </div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <select
                              value={STANDARD_PROCESSES.includes(proc.process) ? proc.process : (proc.process ? '__custom__' : '')}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === '__custom__') {
                                  handleProcessChange(idx, 'process', proc.process && !STANDARD_PROCESSES.includes(proc.process) ? proc.process : '');
                                  handleProcessChange(idx, 'isCustomProcess', true);
                                } else {
                                  handleProcessChange(idx, 'process', val);
                                  handleProcessChange(idx, 'isCustomProcess', false);
                                  if (val && PROCESS_SECTION_MAP[val]) {
                                    scrollToSection(PROCESS_SECTION_MAP[val]);
                                  }
                                }
                              }}
                              style={{ flex: 1, minWidth: '150px', padding: '5px 8px', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                            >
                              <option value="">-- Select Process --</option>
                              {STANDARD_PROCESSES.map((sp) => (
                                <option key={sp} value={sp}>{sp}</option>
                              ))}
                              <option value="__custom__">+ Custom Process...</option>
                            </select>
                            {proc.process && PROCESS_SECTION_MAP[proc.process] && (
                              <button
                                type="button"
                                className="button-small"
                                onClick={() => scrollToSection(PROCESS_SECTION_MAP[proc.process])}
                                title="Jump down to this operation section"
                                style={{ padding: '3px 6px', fontSize: '11px', whiteSpace: 'nowrap', borderColor: '#bfdbfe', color: '#1d4ed8', background: '#eff6ff' }}
                              >
                                <ChevronDown size={14} aria-hidden="true" /> Details
                              </button>
                            )}
                          </div>
                          {(proc.isCustomProcess || (proc.process && !STANDARD_PROCESSES.includes(proc.process))) && (
                            <input
                              type="text"
                              placeholder="Enter custom process name"
                              value={proc.process || ''}
                              onChange={(e) => handleProcessChange(idx, 'process', e.target.value)}
                              style={{ marginTop: '4px', width: '100%', minWidth: '180px' }}
                            />
                          )}
                        </td>
                        <td>
                          <MachineSearchSelect
                            value={proc.machineId ? (findMachine(proc.machineId) || { machineId: proc.machineId, name: proc.machineId }) : null}
                            placeholder="Search machine..."
                            portalMenu
                            compact
                            onChange={(m) => handleProcessChange(idx, 'machineId', m ? m.machineId : '')}
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
                            type="datetime-local"
                            value={toDateTimeLocalValue(proc.startTime)}
                            onChange={(e) => handleProcessChange(idx, 'startTime', e.target.value)}
                            style={{ minWidth: '165px' }}
                          />
                        </td>
                        <td>
                          <input
                            type="datetime-local"
                            value={toDateTimeLocalValue(proc.endTime)}
                            onChange={(e) => handleProcessChange(idx, 'endTime', e.target.value)}
                            style={{ minWidth: '165px' }}
                          />
                        </td>
                        <td>
                          <EmployeeSearchSelect
                            value={proc.operatorId ? { employeeId: proc.operatorId, name: proc.operator } : null}
                            placeholder="Search operator..."
                            portalMenu
                            compact
                            onChange={(e) => {
                              handleProcessChange(idx, 'operatorId', e ? e.employeeId : '');
                              handleProcessChange(idx, 'operator', e ? e.name : '');
                            }}
                          />
                        </td>
                        <td>
                          <select
                            value={proc.status || 'Pending'}
                            onChange={(e) => handleProcessChange(idx, 'status', e.target.value)}
                            style={{
                              width: '100%',
                              minWidth: '125px',
                              padding: '5px 8px',
                              borderRadius: '6px',
                              fontWeight: '600',
                              fontSize: '12px',
                              border: '1px solid',
                              backgroundColor:
                                proc.status === 'Completed' ? '#ecfdf5' :
                                proc.status === 'In Progress' ? '#eff6ff' : '#f8fafc',
                              color:
                                proc.status === 'Completed' ? '#047857' :
                                proc.status === 'In Progress' ? '#1d4ed8' : '#64748b',
                              borderColor:
                                proc.status === 'Completed' ? '#a7f3d0' :
                                proc.status === 'In Progress' ? '#bfdbfe' : '#cbd5e1'
                            }}
                          >
                            <option value="Pending">Pending</option>
                            <option value="In Progress">In Progress</option>
                            <option value="Completed">Completed</option>
                          </select>
                        </td>
                        {!isEmployeeView && (
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
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Machining Routing Operations */}
            <div className="form-section">
              <div className="section-heading">
                <h3>3. Machining Operations & Setup Approvals</h3>
              </div>

              {/* Turning Stage */}
              <div id="op-turning" style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #e2e8f0', transition: 'all 0.3s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ color: '#1e293b' }}>Operation 10: Turning (CNC / Lathe)</strong>
                  <button
                    type="button"
                    onClick={() => scrollToSection('sec-routing-table')}
                    style={{ fontSize: '11px', background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    <ChevronUp size={14} aria-hidden="true" /> Back to Routing Table
                  </button>
                </div>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Turning Status</label>
                    <select
                      value={formData.operations.turning.status}
                      onChange={(e) => updateOperationWithSync('turning', { status: e.target.value })}
                    >
                      <option value="Pending">Pending</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Machine Name</label>
                    <MachineSearchSelect
                      value={findMachine(formData.operations.turning.machineId || formData.operations.turning.machine) || null}
                      placeholder="Search machine..."
                      onChange={(m) =>
                        updateOperationWithSync('turning', {
                          machineId: m ? m.machineId : '',
                          machine: m ? `${m.machineId} - ${m.name}` : ''
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>Operator</label>
                    <EmployeeSearchSelect
                      value={formData.operations.turning.operatorId ? { employeeId: formData.operations.turning.operatorId, name: formData.operations.turning.operator } : null}
                      placeholder="Search operator..."
                      onChange={(e) =>
                        updateOperationWithSync('turning', {
                          operatorId: e ? e.employeeId : '',
                          operator: e ? e.name : ''
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
              <div id="op-milling" style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #e2e8f0', transition: 'all 0.3s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ color: '#1e293b' }}>Operation 20: Milling / Grinding (VMC / Surface Grinder)</strong>
                  <button
                    type="button"
                    onClick={() => scrollToSection('sec-routing-table')}
                    style={{ fontSize: '11px', background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    <ChevronUp size={14} aria-hidden="true" /> Back to Routing Table
                  </button>
                </div>
                <div className="section-grid" style={{ marginTop: '10px' }}>
                  <div className="field-group">
                    <label>Milling/Grinding Status</label>
                    <select
                      value={formData.operations.millingGrinding.status}
                      onChange={(e) => updateOperationWithSync('millingGrinding', { status: e.target.value })}
                    >
                      <option value="Pending">Pending</option>
                      <option value="In Progress">In Progress</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Machine Name</label>
                    <MachineSearchSelect
                      value={findMachine(formData.operations.millingGrinding.machineId || formData.operations.millingGrinding.machine) || null}
                      placeholder="Search machine..."
                      onChange={(m) =>
                        updateOperationWithSync('millingGrinding', {
                          machineId: m ? m.machineId : '',
                          machine: m ? `${m.machineId} - ${m.name}` : ''
                        })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>Operator</label>
                    <EmployeeSearchSelect
                      value={formData.operations.millingGrinding.operatorId ? { employeeId: formData.operations.millingGrinding.operatorId, name: formData.operations.millingGrinding.operator } : null}
                      placeholder="Search operator..."
                      onChange={(e) =>
                        updateOperationWithSync('millingGrinding', {
                          operatorId: e ? e.employeeId : '',
                          operator: e ? e.name : ''
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
                      <option value="NO">Not Approved (Setup In Progress)</option>
                      <option value="YES">Approved by Quality / Supervisor</option>
                    </select>
                  </div>
                  <div className="field-group">
                    <label>Approved By (Quality Lead / Supervisor)</label>
                    <EmployeeSearchSelect
                      value={formData.operations.setupApproval.approvedById ? { employeeId: formData.operations.setupApproval.approvedById, name: formData.operations.setupApproval.approvedBy } : null}
                      placeholder="Search approver..."
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          operations: {
                            ...formData.operations,
                            setupApproval: { ...formData.operations.setupApproval, approvedById: e ? e.employeeId : '', approvedBy: e ? e.name : '' }
                          }
                        })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Heat Treatment Stage */}
              <div id="op-heattreat" style={{ background: '#fffbeb', padding: '14px', borderRadius: '8px', marginBottom: '14px', border: '1px solid #fde68a', transition: 'all 0.3s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ color: '#92400e' }}>Operation 30: Heat Treatment</strong>
                  <button
                    type="button"
                    onClick={() => scrollToSection('sec-routing-table')}
                    style={{ fontSize: '11px', background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    <ChevronUp size={14} aria-hidden="true" /> Back to Routing Table
                  </button>
                </div>
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
                          onChange={(e) => updateOperationWithSync('heatTreatment', { status: e.target.value })}
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
                        <EmployeeSearchSelect
                          value={formData.operations.heatTreatment.inspectorId ? { employeeId: formData.operations.heatTreatment.inspectorId, name: formData.operations.heatTreatment.inspector } : null}
                          placeholder="Search inspector..."
                          onChange={(e) =>
                            updateOperationWithSync('heatTreatment', {
                              inspectorId: e ? e.employeeId : '',
                              inspector: e ? e.name : ''
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
              <div id="op-wirecut" style={{ background: '#f8fafc', padding: '14px', borderRadius: '8px', border: '1px solid #e2e8f0', transition: 'all 0.3s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ color: '#1e293b' }}>Operation 40: Wire Cutting / Drilling / Sparking</strong>
                  <button
                    type="button"
                    onClick={() => scrollToSection('sec-routing-table')}
                    style={{ fontSize: '11px', background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    <ChevronUp size={14} aria-hidden="true" /> Back to Routing Table
                  </button>
                </div>
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
                      onChange={(e) => updateOperationWithSync('machineProcess', { status: e.target.value })}
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
                      placeholder="e.g. Wire cut profile, drill ü6 through, spark EDM pocket"
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
            <div id="sec-surface-treatment" className="form-section" style={{ transition: 'all 0.3s ease' }}>
              <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>4. Surface Treatment (Coating/Plating) & Packing</h3>
                <button
                  type="button"
                  onClick={() => scrollToSection('sec-routing-table')}
                  style={{ fontSize: '11px', background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  <ChevronUp size={14} aria-hidden="true" /> Back to Routing Table
                </button>
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
                        onChange={(e) => updateFinishingWithSync({ status: e.target.value })}
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
            <div id="sec-qc" className="form-section" style={{ transition: 'all 0.3s ease' }}>
              <div className="section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>5. Quality Control (In-Process & Final Inspection)</h3>
                <button
                  type="button"
                  onClick={() => scrollToSection('sec-routing-table')}
                  style={{ fontSize: '11px', background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  <ChevronUp size={14} aria-hidden="true" /> Back to Routing Table
                </button>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>In-Process QC Status</label>
                  <select
                    value={formData.qualityControl.inProcessQC.status}
                    onChange={(e) => updateQCWithSync('inProcessQC', { status: e.target.value })}
                  >
                    <option value="Pending">Pending</option>
                    <option value="Passed">Passed (Dimensions OK)</option>
                    <option value="Rework">Rework Required</option>
                  </select>
                </div>
                <div className="field-group">
                  <label>In-Process QC Inspector</label>
                  <EmployeeSearchSelect
                    value={formData.qualityControl.inProcessQC.inspectorId ? { employeeId: formData.qualityControl.inProcessQC.inspectorId, name: formData.qualityControl.inProcessQC.inspector } : null}
                    placeholder="Search inspector..."
                    onChange={(e) =>
                      updateQCWithSync('inProcessQC', {
                        inspectorId: e ? e.employeeId : '',
                        inspector: e ? e.name : ''
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Final Inspection 3-Way Disposition *</label>
                  <select
                    value={formData.qualityControl.finalQC.disposition}
                    onChange={(e) => updateQCWithSync('finalQC', { disposition: e.target.value })}
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
                Save & Update Job Card
              </button>
            </div>
          </form>
        )}

        {mode === 'view' && selectedJC && (
          <div>
            <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
              {canRequestDispatch && selectedJC.status === 'Completed' && String(selectedJC.qualityControl?.finalQC?.disposition || '').toLowerCase() === 'pass' && !dispatchRequests.some((request) => request.jobCardNumber === selectedJC.jobCardNumber) && (
                <button
                  className="button-primary"
                  onClick={() => handleDispatchRequest(selectedJC)}
                  style={{ background: '#16a34a' }}
                >
                  Request Dispatch
                </button>
              )}
              <button
                className="button-secondary"
                onClick={() => window.print()}
                    title="Print the Job Card in landscape (F/PROD/02)"
              >
                    Print Job Card
              </button>
              <button
                className="button-secondary"
                onClick={() => generateRouteCardPDF(selectedJC)}
                    title="Download the Job Card as a landscape PDF"
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
                  <h3 style={{ margin: '0 0 8px', fontSize: '15px', color: '#1e293b' }}>Manufacturing Steps (Job Card)</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12.5px', color: '#334155' }}>
                    <span><strong>Project:</strong> {selectedJC.projectId ? `${selectedJC.projectId}${selectedJC.projectName ? ` — ${selectedJC.projectName}` : ''}` : '-'}</span>
                    <span><strong>Customer:</strong> {selectedJC.customer || selectedJC.customerName || '-'}</span>
                    <span><strong>Part:</strong> {selectedJC.partName || '-'}</span>
                    <span>
                      <strong>Drawing No:</strong> {selectedJC.drawingNumber || '-'}{' '}
                      {selectedJC.projectId && selectedJC.drawingNumber && (
                        <button
                          type="button"
                          className="button-small"
                          style={{ color: '#1d4ed8', marginLeft: '6px' }}
                          title="Open the enquiry drawing PDF for this Project ID"
                          onClick={() => openDrawing(selectedJC.projectId, selectedJC.drawingNumber)}
                        >
                          ⧉ View drawing
                        </button>
                      )}
                    </span>
                    <span><strong>Qty:</strong> {selectedJC.orderQuantity} Nos</span>
                  </div>
                  {(selectedJC.attachments || []).length > 0 && (
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' }}>
                      <span style={{ fontSize: '11.5px', color: '#64748b', fontWeight: 600 }}>ATTACHMENTS</span>
                      {selectedJC.attachments.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="button-small"
                          style={{ color: '#1d4ed8' }}
                          title={a.source === 'enquiry drawing' ? 'Auto-fetched from the Enquiry' : a.name}
                          onClick={() => openWorkflowDocument(a)}
                        >
                          ⧉ {a.name}
                        </button>
                      ))}
                    </div>
                  )}
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

                {/* Landscape page setup for the Job Card print (only mounted in view mode) */}
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
                      <td className="route-header-title">JOB CARD</td>
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

                {(() => {
                  const allProcs = Array.isArray(selectedJC.processes) ? selectedJC.processes : [];
                  const procs = isEmployeeView ? allProcs.filter(p => isProcessAssignedToMe(p)) : allProcs;
                  const total = procs.length;
                  const completed = procs.filter((p) => p.status === 'Completed').length;
                  const inProg = procs.filter((p) => p.status === 'In Progress').length;
                  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
                  return (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', padding: '6px 12px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: '#334155' }}>
                        {isEmployeeView ? 'Your Process Progress' : 'Process Routing Progress'}
                      </span>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <span style={{ background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>
                          <CircleCheck size={14} aria-hidden="true" /> {completed}/{total} {isEmployeeView ? 'Your Tasks' : 'Completed'} ({pct}%)
                        </span>
                        {inProg > 0 && (
                          <span style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: '600' }}>
                            <Settings2 size={14} aria-hidden="true" /> {inProg} In Progress
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
                <table className="route-process-table">
                  <thead>
                    <tr>
                      <th>Process</th>
                      <th>Machine Name</th>
                      <th>Input QTY</th>
                      <th>Output QTY</th>
                      <th>Rework QTY</th>
                      <th>Reject QTY</th>
                      <th style={{ minWidth: '170px' }}>Start Date &amp; Time</th>
                      <th style={{ minWidth: '170px' }}>End Date &amp; Time</th>
                      <th>Operator / Inspector</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const allProcs = Array.isArray(selectedJC.processes) ? selectedJC.processes : [];
                      const visibleProcs = isEmployeeView ? allProcs.filter(p => isProcessAssignedToMe(p)) : allProcs;
                      return visibleProcs.length > 0 && visibleProcs.map((p, idx) => (
                        <tr
                          key={p.id || idx}
                          style={isProcessAssignedToMe(p) ? { background: '#f0f9ff' } : {}}
                        >
                          <td>
                            <strong>{p.process || '-'}</strong>
                            {isProcessAssignedToMe(p) && (
                              <span style={{ background: '#2563eb', color: '#fff', fontSize: '10px', padding: '1px 6px', borderRadius: '10px', fontWeight: '700', marginLeft: '6px' }}>
                                <UserRound size={14} aria-hidden="true" /> Assigned to You
                              </span>
                            )}
                          </td>
                          <td>{machineDisplay(p.machineId || p.machineName || p.machineNo)}</td>
                          <td>{p.inputQty === '' || p.inputQty === undefined ? '-' : p.inputQty}</td>
                          <td>{p.outputQty === '' || p.outputQty === undefined ? '-' : p.outputQty}</td>
                          <td>{p.reworkQty === '' || p.reworkQty === undefined ? '-' : p.reworkQty}</td>
                          <td>{p.rejectQty === '' || p.rejectQty === undefined ? '-' : p.rejectQty}</td>
                          <td>{formatDateTimeDMY(p.startTime)}</td>
                          <td>{formatDateTimeDMY(p.endTime)}</td>
                          <td>{p.operator || '-'}</td>
                          <td>
                            <span
                              style={{
                                padding: '2px 8px',
                                borderRadius: '12px',
                                fontSize: '11px',
                                fontWeight: '700',
                                background:
                                  p.status === 'Completed' ? '#dcfce7' :
                                  p.status === 'In Progress' ? '#dbeafe' : '#f1f5f9',
                                color:
                                  p.status === 'Completed' ? '#166534' :
                                  p.status === 'In Progress' ? '#1e40af' : '#475569'
                              }}
                            >
                              {p.status === 'Completed' ? <><CircleCheck size={14} aria-hidden="true" /> Completed</> : p.status === 'In Progress' ? <><Settings2 size={14} aria-hidden="true" /> In Progress</> : <><Clock3 size={14} aria-hidden="true" /> Pending</>}
                            </span>
                          </td>
                        </tr>
                      ));
                    })()}
                    {(Array.isArray(selectedJC.processes) ? selectedJC.processes : []).length === 0 && (
                      <tr>
                        <td className="text-center" colSpan="10">-</td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <div className="route-sheet-footer">
                  <span>{getCompanyLegalName()} — Job Card</span>
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

