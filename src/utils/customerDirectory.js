import { createMaster, getCachedMasters, listMasters } from '../services/masterApi.js';

export const readCustomerDirectory = () => getCachedMasters('customers');

export const loadCustomerDirectory = () => listMasters('customers');

export const saveCustomerToDirectory = async (customer) => {
  const result = await createMaster('customers', customer);
  return result.record;
};
