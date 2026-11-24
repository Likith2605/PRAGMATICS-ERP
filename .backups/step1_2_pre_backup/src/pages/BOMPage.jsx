import React, { useState, useMemo, useEffect } from 'react';
import { getBOMs, createBOM, updateBOM, deleteBOM, getInventoryItems } from '../utils/storeService.js';
import { getAllProjectsSummary } from '../utils/projectTracker.js';
import { getFinancialYearInfo } from '../utils/financialYear.js';
import { hasPermission } from '../utils/permissions.js';
import { getDrawing } from '../utils/drawingStorage.js';
import { viewDrawingFile } from '../utils/fileViewer.js';

/** Opens the drawing PDF stored for a project + drawing number (IndexedDB, with project fallback). */
const openDrawingPDF = async (projectId, drawingNumber) => {
  if (!drawingNumber) return false;
  let dataUrl = '';
  try {
    dataUrl = (await getDrawing(projectId, drawingNumber)) || '';
  } catch (err) {
    console.error('Drawing lookup failed', err);
  }
  if (!dataUrl) {
    try {
      const projects = JSON.parse(localStorage.getItem('projectRequests') || '[]');
      const project = projects.find((p) => String(p.projectId) === String(projectId));
      const item = (project?.items || []).find((i) => String(i.drawingNo) === String(drawingNumber));
      dataUrl = item?.drawingDataUrl || '';
    } catch (err) {
      console.error('Drawing fallback lookup failed', err);
    }
  }
  if (!dataUrl) {
    window.alert(`No drawing PDF found for ${drawingNumber}. Upload it from the Enquiry / Project Request screen.`);
    return false;
  }
  viewDrawingFile(dataUrl, `${drawingNumber}.pdf`);
  return true;
};

const DEFAULT_UNITS = [
  'Nos', 'Set', 'Pair', 'Kit', 'Assembly', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Bundle'
];

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

  const [boms, setBOMs] = useState(() => getBOMs());
  const [mode, setMode] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = () => {
    setBOMs(getBOMs());
    setRefreshTick((t) => t + 1);
    setMode('list');
    setSelectedId(null);
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const list = getBOMs();
    if (!q) return list;
    return list.filter((b) => [b.customerName, b.companyName, b.drawingNumber, b.projectId, b.createdBy].join(' ').toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boms, search, refreshTick]);

  const selected = selectedId ? boms.find((b) => b.id === selectedId) : null;

  const handleCreate = () => {
    setSelectedId(null);
    setMode('create');
  };

  const handleEdit = (bom) => {
    setSelectedId(bom.id);
    setMode('edit');
  };

  const handleView = (bom) => {
    setSelectedId(bom.id);
    setMode('view');
  };

  const handleDelete = (bom) => {
    if (!window.confirm(`Delete this item list? This cannot be undone.`)) return;
    try {
      deleteBOM(bom.id);
      refresh();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Production & QC</div>
          <h1 className="page-title">List of Items</h1>
          <p className="page-description">
            List the raw materials required for a specific project / drawing. Materials auto-populate in Material Requests.
          </p>
        </div>
        <div className="header-actions">
          {canCreate && (
            <button type="button" className="button-primary" onClick={handleCreate}>+ Create Item List</button>
          )}
        </div>
      </div>

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
                            <button type="button" className="button-secondary button-small" onClick={() => handleDelete(bom)} style={{ color: '#dc2626' }}>Delete</button>
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
  const [customUnits, setCustomUnits] = useState(() => {
    try {
      const stored = localStorage.getItem('customUnits');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

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
    if (val === 'ADD_NEW') {
      const newUnit = window.prompt('Enter new unit symbol:');
      if (newUnit && newUnit.trim()) {
        const symbol = newUnit.trim();
        if (!DEFAULT_UNITS.includes(symbol) && !customUnits.includes(symbol)) {
          const updated = [...customUnits, symbol];
          setCustomUnits(updated);
          localStorage.setItem('customUnits', JSON.stringify(updated));
        }
        updateLine(idx, 'unit', symbol);
      }
      return;
    }
    updateLine(idx, 'unit', val);
  };

  const handleSave = (e) => {
    e.preventDefault();
    setError('');
    if (!projectId) { setError('Please select an Enquiry (Project).'); return; }
    if (!drawingNumber) { setError('Please select a Drawing Number.'); return; }
    const ready = lines.filter((l) => l.materialId);
    if (ready.length === 0) { setError('Add at least one material.'); return; }

    try {
      setBusy(true);
      if (bom) {
        updateBOM(bom.id, { projectId, customerName, companyName, drawingNumber, remarks, items: ready });
      } else {
        createBOM({ projectId, customerName, companyName, drawingNumber, remarks, items: ready });
      }
      setBusy(false);
      onSave();
    } catch (err) {
      setBusy(false);
      setError(err.message);
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
                    <select className="action-select" value={ln.unit} onChange={(e) => handleUnitChange(idx, e.target.value)} style={{ width: '100%' }}>
                      <option value="">— Unit —</option>
                      {DEFAULT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      {customUnits.map((u) => <option key={u} value={u}>{u}</option>)}
                      <option value="ADD_NEW">+ Add New Unit</option>
                    </select>
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
        {canCreate && <button type="button" className="button-secondary" onClick={onDelete} style={{ color: '#dc2626' }}>Delete</button>}
        <button type="button" className="button-secondary" onClick={onBack}>&larr; Back</button>
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px', padding: '12px', background: '#f8fafc', borderRadius: '8px' }}>
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
