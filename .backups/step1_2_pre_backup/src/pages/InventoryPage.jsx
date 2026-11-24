import React, { useState, useEffect, useMemo } from 'react';
import logoUrl from '../assets/logo.png';
import { hasPermission } from '../utils/permissions.js';
import { getInventoryViewMeta, normalizeInventoryView } from '../utils/inventoryViews.js';

const DEFAULT_CATEGORIES = [
  'Raw Material',
  'Standard Part',
  'Machined Component',
  'Fastener',
  'Consumable'
];

const DEFAULT_UNITS = [
  'Nos', 'Set', 'Pair', 'Kit', 'Assembly', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Bundle'
];

const SEED_INVENTORY_ITEMS = [
  { id: 'INV-001', itemCode: 'PRAG-101', itemName: 'MS Plate 10mm', category: 'Raw Material', hsnSac: '7208', unit: 'Kg', currentQty: 500, reservedQty: 0, minReorderLevel: 100, unitCost: 85, sellingPrice: 95, location: 'Bay A-1' },
  { id: 'INV-002', itemCode: 'PRAG-102', itemName: 'SS Pipe 2inch Sch40', category: 'Raw Material', hsnSac: '7304', unit: 'Nos', currentQty: 120, reservedQty: 0, minReorderLevel: 30, unitCost: 2200, sellingPrice: 2500, location: 'Bay A-2' },
  { id: 'INV-003', itemCode: 'PRAG-103', itemName: 'Hex Bolt M12x50 Grade 8.8', category: 'Fastener', hsnSac: '7318', unit: 'Nos', currentQty: 2000, reservedQty: 0, minReorderLevel: 500, unitCost: 12, sellingPrice: 15, location: 'Bay B-1' },
  { id: 'INV-004', itemCode: 'PRAG-104', itemName: 'Mild Steel Round Bar 32mm', category: 'Raw Material', hsnSac: '7215', unit: 'Kg', currentQty: 350, reservedQty: 0, minReorderLevel: 80, unitCost: 72, sellingPrice: 82, location: 'Bay A-3' },
  { id: 'INV-005', itemCode: 'PRAG-105', itemName: 'Welding Electrode E7018 4mm', category: 'Consumable', hsnSac: '8311', unit: 'Kg', currentQty: 80, reservedQty: 0, minReorderLevel: 25, unitCost: 150, sellingPrice: 180, location: 'Bay C-1' },
  { id: 'INV-006', itemCode: 'PRAG-106', itemName: 'Aluminium Round Bar 50mm', category: 'Raw Material', hsnSac: '7604', unit: 'Kg', currentQty: 180, reservedQty: 10, minReorderLevel: 50, unitCost: 210, sellingPrice: 245, location: 'Bay A-4' },
  { id: 'INV-007', itemCode: 'PRAG-107', itemName: 'Brass C360 Rod 25mm', category: 'Raw Material', hsnSac: '7407', unit: 'Kg', currentQty: 45, reservedQty: 0, minReorderLevel: 60, unitCost: 480, sellingPrice: 540, location: 'Bay A-5' },
  { id: 'INV-008', itemCode: 'PRAG-108', itemName: 'Deep Groove Ball Bearing 6204 ZZ', category: 'Standard Part', hsnSac: '8482', unit: 'Nos', currentQty: 75, reservedQty: 5, minReorderLevel: 20, unitCost: 145, sellingPrice: 185, location: 'Bay B-2' },
  { id: 'INV-009', itemCode: 'PRAG-109', itemName: 'Pneumatic Cylinder DC63x100', category: 'Standard Part', hsnSac: '8412', unit: 'Nos', currentQty: 8, reservedQty: 0, minReorderLevel: 5, unitCost: 3200, sellingPrice: 3800, location: 'Bay B-3' },
  { id: 'INV-010', itemCode: 'PRAG-110', itemName: 'Proximity Sensor M18 PNP', category: 'Standard Part', hsnSac: '8536', unit: 'Nos', currentQty: 0, reservedQty: 0, minReorderLevel: 10, unitCost: 850, sellingPrice: 1050, location: 'Bay B-4' },
  { id: 'INV-011', itemCode: 'PRAG-111', itemName: 'CNC Machined Housing A-101', category: 'Machined Component', hsnSac: '8466', unit: 'Nos', currentQty: 35, reservedQty: 4, minReorderLevel: 15, unitCost: 1250, sellingPrice: 1650, location: 'Bay D-1' },
  { id: 'INV-012', itemCode: 'PRAG-112', itemName: 'Shaft Collar 1/2in SS', category: 'Standard Part', hsnSac: '8483', unit: 'Nos', currentQty: 14, reservedQty: 0, minReorderLevel: 25, unitCost: 95, sellingPrice: 130, location: 'Bay B-5' },
  { id: 'INV-013', itemCode: 'PRAG-113', itemName: 'Carbide Insert CNMG 120408', category: 'Consumable', hsnSac: '8207', unit: 'Nos', currentQty: 60, reservedQty: 6, minReorderLevel: 40, unitCost: 310, sellingPrice: 390, location: 'Bay C-2' },
  { id: 'INV-014', itemCode: 'PRAG-114', itemName: 'MS Angle 40x40x5', category: 'Raw Material', hsnSac: '7216', unit: 'Kg', currentQty: 90, reservedQty: 0, minReorderLevel: 120, unitCost: 68, sellingPrice: 78, location: 'Bay A-6' },
  { id: 'INV-015', itemCode: 'PRAG-115', itemName: 'Gear Motor 0.5kW 30:1', category: 'Standard Part', hsnSac: '8425', unit: 'Nos', currentQty: 3, reservedQty: 1, minReorderLevel: 2, unitCost: 7800, sellingPrice: 9200, location: 'Bay B-6' },
  { id: 'INV-016', itemCode: 'PRAG-116', itemName: 'Machined Flange P-220', category: 'Machined Component', hsnSac: '8466', unit: 'Nos', currentQty: 0, reservedQty: 0, minReorderLevel: 10, unitCost: 640, sellingPrice: 850, location: 'Bay D-2' }
];

const InventoryPage = ({ view: viewProp }) => {
  const canAdjust = hasPermission('inventory.adjust');
  // Store login deep-links pass a `view`; the Admin /inventory route passes none and keeps its original behavior.
  const isStoreScoped = typeof viewProp === 'string' && viewProp.trim() !== '';
  const view = normalizeInventoryView(viewProp);
  const viewMeta = getInventoryViewMeta(view);
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [activeTab, setActiveTab] = useState(viewMeta.tab); // 'inventory' | 'transactions'

  // Categories
  const [customCategories, setCustomCategories] = useState(() => {
    try {
      const stored = localStorage.getItem('customInventoryCategories');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [showAddCategoryModal, setShowAddCategoryModal] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const allCategories = useMemo(() => {
    return [...DEFAULT_CATEGORIES, ...customCategories];
  }, [customCategories]);

  // Filter & Search
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState(viewMeta.status); // 'ALL' | 'LOW_STOCK' | 'OUT_OF_STOCK'

  // Modals
  const [showItemModal, setShowItemModal] = useState(false);
  const [isEditingItem, setIsEditingItem] = useState(false);
  const [itemFormData, setItemFormData] = useState({
    id: '',
    itemCode: '',
    itemName: '',
    category: 'Standard Part',
    hsnSac: '',
    unit: 'Nos',
    currentQty: '',
    reservedQty: 0,
    minReorderLevel: '',
    unitCost: '',
    sellingPrice: '',
    location: '',
    shelfLifeManaged: false,
    shelfLifeMonths: ''
  });

  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustFormData, setAdjustFormData] = useState({
    itemId: '',
    adjustType: 'IN', // 'IN' | 'OUT'
    quantity: '',
    reason: 'Stock Inward (Purchase)',
    reference: '',
    date: new Date().toISOString().slice(0, 10)
  });

  // Load from localStorage
  useEffect(() => {
    try {
      const storedItems = localStorage.getItem('inventoryItems');
      let parsed = storedItems ? JSON.parse(storedItems) : [];
      if (!Array.isArray(parsed)) parsed = [];
      if (parsed.length === 0) {
        parsed = SEED_INVENTORY_ITEMS.map((s) => ({ ...s }));
      } else if (Number(localStorage.getItem('inventorySeedVersion') || 1) < 2) {
        // Older/empty seed: append any missing dummy items once (keeps user's own edits)
        const have = new Set(parsed.map((i) => i.id));
        parsed = [...parsed, ...SEED_INVENTORY_ITEMS.filter((s) => !have.has(s.id)).map((s) => ({ ...s }))];
      }
      localStorage.setItem('inventoryItems', JSON.stringify(parsed));
      localStorage.setItem('inventorySeedVersion', '2');
      setItems(parsed);
    } catch {
      setItems([]);
    }

    try {
      const storedTx = localStorage.getItem('stockTransactions');
      setTransactions(storedTx ? JSON.parse(storedTx) : []);
    } catch {
      setTransactions([]);
    }
  }, []);

  const saveItemsToStorage = (updated) => {
    setItems(updated);
    localStorage.setItem('inventoryItems', JSON.stringify(updated));
  };

  const saveTransactionsToStorage = (updatedTx) => {
    setTransactions(updatedTx);
    localStorage.setItem('stockTransactions', JSON.stringify(updatedTx));
  };

  // Another user's newer save won a per-record conflict: the sync engine has
  // already replaced the localStorage copy with the server version — refresh
  // this page's state so the operator sees the latest data immediately.
  useEffect(() => {
    const refreshFromStorage = () => {
      try {
        const storedItems = localStorage.getItem('inventoryItems');
        if (storedItems) setItems(JSON.parse(storedItems));
        const storedTx = localStorage.getItem('stockTransactions');
        if (storedTx) setTransactions(JSON.parse(storedTx));
      } catch {
        /* keep current state */
      }
    };
    window.addEventListener('erp-records-conflict', refreshFromStorage);
    window.addEventListener('erp-records-synced', refreshFromStorage);
    return () => {
      window.removeEventListener('erp-records-conflict', refreshFromStorage);
      window.removeEventListener('erp-records-synced', refreshFromStorage);
    };
  }, []);

  // Store login: keep the active tab/status filter in sync with the requested view,
  // and auto-open the Add / Quick Adjustment modals when deep-linked.
  useEffect(() => {
    if (!isStoreScoped) return;
    setActiveTab(viewMeta.tab);
    setStatusFilter(viewMeta.status);

    if (canAdjust && view === 'add') {
      setItemFormData({
        id: `item-${Date.now()}`,
        itemCode: `PRAG-${Math.floor(100 + Math.random() * 900)}`,
        itemName: '',
        category: 'Standard Part',
        hsnSac: '',
        unit: 'Nos',
        currentQty: '0',
        reservedQty: 0,
        minReorderLevel: '10',
        unitCost: '',
        sellingPrice: '',
        location: ''
      });
      setShowItemModal(true);
    } else if (canAdjust && view === 'adjust') {
      setAdjustFormData({
        itemId: items[0]?.id || '',
        adjustType: 'IN',
        quantity: '',
        reason: 'Stock Inward (Purchase)',
        reference: '',
        date: new Date().toISOString().slice(0, 10)
      });
      setShowAdjustModal(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Keep the auto-opened Adjust modal pointed at a valid item once the list loads.
  useEffect(() => {
    if (showAdjustModal && !adjustFormData.itemId && items.length > 0) {
      setAdjustFormData((prev) => ({ ...prev, itemId: items[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAdjustModal, adjustFormData.itemId, items]);

  // KPIs
  const kpis = useMemo(() => {
    const totalItems = items.length;
    let totalValue = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    let totalReserved = 0;

    items.forEach((item) => {
      const qty = Number(item.currentQty) || 0;
      const cost = Number(item.unitCost) || 0;
      const reserved = Number(item.reservedQty) || 0;
      const minLevel = Number(item.minReorderLevel) || 0;

      totalValue += qty * cost;
      totalReserved += reserved;

      if (qty <= 0) {
        outOfStockCount++;
      } else if (qty <= minLevel) {
        lowStockCount++;
      }
    });

    return {
      totalItems,
      totalValue,
      lowStockCount,
      outOfStockCount,
      totalReserved
    };
  }, [items]);

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesSearch =
        item.itemName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.itemCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.hsnSac && item.hsnSac.includes(searchTerm));

      const matchesCat = selectedCategory === 'ALL' || item.category === selectedCategory;

      const qty = Number(item.currentQty) || 0;
      const minLevel = Number(item.minReorderLevel) || 0;

      let matchesStatus = true;
      if (statusFilter === 'LOW_STOCK') {
        matchesStatus = qty > 0 && qty <= minLevel;
      } else if (statusFilter === 'OUT_OF_STOCK') {
        matchesStatus = qty <= 0;
      }

      return matchesSearch && matchesCat && matchesStatus;
    });
  }, [items, searchTerm, selectedCategory, statusFilter]);

  // Open Create Item Modal
  const handleOpenCreateItem = () => {
    setIsEditingItem(false);
    setItemFormData({
      id: `item-${Date.now()}`,
      itemCode: `PRAG-${Math.floor(100 + Math.random() * 900)}`,
      itemName: '',
      category: 'Standard Part',
      hsnSac: '',
      unit: 'Nos',
      currentQty: '0',
      reservedQty: 0,
      minReorderLevel: '10',
      unitCost: '',
      sellingPrice: '',
      location: '',
      shelfLifeManaged: false,
      shelfLifeMonths: ''
    });
    setShowItemModal(true);
  };

  // Open Edit Item Modal
  const handleOpenEditItem = (item) => {
    setIsEditingItem(true);
    setItemFormData({ shelfLifeManaged: false, shelfLifeMonths: '', ...item });
    setShowItemModal(true);
  };

  // Save Item
  const handleSaveItem = (e) => {
    e.preventDefault();
    if (!itemFormData.itemName.trim()) {
      alert('Please fill in Item Name.');
      return;
    }

    /* The Item Code input was removed from the form - generate one when
       it is missing so inventory keys, ledgers and matching keep working. */
    const payload = {
      ...itemFormData,
      itemCode:
        (itemFormData.itemCode || '').trim() ||
        `PRAG-${Math.floor(100 + Math.random() * 900)}`
    };

    let updated;
    if (isEditingItem) {
      updated = items.map((it) => (it.id === payload.id ? payload : it));
    } else {
      updated = [payload, ...items];
    }

    saveItemsToStorage(updated);
    setShowItemModal(false);
  };

  // Delete Item
  const handleDeleteItem = (id) => {
    if (window.confirm('Are you sure you want to delete this inventory item?')) {
      const updated = items.filter((it) => it.id !== id);
      saveItemsToStorage(updated);
    }
  };

  const handleSaveNewCategory = (e) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    if (!allCategories.includes(trimmed)) {
      const updated = [...customCategories, trimmed];
      setCustomCategories(updated);
      localStorage.setItem('customInventoryCategories', JSON.stringify(updated));
    }
    setSelectedCategory(trimmed);
    setItemFormData((prev) => ({ ...prev, category: trimmed }));
    setNewCategoryName('');
    setShowAddCategoryModal(false);
  };

  // Open Stock Adjustment Modal
  const handleOpenAdjust = (item = null) => {
    setAdjustFormData({
      itemId: item ? item.id : items[0]?.id || '',
      adjustType: 'IN',
      quantity: '',
      reason: 'Stock Inward (Purchase)',
      reference: '',
      date: new Date().toISOString().slice(0, 10)
    });
    setShowAdjustModal(true);
  };

  // Save Stock Adjustment
  const handleSaveAdjustment = (e) => {
    e.preventDefault();
    const qtyChange = Number(adjustFormData.quantity);
    if (!qtyChange || qtyChange <= 0) {
      alert('Please enter a valid quantity.');
      return;
    }

    const targetItem = items.find((it) => it.id === adjustFormData.itemId);
    if (!targetItem) return;

    const current = Number(targetItem.currentQty) || 0;
    let newQty = current;

    if (adjustFormData.adjustType === 'IN') {
      newQty = current + qtyChange;
    } else {
      if (qtyChange > current) {
        if (!window.confirm('Adjusted quantity is greater than current stock. Proceed anyway?')) {
          return;
        }
      }
      newQty = Math.max(0, current - qtyChange);
    }

    const updatedItems = items.map((it) =>
      it.id === targetItem.id ? { ...it, currentQty: newQty } : it
    );
    saveItemsToStorage(updatedItems);

    // Record Transaction
    const newTx = {
      id: `tx-${Date.now()}`,
      date: adjustFormData.date,
      itemCode: targetItem.itemCode,
      itemName: targetItem.itemName,
      unit: targetItem.unit,
      type: adjustFormData.adjustType,
      quantity: qtyChange,
      balanceAfter: newQty,
      reason: adjustFormData.reason,
      reference: adjustFormData.reference || '-'
    };

    const updatedTx = [newTx, ...transactions];
    saveTransactionsToStorage(updatedTx);

    setShowAdjustModal(false);
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">{isStoreScoped ? viewMeta.eyebrow : 'Warehouse & Materials'}</p>
          <h1>{isStoreScoped ? viewMeta.title : 'Inventory Management'}</h1>
          <p className="page-description">
            {isStoreScoped
              ? viewMeta.desc
              : 'Track stock levels, monitor raw material reserves for sales orders, and manage stock reorder levels.'}
          </p>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          {canAdjust && (
            <button className="button-secondary" onClick={() => handleOpenAdjust()}>
              ± Quick Stock Adjustment
            </button>
          )}
          {canAdjust && (
            <button className="button-primary" onClick={handleOpenCreateItem}>
              + Add New Item
            </button>
          )}
        </div>
      </div>

      {/* KPI Stats Overview */}
      <div className="kpi-grid" style={{ marginBottom: '24px' }}>
        <div className="kpi-card">
          <span className="kpi-title">Total Items in Catalog</span>
          <div className="kpi-value">{kpis.totalItems}</div>
          <span className="kpi-delta positive">Active parts & raw materials</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Total Inventory Value</span>
          <div className="kpi-value">₹ {kpis.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
          <span className="kpi-delta neutral">Based on purchase cost</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Low Stock Alert</span>
          <div className="kpi-value" style={{ color: kpis.lowStockCount > 0 ? '#b91c1c' : '#166534' }}>
            {kpis.lowStockCount} Items
          </div>
          <span className="kpi-delta negative">Below minimum threshold</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-title">Reserved for Sales Orders</span>
          <div className="kpi-value">{kpis.totalReserved} Units</div>
          <span className="kpi-delta positive">Committed to active orders</span>
        </div>
      </div>

      <div className="content-block">
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '10px', borderBottom: '1px solid #e5e7eb', paddingBottom: '14px', marginBottom: '20px' }}>
          <button
            className={activeTab === 'inventory' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('inventory')}
            style={{ padding: '8px 18px' }}
          >
            Item Master & Stock Levels
          </button>
          <button
            className={activeTab === 'transactions' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('transactions')}
            style={{ padding: '8px 18px' }}
          >
            Stock Movement History ({transactions.length})
          </button>
        </div>

        {activeTab === 'inventory' && (
          <>
            {/* Search & Filter Toolbar */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '18px', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', flex: 1 }}>
                <input
                  type="text"
                  placeholder="Search name, HSN..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  style={{ minWidth: '260px', padding: '9px 14px', borderRadius: '8px', border: '1px solid #d1d5db' }}
                />
                <select
                  value={selectedCategory}
                  onChange={(e) => {
                    if (e.target.value === 'ADD_NEW') {
                      setShowAddCategoryModal(true);
                    } else {
                      setSelectedCategory(e.target.value);
                    }
                  }}
                  style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid #d1d5db', background: '#fff' }}
                >
                  <option value="ALL">All Categories</option>
                  {allCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {canAdjust && <option value="ADD_NEW">+ Add New Category</option>}
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{ padding: '9px 12px', borderRadius: '8px', border: '1px solid #d1d5db', background: '#fff' }}
                >
                  <option value="ALL">All Stock Statuses</option>
                  <option value="LOW_STOCK">Low Stock Warning</option>
                  <option value="OUT_OF_STOCK">Out of Stock</option>
                </select>
              </div>

              <div style={{ fontSize: '13px', color: '#6b7280', fontWeight: '600' }}>
                Showing {filteredItems.length} of {items.length} items
              </div>
            </div>

            {/* Inventory Table */}
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Item Description</th>
                    <th>Category</th>
                    <th>Unit</th>
                    <th>In Stock</th>
                    <th>Reserved</th>
                    <th>Available</th>
                    <th>Unit Cost</th>
                    <th>Selling Price</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.length > 0 ? (
                    filteredItems.map((item, idx) => {
                      const cur = Number(item.currentQty) || 0;
                      const res = Number(item.reservedQty) || 0;
                      const avail = Math.max(0, cur - res);
                      const minLvl = Number(item.minReorderLevel) || 0;

                      let statusBadge = { label: 'In Stock', bg: '#dcfce7', color: '#166534' };
                      if (cur <= 0) {
                        statusBadge = { label: 'Out of Stock', bg: '#fee2e2', color: '#991b1b' };
                      } else if (cur <= minLvl) {
                        statusBadge = { label: `Low (${cur}/${minLvl})`, bg: '#fef3c7', color: '#92400e' };
                      }

                      return (
                        <tr key={item.id}>
                          <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                          <td>
                            <div style={{ fontWeight: '600', color: '#0f172a' }}>{item.itemName}</div>
                            {item.location && (
                              <div style={{ fontSize: '11px', color: '#64748b' }}>Loc: {item.location}</div>
                            )}
                          </td>
                          <td>
                            <span style={{ fontSize: '12px', color: '#475569' }}>{item.category}</span>
                          </td>
                          <td>{item.unit || 'Nos'}</td>
                          <td><strong>{cur}</strong></td>
                          <td style={{ color: res > 0 ? '#ea580c' : '#64748b', fontWeight: res > 0 ? '700' : 'normal' }}>
                            {res}
                          </td>
                          <td style={{ fontWeight: '700', color: avail > 0 ? '#166534' : '#dc2626' }}>
                            {avail}
                          </td>
                          <td>₹ {Number(item.unitCost || 0).toFixed(2)}</td>
                          <td>₹ {Number(item.sellingPrice || 0).toFixed(2)}</td>
                          <td>
                            <span
                              style={{
                                padding: '4px 10px',
                                borderRadius: '20px',
                                fontSize: '11.5px',
                                fontWeight: '700',
                                background: statusBadge.bg,
                                color: statusBadge.color
                              }}
                            >
                              {statusBadge.label}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              {canAdjust && (
                                <button
                                  className="button-small"
                                  onClick={() => handleOpenAdjust(item)}
                                  title="Adjust Stock In / Out"
                                >
                                  ± Stock
                                </button>
                              )}
                              {canAdjust && (
                                <button className="button-small" onClick={() => handleOpenEditItem(item)}>
                                  Edit
                                </button>
                              )}
                              {canAdjust && (
                                <button
                                  className="button-small danger"
                                  onClick={() => handleDeleteItem(item.id)}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={11} className="no-history-row">
                        {canAdjust
                          ? 'No inventory items found matching your filter. Click "+ Add New Item".'
                          : 'No inventory items found matching your filter.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'transactions' && (
          <>
            <div className="block-header">
              <h2>Stock Movement & Adjustment Log</h2>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Date</th>
                    <th>Item Description</th>
                    <th>Type</th>
                    <th>Quantity</th>
                    <th>Balance After</th>
                    <th>Reason / Activity</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.length > 0 ? (
                    transactions.map((tx, idx) => (
                      <tr key={tx.id}>
                        <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                        <td>{tx.date}</td>
                        <td>{tx.itemName}</td>
                        <td>
                          <span
                            style={{
                              padding: '3px 8px',
                              borderRadius: '12px',
                              fontSize: '11px',
                              fontWeight: '700',
                              background: tx.type === 'IN' ? '#dcfce7' : '#fee2e2',
                              color: tx.type === 'IN' ? '#166534' : '#991b1b'
                            }}
                          >
                            {tx.type === 'IN' ? '+ Stock IN' : '- Stock OUT'}
                          </span>
                        </td>
                        <td><strong>{tx.quantity} {tx.unit}</strong></td>
                        <td>{tx.balanceAfter} {tx.unit}</td>
                        <td>{tx.reason}</td>
                        <td>{tx.reference}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="no-history-row">
                        No stock movement transactions recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Add / Edit Item Modal */}
      {showItemModal && (
        <div className="template-modal-backdrop">
          <div className="template-modal" style={{ width: 'min(700px, 95vw)' }}>
            <div className="template-modal-header">
              <h3>{isEditingItem ? 'Edit Inventory Item' : 'Add New Inventory Item'}</h3>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setShowItemModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <form onSubmit={handleSaveItem}>
              <div className="form-grid" style={{ gap: '14px' }}>
                <div className="form-field">
                  <span>Category</span>
                  <select
                    value={itemFormData.category}
                    onChange={(e) => {
                      if (e.target.value === 'ADD_NEW') {
                        setShowAddCategoryModal(true);
                      } else {
                        setItemFormData({ ...itemFormData, category: e.target.value });
                      }
                    }}
                  >
                    {allCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    {canAdjust && <option value="ADD_NEW">+ Add New Category</option>}
                  </select>
                </div>
                <div className="form-field full-width">
                  <span>Item Name / Description *</span>
                  <input
                    type="text"
                    required
                    value={itemFormData.itemName}
                    onChange={(e) => setItemFormData({ ...itemFormData, itemName: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>HSN / SAC Code</span>
                  <input
                    type="text"
                    value={itemFormData.hsnSac}
                    onChange={(e) => setItemFormData({ ...itemFormData, hsnSac: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Unit of Measurement</span>
                  <select
                    value={itemFormData.unit}
                    onChange={(e) => setItemFormData({ ...itemFormData, unit: e.target.value })}
                  >
                    {DEFAULT_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <span>Current In Stock Qty</span>
                  <input
                    type="number"
                    min="0"
                    value={itemFormData.currentQty}
                    onChange={(e) => setItemFormData({ ...itemFormData, currentQty: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Min Reorder Alert Level</span>
                  <input
                    type="number"
                    min="0"
                    value={itemFormData.minReorderLevel}
                    onChange={(e) => setItemFormData({ ...itemFormData, minReorderLevel: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Unit Purchase Cost (₹)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={itemFormData.unitCost}
                    onChange={(e) => setItemFormData({ ...itemFormData, unitCost: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Unit Selling Price (₹)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={itemFormData.sellingPrice}
                    onChange={(e) => setItemFormData({ ...itemFormData, sellingPrice: e.target.value })}
                  />
                </div>
                <div className="form-field full-width">
                  <span>Warehouse / Storage Bin Location</span>
                  <input
                    type="text"
                    placeholder="e.g. Rack A-02, Shelf 3"
                    value={itemFormData.location}
                    onChange={(e) => setItemFormData({ ...itemFormData, location: e.target.value })}
                  />
                </div>
                <div className="form-field full-width">
                  <span>Shelf Life</span>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#334155',
                      cursor: 'pointer',
                      border: '1px solid #e2e8f0',
                      background: '#f8fafc',
                      borderRadius: '7px',
                      padding: '9px 11px'
                    }}
                  >
                    <input
                      type="checkbox"
                      style={{ width: 'auto', flexShrink: 0, margin: 0, accentColor: '#2563eb' }}
                      checked={Boolean(itemFormData.shelfLifeManaged)}
                      onChange={(e) =>
                        setItemFormData({ ...itemFormData, shelfLifeManaged: e.target.checked })
                      }
                    />
                    Shelf-life / Expiry managed (chemicals, consumables with expiry)
                  </label>
                  {itemFormData.shelfLifeManaged && (
                    <div style={{ marginTop: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                        Standard shelf life (months) <b style={{ color: '#dc2626' }}>*</b>
                      </span>
                      <input
                        type="number"
                        min="1"
                        placeholder="e.g. 12"
                        value={itemFormData.shelfLifeMonths || ''}
                        onChange={(e) =>
                          setItemFormData({ ...itemFormData, shelfLifeMonths: e.target.value })
                        }
                      />
                      <small style={{ color: '#64748b', fontSize: '11.5px' }}>
                        Reflected in <strong>Store → Shelf Life / Expiry</strong>. Used to suggest the
                        expiry date at receipt (Mfg date + this many months). Stock for this item is
                        issued FEFO — first expiry, first out — and expired batches are blocked until
                        written off.
                      </small>
                    </div>
                  )}
                </div>
              </div>

              <div className="form-actions" style={{ marginTop: '20px' }}>
                <button type="button" className="button-secondary" onClick={() => setShowItemModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="button-primary">
                  {isEditingItem ? 'Update Item' : 'Save Item to Inventory'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {showAdjustModal && (
        <div className="template-modal-backdrop">
          <div className="template-modal" style={{ width: 'min(550px, 95vw)' }}>
            <div className="template-modal-header">
              <h3>Quick Stock In / Out Adjustment</h3>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setShowAdjustModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <form onSubmit={handleSaveAdjustment}>
              <div className="form-grid" style={{ gap: '14px' }}>
                <div className="form-field full-width">
                  <span>Select Item</span>
                  <select
                    value={adjustFormData.itemId}
                    onChange={(e) => setAdjustFormData({ ...adjustFormData, itemId: e.target.value })}
                  >
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.itemName} (In Stock: {it.currentQty} {it.unit})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <span>Movement Type</span>
                  <select
                    value={adjustFormData.adjustType}
                    onChange={(e) =>
                      setAdjustFormData({
                        ...adjustFormData,
                        adjustType: e.target.value,
                        reason: e.target.value === 'IN' ? 'Stock Inward (Purchase)' : 'Production Consumption'
                      })
                    }
                  >
                    <option value="IN">+ Stock IN (Inward / Purchase / Return)</option>
                    <option value="OUT">- Stock OUT (Consumption / Scrapped / Damage)</option>
                  </select>
                </div>

                <div className="form-field">
                  <span>Quantity</span>
                  <input
                    type="number"
                    min="1"
                    required
                    placeholder="Enter quantity"
                    value={adjustFormData.quantity}
                    onChange={(e) => setAdjustFormData({ ...adjustFormData, quantity: e.target.value })}
                  />
                </div>

                <div className="form-field full-width">
                  <span>Reason / Note</span>
                  <input
                    type="text"
                    value={adjustFormData.reason}
                    onChange={(e) => setAdjustFormData({ ...adjustFormData, reason: e.target.value })}
                  />
                </div>

                <div className="form-field full-width">
                  <span>Reference (PO No. / DC No. / Bill No.)</span>
                  <input
                    type="text"
                    placeholder="Optional reference doc number"
                    value={adjustFormData.reference}
                    onChange={(e) => setAdjustFormData({ ...adjustFormData, reference: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-actions" style={{ marginTop: '20px' }}>
                <button type="button" className="button-secondary" onClick={() => setShowAdjustModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="button-primary">
                  Confirm Stock Update
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add New Category Modal */}
      {showAddCategoryModal && (
        <div className="template-modal-backdrop" style={{ zIndex: 120 }}>
          <div className="template-modal" style={{ width: 'min(450px, 90vw)' }}>
            <div className="template-modal-header">
              <h3>Add New Inventory Category</h3>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setShowAddCategoryModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <form onSubmit={handleSaveNewCategory}>
              <div className="form-grid" style={{ gap: '14px' }}>
                <div className="form-field full-width">
                  <span>Category Name *</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Electrical & Electronics, Consumable..."
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-actions" style={{ marginTop: '20px' }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setShowAddCategoryModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="button-primary">
                  Save Category
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventoryPage;
