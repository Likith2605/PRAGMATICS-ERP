const belowTwenty = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen'
];

const tens = ['Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const scales = ['Thousand', 'Million', 'Billion', 'Trillion'];

const convertBelowThousand = (number) => {
  let result = '';

  if (number >= 100) {
    result += `${belowTwenty[Math.floor(number / 100)]} Hundred`;
    number %= 100;
  }

  if (number >= 20) {
    if (result) result += ' ';
    result += tens[Math.floor(number / 10) - 2];
    if (number % 10) {
      result += ` ${belowTwenty[number % 10]}`;
    }
  } else if (number > 0) {
    if (result) result += ' ';
    result += belowTwenty[number];
  }

  return result;
};

export const numberToWords = (value, currencyWord = 'Rupees', subWord = 'Paise') => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return `Zero ${currencyWord}`;
  }

  const fixed = number.toFixed(2);
  const [integerPart, decimalPart] = fixed.split('.');
  const integerNumber = parseInt(integerPart, 10);
  const decimalNumber = parseInt(decimalPart, 10);

  if (integerNumber === 0 && decimalNumber === 0) {
    return `Zero ${currencyWord}`;
  }

  const parts = [];
  let remainder = integerNumber;
  let scaleIndex = 0;

  while (remainder > 0) {
    const chunk = remainder % 1000;
    if (chunk) {
      const chunkWords = convertBelowThousand(chunk);
      const scale = scaleIndex ? ` ${scales[scaleIndex - 1]}` : '';
      parts.unshift(`${chunkWords}${scale}`);
    }
    remainder = Math.floor(remainder / 1000);
    scaleIndex += 1;
  }

  const words = `${parts.join(' ')} ${currencyWord}`;
  if (decimalNumber > 0) {
    return `${words} and ${convertBelowThousand(decimalNumber)} ${subWord}`;
  }

  return words;
};
