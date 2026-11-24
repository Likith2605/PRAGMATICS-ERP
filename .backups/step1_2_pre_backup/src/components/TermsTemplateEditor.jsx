import React, { useState } from 'react';

/**
 * Reusable Terms & Conditions editor with a saved-template picker.
 *
 * Purchase can pick a stored template, edit it inline, save the edited text as
 * a new template, or add one from scratch — the same interaction the Vendor
 * Enquiry (RFQ) terms section uses, but parameterised so any document section
 * can reuse it. Templates live in localStorage under `storageKey`.
 */
export const loadTermsTemplates = (storageKey, defaults = []) => {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      localStorage.setItem(storageKey, JSON.stringify(defaults));
      return defaults;
    }
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaults;
  } catch {
    return defaults;
  }
};

const saveTermsTemplates = (storageKey, list) => {
  localStorage.setItem(storageKey, JSON.stringify(list));
};

const nextTemplateNumber = (list) => list.reduce((m, t) => Math.max(m, Number(t.number) || 0), 0) + 1;

const TermsTemplateEditor = ({
  value = '',
  onChange,
  storageKey,
  defaultTemplates = [],
  label = null,
  placeholder = 'Enter each term on a new line — or pick a template above',
  hint = '',
  newTemplatePrefix = 'Template',
  addModalTitle = 'Add Terms & Conditions Template',
  addModalSubtitle = 'Create a reusable template for future documents.',
  rows = 5
}) => {
  const [templates, setTemplates] = useState(() => loadTermsTemplates(storageKey, defaultTemplates));
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [message, setMessage] = useState('');

  const flash = (msg) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  };

  const applyTemplate = (tpl) => {
    onChange(tpl.content);
    setSelectedTemplateId(tpl.id);
    setIsMenuOpen(false);
    setHoveredId('');
    flash(`${tpl.name || `Template ${tpl.number}`} applied.`);
  };

  const saveAsTemplate = () => {
    const content = String(value || '').trim();
    if (!content) {
      flash('Enter conditions first, then save them as a template.');
      return;
    }
    const name = window.prompt('Template name:', `${newTemplatePrefix} ${nextTemplateNumber(templates)}`);
    if (!name) return;
    const num = nextTemplateNumber(templates);
    const tpl = { id: `tpl-${Date.now()}`, number: num, name: name.trim(), content };
    const next = [...templates, tpl];
    setTemplates(next);
    saveTermsTemplates(storageKey, next);
    setSelectedTemplateId(tpl.id);
    flash(`${tpl.name} saved.`);
  };

  const deleteTemplate = () => {
    if (!selectedTemplateId) return;
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!window.confirm(`Delete template "${tpl?.name || ''}"?`)) return;
    const next = templates.filter((t) => t.id !== selectedTemplateId);
    setTemplates(next);
    saveTermsTemplates(storageKey, next);
    setSelectedTemplateId('');
    flash(`${tpl?.name || 'Template'} deleted.`);
  };

  const addTemplate = () => {
    const content = String(newContent || '').trim();
    if (!newName.trim() || !content) {
      flash('Enter both template name and content.');
      return;
    }
    const num = nextTemplateNumber(templates);
    const tpl = { id: `tpl-${Date.now()}`, number: num, name: newName.trim(), content };
    const next = [...templates, tpl];
    setTemplates(next);
    saveTermsTemplates(storageKey, next);
    setSelectedTemplateId(tpl.id);
    onChange(content);
    setIsAddOpen(false);
    setNewName('');
    setNewContent('');
    flash(`${tpl.name} added and applied.`);
  };

  const sorted = [...templates].sort((a, b) => a.number - b.number);

  return (
    <div className="field-group full-width">
      {label && <label>{label}</label>}

      <div className="template-toolbar" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div className="template-picker" style={{ position: 'relative' }}>
          <button
            type="button"
            className="template-select template-select-button"
            onClick={() => setIsMenuOpen((open) => !open)}
            style={{ minWidth: '220px', height: '40px', padding: '8px 14px' }}
          >
            <span>{templates.find((t) => t.id === selectedTemplateId)?.name || 'Select a template...'}</span>
            <span className="template-chevron">▾</span>
          </button>

          {isMenuOpen && (
            <>
              <div
                className="template-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: '6px',
                  width: '230px',
                  background: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  boxShadow: '0 10px 25px rgba(0,0,0,0.12)',
                  zIndex: 999,
                  overflow: 'hidden'
                }}
              >
                {sorted.map((tpl) => (
                  <div
                    key={tpl.id}
                    onMouseEnter={() => setHoveredId(tpl.id)}
                    onMouseLeave={() => setHoveredId('')}
                    onClick={() => applyTemplate(tpl)}
                    style={{
                      padding: '10px 14px',
                      cursor: 'pointer',
                      borderBottom: '1px solid #f1f5f9',
                      background: selectedTemplateId === tpl.id ? '#eff6ff' : hoveredId === tpl.id ? '#f8fafc' : '#ffffff'
                    }}
                  >
                    <div style={{ fontWeight: '600', color: '#1e293b', fontSize: '13px' }}>
                      {tpl.name || `Template ${tpl.number}`}
                    </div>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>Hover to preview</span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setNewName(`${newTemplatePrefix} ${nextTemplateNumber(templates)}`);
                    setNewContent('');
                    setIsAddOpen(true);
                    setIsMenuOpen(false);
                    setHoveredId('');
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    textAlign: 'left',
                    background: '#f8fafc',
                    border: 'none',
                    borderTop: '1px solid #e2e8f0',
                    color: '#2563eb',
                    fontWeight: '600',
                    cursor: 'pointer',
                    fontSize: '13px'
                  }}
                >
                  ＋ Add Template
                </button>
              </div>

              {hoveredId && (() => {
                const tpl = templates.find((t) => t.id === hoveredId);
                if (!tpl) return null;
                return (
                  <div
                    style={{
                      position: 'absolute',
                      left: '240px',
                      top: '100%',
                      marginTop: '6px',
                      width: '380px',
                      background: '#ffffff',
                      border: '1px solid #cbd5e1',
                      borderRadius: '10px',
                      boxShadow: '0 12px 30px rgba(15, 23, 42, 0.2)',
                      padding: '16px',
                      zIndex: 1000,
                      pointerEvents: 'none'
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 'bold',
                        fontSize: '13.5px',
                        color: '#0f172a',
                        borderBottom: '1px solid #e2e8f0',
                        paddingBottom: '8px',
                        marginBottom: '10px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                    >
                      <span>📄 {tpl.name || `Template ${tpl.number}`}</span>
                      <span style={{ fontSize: '11px', color: '#2563eb', background: '#eff6ff', padding: '2px 8px', borderRadius: '10px', fontWeight: 'bold' }}>
                        Content Preview
                      </span>
                    </div>
                    <div style={{ fontSize: '12.5px', color: '#334155', lineHeight: '1.6', whiteSpace: 'pre-line' }}>
                      {tpl.content}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>

        <button type="button" className="button-secondary button-small" onClick={saveAsTemplate} style={{ height: '40px', padding: '8px 16px' }}>
          Save as Template
        </button>
        <button
          type="button"
          className="button-secondary button-small button-delete"
          onClick={deleteTemplate}
          disabled={!selectedTemplateId}
          style={{ height: '40px', padding: '8px 16px' }}
        >
          Delete Template
        </button>
      </div>

      <textarea
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', resize: 'vertical' }}
      />
      {message && <div className="field-success" style={{ marginTop: '6px' }}>{message}</div>}
      {hint && (
        <p className="muted-text" style={{ fontSize: '12px', marginTop: '6px' }}>
          {hint}
        </p>
      )}

      {isAddOpen && (
        <div className="template-modal-backdrop" onMouseDown={() => setIsAddOpen(false)}>
          <div className="template-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-header">
              <div>
                <h3>{addModalTitle}</h3>
                <p>{addModalSubtitle}</p>
              </div>
              <button type="button" className="template-modal-close" onClick={() => setIsAddOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="template-modal-form">
              <div className="field-group full-width">
                <label>Template Name</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Standard Purchase Terms" autoFocus />
              </div>
              <div className="field-group full-width">
                <label>Terms &amp; Conditions</label>
                <textarea rows="8" value={newContent} onChange={(e) => setNewContent(e.target.value)} placeholder="Enter each term on a new line" />
              </div>
              <div className="form-actions" style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button type="button" className="button-secondary" onClick={() => setIsAddOpen(false)}>Cancel</button>
                <button type="button" className="button-primary" onClick={addTemplate}>Save &amp; Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TermsTemplateEditor;
