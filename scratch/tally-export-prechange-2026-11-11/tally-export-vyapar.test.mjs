/**
 * Tally Export — Vyapar-style Workflow Tests
 *
 * Tests the redesigned Export to Tally service:
 *   1. Date range presets (Today, Yesterday, This Week, This Month, Previous Month, Current FY, Previous FY, Custom)
 *   2. buildTransactionRows — flat transaction rows from ERP records
 *   3. mapSelectedToTally — mapping selected rows to Tally vouchers + masters
 *   4. XML generation (master.xml + voucher.xml)
 *   5. Validation (balanced vouchers, missing masters, GST details)
 *   6. Export history statuses (Generated, Downloaded, Import Pending, Import Confirmed, Import Failed)
 *
 * Run: node tests/tally-export-vyapar.test.mjs
 */

import {
  computeDateRange,
  DATE_PRESETS,
  TransactionTypes,
  TRANSACTION_TYPE_LABELS,
  DEFAULT_SELECTED_TYPES,
  buildTransactionRows,
  mapSelectedToTally,
  generateXml
} from '../src/services/tallyExportService.js';
import { validateTallyXml } from '../src/utils/tallyXmlGenerator.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

const assert = (condition, message) => {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
};

const assertEqual = (actual, expected, message) => {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message} — expected "${expected}", got "${actual}"`);
  }
};

const section = (name) => {
  console.log(`\n${name}`);
  console.log('-'.repeat(name.length));
};

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

const company = {
  companyName: 'PRAGMATIC ENGINEERS',
  gstin: '29AKWPP8736E1ZA',
  pan: 'AKWPP8736E',
  state: 'Karnataka (29)'
};

const customerRecord = {
  date: '2024-01-15',
  reference: 'INV-2024-001',
  company: 'BOSCH LIMITED',
  total: '₹ 118000.00',
  status: 'Pending',
  payload: {
    invoiceDetails: {
      invoiceNumber: 'INV-2024-001',
      invoiceDate: '2024-01-15',
      taxMode: 'intra',
      projectId: 'PE-2024-001',
      amountReceived: '50000',
      paymentReference: 'REF-001',
      paymentMode: 'Bank Transfer'
    },
    customerDetails: {
      customerName: 'BOSCH LIMITED',
      companyName: 'BOSCH LIMITED',
      gstNumber: '29AAACM9840P1ZP',
      gstin: '29AAACM9840P1ZP',
      state: 'Karnataka (29)',
      contactNumber: '8061867312',
      email: 'nagaraj@bosch.com'
    },
    items: [
      { itemName: 'Machining Part A', hsnSac: '8483', quantity: 10, unit: 'Nos', unitPrice: 10000, gst: 18, amount: 100000, gstAmount: 18000 }
    ],
    totals: {
      subtotal: 100000,
      taxableAmount: 100000,
      totalGST: 18000,
      cgst: 9000,
      sgst: 9000,
      igst: 0,
      grandTotal: 118000,
      taxMode: 'intra'
    }
  }
};

const supplierRecord = {
  date: '2024-01-20',
  reference: 'SUP-INV-001',
  vendor: 'SKF INDIA LTD, BANGALORE',
  total: '₹ 59000.00',
  status: 'Pending',
  payload: {
    invoiceDetails: {
      supplierInvoiceNumber: 'SUP-INV-001',
      supplierInvoiceDate: '2024-01-20',
      taxMode: 'intra',
      projectId: 'PE-2024-002',
      amountPaid: '30000',
      paymentReference: 'PAY-001',
      paymentMode: 'NEFT'
    },
    vendorDetails: {
      vendorName: 'SKF INDIA LTD, BANGALORE',
      companyName: 'SKF INDIA LTD, BANGALORE',
      gstNumber: '29AAACS0684H1Z8',
      gstin: '29AAACS0684H1Z8',
      state: 'Karnataka (29)',
      contactNumber: '4032992330',
      email: 'abc@skf.com'
    },
    items: [
      { itemName: 'Ball Bearing 6201', hsnSac: '8482', quantity: 100, unit: 'Nos', unitPrice: 500, gst: 18, amount: 50000, gstAmount: 9000 }
    ],
    totals: {
      subtotal: 50000,
      taxableAmount: 50000,
      totalGST: 9000,
      cgst: 4500,
      sgst: 4500,
      igst: 0,
      grandTotal: 59000,
      taxMode: 'intra'
    }
  }
};

const vendorMaster = [
  { seq: 1, product: 'Bearings', name: 'SKF INDIA LTD, BANGALORE', address: 'BOMMASANDRA', phone: '4032992330', email: 'abc@skf.com' }
];

const debitNoteRecord = {
  date: '2024-02-01',
  reference: 'DN-001',
  vendor: 'SKF INDIA LTD, BANGALORE',
  payload: {
    debitNoteDetails: {
      debitNoteNumber: 'DN-001',
      debitNoteDate: '2024-02-01',
      amount: '5000',
      reason: 'Damaged goods',
      originalInvoiceRef: 'SUP-INV-001'
    },
    vendorDetails: vendorMaster[0],
    total: 5000
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('═'.repeat(60));
  console.log('TALLY EXPORT — VYAPAR-STYLE WORKFLOW TESTS');
  console.log('═'.repeat(60));

  // ── 1. Date Range Presets ──
  section('1. Date Range Presets');

  assertEqual(DATE_PRESETS.length, 8, '8 date presets defined');
  const presetKeys = DATE_PRESETS.map((p) => p.key);
  assert(presetKeys.includes('today'), 'Today preset');
  assert(presetKeys.includes('yesterday'), 'Yesterday preset');
  assert(presetKeys.includes('this_week'), 'This Week preset');
  assert(presetKeys.includes('this_month'), 'This Month preset');
  assert(presetKeys.includes('previous_month'), 'Previous Month preset');
  assert(presetKeys.includes('current_fy'), 'Current Financial Year preset');
  assert(presetKeys.includes('previous_fy'), 'Previous Financial Year preset');
  assert(presetKeys.includes('custom'), 'Custom Date Range preset');

  // Test current_fy (April 1 to March 31)
  const d = new Date();
  const month = d.getMonth();
  const fyYear = month >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const fyRange = computeDateRange('current_fy');
  assertEqual(fyRange.from, `${fyYear}-04-01`, 'Current FY starts April 1');
  assertEqual(fyRange.to, `${fyYear + 1}-03-31`, 'Current FY ends March 31');

  // Test today
  const todayRange = computeDateRange('today');
  const todayIso = new Date().toISOString().slice(0, 10);
  assertEqual(todayRange.from, todayIso, 'Today from = today');
  assertEqual(todayRange.to, todayIso, 'Today to = today');

  // Test custom
  const customRange = computeDateRange('custom', '2024-01-01', '2024-01-31');
  assertEqual(customRange.from, '2024-01-01', 'Custom from date');
  assertEqual(customRange.to, '2024-01-31', 'Custom to date');

  // ── 2. Transaction Types ──
  section('2. Transaction Types');

  assertEqual(Object.values(TransactionTypes).length, 6, '6 transaction types');
  assertEqual(TransactionTypes.SALE, 'sale', 'Sale type');
  assertEqual(TransactionTypes.PURCHASE, 'purchase', 'Purchase type');
  assertEqual(TransactionTypes.CREDIT_NOTE, 'creditNote', 'Credit Note type');
  assertEqual(TransactionTypes.DEBIT_NOTE, 'debitNote', 'Debit Note type');
  assertEqual(TransactionTypes.CUSTOMER_RECEIPT, 'customerReceipt', 'Customer Receipt type');
  assertEqual(TransactionTypes.SUPPLIER_PAYMENT, 'supplierPayment', 'Supplier Payment type');

  assertEqual(TRANSACTION_TYPE_LABELS[TransactionTypes.SALE], 'Sale', 'Sale label');
  assertEqual(TRANSACTION_TYPE_LABELS[TransactionTypes.PURCHASE], 'Purchase', 'Purchase label');
  assertEqual(TRANSACTION_TYPE_LABELS[TransactionTypes.CREDIT_NOTE], 'Credit Note', 'Credit Note label');
  assertEqual(TRANSACTION_TYPE_LABELS[TransactionTypes.DEBIT_NOTE], 'Debit Note', 'Debit Note label');

  assertEqual(DEFAULT_SELECTED_TYPES.length, 4, '4 default selected types');
  assert(DEFAULT_SELECTED_TYPES.includes(TransactionTypes.SALE), 'Sale in defaults');
  assert(DEFAULT_SELECTED_TYPES.includes(TransactionTypes.PURCHASE), 'Purchase in defaults');
  assert(DEFAULT_SELECTED_TYPES.includes(TransactionTypes.CREDIT_NOTE), 'Credit Note in defaults');
  assert(DEFAULT_SELECTED_TYPES.includes(TransactionTypes.DEBIT_NOTE), 'Debit Note in defaults');

  // ── 3. buildTransactionRows ──
  section('3. buildTransactionRows');

  // Mock localStorage
  const originalLocalStorage = globalThis.localStorage;
  const store = new Map();
  const mockLS = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
  globalThis.localStorage = mockLS;

  store.set('companySettings', JSON.stringify(company));
  store.set('customerInvoiceHistory', JSON.stringify([customerRecord]));
  store.set('supplierInvoiceHistory', JSON.stringify([supplierRecord]));
  store.set('vendorMaster', JSON.stringify(vendorMaster));
  store.set('debitNotes', JSON.stringify([debitNoteRecord]));

  // Test with Sale + Purchase types
  const rowsSP = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SALE, TransactionTypes.PURCHASE]
  });
  assertEqual(rowsSP.length, 2, 'Sale + Purchase = 2 rows');
  const saleRow = rowsSP.find((r) => r.transactionType === TransactionTypes.SALE);
  const purchaseRow = rowsSP.find((r) => r.transactionType === TransactionTypes.PURCHASE);
  assert(saleRow !== undefined, 'Sale row present');
  assert(purchaseRow !== undefined, 'Purchase row present');

  if (saleRow) {
    assertEqual(saleRow.invoiceNo, 'INV-2024-001', 'Sale invoice number');
    assertEqual(saleRow.partyName, 'BOSCH LIMITED', 'Sale party name');
    assertEqual(saleRow.amount, 118000, 'Sale amount');
    assertEqual(saleRow.balance, 68000, 'Sale balance (118000 - 50000)');
    assertEqual(saleRow.projectId, 'PE-2024-001', 'Sale project ID');
    assertEqual(saleRow.gstAmount, 18000, 'Sale GST amount');
    assertEqual(saleRow.paymentType, 'Bank Transfer', 'Sale payment type');
    assert(typeof saleRow.mappingFn === 'function', 'Sale has mapping function');
  }

  if (purchaseRow) {
    assertEqual(purchaseRow.invoiceNo, 'SUP-INV-001', 'Purchase invoice number');
    assertEqual(purchaseRow.partyName, 'SKF INDIA LTD, BANGALORE', 'Purchase party name');
    assertEqual(purchaseRow.amount, 59000, 'Purchase amount');
    assertEqual(purchaseRow.balance, 29000, 'Purchase balance (59000 - 30000)');
    assertEqual(purchaseRow.projectId, 'PE-2024-002', 'Purchase project ID');
    assertEqual(purchaseRow.paymentType, 'NEFT', 'Purchase payment type');
  }

  // Test with Customer Receipt type
  const rowsReceipt = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.CUSTOMER_RECEIPT]
  });
  assertEqual(rowsReceipt.length, 1, 'Customer Receipt = 1 row (has amountReceived)');
  if (rowsReceipt[0]) {
    assertEqual(rowsReceipt[0].transactionType, TransactionTypes.CUSTOMER_RECEIPT, 'Receipt type');
    assertEqual(rowsReceipt[0].amount, 50000, 'Receipt amount = amountReceived');
    assertEqual(rowsReceipt[0].balance, 0, 'Receipt balance = 0');
  }

  // Test with Supplier Payment type
  const rowsPayment = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SUPPLIER_PAYMENT]
  });
  assertEqual(rowsPayment.length, 1, 'Supplier Payment = 1 row (has amountPaid)');
  if (rowsPayment[0]) {
    assertEqual(rowsPayment[0].transactionType, TransactionTypes.SUPPLIER_PAYMENT, 'Payment type');
    assertEqual(rowsPayment[0].amount, 30000, 'Payment amount = amountPaid');
  }

  // Test with Debit Note type
  const rowsDN = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-02-28',
    selectedTypes: [TransactionTypes.DEBIT_NOTE]
  });
  assertEqual(rowsDN.length, 1, 'Debit Note = 1 row');
  if (rowsDN[0]) {
    assertEqual(rowsDN[0].transactionType, TransactionTypes.DEBIT_NOTE, 'Debit Note type');
    assertEqual(rowsDN[0].amount, 5000, 'Debit Note amount');
  }

  // Test date range filtering
  const rowsFiltered = buildTransactionRows({
    dateFrom: '2024-01-16',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SALE, TransactionTypes.PURCHASE]
  });
  assertEqual(rowsFiltered.length, 1, 'Date filter: only purchase (Jan 20) in range');
  if (rowsFiltered[0]) {
    assertEqual(rowsFiltered[0].transactionType, TransactionTypes.PURCHASE, 'Only purchase remains');
  }

  // Test empty types
  const rowsEmpty = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: []
  });
  assertEqual(rowsEmpty.length, 0, 'No types = no rows');

  // ── 4. mapSelectedToTally ──
  section('4. mapSelectedToTally');

  const allRows = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SALE, TransactionTypes.PURCHASE]
  });

  const result = mapSelectedToTally({ selectedRows: allRows, company });
  assert(result.vouchers.length >= 1, 'At least 1 valid voucher');
  assert(result.masters.customerLedgers.length >= 1, 'Customer ledgers collected');
  assert(result.masters.supplierLedgers.length >= 1, 'Supplier ledgers collected');
  assert(result.masters.stockItems.length >= 1, 'Stock items collected');
  assert(result.masters.units.length >= 1, 'Units collected');

  // Check voucher balance
  result.vouchers.forEach((v) => {
    assert(v.isBalanced, `Voucher ${v.voucherNumber} is balanced`);
  });

  // Check counts
  assert(result.counts.sales >= 1, 'Sales count >= 1');
  assert(result.counts.purchases >= 1, 'Purchase count >= 1');

  // Check totals
  assert(result.totals.totalGrand > 0, 'Total grand > 0');

  // Test with empty selection
  const emptyResult = mapSelectedToTally({ selectedRows: [], company });
  assertEqual(emptyResult.vouchers.length, 0, 'Empty selection = no vouchers');
  assertEqual(emptyResult.invalidVouchers.length, 0, 'Empty selection = no invalid');

  // ── 5. XML Generation ──
  section('5. XML Generation');

  const xml = generateXml({
    masters: result.masters,
    vouchers: result.vouchers,
    company
  });

  assert(xml.masterValid, 'master.xml is valid', `Errors: ${xml.masterErrors.join(', ')}`);
  assert(xml.voucherValid, 'voucher.xml is valid', `Errors: ${xml.voucherErrors.join(', ')}`);

  assert(xml.masterXml.includes('<ENVELOPE>'), 'master.xml has ENVELOPE');
  assert(xml.masterXml.includes('<REPORTNAME>All Masters</REPORTNAME>'), 'master.xml report name');
  assert(xml.masterXml.includes('<LEDGER'), 'master.xml has LEDGER elements');
  assert(xml.masterXml.includes('<STOCKITEM'), 'master.xml has STOCKITEM elements');
  assert(xml.masterXml.includes('<UNIT'), 'master.xml has UNIT elements');

  assert(xml.voucherXml.includes('<ENVELOPE>'), 'voucher.xml has ENVELOPE');
  assert(xml.voucherXml.includes('<REPORTNAME>Voucher</REPORTNAME>'), 'voucher.xml report name');
  assert(xml.voucherXml.includes('<VOUCHER'), 'voucher.xml has VOUCHER elements');

  // Check no unescaped ampersands
  assert(!xml.masterXml.match(/&(?![a-zA-Z]+;)/g), 'master.xml no unescaped ampersands');
  assert(!xml.voucherXml.match(/&(?![a-zA-Z]+;)/g), 'voucher.xml no unescaped ampersands');

  // Validate via validateTallyXml
  const masterVal = validateTallyXml(xml.masterXml, 'master');
  assert(masterVal.valid, 'master.xml passes validateTallyXml', masterVal.errors.join(', '));
  const voucherVal = validateTallyXml(xml.voucherXml, 'voucher');
  assert(voucherVal.valid, 'voucher.xml passes validateTallyXml', voucherVal.errors.join(', '));

  // ── 6. Voucher Types in XML ──
  section('6. Voucher Types');

  const voucherTypes = result.vouchers.map((v) => v.voucherType);
  assert(voucherTypes.includes('Sales'), 'Sales voucher type present');
  assert(voucherTypes.includes('Purchase'), 'Purchase voucher type present');

  // ── 7. Debit Note + Credit Note ──
  section('7. Debit Note & Credit Note');

  const rowsDNCN = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-02-28',
    selectedTypes: [TransactionTypes.DEBIT_NOTE, TransactionTypes.CREDIT_NOTE]
  });
  // Debit note exists, credit note doesn't (no credit note data in test records)
  const dnRow = rowsDNCN.find((r) => r.transactionType === TransactionTypes.DEBIT_NOTE);
  assert(dnRow !== undefined, 'Debit note row present');

  const resultDN = mapSelectedToTally({ selectedRows: [dnRow], company });
  assert(resultDN.vouchers.length === 1, 'Debit note mapped to 1 voucher');
  if (resultDN.vouchers[0]) {
    assertEqual(resultDN.vouchers[0].voucherType, 'Debit Note', 'Debit Note voucher type');
  }

  // ── 8. Restore localStorage ──
  globalThis.localStorage = originalLocalStorage;

  // ── Summary ──
  console.log('\n' + '═'.repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
