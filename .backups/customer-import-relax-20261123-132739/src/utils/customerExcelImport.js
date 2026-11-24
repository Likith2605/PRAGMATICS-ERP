// Default customer import template headings, in the required order.
export const CUSTOMER_EXCEL_COLUMNS = [
  'Sl No', 'Customer Name', 'Address', 'GST No', 'Tel No.',
  'Contact Person', 'Contact Person No', 'E-Mail', 'Vendor Code'
];

// Heading aliases map both the required headings and previously supported
// spreadsheet headings onto the canonical columns. Matching is done on a
// punctuation/space-insensitive key, so "GST No", "GSTNo", "GST-No" and
// "gst  no" all resolve to the same column.
const HEADER_ALIASES = {
  slno: 'Sl No', sno: 'Sl No', serialno: 'Sl No', 'serialnumber': 'Sl No', 'srno': 'Sl No',
  customername: 'Customer Name', company: 'Customer Name', companyname: 'Customer Name', partyname: 'Customer Name', name: 'Customer Name',
  address: 'Address', billingaddress: 'Address', billto: 'Address',
  gstno: 'GST No', gstin: 'GST No', gstnumber: 'GST No', gst: 'GST No', taxid: 'GST No',
  telno: 'Tel No.', tel: 'Tel No.', telephone: 'Tel No.', phonenumber: 'Tel No.', phone: 'Tel No.', mobile: 'Tel No.', contactnumber: 'Tel No.',
  contactperson: 'Contact Person', contact: 'Contact Person', contactname: 'Contact Person',
  contactpersonno: 'Contact Person No', contactpersonnumber: 'Contact Person No', contactpersonphone: 'Contact Person No', contactno: 'Contact Person No', contactmobileno: 'Contact Person No',
  email: 'E-Mail', emailaddress: 'E-Mail', mail: 'E-Mail',
  vendorcode: 'Vendor Code', customercode: 'Vendor Code', code: 'Vendor Code', customerid: 'Vendor Code', ledgername: 'Vendor Code'
};

export const normalizeCustomerHeader = (value) => String(value ?? '')
  .replace(/[\r\n\u2028\u2029]+/g, ' ')
  .replace(/[^a-z0-9]/gi, '')
  .toLocaleLowerCase();

const canonicalHeader = (value) => {
  const key = normalizeCustomerHeader(value);
  return HEADER_ALIASES[key] || CUSTOMER_EXCEL_COLUMNS.find((column) => normalizeCustomerHeader(column) === key) || null;
};

/** Map a spreadsheet row onto the canonical customer columns. */
export const mapCustomerExcelRow = (row = {}) => {
  const mapped = {};
  Object.entries(row).forEach(([heading, value]) => {
    const field = canonicalHeader(heading);
    if (field && mapped[field] === undefined) mapped[field] = typeof value === 'string' ? value.trim() : value;
  });
  return Object.fromEntries(CUSTOMER_EXCEL_COLUMNS.map((column) => [column, mapped[column] ?? '']));
};

/** Stable identity for duplicate detection: GSTIN first, then name + vendor code. */
export const customerDuplicateKey = (row = {}) => {
  const gstin = String(row['GST No'] || row.GSTIN || row.gstin || row.gstNumber || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (gstin && gstin !== 'URP') return `gstin:${gstin}`;
  const name = String(row['Customer Name'] || row.companyName || row.customerName || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const code = String(row['Vendor Code'] || row['Customer Code'] || row.customerCode || row.vendorCode || '').trim().toUpperCase();
  return name ? `name:${name}${code ? `|${code}` : ''}` : '';
};
