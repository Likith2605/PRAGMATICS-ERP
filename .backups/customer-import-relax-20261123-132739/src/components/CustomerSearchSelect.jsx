import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Type-to-search customer picker.
 * Replaces the native <select> so users can type part of a company name,
 * contact person or phone number and pick from a filtered list instead of
 * scrolling through the whole customer master.
 *
 * value    : selected customer key (same key the old <select> used)
 * onChange : (key) => void  — pass '' to clear the selection
 */
const CustomerSearchSelect = ({
  customers = [],
  value = '',
  selectedLabel = '',
  onChange,
  placeholder = 'Type customer name, contact or phone...'
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const selected = customers.find((c) => c.key === value) || null;
  const displayLabel = selected
    ? `${selected.companyName || selected.customerName || ''}${
        selected.customerName && selected.customerName !== selected.companyName ? ` — ${selected.customerName}` : ''
      }`
    : selectedLabel || '';

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return customers.slice(0, 8);
    return customers
      .filter(
        (c) =>
          (c.companyName || '').toLowerCase().includes(q) ||
          (c.customerName || '').toLowerCase().includes(q) ||
          (c.phone || '').toLowerCase().includes(q) ||
          (c.email || '').toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [query, customers]);

  // Close the dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const openSearch = () => {
    setOpen(true);
    setQuery('');
    setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  };

  const handleSelect = (c) => {
    if (onChange) onChange(c.key);
    setQuery('');
    setOpen(false);
  };

  const handleClear = () => {
    if (onChange) onChange('');
    setQuery('');
    setOpen(false);
  };

  // Selected state: show the picked customer with Change / Clear actions
  if (displayLabel && !open) {
    return (
      <div className="employee-search-select" ref={boxRef} style={{ width: '100%' }}>
        <div className="employee-selected">
          <div className="employee-selected-info">
            <strong>{displayLabel}</strong>
            {selected && (selected.phone || selected.email) ? (
              <span className="employee-selected-meta">
                {selected.phone || ''} {selected.email ? `· ${selected.email}` : ''}
              </span>
            ) : null}
          </div>
          <span style={{ display: 'flex', gap: '12px' }}>
            <button type="button" className="link-btn" onClick={openSearch}>
              Change
            </button>
            <button type="button" className="link-btn" onClick={handleClear} aria-label="Clear customer">
              Clear
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="employee-search-select" ref={boxRef} style={{ width: '100%' }}>
      <input
        ref={inputRef}
        type="text"
        className="action-select form-input"
        value={query}
        placeholder={displayLabel ? `${displayLabel} — type to change...` : placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
      />
      {open && (
        <div className="employee-search-dropdown">
          {filtered.length === 0 ? (
            <div className="employee-search-empty">
              No matching customer found. Use “＋ Add New Customer” to create one.
            </div>
          ) : (
            filtered.map((c) => (
              <button
                type="button"
                key={c.key}
                className={`employee-search-option${c.key === value ? ' is-selected' : ''}`}
                onClick={() => handleSelect(c)}
              >
                <span className="employee-search-name">{c.companyName || c.customerName}</span>
                <span className="employee-search-meta">
                  {c.customerName && c.customerName !== c.companyName ? `${c.customerName} · ` : ''}
                  {c.phone || c.email || '—'}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default CustomerSearchSelect;
