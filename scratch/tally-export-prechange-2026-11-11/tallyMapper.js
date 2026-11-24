/**
 * TallyPrime XML Mapper — maps Pragmatic Engineers ERP data into TallyPrime
 * import-compatible XML structures (masters + vouchers).
 *
 * This module is PURE: it reads ERP records and produces plain JavaScript
 * objects that are then serialised to XML by tallyXmlGenerator.js. It never
 * writes to localStorage or the database.
 *
 * TallyPrime XML import format (official):
 *   <ENVELOPE><HEADER>...</HEADER><BODY><IMPORTDATA>
 *     <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>...</REQUESTDESC>
 *     <REQUESTDATA><TALLYMESSAGE><LEDGER ...>...</LEDGER></TALLYMESSAGE>...</REQUESTDATA>
 *   </IMPORTDATA></BODY></ENVELOPE>
 *
 * For vouchers: REPORTNAME = "Voucher", and <VOUCHER VCHTYPE="Sales" ...>
 */

import { calculateTotals } from './calculations.js';

// ---------------------------------------------------------------------------
// Constants — Tally groups / ledgers
// ---------------------------------------------------------------------------

/** Default Tally parent groups for ERP parties. */
export const TALLY_GROUPS = {
  SUNDRY_DEBTORS: 'Sundry Debtors',
  SUNDRY_CREDITORS: 'Sundry Creditors',
  SALES: 'Sales Accounts',
  PURCHASES: 'Purchase Accounts',
  CASH_IN_HAND: 'Cash-in-Hand',
  BANK_ACCOUNTS: 'Bank Accounts',
  CGST: 'Duties & Taxes',
  SGST: 'Duties & Taxes',
  IGST: 'Duties & Taxes',
  ROUND_OFF: 'Indirect Expenses',
  EXPENSES: 'Indirect Expenses'
};

/** ERP transaction type → Tally voucher type. */
export const VOCHER_TYPE_MAP = {
  salesInvoice: 'Sales',
  purchaseInvoice: 'Purchase',
  salesReturn: 'Credit Note',
  purchaseReturn: 'Debit Note',
  customerReceipt: 'Receipt',
  supplierPayment: 'Payment',
  debitNote: 'Debit Note',
  creditNote: 'Credit Note',
  expense: 'Payment'
};

/** Default ledger names used when a specific party ledger is not found. */
export const DEFAULT_LEDGER_NAMES = {
  SUNDRY_DEBTOR: 'Sundry Debtors',
  SUNDRY_CREDITOR: 'Sundry Creditors',
  SALES: 'Sales',
  PURCHASE: 'Purchases',
  CASH: 'Cash',
  BANK: 'Bank',
  CGST: 'CGST',
  SGST: 'SGST',
  IGST: 'IGST',
  ROUND_OFF: 'Round Off'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isEmpty = (v) => v === null || v === undefined || v === '';

/** Escape XML special characters in text content. */
export const xmlEscape = (str) => {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/** Format a date as Tally expects: YYYYMMDD (no dashes). */
export const tallyDate = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(String(dateStr));
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

/** Round to 2 decimals. */
export const r2 = (n) => Number(Number(n || 0).toFixed(2));

/** Get company settings from localStorage. */
const getCompany = () => {
  try {
    const raw = localStorage.getItem('companySettings');
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
};

/** Determine CGST/SGST/IGST from taxMode. */
const splitGST = (taxMode, totalGST) => {
  const mode = taxMode || 'intra';
  const gst = r2(totalGST);
  if (mode === 'export') return { cgst: 0, sgst: 0, igst: 0 };
  if (mode === 'inter') return { cgst: 0, sgst: 0, igst: gst };
  // intra
  const cgst = r2(gst / 2);
  const sgst = r2(gst / 2);
  return { cgst, sgst, igst: 0 };
};

// ---------------------------------------------------------------------------
// Master mapping (ERP → Tally ledger / stock item / unit)
// ---------------------------------------------------------------------------

/**
 * Map a customer record to a Tally Ledger (Sundry Debtor).
 */
export const mapCustomerToLedger = (customer) => {
  const name = customer.companyName || customer.customerName || 'Unknown Customer';
  const gstin = customer.gstNumber || customer.gstin || '';
  const state = customer.state || '';
  const address = customer.address || '';
  const phone = customer.contactNumber || customer.phone || '';
  const email = customer.email || '';
  const pan = customer.pan || '';

  return {
    type: 'LEDGER',
    name: name,
    parent: TALLY_GROUPS.SUNDRY_DEBTORS,
    openingBalance: 0,
    isDeemedPositive: false, // debtor = positive in Tally (debit nature)
    gstin,
    pan,
    address,
    city: '',
    pincode: '',
    state,
    country: 'India',
    phone,
    email,
    gstRegistrationType: gstin ? 'Regular' : 'Unregistered',
    ledgerFrom: 'customer',
    sourceId: customer.customerName || customer.companyName || name
  };
};

/**
 * Map a supplier/vendor record to a Tally Ledger (Sundry Creditor).
 */
export const mapSupplierToLedger = (supplier) => {
  const name = supplier.companyName || supplier.vendorName || supplier.name || 'Unknown Supplier';
  const gstin = supplier.gstNumber || supplier.gstin || '';
  const state = supplier.state || '';
  const address = supplier.address || '';
  const phone = supplier.contactNumber || supplier.phone || '';
  const email = supplier.email || '';
  const pan = supplier.pan || '';

  return {
    type: 'LEDGER',
    name: name,
    parent: TALLY_GROUPS.SUNDRY_CREDITORS,
    openingBalance: 0,
    isDeemedPositive: false, // creditor = credit nature
    gstin,
    pan,
    address,
    city: '',
    pincode: '',
    state,
    country: 'India',
    phone,
    email,
    gstRegistrationType: gstin ? 'Regular' : 'Unregistered',
    ledgerFrom: 'supplier',
    sourceId: supplier.name || supplier.vendorName || supplier.companyName || name
  };
};

/**
 * Map an inventory item to a Tally Stock Item.
 */
export const mapItemToStockItem = (item) => {
  const name = item.itemName || item.materialName || item.itemCode || 'Unknown Item';
  const hsnSac = item.hsnSac || item.hsn || '';
  const unit = item.unit || 'Nos';
  const gst = Number(item.gst || 0);

  return {
    type: 'STOCKITEM',
    name: name,
    parent: 'Primary',
    unit,
    hsnSac,
    gstRate: r2(gst),
    openingBalance: 0,
    sourceId: item.itemCode || item.itemName || name
  };
};

/**
 * Map a unit of measurement to a Tally Unit.
 */
export const mapUnitToTally = (unitName) => {
  if (!unitName) return null;
  return {
    type: 'UNIT',
    name: unitName,
    parent: 'Number', // Tally base unit
    decimalPlaces: 0,
    sourceId: unitName
  };
};

// ---------------------------------------------------------------------------
// Voucher mapping (ERP transactions → Tally vouchers)
// ---------------------------------------------------------------------------

/**
 * Map a customer invoice (sales) to a Tally Sales Voucher.
 *
 * Accounting entries:
 *   Dr Sundry Debtor (Customer)      = Grand Total
 *   Cr Sales                         = Taxable Amount
 *   Cr CGST/SGST/IGST                = GST amounts
 */
export const mapCustomerInvoiceToVoucher = (record, company) => {
  const inv = record;
  const payload = inv.payload || {};
  const details = payload.invoiceDetails || {};
  const customer = payload.customerDetails || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const totals = payload.totals || {};
  const currency = payload.currency || details.currency || 'INR';
  const taxMode = details.taxMode || 'intra';

  const invoiceNumber = details.invoiceNumber || inv.reference || '';
  const invoiceDate = tallyDate(details.invoiceDate || inv.date);
  const projectId = details.projectId || '';
  const placeOfSupply = details.placeOfSupply || customer.state || '';
  const customerName = customer.companyName || customer.customerName || 'Unknown Customer';
  const gstin = customer.gstNumber || customer.gstin || '';

  const taxableAmount = r2(totals.taxableAmount || totals.subtotal || 0);
  const totalGST = r2(totals.totalGST || 0);
  const cgst = r2(totals.cgst || 0);
  const sgst = r2(totals.sgst || 0);
  const igst = r2(totals.igst || 0);
  const grandTotal = r2(totals.grandTotal || 0);

  // Build narration with project ref
  let narration = `Sales Invoice ${invoiceNumber}`;
  if (projectId) narration += ` | Project: ${projectId}`;
  if (details.quotationRef) narration += ` | Quotation: ${details.quotationRef}`;
  if (details.salesOrderRef) narration += ` | SO: ${details.salesOrderRef}`;
  if (details.notes) narration += ` | ${details.notes}`;

  // Accounting allocations (ledger entries)
  const accountingAllocations = [];

  // 1. Debit Customer (Sundry Debtor) = Grand Total
  const debtorLedger = customerName ? `Sundry Debtor - ${customerName}` : DEFAULT_LEDGER_NAMES.SUNDRY_DEBTOR;
  accountingAllocations.push({
    ledgerName: debtorLedger,
    isDeemedPositive: true, // Debit
    amount: grandTotal,
    billAllocation: invoiceNumber ? { name: invoiceNumber, billType: 'New Ref', amount: grandTotal } : null
  });

  // 2. Credit Sales = Taxable Amount
  accountingAllocations.push({
    ledgerName: DEFAULT_LEDGER_NAMES.SALES,
    isDeemedPositive: false, // Credit
    amount: taxableAmount
  });

  // 3. Credit GST ledgers
  if (taxMode === 'intra') {
    if (cgst > 0) {
      accountingAllocations.push({
        ledgerName: DEFAULT_LEDGER_NAMES.CGST,
        isDeemedPositive: false,
        amount: cgst
      });
    }
    if (sgst > 0) {
      accountingAllocations.push({
        ledgerName: DEFAULT_LEDGER_NAMES.SGST,
        isDeemedPositive: false,
        amount: sgst
      });
    }
  } else if (taxMode === 'inter') {
    if (igst > 0) {
      accountingAllocations.push({
        ledgerName: DEFAULT_LEDGER_NAMES.IGST,
        isDeemedPositive: false,
        amount: igst
      });
    }
  }

  // Inventory allocations (stock items)
  const inventoryAllocations = items
    .filter((it) => it.itemName || it.itemDescription)
    .map((it) => {
      const qty = Number(it.quantity || 0);
      const rate = Number(it.unitPrice || 0);
      const amount = r2(it.amount || (qty * rate));
      const gstPercent = Number(it.gst || 0);
      const gstAmount = r2(it.gstAmount || ((amount * gstPercent) / 100));

      return {
        stockItemName: it.itemName || it.itemDescription || 'Unknown Item',
        isDeemedPositive: false, // Credit (outgoing stock)
        rate: r2(rate),
        amount,
        quantity: r2(qty),
        unit: it.unit || 'Nos',
        gstPercent: r2(gstPercent),
        gstAmount
      };
    });

  // Balance check
  const totalDebit = r2(accountingAllocations.filter((a) => a.isDeemedPositive).reduce((s, a) => s + a.amount, 0));
  const totalCredit = r2(accountingAllocations.filter((a) => !a.isDeemedPositive).reduce((s, a) => s + a.amount, 0));
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  return {
    type: 'VOUCHER',
    voucherType: VOCHER_TYPE_MAP.salesInvoice,
    voucherNumber: invoiceNumber,
    date: invoiceDate,
    effectiveDate: invoiceDate,
    reference: details.salesOrderRef || details.quotationRef || '',
    narration,
    isInvoice: true,
    isDeemedPositive: true,
    partyLedger: debtorLedger,
    partyName: customerName,
    partyGSTIN: gstin,
    placeOfSupply,
    projectId,
    accountingAllocations,
    inventoryAllocations,
    totals: { taxableAmount, totalGST, cgst, sgst, igst, grandTotal },
    isBalanced,
    sourceId: inv.reference || invoiceNumber,
    sourceModule: 'customerInvoiceHistory'
  };
};

/**
 * Map a supplier invoice (purchase) to a Tally Purchase Voucher.
 *
 * Accounting entries:
 *   Dr Purchase                    = Taxable Amount
 *   Dr CGST/SGST/IGST              = GST amounts
 *   Cr Sundry Creditor (Supplier)  = Grand Total
 */
export const mapSupplierInvoiceToVoucher = (record, company) => {
  const inv = record;
  const payload = inv.payload || {};
  const details = payload.invoiceDetails || {};
  const vendor = payload.vendorDetails || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const totals = payload.totals || {};

  const invoiceNumber = details.supplierInvoiceNumber || inv.reference || '';
  const invoiceDate = tallyDate(details.supplierInvoiceDate || inv.date);
  const projectId = details.projectId || details.poReference || '';
  const vendorName = vendor.companyName || vendor.vendorName || 'Unknown Supplier';
  const gstin = vendor.gstNumber || vendor.gstin || '';

  const taxableAmount = r2(totals.taxableAmount || totals.subtotal || 0);
  const totalGST = r2(totals.totalGST || 0);
  const cgst = r2(totals.cgst || 0);
  const sgst = r2(totals.sgst || 0);
  const igst = r2(totals.igst || 0);
  const grandTotal = r2(totals.grandTotal || 0);

  let narration = `Supplier Invoice ${invoiceNumber}`;
  if (projectId) narration += ` | Project: ${projectId}`;
  if (details.poReference) narration += ` | PO: ${details.poReference}`;
  if (details.notes) narration += ` | ${details.notes}`;

  const accountingAllocations = [];

  // 1. Debit Purchase = Taxable Amount
  accountingAllocations.push({
    ledgerName: DEFAULT_LEDGER_NAMES.PURCHASE,
    isDeemedPositive: true,
    amount: taxableAmount
  });

  // 2. Debit GST ledgers (input tax)
  const taxMode = details.taxMode || 'intra';
  if (taxMode === 'intra') {
    if (cgst > 0) {
      accountingAllocations.push({ ledgerName: DEFAULT_LEDGER_NAMES.CGST, isDeemedPositive: true, amount: cgst });
    }
    if (sgst > 0) {
      accountingAllocations.push({ ledgerName: DEFAULT_LEDGER_NAMES.SGST, isDeemedPositive: true, amount: sgst });
    }
  } else if (taxMode === 'inter') {
    if (igst > 0) {
      accountingAllocations.push({ ledgerName: DEFAULT_LEDGER_NAMES.IGST, isDeemedPositive: true, amount: igst });
    }
  }

  // 3. Credit Supplier (Sundry Creditor) = Grand Total
  const creditorLedger = vendorName ? `Sundry Creditor - ${vendorName}` : DEFAULT_LEDGER_NAMES.SUNDRY_CREDITOR;
  accountingAllocations.push({
    ledgerName: creditorLedger,
    isDeemedPositive: false, // Credit
    amount: grandTotal
  });

  const inventoryAllocations = items
    .filter((it) => it.itemName || it.itemDescription)
    .map((it) => {
      const qty = Number(it.quantity || 0);
      const rate = Number(it.unitPrice || 0);
      const amount = r2(it.amount || (qty * rate));
      const gstPercent = Number(it.gst || 0);
      const gstAmount = r2(it.gstAmount || ((amount * gstPercent) / 100));

      return {
        stockItemName: it.itemName || it.itemDescription || 'Unknown Item',
        isDeemedPositive: true, // Debit (incoming stock)
        rate: r2(rate),
        amount,
        quantity: r2(qty),
        unit: it.unit || 'Nos',
        gstPercent: r2(gstPercent),
        gstAmount
      };
    });

  const totalDebit = r2(accountingAllocations.filter((a) => a.isDeemedPositive).reduce((s, a) => s + a.amount, 0));
  const totalCredit = r2(accountingAllocations.filter((a) => !a.isDeemedPositive).reduce((s, a) => s + a.amount, 0));

  return {
    type: 'VOUCHER',
    voucherType: VOCHER_TYPE_MAP.purchaseInvoice,
    voucherNumber: invoiceNumber,
    date: invoiceDate,
    effectiveDate: invoiceDate,
    reference: details.poReference || '',
    narration,
    isInvoice: true,
    isDeemedPositive: true,
    partyLedger: creditorLedger,
    partyName: vendorName,
    partyGSTIN: gstin,
    placeOfSupply: vendor.state || '',
    projectId,
    accountingAllocations,
    inventoryAllocations,
    totals: { taxableAmount, totalGST, cgst, sgst, igst, grandTotal },
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
    sourceId: inv.reference || invoiceNumber,
    sourceModule: 'supplierInvoiceHistory'
  };
};

/**
 * Map a customer receipt to a Tally Receipt Voucher.
 *
 * Accounting entries:
 *   Dr Bank/Cash                   = Amount Received
 *   Cr Sundry Debtor (Customer)    = Amount Received
 */
export const mapCustomerReceiptToVoucher = (record, company) => {
  // Customer receipts are stored within customerInvoiceHistory payload as
  // amountReceived / receivedINR, or as separate records. We handle the
  // receipt portion of an invoice here.
  const inv = record;
  const payload = inv.payload || {};
  const details = payload.invoiceDetails || {};
  const customer = payload.customerDetails || {};

  const amountReceived = r2(details.amountReceived || 0);
  if (amountReceived <= 0) return null; // no receipt to export

  const receiptDate = tallyDate(details.paymentDate || inv.date);
  const customerName = customer.companyName || customer.customerName || 'Unknown Customer';
  const receiptRef = details.paymentReference || inv.reference || '';

  let narration = `Customer Receipt`;
  if (receiptRef) narration += ` | Ref: ${receiptRef}`;
  if (details.projectId) narration += ` | Project: ${details.projectId}`;

  const bankLedger = DEFAULT_LEDGER_NAMES.BANK;
  const debtorLedger = customerName ? `Sundry Debtor - ${customerName}` : DEFAULT_LEDGER_NAMES.SUNDRY_DEBTOR;

  const accountingAllocations = [
    { ledgerName: bankLedger, isDeemedPositive: true, amount: amountReceived }, // Dr Bank
    { ledgerName: debtorLedger, isDeemedPositive: false, amount: amountReceived } // Cr Customer
  ];

  return {
    type: 'VOUCHER',
    voucherType: VOCHER_TYPE_MAP.customerReceipt,
    voucherNumber: receiptRef || `RCPT-${inv.reference || ''}`,
    date: receiptDate,
    effectiveDate: receiptDate,
    reference: receiptRef,
    narration,
    isInvoice: false,
    isDeemedPositive: true,
    partyLedger: debtorLedger,
    partyName: customerName,
    partyGSTIN: customer.gstNumber || customer.gstin || '',
    placeOfSupply: customer.state || '',
    projectId: details.projectId || '',
    accountingAllocations,
    inventoryAllocations: [],
    totals: { taxableAmount: 0, totalGST: 0, cgst: 0, sgst: 0, igst: 0, grandTotal: amountReceived },
    isBalanced: true,
    sourceId: `${inv.reference}-receipt`,
    sourceModule: 'customerInvoiceHistory',
    voucherSubType: 'receipt'
  };
};

/**
 * Map a supplier payment to a Tally Payment Voucher.
 *
 * Accounting entries:
 *   Dr Sundry Creditor (Supplier)  = Amount Paid
 *   Cr Bank/Cash                   = Amount Paid
 */
export const mapSupplierPaymentToVoucher = (record, company) => {
  const inv = record;
  const payload = inv.payload || {};
  const details = payload.invoiceDetails || {};
  const vendor = payload.vendorDetails || {};

  const amountPaid = r2(details.amountPaid || 0);
  if (amountPaid <= 0) return null;

  const paymentDate = tallyDate(details.paymentDate || inv.date);
  const vendorName = vendor.companyName || vendor.vendorName || 'Unknown Supplier';
  const paymentRef = details.paymentReference || inv.reference || '';

  let narration = `Supplier Payment`;
  if (paymentRef) narration += ` | Ref: ${paymentRef}`;
  if (details.poReference) narration += ` | PO: ${details.poReference}`;
  if (details.paymentMode) narration += ` | Mode: ${details.paymentMode}`;

  const creditorLedger = vendorName ? `Sundry Creditor - ${vendorName}` : DEFAULT_LEDGER_NAMES.SUNDRY_CREDITOR;
  const bankLedger = DEFAULT_LEDGER_NAMES.BANK;

  const accountingAllocations = [
    { ledgerName: creditorLedger, isDeemedPositive: true, amount: amountPaid }, // Dr Supplier
    { ledgerName: bankLedger, isDeemedPositive: false, amount: amountPaid } // Cr Bank
  ];

  return {
    type: 'VOUCHER',
    voucherType: VOCHER_TYPE_MAP.supplierPayment,
    voucherNumber: paymentRef || `PAY-${inv.reference || ''}`,
    date: paymentDate,
    effectiveDate: paymentDate,
    reference: paymentRef,
    narration,
    isInvoice: false,
    isDeemedPositive: true,
    partyLedger: creditorLedger,
    partyName: vendorName,
    partyGSTIN: vendor.gstNumber || vendor.gstin || '',
    placeOfSupply: vendor.state || '',
    projectId: details.projectId || details.poReference || '',
    accountingAllocations,
    inventoryAllocations: [],
    totals: { taxableAmount: 0, totalGST: 0, cgst: 0, sgst: 0, igst: 0, grandTotal: amountPaid },
    isBalanced: true,
    sourceId: `${inv.reference}-payment`,
    sourceModule: 'supplierInvoiceHistory',
    voucherSubType: 'payment'
  };
};

/**
 * Map a debit note (purchase return / rejection) to a Tally Debit Note Voucher.
 *
 * Debit Note raised ON supplier:
 *   Dr Sundry Creditor (Supplier)  = Amount
 *   Cr Purchase Returns / Purchase  = Amount (+ GST if applicable)
 */
export const mapDebitNoteToVoucher = (record, company) => {
  const dn = record;
  const payload = dn.payload || {};
  const details = payload.invoiceDetails || payload.debitNoteDetails || {};
  const vendor = payload.vendorDetails || {};

  const dnNumber = details.debitNoteNumber || dn.reference || '';
  const dnDate = tallyDate(details.debitNoteDate || dn.date);
  const amount = r2(details.amount || dn.total || 0);
  if (amount <= 0) return null;

  const vendorName = vendor.companyName || vendor.vendorName || 'Unknown Supplier';

  let narration = `Debit Note ${dnNumber}`;
  if (details.reason) narration += ` | ${details.reason}`;
  if (details.originalInvoiceRef) narration += ` | Against Inv: ${details.originalInvoiceRef}`;

  const creditorLedger = vendorName ? `Sundry Creditor - ${vendorName}` : DEFAULT_LEDGER_NAMES.SUNDRY_CREDITOR;
  const purchaseReturnLedger = 'Purchase Returns';

  const accountingAllocations = [
    { ledgerName: creditorLedger, isDeemedPositive: true, amount }, // Dr Supplier
    { ledgerName: purchaseReturnLedger, isDeemedPositive: false, amount } // Cr Purchase Returns
  ];

  return {
    type: 'VOUCHER',
    voucherType: VOCHER_TYPE_MAP.debitNote,
    voucherNumber: dnNumber,
    date: dnDate,
    effectiveDate: dnDate,
    reference: details.originalInvoiceRef || '',
    narration,
    isInvoice: false,
    isDeemedPositive: true,
    partyLedger: creditorLedger,
    partyName: vendorName,
    partyGSTIN: vendor.gstNumber || vendor.gstin || '',
    placeOfSupply: vendor.state || '',
    projectId: details.projectId || '',
    accountingAllocations,
    inventoryAllocations: [],
    totals: { taxableAmount: amount, totalGST: 0, cgst: 0, sgst: 0, igst: 0, grandTotal: amount },
    isBalanced: true,
    sourceId: dn.reference || dnNumber,
    sourceModule: 'debitNotes'
  };
};

/**
 * Map a credit note (sales return) to a Tally Credit Note Voucher.
 *
 * Credit Note raised TO customer:
 *   Dr Sales Returns / Sales        = Amount
 *   Cr Sundry Debtor (Customer)     = Amount
 */
export const mapCreditNoteToVoucher = (record, company) => {
  const cn = record;
  const payload = cn.payload || {};
  const details = payload.invoiceDetails || payload.creditNoteDetails || {};
  const customer = payload.customerDetails || {};

  const cnNumber = details.creditNoteNumber || cn.reference || '';
  const cnDate = tallyDate(details.creditNoteDate || cn.date);
  const amount = r2(details.amount || cn.total || 0);
  if (amount <= 0) return null;

  const customerName = customer.companyName || customer.customerName || 'Unknown Customer';

  let narration = `Credit Note ${cnNumber}`;
  if (details.reason) narration += ` | ${details.reason}`;
  if (details.originalInvoiceRef) narration += ` | Against Inv: ${details.originalInvoiceRef}`;

  const debtorLedger = customerName ? `Sundry Debtor - ${customerName}` : DEFAULT_LEDGER_NAMES.SUNDRY_DEBTOR;
  const salesReturnLedger = 'Sales Returns';

  const accountingAllocations = [
    { ledgerName: salesReturnLedger, isDeemedPositive: true, amount }, // Dr Sales Returns
    { ledgerName: debtorLedger, isDeemedPositive: false, amount } // Cr Customer
  ];

  return {
    type: 'VOUCHER',
    voucherType: VOCHER_TYPE_MAP.creditNote,
    voucherNumber: cnNumber,
    date: cnDate,
    effectiveDate: cnDate,
    reference: details.originalInvoiceRef || '',
    narration,
    isInvoice: false,
    isDeemedPositive: true,
    partyLedger: debtorLedger,
    partyName: customerName,
    partyGSTIN: customer.gstNumber || customer.gstin || '',
    placeOfSupply: customer.state || '',
    projectId: details.projectId || '',
    accountingAllocations,
    inventoryAllocations: [],
    totals: { taxableAmount: amount, totalGST: 0, cgst: 0, sgst: 0, igst: 0, grandTotal: amount },
    isBalanced: true,
    sourceId: cn.reference || cnNumber,
    sourceModule: 'customerInvoiceHistory' // credit notes linked to invoices
  };
};

// ---------------------------------------------------------------------------
// Batch mapping functions — convert raw storage lists to Tally-mapped objects
// ---------------------------------------------------------------------------

/**
 * Collect customer masters from customerInvoiceHistory and vendorMaster.
 * Returns unique ledgers.
 */
export const collectCustomerLedgers = (records) => {
  const seen = new Set();
  const ledgers = [];

  records.forEach((r) => {
    const payload = r.payload || {};
    const customer = payload.customerDetails || {};
    const key = customer.companyName || customer.customerName || '';
    if (!key || seen.has(key)) return;
    seen.add(key);
    ledgers.push(mapCustomerToLedger(customer));
  });

  return ledgers;
};

/**
 * Collect supplier masters from supplierInvoiceHistory and vendorMaster.
 */
export const collectSupplierLedgers = (records, vendorMaster = []) => {
  const seen = new Set();
  const ledgers = [];

  // From vendor master first
  vendorMaster.forEach((v) => {
    const key = v.name || v.vendorName || v.companyName || '';
    if (!key || seen.has(key)) return;
    seen.add(key);
    ledgers.push(mapSupplierToLedger(v));
  });

  // From supplier invoices
  records.forEach((r) => {
    const payload = r.payload || {};
    const vendor = payload.vendorDetails || {};
    const key = vendor.companyName || vendor.vendorName || '';
    if (!key || seen.has(key)) return;
    seen.add(key);
    ledgers.push(mapSupplierToLedger(vendor));
  });

  return ledgers;
};

/**
 * Collect stock items from all transaction records.
 */
export const collectStockItems = (records) => {
  const seen = new Set();
  const items = [];

  records.forEach((r) => {
    const payload = r.payload || {};
    const itemsList = Array.isArray(payload.items) ? payload.items : [];
    itemsList.forEach((it) => {
      const key = it.itemName || it.itemDescription || '';
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push(mapItemToStockItem(it));
    });
  });

  return items;
};

/**
 * Collect units from stock items.
 */
export const collectUnits = (records) => {
  const seen = new Set();
  const units = [];

  records.forEach((r) => {
    const payload = r.payload || {};
    const itemsList = Array.isArray(payload.items) ? payload.items : [];
    itemsList.forEach((it) => {
      const unit = it.unit || 'Nos';
      if (seen.has(unit)) return;
      seen.add(unit);
      units.push(mapUnitToTally(unit));
    });
  });

  return units.filter(Boolean);
};

/**
 * Map sales invoices to vouchers.
 */
export const mapSalesInvoices = (records, company) =>
  records.map((r) => mapCustomerInvoiceToVoucher(r, company)).filter(Boolean);

/**
 * Map purchase invoices to vouchers.
 */
export const mapPurchaseInvoices = (records, company) =>
  records.map((r) => mapSupplierInvoiceToVoucher(r, company)).filter(Boolean);

/**
 * Map customer receipts (from paid invoices).
 */
export const mapCustomerReceipts = (records, company) =>
  records.map((r) => mapCustomerReceiptToVoucher(r, company)).filter(Boolean);

/**
 * Map supplier payments (from paid invoices).
 */
export const mapSupplierPayments = (records, company) =>
  records.map((r) => mapSupplierPaymentToVoucher(r, company)).filter(Boolean);

/**
 * Map debit notes to vouchers.
 */
export const mapDebitNotes = (records, company) =>
  records.map((r) => mapDebitNoteToVoucher(r, company)).filter(Boolean);

/**
 * Map credit notes to vouchers.
 */
export const mapCreditNotes = (records, company) =>
  records.map((r) => mapCreditNoteToVoucher(r, company)).filter(Boolean);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate mapped vouchers for balance and completeness.
 * Returns { valid: [], invalid: [{ voucher, errors: [] }], warnings: [] }
 */
export const validateVouchers = (vouchers) => {
  const valid = [];
  const invalid = [];
  const warnings = [];

  vouchers.forEach((v) => {
    const errors = [];

    if (!v.voucherNumber) errors.push('Missing voucher number');
    if (!v.date) errors.push('Missing voucher date');
    if (!v.partyLedger) errors.push('Missing party ledger');
    if (!v.partyName) errors.push('Missing party name');
    if (!v.isBalanced) errors.push(`Debit/Credit mismatch: Dr ${v.totals?.grandTotal || 0} vs Cr ${v.totals?.grandTotal || 0}`);
    if (v.accountingAllocations.length === 0) errors.push('No accounting allocations');
    if (v.totals.grandTotal <= 0) errors.push('Grand total is zero or negative');

    // Party GSTIN warning
    if (!v.partyGSTIN) {
      warnings.push(`${v.voucherType} ${v.voucherNumber}: Party '${v.partyName}' has no GSTIN`);
    }

    // Inventory allocations missing for sales/purchase
    if ((v.voucherType === 'Sales' || v.voucherType === 'Purchase') && v.inventoryAllocations.length === 0) {
      warnings.push(`${v.voucherType} ${v.voucherNumber}: No stock items found`);
    }

    if (errors.length > 0) {
      invalid.push({ voucher: v, errors });
    } else {
      valid.push(v);
    }
  });

  return { valid, invalid, warnings };
};
