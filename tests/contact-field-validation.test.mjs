import assert from 'node:assert/strict';
import {
  EMAIL_ERROR,
  GSTIN_ERROR,
  PHONE_ERROR,
  findChangedContactValidationError,
  normalizeGSTINInput,
  validateEmail,
  validateGSTIN,
  validatePhoneNumber
} from '../shared/fieldValidation.js';

assert.equal(validatePhoneNumber('1234567890'), null);
assert.equal(validatePhoneNumber('123456789'), PHONE_ERROR);
assert.equal(validatePhoneNumber('12345678901'), PHONE_ERROR);
assert.equal(validatePhoneNumber('12345a7890'), PHONE_ERROR);
assert.equal(validatePhoneNumber('12345-7890'), PHONE_ERROR);
assert.equal(validatePhoneNumber(''), null);

assert.equal(validateEmail('AA@gmail.com'), null);
for (const invalid of ['AAgmail.com', 'AA@', 'AA@gmail', 'AA gmail.com', 'a..b@example.com']) {
  assert.equal(validateEmail(invalid), EMAIL_ERROR, `${invalid} should be rejected`);
}
assert.equal(validateEmail(''), null);
assert.equal(validateEmail('', { required: true }), EMAIL_ERROR, 'required empty email should be rejected');

assert.equal(validateGSTIN('29ABCDE1234F1Z5'), null);
assert.equal(normalizeGSTINInput('29abcde1234f1z5'), '29ABCDE1234F1Z5');
for (const valid of ['123455EFHEVFJHE', '00AAAAAAAAAAAAA', '39ABCDE1234F1Z5', '29ABCDE1234F1ZA']) {
  assert.equal(validateGSTIN(valid), null, `${valid} should pass without GSTIN structure checks`);
}
for (const invalid of ['29ABCDE1234F1Z', '29ABCDE1234F1Z55', '29ABCDE 1234F1Z5', '29ABCDE-1234F1Z5', '29ABCDE!234F1Z5', '29ABCDE_234F1Z5']) {
  assert.equal(validateGSTIN(invalid), GSTIN_ERROR, `${invalid} should be rejected`);
}
assert.equal(validateGSTIN(''), null);
assert.equal(validateGSTIN('', { required: true }), GSTIN_ERROR);

assert.equal(findChangedContactValidationError({ email: 'bad-address' }), EMAIL_ERROR);
assert.equal(findChangedContactValidationError({ phone: '123456789' }), PHONE_ERROR);
assert.equal(findChangedContactValidationError({ gstin: '29ABCDE1234F1Z' }), GSTIN_ERROR);
assert.equal(findChangedContactValidationError({ gstin: '123455EFHEVFJHE' }), null);
assert.equal(findChangedContactValidationError(
  { records: [{ id: 'old', phone: '+91 123' }, { id: 'new', phone: '123456789' }] },
  { records: [{ id: 'old', phone: '+91 123' }] }
), PHONE_ERROR);
assert.equal(findChangedContactValidationError(
  { records: [{ id: 'old', phone: '+91 123', name: 'Updated label' }] },
  { records: [{ id: 'old', phone: '+91 123', name: 'Old label' }] }
), null, 'unchanged legacy data should not be forced through a migration');

console.log('Contact field validation checks passed.');
