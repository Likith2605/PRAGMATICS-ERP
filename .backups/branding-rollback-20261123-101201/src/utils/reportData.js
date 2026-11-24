import { OFFICIAL_COMPANY_PROFILE } from '../constants/companyProfile.js';

// Read-only localStorage accessor shared by report and ledger pages.
export const readLocalStorageList = (key) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const getReportCompanyProfile = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('companySettings') || '{}');
    return { ...OFFICIAL_COMPANY_PROFILE, ...saved };
  } catch {
    return { ...OFFICIAL_COMPANY_PROFILE };
  }
};
