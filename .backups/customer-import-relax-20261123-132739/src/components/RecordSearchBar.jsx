import React from 'react';
import { Search, X } from 'lucide-react';

const RecordSearchBar = ({ value, onChange, placeholder, label }) => (
  <div className="record-search-bar">
    <Search className="record-search-bar__icon" size={18} aria-hidden="true" />
    <input
      type="text"
      className="action-select form-input record-search-bar__input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
    />
    {value && (
      <button
        type="button"
        className="record-search-bar__clear"
        onClick={() => onChange('')}
        aria-label="Clear search"
        title="Clear search"
      >
        <X size={17} aria-hidden="true" />
      </button>
    )}
  </div>
);

export default RecordSearchBar;
