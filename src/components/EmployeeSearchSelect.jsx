import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEmployeeDirectory } from '../services/employeeApi.js';

const EmployeeSearchSelect = ({ value = null, onChange, placeholder = 'Search employee by name or ID...', portalMenu = false, compact = false }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    let active = true;
    getEmployeeDirectory()
      .then((records) => {
        if (active) setEmployees(records);
      })
      .catch((error) => {
        if (active) setLoadError(error.message || 'Employee directory could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const list = employees.filter((e) => e.active !== false);
    if (!q) return list.slice(0, 8);
    return list
      .filter(
        (e) =>
          (e.name || '').toLowerCase().includes(q) ||
          (e.employeeId || '').toLowerCase().includes(q) ||
          (e.designation || '').toLowerCase().includes(q) ||
          (e.department || '').toLowerCase().includes(q)
      )
      .slice(0, 10);
  }, [query, employees]);

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

  const choose = (emp) => {
    onChange({
      employeeId: emp.employeeId,
      name: emp.name,
      department: emp.department,
      designation: emp.designation,
      mobile: emp.mobile
    });
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
      {loading ? (
        <div className="employee-search-empty">Loading employees…</div>
      ) : loadError ? (
        <div className="employee-search-empty" role="alert">{loadError}</div>
      ) : filtered.length === 0 ? (
        <div className="employee-search-empty">No matching employee found.</div>
      ) : (
        filtered.map((emp, idx) => (
          <button
            type="button"
            key={emp.id}
            className={`employee-search-option${value && value.employeeId === emp.employeeId ? ' is-selected' : ''}`}
            style={idx === hi ? { background: '#eff6ff' } : undefined}
            onClick={() => choose(emp)}
            onMouseEnter={() => setActive(idx)}
          >
            <span className="employee-search-name">{emp.name}</span>
            <span className="employee-search-meta">
              {emp.employeeId} · {emp.department} · {emp.designation || '—'}
            </span>
          </button>
        ))
      )}
    </div>
  ) : null;

  return (
    <div className="employee-search-select" ref={wrapRef}>
      {value ? (
        <div className="employee-selected">
          <div className="employee-selected-info">
            <strong>{compact ? value.name : value.name}</strong>
            {!compact && (
              <span className="employee-selected-meta">
                {value.employeeId} · {value.department || '—'} {value.designation ? `· ${value.designation}` : ''} {value.mobile ? `· ${value.mobile}` : ''}
              </span>
            )}
          </div>
          <button type="button" className="link-btn" onClick={clear} aria-label="Clear employee">
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
          {portalMenu && dropdown ? createPortal(dropdown, document.body) : dropdown}
        </>
      )}
    </div>
  );
};

export default EmployeeSearchSelect;
