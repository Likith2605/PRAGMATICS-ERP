import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { addInventoryItem, adjustInventoryStock, deleteInventoryItemIfUnused } from '../utils/storeService.js';
import { getPOProgress } from '../utils/workflowService.js';
import AddableSelect from '../components/AddableSelect.jsx';
import { addCustomUnit, addInventoryCategory, getAvailableUnits, getInventoryCategories, removeCustomUnit, removeInventoryCategory } from '../utils/addableMasters.js';
import { hasPermission } from '../utils/permissions.js';
import { isAdmin } from '../utils/auth.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

const emptyIssueForm = {
  itemId: '',
  quantity: '',
  employeeName: '',
  date: todayStr(),
  notes: ''
};

const emptyNewItemForm = {
  itemCode: '',
  itemName: '',
  category: 'Standard Part',
  hsnSac: '',
  unit: 'Nos',
  currentQty: '0',
  minReorderLevel: '10',
  unitCost: '',
  sellingPrice: '',
  location: '',
};

const emptyAdjustForm = {
  itemId: '',
  adjustType: 'IN', // 'IN' | 'OUT'
  quantity: '',
  reason: 'Stock Inward (Purchase)',
  reference: ''
};

const StorePage = ({ embeddedTab = '' } = {}) => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [employeeIssues, setEmployeeIssues] = useState([]);
  const [itemToDeleteId, setItemToDeleteId] = useState(null);
  const [isDeletingItem, setIsDeletingItem] = useState(false);
  const [itemActionNotification, setItemActionNotification] = useState(null);

  // Tabs: 'items' | 'receive' | 'issues'
  const [activeTab, setActiveTab] = useState(embeddedTab || 'items');
  const embedded = embeddedTab === 'receive' || embeddedTab === 'issues';

  const [expandedPO, setExpandedPO] = useState(null);

  // Add New Item modal
  const [showAddItemModal, setShowAddItemModal] = useState(false);
  const [newItemForm, setNewItemForm] = useState({ ...emptyNewItemForm });
  const [unitOptions, setUnitOptions] = useState(getAvailableUnits);
  const [categories, setCategories] = useState(getInventoryCategories);
  const canAddCategory = hasPermission('inventory.adjust');

  // Adjust Stock modal
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustForm, setAdjustForm] = useState({ ...emptyAdjustForm });

  // Issue to Employee modal
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issueForm, setIssueForm] = useState({ ...emptyIssueForm });
  const [issueError, setIssueError] = useState('');

  // Employee issue history filter
  const [employeeFilter, setEmployeeFilter] = useState('ALL');

  useEffect(() => {
    try {
      const storedItems = localStorage.getItem('inventoryItems');
      setItems(storedItems ? JSON.parse(storedItems) : []);
    } catch {
      setItems([]);
    }
    try {
      const storedTx = localStorage.getItem('stockTransactions');
      setTransactions(storedTx ? JSON.parse(storedTx) : []);
    } catch {
      setTransactions([]);
    }
    try {
      const storedPOs = localStorage.getItem('supplierPOHistory');
      setPurchaseOrders(storedPOs ? JSON.parse(storedPOs) : []);
    } catch {
      setPurchaseOrders([]);
    }
    try {
      const storedIssues = localStorage.getItem('employeeIssueLog');
      setEmployeeIssues(storedIssues ? JSON.parse(storedIssues) : []);
    } catch {
      setEmployeeIssues([]);
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

  // Per-record conflict resolved by the sync engine (server copy applied to
  // localStorage) — reload so this page shows the latest data.
  useEffect(() => {
    const refresh = () => reloadInventory();
    window.addEventListener('erp-records-conflict', refresh);
    window.addEventListener('erp-records-synced', refresh);
    return () => {
      window.removeEventListener('erp-records-conflict', refresh);
      window.removeEventListener('erp-records-synced', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync state from localStorage after a service-level stock write
  const reloadInventory = () => {
    try {
      const storedItems = localStorage.getItem('inventoryItems');
      setItems(storedItems ? JSON.parse(storedItems) : []);
      const storedTx = localStorage.getItem('stockTransactions');
      setTransactions(storedTx ? JSON.parse(storedTx) : []);
    } catch {
      /* keep current state */
    }
  };

  const reloadPOs = () => {
    try {
      const storedPOs = localStorage.getItem('supplierPOHistory');
      setPurchaseOrders(storedPOs ? JSON.parse(storedPOs) : []);
    } catch {
      setPurchaseOrders([]);
    }
  };

  // Total OUT per itemCode (production consumption + employee issues + dispatches)
  const usedByCode = useMemo(() => {
    const map = {};
    transactions.forEach((tx) => {
      if (tx.type === 'OUT' && tx.itemCode) {
        map[tx.itemCode] = (map[tx.itemCode] || 0) + (Number(tx.quantity) || 0);
      }
    });
    return map;
  }, [transactions]);

  // PO reference(s) that brought each itemCode in via a Purchase Inward
  const poRefsByCode = useMemo(() => {
    const map = {};
    transactions.forEach((tx) => {
      if (tx.type === 'IN' && tx.itemCode && tx.reason && tx.reason.toLowerCase().includes('purchase inward')) {
        if (!tx.reference || tx.reference === '-') return;
        if (!map[tx.itemCode]) map[tx.itemCode] = [];
        if (!map[tx.itemCode].includes(tx.reference)) map[tx.itemCode].push(tx.reference);
      }
    });
    return map;
  }, [transactions]);

  // Purchase Orders still awaiting a Material Receipt (pending quantity > 0)
  const pendingPOs = useMemo(
    () =>
      purchaseOrders.filter((po) => {
        if (po.status === 'Cancelled') return false;
        try {
          const p = getPOProgress(po.reference);
          if (p.ordered > 0) return p.pending > 0;
        } catch {
          // fall through to legacy status check
        }
        return !['Received', 'Fully Received', 'Closed', 'Cancelled'].includes(po.status);
      }),
    [purchaseOrders]
  );

  const employeeNames = useMemo(
    () => [...new Set(employeeIssues.map((i) => i.employeeName).filter(Boolean))],
    [employeeIssues]
  );

  const filteredIssues = useMemo(() => {
    if (employeeFilter === 'ALL') return employeeIssues;
    return employeeIssues.filter((i) => i.employeeName === employeeFilter);
  }, [employeeIssues, employeeFilter]);

  // ---- Store item list helpers ----

  const handleOpenAddItem = () => {
    const availableCategories = getInventoryCategories();
    const availableUnits = getAvailableUnits();
    setCategories(availableCategories);
    setUnitOptions(availableUnits);
    setNewItemForm({
      ...emptyNewItemForm,
      itemCode: `PRAG-${Math.floor(100 + Math.random() * 900)}`,
      category: availableCategories.includes(emptyNewItemForm.category) ? emptyNewItemForm.category : (availableCategories[0] || ''),
      unit: availableUnits.includes(emptyNewItemForm.unit) ? emptyNewItemForm.unit : (availableUnits[0] || '')
    });
    setShowAddItemModal(true);
  };

  const handleCreateCategory = (name) => {
    const created = addInventoryCategory(name);
    setCategories(getInventoryCategories());
    setItemActionNotification({ type: 'success', message: 'Inventory category added successfully.' });
    return created;
  };

  const handleCreateUnit = ({ name, symbol }) => {
    const created = addCustomUnit({ name, symbol });
    setUnitOptions(getAvailableUnits());
    return created;
  };

  const handleDeleteCategory = (name) => {
    try {
      const deleted = removeInventoryCategory(name);
      const availableCategories = getInventoryCategories();
      setCategories(availableCategories);
      if (newItemForm.category.toLocaleLowerCase() === deleted.toLocaleLowerCase()) {
        setNewItemForm((previous) => ({ ...previous, category: availableCategories[0] || '' }));
      }
      setItemActionNotification({ type: 'success', message: `Category “${deleted}” deleted successfully.` });
      return deleted;
    } catch (err) {
      setItemActionNotification({ type: 'error', message: err.message || 'Could not delete this category.' });
      throw err;
    }
  };

  const handleDeleteUnit = (symbol) => {
    try {
      const deleted = removeCustomUnit(symbol);
      const availableUnits = getAvailableUnits();
      setUnitOptions(availableUnits);
      if (newItemForm.unit.toLocaleLowerCase() === deleted.toLocaleLowerCase()) {
        setNewItemForm((previous) => ({ ...previous, unit: availableUnits[0] || '' }));
      }
      setItemActionNotification({ type: 'success', message: `Unit “${deleted}” deleted successfully.` });
      return deleted;
    } catch (err) {
      setItemActionNotification({ type: 'error', message: err.message || 'Could not delete this unit.' });
      throw err;
    }
  };

  const handleSaveNewItem = (e) => {
    e.preventDefault();
    try {
      const created = addInventoryItem(newItemForm);
      reloadInventory();
      setShowAddItemModal(false);
      alert(`Item ${created.itemName} added to Store / inventory master.`);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleConfirmDeleteItem = () => {
    if (!itemToDeleteId || isDeletingItem) return;
    const target = items.find((item) => String(item.id) === String(itemToDeleteId));
    const reason = window.prompt(`Reason for deleting ${target?.itemCode || target?.itemName || itemToDeleteId}:`)?.trim();
    if (!reason) return;
    const reasons = (() => { try { return JSON.parse(localStorage.getItem('erp_record_delete_reasons') || '{}'); } catch { return {}; } })();
    reasons.inventoryItems = { ...(reasons.inventoryItems || {}), [String(itemToDeleteId)]: reason };
    localStorage.setItem('erp_record_delete_reasons', JSON.stringify(reasons));
    setIsDeletingItem(true);
    try {
      deleteInventoryItemIfUnused(itemToDeleteId);
      reloadInventory();
      setItemActionNotification({ type: 'success', message: 'Store item deleted successfully.' });
    } catch (err) {
      setItemActionNotification({
        type: 'error',
        message: err.message || 'The store item could not be deleted.'
      });
    } finally {
      setItemToDeleteId(null);
      setIsDeletingItem(false);
    }
  };

  const handleOpenAdjust = (item = null) => {
    setAdjustForm({
      ...emptyAdjustForm,
      itemId: item ? item.id : (items[0]?.id || '')
    });
    setShowAdjustModal(true);
  };

  const handleSaveAdjustment = (e) => {
    e.preventDefault();
    const qtyChange = Number(adjustForm.quantity);
    if (!qtyChange || qtyChange <= 0) {
      alert('Please enter a valid quantity greater than zero.');
      return;
    }
    const targetItem = items.find((it) => it.id === adjustForm.itemId);
    if (!targetItem) {
      alert('Please select an item.');
      return;
    }
    const current = Number(targetItem.currentQty) || 0;
    if (adjustForm.adjustType === 'OUT' && qtyChange > current) {
      if (!window.confirm('Adjusted reduction is greater than current stock. Proceed anyway?')) {
        return;
      }
    }
    try {
      const result = adjustInventoryStock({
        itemId: targetItem.id,
        adjustType: adjustForm.adjustType,
        quantity: qtyChange,
        reason: adjustForm.reason,
        reference: adjustForm.reference
      });
      reloadInventory();
      setShowAdjustModal(false);
      alert(
        `Stock for ${result.itemName} ${result.type === 'IN' ? 'increased' : 'reduced'} from ${result.previousQty} to ${result.newQty} ${targetItem.unit || 'Nos'}.`
      );
    } catch (err) {
      alert(err.message);
    }
  };

  // ---- Issue to Employee ----

  const handleOpenIssue = (item = null) => {
    setIssueError('');
    setIssueForm({
      itemId: item ? item.id : items[0]?.id || '',
      quantity: '',
      employeeName: '',
      date: todayStr(),
      notes: ''
    });
    setShowIssueModal(true);
  };

  const handleSaveIssue = (e) => {
    e.preventDefault();
    const targetItem = items.find((it) => it.id === issueForm.itemId);
    if (!targetItem) {
      setIssueError('Please select an item.');
      return;
    }
    const qty = Number(issueForm.quantity);
    if (!qty || qty <= 0) {
      setIssueError('Please enter a valid quantity greater than zero.');
      return;
    }
    const current = Number(targetItem.currentQty) || 0;
    if (qty > current) {
      setIssueError(
        `Insufficient stock. Available: ${current} ${targetItem.unit || 'Nos'}. Cannot issue more than available.`
      );
      return;
    }
    const employeeName = issueForm.employeeName.trim();
    if (!employeeName) {
      setIssueError('Please enter the employee name.');
      return;
    }

    const newQty = current - qty;
    const updatedItems = items.map((it) => (it.id === targetItem.id ? { ...it, currentQty: newQty } : it));
    saveItemsToStorage(updatedItems);

    saveTransactionsToStorage([
      {
        id: `tx-${Date.now()}`,
        date: issueForm.date,
        itemCode: targetItem.itemCode,
        itemName: targetItem.itemName,
        unit: targetItem.unit || 'Nos',
        type: 'OUT',
        quantity: qty,
        balanceAfter: newQty,
        reason: `Issued to Employee: ${employeeName}`,
        reference: '-'
      },
      ...transactions
    ]);

    const newIssue = {
      id: `issue-${Date.now()}`,
      date: issueForm.date,
      itemCode: targetItem.itemCode,
      itemName: targetItem.itemName,
      quantity: qty,
      unit: targetItem.unit || 'Nos',
      employeeName,
      notes: issueForm.notes.trim() || ''
    };
    const updatedIssues = [newIssue, ...employeeIssues];
    setEmployeeIssues(updatedIssues);
    localStorage.setItem('employeeIssueLog', JSON.stringify(updatedIssues));

    setIssueError('');
    setShowIssueModal(false);
    alert(`${qty} ${targetItem.unit || 'Nos'} of ${targetItem.itemName} issued to ${employeeName}.`);
  };

  // ---- Render helpers ----

  const reorderBadge = (item) => {
    const qty = Number(item.currentQty) || 0;
    const minLvl = Number(item.minReorderLevel) || 0;
    if (qty <= minLvl) {
      return (
        <span
          style={{
            padding: '4px 10px',
            borderRadius: '20px',
            fontSize: '11.5px',
            fontWeight: '700',
            background: '#fee2e2',
            color: '#991b1b',
            whiteSpace: 'nowrap'
          }}
        >
          Reorder Needed
        </span>
      );
    }
    return <span style={{ color: '#9ca3af' }}>—</span>;
  };

  const itemActions = (item) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      <button className="button-small" onClick={() => handleOpenAdjust(item)} title="Adjust Stock / Physical Count">
        Adjust Stock
      </button>
      <button
        className="button-small"
        onClick={() => handleOpenIssue(item)}
        title="Issue this item to an employee"
        style={{ color: '#6d28d9', borderColor: '#ddd6fe' }}
      >
        Issue
      </button>
      {isAdmin() && <button
        className="button-small"
        onClick={() => {
          setItemActionNotification(null);
          setItemToDeleteId(item.id);
        }}
        title="Delete this unused item"
        style={{ color: '#b91c1c', borderColor: '#fecaca' }}
      >
        Delete
      </button>}
    </div>
  );

  return (
    <div className={`page-section store-screen${embedded ? ' store-screen-embedded' : ''}`}>
      {!embedded && <div className="page-header">
        <div>
          <h1>Store Management</h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          <button className="button-secondary" onClick={handleOpenAddItem}>
            + Add New Item
          </button>
          <button
            className="button-primary"
            onClick={() => {
              setActiveTab('receive');
              setExpandedPO(null);
            }}
          >
            Receive Purchase Orders
          </button>
        </div>
      </div>}

      <div className={embedded ? 'store-embedded-content' : 'content-block'}>
        {/* Top-level navigation tabs */}
        {!embedded && <div style={{ display: 'flex', gap: '10px', borderBottom: '1px solid #e5e7eb', paddingBottom: '14px', marginBottom: '20px', flexWrap: 'wrap' }}>
          <button
            className={activeTab === 'items' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('items')}
            style={{ padding: '8px 18px' }}
          >
            Store Items ({items.length})
          </button>
          <button
            className={activeTab === 'receive' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('receive')}
            style={{ padding: '8px 18px' }}
          >
            Receive Purchase Orders ({pendingPOs.length})
          </button>
          <button
            className={activeTab === 'issues' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('issues')}
            style={{ padding: '8px 18px' }}
          >
            Issued to Employees ({employeeIssues.length})
          </button>
        </div>}

        {/* ============ STORE ITEMS ============ */}
        {activeTab === 'items' && (
          <div className="history-table-wrapper">
            {itemActionNotification && (
              <div
                role={itemActionNotification.type === 'error' ? 'alert' : 'status'}
                style={{
                  position: 'fixed',
                  top: '18px',
                  right: '18px',
                  zIndex: 1100,
                  padding: '10px 14px',
                  maxWidth: 'min(440px, calc(100vw - 36px))',
                  borderRadius: '8px',
                  color: itemActionNotification.type === 'error' ? '#991b1b' : '#166534',
                  background: itemActionNotification.type === 'error' ? '#fee2e2' : '#dcfce7',
                  border: `1px solid ${itemActionNotification.type === 'error' ? '#fecaca' : '#bbf7d0'}`
                }}
              >
                {itemActionNotification.message}
              </div>
            )}
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Item Description</th>
                  <th>Unit</th>
                  <th>In Stock</th>
                  <th>Min Reorder Level</th>
                  <th>Reorder Status</th>
                  <th>Purchase Order Reference(s)</th>
                  <th>Used</th>
                  <th>Pending / Balance</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length > 0 ? (
                  items.map((item, idx) => {
                    const poRefs = poRefsByCode[item.itemCode] || [];
                    return (
                      <tr key={item.id}>
                        <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                        <td><div style={{ fontWeight: '600', color: '#0f172a' }}>{item.itemName}</div></td>
                        <td>{item.unit || 'Nos'}</td>
                        <td><strong>{Number(item.currentQty) || 0}</strong></td>
                        <td>{Number(item.minReorderLevel) || 0}</td>
                        <td>{reorderBadge(item)}</td>
                        <td>
                          {poRefs.length > 0 ? (
                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                              {poRefs.map((ref) => (
                                <span key={ref} style={{ padding: '3px 9px', borderRadius: '12px', fontSize: '11px', fontWeight: '700', background: '#eef2ff', color: '#3730a3', whiteSpace: 'nowrap' }}>
                                  {ref}
                                </span>
                              ))}
                            </div>
                          ) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td>{usedByCode[item.itemCode] || 0}</td>
                        <td style={{ fontWeight: '700', color: (Number(item.currentQty) || 0) > 0 ? '#166534' : '#dc2626' }}>
                          {Number(item.currentQty) || 0}
                        </td>
                        <td>{itemActions(item)}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={10} className="no-history-row">
                      No store items yet. Click "+ Add New Item" or receive a Purchase Order.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ============ PURCHASE ORDERS AWAITING MATERIAL RECEIPT ============ */}
        {activeTab === 'receive' && (
          <>
            <div className="block-header">
              <h2>Purchase Orders Awaiting Material Receipt</h2>
              <span className="count-badge">{pendingPOs.length} open PO(s)</span>
              <button className="button-small" onClick={reloadPOs} style={{ marginRight: '10px' }}>Reload POs</button>
            </div>
            <p style={{ margin: '0 0 18px', color: '#4b5563', fontSize: '13.5px', lineHeight: '1.6' }}>
              A vendor delivery is recorded on the <strong>Tax Invoice / Material Receipt</strong> screen. Received
              material is held as pending stock and is added to Inventory <strong>only after Quality approval</strong>
              (NO QUALITY APPROVAL = NO INVENTORY UPDATE).
            </p>

            {pendingPOs.length > 0 ? (
              pendingPOs.map((po, idx) => {
                const poItems = (po.payload && po.payload.items) || [];
                const progress = (() => {
                  try {
                    return getPOProgress(po.reference);
                  } catch {
                    return null;
                  }
                })();
                const isExpanded = expandedPO === po.reference;
                return (
                  <div
                    key={po.reference || idx}
                    style={{ border: '1px solid #e5e7eb', borderRadius: '14px', marginBottom: '14px', overflow: 'hidden' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px',
                        padding: '14px 16px',
                        background: '#f8fafc',
                        cursor: 'pointer',
                        flexWrap: 'wrap'
                      }}
                      onClick={() => setExpandedPO(isExpanded ? null : po.reference)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                        <strong>{po.reference}</strong>
                        <span>{po.vendor}</span>
                        <span style={{ color: '#64748b', fontSize: '12px' }}>
                          {po.projectRef !== '-' && po.projectRef ? `Project: ${po.projectRef}` : ''}
                        </span>
                        <span style={{ color: '#64748b', fontSize: '12px' }}>Due: {po.dueDate || '-'}</span>
                        <span style={{ color: '#64748b', fontSize: '12px' }}>Total: {po.total}</span>
                        <span className={`status-badge st-${(po.status || 'issued').toLowerCase().replace(/\s+/g, '-')}`}>
                          {po.status === 'Closed' ? 'PO CLOSED – FULLY RECEIVED' : po.status}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {progress && (
                          <span className="count-badge" style={{ background: '#fef3c7', color: '#92400e' }}>
                            {progress.received} / {progress.ordered} received
                          </span>
                        )}
                        {hasPermission('receipt.view') || hasPermission('receipt.create') ? <button
                          className="button-small"
                          style={{ color: '#16a34a', borderColor: '#bbf7d0' }}
                          title="Enter the vendor Tax Invoice / Material Receipt for this PO"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate('/material-receipts', { state: { newReceiptFor: po.reference } });
                          }}
                        >
                          Enter Tax Invoice / Material Receipt
                        </button> : null}
                        <span className="button-small">{isExpanded ? 'Collapse' : 'Expand'}</span>
                      </div>
                    </div>
                    {isExpanded && (
                      <div style={{ padding: '16px' }}>
                        <div className="history-table-wrapper">
                          <table className="history-table" style={{ minWidth: '520px' }}>
                            <thead>
                              <tr>
                                <th>SL.No</th>
                                <th>Item Name</th>
                                <th>Ordered Qty</th>
                                <th>Received Qty</th>
                                <th>Pending Qty</th>
                                <th>Unit</th>
                                <th>Receiving Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {poItems.length > 0 ? (
                                poItems.map((it, i) => {
                                  const line =
                                    progress?.lines?.find(
                                      (l) =>
                                        (l.materialCode && String(l.materialCode) === String(it.itemCode)) ||
                                        (l.itemName && String(l.itemName) === String(it.itemName))
                                    ) || null;
                                  const receivedQty = line ? line.receivedQty : 0;
                                  const pendingQty = line ? line.pendingQty : Number(it.quantity) || 0;
                                  return (
                                    <tr key={`${it.itemCode}-${i}`}>
                                      <td style={{ textAlign: 'center' }}>{i + 1}</td>
                                      <td>{it.itemName}</td>
                                      <td>{it.quantity || 0}</td>
                                      <td style={{ fontWeight: '700', color: receivedQty > 0 ? '#166534' : '#9ca3af' }}>
                                        {receivedQty}
                                      </td>
                                      <td style={{ fontWeight: '700', color: pendingQty > 0 ? '#92400e' : '#9ca3af' }}>
                                        {pendingQty}
                                      </td>
                                      <td>{it.unit || 'Nos'}</td>
                                      <td>
                                        <span
                                          className="count-badge"
                                          style={{
                                            background: pendingQty > 0 ? '#fef3c7' : '#dcfce7',
                                            color: pendingQty > 0 ? '#92400e' : '#166534'
                                          }}
                                        >
                                          {pendingQty > 0 ? 'Awaiting Receipt' : 'Received'}
                                        </span>
                                      </td>
                                    </tr>
                                  );
                                })
                              ) : (
                                <tr>
                                  <td colSpan={7} className="no-history-row">
                                    No line items on this Purchase Order.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <div className="empty-state-icon">✓</div>
                <h3>No pending Purchase Orders</h3>
                <p>All Purchase Orders have been fully received and closed.</p>
              </div>
            )}
          </>
        )}

        {/* ============ ISSUED TO EMPLOYEES ============ */}
        {activeTab === 'issues' && (
          <>
            <div className="block-header">
              <h2>Material Issued to Employees</h2>
              {hasPermission('inventory.adjust') && <button type="button" className="button-primary button-small" onClick={() => handleOpenIssue()} disabled={!items.length}>Issue to Employee</button>}
              <select
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                className="action-select"
                style={{ minWidth: '180px' }}
              >
                <option value="ALL">All Employees</option>
                {employeeNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Date</th>
                    <th>Item Description</th>
                    <th>Quantity</th>
                    <th>Employee</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.length > 0 ? (
                    filteredIssues.map((issue, idx) => (
                      <tr key={issue.id}>
                        <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                        <td>{issue.date}</td>
                        <td>{issue.itemName}</td>
                        <td><strong>{issue.quantity} {issue.unit}</strong></td>
                        <td>{issue.employeeName}</td>
                        <td style={{ color: '#64748b' }}>{issue.notes || '—'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="no-history-row">
                        No materials issued to employees yet. Use "Issue to Employee" to log an issue.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ============ ADD NEW ITEM MODAL ============ */}
      {showAddItemModal && (
        <div className="template-modal-backdrop">
          <div className="template-modal store-item-modal" style={{ width: 'min(1040px, 95vw)' }}>
            <div className="template-modal-header">
              <h3>Add New Store Item</h3>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setShowAddItemModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <form onSubmit={handleSaveNewItem}>
              <div className="form-grid store-item-form-grid" style={{ gap: '14px' }}>
                <div className="form-field">
                  <span>Category</span>
                  <AddableSelect
                    value={newItemForm.category}
                    onValueChange={(category) => setNewItemForm((previous) => ({ ...previous, category }))}
                    options={categories}
                    onCreate={(values) => handleCreateCategory(values.name)}
                    title="Add Inventory Category"
                    fieldLabel="Category Name"
                    saveLabel="Save"
                    addLabel="+ Add New Category"
                    addNewInOptions
                    canAdd={canAddCategory}
                    customDropdown
                    deletableOptions={categories}
                    onDeleteOption={isAdmin() ? handleDeleteCategory : undefined}
                  />
                </div>
                <div className="form-field">
                  <span>Item Name / Description *</span>
                  <input
                    type="text"
                    required
                    value={newItemForm.itemName}
                    onChange={(e) => setNewItemForm({ ...newItemForm, itemName: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>HSN / SAC Code</span>
                  <input
                    type="text"
                    value={newItemForm.hsnSac}
                    onChange={(e) => setNewItemForm({ ...newItemForm, hsnSac: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Unit of Measurement</span>
                  <AddableSelect
                    value={newItemForm.unit}
                    onChange={(event) => setNewItemForm((previous) => ({ ...previous, unit: event.target.value }))}
                    options={unitOptions}
                    onCreate={handleCreateUnit}
                    masterType="unit"
                    title="Add Unit of Measurement"
                    addLabel="+ Add New Unit"
                    addNewInOptions
                    customDropdown
                    deletableOptions={unitOptions}
                    onDeleteOption={isAdmin() ? handleDeleteUnit : undefined}
                  />
                </div>
                <div className="form-field">
                  <span>Current In Stock Qty</span>
                  <input
                    type="number"
                    min="0"
                    value={newItemForm.currentQty}
                    onChange={(e) => setNewItemForm({ ...newItemForm, currentQty: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Min Reorder Alert Level</span>
                  <input
                    type="number"
                    min="0"
                    value={newItemForm.minReorderLevel}
                    onChange={(e) => setNewItemForm({ ...newItemForm, minReorderLevel: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Unit Purchase Cost (₹)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={newItemForm.unitCost}
                    onChange={(e) => setNewItemForm({ ...newItemForm, unitCost: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <span>Unit Selling Price (₹)</span>
                  <input
                    type="number"
                    step="0.01"
                    value={newItemForm.sellingPrice}
                    onChange={(e) => setNewItemForm({ ...newItemForm, sellingPrice: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-actions" style={{ marginTop: '20px' }}>
                <button type="button" className="button-secondary" onClick={() => setShowAddItemModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="button-primary">
                  Save Item to Inventory
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============ QUICK STOCK ADJUSTMENT MODAL ============ */}
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
                    value={adjustForm.itemId}
                    onChange={(e) => setAdjustForm({ ...adjustForm, itemId: e.target.value })}
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
                    value={adjustForm.adjustType}
                    onChange={(e) =>
                      setAdjustForm({
                        ...adjustForm,
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
                    value={adjustForm.quantity}
                    onChange={(e) => setAdjustForm({ ...adjustForm, quantity: e.target.value })}
                  />
                </div>

                <div className="form-field full-width">
                  <span>Reason / Note</span>
                  <input
                    type="text"
                    value={adjustForm.reason}
                    onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
                  />
                </div>

                <div className="form-field full-width">
                  <span>Reference (PO No. / DC No. / Bill No.)</span>
                  <input
                    type="text"
                    placeholder="Optional reference doc number"
                    value={adjustForm.reference}
                    onChange={(e) => setAdjustForm({ ...adjustForm, reference: e.target.value })}
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

      {/* ============ ISSUE TO EMPLOYEE MODAL ============ */}
      {showIssueModal && (
        <div className="template-modal-backdrop">
          <div className="template-modal" style={{ width: 'min(520px, 95vw)' }}>
            <div className="template-modal-header">
              <h3>Issue Material to Employee</h3>
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setShowIssueModal(false)}
              >
                ✕ Close
              </button>
            </div>

            <form onSubmit={handleSaveIssue}>
              {issueError && <div className="form-error">{issueError}</div>}
              <div className="form-grid" style={{ gap: '14px' }}>
                <div className="form-field full-width">
                  <span>Item *</span>
                  <select
                    required
                    value={issueForm.itemId}
                    onChange={(e) => {
                      setIssueError('');
                      setIssueForm({ ...issueForm, itemId: e.target.value });
                    }}
                  >
                    <option value="">Select an item...</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.itemName} (In Stock: {it.currentQty} {it.unit})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <span>Quantity *</span>
                  <input
                    type="number"
                    min="1"
                    required
                    value={issueForm.quantity}
                    onChange={(e) => {
                      setIssueError('');
                      setIssueForm({ ...issueForm, quantity: e.target.value });
                    }}
                  />
                </div>
                <div className="form-field">
                  <span>Date</span>
                  <input
                    type="date"
                    value={issueForm.date}
                    onChange={(e) => setIssueForm({ ...issueForm, date: e.target.value })}
                  />
                </div>
                <div className="form-field full-width">
                  <span>Employee Name *</span>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ramesh Kumar"
                    value={issueForm.employeeName}
                    onChange={(e) => {
                      setIssueError('');
                      setIssueForm({ ...issueForm, employeeName: e.target.value });
                    }}
                  />
                </div>
                <div className="form-field full-width">
                  <span>Notes (Optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. For machine A-02 setup"
                    value={issueForm.notes}
                    onChange={(e) => setIssueForm({ ...issueForm, notes: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-actions" style={{ marginTop: '20px' }}>
                <button type="button" className="button-secondary" onClick={() => setShowIssueModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="button-primary">
                  Confirm Issue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {itemToDeleteId && (
        <div className="template-modal-backdrop">
          <div
            className="template-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-store-item-title"
            style={{ width: 'min(440px, 95vw)' }}
          >
            <div className="template-modal-header">
              <h3 id="delete-store-item-title">Delete Store Item?</h3>
            </div>
            <p style={{ margin: '16px 0', color: '#4b5563', lineHeight: '1.6' }}>
              Are you sure you want to delete this item? This action cannot be undone.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => setItemToDeleteId(null)}
                disabled={isDeletingItem}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button-primary"
                onClick={handleConfirmDeleteItem}
                disabled={isDeletingItem}
                style={{ background: '#b91c1c', borderColor: '#b91c1c' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorePage;
