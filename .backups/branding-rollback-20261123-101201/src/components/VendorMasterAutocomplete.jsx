import React, { useEffect, useMemo, useRef, useState } from 'react';
import { searchVendorMaster } from '../utils/vendorMaster.js';

const norm = (v) => String(v || '').trim().toLowerCase();

const VendorMasterAutocomplete = ({
  value = '',
  onChange,
  onSelect,
  placeholder = 'Search vendor from master...',
  className = '',
  id,
  ...rest
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const matches = useMemo(() => (open ? searchVendorMaster(value) : []), [value, open]);

  const inMaster = useMemo(() => {
    const q = norm(value);
    if (!q) return false;
    return searchVendorMaster(value).some((v) => norm(v.name) === q);
  }, [value]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (v) => {
    onChange?.(v.name);
    onSelect?.(v);
    setOpen(false);
  };

  return (
    <div className="vendor-autocomplete" ref={wrapRef}>
      <input
        {...rest}
        id={id}
        type="text"
        className={className || undefined}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange?.(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'Enter' && open && matches.length > 0) {
            e.preventDefault();
            pick(matches[0]);
          }
        }}
      />
      {inMaster && (
        <span className="vendor-autocomplete-badge" title="Present in Vendor Master">
          ✓
        </span>
      )}
      {open && (
        <div className="vendor-autocomplete-list">
          {matches.length === 0 ? (
            <div className="vendor-autocomplete-empty">
              {String(value || '').trim()
                ? 'Not in Vendor Master — will be saved as typed.'
                : 'Start typing to search the Vendor Master...'}
            </div>
          ) : (
            matches.map((v) => (
              <button type="button" key={v.seq} className="vendor-autocomplete-item" onClick={() => pick(v)}>
                <span className="vendor-autocomplete-name">{v.name}</span>
                <span className="vendor-autocomplete-product">{v.product}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default VendorMasterAutocomplete;
