import { useEffect, useState } from 'react';
import { OFFICIAL_COMPANY_PROFILE } from '../constants/companyProfile.js';
import { getCachedCompanySettings } from '../services/masterApi.js';

// Company branding is read only from the authenticated PostgreSQL master API.
export const COMPANY_SETTINGS_KEY = 'companySettings';
export const COMPANY_BRANDING_EVENT = 'company-branding-updated';

// Transparent 1x1 placeholder used when no company logo is configured. It is
// deliberately neutral: no company's branding is shown on a fresh install, and
// existing image/PDF code paths keep working without any layout changes.
export const NEUTRAL_LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=';

const readSettings = () => getCachedCompanySettings();

/** Stored company settings with the shipped official profile as a baseline.
 *  Explicitly saved values (including blank ones) always win. */
export const getCompanyProfile = () => ({ ...OFFICIAL_COMPANY_PROFILE, ...readSettings() });

/** The company legal name configured in Company Settings. */
export const getCompanyLegalName = () => {
  const profile = getCompanyProfile();
  return String(profile.companyName || profile.legalName || '').trim() || OFFICIAL_COMPANY_PROFILE.companyName;
};

/** The uploaded logo as a data URI, or '' when no custom logo is configured. */
export const getCompanyLogoDataUri = () => {
  const settings = readSettings();
  const value = settings.logoDataUrl || '';
  return typeof value === 'string' && /^data:image\//i.test(value) ? value : '';
};

/** Tell mounted components that the shared branding record has been saved. */
export const notifyCompanyBrandingUpdated = () => {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(COMPANY_BRANDING_EVENT));
  }
};

/** React accessor: keeps branding in sync with confirmed PostgreSQL settings. */
export const useCompanyBranding = (fallbackLogoUrl = NEUTRAL_LOGO_DATA_URI) => {
  const snapshot = () => ({
    logoUrl: getCompanyLogoDataUri() || fallbackLogoUrl,
    companyName: getCompanyLegalName(),
    company: getCompanyProfile()
  });
  const [branding, setBranding] = useState(snapshot);

  useEffect(() => {
    const update = () => setBranding(snapshot());
    update();
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    window.addEventListener(COMPANY_BRANDING_EVENT, update);
    return () => {
      window.removeEventListener(COMPANY_BRANDING_EVENT, update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackLogoUrl]);

  return branding;
};
