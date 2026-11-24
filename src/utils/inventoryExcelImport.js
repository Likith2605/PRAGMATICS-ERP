import * as XLSX from 'xlsx';

export const INVENTORY_EXCEL_COLUMNS = [
  'SL.No', 'Item Description', 'Category', 'Unit', 'In Stock', 'Reserved', 'Available', 'Unit Cost', 'Selling Price'
];

export const buildInventoryImportTemplateWorkbook = (example = []) => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([INVENTORY_EXCEL_COLUMNS, example]);
  worksheet['!cols'] = [10, 34, 22, 14, 14, 14, 14, 16, 18].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory Import');
  return workbook;
};

const aliases = {
  slno: 'SL.No', serialno: 'SL.No', serialnumber: 'SL.No', sno: 'SL.No',
  itemdescription: 'Item Description', itemname: 'Item Description', description: 'Item Description', materialname: 'Item Description',
  category: 'Category', inventorycategory: 'Category',
  unit: 'Unit', uom: 'Unit', unitofmeasure: 'Unit', unitofmeasurement: 'Unit',
  instock: 'In Stock', currentstock: 'In Stock', currentqty: 'In Stock', openingstock: 'In Stock',
  reserved: 'Reserved', reservedstock: 'Reserved', reservedqty: 'Reserved',
  available: 'Available', availableqty: 'Available', availablestock: 'Available',
  unitcost: 'Unit Cost', costperunit: 'Unit Cost',
  sellingprice: 'Selling Price', sellingpriceperunit: 'Selling Price', sellprice: 'Selling Price'
};

const normalizeHeading = (value) => String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

export const mapInventoryExcelRow = (row = {}) => {
  const mapped = {};
  for (const [heading, value] of Object.entries(row)) {
    const column = aliases[normalizeHeading(heading)];
    if (column && mapped[column] === undefined) mapped[column] = value;
  }
  return Object.fromEntries(INVENTORY_EXCEL_COLUMNS.map((column) => [column, mapped[column] ?? '']));
};

export const parseInventoryExcelNumber = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value).trim().replace(/[\s,₹$£€]/g, '');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

export const getInventoryAvailableQuantity = (inStock, reserved) =>
  Math.max(0, (parseInventoryExcelNumber(inStock) ?? 0) - (parseInventoryExcelNumber(reserved) ?? 0));

export const validateInventoryExcelRow = (row = {}) => {
  const errors = [];
  if (!String(row['Item Description'] ?? '').trim()) errors.push('Item Description is required');
  for (const field of ['In Stock', 'Reserved', 'Available', 'Unit Cost', 'Selling Price']) {
    const value = row[field];
    if (value === '' || value == null) continue;
    const parsed = parseInventoryExcelNumber(value);
    if (parsed === null || parsed < 0) errors.push(`${field} must be a non-negative number`);
  }
  if (row.Available !== '' && row.Available != null) {
    const available = parseInventoryExcelNumber(row.Available);
    const derived = getInventoryAvailableQuantity(row['In Stock'], row.Reserved);
    if (available !== null && Math.abs(available - derived) > 1e-9) errors.push(`Available must equal In Stock minus Reserved (${derived})`);
  }
  return errors;
};

export const createInventoryItemsFromExcelRows = (rows, existingItems = [], now = Date.now()) => {
  const usedCodes = new Set(existingItems.map((item) => String(item.itemCode || '').toLowerCase()));
  const usedIds = new Set(existingItems.map((item) => String(item.id || '')));
  const prefix = `PRAG-EXCEL-${Number(now).toString(36).toUpperCase()}`;
  return rows.map((row, index) => {
    let itemCode = `${prefix}-${String(index + 1).padStart(3, '0')}`;
    let suffix = 1;
    while (usedCodes.has(itemCode.toLowerCase())) itemCode = `${prefix}-${String(index + 1).padStart(3, '0')}-${suffix++}`;
    usedCodes.add(itemCode.toLowerCase());
    let id = `item-${now}-excel-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${suffix++}`;
    usedIds.add(id);

    const currentQty = parseInventoryExcelNumber(row['In Stock']) ?? 0;
    const reservedQty = parseInventoryExcelNumber(row.Reserved) ?? 0;
    return {
      id,
      itemCode,
      serialNumber: row['SL.No'] ?? '',
      itemName: String(row['Item Description'] ?? ''),
      category: row.Category === '' || row.Category == null ? 'Standard Part' : String(row.Category),
      unit: row.Unit === '' || row.Unit == null ? 'Nos' : String(row.Unit),
      currentQty,
      reservedQty,
      unitCost: parseInventoryExcelNumber(row['Unit Cost']) ?? 0,
      sellingPrice: parseInventoryExcelNumber(row['Selling Price']) ?? 0,
      minReorderLevel: 0,
      maxStockLevel: 0,
      location: ''
    };
  });
};
