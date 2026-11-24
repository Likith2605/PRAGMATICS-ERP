import { isAdmin } from './auth.js';

/* Vendor Master — centralized vendor registry for the Purchase modules.
   Seeded from the company's vendor list (Sl.No / Product-Service / Name & Address).
   Centralized key: 'vendorMaster' — all Purchase modules read from here so a single
   source of truth keeps PO / Supplier Bill / Advances / Returns connected. */

const VENDOR_MASTER_STORAGE_KEY = 'vendorMaster';
const VENDOR_MASTER_SEQUENCE_KEY = 'vendorMasterSequence';

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

const SEED_VENDORS = [
  { seq: 1, product: 'GAUGE', name: 'BAKER GAUGES INDIA PVT LTD', address: '' },
  { seq: 2, product: 'CG', name: 'CLASSIC ENGINEERING INDUSTRIES', address: '' },
  { seq: 3, product: 'Fabriation & shelt metal', name: 'CUBAX DESIGNS', address: '' },
  { seq: 4, product: 'Electroless Nickel Plating', name: 'D.M.S ENTERPRISES', address: '' },
  { seq: 5, product: 'Fasteners', name: 'DIGITAL METROLOGY', address: '' },
  { seq: 6, product: 'Balls  Ceranic', name: 'DULAR STEEL PRODUCTS', address: '' },
  { seq: 7, product: 'Machining', name: 'EXCON ENGINEERING', address: '' },
  { seq: 8, product: 'pneumatic systems (Cylinders)', name: 'FESTO INDIA PRIVATE LIMITED', address: '' },
  { seq: 9, product: 'pneumatic systems (Cylinders)', name: 'FESTO INDIA PRIVATE LIMITED (TN)', address: '' },
  { seq: 10, product: 'Plastics', name: 'HERAMB THERMOPLASTICS PVT LTD', address: '' },
  { seq: 11, product: 'MS/Spoing Steel', name: 'IMMACULATE STEELS PVT LTD', address: '' },
  { seq: 12, product: 'Hardware', name: 'INDUSTRIAL STORES SUPPLIERS', address: '' },
  { seq: 13, product: 'Hardware', name: 'INDUSTRIAL TOOLS & ENGINEERING', address: '' },
  { seq: 14, product: 'Electrial', name: 'KAGA DEVICES INDIA PRIVATE LIMITED.', address: '' },
  { seq: 15, product: 'Compressor', name: 'M.R.COMPRESSORS', address: '' },
  { seq: 16, product: 'Cylinders LM guide & rails - LM Bush', name: 'MISUMI INDIA PVT LTD (BENGALURU)', address: '' },
  { seq: 17, product: 'Screws - Festening', name: 'MVD FASTENERS PRIVATE LIMITED', address: '' },
  { seq: 18, product: 'Tooling Milling', name: 'PAWAN SAI ENGINEERING', address: '' },
  { seq: 19, product: 'Truning Machine Spacer', name: 'PRESTIGE MACHINERY & SPARES', address: '' },
  { seq: 20, product: 'Coolant Oil/luber', name: 'QUALITY LUBES & COOLANTS', address: '' },
  { seq: 21, product: 'Insturement Calibration', name: 'QUALITY SERVICES AND AGENCIES', address: '' },
  { seq: 22, product: 'MachineSpores', name: 'S AND T MACHINE TOOLS PVT LIMITED', address: '' },
  { seq: 23, product: 'Surface griding', name: 'S R ENGINEERING', address: '' },
  { seq: 24, product: 'CG', name: 'S V ENTERPRISES', address: '' },
  { seq: 25, product: 'Grinding', name: 'S.P. ENGINEERING', address: '' },
  { seq: 26, product: 'Glass bead', name: 'SASTHA INDUSTRIES', address: '' },
  { seq: 27, product: 'Wire cut', name: 'SHREE GAUTHAM INDUSTRIES', address: '' },
  { seq: 28, product: 'Sheet metal Fabriation', name: 'SLV ENGINEERING', address: '' },
  { seq: 29, product: 'Neumatic Cylinder', name: 'SMC CORPORATION (INDIA) PVT LTD ( BANGALORE)', address: '' },
  { seq: 30, product: 'Neumatic Cylinder', name: 'SMC CORPORATION (INDIA) PVT LTD ( CHENNAI )', address: '' },
  { seq: 31, product: 'Screws & std parts', name: 'SOUTH INDIA HARDWARE', address: '' },
  { seq: 33, product: 'Hardware', name: 'SPURS AND THREADS SOLUTIONS PVT LTD', address: '' },
  { seq: 34, product: 'Vendor - Turininh & CG', name: 'SRI KRISHNA INDUSTRIES', address: '' },
  { seq: 35, product: 'IMP - Turning', name: 'SRI RAGHAVENDRA INDUSTRIES', address: '' },
  { seq: 36, product: 'Puncher', name: 'SRS TOOLS', address: '' },
  { seq: 37, product: 'Glass bead', name: 'SUJAN ENTERPRISES', address: '' },
  { seq: 38, product: 'Vmc', name: 'SVS ENGINEERING', address: '' },
  { seq: 39, product: 'Endmill Resharpening', name: 'TARGET TOOLS', address: '' },
  { seq: 40, product: 'MS(RM)', name: 'ASHRAF & COMPANY', address: '' },
  { seq: 41, product: 'End mills', name: 'SST CUTTING TOOLS', address: '' },
  { seq: 42, product: 'LM guide & rails', name: 'VAIBHAV ENTERPRISES', address: '' },
  { seq: 43, product: 'VMN & Height Gauge', name: 'ELECTRONICA MECHATRONICSYSTEMS (INDIA)PRIVATE LIMITED', address: '' },
  { seq: 44, product: 'AMC ( CNC Machines)', name: 'Upanal CNC Solutions', address: '# 161, 10th Main, 3rd Phase, Peenya Industrial Area, Bengaluru - 560058' },
  { seq: 45, product: 'AMC ( Generator)', name: 'Damodar Diesel TECH', address: 'No 23, Sri Kaustubha, 7th Cross, Obalappa layout, Nagarbhavi, II Stage, Bengaluru - 560072' }
];

const normalizeKey = (v) => String(v || '').trim().toLowerCase();

const normalizeRecord = (v) => ({ contactPerson: '', phone: '', email: '', ...v });

const readVendorMaster = () => {
  try {
    const stored = localStorage.getItem(VENDOR_MASTER_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(normalizeRecord);
    }
  } catch {
    /* ignore corrupt master, fall back to seed */
  }
  // Seed once if nothing stored yet
  const seeded = SEED_VENDORS.map((v) => normalizeRecord(v));
  try {
    localStorage.setItem(VENDOR_MASTER_STORAGE_KEY, JSON.stringify(seeded));
    localStorage.setItem(VENDOR_MASTER_SEQUENCE_KEY, JSON.stringify(seeded.length));
  } catch {
    /* ignore */
  }
  return seeded;
};

export const getVendorMaster = () => readVendorMaster();

export const searchVendorMaster = (query, productFilter = '') => {
  const q = normalizeKey(query);
  const list = readVendorMaster();
  return list.filter(
    (v) =>
      (!productFilter || normalizeKey(v.product) === normalizeKey(productFilter)) &&
      (!q || normalizeKey(v.name).includes(q) || normalizeKey(v.product).includes(q))
  );
};

export const getVendorByName = (name) => {
  const key = normalizeKey(name);
  if (!key) return null;
  return readVendorMaster().find((v) => normalizeKey(v.name) === key) || null;
};

export const getVendorBySeq = (seq) => readVendorMaster().find((v) => Number(v.seq) === Number(seq)) || null;

export const getProductCategories = () => {
  const set = new Set();
  readVendorMaster().forEach((v) => {
    if (v.product) set.add(v.product);
  });
  return ['All Categories', ...Array.from(set)];
};

export const addVendorToMaster = (vendor) => {
  if (!vendor || !vendor.name) throw new Error('Vendor name is required.');
  const list = readVendorMaster();
  const existing = getVendorByName(vendor.name);
  if (existing) {
    // Update / merge in place (keeps connectivity)
    const next = list.map((v) =>
      v.seq === existing.seq
        ? {
            ...v,
            product: vendor.product || v.product,
            name: vendor.name,
            address: vendor.address || v.address,
            contactPerson: vendor.contactPerson || v.contactPerson || '',
            phone: vendor.phone || v.phone || '',
            email: vendor.email || v.email || ''
          }
        : v
    );
    localStorage.setItem(VENDOR_MASTER_STORAGE_KEY, JSON.stringify(next));
    localStorage.setItem(VENDOR_MASTER_SEQUENCE_KEY, JSON.stringify(next.length));
    return getVendorBySeq(existing.seq);
  }
  const maxSeq = list.reduce((a, v) => Math.max(a, Number(v.seq) || 0), 0);
  const rec = {
    seq: maxSeq + 1,
    product: vendor.product || 'Other',
    name: vendor.name.trim(),
    address: vendor.address || '',
    contactPerson: vendor.contactPerson || '',
    phone: vendor.phone || '',
    email: vendor.email || ''
  };
  const next = [rec, ...list];
  localStorage.setItem(VENDOR_MASTER_STORAGE_KEY, JSON.stringify(next));
  localStorage.setItem(VENDOR_MASTER_SEQUENCE_KEY, JSON.stringify(next.length));
  return rec;
};

export const updateVendorInMaster = (seq, patch) => {
  const list = readVendorMaster();
  const next = list.map((v) => (Number(v.seq) === Number(seq) ? { ...v, ...patch, seq: Number(v.seq) } : v));
  localStorage.setItem(VENDOR_MASTER_STORAGE_KEY, JSON.stringify(next));
  return getVendorBySeq(seq);
};

export const deleteVendorFromMaster = (seq) => {
  if (!isAdmin()) throw new Error('Permission denied: only an Admin can delete a supplier master record.');
  const list = readVendorMaster();
  const vendor = list.find((v) => Number(v.seq) === Number(seq));
  if (!vendor) throw new Error('Supplier record not found.');
  const relatedKeys = ['supplierPOHistory','supplierInvoiceHistory','supplierAdvanceHistory','supplierReturnHistory','vendorEnquiries','vendorQuotations'];
  const normalize = (value) => String(value || '').trim().toLowerCase();
  for (const key of relatedKeys) {
    let records;
    try { records = JSON.parse(localStorage.getItem(key) || '[]'); } catch { throw new Error('Supplier history could not be checked. Deletion was canceled.'); }
    if (Array.isArray(records) && JSON.stringify(records).toLowerCase().includes(normalize(vendor.name))) throw new Error('This supplier is referenced by business history and cannot be deleted.');
  }
  const next = list.filter((v) => Number(v.seq) !== Number(seq));
  localStorage.setItem(VENDOR_MASTER_STORAGE_KEY, JSON.stringify(next));
  localStorage.setItem(VENDOR_MASTER_SEQUENCE_KEY, JSON.stringify(next.length));
  return next;
};
