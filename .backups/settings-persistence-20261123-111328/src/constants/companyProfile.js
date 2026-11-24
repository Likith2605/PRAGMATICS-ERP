// Neutral baseline used only when a company has not configured Company Settings
// yet. It deliberately contains no company-specific information: all values come
// from the saved, PostgreSQL-synchronised `companySettings` record.
export const OFFICIAL_COMPANY_PROFILE = {
  companyName: '',
  legalName: '',
  tagline: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  state: '',
  gstin: '',
  pan: ''
};
