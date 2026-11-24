import { authHeaders } from '../utils/auth.js';

/**
 * Tally Export Service — Vyapar-style Export to Tally.
 *
 * Reads ERP records from localStorage (read-only), maps selected transactions
 * to Tally objects via tallyMapper, generates XML via tallyXmlGenerator, and
 * persists export history to the PostgreSQL server.
 *
 * Supports per-row transaction selection: the UI picks individual invoice /
 * voucher rows, and this service generates masters + vouchers only for the
 * selected rows.
 */

import {
  collectCustomerLedgers,
  collectSupplierLedgers,
  collectStockItems,
  collectUnits,
  mapCustomerInvoiceToVoucher,
  mapSupplierInvoiceToVoucher,
  mapCustomerReceiptToVoucher,
  mapSupplierPaymentToVoucher,
  mapDebitNoteToVoucher,
  mapCreditNoteToVoucher,
  validateVouchers,
  DEFAULT_LEDGER_NAMES,
  TALLY_GROUPS,
  VOCHER_TYPE_MAP,
  xmlEscape,
  tallyDate,
  r2
} from '../utils/tallyMapper.js';
import { buildMasterXml, buildVoucherXml, validateTallyXml } from '../utils/tallyXmlGenerator.js';
import { readLS } from '../utils/storeService.js';

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEYS = {
  CUSTOMER_INVOICES: 'customerInvoiceHistory',
  SUPPLIER_INVOICES: 'supplierInvoiceHistory',
  VENDOR_MASTER: 'vendorMaster',
  COMPANY_SETTINGS: 'companySettings',
  DEBIT_NOTES: 'debitNotes'
};

// ---------------------------------------------------------------------------
// Data fetchers (read-only from localStorage)
// ---------------------------------------------------------------------------

const readJsonList = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

export const fetchCompany = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.COMPANY_SETTINGS);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    companyName: 'PRAGMATIC ENGINEERS',
    gstin: '',
    pan: '',
    address: '',
    state: 'Karnataka (29)',
    phone: '',
    email: ''
  };
};

export const fetchCustomerInvoices = () => readJsonList(STORAGE_KEYS.CUSTOMER_INVOICES);
export const fetchSupplierInvoices = () => readJsonList(STORAGE_KEYS.SUPPLIER_INVOICES);
export const fetchVendorMaster = () => readJsonList(STORAGE_KEYS.VENDOR_MASTER);
export const fetchDebitNotes = () => readJsonList(STORAGE_KEYS.DEBIT_NOTES);

// ---------------------------------------------------------------------------
// Date range presets (Indian financial year: 1 April to 31 March)
// ---------------------------------------------------------------------------

export const DATE_PRESETS = [
  { key: 'all', label: 'All' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_quarter', label: 'This Quarter' },
  { key: 'this_year', label: 'This Year' },
  { key: 'custom', label: 'Custom' }
];

const formatLocalDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const currentFinancialYear = () => {
  const d = new Date();
  const month = d.getMonth(); // 0-based, April = 3
  const year = month >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { from: `${year}-04-01`, to: `${year + 1}-03-31` };
};

const previousFinancialYear = () => {
  const d = new Date();
  const month = d.getMonth();
  const year = month >= 3 ? d.getFullYear() - 1 : d.getFullYear() - 2;
  return { from: `${year}-04-01`, to: `${year + 1}-03-31` };
};

const today = () => {
  const d = new Date();
  const iso = d.toISOString().slice(0, 10);
  return { from: iso, to: iso };
};

const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const iso = d.toISOString().slice(0, 10);
  return { from: iso, to: iso };
};

const thisWeek = () => {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  const start = new Date(d);
  start.setDate(d.getDate() - day); // start of week (Sunday)
  const end = new Date(d);
  end.setDate(d.getDate() + (6 - day));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10)
  };
};

const thisMonth = () => {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
};

const previousMonth = () => {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const to = new Date(d.getFullYear(), d.getMonth(), 0);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
};

export const computeDateRange = (presetKey, customFrom, customTo, now = new Date()) => {
  const year = now.getFullYear();
  const month = now.getMonth();
  switch (presetKey) {
    case 'all': return { from: '', to: '' };
    case 'this_month': return { from: formatLocalDate(new Date(year, month, 1)), to: formatLocalDate(new Date(year, month + 1, 0)) };
    case 'last_month': return { from: formatLocalDate(new Date(year, month - 1, 1)), to: formatLocalDate(new Date(year, month, 0)) };
    case 'this_quarter': {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      return { from: formatLocalDate(new Date(year, quarterStartMonth, 1)), to: formatLocalDate(new Date(year, quarterStartMonth + 3, 0)) };
    }
    case 'this_year': return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'custom':
      return { from: customFrom || '', to: customTo || '' };
    default: return { from: '', to: '' };
  }
};

// ---------------------------------------------------------------------------
// Transaction types (Vyapar-style)
// ---------------------------------------------------------------------------

export const TransactionTypes = {
  SALE: 'sale',
  PURCHASE: 'purchase',
  CREDIT_NOTE: 'creditNote',
  DEBIT_NOTE: 'debitNote',
  CUSTOMER_RECEIPT: 'customerReceipt',
  SUPPLIER_PAYMENT: 'supplierPayment'
};

const exportableDebitNoteStatuses = new Set(['Issued', 'Sent to Vendor', 'Closed', 'Recorded by Purchase', 'Recorded']);

export const TRANSACTION_TYPE_LABELS = {
  [TransactionTypes.SALE]: 'Sale',
  [TransactionTypes.PURCHASE]: 'Purchase',
  [TransactionTypes.CREDIT_NOTE]: 'Credit Note',
  [TransactionTypes.DEBIT_NOTE]: 'Debit Note',
  [TransactionTypes.CUSTOMER_RECEIPT]: 'Customer Receipt',
  [TransactionTypes.SUPPLIER_PAYMENT]: 'Supplier Payment'
};

// Default selection: main four Vyapar transaction types
export const DEFAULT_SELECTED_TYPES = [
  TransactionTypes.SALE,
  TransactionTypes.PURCHASE,
  TransactionTypes.CREDIT_NOTE,
  TransactionTypes.DEBIT_NOTE
];

export const validateDateRange = (dateFrom, dateTo) => {
  const validIso = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!dateFrom || !dateTo) return { valid: false, message: 'Choose both a From Date and a To Date.' };
  if (!validIso(dateFrom) || !validIso(dateTo)) return { valid: false, message: 'Enter valid From and To dates.' };
  if (dateFrom > dateTo) return { valid: false, message: 'From Date must be on or before To Date.' };
  return { valid: true, message: '' };
};

const EXPORT_RESERVATION_TIMEOUT_MS = 30 * 60 * 1000;

const isActiveExportHistoryRecord = (record, now = Date.now()) => {
  if (['failed', 'import_failed'].includes(record.export_status)) return false;
  if (record.export_status !== 'pending') return true;
  const createdAt = Date.parse(record.export_date || record.created_at || '');
  return !Number.isFinite(createdAt) || now - createdAt < EXPORT_RESERVATION_TIMEOUT_MS;
};

export const getPreviouslyExportedVoucherKeys = (history = [], now = Date.now()) => new Set(
  history
    .filter((record) => isActiveExportHistoryRecord(record, now))
    .flatMap((record) => record.validation_summary?.voucherKeys || [])
);

export const excludePreviouslyExportedRows = (rows = [], history = []) => {
  const exportedKeys = getPreviouslyExportedVoucherKeys(history);
  const duplicates = rows.filter((row) => exportedKeys.has(`${row.transactionType}:${row.invoiceNo}`));
  return {
    rows: rows.filter((row) => !exportedKeys.has(`${row.transactionType}:${row.invoiceNo}`)),
    duplicates
  };
};

// ---------------------------------------------------------------------------
// Normalize raw ERP records into flat transaction rows for the UI table
// ---------------------------------------------------------------------------

/** Extract payment mode from invoice details. */
const extractPaymentMode = (details) => {
  if (!details) return '';
  return details.paymentMode || details.paymentMethod || 'Credit';
};

const toAmount = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(String(value).replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Determine if a customer invoice has a receipt (partial/full payment). */
const hasCustomerReceipt = (record) => {
  const details = record?.payload?.invoiceDetails || {};
  const received = toAmount(details.amountReceived);
  return received > 0;
};

/** Determine if a supplier invoice has a payment. */
const hasSupplierPayment = (record) => {
  const details = record?.payload?.invoiceDetails || {};
  const paid = toAmount(details.amountPaid);
  return paid > 0;
};

/**
 * Build a flat list of transaction rows from raw ERP records.
 * Each row carries enough data to map to a Tally voucher later.
 */
export const buildTransactionRows = ({ dateFrom, dateTo, selectedTypes }) => {
  const company = fetchCompany();
  const vendorMaster = fetchVendorMaster();
  const vendorByName = {};
  vendorMaster.forEach((v) => {
    vendorByName[(v.name || v.vendorName || v.companyName || '').toLowerCase()] = v;
  });

  const rows = [];

  // ---- SALES (Customer Invoices) ----
  if (selectedTypes.includes(TransactionTypes.SALE)) {
    const invoices = readJsonList(STORAGE_KEYS.CUSTOMER_INVOICES);
    invoices.forEach((inv) => {
      const payload = inv.payload || {};
      const details = payload.invoiceDetails || {};
      const customer = payload.customerDetails || {};
      const invoiceDate = details.invoiceDate || inv.date;
      if (!inDateRange(invoiceDate, dateFrom, dateTo)) return;
      const total = toAmount(payload.totals?.grandTotal ?? inv.total);
      const received = toAmount(details.amountReceived);
      const balance = Math.max(0, total - received);
      rows.push({
        id: `sale-${inv.reference || details.invoiceNumber || inv.date}`,
        sourceId: inv.reference || details.invoiceNumber || '',
        sourceModule: 'customerInvoiceHistory',
        date: invoiceDate || '',
        invoiceNo: details.invoiceNumber || inv.reference || '-',
        partyName: customer.companyName || customer.customerName || 'Unknown Customer',
        partyGSTIN: customer.gstNumber || customer.gstin || '',
        partyState: customer.state || '',
        transactionType: TransactionTypes.SALE,
        transactionTypeLabel: TRANSACTION_TYPE_LABELS[TransactionTypes.SALE],
        paymentType: extractPaymentMode(details),
        amount: total,
        taxableAmount: payload.totals?.taxableAmount == null && payload.totals?.subtotal == null ? null : toAmount(payload.totals?.taxableAmount ?? payload.totals?.subtotal),
        balance,
        gstAmount: payload.totals?.totalGST == null ? null : toAmount(payload.totals.totalGST),
        currency: payload.currency || details.currency || 'INR',
        projectId: details.projectId || '',
        status: inv.status || details.paymentStatus || 'Pending',
        record: inv,
        company,
        mappingFn: () => mapCustomerInvoiceToVoucher(inv, company)
      });
    });
  }

  // ---- PURCHASES (Supplier Invoices) ----
  if (selectedTypes.includes(TransactionTypes.PURCHASE)) {
    const invoices = readJsonList(STORAGE_KEYS.SUPPLIER_INVOICES);
    invoices.forEach((inv) => {
      const payload = inv.payload || {};
      const details = payload.invoiceDetails || {};
      const vendor = payload.vendorDetails || {};
      const invoiceDate = details.supplierInvoiceDate || inv.date;
      if (!inDateRange(invoiceDate, dateFrom, dateTo)) return;
      const total = toAmount(payload.totals?.grandTotal ?? inv.total);
      const paid = toAmount(details.amountPaid);
      const balance = Math.max(0, total - paid);
      rows.push({
        id: `purchase-${inv.reference || details.supplierInvoiceNumber || inv.date}`,
        sourceId: inv.reference || details.supplierInvoiceNumber || '',
        sourceModule: 'supplierInvoiceHistory',
        date: invoiceDate || '',
        invoiceNo: details.supplierInvoiceNumber || inv.reference || '-',
        partyName: vendor.companyName || vendor.vendorName || 'Unknown Supplier',
        partyGSTIN: vendor.gstNumber || vendor.gstin || '',
        partyState: vendor.state || '',
        transactionType: TransactionTypes.PURCHASE,
        transactionTypeLabel: TRANSACTION_TYPE_LABELS[TransactionTypes.PURCHASE],
        paymentType: extractPaymentMode(details),
        amount: total,
        taxableAmount: payload.totals?.taxableAmount == null && payload.totals?.subtotal == null ? null : toAmount(payload.totals?.taxableAmount ?? payload.totals?.subtotal),
        balance,
        gstAmount: payload.totals?.totalGST == null ? null : toAmount(payload.totals.totalGST),
        currency: payload.currency || details.currency || 'INR',
        projectId: details.projectId || details.poReference || '',
        status: inv.status || details.paymentStatus || 'Pending',
        record: inv,
        company,
        mappingFn: () => mapSupplierInvoiceToVoucher(inv, company)
      });
    });
  }

  // ---- CREDIT NOTES (Sales Returns) ----
  if (selectedTypes.includes(TransactionTypes.CREDIT_NOTE)) {
    const invoices = readJsonList(STORAGE_KEYS.CUSTOMER_INVOICES);
    invoices.forEach((inv) => {
      const payload = inv.payload || {};
      const details = payload.invoiceDetails || {};
      const customer = payload.customerDetails || {};
      const creditDate = details.creditNoteDate || inv.date;
      if (!inDateRange(creditDate, dateFrom, dateTo)) return;
      const amount = toAmount(details.creditNoteAmount ?? payload.creditNoteAmount);
      if (amount <= 0) return;
      const creditNoteTotals = details.creditNoteTotals || payload.creditNoteTotals || {};
      const recordedTaxBreakdown = ['creditNoteTaxableAmount', 'creditNoteGSTAmount', 'creditNoteCGST', 'creditNoteSGST', 'creditNoteIGST'].every((key) => details[key] !== undefined)
        || ['taxableAmount', 'totalGST', 'cgst', 'sgst', 'igst', 'grandTotal'].every((key) => creditNoteTotals[key] !== undefined);
      const cnNumber = details.creditNoteNumber || `CN-${inv.reference || ''}`;
      rows.push({
        id: `creditnote-${cnNumber}-${inv.date}`,
        sourceId: cnNumber,
        sourceModule: 'customerInvoiceHistory',
        date: creditDate || '',
        invoiceNo: cnNumber,
        partyName: customer.companyName || customer.customerName || 'Unknown Customer',
        partyGSTIN: customer.gstNumber || customer.gstin || '',
        partyState: customer.state || '',
        transactionType: TransactionTypes.CREDIT_NOTE,
        transactionTypeLabel: TRANSACTION_TYPE_LABELS[TransactionTypes.CREDIT_NOTE],
        paymentType: 'Credit',
        amount,
        taxableAmount: recordedTaxBreakdown ? toAmount(details.creditNoteTaxableAmount ?? creditNoteTotals.taxableAmount) : null,
        balance: amount,
        gstAmount: recordedTaxBreakdown ? toAmount(details.creditNoteGSTAmount ?? creditNoteTotals.totalGST) : null,
        taxBreakdownRecorded: recordedTaxBreakdown,
        currency: payload.currency || details.currency || 'INR',
        projectId: details.projectId || '',
        status: 'Pending',
        record: inv,
        company,
        mappingFn: () => {
          const cnRecord = {
            date: inv.date,
            reference: cnNumber,
            payload: {
              creditNoteDetails: {
                creditNoteNumber: cnNumber,
              creditNoteDate: details.creditNoteDate || inv.date,
                amount: String(amount),
              taxableAmount: details.creditNoteTaxableAmount ?? creditNoteTotals.taxableAmount,
              totalGST: details.creditNoteGSTAmount ?? creditNoteTotals.totalGST,
              cgst: details.creditNoteCGST ?? creditNoteTotals.cgst,
              sgst: details.creditNoteSGST ?? creditNoteTotals.sgst,
              igst: details.creditNoteIGST ?? creditNoteTotals.igst,
              grandTotal: creditNoteTotals.grandTotal ?? amount,
                reason: details.creditNoteReason || 'Sales Return',
                originalInvoiceRef: details.invoiceNumber || inv.reference || ''
              },
              customerDetails: customer,
              total: amount
            }
          };
          return mapCreditNoteToVoucher(cnRecord, company);
        }
      });
    });
  }

  // ---- DEBIT NOTES (Purchase Returns) ----
  if (selectedTypes.includes(TransactionTypes.DEBIT_NOTE)) {
    const debitNotes = readJsonList(STORAGE_KEYS.DEBIT_NOTES);
    debitNotes.forEach((dn) => {
      if (!exportableDebitNoteStatuses.has(dn.status)) return;
      const payload = dn.payload || {};
      const details = payload.invoiceDetails || payload.debitNoteDetails || {};
      const debitDate = details.debitNoteDate || dn.debitNoteDate || dn.date;
      if (!inDateRange(debitDate, dateFrom, dateTo)) return;
      const noteVendorName = typeof dn.vendor === 'string' ? dn.vendor : dn.vendor?.companyName || dn.vendor?.vendorName || dn.vendor?.name || '';
      const vendor = payload.vendorDetails || dn.vendorDetails || vendorByName[noteVendorName.toLowerCase()] || (typeof dn.vendor === 'object' ? dn.vendor : {});
      const amount = toAmount(details.amount ?? dn.grandTotal ?? dn.total ?? payload.total);
      if (amount <= 0) return;
      const dnNumber = details.debitNoteNumber || dn.debitNoteNumber || dn.reference || '';
      const hasTaxBreakdown = ['taxableAmount', 'totalGST', 'cgst', 'sgst', 'igst', 'grandTotal'].every((key) => dn[key] !== undefined && dn[key] !== null)
        || ['taxableAmount', 'totalGST', 'cgst', 'sgst', 'igst', 'grandTotal'].every((key) => payload.totals?.[key] !== undefined);
      const partyName = vendor.companyName || vendor.vendorName || vendor.name || noteVendorName || 'Unknown Supplier';
      rows.push({
        id: `debitnote-${dnNumber}-${debitDate}`,
        sourceId: dnNumber,
        sourceModule: 'debitNotes',
        date: debitDate || '',
        invoiceNo: dnNumber,
        partyName,
        partyGSTIN: vendor.gstNumber || vendor.gstin || '',
        partyState: vendor.state || '',
        transactionType: TransactionTypes.DEBIT_NOTE,
        transactionTypeLabel: TRANSACTION_TYPE_LABELS[TransactionTypes.DEBIT_NOTE],
        paymentType: 'Credit',
        amount,
        taxableAmount: hasTaxBreakdown ? toAmount(dn.taxableAmount ?? payload.totals?.taxableAmount) : null,
        balance: amount,
        gstAmount: hasTaxBreakdown ? toAmount(dn.totalGST ?? payload.totals?.totalGST) : null,
        taxBreakdownRecorded: hasTaxBreakdown,
        currency: payload.currency || details.currency || 'INR',
        projectId: details.projectId || dn.projectId || '',
        status: dn.status,
        record: dn,
        company,
        mappingFn: () => mapDebitNoteToVoucher({
          ...dn,
          reference: dn.reference || dnNumber,
          date: dn.date || debitDate,
          total: dn.total ?? amount,
          payload: {
            ...payload,
            vendorDetails: vendor,
            debitNoteDetails: {
              ...details,
              debitNoteNumber: dnNumber,
              debitNoteDate: debitDate,
              amount,
              taxableAmount: dn.taxableAmount ?? payload.totals?.taxableAmount,
              totalGST: dn.totalGST ?? payload.totals?.totalGST,
              cgst: dn.cgst ?? payload.totals?.cgst,
              sgst: dn.sgst ?? payload.totals?.sgst,
              igst: dn.igst ?? payload.totals?.igst,
              grandTotal: dn.grandTotal ?? payload.totals?.grandTotal ?? amount,
              reason: details.reason || dn.remarks || dn.qualityRemarks,
              originalInvoiceRef: details.originalInvoiceRef || dn.invoiceNumber || ''
            }
          }
        }, company)
      });
    });
  }

  // ---- CUSTOMER RECEIPTS ----
  if (selectedTypes.includes(TransactionTypes.CUSTOMER_RECEIPT)) {
    const invoices = readJsonList(STORAGE_KEYS.CUSTOMER_INVOICES);
    invoices.forEach((inv) => {
      if (!hasCustomerReceipt(inv)) return;
      const payload = inv.payload || {};
      const details = payload.invoiceDetails || {};
      const customer = payload.customerDetails || {};
      const received = toAmount(details.amountReceived);
      const paymentDate = details.paymentDate || inv.date;
      if (!inDateRange(paymentDate, dateFrom, dateTo)) return;
      rows.push({
        id: `receipt-${inv.reference || details.invoiceNumber}-${paymentDate}`,
        sourceId: `${inv.reference || details.invoiceNumber}-receipt`,
        sourceModule: 'customerInvoiceHistory',
        date: paymentDate,
        invoiceNo: details.paymentReference || inv.reference || details.invoiceNumber || '-',
        partyName: customer.companyName || customer.customerName || 'Unknown Customer',
        partyGSTIN: customer.gstNumber || customer.gstin || '',
        partyState: customer.state || '',
        transactionType: TransactionTypes.CUSTOMER_RECEIPT,
        transactionTypeLabel: TRANSACTION_TYPE_LABELS[TransactionTypes.CUSTOMER_RECEIPT],
        paymentType: details.paymentMode || 'Bank',
        amount: received,
        taxableAmount: 0,
        balance: 0,
        gstAmount: 0,
        currency: payload.currency || details.currency || 'INR',
        projectId: details.projectId || '',
        status: 'Received',
        record: inv,
        company,
        mappingFn: () => mapCustomerReceiptToVoucher(inv, company)
      });
    });
  }

  // ---- SUPPLIER PAYMENTS ----
  if (selectedTypes.includes(TransactionTypes.SUPPLIER_PAYMENT)) {
    const invoices = readJsonList(STORAGE_KEYS.SUPPLIER_INVOICES);
    invoices.forEach((inv) => {
      if (!hasSupplierPayment(inv)) return;
      const payload = inv.payload || {};
      const details = payload.invoiceDetails || {};
      const vendor = payload.vendorDetails || {};
      const paid = toAmount(details.amountPaid);
      const paymentDate = details.paymentDate || inv.date;
      if (!inDateRange(paymentDate, dateFrom, dateTo)) return;
      rows.push({
        id: `payment-${inv.reference || details.supplierInvoiceNumber}-${paymentDate}`,
        sourceId: `${inv.reference || details.supplierInvoiceNumber}-payment`,
        sourceModule: 'supplierInvoiceHistory',
        date: paymentDate,
        invoiceNo: details.paymentReference || inv.reference || details.supplierInvoiceNumber || '-',
        partyName: vendor.companyName || vendor.vendorName || 'Unknown Supplier',
        partyGSTIN: vendor.gstNumber || vendor.gstin || '',
        partyState: vendor.state || '',
        transactionType: TransactionTypes.SUPPLIER_PAYMENT,
        transactionTypeLabel: TRANSACTION_TYPE_LABELS[TransactionTypes.SUPPLIER_PAYMENT],
        paymentType: details.paymentMode || 'Bank',
        amount: paid,
        taxableAmount: 0,
        balance: 0,
        gstAmount: 0,
        currency: payload.currency || details.currency || 'INR',
        projectId: details.projectId || details.poReference || '',
        status: 'Paid',
        record: inv,
        company,
        mappingFn: () => mapSupplierPaymentToVoucher(inv, company)
      });
    });
  }

  // Sort by date descending, then invoice number
  rows.sort((a, b) => {
    if (b.date !== a.date) return b.date.localeCompare(a.date);
    return (a.invoiceNo || '').localeCompare(b.invoiceNo || '');
  });

  return rows;
};

const inDateRange = (dateStr, dateFrom, dateTo) => {
  if (!dateStr) return false;
  if (!dateFrom && !dateTo) return true;
  const day = String(dateStr).slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return false;
  if (dateFrom && day < dateFrom) return false;
  if (dateTo && day > dateTo) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Map selected rows to Tally vouchers + collect required masters
// ---------------------------------------------------------------------------

/**
 * Given selected transaction rows, produce:
 *   vouchers (mapped, validated),
 *   masters (customer ledgers, supplier ledgers, stock items, units),
 *   validation results.
 *
 * Only rows that are selected AND pass validation are included in vouchers.
 */
export const mapSelectedToTally = ({ selectedRows, company }) => {
  const vouchers = [];
  const invalid = [];
  const warnings = [];

  // Collect all source records for master extraction
  const customerRecords = [];
  const supplierRecords = [];
  const allRecordsForItems = [];

  selectedRows.forEach((row) => {
    const mapped = row.mappingFn ? row.mappingFn() : null;
    if (!mapped) return;

    // Attach UI-level info
    mapped.uiRow = {
      id: row.id,
      invoiceNo: row.invoiceNo,
      partyName: row.partyName,
      transactionType: row.transactionType,
      amount: row.amount,
      balance: row.balance,
      currency: row.currency || 'INR'
    };

    if (mapped.isBalanced) {
      vouchers.push(mapped);
    } else {
      invalid.push({ voucher: mapped, errors: ['Voucher is not balanced (debit ≠ credit)'] });
    }

    const rowCurrency = row.currency || 'INR';
    const companyCurrency = company?.currency || company?.baseCurrency || 'INR';
    const mappingErrors = [
      ...(!company?.companyName ? ['Company name is missing from company settings.'] : []),
      ...(rowCurrency !== companyCurrency ? [`Recorded currency ${rowCurrency} differs from company base currency ${companyCurrency}; configure Tally currency conversion before export.`] : []),
      ...([TransactionTypes.CREDIT_NOTE, TransactionTypes.DEBIT_NOTE].includes(row.transactionType) && row.taxBreakdownRecorded !== true
        ? ['Recorded taxable amount and GST breakdown are incomplete; voucher export would require guessing tax values.']
        : [])
    ];
    if (mappingErrors.length) {
      if (mapped.isBalanced) {
        vouchers.splice(vouchers.indexOf(mapped), 1);
        invalid.push({ voucher: mapped, errors: mappingErrors });
      } else {
        invalid[invalid.length - 1].errors.push(...mappingErrors);
      }
    }

    // Track source records for masters
    allRecordsForItems.push(row.record);
    if ([TransactionTypes.SALE, TransactionTypes.CREDIT_NOTE, TransactionTypes.CUSTOMER_RECEIPT].includes(row.transactionType)) customerRecords.push(row.record);
    if ([TransactionTypes.PURCHASE, TransactionTypes.DEBIT_NOTE, TransactionTypes.SUPPLIER_PAYMENT].includes(row.transactionType)) supplierRecords.push(row.record);
  });

  const validation = validateVouchers(vouchers);
  const validVouchers = validation.valid;
  const validationInvalid = validation.invalid;
  const validationWarnings = validation.warnings;

  // Combine invalid from mapping + validation
  const allInvalid = [...invalid, ...validationInvalid];

  // Collect masters automatically from selected records
  const customerLedgers = collectCustomerLedgers(customerRecords);
  const supplierLedgers = collectSupplierLedgers(supplierRecords, fetchVendorMaster());
  const stockItems = collectStockItems(allRecordsForItems);
  const units = collectUnits(allRecordsForItems);

  // Add default accounting ledgers (Sales, Purchase, CGST, SGST, IGST, Bank, Cash)
  // These are always required for voucher posting
  const defaultLedgers = [
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.SALES, parent: TALLY_GROUPS.SALES, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.SALES },
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.PURCHASE, parent: TALLY_GROUPS.PURCHASES, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.PURCHASE },
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.CGST, parent: TALLY_GROUPS.CGST, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.CGST },
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.SGST, parent: TALLY_GROUPS.SGST, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.SGST },
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.IGST, parent: TALLY_GROUPS.IGST, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.IGST },
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.BANK, parent: TALLY_GROUPS.BANK_ACCOUNTS, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.BANK },
    { type: 'LEDGER', name: DEFAULT_LEDGER_NAMES.CASH, parent: TALLY_GROUPS.CASH_IN_HAND, openingBalance: 0, isDeemedPositive: false, gstin: '', pan: '', address: '', city: '', pincode: '', state: '', country: 'India', phone: '', email: '', gstRegistrationType: 'Unregistered', ledgerFrom: 'system', sourceId: DEFAULT_LEDGER_NAMES.CASH }
  ];

  // Deduplicate ledgers by name
  const seenLedgerNames = new Set();
  const allCustomerLedgers = [];
  [...customerLedgers, ...defaultLedgers].forEach((l) => {
    if (seenLedgerNames.has(l.name)) return;
    seenLedgerNames.add(l.name);
    allCustomerLedgers.push(l);
  });

  const seenSupplierNames = new Set();
  const allSupplierLedgers = [];
  supplierLedgers.forEach((l) => {
    if (seenSupplierNames.has(l.name)) return;
    seenSupplierNames.add(l.name);
    allSupplierLedgers.push(l);
  });

  return {
    vouchers: validVouchers,
    invalidVouchers: allInvalid,
    warnings: validationWarnings,
    masters: {
      customerLedgers: allCustomerLedgers,
      supplierLedgers: allSupplierLedgers,
      stockItems,
      units
    },
    counts: {
      sales: validVouchers.filter((v) => v.voucherType === 'Sales').length,
      purchases: validVouchers.filter((v) => v.voucherType === 'Purchase').length,
      creditNotes: validVouchers.filter((v) => v.voucherType === 'Credit Note').length,
      debitNotes: validVouchers.filter((v) => v.voucherType === 'Debit Note').length,
      receipts: validVouchers.filter((v) => v.voucherType === 'Receipt').length,
      payments: validVouchers.filter((v) => v.voucherType === 'Payment').length
    },
    totals: {
      totalTax: validVouchers.reduce((sum, v) => sum + (v.totals?.totalGST || 0), 0),
      totalGrand: validVouchers.reduce((sum, v) => sum + (v.totals?.grandTotal || 0), 0)
    }
  };
};

// ---------------------------------------------------------------------------
// XML generation
// ---------------------------------------------------------------------------

export const generateXml = ({ masters, vouchers, company }) => {
  const companyName = company?.companyName || 'PRAGMATIC ENGINEERS';

  const masterXml = buildMasterXml({
    customers: masters.customerLedgers || [],
    suppliers: masters.supplierLedgers || [],
    stockItems: masters.stockItems || [],
    units: masters.units || [],
    companyName
  });

  const voucherXml = buildVoucherXml({
    vouchers,
    companyName
  });

  const masterValidation = validateTallyXml(masterXml, 'master');
  const voucherValidation = validateTallyXml(voucherXml, 'voucher');

  return {
    masterXml,
    voucherXml,
    masterValid: masterValidation.valid,
    voucherValid: voucherValidation.valid,
    masterErrors: masterValidation.errors,
    voucherErrors: voucherValidation.errors
  };
};

// ---------------------------------------------------------------------------
// Export history persistence (server)
// ---------------------------------------------------------------------------

const getApiBase = () => {
  if (typeof window !== 'undefined' && window.location) {
    if (window.location.port === '5173') {
      return `http://${window.location.hostname || 'localhost'}:3001/api`;
    }
    return '/api';
  }
  return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const API_BASE = String(getApiBase()).replace(/\/$/, '');

export const saveExportHistory = async (exportData) => {
  const response = await fetch(`${API_BASE}/tally-export/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(exportData)
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const error = new Error(err.error || 'Failed to save export history');
    error.code = err.code;
    throw error;
  }
  return response.json();
};

export const storeExportFiles = async (exportId, { masterXml, voucherXml }) => {
  const results = [];

  if (masterXml) {
    const b64Master = btoa(unescape(encodeURIComponent(masterXml)));
    const res1 = await fetch(`${API_BASE}/tally-export/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        export_id: exportId,
        file_name: 'master.xml',
        file_type: 'master',
        content_base64: b64Master,
        content_type: 'application/xml'
      })
    });
    if (!res1.ok) throw new Error('Failed to store master.xml');
    results.push(await res1.json());
  }

  if (voucherXml) {
    const b64Voucher = btoa(unescape(encodeURIComponent(voucherXml)));
    const res2 = await fetch(`${API_BASE}/tally-export/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        export_id: exportId,
        file_name: 'voucher.xml',
        file_type: 'voucher',
        content_base64: b64Voucher,
        content_type: 'application/xml'
      })
    });
    if (!res2.ok) throw new Error('Failed to store voucher.xml');
    results.push(await res2.json());
  }

  return results;
};

export const fetchExportHistory = async () => {
  const response = await fetch(`${API_BASE}/tally-export/history`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch export history');
  return response.json();
};

export const fetchExportRecord = async (id) => {
  const response = await fetch(`${API_BASE}/tally-export/history/${id}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to fetch export record');
  return response.json();
};

export const downloadExportFile = async (exportId, fileType) => {
  const response = await fetch(`${API_BASE}/tally-export/file/${exportId}/${fileType}`, { headers: authHeaders() });
  if (!response.ok) throw new Error('Failed to download export file');

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileType === 'master' ? 'master.xml' : 'voucher.xml';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const updateExportStatus = async (id, { exportStatus, notes }) => {
  const response = await fetch(`${API_BASE}/tally-export/history/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ export_status: exportStatus, notes })
  });
  if (!response.ok) throw new Error('Failed to update export status');
  return response.json();
};

export const downloadXmlContent = (xmlContent, fileName) => {
  const blob = new Blob([xmlContent], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// Re-export for UI (already exported above via export const)
// TransactionTypes, TRANSACTION_TYPE_LABELS, DEFAULT_SELECTED_TYPES, DATE_PRESETS, computeDateRange are all exported above
