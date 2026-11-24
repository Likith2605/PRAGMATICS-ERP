const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

export const matchesCustomerSearch = (customer, query) => {
  const nameQuery = normalizeName(query);
  const phoneQuery = String(query || '').replace(/\D/g, '');
  return normalizeName(customer.name).includes(nameQuery) ||
    normalizeName(customer.contactPerson).includes(nameQuery) ||
    (phoneQuery.length > 0 && String(customer.phone || '').replace(/\D/g, '').includes(phoneQuery));
};
