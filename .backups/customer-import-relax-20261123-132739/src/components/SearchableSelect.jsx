import { useEffect, useMemo, useRef, useState } from 'react';

const iconBtnStyle = {
  background: 'transparent',
  border: 'none',
  color: '#64748b',
  cursor: 'pointer',
  padding: '2px 4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '11px',
  borderRadius: '4px',
  lineHeight: 1
};

/**
 * Generic searchable dropdown (Sales Order / Job Card pickers).
 *
 * - Matches the look & feel of MaterialNameSelector (same inline-styled fixed
 *   panel) so it fits the existing ERP design.
 * - Free text is never committed: onChange only fires with a value taken from
 *   `options` (or '' when cleared), so the field can never hold junk.
 * - If `value` is not present in `options` (e.g. a legacy Job Card reference),
 *   it is displayed as-is instead of an empty field.
 *
 * @param {{value?: string, options: Array<{value: string, label: string, hint?: string}>,
 *          onChange: (value: string) => void, placeholder?: string, disabled?: boolean,
 *          label?: string}} props
 */
const SearchableSelect = ({
  value = '',
  options = [],
  onChange,
  placeholder = 'Search...',
  disabled = false,
  label = 'Options'
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const selected = useMemo(() => options.find((o) => String(o.value) === String(value)) || null, [options, value]);

  useEffect(() => {
    const onDocDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const matches = useMemo(() => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      [o.label, o.hint, o.value].some((f) => String(f || '').toLowerCase().includes(q))
    );
  }, [options, query]);

  const hi = Math.min(active, Math.max(matches.length - 1, 0));

  const commit = (opt) => {
    if (!opt) return;
    setOpen(false);
    setQuery('');
    if (onChange) onChange(opt.value);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[hi]) {
        e.preventDefault();
        commit(matches[hi]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const display = open ? query : (selected ? selected.label : String(value || ''));

  return (
    <div ref={wrapRef} className="material-select" style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        className="form-input material-select-input"
        value={display}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        style={{ width: '100%', boxSizing: 'border-box', paddingRight: '46px' }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <div style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '2px', alignItems: 'center' }}>
        {value && !disabled && (
          <button
            type="button"
            title="Clear selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setQuery(''); setOpen(false); if (onChange) onChange(''); }}
            style={iconBtnStyle}
          >
            ✕
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          title="Show list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { if (!disabled) setOpen((o) => !o); }}
          style={{ ...iconBtnStyle, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
        >
          ▼
        </button>
      </div>

      {open && (
        <div
          className="material-select-panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: '280px',
            overflowY: 'auto',
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: '8px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            zIndex: 9999,
            padding: '4px'
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div style={{ padding: '6px 10px', fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #f1f5f9' }}>
            {label} ({matches.length})
          </div>
          {matches.length === 0 ? (
            <div style={{ padding: '14px 10px', textAlign: 'center', fontSize: '12px', color: '#64748b' }}>
              No match for “{query}”.
            </div>
          ) : (
            matches.map((o, idx) => (
              <div
                key={String(o.value)}
                className="material-select-option"
                onClick={() => commit(o)}
                onMouseEnter={() => setActive(idx)}
                style={{
                  padding: '7px 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: idx === hi ? '#eff6ff' : 'transparent',
                  borderLeft: idx === hi ? '3px solid #60a5fa' : '3px solid transparent',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px'
                }}
              >
                <strong style={{ fontSize: '12.5px', color: '#1e293b' }}>{o.label}</strong>
                {o.hint && <span style={{ fontSize: '11px', color: '#64748b' }}>{o.hint}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default SearchableSelect;
