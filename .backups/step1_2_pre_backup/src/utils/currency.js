import { numberToWords } from './numberToWords.js';

export const DEFAULT_CURRENCY = 'INR';

export const CURRENCIES = [
  { code: 'INR', symbol: '₹', label: 'INR — Indian Rupee', locale: 'en-IN', word: 'Rupees', subWord: 'Paise' },
  { code: 'USD', symbol: '$', label: 'USD — US Dollar', locale: 'en-US', word: 'Dollars', subWord: 'Cents' },
  { code: 'EUR', symbol: '€', label: 'EUR — Euro', locale: 'en-DE', word: 'Euros', subWord: 'Cents' },
  { code: 'GBP', symbol: '£', label: 'GBP — Pound Sterling', locale: 'en-GB', word: 'Pounds', subWord: 'Pence' },
  { code: 'AED', symbol: 'AED', label: 'AED — UAE Dirham', locale: 'en-AE', word: 'Dirhams', subWord: 'Fils' },
  { code: 'AUD', symbol: 'A$', label: 'AUD — Australian Dollar', locale: 'en-AU', word: 'Dollars', subWord: 'Cents' },
  { code: 'SGD', symbol: 'S$', label: 'SGD — Singapore Dollar', locale: 'en-SG', word: 'Dollars', subWord: 'Cents' }
];

export const getCurrency = (code) => {
  const normalized = String(code || DEFAULT_CURRENCY).trim().toUpperCase();
  return CURRENCIES.find((currency) => currency.code === normalized) || CURRENCIES[0];
};

export const isForeignCurrency = (code) =>
  String(code || DEFAULT_CURRENCY).trim().toUpperCase() !== DEFAULT_CURRENCY;

export const money = (value, code = DEFAULT_CURRENCY) => {
  const currency = getCurrency(code);
  const parsed = Number(value);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  try {
    return new Intl.NumberFormat(currency.locale, {
      style: 'currency',
      currency: currency.code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${currency.symbol} ${amount.toFixed(2)}`;
  }
};

export const moneyPlain = (value, code = DEFAULT_CURRENCY) => {
  const currency = getCurrency(code);
  const parsed = Number(value);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  try {
    return new Intl.NumberFormat(currency.locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
};

export const convertToINR = (amount, code = DEFAULT_CURRENCY, rate = 1) => {
  const parsed = Number(amount);
  const value = Number.isFinite(parsed) ? parsed : 0;
  if (!isForeignCurrency(code)) {
    return Number(value.toFixed(2));
  }
  const rateValue = Number(rate);
  if (!(rateValue > 0)) {
    return 0;
  }
  return Number((value * rateValue).toFixed(2));
};

export const amountInWords = (value, code = DEFAULT_CURRENCY) => {
  const currency = getCurrency(code);
  return numberToWords(value, currency.word, currency.subWord);
};
