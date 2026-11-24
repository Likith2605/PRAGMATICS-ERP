import masterCustomers from '../constants/masterCustomers.json' with { type: 'json' };

/**
 * Utility for Master Customer Directory & Auto-Fill
 */

export const getMasterCustomerList = () => {
  return masterCustomers || [];
};

export const findMasterCustomer = (name) => {
  if (!name || typeof name !== 'string') return null;
  const clean = name.trim().toLowerCase();

  // 1. Direct match
  const exact = masterCustomers.find(
    (c) => (c.customerName && c.customerName.trim().toLowerCase() === clean) ||
           (c.companyName && c.companyName.trim().toLowerCase() === clean)
  );
  if (exact) return exact;

  // 2. Starts with / includes match
  const partial = masterCustomers.find((c) => {
    const cName = (c.customerName || c.companyName || '').trim().toLowerCase();
    return cName.includes(clean) || clean.includes(cName);
  });

  return partial || null;
};

export const enrichCustomerDetails = (customerName, defaultDetails = {}) => {
  const master = findMasterCustomer(customerName);
  if (!master) {
    return {
      customerName: customerName || '',
      companyName: customerName || '',
      address: defaultDetails.address || '',
      contactNumber: defaultDetails.contactNumber || defaultDetails.phone || '',
      phone: defaultDetails.phone || defaultDetails.contactNumber || '',
      email: defaultDetails.email || '',
      gstNumber: defaultDetails.gstNumber || defaultDetails.gstin || '',
      gstin: defaultDetails.gstin || defaultDetails.gstNumber || '',
      vendorCode: defaultDetails.vendorCode || ''
    };
  }

  return {
    customerName: master.contactPerson || master.customerName || customerName,
    companyName: master.companyName || master.customerName || customerName,
    address: master.address || defaultDetails.address || '',
    contactNumber: master.contactNumber || master.phone || defaultDetails.contactNumber || defaultDetails.phone || '',
    phone: master.phone || master.contactNumber || defaultDetails.phone || defaultDetails.contactNumber || '',
    email: master.email || defaultDetails.email || '',
    gstNumber: master.gstNumber || master.gstin || defaultDetails.gstNumber || defaultDetails.gstin || '',
    gstin: master.gstin || master.gstNumber || defaultDetails.gstin || defaultDetails.gstNumber || '',
    vendorCode: master.vendorCode && master.vendorCode !== 'no vendor code' ? master.vendorCode : (defaultDetails.vendorCode || '')
  };
};
