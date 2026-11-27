import { getCompanyProfile } from './companyBranding.js';

// Read-only localStorage accessor shared by report and ledger pages.
export const readLocalStorageList = (key) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const getReportCompanyProfile = () => getCompanyProfile();
