import assert from 'node:assert/strict';
import { matchesCustomerSearch } from '../src/utils/customerSearch.js';

const customer = { name: 'SKF INDIA LIMITED, HARIDWAR', contactPerson: 'Accounts Team', phone: '+91 222 813 567' };

assert.equal(matchesCustomerSearch(customer, 'skf india'), true, 'name search is case-insensitive and supports partial names');
assert.equal(matchesCustomerSearch(customer, '281'), true, 'phone search supports partial digits, ignoring formatting');
assert.equal(matchesCustomerSearch(customer, 'xyz'), false, 'nonmatching text does not match');

console.log('Customer search checks passed.');
