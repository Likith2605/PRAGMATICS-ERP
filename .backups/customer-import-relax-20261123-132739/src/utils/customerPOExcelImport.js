import * as XLSX from 'xlsx';

export const CUSTOMER_PO_EXCEL_COLUMNS = [
  'Sl No',
  'PO No',
  'PO Date',
  'Customer Name',
  'Description of Goods',
  'Quantity',
  'Delivered Quantity',
  'Balance Quantity',
  'Price',
  'Amount',
  'PO Balance Quantity Price'
];

const text = (value) => String(value ?? '').trim();
export const normalizeCustomerPOHeader = (value) => text(value)
  .replace(/[\r\n\u2028\u2029]+/g, ' ')
  .replace(/\s+/g, ' ')
  .toLocaleLowerCase();
const number = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const normalized = text(value).replace(/,/g, '').replace(/^₹\s*/, '');
  return normalized === '' ? NaN : Number(normalized);
};
const dateText = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const raw = text(value);
  if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) > 20000 && Number(raw) < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(raw)) * 86400000);
    return date.toISOString().slice(0, 10);
  }
  const parts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (parts) {
    let [, first, second, year] = parts;
    let month, day;
    if (Number(first) > 12) { day = Number(first); month = Number(second); }
    else if (Number(second) > 12) { month = Number(first); day = Number(second); }
    else { day = Number(first); month = Number(second); }
    const date = new Date(Date.UTC(Number(year), month - 1, day));
    if (date.getUTCFullYear() === Number(year) && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return date.toISOString().slice(0, 10);
    return raw;
  }
  return raw;
};
const optionalNumber = (value) => text(value) === '' ? null : number(value);

export const missingCustomerPOColumns = (headers = []) => {
  const present = new Set(headers.map(normalizeCustomerPOHeader));
  return CUSTOMER_PO_EXCEL_COLUMNS.filter((column) => !present.has(normalizeCustomerPOHeader(column)));
};
export const customerPOHeaderOrderIsValid = (headers = []) =>
  CUSTOMER_PO_EXCEL_COLUMNS.every((column, index) => normalizeCustomerPOHeader(headers[index]) === normalizeCustomerPOHeader(column));

export const findCustomerPOHeaderRow = (matrix = []) => {
  let best = { rowIndex: -1, columnIndexes: [], missingColumns: CUSTOMER_PO_EXCEL_COLUMNS, matchedCount: 0, orderValid: false };
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const normalized = (matrix[rowIndex] || []).map(normalizeCustomerPOHeader);
    const columnIndexes = CUSTOMER_PO_EXCEL_COLUMNS.map((column) => normalized.indexOf(normalizeCustomerPOHeader(column)));
    const matchedCount = columnIndexes.filter((index) => index >= 0).length;
    const missingColumns = CUSTOMER_PO_EXCEL_COLUMNS.filter((column, index) => columnIndexes[index] < 0);
    const orderValid = matchedCount === CUSTOMER_PO_EXCEL_COLUMNS.length &&
      columnIndexes.every((index, columnIndex) => index === columnIndexes[0] + columnIndex);
    if (matchedCount > best.matchedCount) best = { rowIndex, columnIndexes, missingColumns, matchedCount, orderValid };
    if (orderValid) return { rowIndex, columnIndexes, missingColumns: [], matchedCount, orderValid };
  }
  return best;
};

const sheetMatrix = (sheet, endRow, endColumn) => XLSX.utils.sheet_to_json(sheet, {
  header: 1,
  range: { s: { r: 0, c: 0 }, e: { r: endRow, c: endColumn } },
  defval: '', raw: true, blankrows: true
});

export const readCustomerPOWorkbook = (workbook) => {
  const candidates = [];
  let best = null;
  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet?.['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const scanEnd = Math.min(range.e.r, 249);
    const header = findCustomerPOHeaderRow(sheetMatrix(sheet, scanEnd, range.e.c));
    if (header.rowIndex < 0) continue;
    if (!best || header.matchedCount > best.header.matchedCount) best = { sheetName, header };
    if (!header.orderValid) continue;

    const body = header.rowIndex < range.e.r
      ? sheetMatrix(sheet, range.e.r, range.e.c).slice(header.rowIndex + 1)
      : [];
    const indexes = header.columnIndexes;
    const populatedRows = body.reduce((count, values) => count + (indexes.some((index) => text(values[index]) !== '') ? 1 : 0), 0);
    const rows = body.map((values, bodyIndex) => {
      const sourceRowIndex = header.rowIndex + bodyIndex + 1;
      return Object.fromEntries(CUSTOMER_PO_EXCEL_COLUMNS.map((column, index) => {
        const cellAddress = XLSX.utils.encode_cell({ r: sourceRowIndex, c: indexes[index] });
        const cell = sheet[cellAddress];
        const value = ['Sl No', 'PO No'].includes(column) && cell ? XLSX.utils.format_cell(cell) : values[indexes[index]];
        return [column, typeof value === 'string' ? value.trim() : value ?? ''];
      }));
    });
    candidates.push({ sheetName, headerRowNumber: header.rowIndex + 1, rows, populatedRows });
  }

  if (!candidates.length) {
    const missingColumns = best?.header.missingColumns || CUSTOMER_PO_EXCEL_COLUMNS;
    const location = best ? ` in worksheet "${best.sheetName}" near row ${best.header.rowIndex + 1}` : ' in any worksheet';
    if (best && best.header.matchedCount === CUSTOMER_PO_EXCEL_COLUMNS.length) {
      throw new Error(`Found all required Customer PO headings${location}, but they are not in the expected order.`);
    }
    throw new Error(`Could not find all 11 required Customer PO headings${location}. Missing: ${missingColumns.join(', ')}.`);
  }
  candidates.sort((left, right) => right.populatedRows - left.populatedRows);
  const selected = candidates[0];
  if (selected.populatedRows > 5000) throw new Error('Files are limited to 5,000 Customer PO data rows.');
  return selected;
};

export const parseCustomerPOExcelRows = (rows = [], validate = () => [], headerRowIndex = 0) => {
  const groups = [];
  let current = null;
  rows.forEach((row, index) => {
    const poNumber = text(row['PO No']);
    const poDate = row['PO Date'];
    const customerName = text(row['Customer Name']);
    const startsPO = Boolean(poNumber || text(poDate) || customerName);
    const hasItemData = CUSTOMER_PO_EXCEL_COLUMNS.some((column) => text(row[column]) !== '');
    if (!startsPO && !hasItemData) return;
    if (startsPO) {
      current = {
        row: null,
        rowNumber: index + headerRowIndex + 2,
        rows: [],
        errors: [],
        poNumber,
        poDate: dateText(poDate),
        customerName,
        poBalanceValue: optionalNumber(row['PO Balance Quantity Price']),
        items: []
      };
      groups.push(current);
    } else if (!current) {
      current = {
        row: null,
        rowNumber: index + headerRowIndex + 2,
        rows: [],
        errors: ['Item row has no preceding PO No, PO Date and Customer Name header.'],
        poNumber: '', poDate: '', customerName: '', poBalanceValue: NaN, items: []
      };
      groups.push(current);
    }

    const sourceRow = index + headerRowIndex + 2;
    const source = { ...row, 'Source Row': sourceRow };
    current.rows.push(source);
    const poBalanceValue = optionalNumber(row['PO Balance Quantity Price']);
    if (current.poBalanceValue == null && poBalanceValue != null) current.poBalanceValue = poBalanceValue;
    const description = text(row['Description of Goods']);
    if (description || startsPO) {
      current.items.push({
        serialNumber: text(row['Sl No']),
        description,
        quantity: number(row.Quantity),
        deliveredQuantity: number(row['Delivered Quantity']),
        balanceQuantity: number(row['Balance Quantity']),
        unitPrice: number(row.Price),
        amount: number(row.Amount),
        poBalanceQuantityPrice: optionalNumber(row['PO Balance Quantity Price']),
        sourceRow
      });
    }
  });

  const duplicates = new Map();
  groups.forEach((group) => {
    const key = group.poNumber.toLocaleLowerCase();
    if (key) duplicates.set(key, (duplicates.get(key) || 0) + 1);
  });
  groups.forEach((group) => {
    if (group.poNumber && duplicates.get(group.poNumber.toLocaleLowerCase()) > 1) {
      group.errors.push('Duplicate PO No in uploaded file.');
    }
    const record = {
      poNumber: group.poNumber,
      poDate: group.poDate,
      customerName: group.customerName,
      poBalanceValue: group.poBalanceValue,
      items: group.items.map(({ sourceRow, ...item }) => item)
    };
    group.errors.push(...(validate(record) || []));
    group.row = record;
  });
  return groups;
};

export const validateCustomerPOExcelRecord = (record) => {
  const errors = [];
  if (!record.poNumber) errors.push('PO No is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.poDate) || Number.isNaN(Date.parse(`${record.poDate}T00:00:00Z`)) || new Date(`${record.poDate}T00:00:00Z`).toISOString().slice(0, 10) !== record.poDate) {
    errors.push('PO Date is required and must be a valid date.');
  }
  if (!record.customerName) errors.push('Customer Name is required.');
  if (!record.items.length) errors.push('At least one Description of Goods item row is required.');
  record.items.forEach((item, index) => {
    const itemLabel = `Item ${index + 1}`;
    if (!item.description) errors.push(`${itemLabel}: Description of Goods is required.`);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) errors.push(`${itemLabel}: Quantity must be a number greater than zero.`);
    if (!Number.isFinite(item.deliveredQuantity) || item.deliveredQuantity < 0 || item.deliveredQuantity > item.quantity) errors.push(`${itemLabel}: Delivered Quantity must be between zero and Quantity.`);
    if (!Number.isFinite(item.balanceQuantity) || item.balanceQuantity < 0) errors.push(`${itemLabel}: Balance Quantity must be a non-negative number.`);
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) errors.push(`${itemLabel}: Price must be a non-negative number.`);
    if (!Number.isFinite(item.amount) || item.amount < 0) errors.push(`${itemLabel}: Amount must be a non-negative number.`);
  });
  if (record.poBalanceValue != null && (!Number.isFinite(record.poBalanceValue) || record.poBalanceValue < 0)) errors.push('PO Balance Quantity Price must be a non-negative number.');
  return errors;
};
