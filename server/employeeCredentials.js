import { randomBytes, scrypt as callbackScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(callbackScrypt);
const KEY_LENGTH = 64;

const constantTimeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

export const hashEmployeePassword = async (password) => {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
};

export const verifyEmployeePassword = async (password, stored) => {
  const value = String(stored || '');
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(value);
  if (!match) return constantTimeEqual(password, value);
  const salt = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(match[2], 'hex');
  const actual = await scrypt(String(password), salt, expected.length);
  return timingSafeEqual(actual, expected);
};

export const hashLegacyEmployeePassword = async (password) => {
  const value = String(password || '');
  return /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(value) ? value : hashEmployeePassword(value);
};
