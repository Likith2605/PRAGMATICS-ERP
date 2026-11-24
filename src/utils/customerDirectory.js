const STORAGE_KEY = 'customerDirectory';

export const readCustomerDirectory = () => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

/**
 * Append a customer to the central directory. Customer fields (GST No, vendor
 * code, phone, email, address, ...) are deliberately NOT unique: different
 * customers can share any of them. Exact duplicates are only reported as a
 * warning by the Excel import preview and are never rejected here.
 */
export const saveCustomerToDirectory = (customer, options = {}) => {
  const customers = readCustomerDirectory();
  const saved = { ...customer, id: `customer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([saved, ...customers]));
  if (!options.silent) window.dispatchEvent(new CustomEvent('customer-directory-updated', { detail: saved }));
  return saved;
};
