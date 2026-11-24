import * as XLSX from 'xlsx';

const excelDate = (value) => {
  if (value === null || value === undefined || value === '') return value ?? '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date;
};

const safeSheetName = (name) => name.replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Data';

const makeSheet = (columns, rows, { dateKeys = [], numberKeys = [] } = {}) => {
  const data = [columns.map((column) => column.label), ...rows.map((row) => columns.map(({ key }) => {
    const value = row[key];
    if (dateKeys.includes(key)) return excelDate(value);
    if (numberKeys.includes(key) && value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return value ?? '';
  }))];
  const sheet = XLSX.utils.aoa_to_sheet(data, { cellDates: true });
  sheet['!cols'] = columns.map(({ label, width }) => ({ wch: width || Math.min(42, Math.max(14, label.length + 3)) }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: columns.length - 1 } }) };
  sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  return sheet;
};

export const downloadBackupWorkbook = (filename, title, sheets) => {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, columns, rows, dateKeys, numberKeys }) => {
    XLSX.utils.book_append_sheet(workbook, makeSheet(columns, rows, { dateKeys, numberKeys }), safeSheetName(name));
  });
  workbook.Props = { Title: title, Subject: 'VYAVASTA ERP data export', Author: 'VYAVASTA ERP', Company: 'VYAVASTA' };
  XLSX.writeFile(workbook, filename, { bookType: 'xlsx', cellDates: true });
};

export const buildFullBackupWorkbookSheets = (dataset) => Object.entries(dataset || {}).filter(([, value]) => Array.isArray(value) && value.length).map(([key, rows]) => {
  const keys = [...new Set(rows.flatMap((row) => row && typeof row === 'object' ? Object.keys(row) : ['value']))];
  return {
    name: key,
    columns: keys.map((field) => ({ key: field, label: field })),
    rows: rows.map((row) => row && typeof row === 'object' ? row : { value: row }),
    dateKeys: keys.filter((field) => /(^date$|Date$|At$|timestamp)/i.test(field)),
    numberKeys: keys.filter((field) => /amount|qty|quantity|count|total|price|cost|rate|balance|stock|value|weight|length|width|height/i.test(field) && !/(id|number|no)$/i.test(field))
  };
});
