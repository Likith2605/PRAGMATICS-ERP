import { getCompanyLogoDataUri, NEUTRAL_LOGO_DATA_URI } from "../../utils/companyBranding.js";

async function getLogoDataUri() {
  // Use the logo configured in Company Settings when present. When no logo is
  // uploaded, return a neutral transparent placeholder — never another
  // company's logo. The bundled legacy logo asset is no longer referenced.
  return getCompanyLogoDataUri() || NEUTRAL_LOGO_DATA_URI;
}

export {
  getLogoDataUri
};
