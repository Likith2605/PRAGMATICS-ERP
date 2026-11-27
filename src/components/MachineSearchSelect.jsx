import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listMasters } from '../services/masterApi.js';

const MachineSearchSelect = ({ value = null, onChange, placeholder = 'Search machine by name or ID...', portalMenu = false, compact = false }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const [machines, setMachines] = useState([]);
  const [loadError, setLoadError] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  useEffect(() => {
    let activeRequest = true;
    listMasters('machines')
      .then((records) => { if (activeRequest) { setMachines(records); setLoadError(''); } })
      .catch((error) => { if (activeRequest) { setMachines([]); setLoadError(`Machine master could not be loaded from PostgreSQL: ${error.message}`); } });
    return () => { activeRequest = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const list = machines.filter((m) => m.status !== 'Inactive' && m.active !== false);
    if (!q) return list.slice(0, 8);
    return list
      .filter(
        (m) =>
          (m.name || '').toLowerCase().includes(q) ||
          (m.machineId || '').toLowerCase().includes(q) ||
          (m.type || '').toLowerCase().includes(q) ||
          (m.workCenter || '').toLowerCase().includes(q) ||
          (m.location || '').toLowerCase().includes(q)
      )
      .slice(0, 10);
  }, [query, machines]);

  const hi = Math.min(active, Math.max(filtered.length - 1, 0));

  const place = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 260);
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
    const below = window.innerHeight - r.bottom;
    const flip = below < 240 && r.top > below;
    const maxH = Math.max(120, Math.min(240, (flip ? r.top : below) - 4));
    setPos({
      left,
      width,
      flip,
      maxH,
      top: flip ? undefined : r.bottom + 4,
      bottom: flip ? window.innerHeight - r.top + 4 : undefined
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    place();
    const onMove = () => {
      const el = inputRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) {
          setOpen(false);
          return;
        }
      }
      place();
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      const inWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const inMenu = listRef.current && listRef.current.contains(e.target);
      if (!inWrap && !inMenu) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current && listRef.current.children[hi];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  useEffect(() => {
    if (!value) setQuery('');
  }, [value]);

  const choose = (m) => {
    onChange({ machineId: m.machineId, name: m.name, type: m.type, workCenter: m.workCenter, location: m.location, department: m.department });
    setQuery('');
    setOpen(false);
    if (inputRef.current) inputRef.current.focus();
  };

  const clear = () => {
    onChange(null);
    setQuery('');
    setOpen(false);
    window.setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        setOpen(true);
      }
    }, 0);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else {
        setActive((a) => Math.min(a + 1, Math.max(filtered.length - 1, 0)));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[hi]) {
        e.preventDefault();
        choose(filtered[hi]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery('');
      }
    } else if (e.key === 'Tab') {
      if (open) setOpen(false);
    }
  };

  const dropdown = open && pos ? (
    <div
      ref={listRef}
      className="employee-search-dropdown"
      onMouseDown={(e) => e.preventDefault()}
      style={
        portalMenu
          ? {
              position: 'fixed',
              zIndex: 9999,
              left: pos.left,
              width: pos.width,
              top: pos.flip ? 'auto' : pos.top,
              bottom: pos.flip ? pos.bottom : 'auto',
              maxHeight: pos.maxH
            }
          : {
              zIndex: 9999,
              top: pos.flip ? 'auto' : '100%',
              bottom: pos.flip ? '100%' : 'auto',
              left: 0,
              right: 0,
              marginTop: pos.flip ? 0 : 4,
              marginBottom: pos.flip ? 4 : 0,
              maxHeight: pos.maxH
            }
      }
    >
      {filtered.length === 0 ? (
        <div className="employee-search-empty">No matching machine found.</div>
      ) : (
        filtered.map((m, idx) => (
          <button
            type="button"
            key={m.id}
            className={`employee-search-option${value && value.machineId === m.machineId ? ' is-selected' : ''}`}
            style={idx === hi ? { background: '#eff6ff' } : undefined}
            onClick={() => choose(m)}
            onMouseEnter={() => setActive(idx)}
          >
            <span className="employee-search-name">{m.machineId} - {m.name}</span>
            <span className="employee-search-meta">{m.type} • {m.workCenter} • {m.location}</span>
          </button>
        ))
      )}
    </div>
  ) : null;

  return (
    <div className="employee-search-select" ref={wrapRef}>
      {value && (value.machineId || value.name) ? (
        <div className="employee-selected">
          <div className="employee-selected-info">
            <strong>{compact ? (value.name || value.machineId) : value.machineId ? `${value.machineId} - ${value.name}` : value.name}</strong>
            {!compact && (
              <span className="employee-selected-meta">
                {value.type || ''} {value.workCenter ? `• ${value.workCenter}` : ''} {value.location ? `• ${value.location}` : ''}
              </span>
            )}
          </div>
          <button type="button" className="link-btn" onClick={clear} aria-label="Clear machine">
            Change
          </button>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            type="text"
            className="action-select form-input"
            value={query}
            placeholder={placeholder}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          {loadError && <span role="alert" className="employee-search-empty">{loadError}</span>}
          {portalMenu && dropdown ? createPortal(dropdown, document.body) : dropdown}
        </>
      )}
      {value && loadError && <span role="alert" className="employee-search-empty">{loadError}</span>}
    </div>
  );
};

export default MachineSearchSelect;
