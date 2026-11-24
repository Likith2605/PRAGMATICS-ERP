/**
 * Customer master lookup helper.
 *
 * Customer masters are now entered manually or imported from Excel into the
 * synchronised `customerDirectory` record. No company/customer records are
 * embedded in the application source.
 */

export const getMasterCustomerList = () => [];

export const findMasterCustomer = () => null;

export const enrichCustomerDetails = (customerName, defaultDetails = {}) => ({
  customerName: customerName || '',
  companyName: customerName || '',
  address: defaultDetails.address || '',
  contactNumber: defaultDetails.contactNumber || defaultDetails.phone || '',
  phone: defaultDetails.phone || defaultDetails.contactNumber || '',
  email: defaultDetails.email || '',
  gstNumber: defaultDetails.gstNumber || defaultDetails.gstin || '',
  gstin: defaultDetails.gstin || defaultDetails.gstNumber || '',
  vendorCode: defaultDetails.vendorCode || ''
});
