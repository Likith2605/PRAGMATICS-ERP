import React, { useState, useEffect, useRef, useMemo } from 'react';
import { getAllProjectsSummary, getFullProjectData } from '../utils/projectTracker.js';

const ProjectIdAutocomplete = ({
  value = '',
  onChange,
  onSelectProject,
  placeholder = 'Type to search Project ID, Customer or PO...',
  autoLinkMsg = '',
  disabled = false,
  excludeLegacy = true
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [allProjects, setAllProjects] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Load master project summary list
  useEffect(() => {
    try {
      const list = getAllProjectsSummary();
      setAllProjects(list || []);
    } catch (err) {
      console.error('Failed to load project summary list', err);
    }
  }, []);

  // Filter projects based on input query
  const filteredProjects = useMemo(() => {
    let list = allProjects;
    if (excludeLegacy) {
      list = list.filter((p) => !p.isLegacy);
    }
    if (!value || !value.trim()) {
      return list.slice(0, 50); // Show recent 50 if empty
    }
    const q = value.trim().toLowerCase();
    return list
      .filter((p) => {
        const matchId = String(p.projectId || '').toLowerCase().includes(q);
        const matchCustomer = String(p.customerName || '').toLowerCase().includes(q);
        const matchCompany = String(p.companyName || '').toLowerCase().includes(q);
        const matchPo = String(p.customerPoNumber || '').toLowerCase().includes(q);
        const matchQuote = String(p.quotationRef || '').toLowerCase().includes(q);
        const matchStatus = String(p.status || '').toLowerCase().includes(q);
        const matchFy = String(p.fyLabel || '').toLowerCase().includes(q);
        return matchId || matchCustomer || matchCompany || matchPo || matchQuote || matchStatus || matchFy;
      })
      .slice(0, 50);
  }, [allProjects, value, excludeLegacy]);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (project) => {
    if (!project) return;
    const pid = project.projectId;
    if (onChange) onChange(pid);

    const fullData = getFullProjectData(pid);
    if (onSelectProject) {
      onSelectProject(pid, fullData, project);
    }
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    if (onChange) onChange(val);
    setIsOpen(true);
    setActiveIndex(-1);

    // If exact match found while typing
    if (val && val.trim()) {
      const match = allProjects.find((p) => {
        if (excludeLegacy && p.isLegacy) return false;
        return p.projectId?.toLowerCase() === val.trim().toLowerCase();
      });
      if (match) {
        const fullData = getFullProjectData(match.projectId);
        if (onSelectProject) {
          onSelectProject(match.projectId, fullData, match);
        }
      }
    }
  };

  const handleKeyDown = (e) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setIsOpen(true);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < filteredProjects.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === 'Enter') {
      if (isOpen && activeIndex >= 0 && filteredProjects[activeIndex]) {
        e.preventDefault();
        handleSelect(filteredProjects[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleClear = (e) => {
    e.stopPropagation();
    if (onChange) onChange('');
    if (onSelectProject) onSelectProject('', null, null);
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', paddingBottom: autoLinkMsg ? '18px' : '0' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          style={{
            width: '100%',
            paddingRight: '60px',
            borderColor: isOpen ? '#6b7280' : undefined,
            boxShadow: isOpen ? '0 0 0 3px rgba(107, 114, 128, 0.15)' : undefined,
            background: disabled ? '#f1f5f9' : undefined,
            transition: 'all 0.15s ease'
          }}
        />

        {/* Action icons (Clear and Dropdown Toggle) */}
        <div style={{ position: 'absolute', right: '8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          {value && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear Project ID"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                borderRadius: '4px'
              }}
            >
              ✕
            </button>
          )}
          <button
            type="button"
            onClick={() => !disabled && setIsOpen((prev) => !prev)}
            title="Toggle Project Suggestions"
            tabIndex={-1}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#64748b',
              cursor: disabled ? 'default' : 'pointer',
              padding: '4px 6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              borderRadius: '4px',
              transform: isOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease'
            }}
          >
            ▼
          </button>
        </div>
      </div>

      {/* Auto-link confirmation message */}
      {autoLinkMsg && (
        <div
          style={{
            fontSize: '11.5px',
            color: '#16a34a',
            fontWeight: '600',
            marginTop: '0',
            position: 'absolute',
            bottom: '-18px',
            left: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '100%'
          }}
        >
          {autoLinkMsg}
        </div>
      )}

      {/* Floating Suggestions Dropdown */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: '320px',
            overflowY: 'auto',
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: '8px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            zIndex: 9999,
            padding: '4px'
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              fontSize: '11px',
              fontWeight: '700',
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              borderBottom: '1px solid #f1f5f9',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <span>Master Projects Directory ({filteredProjects.length} matches)</span>
            <span style={{ fontSize: '10px', color: '#94a3b8' }}>Click or Press Enter to link</span>
          </div>

          {filteredProjects.length > 0 ? (
            filteredProjects.map((proj, idx) => {
              const isSelected = value?.trim().toUpperCase() === proj.projectId?.toUpperCase();
              const isHighlighted = idx === activeIndex;

              return (
                <div
                  key={proj.projectId || idx}
                  onClick={() => handleSelect(proj)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    background: isHighlighted ? '#eff6ff' : isSelected ? '#f8fafc' : 'transparent',
                    borderLeft: isSelected ? '3px solid #2563eb' : isHighlighted ? '3px solid #60a5fa' : '3px solid transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    transition: 'background 0.1s ease',
                    marginBottom: '2px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <strong style={{ fontSize: '13px', color: proj.isLegacy ? '#b45309' : '#1e40af' }}>
                        {proj.projectId}
                      </strong>
                      <span
                        style={{
                          fontSize: '10.5px',
                          padding: '2px 7px',
                          borderRadius: '12px',
                          fontWeight: '700',
                          background: proj.isLegacy ? '#fef3c7' : '#dcfce7',
                          color: proj.isLegacy ? '#92400e' : '#166534',
                          border: `1px solid ${proj.isLegacy ? '#fde68a' : '#bbf7d0'}`
                        }}
                      >
                        {proj.isLegacy ? `📜 ${proj.fyLabel || 'Pre-ERP'}` : '⚡ Live ERP'}
                      </span>
                    </div>

                    <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '500' }}>
                      {proj.status || 'Active'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
                    <span style={{ fontWeight: '600', color: '#1e293b' }}>
                      {proj.companyName || proj.customerName || 'Direct Customer'}
                      {proj.customerName && proj.companyName && proj.customerName !== proj.companyName
                        ? ` (${proj.customerName})`
                        : ''}
                    </span>

                    {proj.customerPoNumber && (
                      <span style={{ fontSize: '11px', color: '#64748b' }}>
                        PO: <strong>{proj.customerPoNumber}</strong>
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ padding: '16px 12px', textAlign: 'center', fontSize: '12px', color: '#64748b' }}>
              No projects found matching "<strong>{value}</strong>". You can continue typing a custom Project ID.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ProjectIdAutocomplete;
