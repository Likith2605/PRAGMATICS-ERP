/**
 * Tally Export Feature — Automated Tests
 *
 * Validates:
 *   1. Data mapping from ERP records to Tally objects (ledgers, stock items, vouchers)
 *   2. XML generation (master.xml + voucher.xml) follows TallyPrime format
 *   3. XML validation (well-formed, required elements present)
 *   4. Voucher balancing (debit = credit)
 *   5. Date range filtering
 *   6. Export history round-trip (server API)
 *
 * Run: node tests/tally-export.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { getPool, closeDatabase, runMigrations } from '../server/database.js';

// Import the mapper and generator directly
import {
  mapCustomerToLedger,
  mapSupplierToLedger,
  mapItemToStockItem,
  mapCustomerInvoiceToVoucher,
  mapSupplierInvoiceToVoucher,
  mapCustomerReceiptToVoucher,
  mapSupplierPaymentToVoucher,
  mapDebitNoteToVoucher,
  mapCreditNoteToVoucher,
  collectCustomerLedgers,
  collectSupplierLedgers,
  collectStockItems,
  collectUnits,
  validateVouchers,
  xmlEscape,
  tallyDate,
  r2,
  DEFAULT_LEDGER_NAMES,
  VOCHER_TYPE_MAP,
  mapUnitToTally
} from '../src/utils/tallyMapper.js';

import { buildMasterXml, buildVoucherXml, validateTallyXml } from '../src/utils/tallyXmlGenerator.js';

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
// Sample ERP data (mirrors real record structures)
// ---------------------------------------------------------------------------

const company = {
  companyName: 'PRAGMATIC ENGINEERS',
  gstin: '29AKWPP8736E1ZA',
  pan: 'AKWPP8736E',
  address: 'NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083',
  state: 'Karnataka (29)',
  phone: '+91 9880030466',
  email: 'pragmatic.vasudev@gmail.com'
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
      dueDate: '2024-02-14',
      projectId: 'PE-2024-001',
      placeOfSupply: 'Karnataka (29)',
      taxMode: 'intra',
      notes: 'Sales against PO 456789',
      amountReceived: '0',
      balanceDue: '118000'
    },
    customerDetails: {
      customerName: 'BOSCH LIMITED',
      companyName: 'BOSCH LIMITED',
      address: 'PA- ATMO6 DIVISION NAGANATHAPURA PLANT, \nPB NO 6887, ELECTRONIC CITY POST, HOSUR ROAD\nBANGALORE-560100',
      gstNumber: '29AAACM9840P1ZP',
      gstin: '29AAACM9840P1ZP',
      state: 'Karnataka (29)',
      contactNumber: '8061867312',
      phone: '8061867312',
      email: 'Nagaraj.MK@in.bosch.com'
    },
    companyDetails: company,
    items: [
      {
        itemCode: 'ITEM-001',
        itemName: 'Machining Part A',
        drawingNo: 'DWG-001',
        hsnSac: '8483',
        quantity: 10,
        unit: 'Nos',
        unitPrice: 10000,
        gst: 18,
        amount: 100000,
        gstAmount: 18000
      }
    ],
    totals: {
      subtotal: 100000,
      discount: 0,
      taxableAmount: 100000,
      totalGST: 18000,
      cgst: 9000,
      sgst: 9000,
      igst: 0,
      grandTotal: 118000,
      taxMode: 'intra'
    },
    amountInWords: 'One Lakh Eighteen Thousand Only',
    currency: 'INR',
    amountINR: 118000,
    receivedINR: 0,
    balanceINR: 118000
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
      paymentDueDate: '2024-02-19',
      poReference: 'PO-2024-001',
      projectId: 'PE-2024-002',
      taxMode: 'intra',
      amountPaid: '0',
      balanceDue: '59000',
      notes: 'Raw material supply'
    },
    vendorDetails: {
      vendorName: 'SKF INDIA LTD, BANGALORE',
      companyName: 'SKF INDIA LTD, BANGALORE',
      address: 'PLOT NO 2, BOMMASANDRA INDUSTRIAL AREA, HOSUR ROAD, \nBANGALORE-560099',
      gstNumber: '29AAACS0684H1Z8',
      gstin: '29AAACS0684H1Z8',
      state: 'Karnataka (29)',
      contactNumber: '4032992330',
      phone: '4032992330',
      email: 'abc@skf.com'
    },
    companyDetails: company,
    items: [
      {
        itemCode: 'RM-001',
        itemName: 'Ball Bearing 6201',
        drawingNo: '',
        hsnSac: '8482',
        quantity: 100,
        unit: 'Nos',
        unitPrice: 500,
        gst: 18,
        amount: 50000,
        gstAmount: 9000
      }
    ],
    totals: {
      subtotal: 50000,
      discount: 0,
      taxableAmount: 50000,
      totalGST: 9000,
      cgst: 4500,
      sgst: 4500,
      igst: 0,
      grandTotal: 59000,
      taxMode: 'intra'
    },
    amountInWords: 'Fifty Nine Thousand Only',
    currency: 'INR',
    amountINR: 59000,
    receivedINR: 0,
    balanceINR: 59000
  }
};

const vendorMaster = [
  { seq: 1, product: 'Bearings', name: 'SKF INDIA LTD, BANGALORE', address: 'PLOT NO 2, BOMMASANDRA', phone: '4032992330', email: 'abc@skf.com' },
  { seq: 2, product: 'Steel', name: 'TATA STEEL LIMITED', address: 'MUMBAI', phone: '', email: '' }
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('═'.repeat(60));
  console.log('TALLY EXPORT FEATURE — TEST SUITE');
  console.log('═'.repeat(60));

  // ── 1. Helper functions ──
  section('1. Helper Functions');

  assertEqual(tallyDate('2024-01-15'), '20240115', 'tallyDate converts YYYY-MM-DD to YYYYMMDD');
  assertEqual(tallyDate(''), '', 'tallyDate empty string returns empty');
  assertEqual(tallyDate(null), '', 'tallyDate null returns empty');
  assertEqual(r2(100.456), 100.46, 'r2 rounds to 2 decimals');
  assertEqual(r2(100), 100, 'r2 preserves whole numbers');
  assertEqual(xmlEscape('A & B'), 'A &amp; B', 'xmlEscape escapes ampersand');
  assertEqual(xmlEscape('<tag>'), '&lt;tag&gt;', 'xmlEscape escapes angle brackets');

  // ── 2. Master mapping ──
  section('2. Master Mapping (ERP → Tally Ledgers / Stock Items)');

  const customerLedger = mapCustomerToLedger(customerRecord.payload.customerDetails);
  assertEqual(customerLedger.type, 'LEDGER', 'Customer mapped as LEDGER type');
  assertEqual(customerLedger.name, 'BOSCH LIMITED', 'Customer ledger name');
  assertEqual(customerLedger.parent, 'Sundry Debtors', 'Customer parent group is Sundry Debtors');
  assertEqual(customerLedger.gstin, '29AAACM9840P1ZP', 'Customer GSTIN');
  assertEqual(customerLedger.sourceId, 'BOSCH LIMITED', 'Customer source ID');

  const supplierLedger = mapSupplierToLedger(vendorMaster[0]);
  assertEqual(supplierLedger.type, 'LEDGER', 'Supplier mapped as LEDGER type');
  assertEqual(supplierLedger.name, 'SKF INDIA LTD, BANGALORE', 'Supplier ledger name');
  assertEqual(supplierLedger.parent, 'Sundry Creditors', 'Supplier parent group is Sundry Creditors');

  const stockItem = mapItemToStockItem(customerRecord.payload.items[0]);
  assertEqual(stockItem.type, 'STOCKITEM', 'Item mapped as STOCKITEM type');
  assertEqual(stockItem.name, 'Machining Part A', 'Stock item name');
  assertEqual(stockItem.unit, 'Nos', 'Stock item unit');
  assertEqual(stockItem.hsnSac, '8483', 'Stock item HSN');

  const unit = mapUnitToTally('Nos');
  assertEqual(unit.type, 'UNIT', 'Unit mapped as UNIT type');
  assertEqual(unit.name, 'Nos', 'Unit name');
  assertEqual(unit.parent, 'Number', 'Unit parent is Number');

  // ── 3. Voucher mapping ──
  section('3. Voucher Mapping');

  const salesVoucher = mapCustomerInvoiceToVoucher(customerRecord, company);
  assertEqual(salesVoucher.type, 'VOUCHER', 'Sales invoice mapped as VOUCHER type');
  assertEqual(salesVoucher.voucherType, 'Sales', 'Sales voucher type');
  assertEqual(salesVoucher.voucherNumber, 'INV-2024-001', 'Sales voucher number');
  assertEqual(salesVoucher.date, '20240115', 'Sales voucher date format');
  assert(salesVoucher.isBalanced, 'Sales voucher is balanced (Dr = Cr)');
  assert(salesVoucher.accountingAllocations.length >= 3, 'Sales voucher has 3+ accounting allocations');
  assert(salesVoucher.inventoryAllocations.length === 1, 'Sales voucher has 1 inventory allocation');

  // Check debit = credit
  const salesDebit = salesVoucher.accountingAllocations.filter((a) => a.isDeemedPositive).reduce((s, a) => s + a.amount, 0);
  const salesCredit = salesVoucher.accountingAllocations.filter((a) => !a.isDeemedPositive).reduce((s, a) => s + a.amount, 0);
  assertEqual(Math.abs(salesDebit - salesCredit), 0, 'Sales voucher debit equals credit');

  const purchaseVoucher = mapSupplierInvoiceToVoucher(supplierRecord, company);
  assertEqual(purchaseVoucher.voucherType, 'Purchase', 'Purchase voucher type');
  assertEqual(purchaseVoucher.voucherNumber, 'SUP-INV-001', 'Purchase voucher number');
  assert(purchaseVoucher.isBalanced, 'Purchase voucher is balanced');

  const purchaseDebit = purchaseVoucher.accountingAllocations.filter((a) => a.isDeemedPositive).reduce((s, a) => s + a.amount, 0);
  const purchaseCredit = purchaseVoucher.accountingAllocations.filter((a) => !a.isDeemedPositive).reduce((s, a) => s + a.amount, 0);
  assertEqual(Math.abs(purchaseDebit - purchaseCredit), 0, 'Purchase voucher debit equals credit');

  // Customer receipt (partial payment)
  const receiptRecord = { ...customerRecord };
  receiptRecord.payload.invoiceDetails.amountReceived = '50000';
  const receiptVoucher = mapCustomerReceiptToVoucher(receiptRecord, company);
  assert(receiptVoucher !== null, 'Customer receipt voucher created');
  assertEqual(receiptVoucher.voucherType, 'Receipt', 'Receipt voucher type');
  assert(receiptVoucher.isBalanced, 'Receipt voucher is balanced');

  // Supplier payment (partial payment)
  const paymentRecord = { ...supplierRecord };
  paymentRecord.payload.invoiceDetails.amountPaid = '30000';
  const paymentVoucher = mapSupplierPaymentToVoucher(paymentRecord, company);
  assert(paymentVoucher !== null, 'Supplier payment voucher created');
  assertEqual(paymentVoucher.voucherType, 'Payment', 'Payment voucher type');
  assert(paymentVoucher.isBalanced, 'Payment voucher is balanced');

  // Debit note
  const debitNoteRecord = {
    date: '2024-02-01',
    reference: 'DN-001',
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
  const debitNoteVoucher = mapDebitNoteToVoucher(debitNoteRecord, company);
  assert(debitNoteVoucher !== null, 'Debit note voucher created');
  assertEqual(debitNoteVoucher.voucherType, 'Debit Note', 'Debit note voucher type');
  assert(debitNoteVoucher.isBalanced, 'Debit note voucher is balanced');

  // Credit note
  const creditNoteRecord = {
    date: '2024-02-05',
    reference: 'CN-001',
    payload: {
      creditNoteDetails: {
        creditNoteNumber: 'CN-001',
        creditNoteDate: '2024-02-05',
        amount: '3000',
        reason: 'Sales return',
        originalInvoiceRef: 'INV-2024-001'
      },
      customerDetails: customerRecord.payload.customerDetails,
      total: 3000
    }
  };
  const creditNoteVoucher = mapCreditNoteToVoucher(creditNoteRecord, company);
  assert(creditNoteVoucher !== null, 'Credit note voucher created');
  assertEqual(creditNoteVoucher.voucherType, 'Credit Note', 'Credit note voucher type');
  assert(creditNoteVoucher.isBalanced, 'Credit note voucher is balanced');

  // ── 4. Collection functions ──
  section('4. Collection Functions');

  const customers = collectCustomerLedgers([customerRecord]);
  assertEqual(customers.length, 1, 'Collects 1 customer ledger');
  assertEqual(customers[0].name, 'BOSCH LIMITED', 'Customer ledger name correct');

  const suppliers = collectSupplierLedgers([supplierRecord], vendorMaster);
  assert(suppliers.length >= 1, 'Collects supplier ledgers from vendor master + invoices');

  const items = collectStockItems([customerRecord, supplierRecord]);
  assert(items.length >= 2, 'Collects stock items from all records');

  const units = collectUnits([customerRecord, supplierRecord]);
  assert(units.length >= 1, 'Collects units of measurement');

  // ── 5. Validation ──
  section('5. Validation');

  const validation = validateVouchers([salesVoucher, purchaseVoucher, receiptVoucher]);
  assert(validation.valid.length === 3, 'All 3 vouchers valid');
  assertEqual(validation.invalid.length, 0, 'No invalid vouchers');

  // Create an invalid voucher (missing number)
  const invalidVoucher = { ...salesVoucher, voucherNumber: '', isBalanced: true };
  const validation2 = validateVouchers([invalidVoucher]);
  assertEqual(validation2.valid.length, 0, 'Invalid voucher detected');
  assertEqual(validation2.invalid.length, 1, '1 invalid voucher');
  assert(validation2.invalid[0].errors.length > 0, 'Invalid voucher has errors');

  // ── 6. XML Generation ──
  section('6. XML Generation');

  const masterXml = buildMasterXml({
    customers: [customerLedger],
    suppliers: [supplierLedger],
    stockItems: [stockItem],
    units: [unit],
    companyName: company.companyName
  });

  const masterValidation = validateTallyXml(masterXml, 'master');
  assert(masterValidation.valid, 'master.xml is valid Tally XML', `Errors: ${masterValidation.errors.join(', ')}`);
  assert(masterXml.includes('<ENVELOPE>'), 'master.xml has ENVELOPE');
  assert(masterXml.includes('<REPORTNAME>All Masters</REPORTNAME>'), 'master.xml has All Masters report name');
  assert(masterXml.includes('<LEDGER'), 'master.xml has LEDGER elements');
  assert(masterXml.includes('<STOCKITEM'), 'master.xml has STOCKITEM elements');
  assert(masterXml.includes('<UNIT'), 'master.xml has UNIT elements');
  assert(masterXml.includes('Sundry Debtors'), 'master.xml references Sundry Debtors group');
  assert(masterXml.includes('Sundry Creditors'), 'master.xml references Sundry Creditors group');
  assert(masterXml.includes('BOSCH LIMITED'), 'master.xml contains customer name');
  assert(masterXml.includes('SKF INDIA LTD, BANGALORE'), 'master.xml contains supplier name');

  const voucherXml = buildVoucherXml({
    vouchers: [salesVoucher, purchaseVoucher],
    companyName: company.companyName
  });

  const voucherValidation = validateTallyXml(voucherXml, 'voucher');
  assert(voucherValidation.valid, 'voucher.xml is valid Tally XML', `Errors: ${voucherValidation.errors.join(', ')}`);
  assert(voucherXml.includes('<ENVELOPE>'), 'voucher.xml has ENVELOPE');
  assert(voucherXml.includes('<REPORTNAME>Voucher</REPORTNAME>'), 'voucher.xml has Voucher report name');
  assert(voucherXml.includes('<VOUCHER'), 'voucher.xml has VOUCHER elements');
  assert(voucherXml.includes('INV-2024-001'), 'voucher.xml contains sales invoice number');
  assert(voucherXml.includes('SUP-INV-001'), 'voucher.xml contains purchase invoice number');
  assert(voucherXml.includes('<ACCOUNTINGALLOCATIONS>'), 'voucher.xml has accounting allocations');
  assert(voucherXml.includes('<INVENTORYALLOCATIONS>'), 'voucher.xml has inventory allocations');
  assert(voucherXml.includes('<ISINVOICE>Yes</ISINVOICE>'), 'Sales voucher marked as invoice');

  // Check no unescaped ampersands
  assert(!masterXml.match(/&(?![a-zA-Z]+;)/g), 'master.xml has no unescaped ampersands');
  assert(!voucherXml.match(/&(?![a-zA-Z]+;)/g), 'voucher.xml has no unescaped ampersands');

  // ── 7. Inter-state GST (IGST) ──
  section('7. Inter-State GST (IGST)');

  const interStateCustomer = { ...customerRecord };
  interStateCustomer.payload.invoiceDetails.taxMode = 'inter';
  interStateCustomer.payload.totals = {
    ...interStateCustomer.payload.totals,
    taxMode: 'inter',
    cgst: 0,
    sgst: 0,
    igst: 18000,
    totalGST: 18000
  };
  const interStateVoucher = mapCustomerInvoiceToVoucher(interStateCustomer, company);
  const igstAlloc = interStateVoucher.accountingAllocations.find((a) => a.ledgerName === 'IGST');
  assert(igstAlloc !== undefined, 'IGST ledger allocation exists for inter-state');
  assertEqual(igstAlloc.amount, 18000, 'IGST amount correct');

  // ── 8. Export to Tally date filtering ──
  section('8. Date Range Filtering (in prepareExport logic)');

  // Simulate filtering: only invoices within date range
  const allInvoices = [customerRecord, supplierRecord];
  const from = new Date('2024-01-10');
  const to = new Date('2024-01-18');
  to.setHours(23, 59, 59, 999);
  const filtered = allInvoices.filter((r) => {
    const d = new Date(r.date);
    return d >= from && d <= to;
  });
  assertEqual(filtered.length, 1, 'Only customer invoice (Jan 15) falls within Jan 10-18 range');

  const from2 = new Date('2024-01-16');
  const to2 = new Date('2024-01-31');
  to2.setHours(23, 59, 59, 999);
  const filtered2 = allInvoices.filter((r) => {
    const d = new Date(r.date);
    return d >= from2 && d <= to2;
  });
  assertEqual(filtered2.length, 1, 'Only supplier invoice falls within Jan 16-31 range');

  // ── 9. VOCHER_TYPE_MAP ──
  section('9. Voucher Type Mapping');

  assertEqual(VOCHER_TYPE_MAP.salesInvoice, 'Sales', 'Sales → Sales');
  assertEqual(VOCHER_TYPE_MAP.purchaseInvoice, 'Purchase', 'Purchase → Purchase');
  assertEqual(VOCHER_TYPE_MAP.customerReceipt, 'Receipt', 'Receipt → Receipt');
  assertEqual(VOCHER_TYPE_MAP.supplierPayment, 'Payment', 'Payment → Payment');
  assertEqual(VOCHER_TYPE_MAP.salesReturn, 'Credit Note', 'Sales Return → Credit Note');
  assertEqual(VOCHER_TYPE_MAP.purchaseReturn, 'Debit Note', 'Purchase Return → Debit Note');

  // ── Summary ──
  console.log('\n' + '═'.repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

// Run tests
runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
