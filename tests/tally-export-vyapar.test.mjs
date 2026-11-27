/**
 * Tally Export — Vyapar-style Workflow Tests
 *
 * Tests the redesigned Export to Tally service:
 *   1. Manual date range validation and inclusive boundaries
 *   2. buildTransactionRows — flat transaction rows from ERP records
 *   3. mapSelectedToTally — mapping selected rows to Tally vouchers + masters
 *   4. XML generation (master.xml + voucher.xml)
 *   5. Validation (balanced vouchers, missing masters, GST details)
 *   6. Export duplicate prevention and retry handling
 *
 * Run: node tests/tally-export-vyapar.test.mjs
 */

import {
  TransactionTypes,
  TRANSACTION_TYPE_LABELS,
  DEFAULT_SELECTED_TYPES,
  DATE_PRESETS,
  computeDateRange,
  validateDateRange,
  excludePreviouslyExportedRows,
  buildTransactionRows,
  mapSelectedToTally,
  generateXml
} from '../src/services/tallyExportService.js';
import { validateTallyXml } from '../src/utils/tallyXmlGenerator.js';
import { validateVouchers } from '../src/utils/tallyMapper.js';

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
  debitNoteNumber: 'DN-001',
  debitNoteDate: '2024-02-01',
  status: 'Recorded by Purchase',
  vendor: 'SKF INDIA LTD, BANGALORE',
  taxableAmount: 5000,
  totalGST: 0,
  cgst: 0,
  sgst: 0,
  igst: 0,
  grandTotal: 5000,
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
  section('1. Custom Date Range Validation');

  assert(validateDateRange('2024-01-01', '2024-01-31').valid, 'Valid custom range accepted');
  assert(validateDateRange('2024-01-31', '2024-01-31').valid, 'Same-day range accepted');
  assert(!validateDateRange('2024-02-31', '2024-03-01').valid, 'Impossible calendar date rejected');
  assert(!validateDateRange('2024-02-01', '2024-01-31').valid, 'Reversed date range rejected');
  assert(!validateDateRange('2024-01-01', '').valid, 'Missing date rejected');

  const periods = DATE_PRESETS.map(({ label }) => label);
  assertEqual(periods.join('|'), 'All|This Month|Last Month|This Quarter|This Year|Custom', 'All six requested date periods are present in order');
  const dateAt = (year, month, day) => new Date(year, month - 1, day, 12);
  const expectRange = (key, now, from, to, label) => {
    const range = computeDateRange(key, '', '', now);
    assertEqual(`${range.from}|${range.to}`, `${from}|${to}`, label);
  };
  expectRange('all', dateAt(2025, 1, 15), '', '', 'All removes date restrictions');
  expectRange('this_month', dateAt(2024, 2, 15), '2024-02-01', '2024-02-29', 'This Month handles leap February');
  expectRange('last_month', dateAt(2025, 1, 15), '2024-12-01', '2024-12-31', 'Last Month crosses year boundary');
  expectRange('this_quarter', dateAt(2025, 12, 31), '2025-10-01', '2025-12-31', 'This Quarter handles Q4 year end');
  expectRange('this_quarter', dateAt(2025, 4, 1), '2025-04-01', '2025-06-30', 'This Quarter starts at quarter boundary');
  expectRange('this_year', dateAt(2025, 12, 31), '2025-01-01', '2025-12-31', 'This Year uses calendar year boundaries');
  const customRange = computeDateRange('custom', '2024-03-01', '2024-03-31', dateAt(2025, 1, 1));
  assertEqual(`${customRange.from}|${customRange.to}`, '2024-03-01|2024-03-31', 'Custom preserves manually selected dates');
  assert(validateDateRange(customRange.from, customRange.to).valid, 'Valid custom date range applies');
  assert(!validateDateRange('2024-03-31', '2024-03-01').valid, 'Reversed custom date range rejected');
  assert(!validateDateRange('2025-02-29', '2025-03-01').valid, 'Invalid leap day custom date rejected');

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

  const sourceRecords = {
    customerInvoices: [customerRecord],
    supplierInvoices: [supplierRecord],
    debitNotes: [debitNoteRecord],
    vendorMaster,
    company
  };

  // Test with Sale + Purchase types
  const rowsSP = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SALE, TransactionTypes.PURCHASE],
    ...sourceRecords
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

  // Inclusive boundary dates and voucher-date filtering.
  const beforeBoundary = { ...customerRecord, date: '2023-12-31', reference: 'INV-BEFORE', payload: { ...customerRecord.payload, invoiceDetails: { ...customerRecord.payload.invoiceDetails, invoiceDate: '2023-12-31', invoiceNumber: 'INV-BEFORE' } } };
  const fromBoundary = { ...customerRecord, date: '2024-01-01', reference: 'INV-FROM', payload: { ...customerRecord.payload, invoiceDetails: { ...customerRecord.payload.invoiceDetails, invoiceDate: '2024-01-01', invoiceNumber: 'INV-FROM' } } };
  const toBoundary = { ...customerRecord, date: '2024-01-31', reference: 'INV-TO', payload: { ...customerRecord.payload, invoiceDetails: { ...customerRecord.payload.invoiceDetails, invoiceDate: '2024-01-31', invoiceNumber: 'INV-TO' } } };
  const boundaryRows = buildTransactionRows({
    dateFrom: '2024-01-01', dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SALE],
    ...sourceRecords,
    customerInvoices: [beforeBoundary, fromBoundary, toBoundary]
  });
  assertEqual(boundaryRows.length, 2, 'Both date boundaries included and outside date excluded');
  assert(boundaryRows.some((row) => row.invoiceNo === 'INV-FROM'), 'From Date transaction included');
  assert(boundaryRows.some((row) => row.invoiceNo === 'INV-TO'), 'To Date transaction included');
  // Duplicate handling: successful exports block; failed exports are retryable.
  const duplicateCandidate = { transactionType: TransactionTypes.SALE, invoiceNo: 'INV-2024-001' };
  const blocked = excludePreviouslyExportedRows([duplicateCandidate], [{ export_status: 'generated', validation_summary: { voucherKeys: ['sale:INV-2024-001'] } }]);
  assertEqual(blocked.rows.length, 0, 'Previously generated voucher excluded');
  assertEqual(blocked.duplicates.length, 1, 'Duplicate surfaced for explanation');
  const retry = excludePreviouslyExportedRows([duplicateCandidate], [{ export_status: 'failed', validation_summary: { voucherKeys: ['sale:INV-2024-001'] } }]);
  assertEqual(retry.rows.length, 1, 'Failed export remains retryable');
  const pendingRows = excludePreviouslyExportedRows([duplicateCandidate], [{ export_status: 'pending', validation_summary: { voucherKeys: ['sale:INV-2024-001'] } }]);
  assertEqual(pendingRows.rows.length, 0, 'Active pending export reserves its voucher');
  const stalePendingRows = excludePreviouslyExportedRows([duplicateCandidate], [{ export_status: 'pending', export_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(), validation_summary: { voucherKeys: ['sale:INV-2024-001'] } }]);
  assertEqual(stalePendingRows.rows.length, 1, 'Stale pending export can be retried');

  // Test with Customer Receipt type
  const rowsReceipt = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.CUSTOMER_RECEIPT],
    ...sourceRecords
  });
  assertEqual(rowsReceipt.length, 1, 'Customer Receipt = 1 row (has amountReceived)');
  if (rowsReceipt[0]) {
    assertEqual(rowsReceipt[0].transactionType, TransactionTypes.CUSTOMER_RECEIPT, 'Receipt type');
    assertEqual(rowsReceipt[0].amount, 50000, 'Receipt amount = amountReceived');
    assertEqual(rowsReceipt[0].balance, 0, 'Receipt balance = 0');
    const mappedReceipt = mapSelectedToTally({ selectedRows: rowsReceipt, company, vendorMaster });
    assertEqual(mappedReceipt.vouchers[0]?.voucherType, 'Receipt', 'Customer receipt maps to a receipt voucher');
  }
  const receiptOnPaymentDate = { ...customerRecord, payload: { ...customerRecord.payload, invoiceDetails: { ...customerRecord.payload.invoiceDetails, paymentDate: '2024-02-01' } } };
  const paymentDateRows = buildTransactionRows({
    dateFrom: '2024-02-01', dateTo: '2024-02-01',
    selectedTypes: [TransactionTypes.CUSTOMER_RECEIPT],
    ...sourceRecords,
    customerInvoices: [receiptOnPaymentDate]
  });
  assertEqual(paymentDateRows.length, 1, 'Receipt date filtering uses the recorded payment date');
  // Test with Supplier Payment type
  const rowsPayment = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SUPPLIER_PAYMENT],
    ...sourceRecords
  });
  assertEqual(rowsPayment.length, 1, 'Supplier Payment = 1 row (has amountPaid)');
  if (rowsPayment[0]) {
    assertEqual(rowsPayment[0].transactionType, TransactionTypes.SUPPLIER_PAYMENT, 'Payment type');
    assertEqual(rowsPayment[0].amount, 30000, 'Payment amount = amountPaid');
    const mappedPayment = mapSelectedToTally({ selectedRows: rowsPayment, company, vendorMaster });
    assertEqual(mappedPayment.vouchers[0]?.voucherType, 'Payment', 'Supplier payment maps to a payment voucher');
  }

  // Test with Debit Note type
  const rowsDN = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-02-28',
    selectedTypes: [TransactionTypes.DEBIT_NOTE],
    ...sourceRecords
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
    selectedTypes: [TransactionTypes.SALE, TransactionTypes.PURCHASE],
    ...sourceRecords
  });
  assertEqual(rowsFiltered.length, 1, 'Date filter: only purchase (Jan 20) in range');
  if (rowsFiltered[0]) {
    assertEqual(rowsFiltered[0].transactionType, TransactionTypes.PURCHASE, 'Only purchase remains');
  }

  // Test empty types
  const rowsEmpty = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [],
    ...sourceRecords
  });
  assertEqual(rowsEmpty.length, 0, 'No types = no rows');

  // ── 4. mapSelectedToTally ──
  section('4. mapSelectedToTally');

  const allRows = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-01-31',
    selectedTypes: [TransactionTypes.SALE, TransactionTypes.PURCHASE],
    ...sourceRecords
  });

  const result = mapSelectedToTally({ selectedRows: allRows, company, vendorMaster });
  assert(result.vouchers.length >= 1, 'At least 1 valid voucher');
  assert(result.masters.customerLedgers.length >= 1, 'Customer ledgers collected');
  assert(result.masters.supplierLedgers.length >= 1, 'Supplier ledgers collected');
  assert(result.masters.stockItems.length >= 1, 'Stock items collected');
  assert(result.masters.units.length >= 1, 'Units collected');

  // Check voucher balance
  result.vouchers.forEach((v) => {
    assert(v.isBalanced, `Voucher ${v.voucherNumber} is balanced`);
  });
  const missingPartyMapping = validateVouchers([{ ...result.vouchers[0], partyLedger: '', partyName: 'Unknown Customer' }]);
  assert(missingPartyMapping.invalid[0]?.errors.some((error) => error.includes('customer or supplier mapping')), 'Missing party mapping is rejected');
  const missingCompany = mapSelectedToTally({ selectedRows: allRows, company: {}, vendorMaster });
  assertEqual(missingCompany.vouchers.length, 0, 'Missing company settings prevent export');
  assert(missingCompany.invalidVouchers.some((item) => item.errors.includes('Company name is missing from company settings.')), 'Missing company mapping is explained');
  const inconsistentGSTVoucher = { ...result.vouchers[0], totals: { ...result.vouchers[0]?.totals, cgst: 0, sgst: 0, igst: 0 } };
  const invalidGST = validateVouchers([inconsistentGSTVoucher]);
  assertEqual(invalidGST.invalid.length, 1, 'GST amount mismatch is rejected');
  assert(invalidGST.invalid[0]?.errors.some((error) => error.includes('GST components')), 'GST mismatch has actionable validation error');

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
  assert(xml.voucherXml.includes('<AMOUNT>118000</AMOUNT>'), 'voucher XML includes the recorded sale total');

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

  const creditRecord = {
    ...customerRecord,
    date: '2024-02-02',
    reference: 'INV-CN-SOURCE',
    payload: {
      ...customerRecord.payload,
      invoiceDetails: { ...customerRecord.payload.invoiceDetails, creditNoteNumber: 'CN-001', creditNoteDate: '2024-02-02', creditNoteAmount: 2500, creditNoteTaxableAmount: 2500, creditNoteGSTAmount: 0, creditNoteCGST: 0, creditNoteSGST: 0, creditNoteIGST: 0 }
    }
  };
  const rowsDNCN = buildTransactionRows({
    dateFrom: '2024-01-01',
    dateTo: '2024-02-28',
    selectedTypes: [TransactionTypes.DEBIT_NOTE, TransactionTypes.CREDIT_NOTE],
    ...sourceRecords,
    customerInvoices: [customerRecord, creditRecord]
  });
  // Debit note exists, credit note doesn't (no credit note data in test records)
  const dnRow = rowsDNCN.find((r) => r.transactionType === TransactionTypes.DEBIT_NOTE);
  const cnRow = rowsDNCN.find((r) => r.transactionType === TransactionTypes.CREDIT_NOTE);
  assert(dnRow !== undefined, 'Debit note row present');
  assert(cnRow !== undefined, 'Credit note row present');

  const resultDN = mapSelectedToTally({ selectedRows: [dnRow], company, vendorMaster });
  assert(resultDN.vouchers.length === 1, 'Debit note mapped to 1 voucher');
  if (resultDN.vouchers[0]) {
    assertEqual(resultDN.vouchers[0].voucherType, 'Debit Note', 'Debit Note voucher type');
  }
  const resultCN = mapSelectedToTally({ selectedRows: [cnRow], company, vendorMaster });
  assertEqual(resultCN.vouchers.length, 1, 'Credit Note maps to one voucher');
  assertEqual(resultCN.vouchers[0]?.voucherType, 'Credit Note', 'Credit Note voucher type');
  const draftDebitRows = buildTransactionRows({
    dateFrom: '2024-01-01', dateTo: '2024-02-28',
    selectedTypes: [TransactionTypes.DEBIT_NOTE],
    ...sourceRecords,
    debitNotes: [{ ...debitNoteRecord, status: 'Draft' }]
  });
  assertEqual(draftDebitRows.length, 0, 'Draft debit notes are not treated as accounting vouchers');

  let missingCustomerSourceRejected = false;
  try {
    buildTransactionRows({
      dateFrom: '2024-01-01',
      dateTo: '2024-01-31',
      selectedTypes: [TransactionTypes.SALE],
      supplierInvoices: [],
      debitNotes: [],
      vendorMaster: [],
      company
    });
  } catch (error) {
    missingCustomerSourceRejected = /PostgreSQL Customer Invoice records are required/.test(error.message);
  }
  assert(missingCustomerSourceRejected, 'Missing PostgreSQL source records are rejected instead of silently falling back');

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
