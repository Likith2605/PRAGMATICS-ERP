export const PHONE_ERROR = 'Phone number must contain exactly 10 digits.';
export const EMAIL_ERROR = 'Please enter a valid email address.';
export const GSTIN_ERROR = 'GSTIN must contain exactly 15 alphanumeric characters.';

export const EMAIL_PATTERN = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])";
export const GSTIN_PATTERN = '[A-Z0-9]{15}';

const GSTIN_REGEX = new RegExp(`^${GSTIN_PATTERN}$`);
const EMAIL_REGEX = new RegExp(`^(?=.{3,254}$)${EMAIL_PATTERN}$`, 'i');

const empty = (value) => value == null || String(value).length === 0;

export const validatePhoneNumber = (value, { required = false } = {}) => {
  if (empty(value)) return required ? PHONE_ERROR : null;
  return /^[0-9]{10}$/.test(String(value)) ? null : PHONE_ERROR;
};

export const validateEmail = (value, { required = false } = {}) => {
  if (empty(value)) return required ? EMAIL_ERROR : null;
  const email = String(value);
  if (email.length > 254 || email.includes(' ') || email.includes('..')) return EMAIL_ERROR;
  const [localPart, domain] = email.split('@');
  if (!localPart || localPart.length > 64 || localPart.startsWith('.') || localPart.endsWith('.') || !domain) return EMAIL_ERROR;
  return EMAIL_REGEX.test(email) ? null : EMAIL_ERROR;
};

export const validateGSTIN = (value, { required = false } = {}) => {
  if (empty(value)) return required ? GSTIN_ERROR : null;
  return GSTIN_REGEX.test(String(value)) ? null : GSTIN_ERROR;
};

export const normalizeGSTINInput = (value) => String(value ?? '').toUpperCase();

export const getContactValidationType = (fieldName) => {
  const name = String(fieldName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name.includes('gstin') || name.includes('gstnumber') || name.includes('gstno')) return 'gstin';
  if (name.includes('email') || name.includes('emailaddress')) return 'email';
  if (name.includes('phone') || name.includes('mobile') || name.includes('telephone') || name.includes('telno') || name.includes('contactnumber') || name.includes('contactno')) return 'phone';
  return null;
};

export const validateContactField = (type, value, options) => {
  if (type === 'phone') return validatePhoneNumber(value, options);
  if (type === 'email') return validateEmail(value, options);
  if (type === 'gstin') return validateGSTIN(value, options);
  return null;
};

const ARRAY_IDENTITY_KEYS = ['id', 'employeeId', 'employeeCode', 'customerId', 'customerCode', 'vendorId', 'vendorCode', 'seq', 'projectId', 'itemCode', 'quotationNumber', 'invoiceNumber', 'code', 'key'];

const matchPreviousArrayItem = (item, index, previous, currentLength) => {
  if (!Array.isArray(previous)) return undefined;
  if (item && typeof item === 'object') {
    for (const key of ARRAY_IDENTITY_KEYS) {
      if (item[key] == null || item[key] === '') continue;
      const match = previous.find((candidate) => candidate && typeof candidate === 'object' && String(candidate[key] ?? '') === String(item[key]));
      if (match) return match;
    }
  }
  return previous.length === currentLength ? previous[index] : undefined;
};

/**
 * Validate contact fields that are new or changed in a generic ERP API payload.
 * Unchanged legacy values remain readable/editable without forcing a data migration.
 */
export const findChangedContactValidationError = (incoming, previous) => {
  const visit = (value, oldValue) => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const oldItem = matchPreviousArrayItem(value[index], index, oldValue, value.length);
        const error = visit(value[index], oldItem);
        if (error) return error;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    for (const [key, child] of Object.entries(value)) {
      const type = getContactValidationType(key);
      if (type && (oldValue == null || JSON.stringify(child) !== JSON.stringify(oldValue?.[key]))) {
        const error = validateContactField(type, child);
        if (error) return error;
      } else if (child && typeof child === 'object') {
        const error = visit(child, oldValue?.[key]);
        if (error) return error;
      }
    }
    return null;
  };
  return visit(incoming, previous);
};
