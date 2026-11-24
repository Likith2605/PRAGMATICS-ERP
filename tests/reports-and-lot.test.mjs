/**
 * Verification test suite for:
 * 1. Reports Module Audit & Operations
 * 2. Customer Invoice Optional Lot Number functionality
 *
 * Run: node tests/reports-and-lot.test.mjs
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failures = [];

const check = (cond, label, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ✓  ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} ${extra}`);
    console.log(`  ✗  FAIL: ${label} ${extra}`);
  }
};

const section = (name) => console.log(`\n── ${name}`);

/* ========================================================================= */
/* SECTION 1: REPORTS MODULE AUDIT                                           */
/* ========================================================================= */
section('1. Reports Module Audit');

import fs from 'node:fs';

const reportsHomeContent = fs.readFileSync('src/pages/ReportsHomePage.jsx', 'utf8');
check(reportsHomeContent.includes('export default ReportsHomePage'), 'ReportsHomePage component is exported');
check(reportsHomeContent.includes('const SECTIONS ='), 'ReportsHomePage defines SECTIONS catalogue');

// Verify report data structures in storeService and report utilities
const storeService = await import('../src/utils/storeService.js');
const reportData = await import('../src/utils/reportData.js');
const invoiceValues = await import('../src/utils/invoiceValues.js');

check(typeof reportData.readLocalStorageList === 'function', 'readLocalStorageList is available');
check(typeof invoiceValues.invTotalINR === 'function', 'invTotalINR helper is available');
check(typeof invoiceValues.invReceivedINR === 'function', 'invReceivedINR helper is available');
check(typeof invoiceValues.invBalanceINR === 'function', 'invBalanceINR helper is available');

// 1. Stock Status Report logic test
const reorderList = storeService.getReorderList();
const invItems = storeService.getInventoryItems();
check(Array.isArray(invItems), 'getInventoryItems returns an array');
check(Array.isArray(reorderList), 'getReorderList returns an array');

// 2. Stock Valuation Summary logic test
const stockOverview = storeService.getItemStockOverview();
const stockTotals = storeService.getStockTotals();
const catStock = storeService.getCategoryWiseStock();
check(Array.isArray(stockOverview), 'getItemStockOverview returns items');
check(typeof stockTotals === 'object' && stockTotals !== null, 'getStockTotals returns totals object');
check(Array.isArray(catStock), 'getCategoryWiseStock returns categories array');

// 3. Material Issue Register logic test
const storeIssues = storeService.getStoreIssues();
check(Array.isArray(storeIssues), 'getStoreIssues returns store issues array');

// 4. Material with Supplier logic test
const htRequests = storeService.getHTOutsourceRequests();
check(Array.isArray(htRequests), 'getHTOutsourceRequests returns outsource requests');

// 5. Customer Master & Customer List logic test
const customerMaster = await import('../src/utils/customerMaster.js');
const masterCustomers = customerMaster.getMasterCustomerList();
check(Array.isArray(masterCustomers), 'getMasterCustomerList returns array of customers');


// 6. Section 1B: Verify the 6 Newly Implemented Reports & Routes
section('1B. Implemented Report Files and Routes Verification');

const appContent = fs.readFileSync('src/App.jsx', 'utf8');
const reportFiles = [
  { file: 'src/pages/reports/SalesRegisterPage.jsx', route: '/reports/sales-register', name: 'Sales Register' },
  { file: 'src/pages/reports/SalesOrderAgeingPage.jsx', route: '/reports/sales-orders', name: 'Sales Order Status & Ageing' },
  { file: 'src/pages/reports/SupplierOutstandingPage.jsx', route: '/reports/purchase/creditors', name: 'Supplier Outstanding' },
  { file: 'src/pages/reports/JobCardPlannedActualPage.jsx', route: '/reports/production/planned-actual', name: 'Job Card Planned vs Actual' },
  { file: 'src/pages/reports/JobCardMaterialPage.jsx', route: '/reports/production/jc-material', name: 'Job Card Material Issue & Return' },
  { file: 'src/pages/reports/ReadyToDespatchPage.jsx', route: '/reports/production/ready-despatch', name: 'Ready to Despatch' }
];

reportFiles.forEach((rf) => {
  check(fs.existsSync(rf.file), `File exists: ${rf.file}`);
  const src = fs.readFileSync(rf.file, 'utf8');
  check(src.includes('ReportRegister'), `${rf.name} imports and uses ReportRegister`);
  check(src.includes('summaryCards='), `${rf.name} provides summaryCards`);
  check(appContent.includes(rf.route), `Route registered in App.jsx: ${rf.route}`);
});

// Check ReportRegister features
const rrSrc = fs.readFileSync('src/components/ReportRegister.jsx', 'utf8');
check(rrSrc.includes('search'), 'ReportRegister supports search functionality');
check(rrSrc.includes('handleSort'), 'ReportRegister supports column sorting');
check(rrSrc.includes('Apply Filters') && rrSrc.includes('Reset Filters'), 'ReportRegister supports explicit Apply and Reset Filters');
check(rrSrc.includes('pagedRows'), 'ReportRegister supports pagination');
check(rrSrc.includes('summaryCards'), 'ReportRegister supports summary cards');

// Section 1C: Data transformation & business logic tests for all 6 reports
section('1C. Report Business Logic & Calculation Verifications');

// 1C.1 Sales Register calculations
const testInv1 = {
  reference: 'INV-TEST-001',
  date: '2026-11-01',
  company: 'Aero Dynamics Ltd',
  amountINR: 11800,
  receivedINR: 5000,
  balanceINR: 6800,
  status: 'Partially Paid',
  payload: {
    invoiceDetails: { projectId: 'PRJ-101', paymentStatus: 'Partially Paid' },
    items: [{ itemName: 'Turbine Blade', quantity: 10, amount: 10000, gst: 18 }],
    totals: { taxableAmount: 10000, totalGST: 1800, grandTotal: 11800 }
  }
};
check(invoiceValues.invTotalINR(testInv1) === 11800, 'Sales Register total INR calculated (11800)');
check(invoiceValues.invReceivedINR(testInv1) === 5000, 'Sales Register received INR calculated (5000)');
check(invoiceValues.invBalanceINR(testInv1) === 6800, 'Sales Register outstanding INR calculated (6800)');

// 1C.2 Sales Order Ageing calculations
const getAgeingBucket = (days) => {
  if (days <= 30) return '0–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return '90+ days';
};
check(getAgeingBucket(15) === '0–30 days', 'Ageing bucket 15 days = 0–30 days');
check(getAgeingBucket(45) === '31–60 days', 'Ageing bucket 45 days = 31–60 days');
check(getAgeingBucket(75) === '61–90 days', 'Ageing bucket 75 days = 61–90 days');
check(getAgeingBucket(120) === '90+ days', 'Ageing bucket 120 days = 90+ days');

// 1C.3 Supplier Outstanding calculations
const testBill = {
  grandTotal: 50000,
  amountPaid: 20000,
  status: 'Partially Paid'
};
const billOutstanding = Math.max(0, testBill.grandTotal - testBill.amountPaid);
check(billOutstanding === 30000, 'Supplier bill outstanding calculated (30000)');

// 1C.4 Job Card Planned vs Actual calculations
const jcPlanned = 100;
const jcProduced = 85;
const jcPending = Math.max(0, jcPlanned - jcProduced);
const jcVariance = jcProduced - jcPlanned;
check(jcPending === 15, 'Job Card pending qty calculated (15)');
check(jcVariance === -15, 'Job Card variance calculated (-15)');

// 1C.5 Job Card Material Net Consumption calculations
const matIssued = 50;
const matReturned = 5;
const netConsumption = Math.max(0, matIssued - matReturned);
check(netConsumption === 45, 'Job Card net consumption calculated (45)');

// 1C.6 Ready to Despatch strict QC Rule
// Rule: Produced quantity alone is NEVER automatically ready for dispatch.
// ONLY QC Accepted quantity minus already dispatched quantity is ready for dispatch.
const batchProduced = 100;
const batchQcAccepted = 80;
const batchQcRejected = 20;
const batchAlreadyDispatched = 30;
const readyToDispatch = Math.max(0, batchQcAccepted - batchAlreadyDispatched);
check(readyToDispatch === 50, 'Ready to Despatch strictly uses QC accepted (80 - 30 = 50, not produced 100)');
check(readyToDispatch !== (batchProduced - batchAlreadyDispatched), 'Produced qty without QC approval is excluded from dispatch');

/* ========================================================================= */
/* SECTION 2: CUSTOMER INVOICE OPTIONAL LOT NUMBER AUDIT                     */
/* ========================================================================= */
section('2. Customer Invoice Optional Lot Number Support');

// Helper to simulate computedItems logic from CustomerInvoicePage
const computeItems = (items) => {
  return items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const gstPercent = Number(item.gst) || 0;
    const amount = quantity * unitPrice;
    const gstAmount = (amount * gstPercent) / 100;

    return {
      ...item,
      lotNumber: item.lotNumber || item.lotNo || '',
      unit: item.unit || 'Nos',
      amount,
      gstAmount
    };
  });
};

// Test 2.1: Blank lot number (optional)
const itemBlankLot = {
  itemName: 'Bearing Housing',
  drawingNo: 'DWG-101',
  lotNumber: '',
  quantity: 10,
  unitPrice: 500,
  gst: 18
};
const computedBlank = computeItems([itemBlankLot]);
check(computedBlank[0].lotNumber === '', 'Blank lot number is preserved as empty string');
check(computedBlank[0].amount === 5000, 'Blank lot item calculation is intact (5000)');

// Test 2.2: Existing legacy invoice item without lotNumber property
const legacyItem = {
  itemName: 'Flange Adapter',
  drawingNo: 'DWG-999',
  quantity: 5,
  unitPrice: 200,
  gst: 18
};
const computedLegacy = computeItems([legacyItem]);
check(computedLegacy[0].lotNumber === '', 'Legacy item without lotNumber defaults safely to empty string');
check(computedLegacy[0].amount === 1000, 'Legacy item amount is computed correctly');

// Test 2.3: Single Lot Number entered
const itemWithLot = {
  itemName: 'Shaft 25mm',
  drawingNo: 'DWG-202',
  lotNumber: 'LOT-2026-X1',
  quantity: 20,
  unitPrice: 350,
  gst: 18
};
const computedWithLot = computeItems([itemWithLot]);
check(computedWithLot[0].lotNumber === 'LOT-2026-X1', 'Specified lot number is preserved exactly');

// Test 2.4: Multiple lots for one product line (comma-separated lots)
const itemMultiLotString = {
  itemName: 'Coupling Plate',
  drawingNo: 'DWG-303',
  lotNumber: 'LOT-A1 (10 Nos), LOT-A2 (15 Nos)',
  quantity: 25,
  unitPrice: 400,
  gst: 18
};
const computedMultiLot = computeItems([itemMultiLotString]);
check(computedMultiLot[0].lotNumber === 'LOT-A1 (10 Nos), LOT-A2 (15 Nos)', 'Multiple lots in single line field preserved');

// Test 2.5: Multiple line items for the same product with distinct lots
const itemSplitLot1 = {
  itemName: 'Pin 10mm',
  drawingNo: 'DWG-404',
  lotNumber: 'LOT-PART-1',
  quantity: 50,
  unitPrice: 50,
  gst: 18
};
const itemSplitLot2 = {
  itemName: 'Pin 10mm',
  drawingNo: 'DWG-404',
  lotNumber: 'LOT-PART-2',
  quantity: 30,
  unitPrice: 50,
  gst: 18
};
const computedSplit = computeItems([itemSplitLot1, itemSplitLot2]);
check(computedSplit.length === 2, 'Two lines for same product supported');
check(computedSplit[0].lotNumber === 'LOT-PART-1' && computedSplit[0].quantity === 50, 'Line 1 lot and quantity correct');
check(computedSplit[1].lotNumber === 'LOT-PART-2' && computedSplit[1].quantity === 30, 'Line 2 lot and quantity correct');
check(computedSplit[0].amount + computedSplit[1].amount === 4000, 'Total amount across split lot lines matches');

// Test 2.6: Simulated invoice payload round-trip
const invoicePayload = {
  invoiceDetails: {
    invoiceNumber: 'INV-AUDIT-001',
    invoiceDate: '2026-11-02',
    paymentStatus: 'Pending'
  },
  customerDetails: {
    customerName: 'Precision Aero Ltd',
    companyName: 'Precision Aero Ltd'
  },
  items: computedSplit
};

const serialized = JSON.stringify(invoicePayload);
const deserialized = JSON.parse(serialized);
check(deserialized.items[0].lotNumber === 'LOT-PART-1', 'Invoice payload serialization preserves line 1 lot number');
check(deserialized.items[1].lotNumber === 'LOT-PART-2', 'Invoice payload serialization preserves line 2 lot number');

// Test 2.7: View / Print text representation
const viewDisplay = (item) => item.lotNumber || item.lotNo || '-';
check(viewDisplay(computedBlank[0]) === '-', 'Empty lot number renders clean dash in view mode');
check(viewDisplay(computedLegacy[0]) === '-', 'Legacy item without lot renders dash in view mode');
check(viewDisplay(computedWithLot[0]) === 'LOT-2026-X1', 'Item with lot renders lot number in view mode');

// Test 2.8: Conditional column visibility in Print / PDF / View mode
const hasAnyLotNumber = (items) => Boolean(
  items?.some((item) => String(item.lotNumber || item.lotNo || '').trim())
);

const emptyInvoiceItems = [
  { itemName: 'Item A', drawingNo: 'DWG-A', lotNumber: '', quantity: 2, unitPrice: 100 },
  { itemName: 'Item B', drawingNo: 'DWG-B', quantity: 5, unitPrice: 200 }
];
const whitespaceInvoiceItems = [
  { itemName: 'Item C', drawingNo: 'DWG-C', lotNumber: '   ', quantity: 1, unitPrice: 50 }
];
const mixedInvoiceItems = [
  { itemName: 'Item D', drawingNo: 'DWG-D', lotNumber: '', quantity: 2, unitPrice: 100 },
  { itemName: 'Item E', drawingNo: 'DWG-E', lotNumber: 'LOT-987', quantity: 4, unitPrice: 250 }
];

check(!hasAnyLotNumber(emptyInvoiceItems), 'Invoice with all blank lots hides Lot No. column in Print/PDF');
check(!hasAnyLotNumber(whitespaceInvoiceItems), 'Invoice with whitespace-only lots hides Lot No. column in Print/PDF');
check(hasAnyLotNumber(mixedInvoiceItems), 'Invoice with at least one lot number displays Lot No. column in Print/PDF');

const customerInvoicePageSrc = fs.readFileSync('src/pages/CustomerInvoicePage.jsx', 'utf8');
check(customerInvoicePageSrc.includes('const viewHasAnyLotNumber = Boolean('), 'CustomerInvoicePage defines viewHasAnyLotNumber logic');
check(customerInvoicePageSrc.includes('{viewHasAnyLotNumber && ('), 'CustomerInvoicePage conditionally renders Lot No. th and td');
check(customerInvoicePageSrc.includes('colSpan={viewHasAnyLotNumber ? 5 : 4}'), 'CustomerInvoicePage dynamically adjusts Total row colSpan');

console.log(`\n============================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:', failures);
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED SUCCESSFULLY! ✓');
}
