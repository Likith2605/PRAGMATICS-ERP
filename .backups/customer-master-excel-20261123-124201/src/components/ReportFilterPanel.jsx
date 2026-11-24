import React, { useEffect, useRef } from 'react';

/** Shared popover interaction for report filter controls. */
const ReportFilterPanel = ({
  open,
  onOpenChange,
  onApply,
  onReset,
  resetDisabled = false,
  children,
  applyDisabled = false,
  ariaLabel = 'Report filters'
}) => {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) onOpenChange(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, onOpenChange]);

  return (
    <div className="report-filter-dropdown" ref={rootRef}>
      <button
        type="button"
        className="button-secondary button-small"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        Apply Filters
      </button>
      {open && (
        <div className="report-filter-dropdown__panel" role="dialog" aria-label={ariaLabel}>
          <div className="report-filter-dropdown__fields">{children}</div>
          <div className="report-filter-dropdown__actions">
            <button type="button" className="button-primary button-small" onClick={onApply} disabled={applyDisabled}>Apply Filters</button>
            <button type="button" className="button-secondary button-small" onClick={onReset} disabled={resetDisabled}>Reset Filters</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportFilterPanel;
