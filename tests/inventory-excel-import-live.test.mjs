import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import XLSX from 'xlsx';
import { INVENTORY_EXCEL_COLUMNS, mapInventoryExcelRow, validateInventoryExcelRow, createInventoryItemsFromExcelRows } from '../src/utils/inventoryExcelImport.js';

const port = 3350;
const base = `http://127.0.0.1:${port}/api`;
const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), QC_PULL_ENABLED: '0' }, stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let token = '';
let testId = '';
let saved = false;

const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await pause(250);
  }
  assert.ok(ready, 'test Express API starts with PostgreSQL available');
  const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.ERP_ADMIN_EMAIL, password: process.env.ERP_ADMIN_PASSWORD, portal: 'admin' }) });
  assert.equal(login.status, 200);
  token = login.data.token;

  const incoming = [{ 'SL.No': 'LIVE-001', 'Item Description': 'QA inventory import live test', Category: 'QA Category', Unit: 'QA Unit', 'In Stock': 37, Reserved: 7, Available: 30, 'Unit Cost': 12.5, 'Selling Price': 19.75 }];
  const worksheet = XLSX.utils.aoa_to_sheet([INVENTORY_EXCEL_COLUMNS, ...incoming.map((row) => INVENTORY_EXCEL_COLUMNS.map((key) => row[key]))]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory Import');
  const uploadedBytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const parsed = XLSX.read(uploadedBytes, { type: 'buffer', raw: false });
  const uploadedRows = XLSX.utils.sheet_to_json(parsed.Sheets['Inventory Import'], { defval: '', raw: false, blankrows: false }).map(mapInventoryExcelRow);
  assert.equal(uploadedRows.length, 1, 'uploaded workbook produces one preview row');
  assert.deepEqual(validateInventoryExcelRow(uploadedRows[0]), [], 'preview row passes validation');

  const existingResult = await request('/records/inventoryItems');
  assert.equal(existingResult.status, 200);
  const existingItems = (existingResult.data.records || []).map((record) => record.data);
  const [newItem] = createInventoryItemsFromExcelRows(uploadedRows, existingItems);
  testId = newItem.id;
  const saveResult = await request('/records/inventoryItems', { method: 'PUT', body: JSON.stringify({ records: [{ id: newItem.id, data: newItem, version: 0 }] }) });
  assert.equal(saveResult.status, 200, `inventory module save succeeds: ${saveResult.data.error || ''}`);
  saved = true;
  const persistedResult = await request('/records/inventoryItems');
  const persisted = persistedResult.data.records.find((record) => record.id === testId);
  assert.ok(persisted, 'item appears in PostgreSQL module records');
  assert.equal(persisted.data.itemName, 'QA inventory import live test');
  assert.equal(persisted.data.serialNumber, 'LIVE-001');
  assert.equal(persisted.data.currentQty, 37);
  assert.equal(persisted.data.reservedQty, 7);
  assert.equal(persisted.data.unitCost, 12.5);
  assert.equal(persisted.data.sellingPrice, 19.75);
  assert.equal(Math.max(0, persisted.data.currentQty - persisted.data.reservedQty), 30);
  console.log('Live Inventory Excel/API check passed: workbook previewed, item saved to PostgreSQL and read back with correct stock values.');
} finally {
  if (token && saved && testId) {
    try {
      const current = await request('/records/inventoryItems');
      const record = current.data.records?.find((entry) => entry.id === testId);
      if (record) {
        let version = record.version;
        let data = record.data;
        if (Number(data.currentQty) !== 0 || Number(data.reservedQty) !== 0) {
          const cleared = { ...data, currentQty: 0, reservedQty: 0 };
          const update = await request('/records/inventoryItems', { method: 'PUT', body: JSON.stringify({ records: [{ id: testId, data: cleared, version }] }) });
          if (update.status === 200 && update.data.saved?.length) { version = update.data.saved[0].version; data = cleared; }
        }
        if (Number(data.currentQty) === 0 && Number(data.reservedQty) === 0) {
          await request('/records/inventoryItems', { method: 'PUT', body: JSON.stringify({ deletes: [{ id: testId, version, reason: 'Clean up live Inventory Excel import test fixture.' }] }) });
        }
      }
    } catch { /* preserve test result */ }
  }
  server.kill();
}
