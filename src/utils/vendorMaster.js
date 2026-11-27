import { createMaster, deleteMaster, getCachedMasters, listMasters, updateMaster } from '../services/masterApi.js';

export const VENDOR_CATEGORIES = [
  'Hardware',
  'Machining / Turning',
  'Grinding',
  'Sheet Metal / Fabrication',
  'Cylinders / Pneumatics',
  'Fasteners / Screws',
  'Raw Material / Steel',
  'Tools / Tooling',
  'Plastics',
  'Electrical / Electronics',
  'Lubricants / Coolants',
  'Calibration / Instruments',
  'Compressor',
  'Balls / Ceramic',
  'Glass Bead',
  'AMC / Services',
  'Other'
];

const normalizeKey = (value) => String(value || '').trim().toLowerCase();

export const loadVendorMaster = () => listMasters('vendors');
export const getVendorMaster = () => getCachedMasters('vendors');

export const searchVendorMaster = (query, productFilter = '') => {
  const q = normalizeKey(query);
  return getVendorMaster().filter((vendor) =>
    (!productFilter || normalizeKey(vendor.product) === normalizeKey(productFilter)) &&
    (!q || normalizeKey(vendor.name).includes(q) || normalizeKey(vendor.product).includes(q))
  );
};

export const getVendorByName = (name) => {
  const key = normalizeKey(name);
  return key ? getVendorMaster().find((vendor) => normalizeKey(vendor.name) === key) || null : null;
};

export const getVendorBySeq = (seq) =>
  getVendorMaster().find((vendor) => String(vendor.seq) === String(seq) || String(vendor.id) === String(seq)) || null;

export const getProductCategories = () => {
  const categories = new Set(getVendorMaster().map((vendor) => vendor.product).filter(Boolean));
  return ['All Categories', ...categories];
};

export const addVendorToMaster = async (vendor) => {
  if (!vendor || !String(vendor.name || '').trim()) throw new Error('Vendor name is required.');
  const existing = getVendorByName(vendor.name);
  const data = {
    ...vendor,
    name: String(vendor.name).trim(),
    product: vendor.product || 'Other'
  };
  if (!existing) return (await createMaster('vendors', data)).record;
  return (await updateMaster('vendors', existing.id, { ...existing, ...data }, existing.version)).record;
};

export const updateVendorInMaster = async (seq, patch) => {
  const vendor = getVendorBySeq(seq);
  if (!vendor) throw new Error('Supplier record not found.');
  return (await updateMaster('vendors', vendor.id, { ...vendor, ...patch }, vendor.version)).record;
};

export const deleteVendorFromMaster = async (seq, reason = 'Deleted by administrator') => {
  const vendor = getVendorBySeq(seq);
  if (!vendor) throw new Error('Supplier record not found.');
  await deleteMaster('vendors', vendor.id, vendor.version, reason);
  return getVendorMaster();
};
