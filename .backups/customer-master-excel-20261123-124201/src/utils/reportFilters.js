const VALID_DATE_PARTS = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** Normalize supported ERP date forms to a calendar-day key (YYYY-MM-DD). */
export const normalizeReportDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (match) {
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    return VALID_DATE_PARTS(year, month, day) ? `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const [, first, second, yearText] = match;
    const a = Number(first), b = Number(second), year = Number(yearText);
    // ERP UI dates are normally DD/MM/YYYY. If the first part cannot be a month,
    // the value is unambiguously DD/MM/YYYY; otherwise use the same ERP convention.
    const day = a, month = b;
    return VALID_DATE_PARTS(year, month, day) ? `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

export const validateReportDateRange = (fromDate, toDate) => {
  const from = fromDate ? normalizeReportDate(fromDate) : null;
  const to = toDate ? normalizeReportDate(toDate) : null;
  if (fromDate && !from) return 'From Date is invalid.';
  if (toDate && !to) return 'To Date is invalid.';
  if (from && to && from > to) return 'From Date cannot be later than To Date.';
  return '';
};

export const applyReportFilters = ({ rows = [], dateField = 'date', dateFilters = true, from = '', to = '', filters = [], selections = {}, search = '', columns = [] }) => {
  const hasRange = Boolean(dateFilters && (from || to));
  const excludedUndated = [];
  const filteredRows = rows.filter((row) => {
    if (hasRange) {
      const rawDate = typeof dateField === 'function' ? dateField(row) : row?.[dateField];
      const date = normalizeReportDate(rawDate);
      if (!date) {
        excludedUndated.push(row);
        return false;
      }
      const normalizedFrom = from ? normalizeReportDate(from) : null;
      const normalizedTo = to ? normalizeReportDate(to) : null;
      if (normalizedFrom && date < normalizedFrom) return false;
      if (normalizedTo && date > normalizedTo) return false;
    }
    for (const filter of filters) {
      const value = selections[filter.key];
      if (!value) continue;
      if (filter.match ? !filter.match(row, value) : row?.[filter.key] !== value) return false;
    }
    if (search) {
      const term = search.trim().toLocaleLowerCase();
      const matches = columns.some((column) => {
        const value = column.renderText ? column.renderText(row) : row?.[column.key];
        return String(value ?? '').toLocaleLowerCase().includes(term);
      });
      if (!matches) return false;
    }
    return true;
  });
  return { filteredRows, excludedUndated };
};

export const formatQuantityByUnit = (rows = [], quantityField, unitField = 'unit') => {
  const totals = rows.reduce((map, row) => {
    const unit = String(row?.[unitField] || 'Unit not recorded');
    map.set(unit, (map.get(unit) || 0) + (Number(row?.[quantityField]) || 0));
    return map;
  }, new Map());
  return [...totals.entries()].map(([unit, quantity]) => `${quantity.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`).join(' | ') || '0';
};
