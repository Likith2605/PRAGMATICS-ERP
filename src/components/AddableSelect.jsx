import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createMaster, deleteMaster, listMasters } from '../services/masterApi.js';

const ADD_NEW_OPTION = '__ADDABLE_SELECT_ADD_NEW__';
const clean = (value) => String(value ?? '').trim();

/** Native select with a reusable Add New modal for approved master fields. */
const AddableSelect = ({
  value = '', onChange, onValueChange, options = [], onCreate, addLabel = '+ Add New',
  title = 'Add New Value', fieldLabel = 'Name', saveLabel = 'Save and Select', fields = [], className = '', masterType = '',
  style, selectStyle, disabled = false, canAdd = true, addNewInOptions = false, name, id,
  deletableOptions = [], onDeleteOption, customDropdown = false
}) => {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownRect, setDropdownRect] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const dropdownId = useId();
  // Units of measure are permanent master records. Browser storage is never
  // consulted here; the PostgreSQL UOM master is the only list source.
  const uomRecordsRef = useRef([]);
  const [masterOptions, setMasterOptions] = useState([]);
  const [masterError, setMasterError] = useState('');
  const [recentOptions, setRecentOptions] = useState([]);
  const addNewInDropdown = addNewInOptions || masterType === 'unit';
  const availableOptions = [...new Set([...options, ...masterOptions, ...recentOptions])];
  const normalizedOptions = availableOptions.map((option) => typeof option === 'string' ? { value: option, label: option } : option);
  const selectedOption = normalizedOptions.find((option) => String(option.value) === String(value));
  const deletableValues = new Set(deletableOptions.map((option) => String(typeof option === 'string' ? option : option.value)));

  const fieldList = fields.length ? fields : masterType === 'unit'
    ? [{ key: 'name', label: 'Unit Name', placeholder: 'e.g. Kilograms', required: false }, { key: 'symbol', label: 'Unit Symbol', placeholder: 'e.g. Kg', required: true }]
    : [{ key: 'name', label: fieldLabel, required: true }];
  const loadUoms = async () => {
    const records = await listMasters('uoms');
    uomRecordsRef.current = records;
    setMasterOptions(records.map((record) => clean(record.code)).filter(Boolean));
    setMasterError('');
    return records;
  };

  useEffect(() => {
    if (masterType !== 'unit') return undefined;
    let active = true;
    loadUoms()
      .catch((loadError) => { if (active) setMasterError(loadError.message || 'The UOM Master could not be loaded.'); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterType]);

  const startAdd = () => {
    setDropdownOpen(false);
    setValues({});
    setError('');
    setMasterError('');
    setOpen(true);
  };
  const handleSelectChange = (event) => {
    if (addNewInDropdown && canAdd && event.target.value === ADD_NEW_OPTION) {
      // Reset the controlled native select to its previous value while opening the modal.
      event.target.value = value == null ? '' : String(value);
      startAdd();
      return;
    }
    if (onValueChange) onValueChange(event.target.value, event);
    else onChange(event);
  };
  const selectOption = (option) => {
    const selected = String(option.value);
    if (onValueChange) onValueChange(selected);
    else if (onChange) onChange({ target: { name, value: selected } });
    setDropdownOpen(false);
    triggerRef.current?.focus();
  };
  const openDropdown = () => {
    const selectedIndex = normalizedOptions.findIndex((option) => String(option.value) === String(value));
    setHighlightedIndex(Math.max(0, selectedIndex));
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setDropdownRect({ left: rect.left, top: rect.bottom, width: rect.width });
    setDropdownOpen(true);
  };
  const handleTriggerKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!dropdownOpen) {
        openDropdown();
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlightedIndex((index) => (index + direction + normalizedOptions.length) % normalizedOptions.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (dropdownOpen && normalizedOptions[highlightedIndex]) {
        event.preventDefault();
        selectOption(normalizedOptions[highlightedIndex]);
      } else if (!dropdownOpen) {
        event.preventDefault();
        openDropdown();
      }
    }
    if (event.key === 'Escape' && dropdownOpen) {
      event.preventDefault();
      setDropdownOpen(false);
    }
  };
  const handleOptionKeyDown = (event, index) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setHighlightedIndex((index + direction + normalizedOptions.length) % normalizedOptions.length);
      triggerRef.current?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDropdownOpen(false);
      triggerRef.current?.focus();
    }
  };
  const save = async (event) => {
    event.preventDefault();
    // This modal can be rendered from inside another form via a React portal.
    // React still bubbles the submit event through the parent component tree,
    // so stop it here to keep the parent form from validating/submitting.
    event.stopPropagation();
    setError('');
    setSaving(true);
    try {
      let createdValue;
      if (masterType === 'unit') {
        // Even when a page supplies an onCreate handler, UOM additions go to
        // the authoritative master API so every screen sees the same record.
        const symbol = clean(values.symbol || values.name);
        if (!symbol) throw new Error('Unit symbol is required.');
        const response = await createMaster('uoms', {
          code: symbol,
          name: clean(values.name) || symbol,
          symbol,
          description: clean(values.description)
        });
        createdValue = response.record?.code || symbol;
        await loadUoms();
      } else if (onCreate) {
        createdValue = await onCreate(values);
      }
      if (createdValue == null || createdValue === '') throw new Error('The new value could not be saved.');
      setRecentOptions((previous) => [...new Set([...previous, String(createdValue)])]);
      if (onValueChange) onValueChange(createdValue);
      else onChange({ target: { name, value: createdValue } });
      setOpen(false);
      setValues({});
    } catch (saveError) {
      setError(saveError?.message || 'Could not save this value.');
    } finally {
      setSaving(false);
    }
  };
  const deleteOption = async (event, option) => {
    event.preventDefault();
    event.stopPropagation();
    const item = typeof option === 'string' ? { value: option, label: option } : option;
    if (!window.confirm(`Delete custom ${fieldLabel.toLowerCase()} “${item.label}”?`)) return;
    try {
      if (masterType === 'unit') {
        const record = uomRecordsRef.current.find((entry) => clean(entry.code) === clean(item.value));
        if (!record) throw new Error('The UOM Master record was not found. Reload before deleting.');
        const reason = window.prompt(`Reason for deleting unit “${item.label}”?`)?.trim();
        if (!reason) return;
        await deleteMaster('uoms', record.id, Number(record.version) || 1, reason);
        await loadUoms();
      } else {
        await onDeleteOption(item.value);
      }
      setRecentOptions((previous) => previous.filter((entry) => entry !== String(item.value)));
      triggerRef.current?.focus();
    } catch (deleteError) {
      setMasterError(deleteError.message || 'The unit could not be deleted.');
    }
  };

  useEffect(() => {
    if (!dropdownOpen) return undefined;
    const updateRect = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setDropdownRect({ left: rect.left, top: rect.bottom, width: rect.width });
    };
    const handleOutsidePointer = (event) => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setDropdownOpen(false);
      }
    };
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    document.addEventListener('pointerdown', handleOutsidePointer);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
      document.removeEventListener('pointerdown', handleOutsidePointer);
    };
  }, [dropdownOpen]);

  return (
    <>
      <div className={`addable-select ${addNewInDropdown ? 'addable-select--menu' : ''} ${className}`.trim()} style={style}>
        {customDropdown ? (
          <button
            ref={triggerRef}
            id={id}
            name={name}
            type="button"
            className="addable-select__trigger"
            style={selectStyle}
            disabled={disabled}
            role="combobox"
            aria-label={fieldLabel}
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
            aria-controls={dropdownId}
            aria-activedescendant={dropdownOpen && normalizedOptions[highlightedIndex] ? `${dropdownId}-option-${highlightedIndex}` : undefined}
            onClick={() => dropdownOpen ? setDropdownOpen(false) : openDropdown()}
            onKeyDown={handleTriggerKeyDown}
          >
            <span>{selectedOption?.label || value || 'Select'}</span>
            <span className="addable-select__chevron" aria-hidden="true" />
          </button>
        ) : (
          <select id={id} name={name} value={value} onChange={handleSelectChange} disabled={disabled} style={selectStyle}>
            {availableOptions.map((option) => {
              const item = typeof option === 'string' ? { value: option, label: option } : option;
              return <option key={String(item.value)} value={item.value}>{item.label}</option>;
            })}
            {canAdd && addNewInDropdown && <option value={ADD_NEW_OPTION}>{addLabel}</option>}
          </select>
        )}
        {canAdd && !addNewInDropdown && <button type="button" className="button-secondary addable-select__action" onClick={startAdd} disabled={disabled}>{addLabel}</button>}
      </div>
      {customDropdown && dropdownOpen && dropdownRect && createPortal(
        <div
          id={dropdownId}
          ref={menuRef}
          className="addable-select__option-menu"
          role="listbox"
          aria-label={fieldLabel}
          style={{ left: dropdownRect.left, top: dropdownRect.top, width: dropdownRect.width }}
        >
          {normalizedOptions.map((option, index) => {
            const selected = String(option.value) === String(value);
            const canDelete = Boolean(onDeleteOption && deletableValues.has(String(option.value)));
            return (
              <div className="addable-select__option-row" key={String(option.value)}>
                <button
                  type="button"
                  id={`${dropdownId}-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  className={`addable-select__option${index === highlightedIndex ? ' is-highlighted' : ''}`}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => selectOption(option)}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                >
                  <span>{option.label}</span>
                </button>
                {canDelete && (
                  <button
                    type="button"
                    className="addable-select__delete"
                    aria-label={`Delete ${option.label}`}
                    title={`Delete ${option.label}`}
                    onClick={(event) => deleteOption(event, option)}
                    onKeyDown={(event) => event.stopPropagation()}
                    disabled={disabled}
                  >×</button>
                )}
              </div>
            );
          })}
          {masterError && <div className="addable-select__error" role="alert" style={{ padding: '6px 10px' }}>{masterError}</div>}
          {canAdd && addNewInDropdown && (
            <button type="button" className="addable-select__add-option" onClick={startAdd}>{addLabel}</button>
          )}
        </div>,
        document.body
      )}
      {open && createPortal(
        <div className="template-modal-backdrop addable-select__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setOpen(false); }}>
          <section className="template-modal addable-select__modal" role="dialog" aria-modal="true" aria-labelledby="addable-select-title">
            <div className="template-modal-header">
              <div>
                <h3 id="addable-select-title">{title}</h3>
                <p className="addable-select__hint">
                  {masterType === 'unit'
                    ? 'Units are saved to the shared PostgreSQL UOM Master.'
                    : 'Add a value for this form. It will be available in the shared dropdown list.'}
                </p>
              </div>
              <button type="button" className="button-secondary button-small" onClick={() => setOpen(false)} disabled={saving} aria-label="Close">×</button>
            </div>
            <form onSubmit={save}>
              <div className="form-grid addable-select__fields">
                {fieldList.map((field) => (
                  <label className="form-field" key={field.key}>
                    <span>{field.label}{field.required !== false && <b className="addable-select__required"> *</b>}</span>
                    <input
                      autoFocus={fieldList[0]?.key === field.key}
                      required={field.required !== false}
                      maxLength={field.maxLength || 80}
                      value={values[field.key] || ''}
                      placeholder={field.placeholder || ''}
                      onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
                    />
                  </label>
                ))}
              </div>
              {error && <p className="addable-select__error" role="alert">{error}</p>}
              {masterError && <p className="addable-select__error" role="alert">{masterError}</p>}
              <div className="form-actions addable-select__actions">
                <button type="button" className="button-secondary" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
                <button type="submit" className="button-primary" disabled={saving}>{saving ? 'Saving…' : saveLabel}</button>
              </div>
            </form>
          </section>
        </div>,
        document.body
      )}
    </>
  );
};

export default AddableSelect;
