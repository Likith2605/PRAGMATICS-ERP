import { useEffect, useMemo, useRef, useState } from 'react';
import { listInventoryItems } from '../services/inventoryApi.js';

const availableOf = (it) => Math.max(0, (Number(it.currentQty) || 0) - (Number(it.reservedQty) || 0));

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
 * Searchable "Material Name" combobox backed by the PostgreSQL Inventory API.
 *
 * - Lists EVERY registered master item regardless of stock quantity.
 * - Search matches item name, code, description, specification, category, HSN.
 * - Mouse + keyboard (Arrow keys / Enter / Escape / Tab) selection.
 * - The panel is position: fixed (repositioned on scroll) so it is never
 *   clipped by the horizontally scrollable requirement table.
 * - Free text is never committed: onSelect receives the full inventory record;
 *   if the caller returns false (e.g. duplicate) the previous value is kept.
 */
const MaterialNameSelector = ({
  value = '',
  onSelect,
  onClear,
  placeholder = 'Search material / item from Inventory...',
  disabled = false,
  showAvailability = true,
  items: suppliedItems = null
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || '');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [serverItems, setServerItems] = useState([]);
  const [loadError, setLoadError] = useState('');

  const items = useMemo(() => {
    const source = Array.isArray(suppliedItems) ? suppliedItems : serverItems;
    return (source || []).map((row) => ({
      ...(row.payload || {}),
      id: row.item_code || row.itemCode || row.payload?.id || '',
      itemCode: row.item_code || row.itemCode || row.payload?.itemCode || '',
      itemName: row.material_name || row.itemName || row.payload?.itemName || '',
      description: row.description || row.payload?.description || row.payload?.itemDescription || '',
      category: row.category || row.payload?.category || '',
      unit: row.unit || row.payload?.unit || 'Nos',
      specification: row.specification || row.spec || row.payload?.specification || row.payload?.spec || '',
      spec: row.spec || row.payload?.spec || row.payload?.specification || '',
      hsnSac: row.hsn_code || row.hsnSac || row.payload?.hsnSac || '',
      currentQty: Number(row.current_qty ?? row.currentQty ?? row.payload?.currentQty) || 0,
      reservedQty: Number(row.reservedQty ?? row.payload?.reservedQty) || 0
    })).filter((row) => row.itemName || row.itemCode);
  }, [serverItems, suppliedItems]);

  useEffect(() => {
    if (Array.isArray(suppliedItems)) return undefined;
    let active = true;
    const load = () => {
      listInventoryItems()
        .then((rows) => { if (active) { setServerItems(rows); setLoadError(''); } })
        .catch((error) => { if (active) { setServerItems([]); setLoadError(error.message || 'Could not load Inventory items.'); } });
    };
    load();
    window.addEventListener('inventory-authority-updated', load);
    return () => {
      active = false;
      window.removeEventListener('inventory-authority-updated', load);
    };
  }, [suppliedItems]);

  /* Keep the visible text in sync when the parent clears / reloads the row. */
  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  const matches = useMemo(() => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter((x) =>
      [x.itemName, x.itemCode, x.description, x.specification, x.spec, x.category, x.hsnSac].some((f) =>
        String(f || '').toLowerCase().includes(q)
      )
    );
  }, [items, query]);

  const hi = Math.min(active, Math.max(matches.length - 1, 0));

  const place = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 300);
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
    const below = window.innerHeight - r.bottom;
    const flip = below < 230 && r.top > below;
    setPos({
      left,
      width,
      top: flip ? undefined : r.bottom + 4,
      bottom: flip ? window.innerHeight - r.top + 4 : undefined
    });
  };

  /* Reposition while open so the panel follows the row inside any scrolling
     container; close it if the input scrolls out of the viewport. */
  useEffect(() => {
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
  }, [open, matches.length]);

  /* Close + revert when clicking outside this row's selector. */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery(value || '');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children?.[hi];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const choose = (item) => {
    if (!item) return;
    const accepted = onSelect ? onSelect(item) : true;
    if (accepted === false) {
      setQuery(value || '');
      setOpen(false);
      return;
    }
    setQuery(item.itemName || '');
    setOpen(false);
    inputRef.current?.focus();
  };

  const clear = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setQuery('');
    setOpen(false);
    if (onClear) onClear();
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else setActive((a) => Math.min(a + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[hi]) {
        e.preventDefault();
        choose(matches[hi]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery(value || '');
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="material-select" style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        className="form-input material-select-input"
        value={query}
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
      <div
        style={{
          position: 'absolute',
          right: '6px',
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          gap: '2px',
          alignItems: 'center'
        }}
      >
        {value && !disabled && (
          <button type="button" title="Clear material selection" onMouseDown={(e) => e.preventDefault()} onClick={clear} style={iconBtnStyle}>
            ✕
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          title="Show Inventory items"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!disabled) setOpen((o) => !o);
          }}
          style={{ ...iconBtnStyle, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
        >
          ▼
        </button>
      </div>

      {open && pos && (
        <div
          className="material-select-panel"
          style={{
            position: 'fixed',
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            width: pos.width,
            maxHeight: '300px',
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
              alignItems: 'center',
              position: 'sticky',
              top: '-4px',
              background: '#fff',
              zIndex: 1
            }}
          >
            <span>
              Inventory ({matches.length} item{matches.length === 1 ? '' : 's'})
            </span>
            <span style={{ fontSize: '10px', color: '#94a3b8' }}>Click or press Enter to select</span>
          </div>
          <div ref={listRef}>
            {matches.length === 0 ? (
              <div style={{ padding: '14px 10px', textAlign: 'center', fontSize: '12px', color: '#64748b' }}>
                {loadError
                  ? `Inventory could not be loaded: ${loadError}`
                  : `No inventory items match “${query}”. Search by item name, code, category or HSN.`}
              </div>
            ) : (
              matches.map((x, idx) => {
                const avail = availableOf(x);
                const isHi = idx === hi;
                const isSel = String(value || '').trim() !== '' && String(value).trim().toLowerCase() === String(x.itemName || '').trim().toLowerCase();
                return (
                  <div
                    key={String(x.id || x.itemCode || idx)}
                    className="material-select-option"
                    onClick={() => choose(x)}
                    onMouseEnter={() => setActive(idx)}
                    style={{
                      padding: '7px 10px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: isHi ? '#eff6ff' : isSel ? '#f8fafc' : 'transparent',
                      borderLeft: isSel ? '3px solid #2563eb' : isHi ? '3px solid #60a5fa' : '3px solid transparent',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                      marginBottom: '2px'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                      <strong style={{ fontSize: '12.5px', color: '#1e293b' }}>{x.itemName || '(unnamed item)'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#64748b' }}>
                      <span>
                        {[x.category, x.unit, x.description].filter(Boolean).join(' · ')}
                      </span>
                      {showAvailability && (
                        <span style={{ fontWeight: 700, color: avail > 0 ? '#166534' : '#b91c1c', whiteSpace: 'nowrap' }}>
                          {avail > 0 ? `Available: ${avail}` : 'Out of stock'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MaterialNameSelector;
