import assert from 'node:assert/strict';
import { invReceivableINR } from '../src/utils/invoiceValues.js';

const makeInvoice = (overrides = {}) => ({
  status: 'Pending',
  currency: 'INR',
  total: '₹ 1,000.00',
  amountINR: 1000,
  balanceINR: 1000,
  receivedINR: 0,
  balanceDue: '₹ 1,000.00',
  amountReceived: '₹ 0.00',
  payload: {
    invoiceDetails: { currency: 'INR', paymentStatus: 'Pending', amountReceived: 0, balanceDue: 1000 },
    totals: { grandTotal: 1000 },
    amountINR: 1000,
    receivedINR: 0,
    balanceINR: 1000
  },
  ...overrides
});

assert.equal(invReceivableINR(makeInvoice()), 1000, 'unpaid invoice contributes its full outstanding balance');

assert.equal(invReceivableINR(makeInvoice({
  status: 'Partial', balanceINR: 650, balanceDue: '₹ 650.00', amountReceived: '₹ 350.00', receivedINR: 350,
  payload: {
    invoiceDetails: { currency: 'INR', paymentStatus: 'Partial', amountReceived: 350, balanceDue: 650 },
    totals: { grandTotal: 1000 }, amountINR: 1000, receivedINR: 350, balanceINR: 650
  }
})), 650, 'partially paid invoice contributes only its remaining balance');

assert.equal(invReceivableINR(makeInvoice({
  status: 'Paid', balanceINR: 1000, balanceDue: '₹ 1,000.00'
})), 0, 'fully paid invoice is excluded even if stale balance fields remain');

assert.equal(invReceivableINR({
  status: 'Partial', total: '₹ 1,000.00', amountReceived: '₹ 275.00',
  payload: { invoiceDetails: { currency: 'INR', paymentStatus: 'Partial', amountReceived: 275 }, totals: { grandTotal: 1000 } }
}), 725, 'legacy INR invoice derives balance from total less amount received');

assert.equal(invReceivableINR({
  status: 'Partial', currency: 'USD', total: 'USD 100.00', amountReceived: 'USD 25.00',
  payload: { invoiceDetails: { currency: 'USD', exchangeRate: 80, paymentStatus: 'Partial', amountReceived: 25 }, totals: { grandTotal: 100 } }
}), 6000, 'legacy foreign-currency invoice converts the remaining amount using its saved exchange rate');

assert.equal(invReceivableINR({
  status: 'Partial', currency: 'USD', balanceDue: 'USD 75.00',
  payload: { invoiceDetails: { currency: 'USD', exchangeRate: 80, paymentStatus: 'Partial', balanceDue: 75 }, totals: { grandTotal: 100 } }
}), 6000, 'stored foreign-currency balance is converted to INR when its INR balance is absent');

assert.equal(invReceivableINR({
  status: 'Partial', currency: 'INR',
  payload: { invoiceDetails: { currency: 'INR', paymentStatus: 'Partial', balanceDue: 425 }, totals: { grandTotal: 1000 } }
}), 425, 'nested balance due is used when a legacy outer row has no balance field');

assert.equal(invReceivableINR(makeInvoice({ status: 'Partial', balanceINR: 0, balanceDue: '₹ 0.00' })), 0,
  'an explicit zero balance remains settled');

console.log('Receivables calculation tests passed: unpaid, partial, paid, legacy INR/FX, and explicit zero balance.');
