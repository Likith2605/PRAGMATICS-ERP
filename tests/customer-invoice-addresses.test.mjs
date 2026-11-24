import assert from 'node:assert/strict';
import {
  getInvoiceBillTo,
  getInvoiceShipTo,
  makeInvoiceAddress
} from '../src/utils/invoiceAddresses.js';

const masterCustomer = {
  customerName: 'Contact Person',
  companyName: 'Example Company',
  address: '12 Industrial Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pinCode: '560001',
  gstin: '29ABCDE1234F1Z5',
  phone: '08012345678'
};

assert.deepEqual(makeInvoiceAddress(masterCustomer), {
  name: 'Example Company',
  address: '12 Industrial Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pinCode: '560001',
  gstNumber: '29ABCDE1234F1Z5',
  contactNumber: '08012345678'
});

assert.deepEqual(
  (({ city, state, pinCode }) => ({ city, state, pinCode }))(
    makeInvoiceAddress({
      companyName: 'Customer Master Example',
      address: 'IMT MANESAR, GURGAON\nHARYANA- 122050',
      gstin: '06AAACD6817F1ZW',
      state: 'Karnataka (29)'
    })
  ),
  { city: 'GURGAON', state: 'Haryana', pinCode: '122050' }
);

const legacyInvoice = {
  customerDetails: {
    customerName: 'Legacy Company',
    address: 'Legacy billing address',
    state: 'Maharashtra',
    gstNumber: '27ABCDE1234F1Z5',
    contactNumber: '9876543210'
  }
};
assert.equal(getInvoiceBillTo(legacyInvoice).address, 'Legacy billing address');
assert.deepEqual(getInvoiceShipTo(legacyInvoice), getInvoiceBillTo(legacyInvoice));

const invoiceWithSeparateAddresses = {
  ...legacyInvoice,
  billTo: { name: 'Billing Company', address: 'Billing address' },
  shipTo: { name: 'Consignee', address: 'Separate delivery address' }
};
assert.equal(getInvoiceBillTo(invoiceWithSeparateAddresses).name, 'Billing Company');
assert.equal(getInvoiceShipTo(invoiceWithSeparateAddresses).address, 'Separate delivery address');

console.log('Customer invoice address tests passed.');
