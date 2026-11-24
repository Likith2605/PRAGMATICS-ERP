import { getMasterCustomerList } from './customerMaster.js';

const STORAGE_KEY = 'customerDirectory';

export const readCustomerDirectory = () => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

export const saveCustomerToDirectory = (customer) => {
  const customers = readCustomerDirectory();
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const companyName = normalize(customer.companyName);
  const gstin = normalize(customer.gstin);
  const historicalCustomers = ['projectRequests', 'quotationHistory', 'salesOrderHistory', 'customerInvoiceHistory'].flatMap((key) => {
    try {
      const records = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(records) ? records.map((record) => record.payload?.customerDetails || record.customerDetails || record) : [];
    } catch { return []; }
  });
  const duplicate = [...customers, ...getMasterCustomerList(), ...historicalCustomers].find((entry) =>
    (companyName && normalize(entry.companyName || entry.customerName) === companyName) ||
    (gstin && normalize(entry.gstin || entry.gstNumber) === gstin)
  );
  if (duplicate) throw new Error('A customer with this company name already exists.');
  const saved = { ...customer, id: `customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([saved, ...customers]));
  window.dispatchEvent(new CustomEvent('customer-directory-updated', { detail: saved }));
  return saved;
};
