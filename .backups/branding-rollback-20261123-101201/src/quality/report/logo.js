import { LOGO_DATA_URI } from "./logoDataUri.js";
let cached = null;
async function getLogoDataUri() {
  if (cached) {
    return cached;
  }
  cached = LOGO_DATA_URI;
  return cached;
}
export {
  getLogoDataUri
};
