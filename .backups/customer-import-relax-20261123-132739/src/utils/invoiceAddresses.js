const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh'
};

const addressLocation = (source) => {
  const address = String(source.address || '');
  const pinCode = source.pinCode || source.pincode || source.postalCode ||
    address.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] || '';
  const gstState = GST_STATES[String(source.gstin || source.gstNumber || '').slice(0, 2)];
  const sourceState = String(source.state || '').trim();
  const state = gstState && /\(\d{2}\)\s*$/.test(sourceState) ? gstState : sourceState || gstState || '';
  const segments = address.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
  const pinSegmentIndex = pinCode ? segments.findIndex((part) => part.includes(pinCode)) : -1;
  const cleanCity = (value) => value
    .replace(new RegExp(String(pinCode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
    .replace(/\bDIST(?:RICT)?\.?\s*/gi, '')
    .replace(/[-–]/g, ' ')
    .trim();

  let city = source.city || '';
  if (!city && pinSegmentIndex >= 0) {
    city = cleanCity(segments[pinSegmentIndex]);
    if (city.toLowerCase() === state.toLowerCase()) city = '';
    for (let index = pinSegmentIndex - 1; !city && index >= 0; index -= 1) {
      const candidate = cleanCity(segments[index]);
      if (candidate && candidate.toLowerCase() !== state.toLowerCase()) city = candidate;
    }
  }

  return { city, state, pinCode };
};

export const makeInvoiceAddress = (source = {}) => ({
  name: source.name || source.consigneeName || source.companyName || source.customerName || '',
  address: source.address || '',
  ...addressLocation(source),
  gstNumber: source.gstNumber || source.gstin || '',
  contactNumber: source.contactNumber || source.phone || ''
});

export const getInvoiceBillTo = (invoice = {}) =>
  makeInvoiceAddress(invoice.billTo || invoice.billingAddress || invoice.customerDetails);

export const getInvoiceShipTo = (invoice = {}) =>
  makeInvoiceAddress(invoice.shipTo || invoice.shippingAddress || getInvoiceBillTo(invoice));
