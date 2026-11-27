import assert from 'node:assert/strict';

const storage = new Map([
  ['erp_auth', JSON.stringify({ token: 'test-token', isLoggedIn: true })],
  ['companySettings', JSON.stringify({ companyName: 'Legacy Local Company' })],
  ['customerDirectory', JSON.stringify([{ companyName: 'Legacy Local Customer' }])],
  ['vendorMaster', JSON.stringify([{ name: 'Legacy Local Vendor' }])],
  ['machines', JSON.stringify([{ machineId: 'OLD-1', name: 'Legacy Local Machine' }])]
]);

globalThis.localStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};
globalThis.window = {
  location: { port: '5173', hostname: 'localhost' },
  dispatchEvent: () => true
};

const apiRecords = {
  vendors: [{ id: 'vendor-pg-1', seq: 1, name: 'PostgreSQL Vendor', version: 2 }],
  machines: [{ id: 'machine-pg-1', machineId: 'MC901', name: 'PostgreSQL Machine', version: 4 }],
  customers: [{ id: 'customer-pg-1', companyName: 'PostgreSQL Customer', version: 1 }]
};
let companyApiFails = false;

globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.endsWith('/masters/company-settings')) {
    if (companyApiFails) return { ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) };
    return { ok: true, json: async () => ({ record: { companyName: 'PostgreSQL Company', version: 3 } }) };
  }
  const kind = Object.keys(apiRecords).find((key) => path.endsWith(`/masters/${key}`));
  if (kind) return { ok: true, json: async () => ({ records: apiRecords[kind] }) };
  throw new Error(`Unexpected API request: ${path}`);
};

const { clearMasterCaches, getCompanySettings, listMasters } = await import('../src/services/masterApi.js');
const { getCompanyProfile } = await import('../src/utils/companyBranding.js');
const { loadCustomerDirectory } = await import('../src/utils/customerDirectory.js');
const { getVendorByName, getVendorMaster, loadVendorMaster } = await import('../src/utils/vendorMaster.js');
const { getMachines } = await import('../src/utils/storeService.js');

assert.deepEqual(getVendorMaster(), [], 'Vendor helper does not fall back to localStorage');
assert.deepEqual(getMachines(), [], 'Machine helper does not fall back to localStorage or seeded defaults');
assert.equal(getCompanyProfile().companyName, '', 'Company profile ignores stale browser settings before API hydration');

await getCompanySettings();
await loadCustomerDirectory();
await loadVendorMaster();
await listMasters('machines');

assert.equal(getCompanyProfile().companyName, 'PostgreSQL Company', 'Company branding reflects the authenticated API response');
assert.equal(getVendorByName('PostgreSQL Vendor')?.id, 'vendor-pg-1', 'Vendor helper reads the server-confirmed in-memory master');
assert.equal(getMachines()[0]?.machineId, 'MC901', 'Machine helper reads the server-confirmed in-memory master');
assert.deepEqual(JSON.parse(storage.get('companySettings')), { companyName: 'Legacy Local Company' }, 'Company legacy data remains preserved');
assert.deepEqual(JSON.parse(storage.get('customerDirectory')), [{ companyName: 'Legacy Local Customer' }], 'Customer legacy data remains preserved');
assert.deepEqual(JSON.parse(storage.get('vendorMaster')), [{ name: 'Legacy Local Vendor' }], 'Vendor legacy data remains preserved');
assert.deepEqual(JSON.parse(storage.get('machines')), [{ machineId: 'OLD-1', name: 'Legacy Local Machine' }], 'Machine legacy data remains preserved');

clearMasterCaches();
assert.equal(getCompanyProfile().companyName, '', 'Clearing the authenticated cache cannot expose stale local company settings');
companyApiFails = true;
await assert.rejects(getCompanySettings, /Unavailable/, 'Company settings API failures are surfaced');
assert.equal(getCompanyProfile().companyName, '', 'Company settings API failures do not fall back to stale localStorage');
console.log('PASS shared master client uses PostgreSQL caches without local fallback or legacy overwrite');
