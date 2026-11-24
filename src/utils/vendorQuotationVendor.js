import { getVendorByName, getVendorBySeq } from './vendorMaster.js';

export const vendorEntryName = (entry) => typeof entry === 'string'
  ? entry.trim()
  : String(entry?.name || entry?.vendorName || entry?.supplierName || '').trim();

const getVendorEntries = (enq) => {
  if (Array.isArray(enq?.vendors) && enq.vendors.length > 0) return enq.vendors;
  const legacyVendor = enq?.vendor || enq?.vendorName || enq?.supplierName;
  return legacyVendor ? [legacyVendor] : [];
};

export const getEnquiryVendorChoices = (enq) => getVendorEntries(enq).map((entry, index) => {
  const name = vendorEntryName(entry);
  const entryId = typeof entry === 'object' && entry
    ? (entry.vendorId || entry.vendorMasterId || entry.vendorSeq || entry.seq || '')
    : '';
  const master = (entryId ? getVendorBySeq(entryId) : null) || getVendorByName(name);
  return {
    key: String(index),
    vendorId: master?.seq || entryId || '',
    name: master?.name || name,
    contact: (typeof entry === 'object' && entry ? (entry.contact || entry.contactPerson) : '') || master?.contactPerson || master?.contact || '',
    email: (typeof entry === 'object' && entry ? entry.email : '') || master?.email || '',
    phone: (typeof entry === 'object' && entry ? entry.phone : '') || master?.phone || '',
    status: typeof entry === 'object' && entry ? entry.status || '' : ''
  };
}).filter((vendor) => vendor.name);

const normalized = (value) => String(value || '').trim().toLowerCase();

export const hasQuotationForEnquiryVendor = (enquiry, vendor, quotations = []) =>
  quotations.some((quotation) => {
    if (String(quotation.enquiryNumber || '') !== String(enquiry?.enquiryNumber || '')) return false;
    const quotationVendorId = quotation.vendorId;
    if (quotationVendorId && vendor.vendorId) return String(quotationVendorId) === String(vendor.vendorId);
    return normalized(quotation.vendorName) === normalized(vendor.name);
  });

export const getPendingEnquiryVendorChoices = (enquiry, quotations = []) => {
  const choices = getEnquiryVendorChoices(enquiry);
  if (choices.length === 0) return [];
  return choices.filter((vendor) =>
    normalized(vendor.status) !== 'quotation received' && !hasQuotationForEnquiryVendor(enquiry, vendor, quotations)
  );
};

export const getQuotationFormVendorChoices = (enquiry, quotations = []) => {
  const pending = getPendingEnquiryVendorChoices(enquiry, quotations);
  return pending.length > 0 ? pending : getEnquiryVendorChoices(enquiry);
};

export const hasPendingEnquiryVendor = (enquiry, quotations = []) => {
  if (getEnquiryVendorChoices(enquiry).length === 0) {
    return !quotations.some((quotation) => String(quotation.enquiryNumber || '') === String(enquiry?.enquiryNumber || ''));
  }
  return getPendingEnquiryVendorChoices(enquiry, quotations).length > 0;
};
