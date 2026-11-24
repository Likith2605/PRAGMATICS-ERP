// Shared view model for exposing the existing Admin Inventory section inside the Store login.
// The Store sidebar sub-items, routes, and the reused Admin Inventory page all read from here,
// so navigation labels and page behavior stay in sync without duplicating inventory logic.

export const INVENTORY_VIEWS = ['dashboard', 'add', 'items', 'stock', 'adjust', 'history', 'low'];

const INVENTORY_VIEW_ALIASES = {
  dashboard: 'dashboard',
  overview: 'dashboard',
  'inventory-dashboard': 'dashboard',
  add: 'add',
  'add-item': 'add',
  'new-item': 'add',
  items: 'items',
  list: 'items',
  'item-list': 'items',
  'material-list': 'items',
  materials: 'items',
  stock: 'stock',
  'current-stock': 'stock',
  'stock-levels': 'stock',
  adjust: 'adjust',
  adjustment: 'adjust',
  'adjust-stock': 'adjust',
  'quick-adjust': 'adjust',
  history: 'history',
  'stock-history': 'history',
  transactions: 'history',
  'transaction-history': 'history',
  low: 'low',
  'low-stock': 'low',
  'required-materials': 'low',
  reorder: 'low'
};

export const normalizeInventoryView = (view) => {
  if (!view) return 'dashboard';
  const key = String(view).trim();
  const leaf = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  return INVENTORY_VIEW_ALIASES[leaf.toLowerCase()] || 'dashboard';
};

export const INVENTORY_VIEW_LABELS = {
  dashboard: 'Inventory Dashboard',
  add: 'Add Item',
  items: 'Item/Material List',
  stock: 'Current Stock',
  adjust: 'Quick Stock Adjustment',
  history: 'Stock History',
  low: 'Low Stock / Required Materials'
};

export const INVENTORY_VIEW_META = {
  dashboard: {
    tab: 'inventory',
    status: 'ALL',
    eyebrow: 'Store · Inventory',
    title: 'Inventory Management',
    desc: 'Track stock levels, monitor raw material reserves, and manage reorder levels — the same inventory master used by Admin.'
  },
  add: {
    tab: 'inventory',
    status: 'ALL',
    eyebrow: 'Store · Inventory',
    title: 'Add Item',
    desc: 'Add a new raw material / part to the shared item master used across the ERP and by Admin.'
  },
  items: {
    tab: 'inventory',
    status: 'ALL',
    eyebrow: 'Store · Inventory',
    title: 'Item / Material List',
    desc: 'The full item & material catalog from the shared inventory master.'
  },
  stock: {
    tab: 'inventory',
    status: 'ALL',
    eyebrow: 'Store · Inventory',
    title: 'Current Stock',
    desc: 'Live stock levels with reserved and available quantities for every material.'
  },
  adjust: {
    tab: 'inventory',
    status: 'ALL',
    eyebrow: 'Store · Inventory',
    title: 'Quick Stock Adjustment',
    desc: 'Record stock IN / OUT movements with a reason and reference; every movement is logged.'
  },
  history: {
    tab: 'transactions',
    status: 'ALL',
    eyebrow: 'Store · Inventory',
    title: 'Stock History',
    desc: 'Complete stock movement & adjustment log from the shared transaction records.'
  },
  low: {
    tab: 'inventory',
    status: 'LOW_STOCK',
    eyebrow: 'Store · Inventory',
    title: 'Low Stock / Required Materials',
    desc: 'Materials at or below their minimum reorder level, ready for purchase requests.'
  }
};

export const getInventoryViewMeta = (view) =>
  INVENTORY_VIEW_META[normalizeInventoryView(view)] || INVENTORY_VIEW_META.dashboard;

// Add-item and quick-adjustment are inventory.adjust operations. Users without that
// permission (e.g. Store Employee) fall back to the read-only item list view.
export const resolveInventoryViewForUser = (view, canAdjust) => {
  const normalized = normalizeInventoryView(view);
  if ((normalized === 'add' || normalized === 'adjust') && !canAdjust) return 'items';
  return normalized;
};