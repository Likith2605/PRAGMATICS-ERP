import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Eye, ExternalLink, FileText, Pencil } from 'lucide-react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { getBlobUrlFromDataUrl } from '../utils/fileViewer';
import { isAdmin } from '../utils/auth.js';
import FileChecksumReviewPanel from '../components/FileChecksumReviewPanel.jsx';
import { getDrawing, getDrawingFileId, deleteAllDrawings, findEmbeddedLegacyDrawing, migrateLegacyDrawing, migrateLegacyEmbeddedDrawing, previewLegacyDrawings } from '../utils/drawingStorage.js';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterProjectRequests } from '../utils/historySearch.js';
import { deleteEnquiry, getEnquiry, getEnquiryMigrationPreview, importMissingEnquiries, listEnquiries, updateEnquiry } from '../services/enquiryApi.js';

const ProjectRequestPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useParams();
  const [projects, setProjects] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedProject, setSelectedProject] = useState(null);
  const [previewDrawing, setPreviewDrawing] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [migration, setMigration] = useState({ missing: [], conflicts: [], deleted: [], existing: [] });
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [drawingMigrationStatus, setDrawingMigrationStatus] = useState({});
  const [legacyDrawingSources, setLegacyDrawingSources] = useState([]);
  const [tombstonedEnquiryIds, setTombstonedEnquiryIds] = useState(() => new Set());
  const persistDrawingReference = async (project, item, attachment) => {
    const fileId = attachment.fileId || getDrawingFileId(project.projectId, item.drawingNo);
    if (item.drawingFileId === fileId) return project;
    const nextItems = (project.items || []).map((entry) =>
      String(entry.drawingNo || '').trim() === String(item.drawingNo || '').trim()
        ? { ...entry, drawingFileId: fileId, drawingFileName: attachment.fileName || entry.drawingFileName || '' }
        : entry
    );
    const { projectId, version, updatedAt, ...data } = project;
    const result = await updateEnquiry(projectId, { ...data, items: nextItems }, version);
    setProjects((current) => current.map((entry) => entry.projectId === projectId ? result.record : entry));
    setSelectedProject(result.record);
    return result.record;
  };

  useEffect(() => {
    const blobUrl = previewDrawing?.blobUrl;
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [previewDrawing?.blobUrl]);

  const inspectOrMigrateLegacyDrawing = async (project, item) => {
    const key = `${project.projectId}:${item.drawingNo}`;
    try {
      const [preview] = await previewLegacyDrawings(project.projectId, [item]);
      setDrawingMigrationStatus((current) => ({ ...current, [key]: preview.status }));
      if (!isAdmin()) {
        window.alert('Administrator access is required to migrate a local-only drawing to PostgreSQL.');
        return;
      }
      if (tombstonedEnquiryIds.has(String(project.projectId))) {
        throw new Error('This enquiry ID is blocked by a deletion tombstone. Resolve the record history before migrating an attachment.');
      }
      const embedded = findEmbeddedLegacyDrawing(legacyDrawingSources, project.projectId, item.drawingNo);
      if (preview.status === 'missing-both' && embedded.status === 'ambiguous') {
        throw new Error('Conflicting browser-local drawing copies were found. No copy was uploaded; resolve the local conflict first.');
      }
      if (preview.status === 'missing-both' && embedded.status === 'missing') {
        window.alert(`No PostgreSQL attachment or browser-local PDF bytes were found for ${item.drawingNo}. Upload the original drawing again.`);
        return;
      }
      let result = preview;
      if (preview.status === 'legacy-local-only') {
        if (!window.confirm(`A local-only drawing copy was found for ${item.drawingNo}. Copy its actual bytes to PostgreSQL without replacing any server copy? The local copy will be retained.`)) return;
        result = await migrateLegacyDrawing(project.projectId, item.drawingNo, item.drawingFileName);
      } else if (preview.status === 'missing-both' && embedded.status === 'available') {
        if (!window.confirm(`An embedded browser-local drawing copy was found for ${item.drawingNo}. Copy its actual bytes to PostgreSQL without replacing any server copy? The local copy will be retained.`)) return;
        result = await migrateLegacyEmbeddedDrawing(project.projectId, item.drawingNo, embedded.dataUrl, embedded.fileName || item.drawingFileName);
      }
      if (!result.fileId || !result.checksumSha256 || !result.sizeBytes) {
        throw new Error('The PostgreSQL drawing bytes could not be verified; the enquiry reference was not changed.');
      }
      await persistDrawingReference(project, item, result);
      setDrawingMigrationStatus((current) => ({ ...current, [key]: `${result.status}; PostgreSQL attachment linked (SHA-256 ${result.checksumSha256})` }));
    } catch (error) {
      setDrawingMigrationStatus((current) => ({ ...current, [key]: `failed: ${error.message}` }));
      window.alert(`Drawing migration was not confirmed: ${error.message}`);
    }
  };

  const recoverEmbeddedLegacyDrawing = async (project, item) => {
    if (!isAdmin() || !item.drawingDataUrl || !item.drawingNo) return;
    if (!window.confirm(`Recover embedded legacy drawing ${item.drawingNo} to PostgreSQL? An existing server attachment will not be overwritten, and this Enquiry/local copy will remain unchanged.`)) return;
    try {
      const result = await migrateLegacyEmbeddedDrawing(project.projectId, item.drawingNo, item.drawingDataUrl, item.drawingFileName);
      if (!result.fileId || !result.checksumSha256 || !result.sizeBytes) throw new Error('The PostgreSQL drawing bytes could not be verified; the enquiry reference was not changed.');
      await persistDrawingReference(project, item, result);
      window.alert(`Drawing recovery result: ${result.status}; linked and verified (${result.checksumSha256}).`);
    } catch (error) { window.alert(`Legacy drawing recovery failed: ${error.message}`); }
  };

  const handlePreviewDrawing = async (item, projectId) => {
    let url;
    try {
      url = await getDrawing(projectId, item.drawingNo, item.drawingFileId);
      if (!url) throw new Error(`No PostgreSQL attachment exists for ${item.drawingNo || 'this drawing'}.`);
    } catch (error) {
      window.alert(`Drawing could not be verified from PostgreSQL: ${error.message}`);
      return;
    }
    const blobUrl = getBlobUrlFromDataUrl(url);
    setPreviewDrawing({ fileName: item.drawingFileName || 'drawing.pdf', dataUrl: url, blobUrl });
  };

  useEffect(() => {
    let requestSequence = 0;
    let disposed = false;
    const loadProjects = async () => {
      const sequence = ++requestSequence;
      try {
        setLoadError('');
        const preview = await getEnquiryMigrationPreview();
        if (disposed || sequence !== requestSequence) return;
        const authoritative = Array.isArray(preview.records) ? preview.records : [];
        setProjects(authoritative);
        const serverById = new Map(authoritative.map((record) => [String(record.projectId), record]));
        const candidates = new Map();
        const conflicts = new Set((preview.conflicts || []).map((item) => String(item.id)));
        const existing = new Set();
        const deletedMatches = new Set();
        const deleted = new Set((preview.deleted || []).map((item) => String(item.record_id)));
        setTombstonedEnquiryIds(deleted);
        const local = (() => { try { return JSON.parse(localStorage.getItem('projectRequests') || '[]'); } catch { return []; } })();
        const archived = (() => { try { return JSON.parse(localStorage.getItem('projectRequests_localConflictArchive') || '[]').map((entry) => entry.record).filter(Boolean); } catch { return []; } })();
        const legacySources = [...(preview.legacyRecords || []), ...(Array.isArray(local) ? local : []), ...(Array.isArray(archived) ? archived : [])];
        setLegacyDrawingSources(legacySources);
        for (const record of legacySources) {
          const id = String(record?.projectId || record?.id || '').trim();
          if (!id) continue;
          if (deleted.has(id)) {
            deletedMatches.add(id);
            continue;
          }
          const serverRecord = serverById.get(id);
          if (serverRecord) {
            const legacy = { ...record }; delete legacy.version; delete legacy.updatedAt;
            const current = { ...serverRecord }; delete current.version; delete current.updatedAt;
            if (JSON.stringify(legacy) !== JSON.stringify(current)) conflicts.add(id);
            else existing.add(id);
            continue;
          }
          if (!candidates.has(id)) candidates.set(id, record);
          else if (JSON.stringify(candidates.get(id)) !== JSON.stringify(record)) conflicts.add(id);
        }
        for (const id of conflicts) candidates.delete(id);
        setMigration({
          missing: [...candidates.values()],
          existing: [...existing],
          conflicts: [...conflicts],
          deleted: (preview.deleted || []).filter((item) => deletedMatches.has(String(item.record_id)))
        });
      } catch (error) {
        if (disposed || sequence !== requestSequence) return;
        console.error('Unable to load enquiries from PostgreSQL', error);
        setLoadError(error.message || 'Unable to load enquiries from PostgreSQL.');
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
    const refreshTimer = window.setInterval(loadProjects, 10000);
    return () => {
      disposed = true;
      window.removeEventListener('erp-state-hydrated', loadProjects);
      window.removeEventListener('erp-state-change', onERPStateChange);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', loadProjects);
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    if (!routeProjectId) {
      setSelectedProject(null);
      setDetailError('');
      setDetailLoading(false);
      return undefined;
    }
    let active = true;
    setSelectedProject(null);
    setDetailError('');
    setDetailLoading(true);
    getEnquiry(routeProjectId)
      .then((record) => { if (active) setSelectedProject(record); })
      .catch((error) => {
        if (!active) return;
        const setError = () => setDetailError(error.status === 404
          ? `Enquiry '${routeProjectId}' was not found in PostgreSQL.`
          : `Unable to load enquiry '${routeProjectId}' from PostgreSQL: ${error.message}`);
        if (error.status !== 404) {
          setError();
          return;
        }
        getEnquiryMigrationPreview()
          .then((preview) => {
            if (!active) return;
            setProjects(Array.isArray(preview.records) ? preview.records : []);
            setTombstonedEnquiryIds(new Set((preview.deleted || []).map((item) => String(item.record_id))));
            setError();
          })
          .catch((refreshError) => {
            if (!active) return;
            setLoadError(`The enquiry lookup returned not found, and the PostgreSQL list could not be refreshed: ${refreshError.message}`);
            setError();
          });
      })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [routeProjectId]);

  const closeDetails = () => {
    setSelectedProject(null);
    if (routeProjectId) navigate('/project-request', { replace: true });
  };

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
    const project = projects.find((entry) => entry.projectId === id);
    if (!project) return;
    const reason = window.prompt(`Reason for deleting enquiry ${id}:`)?.trim();
    if (!reason) return;
    try {
      await deleteEnquiry(id, project.version, reason);
      const updated = await listEnquiries();
      setProjects(updated);
    } catch (error) {
      window.alert(error.message || 'Enquiry deletion failed.');
      return;
    }
    try {
      if (project.items) await deleteAllDrawings(id, project.items);
    } catch (error) {
      window.alert(`Enquiry ${id} was deleted in PostgreSQL, but drawing cleanup failed: ${error.message}`);
    }
  };

  const importMissing = async () => {
    if (!migration.missing.length || migrationBusy) return;
    setMigrationBusy(true);
    try {
      const result = await importMissingEnquiries(migration.missing);
      const authoritative = await listEnquiries();
      setProjects(authoritative);
      const remainingConflicts = [...new Set([...migration.conflicts, ...(result.conflicts || []).map((item) => item.id)])];
      setMigration({ missing: [], existing: [...migration.existing, ...(result.alreadyPresent || [])], conflicts: remainingConflicts, deleted: result.deleted || migration.deleted || [] });
      window.alert(`Imported ${result.imported.length}; already existing ${result.alreadyPresent?.length || 0}; conflicts ${result.conflicts?.length || 0}; tombstone-blocked ${result.deleted?.length || 0}.`);
    } catch (error) {
      window.alert(error.message || 'Enquiry migration failed.');
    } finally {
      setMigrationBusy(false);
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
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
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

        {loadError && <div className="form-error" role="alert">PostgreSQL enquiry load failed: {loadError}</div>}
        {routeProjectId && detailLoading && <div className="empty-state" role="status">Loading enquiry details from PostgreSQL…</div>}
        {routeProjectId && detailError && (
          <div className="empty-state" role="alert">
            <h3>Enquiry details unavailable</h3>
            <p>{detailError}</p>
            <button type="button" className="button-secondary" onClick={closeDetails}>Back to enquiries</button>
          </div>
        )}

        {(migration.missing.length > 0 || migration.conflicts.length > 0 || migration.deleted?.length > 0) && (
          <section className="content-block" aria-label="Enquiry migration preview" style={{ marginTop: 16, border: '1px solid #f59e0b' }}>
            <h3>Existing browser enquiries need review</h3>
            <p>
              PostgreSQL has {projects.length} active records. Preview: {migration.missing.length} eligible new, {migration.existing.length} already existing, {migration.conflicts.length} conflicts, {(migration.deleted || []).length} previously deleted and blocked. Existing database records remain unchanged.
            </p>
            {migration.missing.length > 0 && (
              <details>
                <summary>Preview missing records ({migration.missing.length})</summary>
                <ul>{migration.missing.slice(0, 30).map((record) => <li key={record.projectId}>{record.projectId} — {record.companyName || record.customerName || 'Customer not set'}</li>)}</ul>
                {migration.missing.length > 30 && <p>Showing first 30. All {migration.missing.length} will be included.</p>}
              </details>
            )}
            {migration.conflicts.length > 0 && <p>Conflicting IDs retained without import: {migration.conflicts.slice(0, 20).join(', ')}{migration.conflicts.length > 20 ? '…' : ''}</p>}
            {isAdmin() ? <button className="button-secondary" type="button" disabled={migrationBusy || !migration.missing.length} onClick={importMissing}>
              {migrationBusy ? 'Importing…' : `Import ${migration.missing.length} eligible record(s)`}
            </button> : <p>Only an Administrator can approve legacy record import.</p>}
          </section>
        )}

        {loadError ? (
          <div className="empty-state"><h3>Enquiries could not be loaded</h3><p>Reconnect to the ERP server and refresh. Cached records are not shown as authoritative.</p></div>
        ) : projects.length === 0 ? (
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
                            {(firstItem.drawingFileName || firstItem.drawingFileId) && (
                              <button
                                  type="button"
                                  onClick={() => handlePreviewDrawing(firstItem, project.projectId)}
                                  title={`View Drawing: ${firstItem.drawingFileName || 'Drawing'}`}
                                  style={{ fontSize: '10px', background: '#e0f2fe', color: '#0369a1', padding: '1px 6px', borderRadius: '4px', border: '1px solid #bae6fd', fontWeight: 'bold', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                                >
                                  PDF <Eye size={14} aria-hidden="true" />
                              </button>
                            )}
                            {isAdmin() && <button type="button" className="button-small" onClick={() => inspectOrMigrateLegacyDrawing(project, firstItem)}>Check/migrate local copy</button>}
                            {isAdmin() && firstItem.drawingDataUrl && <button type="button" className="button-small" onClick={() => recoverEmbeddedLegacyDrawing(project, firstItem)}>Recover embedded legacy copy</button>}
                            {drawingMigrationStatus[`${project.projectId}:${firstItem.drawingNo}`] && <small>{drawingMigrationStatus[`${project.projectId}:${firstItem.drawingNo}`]}</small>}
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
                            onClick={() => navigate(`/project-request/${encodeURIComponent(project.projectId)}`)}
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

      <FileChecksumReviewPanel />

      {/* Project Details Modal */}
      {selectedProject && (
        <div className="template-modal-backdrop no-print" onMouseDown={closeDetails}>
          <div className="template-modal" style={{ maxWidth: '650px' }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-header">
              <div>
                <h3>Project Request Details ({selectedProject.projectId})</h3>
                <p>{selectedProject.companyName}</p>
              </div>
              <button type="button" className="template-modal-close" onClick={closeDetails}>×</button>
            </div>

            <div style={{ padding: '16px 0', fontSize: '13px', lineHeight: '1.6' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px', background: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
                <div><strong>Customer:</strong> {selectedProject.customerName}</div>
                <div><strong>Company:</strong> {selectedProject.companyName}</div>
                <div><strong>Phone:</strong> {selectedProject.phone || '-'}</div>
                <div><strong>Email:</strong> {selectedProject.email || '-'}</div>
                <div><strong>GSTIN:</strong> {selectedProject.gstin || '-'}</div>
                <div><strong>Requested Date:</strong> {selectedProject.requestedDate || '-'}</div>
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
                          <div style={{ marginTop: '3px', color: '#475569' }}>
                            <strong>PDF:</strong> {it.drawingFileName || (it.drawingFileId ? 'Stored drawing attachment' : 'No attachment')}
                          </div>
                          {it.drawingNo && (
                            <div style={{ marginTop: '4px' }}>
                              {(it.drawingFileName || it.drawingFileId) && <button
                                type="button"
                                onClick={() => handlePreviewDrawing(it, selectedProject.projectId)}
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
                              </button>}
                              {isAdmin() && <button type="button" className="button-small" style={{ marginLeft: 6 }} onClick={() => inspectOrMigrateLegacyDrawing(selectedProject, it)}>
                                Check/migrate local copy
                              </button>}
                              {isAdmin() && it.drawingDataUrl && <button type="button" className="button-small" style={{ marginLeft: 6 }} onClick={() => recoverEmbeddedLegacyDrawing(selectedProject, it)}>
                                Recover embedded legacy copy
                              </button>}
                              {drawingMigrationStatus[`${selectedProject.projectId}:${it.drawingNo}`] && <small style={{ display: 'block' }}>{drawingMigrationStatus[`${selectedProject.projectId}:${it.drawingNo}`]}</small>}
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
              <button className="button-secondary" onClick={closeDetails}>Close</button>
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
                <a
                  href={previewDrawing.blobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="button-secondary"
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px' }}
                >
                  <ExternalLink size={14} aria-hidden="true" /> Open in New Tab
                </a>
                <a
                  className="button-secondary"
                  href={previewDrawing.blobUrl}
                  download={previewDrawing.fileName}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px', textDecoration: 'none' }}
                >
                  Download
                </a>
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
