import React, { useState, useMemo, useEffect } from 'react';
import { getInventoryItems } from '../utils/storeService.js';
import { listBoms, getBom, createBom, updateBom, deleteBom } from '../services/bomApi.js';
import { getAllProjectsSummary } from '../utils/projectTracker.js';
import { getFinancialYearInfo } from '../utils/financialYear.js';
import { hasPermission } from '../utils/permissions.js';
import { isAdmin } from '../utils/auth.js';
import { getDrawing } from '../utils/drawingStorage.js';
import { viewDrawingFile } from '../utils/fileViewer.js';
import AddableSelect from '../components/AddableSelect.jsx';
import { addCustomUnit, DEFAULT_UNITS, getCustomUnits } from '../utils/addableMasters.js';

/** Opens the authoritative PostgreSQL drawing for a project + drawing number. */
const openDrawingPDF = async (projectId, drawingNumber) => {
  if (!drawingNumber) return false;
  try {
    const dataUrl = await getDrawing(projectId, drawingNumber);
    if (!dataUrl) throw new Error(`No PostgreSQL drawing exists for ${drawingNumber}.`);
    viewDrawingFile(dataUrl, `${drawingNumber}.pdf`);
    return true;
  } catch (err) {
    window.alert(`Drawing could not be verified from PostgreSQL: ${err.message}`);
    return false;
  }
};

const newCreateToken = () => globalThis.crypto?.randomUUID?.() || `bom-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const EMPTY_BOM_LINE = {
  materialId: '',
  materialName: '',
  grade: '',
  spec: '',
  sizeDimensions: '',
  unit: '',
  requiredQty: '',
  purpose: ''
};

const BOMPage = () => {
  const canCreate = hasPermission('material_request.create') || hasPermission('production.view');

  const [boms, setBOMs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setBOMs(await listBoms());
    } catch (err) {
      setError(err.message || 'Could not load BOMs from PostgreSQL.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const refresh = async () => {
    await load();
    setMode('list');
    setSelectedId(null);
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return boms;
    return boms.filter((b) => [b.customerName, b.companyName, b.drawingNumber, b.projectId, b.createdBy].join(' ').toLowerCase().includes(q));
  }, [boms, search]);

  const selected = selectedId ? boms.find((b) => b.id === selectedId) : null;

  const handleCreate = () => {
    setSelectedId(null);
    setMode('create');
  };

  const handleEdit = (bom) => {
    setSelectedId(bom.id);
    setMode('edit');
  };

  const handleView = async (bom) => {
    try {
      const latest = await getBom(bom.bomNumber || bom.id);
      setBOMs((prev) => prev.map((row) => (row.id === latest.id ? latest : row)));
      setSelectedId(latest.id);
      setMode('view');
    } catch (err) {
      setError(err.message || 'Could not open this BOM.');
    }
  };

  const handleDelete = async (bom) => {
    if (!window.confirm(`Delete this item list? This cannot be undone.`)) return;
    const reason = window.prompt('Reason for deleting this BOM:');
    if (reason === null || !reason.trim()) return;
    try {
      setError('');
      await deleteBom(bom.bomNumber || bom.id, Number(bom.version) || 1, reason.trim());
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not delete this BOM.');
    }
  };

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">List of Items</h1>
        </div>
        <div className="header-actions">
          {canCreate && (
            <button type="button" className="button-primary" onClick={handleCreate}>+ Create Item List</button>
          )}
        </div>
      </div>

      {loading && <div className="form-error" style={{ marginBottom: '12px' }}>Loading BOMs from PostgreSQL…</div>}
      {error && <div className="form-error" style={{ marginBottom: '12px' }}>{error}</div>}

      {mode === 'create' || mode === 'edit' ? (
        <BOMForm
          bom={mode === 'edit' ? selected : null}
          onSave={refresh}
          onCancel={() => { setMode('list'); setSelectedId(null); }}
        />
      ) : mode === 'view' && selected ? (
        <BOMDetailView
          bom={selected}
          onViewDrawing={() => openDrawingPDF(selected.projectId, selected.drawingNumber)}
          onBack={() => { setMode('list'); setSelectedId(null); }}
          onEdit={() => setMode('edit')}
          onDelete={() => handleDelete(selected)}
          canCreate={canCreate}
        />
      ) : (
        <>
          <div className="filters-grid" style={{ marginBottom: '16px' }}>
            <input
              type="text"
              className="action-select form-input"
              placeholder="Search by customer, company, drawing, project..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <table className="history-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Company</th>
                <th>Drawing No</th>
                <th>Project</th>
                <th>Materials</th>
                <th>Created By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan="7" className="no-history-row">No item lists yet. Click "+ Create Item List" to link an Enquiry and list the raw materials.</td>
                </tr>
              ) : (
                filtered.map((bom) => (
                  <tr key={bom.id}>
                    <td>{bom.customerName || '—'}</td>
                    <td>{bom.companyName || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <strong>{bom.drawingNumber || '—'}</strong>
                        {bom.drawingNumber && (
                          <button
                            type="button"
                            className="button-small button-secondary"
                            title="View drawing PDF"
                            onClick={() => openDrawingPDF(bom.projectId, bom.drawingNumber)}
                          >
                            View PDF
                          </button>
                        )}
                      </div>
                    </td>
                    <td>{bom.projectId || '—'}</td>
                    <td><span style={{ background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 700 }}>{bom.items.length} material(s)</span></td>
                    <td>{bom.createdBy}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button type="button" className="button-secondary button-small" onClick={() => handleView(bom)}>View</button>
                        {canCreate && (
                          <>
                            <button type="button" className="button-secondary button-small" onClick={() => handleEdit(bom)}>Edit</button>
                            {isAdmin() && <button type="button" className="button-secondary button-small" onClick={() => handleDelete(bom)} style={{ color: '#dc2626' }}>Delete</button>}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
};

const BOMForm = ({ bom, onSave, onCancel }) => {
  const inventory = getInventoryItems();
  const allProjects = useMemo(() => {
    const fy = getFinancialYearInfo();
    const fyPrefix = `PE-${fy.fyCompact}-`;
    return getAllProjectsSummary().filter((p) => p.projectId && p.projectId.startsWith(fyPrefix));
  }, []);

  const [projectId, setProjectId] = useState(bom?.projectId || '');
  const [customerName, setCustomerName] = useState(bom?.customerName || '');
  const [companyName, setCompanyName] = useState(bom?.companyName || '');
  const [drawingNumber, setDrawingNumber] = useState(bom?.drawingNumber || '');
  const [remarks, setRemarks] = useState(bom?.remarks || '');
  const [lines, setLines] = useState(
    bom?.items?.length > 0
      ? bom.items.map((it) => ({ ...it, requiredQty: it.requiredQty || '' }))
      : [{ ...EMPTY_BOM_LINE }]
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [customUnits, setCustomUnits] = useState(getCustomUnits);

  const selectedProject = useMemo(() => {
    if (!projectId) return null;
    return allProjects.find((p) => p.projectId === projectId) || null;
  }, [projectId, allProjects]);

  const drawings = useMemo(() => {
    if (!selectedProject) return [];
    return (selectedProject.items || []).filter((it) => it.drawingNo);
  }, [selectedProject]);

  useEffect(() => {
    if (selectedProject && !bom) {
      setCustomerName(selectedProject.customerName || '');
      setCompanyName(selectedProject.companyName || '');
      setDrawingNumber('');
    }
  }, [selectedProject, bom]);

  const addLine = () => setLines((prev) => [...prev, { ...EMPTY_BOM_LINE }]);
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const updateLine = (idx, field, val) => {
    setLines((prev) => prev.map((ln, i) => (i === idx ? { ...ln, [field]: val } : ln)));
  };

  const handleMaterialSelect = (idx, itemCode) => {
    const item = inventory.find((i) => i.itemCode === itemCode);
    setLines((prev) => prev.map((ln, i) => {
      if (i !== idx) return ln;
      return { ...ln, materialId: itemCode, materialName: item?.itemName || '', unit: item?.unit || '' };
    }));
  };

  const handleUnitChange = (idx, val) => {
    updateLine(idx, 'unit', val);
  };

  const handleCreateUnit = ({ name, symbol }) => {
    const created = addCustomUnit({ name, symbol });
    setCustomUnits(getCustomUnits());
    return created;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    if (!projectId) { setError('Please select an Enquiry (Project).'); return; }
    if (!drawingNumber) { setError('Please select a Drawing Number.'); return; }
    const ready = lines.filter((l) => l.materialId);
    if (ready.length === 0) { setError('Add at least one material.'); return; }

    setBusy(true);
    try {
      const payload = {
        id: bom?.id || bom?.bomNumber || '',
        bomNumber: bom?.bomNumber || bom?.id || '',
        version: Number(bom?.version || 1) + (bom ? 1 : 0),
        partName: ready[0]?.partName || drawingNumber,
        partCode: drawingNumber,
        projectId,
        customerName,
        companyName,
        drawingNumber,
        effectiveDate: new Date().toISOString().slice(0, 10),
        remarks,
        items: ready
      };
      if (bom) {
        await updateBom(bom.bomNumber || bom.id, Number(bom.version) || 1, payload);
      } else {
        await createBom(payload, newCreateToken());
      }
      await onSave();
    } catch (err) {
      setError(err.message || 'Could not save this BOM.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="quotation-form" onSubmit={handleSave}>
      {error && <div className="form-error" style={{ marginBottom: '12px' }}>{error}</div>}

      <div className="content-block" style={{ marginBottom: '16px' }}>
        <div className="block-header">
          <h3 className="block-title">Select Enquiry</h3>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <label>Project / Enquiry *</label>
            <select className="action-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— Select Enquiry —</option>
              {allProjects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectId} — {p.companyName || p.customerName || 'Unknown'}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label>Customer Name</label>
            <input type="text" className="action-select form-input" value={customerName} readOnly style={{ background: '#f1f5f9' }} />
          </div>
          <div className="form-field">
            <label>Company</label>
            <input type="text" className="action-select form-input" value={companyName} readOnly style={{ background: '#f1f5f9' }} />
          </div>
          <div className="form-field">
            <label>Drawing Number *</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <select className="action-select" style={{ flex: 1 }} value={drawingNumber} onChange={(e) => setDrawingNumber(e.target.value)}>
                <option value="">— Select Drawing —</option>
                {drawings.map((d) => (
                  <option key={d.drawingNo} value={d.drawingNo}>
                    {d.drawingNo} — {d.itemName || 'Untitled'}
                  </option>
                ))}
              </select>
              {drawingNumber && (
                <button
                  type="button"
                  className="button-secondary button-small"
                  style={{ whiteSpace: 'nowrap' }}
                  title="View drawing PDF"
                  onClick={() => openDrawingPDF(projectId, drawingNumber)}
                >
                  View PDF
                </button>
              )}
            </div>
            {projectId && drawings.length === 0 && (
              <div className="muted-text" style={{ color: '#dc2626' }}>No drawings found for this enquiry.</div>
            )}
          </div>
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Materials Required</h3>
          <button type="button" className="button-secondary button-small" onClick={addLine}>+ Add Material</button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="item-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>SL.No</th>
                <th style={{ minWidth: '200px' }}>Material *</th>
                <th style={{ width: '90px' }}>Qty *</th>
                <th style={{ width: '80px' }}>Unit</th>
                <th style={{ width: '120px' }}>Grade / Spec</th>
                <th style={{ width: '130px' }}>Size</th>
                <th style={{ minWidth: '120px' }}>Purpose</th>
                {lines.length > 1 && <th style={{ width: '80px' }}></th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((ln, idx) => (
                <tr key={idx}>
                  <td style={{ textAlign: 'center', color: '#94a3b8', fontWeight: 600 }}>{idx + 1}</td>
                  <td>
                    <select className="action-select" value={ln.materialId} onChange={(e) => handleMaterialSelect(idx, e.target.value)} style={{ width: '100%' }}>
                      <option value="">— Select from Inventory —</option>
                      {inventory.map((i) => (
                        <option key={i.itemCode} value={i.itemCode}>{i.itemName}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="number" min="0" step="any" className="action-select form-input" value={ln.requiredQty} onChange={(e) => updateLine(idx, 'requiredQty', e.target.value)} />
                  </td>
                  <td>
                    <AddableSelect value={ln.unit} onChange={(event) => handleUnitChange(idx, event.target.value)} options={[{ value: '', label: 'Unit' }, ...DEFAULT_UNITS, ...customUnits]} onCreate={handleCreateUnit} masterType="unit" title="Add Unit of Measurement" addLabel="+ Add New Unit" selectStyle={{ width: '100%' }} />
                  </td>
                  <td>
                    <input type="text" className="action-select form-input" value={ln.grade} onChange={(e) => updateLine(idx, 'grade', e.target.value)} placeholder="e.g. EN8" />
                  </td>
                  <td>
                    <input type="text" className="action-select form-input" value={ln.sizeDimensions} onChange={(e) => updateLine(idx, 'sizeDimensions', e.target.value)} placeholder="e.g. 50mm dia" />
                  </td>
                  <td>
                    <input type="text" className="action-select form-input" value={ln.purpose} onChange={(e) => updateLine(idx, 'purpose', e.target.value)} placeholder="e.g. Main body" />
                  </td>
                  {lines.length > 1 && (
                    <td>
                      <button type="button" className="button-secondary button-small" onClick={() => removeLine(idx)} style={{ color: '#dc2626', padding: '4px 8px' }}>Remove</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: '8px' }}>
          <label className="form-field" style={{ margin: 0 }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#334155' }}>Remarks</span>
            <textarea
              className="action-select form-input"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
              style={{ resize: 'vertical', minHeight: '60px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word' }}
            />
          </label>
        </div>
      </div>

      <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
        <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Saving...' : bom ? 'Update Item List' : 'Create Item List'}</button>
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
};

const BOMDetailView = ({ bom, onBack, onEdit, onDelete, canCreate, onViewDrawing }) => (
  <div className="content-block" style={{ marginTop: '16px' }}>
    <div className="block-header">
      <div>
        <h3 className="block-title">Item List Details</h3>
        <div className="muted-text" style={{ fontSize: '13px' }}>
          {bom.customerName && <span>{bom.customerName}</span>}
          {bom.companyName && <span> · {bom.companyName}</span>}
          {bom.drawingNumber && <span> · Drawing: <strong>{bom.drawingNumber}</strong></span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        {canCreate && <button type="button" className="button-secondary" onClick={onEdit}>Edit</button>}
        {isAdmin() && <button type="button" className="button-secondary" onClick={onDelete} style={{ color: '#dc2626' }}>Delete</button>}
        <button type="button" className="button-secondary" onClick={onBack}>&larr; Back</button>
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px' }}>
      <div>
        <div style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}>BOM Version</div>
        <div style={{ fontSize: '13px', fontWeight: '600' }}>{bom.bomNumber || bom.id} · v{bom.version || 1}</div>
      </div>
      <div>
        <div style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}>Customer</div>
        <div style={{ fontSize: '13px', fontWeight: '600' }}>{bom.customerName || '—'}</div>
      </div>
      <div>
        <div style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}>Company</div>
        <div style={{ fontSize: '13px', fontWeight: '600' }}>{bom.companyName || '—'}</div>
      </div>
      <div>
        <div style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '2px' }}>Drawing</div>
        <div style={{ fontSize: '13px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {bom.drawingNumber || '—'}
          {bom.drawingNumber && onViewDrawing && (
            <button type="button" className="button-small button-secondary" title="View drawing PDF" onClick={onViewDrawing}>
              View PDF
            </button>
          )}
        </div>
      </div>
    </div>

    {bom.remarks && <p className="muted-text" style={{ marginBottom: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>Remarks: {bom.remarks}</p>}

    <table className="history-table">
      <thead>
        <tr>
          <th>SL.No</th>
          <th>Material</th>
          <th>Grade</th>
          <th>Size</th>
          <th>Qty</th>
          <th>Unit</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        {bom.items.map((it, idx) => (
          <tr key={idx}>
            <td>{idx + 1}</td>
            <td><strong>{it.materialName || it.materialId}</strong></td>
            <td>{it.grade || '—'}</td>
            <td>{it.sizeDimensions || '—'}</td>
            <td>{it.requiredQty}</td>
            <td>{it.unit}</td>
            <td>{it.purpose || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>

    <div style={{ marginTop: '12px', fontSize: '12px', color: '#6b7280' }}>
      Created by {bom.createdBy} on {new Date(bom.createdAt).toLocaleDateString()}
    </div>
  </div>
);

export default BOMPage;

