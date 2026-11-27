const MONEY_SCALE = 10000n;
const INELIGIBLE_STATUSES = new Set(['cancelled', 'canceled', 'deleted', 'draft', 'rejected', 'void', 'voided']);

const moneyUnits = (value, label, { optional = false } = {}) => {
  if ((value == null || value === '') && optional) return 0n;
  const text = String(value ?? '').replace(/,/g, '').trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`${label} is missing or is not a valid decimal amount.`);
  const fraction = match[3] || '';
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) {
    throw new Error(`${label} exceeds the supported four-decimal precision.`);
  }
  const units = BigInt(match[2]) * MONEY_SCALE + BigInt(fraction.slice(0, 4).padEnd(4, '0') || '0');
  return match[1] ? -units : units;
};

const asAmount = (units) => Number(units) / Number(MONEY_SCALE);
const normalizedParty = (value) => String(value || '').trim().toLocaleLowerCase();
const groupKey = (party, currency) => `${normalizedParty(party)}\u0000${String(currency || '').toUpperCase()}`;
const invoiceStatusExcluded = (invoice) => {
  const status = String(invoice.status || invoice.payload?.invoiceDetails?.paymentStatus || '').trim().toLowerCase();
  return INELIGIBLE_STATUSES.has(status) || Boolean(invoice.deletedAt || invoice.deleted_at);
};

const invoiceValues = (invoice) => {
  const details = invoice.payload?.invoiceDetails || {};
  const currency = String(details.currency || invoice.payload?.currency || 'INR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Supplier Invoice ${invoice.reference || ''} has an invalid currency.`);
  const amountValue = invoice.payload?.totals?.grandTotal ?? invoice.total;
  const invoiceAmount = moneyUnits(amountValue, `Supplier Invoice ${invoice.reference || ''} amount`);
  const paidAmount = moneyUnits(details.amountPaid ?? 0, `Supplier Invoice ${invoice.reference || ''} payments`);
  const advanceAmount = moneyUnits(
    invoice.advanceAdjusted ?? details.advanceAdjusted ?? 0,
    `Supplier Invoice ${invoice.reference || ''} advance allocation`
  );
  if (invoiceAmount < 0n || paidAmount < 0n || advanceAmount < 0n) {
    throw new Error(`Supplier Invoice ${invoice.reference || ''} has a negative financial value.`);
  }
  if (paidAmount + advanceAmount > invoiceAmount) {
    throw new Error(`Supplier Invoice ${invoice.reference || ''} payments and advances exceed its amount.`);
  }
  const outstanding = invoiceAmount - paidAmount - advanceAmount;
  if (details.balanceDue != null && details.balanceDue !== '') {
    const storedBalance = moneyUnits(details.balanceDue, `Supplier Invoice ${invoice.reference || ''} PostgreSQL balance`);
    if (storedBalance !== outstanding) {
      throw new Error(`Supplier Invoice ${invoice.reference || ''} settlement balance does not match its PostgreSQL payment and advance totals.`);
    }
  }
  return { currency, invoiceAmount, paidAmount, advanceAmount };
};

const addTo = (map, key, amount) => map.set(key, (map.get(key) || 0n) + amount);

export const sumSupplierOutstanding = (rows, key) =>
  asAmount((rows || []).reduce((total, row) => total + moneyUnits(row[key] ?? 0, key), 0n));

export const buildSupplierOutstandingRows = (invoices, advances) => {
  if (!Array.isArray(invoices) || !Array.isArray(advances)) {
    throw new Error('Supplier Outstanding requires complete PostgreSQL invoice and advance responses.');
  }

  const invoiceAllocations = new Map();
  const advanceAllocations = new Map();
  const supplierIds = new Map();
  const ambiguousSupplierIds = new Set();
  const parsedInvoices = [];

  for (const invoice of invoices) {
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
      throw new Error('Supplier Invoice response contains an invalid record.');
    }
    const values = invoiceValues(invoice);
    const supplierName = String(
      invoice.vendor || invoice.payload?.vendorDetails?.companyName || invoice.payload?.vendorDetails?.vendorName || ''
    ).trim();
    if (!supplierName) throw new Error(`Supplier Invoice ${invoice.reference || ''} has no supplier name.`);
    const key = groupKey(supplierName, values.currency);
    if (!invoiceStatusExcluded(invoice)) addTo(invoiceAllocations, key, values.advanceAmount);
    parsedInvoices.push({ invoice, supplierName, ...values, eligible: !invoiceStatusExcluded(invoice) });
  }

  for (const advance of advances) {
    if (!advance || typeof advance !== 'object' || Array.isArray(advance)) {
      throw new Error('Supplier Advance response contains an invalid record.');
    }
    if (advance.deletedAt || advance.deleted_at) continue;
    const party = String(advance.party || '').trim();
    const currency = String(advance.currency || '').trim().toUpperCase();
    if (!party || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`Supplier Advance ${advance.advanceNumber || ''} has incomplete party or currency data.`);
    }
    if (advance.partyId) {
      const partyKey = normalizedParty(party);
      const existingId = supplierIds.get(partyKey);
      if (existingId && existingId !== String(advance.partyId)) ambiguousSupplierIds.add(partyKey);
      else supplierIds.set(partyKey, String(advance.partyId));
    }
    const applied = moneyUnits(advance.appliedAmount ?? 0, `Supplier Advance ${advance.advanceNumber || ''} allocations`);
    if (applied < 0n) throw new Error(`Supplier Advance ${advance.advanceNumber || ''} has a negative allocation total.`);
    addTo(advanceAllocations, groupKey(party, currency), applied);
  }

  const reconciliationKeys = new Set([...invoiceAllocations.keys(), ...advanceAllocations.keys()]);
  for (const key of reconciliationKeys) {
    if ((invoiceAllocations.get(key) || 0n) !== (advanceAllocations.get(key) || 0n)) {
      throw new Error('Supplier advance allocations do not reconcile with PostgreSQL invoice balances. Reload the report or contact an administrator.');
    }
  }

  return parsedInvoices.flatMap(({ invoice, supplierName, currency, invoiceAmount, paidAmount, advanceAmount, eligible }) => {
    if (!eligible) return [];
    const outstanding = invoiceAmount - paidAmount - advanceAmount;
    if (outstanding <= 0n) return [];
    const date = invoice.date || invoice.payload?.invoiceDetails?.supplierInvoiceDate || '';
    const invoiceDateTime = date ? new Date(date).getTime() : Number.NaN;
    const ageDays = Number.isNaN(invoiceDateTime)
      ? 0
      : Math.max(0, Math.floor((Date.now() - invoiceDateTime) / 86400000));
    const status = String(invoice.status || invoice.payload?.invoiceDetails?.paymentStatus ||
      (paidAmount + advanceAmount > 0n ? 'Partial' : 'Pending'));
    return [{
      supplierName,
      supplierId: String(invoice.vendorId || invoice.vendor_id || invoice.payload?.vendorDetails?.vendorId ||
        (!ambiguousSupplierIds.has(normalizedParty(supplierName)) ? supplierIds.get(normalizedParty(supplierName)) : '') || ''),
      invoiceNumber: String(invoice.reference || invoice.payload?.invoiceDetails?.supplierInvoiceNumber || ''),
      date,
      dueDate: invoice.dueDate || invoice.payload?.invoiceDetails?.paymentDueDate || '',
      currency,
      invoiceAmount: asAmount(invoiceAmount),
      amountPaid: asAmount(paidAmount),
      advanceAllocated: asAmount(advanceAmount),
      outstandingAmount: asAmount(outstanding),
      ageDays,
      paymentStatus: status
    }];
  });
};

export const buildSupplierOutstandingSummary = (rows) => {
  const currencies = new Map();
  for (const row of rows || []) {
    const currency = String(row.currency || 'INR').toUpperCase();
    const summary = currencies.get(currency) || {
      currency,
      invoiceAmount: 0n,
      amountPaid: 0n,
      advanceAllocated: 0n,
      outstandingAmount: 0n
    };
    summary.invoiceAmount += moneyUnits(row.invoiceAmount ?? 0, 'Invoice amount');
    summary.amountPaid += moneyUnits(row.amountPaid ?? 0, 'Payments');
    summary.advanceAllocated += moneyUnits(row.advanceAllocated ?? 0, 'Advance allocation');
    summary.outstandingAmount += moneyUnits(row.outstandingAmount ?? 0, 'Outstanding amount');
    currencies.set(currency, summary);
  }
  return [...currencies.values()].map((summary) => ({
    currency: summary.currency,
    invoiceAmount: asAmount(summary.invoiceAmount),
    amountPaid: asAmount(summary.amountPaid),
    advanceAllocated: asAmount(summary.advanceAllocated),
    outstandingAmount: asAmount(summary.outstandingAmount)
  }));
};

export const buildSupplierOutstandingPartySummary = (rows) => {
  const groups = new Map();
  for (const row of rows || []) {
    const key = `${groupKey(row.supplierName, row.currency)}\u0000${row.supplierId || ''}`;
    const group = groups.get(key) || {
      supplierName: row.supplierName,
      supplierId: row.supplierId || '',
      currency: row.currency,
      invoiceAmount: 0n,
      amountPaid: 0n,
      advanceAllocated: 0n,
      outstandingAmount: 0n
    };
    group.invoiceAmount += moneyUnits(row.invoiceAmount ?? 0, 'Invoice amount');
    group.amountPaid += moneyUnits(row.amountPaid ?? 0, 'Payments');
    group.advanceAllocated += moneyUnits(row.advanceAllocated ?? 0, 'Advance allocation');
    group.outstandingAmount += moneyUnits(row.outstandingAmount ?? 0, 'Outstanding amount');
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    supplierName: group.supplierName,
    supplierId: group.supplierId,
    currency: group.currency,
    invoiceAmount: asAmount(group.invoiceAmount),
    amountPaid: asAmount(group.amountPaid),
    advanceAllocated: asAmount(group.advanceAllocated),
    outstandingAmount: asAmount(group.outstandingAmount)
  }));
};
