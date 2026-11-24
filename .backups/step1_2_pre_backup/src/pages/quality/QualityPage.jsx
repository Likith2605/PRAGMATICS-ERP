import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, X, Plus, Trash2, Play, CheckCircle2, XCircle, Clock,
  Package, Ruler, Wrench, ClipboardCheck, Send, Loader2, ChevronRight,
  ArrowLeft, FileText, Pencil
} from 'lucide-react';
import * as qa from '../../services/qualityApi';
import api from '../../services/ballooningApi';

/* ================================================================== */
/* Theme — mirrors QualityApp/src/theme.ts                             */
/* ================================================================== */
const C = {
  primary: '#1d4ed8',
  primaryDark: '#1e3a8a',
  background: '#f1f5f9',
  surface: '#ffffff',
  border: '#e2e8f0',
  text: '#0f172a',
  textMuted: '#64748b',
  success: '#16a34a',
  successBg: '#dcfce7',
  danger: '#dc2626',
  dangerBg: '#fee2e2',
  warning: '#d97706',
  warningBg: '#fef3c7',
};

const SAMPLE_COUNT = 5;
const MAX_SAMPLES = 10;

const fmt = (n) => (n == null || isNaN(n) ? '-' : Number(n).toFixed(3).replace(/\.?0+$/, '') || '0');
const toleranceText = (up, low) => {
  const u = Number(up) || 0;
  const l = Number(low) || 0;
  if (u === 0 && l === 0) return '±0';
  if (u === l) return `±${Math.abs(u)}`;
  return `${u > 0 ? '+' + u : u} / ${l > 0 ? '+' + l : l}`;
};
const isInTolerance = (val, nominal, tolUpper, tolLower) => {
  const v = Number(val);
  return v >= (Number(nominal) + Number(tolLower)) && v <= (Number(nominal) + Number(tolUpper));
};

/* ================================================================== */
/* Shared UI components (web versions of QualityApp ui.tsx)            */
/* ================================================================== */

function Card({ children, onClick, style }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        backgroundColor: C.surface,
        borderRadius: 12,
        padding: 14,
        margin: '6px 16px',
        border: `1px solid ${C.border}`,
        boxShadow: hover ? '0 2px 8px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.04)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.15s',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: '18px 16px 8px' }}>
      {children}
    </div>
  );
}

function Badge({ text, tone }) {
  const bg = tone === 'success' ? C.successBg : tone === 'danger' ? C.dangerBg : C.warningBg;
  const fg = tone === 'success' ? C.success : tone === 'danger' ? C.danger : C.warning;
  return (
    <span style={{
      display: 'inline-block',
      borderRadius: 999,
      padding: '3px 10px',
      fontSize: 12,
      fontWeight: 800,
      letterSpacing: 0.5,
      backgroundColor: bg,
      color: fg,
      whiteSpace: 'nowrap',
    }}>
      {text}
    </span>
  );
}

function Btn({ title, onClick, variant = 'primary', disabled, loading, style }) {
  const bg = variant === 'primary' ? C.primary
    : variant === 'success' ? C.success
    : variant === 'danger' ? C.danger
    : variant === 'outline' ? C.surface
    : 'transparent';
  const border = variant === 'outline' ? C.primary : 'transparent';
  const fg = variant === 'outline' || variant === 'ghost' ? C.primary : '#fff';
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        borderRadius: 10,
        padding: '10px 18px',
        fontSize: 14,
        fontWeight: 700,
        backgroundColor: bg,
        borderColor: border,
        borderWidth: 1,
        color: fg,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.5 : 1,
        transition: 'opacity 0.15s',
        ...style,
      }}
    >
      {loading ? '...' : title}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, multiline }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 5 }}>
        {label}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%', border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '10px 12px', fontSize: 15, color: C.text, backgroundColor: C.surface,
            minHeight: 70, resize: 'vertical', fontFamily: 'inherit',
          }}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%', border: `1px solid ${C.border}`, borderRadius: 8,
            padding: '10px 12px', fontSize: 15, color: C.text, backgroundColor: C.surface,
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}

function SearchBar({ value, onChange, placeholder }) {
  return (
    <div style={{ margin: '12px 16px 4px', position: 'relative' }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'Search...'}
        style={{
          width: '100%', border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '10px 36px 10px 12px', fontSize: 15, color: C.text,
          backgroundColor: C.surface, boxSizing: 'border-box',
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          style={{
            position: 'absolute', right: 10, top: 0, bottom: 0,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, fontWeight: 700, color: C.textMuted,
          }}
        >✕</button>
      )}
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 24px', color: C.textMuted, fontSize: 14 }}>
      {message}
    </div>
  );
}

function Select({ label, value, onChange, options, placeholder }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 5 }}>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '10px 12px', fontSize: 15, color: C.text, backgroundColor: C.surface,
          boxSizing: 'border-box',
        }}
      >
        <option value="">{placeholder || 'Select...'}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/* ================================================================== */
/* Sample input with pass/fail coloring                                */
/* ================================================================== */

function SampleInput({ label, value, onChange, dim, readOnly }) {
  const n = value.trim() === '' ? null : Number(value);
  const tone = n === null || isNaN(n) ? 'empty' : isInTolerance(n, dim.nominal, dim.tol_upper, dim.tol_lower) ? 'pass' : 'fail';

  const border = tone === 'pass' ? C.success : tone === 'fail' ? C.danger : C.border;
  const bg = tone === 'pass' ? C.successBg : tone === 'fail' ? C.dangerBg : C.surface;
  const color = tone === 'pass' ? C.success : tone === 'fail' ? C.danger : C.text;

  return (
    <div style={{ flex: 1, margin: '0 3px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder="-"
        style={{
          width: '100%', border: `1.5px solid ${border}`, borderRadius: 8,
          padding: '8px 2px', fontSize: 14, textAlign: 'center',
          color, backgroundColor: bg, fontWeight: tone !== 'empty' ? 700 : 400,
          boxSizing: 'border-box',
        }}
      />
      <div style={{ fontSize: 10, fontWeight: 800, textAlign: 'center', marginTop: 3, minHeight: 12, color: tone === 'pass' ? C.success : tone === 'fail' ? C.danger : 'transparent' }}>
        {tone === 'pass' ? 'OK' : tone === 'fail' ? 'FAIL' : ''}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Main Quality Page                                                   */
/* ================================================================== */

export default function QualityPage() {
  const [view, setView] = useState('home'); // home | check | history | dispatches | instruments
  const [activeCheck, setActiveCheck] = useState(null); // { drawingId, drawing, dims, ... }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: C.background, padding: 16 }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {view === 'home' && <HomeView onNavigate={setView} onOpenCheck={setActiveCheck} />}
        {view === 'check' && activeCheck && (
          <CheckView
            checkData={activeCheck}
            onBack={() => { setView('home'); setActiveCheck(null); }}
          />
        )}
        {view === 'history' && <HistoryView onBack={() => setView('home')} />}
        {view === 'dispatches' && <DispatchView onBack={() => setView('home')} />}
        {view === 'instruments' && <InstrumentsView onBack={() => setView('home')} />}
      </div>
    </div>
  );
}

/* ================================================================== */
/* HOME VIEW — mirrors QCHomeScreen + DesignerHomeScreen               */
/* ================================================================== */

function HomeView({ onNavigate, onOpenCheck }) {
  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [balloonProjects, setBalloonProjects] = useState([]);
  const [importing, setImporting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await qa.listDrawings();
      setDrawings(list);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return drawings;
    const q = search.toLowerCase();
    return drawings.filter(
      (d) =>
        d.drawing_no.toLowerCase().includes(q) ||
        d.part_name.toLowerCase().includes(q) ||
        (d.customer || '').toLowerCase().includes(q)
    );
  }, [drawings, search]);

  const openImport = async () => {
    try {
      const projects = await api.get('/projects');
      setBalloonProjects(projects);
      setShowImport(true);
    } catch (e) { alert('Failed to load ballooning projects: ' + e.message); }
  };

  const doImport = async (projectId) => {
    setImporting(projectId);
    try {
      await qa.importFromBallooning(projectId);
      setShowImport(false);
      load();
    } catch (e) { alert('Import failed: ' + e.message); }
    finally { setImporting(null); }
  };

  const handleDelete = async (d) => {
    if (!confirm(`Delete ${d.drawing_no}?`)) return;
    await qa.deleteDrawing(d.id);
    load();
  };

  const startInspection = async (d) => {
    // Create a new check and open the check view
    try {
      const check = await qa.createCheck({ drawing_id: d.id, inspector_name: '' });
      const full = await qa.getCheck(check.id);
      onOpenCheck({ checkId: check.id, drawing: d, dims: full.dimensions || [], checkedRows: [] });
      onNavigate('check');
    } catch (e) { alert('Failed to start inspection: ' + e.message); }
  };

  const openExistingCheck = async (d) => {
    try {
      const checks = await qa.listChecks(d.id);
      if (checks.length === 0) { startInspection(d); return; }
      const latest = checks[0];
      const full = await qa.getCheck(latest.id);
      onOpenCheck({ checkId: latest.id, drawing: d, dims: full.dimensions || [], checkedRows: full.dimensions?.filter((x) => x.measurement) || [] });
      onNavigate('check');
    } catch (e) { alert('Error: ' + e.message); }
  };

  const hasDims = async (d) => {
    try {
      const dims = await qa.listDimensions(d.id);
      return dims.length > 0;
    } catch { return false; }
  };

  return (
    <>
      {/* Top action bar */}
      <div style={{ display: 'flex', gap: 8, margin: '0 16px 8px', flexWrap: 'wrap' }}>
        <Btn title="+ Import from Ballooning" onClick={openImport} variant="primary" />
        <Btn title="History" onClick={() => onNavigate('history')} variant="outline" />
        <Btn title="Dispatches" onClick={() => onNavigate('dispatches')} variant="outline" />
        <Btn title="Instruments" onClick={() => onNavigate('instruments')} variant="outline" />
      </div>

      {/* Import panel */}
      {showImport && (
        <Card style={{ backgroundColor: '#f8fafc' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 8 }}>
            Select a ballooning project to import
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {balloonProjects.map((p) => (
              <div key={p._id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{p.drawingNumber || p.projectId}</span>
                  <span style={{ marginLeft: 8, fontSize: 13, color: C.textMuted }}>{p.partName}</span>
                </div>
                <Btn
                  title={importing === p._id ? 'Importing...' : 'Import'}
                  onClick={() => doImport(p._id)}
                  disabled={importing === p._id}
                  variant="primary"
                  style={{ padding: '6px 14px', fontSize: 12 }}
                />
              </div>
            ))}
            {balloonProjects.length === 0 && <EmptyState message="No ballooning projects found." />}
          </div>
        </Card>
      )}

      <SectionTitle>Parts to Inspect</SectionTitle>

      {loading ? (
        <EmptyState message="Loading..." />
      ) : drawings.length === 0 ? (
        <EmptyState message="No drawings available. Import from ballooning or create drawings first." />
      ) : (
        <>
          <SearchBar value={search} onChange={setSearch} placeholder="Search drawings..." />
          {filtered.length === 0 ? (
            <EmptyState message="No drawings match your search." />
          ) : (
            filtered.map((d) => (
              <Card key={d.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: C.primaryDark }}>{d.drawing_no}</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginTop: 4 }}>{d.part_name}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {d.customer ? `${d.customer}  ·  ` : ''}Rev {d.revision}  ·  {d.unit}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <Btn title="Start Inspection" onClick={() => startInspection(d)} variant="success" style={{ padding: '8px 14px', fontSize: 13 }} />
                  <Btn title="Check Again" onClick={() => openExistingCheck(d)} variant="outline" style={{ padding: '8px 14px', fontSize: 13 }} />
                  <Btn title="Delete" onClick={() => handleDelete(d)} variant="danger" style={{ padding: '8px 14px', fontSize: 13 }} />
                </div>
              </Card>
            ))
          )}
        </>
      )}
    </>
  );
}

/* ================================================================== */
/* CHECK VIEW — mirrors QCCheckScreen                                  */
/* ================================================================== */

function CheckView({ checkData, onBack }) {
  const { checkId, drawing } = checkData;
  const [dims, setDims] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [inspectorName, setInspectorName] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actuals, setActuals] = useState({});
  const [remarks, setRemarks] = useState({});
  const [dimInstruments, setDimInstruments] = useState({});
  const [extraSamples, setExtraSamples] = useState({});
  const [newInstrument, setNewInstrument] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [full, instrs] = await Promise.all([
          qa.getCheck(checkId),
          qa.listInstruments().catch(() => []),
        ]);
        const dimensionList = full.dimensions || [];
        setDims(dimensionList);
        setInstruments(instrs);

        // Initialize sample state
        const initActuals = {};
        const initRemarks = {};
        const initInstruments = {};
        const initExtra = {};
        dimensionList.forEach((dim) => {
          initActuals[dim.id] = Array(SAMPLE_COUNT).fill('');
          initRemarks[dim.id] = dim.measurement?.remarks || '';
          initInstruments[dim.id] = dim.measurement?.instrument || '';
          initExtra[dim.id] = 0;
        });
        setActuals(initActuals);
        setRemarks(initRemarks);
        setDimInstruments(initInstruments);
        setExtraSamples(initExtra);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, [checkId]);

  const countFor = (dimId) => SAMPLE_COUNT + (extraSamples[dimId] || 0);

  const setSample = (dimId, idx, value) => {
    setActuals((prev) => {
      const next = [...(prev[dimId] || [])];
      next[idx] = value;
      return { ...prev, [dimId]: next };
    });
  };

  const addSample = (dimId) => {
    setExtraSamples((prev) => ({ ...prev, [dimId]: Math.min(MAX_SAMPLES - SAMPLE_COUNT, (prev[dimId] || 0) + 1) }));
    setActuals((prev) => {
      const current = prev[dimId] || [];
      return { ...prev, [dimId]: [...current, ''] };
    });
  };

  const removeSample = (dimId) => {
    setExtraSamples((prev) => ({ ...prev, [dimId]: Math.max(0, (prev[dimId] || 0) - 1) }));
    setActuals((prev) => {
      const current = prev[dimId] || [];
      return { ...prev, [dimId]: current.slice(0, -1) };
    });
  };

  const addInstrument = async () => {
    const name = newInstrument.trim();
    if (!name) return;
    try {
      await qa.createInstrument({ name });
      setNewInstrument('');
      setInstruments(await qa.listInstruments());
    } catch (e) { alert('Error: ' + e.message); }
  };

  const handleSubmit = async () => {
    let savedCount = 0;
    for (const dim of dims) {
      const samples = actuals[dim.id] || [];
      const hasData = samples.some((s) => s.trim() !== '' && !isNaN(Number(s)));
      if (!hasData) continue;

      const body = {
        check_id: checkId,
        instrument: dimInstruments[dim.id] || '',
        remarks: remarks[dim.id] || '',
      };
      for (let i = 0; i < MAX_SAMPLES; i++) {
        body[`sample${i + 1}`] = samples[i] != null && samples[i] !== '' ? Number(samples[i]) : null;
      }
      await qa.saveMeasurement(dim.id, body);
      savedCount++;
    }

    if (savedCount === 0) {
      alert('Enter at least one sample measurement before saving.');
      return;
    }

    setSaving(true);
    try {
      await qa.updateCheck(checkId, { inspector_name: inspectorName, inspector_notes: notes });
      await qa.completeCheck(checkId);
      alert(`Inspection saved! ${savedCount} dimension(s) recorded.`);
      onBack();
    } catch (e) { alert('Error: ' + e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <EmptyState message="Loading..." />;

  return (
    <>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: C.primary, fontWeight: 600, margin: '0 16px', padding: 0 }}>
        ← Back to Drawings
      </button>

      {/* Drawing info card */}
      <Card>
        <div style={{ fontSize: 17, fontWeight: 800, color: C.primaryDark }}>
          {drawing.drawing_no} – {drawing.part_name}
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>
          {drawing.customer ? `${drawing.customer}  ·  ` : ''}Rev {drawing.revision}  ·  Unit: {drawing.unit}
        </div>
      </Card>

      {/* Inspector name */}
      <div style={{ margin: '12px 16px 0' }}>
        <Field label="Inspector Name" value={inspectorName} onChange={setInspectorName} placeholder="Name of the person inspecting" />
      </div>

      {/* Instruments */}
      <SectionTitle>Instruments</SectionTitle>
      <div style={{ margin: '0 16px' }}>
        {instruments.map((inst) => (
          <div key={inst.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
            <span style={{ fontSize: 14, color: C.text }}>{inst.name}</span>
            <button
              onClick={async () => { if (confirm(`Delete "${inst.name}"?`)) { await qa.deleteInstrument(inst.id); setInstruments(await qa.listInstruments()); } }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: C.danger, fontWeight: 600 }}
            >Remove</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            value={newInstrument}
            onChange={(e) => setNewInstrument(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addInstrument()}
            placeholder="New instrument name"
            style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 14, boxSizing: 'border-box' }}
          />
          <Btn title="Add" onClick={addInstrument} variant="primary" style={{ padding: '8px 14px', fontSize: 13 }} />
        </div>
      </div>

      {/* Dimensions */}
      <SectionTitle>Dimensions to Check ({dims.length})</SectionTitle>
      {dims.map((dim) => {
        const samples = actuals[dim.id] || Array(SAMPLE_COUNT).fill('');
        const filled = samples.filter((s) => s.trim() !== '' && !isNaN(Number(s))).length;
        const hasFail = samples.some((s) => s.trim() !== '' && !isNaN(Number(s)) && !isInTolerance(Number(s), dim.nominal, dim.tol_upper, dim.tol_lower));
        const allPass = filled === samples.length && filled > 0 && !hasFail;
        const tone = hasFail ? 'danger' : allPass ? 'success' : 'neutral';
        const badgeText = hasFail ? 'FAIL' : allPass ? 'OK' : filled === 0 ? 'Pending' : `${filled}/${samples.length}`;

        return (
          <Card key={dim.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
                  Dim {dim.dim_no}{dim.description ? ` · ${dim.description}` : ''}
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {dim.nominal_text || `${fmt(dim.nominal)} ${drawing.unit}  ${toleranceText(dim.tol_upper, dim.tol_lower)}`}
                </div>
              </div>
              <Badge text={badgeText} tone={tone} />
            </div>

            {/* Tolerance range display */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
              Range: {fmt(dim.nominal + dim.tol_lower)} to {fmt(dim.nominal + dim.tol_upper)}
            </div>

            {/* Instrument select */}
            <div style={{ marginVertical: 8 }}>
              <Select
                label="Instrument"
                value={dimInstruments[dim.id] || ''}
                onChange={(val) => setDimInstruments((prev) => ({ ...prev, [dim.id]: val }))}
                options={instruments.map((i) => ({ label: i.name, value: i.name }))}
                placeholder="Select an instrument"
              />
            </div>

            {/* Sample inputs */}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              {samples.map((value, idx) => (
                <SampleInput
                  key={idx}
                  label={`S${idx + 1}`}
                  value={value}
                  onChange={(v) => setSample(dim.id, idx, v)}
                  dim={dim}
                />
              ))}
            </div>

            {/* Sample controls */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 11, color: C.textMuted }}>Default 5 samples per dimension.</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {countFor(dim.id) > SAMPLE_COUNT && (
                  <button onClick={() => removeSample(dim.id)} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: C.textMuted, cursor: 'pointer', backgroundColor: C.surface }}>
                    − Sample
                  </button>
                )}
                {countFor(dim.id) < MAX_SAMPLES && (
                  <button onClick={() => addSample(dim.id)} style={{ border: `1px solid ${C.primary}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: C.primary, cursor: 'pointer', backgroundColor: C.surface }}>
                    + Add Sample
                  </button>
                )}
              </div>
            </div>

            {/* Remarks */}
            <div style={{ marginTop: 10 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: C.textMuted, marginBottom: 4 }}>Remarks</label>
              <textarea
                value={remarks[dim.id] || ''}
                onChange={(e) => setRemarks((prev) => ({ ...prev, [dim.id]: e.target.value }))}
                placeholder="Type remarks for this dimension"
                style={{ width: '100%', border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, color: C.text, minHeight: 40, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
          </Card>
        );
      })}

      {/* Inspector remarks */}
      <SectionTitle>Inspector Remarks</SectionTitle>
      <div style={{ margin: '0 16px' }}>
        <Field label="Remarks" value={notes} onChange={setNotes} multiline placeholder="Optional remarks" />
      </div>

      {/* Save button */}
      <div style={{ margin: '0 16px 24px' }}>
        <Btn title={saving ? 'Saving...' : 'Save & Generate Report'} onClick={handleSubmit} loading={saving} variant="success" style={{ width: '100%', padding: 14, fontSize: 15 }} />
      </div>
    </>
  );
}

/* ================================================================== */
/* HISTORY VIEW                                                         */
/* ================================================================== */

function HistoryView({ onBack }) {
  const [checks, setChecks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    qa.listChecks().then(setChecks).finally(() => setLoading(false));
  }, []);

  return (
    <>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: C.primary, fontWeight: 600, margin: '0 16px', padding: 0 }}>
        ← Back
      </button>
      <SectionTitle>Inspection History</SectionTitle>
      {loading ? (
        <EmptyState message="Loading..." />
      ) : checks.length === 0 ? (
        <EmptyState message="No inspections yet." />
      ) : (
        checks.map((c) => (
          <Card key={c.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{c.drawing_no} — {c.part_name}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {c.inspector_name || 'Unknown'} · {new Date(c.checked_at).toLocaleString()}
                </div>
              </div>
              <Badge text={c.result} tone={c.result === 'Pass' ? 'success' : c.result === 'Fail' ? 'danger' : 'neutral'} />
            </div>
          </Card>
        ))
      )}
    </>
  );
}

/* ================================================================== */
/* DISPATCH VIEW                                                       */
/* ================================================================== */

function DispatchView({ onBack }) {
  const [dispatches, setDispatches] = useState([]);
  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ drawing_id: '', dispatch_no: '', po_no: '', invoice_no: '', qty: '', dispatched_by: '', notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, draws] = await Promise.all([qa.listDispatches(), qa.listDrawings()]);
      setDispatches(d);
      setDrawings(draws);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.drawing_id) return alert('Select a drawing');
    const drawing = drawings.find((d) => d.id === form.drawing_id);
    await qa.createDispatch({
      ...form,
      drawing_no: drawing?.drawing_no || '',
      part_name: drawing?.part_name || '',
      qty: Number(form.qty) || 0,
    });
    setShowNew(false);
    setForm({ drawing_id: '', dispatch_no: '', po_no: '', invoice_no: '', qty: '', dispatched_by: '', notes: '' });
    load();
  };

  return (
    <>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: C.primary, fontWeight: 600, margin: '0 16px', padding: 0 }}>
        ← Back
      </button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 16px' }}>
        <SectionTitle style={{ margin: 0 }}>Dispatches</SectionTitle>
        <Btn title="+ New Dispatch" onClick={() => setShowNew(!showNew)} variant="primary" style={{ padding: '8px 14px', fontSize: 13 }} />
      </div>

      {showNew && (
        <Card style={{ backgroundColor: '#f8fafc' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Select label="Drawing" value={form.drawing_id} onChange={(v) => setForm({ ...form, drawing_id: v })} options={drawings.map((d) => ({ label: `${d.drawing_no} — ${d.part_name}`, value: d.id }))} placeholder="-- Select --" />
            <Field label="Dispatch No" value={form.dispatch_no} onChange={(v) => setForm({ ...form, dispatch_no: v })} />
            <Field label="PO No" value={form.po_no} onChange={(v) => setForm({ ...form, po_no: v })} />
            <Field label="Invoice No" value={form.invoice_no} onChange={(v) => setForm({ ...form, invoice_no: v })} />
            <Field label="Quantity" value={form.qty} onChange={(v) => setForm({ ...form, qty: v })} placeholder="0" />
            <Field label="Dispatched By" value={form.dispatched_by} onChange={(v) => setForm({ ...form, dispatched_by: v })} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Btn title="Create Dispatch" onClick={create} variant="success" style={{ padding: '8px 16px', fontSize: 13 }} />
            <Btn title="Cancel" onClick={() => setShowNew(false)} variant="outline" style={{ padding: '8px 16px', fontSize: 13 }} />
          </div>
        </Card>
      )}

      {loading ? (
        <EmptyState message="Loading..." />
      ) : dispatches.length === 0 ? (
        <EmptyState message="No dispatches yet." />
      ) : (
        dispatches.map((d) => (
          <Card key={d.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{d.dispatch_no || '—'} · {d.drawing_no}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {d.part_name} · PO: {d.po_no || '-'} · Qty: {d.qty} · By: {d.dispatched_by || '-'} · {new Date(d.dispatched_at).toLocaleDateString()}
                </div>
              </div>
              <button onClick={async () => { if (confirm('Delete?')) { await qa.deleteDispatch(d.id); load(); } }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.danger }}>
                <Trash2 size={16} />
              </button>
            </div>
          </Card>
        ))
      )}
    </>
  );
}

/* ================================================================== */
/* INSTRUMENTS VIEW                                                    */
/* ================================================================== */

function InstrumentsView({ onBack }) {
  const [instruments, setInstruments] = useState([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setInstruments(await qa.listInstruments()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim()) return;
    await qa.createInstrument({ name: name.trim() });
    setName('');
    load();
  };

  return (
    <>
      <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: C.primary, fontWeight: 600, margin: '0 16px', padding: 0 }}>
        ← Back
      </button>
      <SectionTitle>Measuring Instruments</SectionTitle>
      <div style={{ margin: '0 16px', maxWidth: 500 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="e.g. Vernier Caliper, Micrometer, CMM"
            style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14, boxSizing: 'border-box' }}
          />
          <Btn title="Add" onClick={add} variant="primary" style={{ padding: '10px 16px', fontSize: 13 }} />
        </div>

        {loading ? (
          <EmptyState message="Loading..." />
        ) : (
          <div style={{ marginTop: 12 }}>
            {instruments.map((i) => (
              <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 14, color: C.text }}>{i.name}</span>
                <button onClick={async () => { if (confirm('Remove?')) { await qa.deleteInstrument(i.id); load(); } }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.danger }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {instruments.length === 0 && <EmptyState message="No instruments added yet." />}
          </div>
        )}
      </div>
    </>
  );
}
