import { OFFICIAL_COMPANY_PROFILE } from '../constants/companyProfile.js';

// Read-only localStorage accessor for report pages.
// Reports never write; this helper only reads and safely parses lists.

export const readLocalStorageList = (key) => {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Company Settings is the live source of truth; the official profile only
// supplies safe defaults for older installations or incomplete settings.
export const getReportCompanyProfile = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('companySettings') || '{}');
    return { ...OFFICIAL_COMPANY_PROFILE, ...saved };
  } catch {
    return { ...OFFICIAL_COMPANY_PROFILE };
  }
};
