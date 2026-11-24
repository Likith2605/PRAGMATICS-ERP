import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {
  INVENTORY_EXCEL_COLUMNS,
  buildInventoryImportTemplateWorkbook,
  mapInventoryExcelRow,
  validateInventoryExcelRow,
  getInventoryAvailableQuantity,
  createInventoryItemsFromExcelRows
} from '../src/utils/inventoryExcelImport.js';

const expectedColumns = ['SL.No', 'Item Description', 'Category', 'Unit', 'In Stock', 'Reserved', 'Available', 'Unit Cost', 'Selling Price'];
assert.deepEqual(INVENTORY_EXCEL_COLUMNS, expectedColumns, 'inventory template headings and order are exact');

const template = buildInventoryImportTemplateWorkbook(['1', 'Sample steel', 'Raw Material', 'Kg', 120, 20, 100, 85, 95]);
const templateBytes = XLSX.write(template, { type: 'buffer', bookType: 'xlsx' });
assert.equal(templateBytes.subarray(0, 2).toString(), 'PK', 'template is a genuine XLSX ZIP workbook');
const reopenedTemplate = XLSX.read(templateBytes, { type: 'buffer' });
assert.deepEqual(XLSX.utils.sheet_to_json(reopenedTemplate.Sheets['Inventory Import'], { header: 1 })[0], expectedColumns);
assert.equal(XLSX.utils.sheet_to_json(reopenedTemplate.Sheets['Inventory Import'], { header: 1 })[1].length, 9);

const sourceRows = [
  {
    's.l. no': '0007',
    'item-description': '  Extra long steel plate / grade X  ',
    'INVENTORY Category': 'Custom / category 2026',
    'Unit of Measurement': 'm² / special',
    'Current Stock': '1,200.5',
    'reserved_qty': 200.5,
    'Available Qty': '1,000.00',
    'Cost per Unit': '₹ 1,250.50',
    'Selling Price per Unit': '₹ 1,500.75'
  },
  { 's.l. no': '0008', 'item-description': 'Second item', 'INVENTORY Category': '', 'Unit of Measurement': '', 'Current Stock': '', 'reserved_qty': '', 'Available Qty': '', 'Cost per Unit': '', 'Selling Price per Unit': '' }
];
const worksheet = XLSX.utils.json_to_sheet(sourceRows);
const sourceWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(sourceWorkbook, worksheet, 'Items');
const importedWorkbook = XLSX.read(XLSX.write(sourceWorkbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', raw: false, cellDates: true, formula: false });
const parsedRows = XLSX.utils.sheet_to_json(importedWorkbook.Sheets.Items, { defval: '', raw: false, blankrows: false });
const previewRows = parsedRows.map(mapInventoryExcelRow);
assert.equal(previewRows.length, 2, 'preview preserves all non-empty spreadsheet rows');
assert.equal(previewRows[0]['SL.No'], '0007', 'serial number keeps leading zeros');
assert.equal(previewRows[0]['Item Description'], '  Extra long steel plate / grade X  ', 'description value is preserved');
assert.equal(previewRows[0].Category, 'Custom / category 2026', 'custom category is preserved');
assert.equal(previewRows[0].Unit, 'm² / special', 'custom unit is preserved');
assert.equal(mapInventoryExcelRow({ 'Item Name': 'Legacy item heading' })['Item Description'], 'Legacy item heading', 'legacy item-name heading is recognized');
assert.deepEqual(previewRows.map(validateInventoryExcelRow), [[], []], 'both rows pass preview validation');
assert.deepEqual(validateInventoryExcelRow({ ...previewRows[0], Available: '999' }), ['Available must equal In Stock minus Reserved (1000)']);
assert.equal(getInventoryAvailableQuantity('1,200.5', 200.5), 1000, 'availability is on hand minus reserved exactly once');

const existing = [{ id: 'existing-id', itemCode: 'PRAG-EXCEL-ME', itemName: 'Existing stock', currentQty: 50, reservedQty: 5 }];
const newItems = createInventoryItemsFromExcelRows(previewRows, existing, 123456789);
assert.equal(newItems.length, 2, 'duplicate names and missing optional fields do not silently skip rows');
assert.equal(newItems[0].serialNumber, '0007');
assert.equal(newItems[0].itemName, sourceRows[0]['item-description']);
assert.equal(newItems[0].category, sourceRows[0]['INVENTORY Category']);
assert.equal(newItems[0].unit, sourceRows[0]['Unit of Measurement']);
assert.equal(newItems[0].currentQty, 1200.5);
assert.equal(newItems[0].reservedQty, 200.5);
assert.equal(newItems[0].unitCost, 1250.5);
assert.equal(newItems[0].sellingPrice, 1500.75);
assert.equal(getInventoryAvailableQuantity(newItems[0].currentQty, newItems[0].reservedQty), 1000);
assert.equal(newItems[1].category, 'Standard Part');
assert.equal(newItems[1].unit, 'Nos');
assert.ok(newItems.every((item) => item.id !== existing[0].id && item.itemCode !== existing[0].itemCode));
assert.equal(new Set([...existing, ...newItems].map((item) => item.itemCode.toLowerCase())).size, 3, 'generated item codes stay unique without replacing existing codes');
assert.equal(existing[0].currentQty, 50, 'existing stock quantity is not overwritten');

console.log('Inventory Excel import checks passed: exact XLSX template, alias mapping, preview validation, stock arithmetic, and append-only records.');
