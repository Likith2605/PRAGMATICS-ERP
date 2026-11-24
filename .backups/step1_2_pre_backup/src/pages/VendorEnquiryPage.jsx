import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { isAdmin } from '../utils/auth.js';
import { hasPermission } from '../utils/permissions.js';
import {
  getPurchaseRequests,
  getAllVendorEnquiries,
  createVendorEnquiry,
  updateVendorEnquiry,
  deleteVendorEnquiry,
  dateOnly
} from '../utils/storeService.js';
import {
  getIndents,
  INDENT_STATUS
} from '../utils/workflowService.js';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';
import VendorEnquiryTermsSection from '../components/VendorEnquiryTermsSection.jsx';

const STATUS_COLORS = {
  Draft: { bg: '#f1f5f9', color: '#475569' },
  Invited: { bg: '#f1f5f9', color: '#475569' },
  Sent: { bg: '#eff6ff', color: '#1d4ed8' },
  'Quotations Received': { bg: '#f0fdf4', color: '#166534' },
  Closed: { bg: '#f8fafc', color: '#6b7280' },
  Cancelled: { bg: '#fef2f2', color: '#991b1b' }
};

const StatusBadge = ({ status }) => {
  const c = STATUS_COLORS[status] || STATUS_COLORS.Draft;
  return (
    <span className="status-badge" style={{ background: c.bg, color: c.color }}>
      {status}
    </span>
  );
};

const VendorEnquiryPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const canCreate = hasPermission('purchase_request.create') || hasPermission('purchase_request.approve');

  const [enquiries, setEnquiries] = useState([]);
  const [approvedPRs, setApprovedPRs] = useState([]);
  const [view, setView] = useState('list');
  const [selectedPR, setSelectedPR] = useState(null);
  const [vendors, setVendors] = useState([{ name: '', contact: '', email: '', phone: '' }]);
  const [remarks, setRemarks] = useState('');
  const [termsAndConditions, setTermsAndConditions] = useState('');
  const [validUntil, setValidUntil] = useState(() =>
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  );
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('All');
  const [prPickerOpen, setPrPickerOpen] = useState(false);
  // Purchase Indents awaiting a vendor enquiry (raw-material procurement chain)
  const [openIndents, setOpenIndents] = useState([]);
  // Shared by Store but not yet approved by the Admin — enquiry cannot start.
  const [awaitingApproval, setAwaitingApproval] = useState([]);

  // Load once on mount. Writing enquiries here while also depending on
  // [enquiries] retriggered this effect forever (fresh array each run),
  // which starved React's route transition and froze navigation away from
  // this page (the + VQ click changed the URL but never re-rendered).
  useEffect(() => {
    setApprovedPRs(getPurchaseRequests().filter((p) => p.status === 'Approved'));
    setEnquiries(getAllVendorEnquiries());
  }, []);

  // Recomputes indent buckets whenever enquiries change (create/delete handlers).
  useEffect(() => {
    try {
      const indents = getIndents();
      const withoutEnquiry = indents.filter(
        (i) =>
          i.status === INDENT_STATUS.SUBMITTED &&
          !(enquiries || []).some((e) => e.indentNumber === i.indentNumber)
      );
      setOpenIndents(withoutEnquiry.filter((i) => Boolean(i.adminApprovedAt)));
      setAwaitingApproval(withoutEnquiry.filter((i) => !i.adminApprovedAt));
    } catch {
      setOpenIndents([]);
      setAwaitingApproval([]);
    }
  }, [enquiries]);

  // Deep link from the Purchase Indent screen: /vendor-enquiry?state.purchaseIndent=IND-0001
  useEffect(() => {
    const indentNumber = location.state?.purchaseIndent;
    if (!indentNumber) return;
    try {
      const parsed = JSON.parse(localStorage.getItem('purchaseIndents') || '[]');
      const indents = Array.isArray(parsed) ? parsed : [];
      const ind = indents.find((i) => i.indentNumber === indentNumber);
      if (ind) handleSelectIndent(ind);
    } catch {
      /* ignore malformed storage */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  /** Loads a Purchase Indent into the enquiry form, inheriting the full SO/project chain. */
  const handleSelectIndent = (indent) => {
    setSelectedPR({
      sourceType: 'purchaseIndent',
      prNumber: indent.indentNumber,
      indentNumber: indent.indentNumber,
      projectId: indent.projectId || '',
      soNumber: indent.soNumber || '',
      customer: indent.customer || '',
      requiredDate: indent.requiredDate || '',
      items: (indent.items || []).map((it) => ({
        materialCode: it.materialCode || '',
        materialName: it.materialName || it.partName || '',
        drawingNo: it.drawingNo || '',
        hsnSac: it.hsnSac || '',
        requiredQty: it.purchaseQty || 1,
        unit: it.unit || 'Nos',
        specifications: it.specifications || ''
      }))
    });
    setVendors([{ name: '', contact: '', email: '', phone: '' }]);
    setRemarks(`Purchase Indent ${indent.indentNumber} raised against ${indent.soNumber || 'Sales Order'}.`);
    setTermsAndConditions('');
    setView('create');
  };

  const filtered = filter === 'All' ? enquiries : enquiries.filter((e) => e.status === filter);

  const handleSelectPR = (pr) => {
    setSelectedPR(pr);
    setVendors([{ name: '', contact: '', email: '', phone: '' }]);
    setRemarks('');
    setTermsAndConditions('');
    setView('create');
  };

  const addVendor = () => setVendors([...vendors, { name: '', contact: '', email: '', phone: '' }]);
  const removeVendor = (idx) => setVendors(vendors.filter((_, i) => i !== idx));
  const updateVendor = (idx, field, val) => setVendors(vendors.map((v, i) => i === idx ? { ...v, [field]: val } : v));

  const handleCreate = () => {
    if (!selectedPR) return;
    const validVendors = vendors.filter((v) => v.name.trim());
    if (validVendors.length === 0) return alert('Add at least one vendor.');
    try {
      setBusy(true);
      const record = createVendorEnquiry({
        prNumber: selectedPR.prNumber,
        indentNumber: selectedPR.indentNumber || '',
        soNumber: selectedPR.soNumber || '',
        customer: selectedPR.customer || '',
        requiredDate: selectedPR.requiredDate || '',
        projectId: selectedPR.projectId,
        projectName: selectedPR.projectName,
        partName: selectedPR.partName,
        jobCardNumber: selectedPR.jobCardNumber,
        items: selectedPR.items,
        vendors: validVendors,
        remarks,
        termsAndConditions,
        validUntil
      });
      setBusy(false);
      alert(`Vendor Enquiry ${record.enquiryNumber} created. Send it to the vendors manually.`);
      setEnquiries(getAllVendorEnquiries());
      setView('list');
    } catch (err) {
      setBusy(false);
      alert(err.message);
    }
  };

  const handleSend = (enquiryNumber) => {
    if (!window.confirm(`Mark ${enquiryNumber} as Sent to vendors?`)) return;
    try {
      updateVendorEnquiry(enquiryNumber, { status: 'Sent', sentAt: new Date().toISOString() });
      setEnquiries(getAllVendorEnquiries());
    } catch (err) {
      alert(err.message);
    }
  };

  const handleViewEnquiry = (enq) => {
    localStorage.setItem('currentVendorEnquiry', JSON.stringify(enq));
    navigate('/vendor-enquiry/preview', { state: { enquiry: enq } });
  };

  const handleReceive = (enq) => {
    navigate('/vendor-quotations', {
      state: {
        fromVendorEnquiry: true,
        vendorEnquiry: {
          enquiryNumber: enq.enquiryNumber,
          prNumber: enq.prNumber,
          indentNumber: enq.indentNumber || '',
          soNumber: enq.soNumber || '',
          projectId: enq.projectId,
          projectName: enq.projectName,
          partName: enq.partName,
          jobCardNumber: enq.jobCardNumber,
          requestedBy: enq.requestedBy,
          vendors: enq.vendors || [],
          items: (enq.items || []).map((it) => ({
            materialId: it.materialId || '',
            materialName: it.materialName || '',
            unit: it.unit || 'Nos',
            requiredQty: Number(it.requiredQty) || 0,
            shortageQty: Number(it.shortageQty) || 0,
            specification: it.specification || ''
          })),
          remarks: enq.remarks || '',
          status: enq.status,
          createdAt: enq.createdAt
        }
      }
    });
  };

  const handleClose = (enquiryNumber) => {
    if (!window.confirm(`Close enquiry ${enquiryNumber}? No more quotations will be accepted.`)) return;
    try {
      updateVendorEnquiry(enquiryNumber, { status: 'Closed', closedAt: new Date().toISOString() });
      setEnquiries(getAllVendorEnquiries());
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = (enquiryNumber) => {
    if (!window.confirm(`Delete enquiry ${enquiryNumber}?`)) return;
    try {
      deleteVendorEnquiry(enquiryNumber);
      setEnquiries(getAllVendorEnquiries());
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateQuotation = (enq) => {
    navigate('/vendor-quotations', {
      state: {
        fromVendorEnquiry: true,
        vendorEnquiry: {
          enquiryNumber: enq.enquiryNumber,
          prNumber: enq.prNumber,
          indentNumber: enq.indentNumber || '',
          soNumber: enq.soNumber || '',
          projectId: enq.projectId,
          projectName: enq.projectName,
          partName: enq.partName,
          jobCardNumber: enq.jobCardNumber,
          requestedBy: enq.requestedBy,
          vendors: enq.vendors || [],
          items: (enq.items || []).map((it) => ({
            materialId: it.materialId || '',
            materialName: it.materialName || '',
            unit: it.unit || 'Nos',
            requiredQty: Number(it.requiredQty) || 0,
            shortageQty: Number(it.shortageQty) || 0,
            specification: it.specification || ''
          })),
          remarks: enq.remarks || '',
          status: enq.status,
          createdAt: enq.createdAt
        }
      }
    });
  };

  if (view === 'create' && selectedPR) {
    return (
      <div className="page-section">
        <div className="page-header">
          <div>
            <p className="eyebrow">Purchase Department</p>
            <h1>Create Vendor Enquiry</h1>
            <p className="page-description">Select vendors and send enquiry for PR: {selectedPR.prNumber}</p>
          </div>
          <div className="header-actions">
            <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
            <button className="button-secondary" onClick={() => setView('list')}>
              Back to Enquiries
            </button>
          </div>
        </div>

        <div className="content-block">
          <div className="form-section">
            <div className="section-heading">
              <h3>PR Reference Details</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>PR Number</label>
                <input type="text" className="action-select" value={selectedPR.prNumber} readOnly />
              </div>
              <div className="field-group">
                <label>Project ID</label>
                <input type="text" className="action-select" value={selectedPR.projectId || '-'} readOnly />
              </div>
              <div className="field-group">
                <label>Part Name</label>
                <input type="text" className="action-select" value={selectedPR.partName || '-'} readOnly />
              </div>
              <div className="field-group">
                <label>Quote Valid Until</label>
                <input type="date" className="action-select" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Materials Required</h3>
              <span className="count-badge">{selectedPR.items?.length || 0} Items</span>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Material</th>
                    <th>Unit</th>
                    <th>Required</th>
                    <th>Shortage</th>
                    <th>Specification</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedPR.items || []).map((item, idx) => (
                    <tr key={idx}>
                      <td>{idx + 1}</td>
                      <td><strong>{item.materialName || item.materialId}</strong></td>
                      <td>{item.unit || '-'}</td>
                      <td>{item.requiredQty || 0}</td>
                      <td style={{ color: '#dc2626', fontWeight: 600 }}>{item.shortageQty || 0}</td>
                      <td>{item.specification || item.spec || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Vendors to Invite</h3>
              <button type="button" className="button-secondary button-small" onClick={addVendor}>+ Add Vendor</button>
            </div>
            {vendors.map((v, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '12px', marginBottom: '10px', alignItems: 'end' }}>
                <div className="field-group">
                  {idx === 0 && <label>Vendor Name *</label>}
                  <VendorMasterAutocomplete
                    className="action-select"
                    value={v.name}
                    onChange={(val) => updateVendor(idx, 'name', val)}
                    onSelect={(vm) =>
                      setVendors((prev) =>
                        prev.map((row, i) =>
                          i === idx
                            ? { ...row, email: row.email || vm.email || '', phone: row.phone || vm.phone || '' }
                            : row
                        )
                      )
                    }
                    placeholder="Vendor name"
                  />
                </div>
                <div className="field-group">
                  {idx === 0 && <label>Contact Person</label>}
                  <input type="text" className="action-select" value={v.contact} onChange={(e) => updateVendor(idx, 'contact', e.target.value)} />
                </div>
                <div className="field-group">
                  {idx === 0 && <label>Email</label>}
                  <input type="email" className="action-select" value={v.email} onChange={(e) => updateVendor(idx, 'email', e.target.value)} />
                </div>
                <div className="field-group">
                  {idx === 0 && <label>Phone</label>}
                  <input type="text" className="action-select" value={v.phone} onChange={(e) => updateVendor(idx, 'phone', e.target.value)} />
                </div>
                {vendors.length > 1 && (
                  <button type="button" className="button-secondary button-small danger" onClick={() => removeVendor(idx)}>Remove</button>
                )}
              </div>
            ))}
          </div>

          <VendorEnquiryTermsSection value={termsAndConditions} onChange={setTermsAndConditions} />

          <div className="form-section" style={{ marginTop: '20px' }}>
            <div className="section-heading">
              <h3>Remarks</h3>
            </div>
            <div className="field-group full-width">
              <textarea
                className="form-input"
                rows={4}
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Optional notes for vendors"
                style={{ resize: 'vertical', width: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word', lineHeight: '1.5' }}
              />
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: '20px' }}>
            <button type="button" className="button-primary" onClick={handleCreate} disabled={busy}>{busy ? 'Creating...' : 'Create Vendor Enquiry'}</button>
            <button type="button" className="button-secondary" onClick={() => setView('list')}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">Purchase Department</p>
          <h1>Vendor Enquiries</h1>
          <p className="page-description">
            Send enquiries to vendors for material shortage and receive quotations.
          </p>
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          <div style={{ position: 'relative' }}>
            <button className="button-primary" onClick={() => setPrPickerOpen((open) => !open)}>
              + Create Vendor Enquiry
            </button>
              {prPickerOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setPrPickerOpen(false)} />
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: '8px',
                      width: '420px',
                      maxHeight: '360px',
                      overflowY: 'auto',
                      background: '#fff',
                      border: '1px solid #e2e8f0',
                      borderRadius: '10px',
                      boxShadow: '0 12px 30px rgba(15,23,42,0.18)',
                      zIndex: 1000,
                      padding: '8px'
                    }}
                  >
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#64748b', padding: '6px 10px', textTransform: 'uppercase' }}>
                      Select an Approved Purchase Request
                    </div>
                    {approvedPRs.map((pr) => (
                      <button
                        key={pr.prNumber}
                        type="button"
                        onClick={() => {
                          setPrPickerOpen(false);
                          handleSelectPR(pr);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '10px 12px',
                          border: 'none',
                          borderBottom: '1px solid #f1f5f9',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontSize: '13px',
                          color: '#0f172a'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <strong>{pr.prNumber}</strong>
                        <span style={{ color: '#64748b' }}> · {pr.projectId || '-'} · {pr.partName || '-'} · {pr.items?.length || 0} item(s)</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
</div>
    </div>

    {/* Shared by Store, awaiting Admin approval */}
    {awaitingApproval.length > 0 && (
      <div className="content-block" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
        <div className="block-header">
          <div>
            <h2>Awaiting Admin approval</h2>
            <p className="section-description">
              These Purchase Indents were shared by Store. The Admin must approve them before Purchase can raise the
              vendor enquiry.
            </p>
          </div>
          <span className="count-badge">{awaitingApproval.length} Indents</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {awaitingApproval.map((i) => (
            <button
              key={i.indentNumber}
              className="button-secondary button-small"
              onClick={() => navigate('/purchase-indents', { state: { openIndent: i.indentNumber } })}
            >
              {i.indentNumber} · {i.projectId || i.soNumber || '-'} · open
            </button>
          ))}
        </div>
      </div>
    )}

    {/* Indents Ready for Enquiry */}
    {openIndents.length > 0 && (
      <div className="content-block">
        <div className="block-header">
          <div>
            <h2>Indents Ready for Enquiry</h2>
            <p className="section-description">Purchase Indents approved by Admin and awaiting the vendor enquiry.</p>
          </div>
          <span className="count-badge">{openIndents.length} Indents</span>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th style={{ minWidth: '120px' }}>Indent No</th>
                <th style={{ minWidth: '100px' }}>Date</th>
                <th style={{ minWidth: '100px' }}>SO</th>
                <th style={{ minWidth: '110px' }}>Project</th>
                <th style={{ minWidth: '100px' }}>Customer</th>
                <th style={{ minWidth: '90px' }}>Materials</th>
                <th style={{ minWidth: '140px' }}>Status</th>
                <th style={{ minWidth: '200px' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {openIndents.map((ind) => (
                <tr key={ind.indentNumber}>
                  <td><strong>{ind.indentNumber}</strong></td>
                  <td>{ind.indentDate}</td>
                  <td>{ind.soNumber || '-'}</td>
                  <td>{ind.projectId || '-'}</td>
                  <td>{ind.customer || '-'}</td>
                  <td>{ind.items?.length || 0}</td>
                  <td><StatusBadge status={ind.status} /></td>
                  <td>
                    <button
                      type="button"
                      className="button-small"
                      style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
                      onClick={() => handleSelectIndent(ind)}
                    >
                      Create Enquiry
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}

    <div className="content-block">
      <div className="block-header">
        <div>
          <h2>Vendor Enquiry List</h2>
          <p className="section-description">All vendor enquiries raised from approved purchase requests.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <select className="action-select" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="All">All Statuses</option>
            <option value="Draft">Draft</option>
            <option value="Sent">Sent</option>
            <option value="Quotations Received">Quotations Received</option>
            <option value="Closed">Closed</option>
          </select>
          <span className="count-badge">
            {filtered.length} Enquir{filtered.length === 1 ? 'y' : 'ies'}
          </span>
        </div>
      </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">+</div>
            <h3>No vendor enquiries yet</h3>
            <p>Create a vendor enquiry from an approved purchase request to start procurement.</p>
            {approvedPRs.length > 0 && (
              <div className="field-group" style={{ minWidth: '320px' }}>
                <label>Select Approved PR</label>
                <select
                  className="action-select"
                  value=""
                  onChange={(e) => {
                    const pr = approvedPRs.find((p) => p.prNumber === e.target.value);
                    if (pr) handleSelectPR(pr);
                  }}
                >
                  <option value="" disabled>
                    Choose a purchase request…
                  </option>
                  {approvedPRs.map((pr) => (
                    <option key={pr.prNumber} value={pr.prNumber}>
                      {pr.prNumber} · {pr.projectId || '-'} · {pr.partName || '-'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {openIndents.length > 0 && (
              <div className="field-group" style={{ minWidth: '320px' }}>
                <label>Or raise enquiry for a Purchase Indent</label>
                <select
                  className="action-select"
                  value=""
                  onChange={(e) => {
                    const ind = openIndents.find((i) => i.indentNumber === e.target.value);
                    if (ind) handleSelectIndent(ind);
                  }}
                >
                  <option value="" disabled>
                    Choose a purchase indent…
                  </option>
                  {openIndents.map((i) => (
                    <option key={i.indentNumber} value={i.indentNumber}>
                      {i.indentNumber} · {i.projectId || '-'} · {i.soNumber || '-'} · {(i.items || []).length} material(s)
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th style={{ minWidth: '120px' }}>Enquiry No</th>
                  <th style={{ minWidth: '100px' }}>Date</th>
                  <th style={{ minWidth: '100px' }}>PR Ref</th>
                  <th style={{ minWidth: '110px' }}>Indent</th>
                  <th style={{ minWidth: '100px' }}>SO</th>
                  <th style={{ minWidth: '120px' }}>Project</th>
                  <th style={{ minWidth: '90px' }}>Vendors</th>
                  <th style={{ minWidth: '100px' }}>Materials</th>
                  <th style={{ minWidth: '140px' }}>Status</th>
                  <th style={{ minWidth: '200px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((enq) => (
                  <tr key={enq.enquiryNumber}>
                    <td><strong>{enq.enquiryNumber}</strong></td>
                    <td>{dateOnly(enq.createdAt) || '-'}</td>
                    <td>{enq.prNumber}</td>
                    <td>{enq.indentNumber || '-'}</td>
                    <td>{enq.soNumber || '-'}</td>
                    <td>{enq.projectId || '-'}</td>
                    <td>{enq.vendors?.length || 0}</td>
                    <td>{enq.items?.length || 0}</td>
                    <td><StatusBadge status={enq.status} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="button-small"
                          onClick={() => handleViewEnquiry(enq)}
                        >
                          View
                        </button>
                        {enq.status === 'Draft' && (
                          <button
                            type="button"
                            className="button-small"
                            style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
                            onClick={() => handleSend(enq.enquiryNumber)}
                          >
                            Mark Sent
                          </button>
                        )}
                        {enq.status !== 'Closed' && enq.status !== 'Cancelled' && (
                          <button
                            type="button"
                            className="button-small"
                            style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
                            onClick={() => handleCreateQuotation(enq)}
                          >
                            + VQ
                          </button>
                        )}
                        {enq.status !== 'Closed' && enq.status !== 'Cancelled' && (
                          <button
                            type="button"
                            className="button-small"
                            style={{ color: '#6b7280', borderColor: '#d1d5db' }}
                            onClick={() => handleClose(enq.enquiryNumber)}
                          >
                            Close
                          </button>
                        )}
                        {canCreate && enq.status === 'Draft' && (
                          <button
                            type="button"
                            className="button-small danger"
                            onClick={() => handleDelete(enq.enquiryNumber)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Approved PRs available for creating enquiries */}
      {approvedPRs.length > 0 && (
        <div className="content-block">
          <div className="block-header">
            <div>
              <h2>Approved Purchase Requests</h2>
              <p className="section-description">Select a PR to create a vendor enquiry.</p>
            </div>
            <span className="count-badge">{approvedPRs.length} PRs</span>
          </div>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>PR No</th>
                  <th>Date</th>
                  <th>Project</th>
                  <th>Part</th>
                  <th>Materials</th>
                  <th>Priority</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {approvedPRs.map((pr) => (
                  <tr key={pr.prNumber}>
                    <td><strong>{pr.prNumber}</strong></td>
                    <td>{pr.prDate}</td>
                    <td>{pr.projectId || '-'}</td>
                    <td>{pr.partName || '-'}</td>
                    <td>{pr.items?.length || 0} material(s)</td>
                    <td>{pr.priority || 'Normal'}</td>
                    <td>
                      <button
                        type="button"
                        className="button-small"
                        style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
                        onClick={() => handleSelectPR(pr)}
                      >
                        Create Enquiry
                      </button>
                    </td>
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

export default VendorEnquiryPage;
