import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addCustomUnit, getCustomUnits } from '../utils/addableMasters.js';

const ADD_NEW_OPTION = '__ADDABLE_SELECT_ADD_NEW__';

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
  const [masterOptions, setMasterOptions] = useState(() => masterType === 'unit' ? getCustomUnits() : []);
  const [recentOptions, setRecentOptions] = useState([]);
  const addNewInDropdown = addNewInOptions || masterType === 'unit';
  const availableOptions = [...new Set([...options, ...masterOptions, ...recentOptions])];
  const normalizedOptions = availableOptions.map((option) => typeof option === 'string' ? { value: option, label: option } : option);
  const selectedOption = normalizedOptions.find((option) => String(option.value) === String(value));
  const deletableValues = new Set(deletableOptions.map((option) => String(typeof option === 'string' ? option : option.value)));

  const fieldList = fields.length ? fields : masterType === 'unit'
    ? [{ key: 'name', label: 'Unit Name', placeholder: 'e.g. Kilograms', required: false }, { key: 'symbol', label: 'Unit Symbol', placeholder: 'e.g. Kg', required: true }]
    : [{ key: 'name', label: fieldLabel, required: true }];
  const startAdd = () => {
    setDropdownOpen(false);
    setValues({});
    setError('');
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
      const createdValue = onCreate
        ? await onCreate(values)
        : masterType === 'unit'
          ? addCustomUnit(values)
          : null;
      if (createdValue == null || createdValue === '') throw new Error('The new value could not be saved.');
      if (masterType === 'unit') setMasterOptions(getCustomUnits());
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
      await onDeleteOption(item.value);
      setRecentOptions((previous) => previous.filter((entry) => entry !== String(item.value)));
      if (masterType === 'unit') setMasterOptions(getCustomUnits());
      triggerRef.current?.focus();
    } catch {
      // The owning page reports failures through its existing notification UI.
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
                <p className="addable-select__hint">Add a value for this form. It will be available in the shared dropdown list.</p>
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
