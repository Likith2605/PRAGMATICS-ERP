import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye } from 'lucide-react';
import defaultLogoUrl from '../assets/logo.png';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { viewDrawingFile, getBlobUrlFromDataUrl } from '../utils/fileViewer';
import { isAdmin } from '../utils/auth.js';
import { getDrawing, deleteAllDrawings } from '../utils/drawingStorage.js';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterProjectRequests } from '../utils/historySearch.js';

const ProjectRequestPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedProject, setSelectedProject] = useState(null);
  const [previewDrawing, setPreviewDrawing] = useState(null);

  const handlePreviewDrawing = async (dataUrl, fileName, projectId, drawingNo) => {
    let url = dataUrl;
    if (!url && projectId && drawingNo) {
      try { url = await getDrawing(projectId, drawingNo); } catch (e) { /* ignore */ }
    }
    if (!url) return;
    const blobUrl = getBlobUrlFromDataUrl(url);
    setPreviewDrawing({ fileName: fileName || 'drawing.pdf', dataUrl: url, blobUrl });
  };

  useEffect(() => {
    const loadProjects = () => {
      try {
        const stored = localStorage.getItem('projectRequests');
        setProjects(stored ? JSON.parse(stored) : []);
      } catch (error) {
        console.error('Unable to load project requests', error);
        setProjects([]);
      }
    };
    const onERPStateChange = (event) => {
      if (!event.detail?.key || event.detail.key === 'projectRequests') loadProjects();
    };
    const onStorage = (event) => {
      if (event.key === 'projectRequests') loadProjects();
    };
    loadProjects();
    window.addEventListener('erp-state-hydrated', loadProjects);
    window.addEventListener('erp-state-change', onERPStateChange);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', loadProjects);
    return () => {
      window.removeEventListener('erp-state-hydrated', loadProjects);
      window.removeEventListener('erp-state-change', onERPStateChange);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', loadProjects);
    };
  }, []);

  const filteredProjects = useMemo(() => {
    return filterProjectRequests(projects, search);
  }, [projects, search]);

  /* Enquiries that already have a quotation against them — those rows must not
     offer "+ Quote" a second time. */
  const quotedProjectIds = useMemo(() => {
    const ids = new Set();
    try {
      const stored = localStorage.getItem('quotationHistory');
      const list = stored ? JSON.parse(stored) : [];
      list.forEach((t) => {
        const pid = t?.projectId || t?.payload?.quotationDetails?.projectId;
        if (pid) ids.add(String(pid));
      });
    } catch {
      /* ignore unreadable history */
    }
    return ids;
  }, []);

  const deleteProject = async (id) => {
    if (window.confirm(`Delete project request ${id}?`)) {
      const updated = projects.filter((project) => project.projectId !== id);
      setProjects(updated);
      localStorage.setItem('projectRequests', JSON.stringify(updated));
      try { const proj = projects.find((p) => p.projectId === id); if (proj?.items) await deleteAllDrawings(id, proj.items); } catch (e) { /* ignore */ }
    }
  };

  const handleCreateQuotation = (project) => {
    const firstItem = project.items?.[0] || {};
    navigate('/quotation', {
      state: {
        fromProjectRequest: true,
        projectDetails: {
          projectId: project.projectId,
          customerName: project.customerName,
          companyName: project.companyName,
          address: project.address,
          email: project.email,
          phone: project.phone,
          gstin: project.gstin
        },
        items: project.items?.map((it) => ({
          itemCode: it.drawingNo ? `PRAG-${it.drawingNo.replace(/[^a-zA-Z0-9]/g, '')}` : 'PRAG-001',
          itemName: it.itemName,
          drawingNo: it.drawingNo,
          materialSpec: it.materialSpec,
          quantity: it.quantity || 1,
          unit: it.unit || 'Nos',
          unitPrice: 0,
          gst: '18',
          notes: it.notes
        }))
      }
    });
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Customer Enquiries</h1>
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          <button className="button-primary" onClick={() => navigate('/project-request/new')}>
            + Add New Enquiry
          </button>
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <div>
            <h2>Enquiry List</h2>
          </div>
          <span className="count-badge">
            {search.trim() ? `${filteredProjects.length} of ${projects.length}` : projects.length} Enquir{projects.length === 1 && !search.trim() ? 'y' : 'ies'}
          </span>
        </div>
        <RecordSearchBar
          value={search}
          onChange={setSearch}
          placeholder="Search enquiry, customer, contact, phone, email, project or drawing..."
          label="Search customer enquiries"
        />

        {projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">+</div>
            <h3>No enquiries yet</h3>
            <p>Create your first customer enquiry with drawing numbers and material specifications.</p>
            <button className="button-primary" onClick={() => navigate('/project-request/new')}>
              + Add New Enquiry
            </button>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="empty-state">
            <h3>No matching enquiries</h3>
            <p>Try another enquiry number, customer or drawing detail, or clear the search.</p>
          </div>
        ) : (
          <div className="history-table-wrapper">
            <table className="history-table project-request-table">
              <thead>
                <tr>
                  <th style={{ minWidth: '110px' }}>Enquiry ID</th>
                  <th style={{ minWidth: '160px', maxWidth: '200px' }}>Customer & Company</th>
                  <th style={{ minWidth: '160px', maxWidth: '200px' }}>Component & Drawing No.</th>
                  <th style={{ minWidth: '180px', maxWidth: '260px' }}>Material Specification</th>
                  <th style={{ minWidth: '110px' }}>Target Date</th>
                  <th style={{ minWidth: '90px' }}>Quantity</th>
                  <th style={{ minWidth: '170px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map((project) => {
                  const firstItem = project.items?.[0] || {};
                  const totalQty = (project.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
                  const alreadyQuoted = quotedProjectIds.has(String(project.projectId));

                  return (
                    <tr key={project.projectId}>
                      <td><strong>{project.projectId}</strong></td>
                      <td style={{ maxWidth: '200px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                        <strong>{project.companyName}</strong>
                        <div style={{ fontSize: '11px', color: '#64748b', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>Attn: {project.customerName}</div>
                      </td>
                      <td style={{ maxWidth: '200px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                        <strong>{firstItem.itemName || '-'}</strong>
                        {firstItem.drawingNo && (
                          <div style={{ fontSize: '11px', color: '#2563eb', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px', flexWrap: 'wrap' }}>
                            <span style={{ wordBreak: 'break-all' }}>📐 {firstItem.drawingNo}</span>
                            {firstItem.drawingFileName && (
                              <button
                                type="button"
                                onClick={() => handlePreviewDrawing(firstItem.drawingDataUrl, firstItem.drawingFileName, project.projectId, firstItem.drawingNo)}
                                title={`View Drawing: ${firstItem.drawingFileName || 'Drawing'}`}
                                style={{
                                  fontSize: '10px',
                                  background: '#e0f2fe',
                                  color: '#0369a1',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  border: '1px solid #bae6fd',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px'
                                }}
                              >
                                PDF <Eye size={14} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: '260px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                        <span style={{ fontSize: '12px', color: '#334155', display: 'block', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                          {firstItem.materialSpec || '-'}
                        </span>
                      </td>
                      <td>{project.targetDeliveryDate || project.requestedDate}</td>
                      <td>
                        <strong>{totalQty} {firstItem.unit || 'Nos'}</strong>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                          {alreadyQuoted ? (
                            <span
                              className="status-badge st-quoted"
                              title="Already converted to a quotation — create the quotation again from the Quotation page only if this one was deleted"
                            >
                              Quoted
                            </span>
                          ) : (
                            <button
                              className="button-small"
                              style={{ background: '#2563eb', color: '#ffffff', borderColor: '#1d4ed8' }}
                              onClick={() => handleCreateQuotation(project)}
                              title="Generate official Quotation from this Project"
                            >
                              + Quote
                            </button>
                          )}
                          <button
                            className="button-small"
                            onClick={() => setSelectedProject(project)}
                          >
                            View
                          </button>
                          {isAdmin() && (
                            <>
                              <button
                                className="button-small"
                                style={{ color: '#0369a1', borderColor: '#bae6fd', background: '#f0f9ff' }}
                                onClick={() => navigate('/project-request/new', { state: { edit: true, project } })}
                                title="Edit this Customer Enquiry"
                              >
                                Edit
                              </button>
                              <button
                                className="button-small danger"
                                onClick={() => deleteProject(project.projectId)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Project Details Modal */}
      {selectedProject && (
        <div className="template-modal-backdrop no-print" onMouseDown={() => setSelectedProject(null)}>
          <div className="template-modal" style={{ maxWidth: '650px' }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-header">
              <div>
                <h3>Project Request Details ({selectedProject.projectId})</h3>
                <p>{selectedProject.companyName}</p>
              </div>
              <button type="button" className="template-modal-close" onClick={() => setSelectedProject(null)}>×</button>
            </div>

            <div style={{ padding: '16px 0', fontSize: '13px', lineHeight: '1.6' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px', background: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
                <div><strong>Customer:</strong> {selectedProject.customerName}</div>
                <div><strong>Company:</strong> {selectedProject.companyName}</div>
                <div><strong>Phone:</strong> {selectedProject.phone || '-'}</div>
                <div><strong>Email:</strong> {selectedProject.email || '-'}</div>
                <div><strong>GSTIN:</strong> {selectedProject.gstin || '-'}</div>
                <div><strong>Target Delivery:</strong> {selectedProject.targetDeliveryDate || '-'}</div>
                <div style={{ gridColumn: 'span 2' }}><strong>Address:</strong> {selectedProject.address}</div>
              </div>

              <strong style={{ fontSize: '14px', color: '#0f172a' }}>Component Specifications:</strong>
              <div style={{ marginTop: '8px', border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden' }}>
                <table className="history-table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>SL.No</th>
                      <th>Item Name</th>
                      <th>Drawing No.</th>
                      <th>Material Spec</th>
                      <th>Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedProject.items?.map((it, idx) => (
                      <tr key={idx}>
                        <td>{idx + 1}</td>
                        <td><strong>{it.itemName}</strong></td>
                        <td>
                          <span style={{ color: '#2563eb', fontWeight: 'bold' }}>{it.drawingNo || '-'}</span>
                          {it.drawingFileName && (
                            <div style={{ marginTop: '4px' }}>
                              <button
                                type="button"
                                onClick={() => handlePreviewDrawing(it.drawingDataUrl, it.drawingFileName, selectedProject.projectId, it.drawingNo)}
                                title={`View ${it.drawingFileName || 'Drawing'}`}
                                style={{
                                  fontSize: '10.5px',
                                  color: '#0369a1',
                                  background: '#e0f2fe',
                                  padding: '2px 7px',
                                  borderRadius: '4px',
                                  border: '1px solid #bae6fd',
                                  fontWeight: 'bold',
                                  cursor: 'pointer'
                                }}
                              >
                                <FileText size={14} aria-hidden="true" /> Open PDF
                              </button>
                            </div>
                          )}
                        </td>
                        <td style={{ maxWidth: '240px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{it.materialSpec || '-'}</td>
                        <td><strong>{it.quantity} {it.unit}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedProject.engineeringNotes && (
                <div style={{ marginTop: '14px', background: '#fefce8', border: '1px solid #fef08a', padding: '10px', borderRadius: '6px', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                  <strong>Engineering & Feasibility Notes:</strong>
                  <div style={{ color: '#713f12', marginTop: '4px' }}>{selectedProject.engineeringNotes}</div>
                </div>
              )}
            </div>

            <div className="template-modal-actions">
              <button className="button-secondary" onClick={() => setSelectedProject(null)}>Close</button>
              <button
                className="button-secondary"
                style={{ color: '#0369a1', borderColor: '#bae6fd', background: '#f0f9ff', fontWeight: '600' }}
                onClick={() => {
                  const p = selectedProject;
                  setSelectedProject(null);
                  navigate('/project-request/new', { state: { edit: true, project: p } });
                }}
              >
                <Pencil size={14} aria-hidden="true" /> Edit Enquiry
              </button>
              {!quotedProjectIds.has(String(selectedProject.projectId)) && (
                <button
                  className="button-primary"
                  onClick={() => {
                    const p = selectedProject;
                    setSelectedProject(null);
                    handleCreateQuotation(p);
                  }}
                >
                  Create Quotation Now
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drawing PDF / CAD Preview Modal */}
      {previewDrawing && (
        <div className="template-modal-backdrop no-print" onMouseDown={() => setPreviewDrawing(null)}>
          <div className="template-modal" style={{ maxWidth: '960px', width: '92vw' }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>📐</span>
                  <span>Drawing: {previewDrawing.fileName}</span>
                </h3>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => viewDrawingFile(previewDrawing.dataUrl, previewDrawing.fileName)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px' }}
                >
                  <ExternalLink size={14} aria-hidden="true" /> Open in New Tab
                </button>
                <button
                  type="button"
                  className="template-modal-close"
                  onClick={() => setPreviewDrawing(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ padding: '12px 0 6px', minHeight: '560px' }}>
              {previewDrawing.fileName?.toLowerCase().endsWith('.png') ||
              previewDrawing.fileName?.toLowerCase().endsWith('.jpg') ||
              previewDrawing.fileName?.toLowerCase().endsWith('.jpeg') ? (
                <img
                  src={previewDrawing.dataUrl}
                  alt={previewDrawing.fileName}
                  style={{ maxWidth: '100%', maxHeight: '75vh', margin: '0 auto', display: 'block', objectFit: 'contain' }}
                />
              ) : (
                <iframe
                  src={previewDrawing.blobUrl}
                  title={previewDrawing.fileName}
                  style={{ width: '100%', height: '75vh', border: '1px solid #cbd5e1', borderRadius: '8px' }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectRequestPage;
