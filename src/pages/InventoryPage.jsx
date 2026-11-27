import React, { useState, useEffect, useMemo } from 'react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { hasPermission } from '../utils/permissions.js';
import { isAdmin } from '../utils/auth.js';
import { getInventoryViewMeta, normalizeInventoryView } from '../utils/inventoryViews.js';
import AddableSelect from '../components/AddableSelect.jsx';
import StorePage from './StorePage.jsx';
import { addInventoryCategory, DEFAULT_INVENTORY_CATEGORIES, DEFAULT_UNITS, getInventoryCategories } from '../utils/addableMasters.js';
import { createMaster, listMasters } from '../services/masterApi.js';
import {
  deleteInventoryItem,
  getInventoryItem,
  listInventoryItems,
  listAllStockLedger,
  saveInventoryItem,
  postOpeningStock,
  postInventoryAdjustment
} from '../services/inventoryApi.js';
import ExcelImportDialog from '../components/ExcelImportDialog.jsx';
import { Upload } from 'lucide-react';
import { INVENTORY_EXCEL_COLUMNS, mapInventoryExcelRow, validateInventoryExcelRow, createInventoryItemsFromExcelRows } from '../utils/inventoryExcelImport.js';

const DEFAULT_CATEGORIES = DEFAULT_INVENTORY_CATEGORIES;


const InventoryPage = ({ view: viewProp }) => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const canAdjust = hasPermission('inventory.adjust');
  // Store login deep-links pass a `view`; the Admin /inventory route passes none and keeps its original behavior.
  const isStoreScoped = typeof viewProp === 'string' && viewProp.trim() !== '';
  const view = normalizeInventoryView(viewProp);
  const viewMeta = getInventoryViewMeta(view);
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [activeTab, setActiveTab] = useState(viewMeta.tab); // inventory | transactions | receive | issues

  // Categories
  const [customCategories, setCustomCategories] = useState(() => {
    return getInventoryCategories().filter((category) => !DEFAULT_CATEGORIES.includes(category));
  });
  // Custom units come from the PostgreSQL UOM Master, never browser storage.
  const [customUnits, setCustomUnits] = useState([]);
  useEffect(() => {
    let active = true;
    listMasters('uoms')
      .then((records) => { if (active) setCustomUnits(records.map((record) => record.code).filter(Boolean)); })
      .catch(() => { if (active) setCustomUnits([]); });
    return () => { active = false; };
  }, []);

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
  const [showExcelImport, setShowExcelImport] = useState(false);
  const inventoryImportColumns = INVENTORY_EXCEL_COLUMNS;
  const validateInventoryRow = (row) => validateInventoryExcelRow(mapInventoryExcelRow(row));
  const importInventoryRows = async (rows) => {
    const mappedRows = rows.map(mapInventoryExcelRow);
    const entries = createInventoryItemsFromExcelRows(mappedRows, items);
    let success = 0;
    for (const entry of entries) {
      await saveInventoryItem({
        itemCode: entry.itemCode,
        materialName: entry.itemName,
        category: entry.category,
        unit: entry.unit,
        hsnSac: entry.hsnSac,
        reorderLevel: entry.minReorderLevel,
        unitPrice: entry.unitCost,
        location: entry.location,
        currentQty: entry.currentQty
      });
      success += 1;
    }
    await refreshInventory();
    return { success, skipped: Math.max(0, rows.length - success) };
  };
  const [adjustFormData, setAdjustFormData] = useState({
    itemId: '',
    adjustType: 'IN', // 'IN' | 'OUT'
    quantity: '',
    reason: 'Stock Inward (Purchase)',
    reference: '',
    date: new Date().toISOString().slice(0, 10)
  });

  const refreshInventory = async () => {
    const [rows, ledger] = await Promise.all([listInventoryItems(), listAllStockLedger()]);
    setItems(rows.map((row) => ({
      ...(row.payload || {}),
      id: row.item_code || row.payload?.id,
      itemCode: row.item_code,
      itemName: row.material_name,
      category: row.category,
      hsnSac: row.hsn_code,
      unit: row.unit,
      currentQty: Number(row.current_qty) || 0,
      minReorderLevel: Number(row.reorder_level) || 0,
      minOrderQty: Number(row.min_order_qty) || 0,
      unitCost: Number(row.unit_price) || 0,
      location: row.location,
      shelfLifeManaged: Boolean(row.shelf_life_managed),
      shelfLifeDays: Number(row.shelf_life_days) || 0,
      recordVersion: Number(row.version) || 1
    })));
    setTransactions(ledger.map((row) => ({
      id: row.id,
      date: String(row.entry_date || '').slice(0, 10),
      itemCode: row.item_code,
      itemName: row.payload?.itemName || row.item_code,
      unit: row.unit,
      type: ['OUT', 'ISSUE', 'ADJUSTMENT_OUT', 'TRANSFER_OUT'].includes(String(row.movement_type).toUpperCase()) ? 'OUT' : 'IN',
      quantity: Number(row.quantity) || 0,
      balanceAfter: Number(row.balance_after) || 0,
      reason: row.reason,
      reference: row.source_doc_ref || '-'
    })));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('inventory-authority-updated'));
    }
  };

  useEffect(() => {
    refreshInventory().catch((error) => alert(error.message || 'Inventory could not be loaded from PostgreSQL.'));
  }, []);

  const selectInventoryTab = (tab) => setActiveTab(tab);

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
  const handleSaveItem = async (e) => {
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

    try {
      await saveInventoryItem(payload, isEditingItem ? Number(items.find((it) => it.id === payload.itemCode)?.recordVersion || 1) : undefined);
      if (!isEditingItem && Number(payload.currentQty) > 0) {
        await postOpeningStock({
          idempotencyKey: `opening-${payload.itemCode}-${Date.now()}`,
          itemCode: payload.itemCode,
          materialName: payload.itemName,
          quantity: Number(payload.currentQty),
          unit: payload.unit,
          unitCost: payload.unitCost,
          reason: 'Opening stock'
        });
      }
      await refreshInventory();
      setShowItemModal(false);
    } catch (error) {
      alert(error.message || 'Inventory item could not be saved to PostgreSQL.');
    }
  };

  // Delete Item — server confirms the soft delete before the local cache changes.
  const handleDeleteItem = async (id) => {
    const item = items.find((entry) => String(entry.id) === String(id));
    if (!isAdmin() || !item) return;
    if (!window.confirm(`Delete inventory item ${item.itemCode || item.itemName || id}? Only unused items with zero stock can be deleted.`)) return;
    const reason = window.prompt(`Reason for deleting ${item.itemCode || item.itemName || id}:`)?.trim();
    if (!reason) return;
    try {
      const itemCode = String(item.itemCode || item.id);
      const fresh = await getInventoryItem(itemCode);
      await deleteInventoryItem(itemCode, fresh.version, reason);
      await refreshInventory();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateCategory = (name) => {
    const created = addInventoryCategory(name);
    setCustomCategories(getInventoryCategories().filter((category) => !DEFAULT_CATEGORIES.includes(category)));
    return created;
  };

  const handleCreateUnit = async ({ name, symbol }) => {
    const code = String(symbol || name || '').trim();
    if (!code) throw new Error('Unit symbol is required.');
    const response = await createMaster('uoms', {
      code,
      name: String(name || code).trim(),
      symbol: code,
      description: ''
    });
    const records = await listMasters('uoms');
    setCustomUnits(records.map((record) => record.code).filter(Boolean));
    return response.record?.code || code;
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
  const handleSaveAdjustment = async (e) => {
    e.preventDefault();
    const qtyChange = Number(adjustFormData.quantity);
    if (!qtyChange || qtyChange <= 0) {
      alert('Please enter a valid quantity.');
      return;
    }

    const targetItem = items.find((it) => it.id === adjustFormData.itemId);
    if (!targetItem) return;

    const quantity = adjustFormData.adjustType === 'OUT' ? -qtyChange : qtyChange;
    try {
      await postInventoryAdjustment({
        idempotencyKey: `adjust-${targetItem.itemCode}-${Date.now()}`,
        itemCode: targetItem.itemCode,
        materialName: targetItem.itemName,
        quantity,
        unit: targetItem.unit,
        entryDate: adjustFormData.date,
        reason: adjustFormData.reason,
        reference: adjustFormData.reference || '-'
      });
      await refreshInventory();
      setShowAdjustModal(false);
    } catch (error) {
      alert(error.message || 'Inventory adjustment could not be saved to PostgreSQL.');
    }
  };

  return (
    <div className={`page-section${isStoreScoped ? ' store-screen' : ''}`}>
      <div className="page-header">
        <div>
          <h1>{isStoreScoped ? viewMeta.title : 'Inventory Management'}</h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
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
          {canAdjust && <button type="button" className="button-secondary" onClick={() => setShowExcelImport(true)}><Upload size={16}/> Import Excel</button>}
          <button type="button" className="button-primary" onClick={() => selectInventoryTab('receive')}>
            Receive Purchase Orders
          </button>
        </div>
      </div>

      {/* KPI Stats Overview */}
      {showExcelImport && <ExcelImportDialog title="Inventory Items" columns={inventoryImportColumns} example={['1','Example steel plate','Raw Material','Kg',100,20,80,85,95]} instructions={['Template columns: SL.No, Item Description, Category, Unit, In Stock, Reserved, Available, Unit Cost and Selling Price.', 'Item Description is required. Category and Unit are optional and default to Standard Part and Nos.', 'In Stock, Reserved, Available and prices may be blank or non-negative numbers. Available must match In Stock minus Reserved.', 'Rows are added as new inventory records with generated unique item codes. Existing stock, IDs and transaction relationships are not overwritten.']} validate={validateInventoryRow} onImport={importInventoryRows} mapRow={mapInventoryExcelRow} onClose={() => setShowExcelImport(false)}/>}
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
        <div className="inventory-section-tabs tab-nav" role="tablist" aria-label="Inventory sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'inventory'}
            className={`tab-link${activeTab === 'inventory' ? ' active' : ''}`}
            onClick={() => selectInventoryTab('inventory')}
          >
            Item Master & Stock Levels
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'transactions'}
            className={`tab-link${activeTab === 'transactions' ? ' active' : ''}`}
            onClick={() => selectInventoryTab('transactions')}
          >
            Stock Movement History ({transactions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'receive'}
            className={`tab-link${activeTab === 'receive' ? ' active' : ''}`}
            onClick={() => selectInventoryTab('receive')}
          >
            Receive Purchase Orders
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'issues'}
            className={`tab-link${activeTab === 'issues' ? ' active' : ''}`}
            onClick={() => selectInventoryTab('issues')}
          >
            Issued to Employees
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
                <AddableSelect
                  value={selectedCategory}
                  onValueChange={(category) => setSelectedCategory(category)}
                  options={[{ value: 'ALL', label: 'All Categories' }, ...allCategories]}
                  onCreate={(values) => handleCreateCategory(values.name)}
                  title="Add Inventory Category"
                  fieldLabel="Category Name"
                  saveLabel="Save"
                  addLabel="+ Add New Category"
                  addNewInOptions
                  className="inventory-category-select"
                  canAdd={canAdjust}
                />
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
                          <td style={{ textAlign: 'center' }}>{item.serialNumber || idx + 1}</td>
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
                              {isAdmin() && (
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

        {activeTab === 'receive' && <StorePage embeddedTab="receive" />}
        {activeTab === 'issues' && <StorePage embeddedTab="issues" />}
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
                  <AddableSelect
                    value={itemFormData.category}
                    onValueChange={(category) => setItemFormData((previous) => ({ ...previous, category }))}
                    options={allCategories}
                    onCreate={(values) => handleCreateCategory(values.name)}
                    title="Add Inventory Category"
                    fieldLabel="Category Name"
                    saveLabel="Save"
                    addLabel="+ Add New Category"
                    addNewInOptions
                    canAdd={canAdjust}
                  />
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
                  <AddableSelect
                    value={itemFormData.unit}
                    onChange={(event) => setItemFormData((previous) => ({ ...previous, unit: event.target.value }))}
                    options={[...DEFAULT_UNITS, ...customUnits]}
                    onCreate={handleCreateUnit}
                    masterType="unit"
                    title="Add Unit of Measurement"
                    addLabel="+ Add New Unit"
                  />
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

    </div>
  );
};

export default InventoryPage;
