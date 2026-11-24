import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { getCurrentUserInfo, hasPermission, normalizeDepartment } from '../utils/permissions.js';
import { getStoredAuth } from '../utils/auth.js';
import { getNotifications } from '../utils/storeService.js';
import { openWorkflowDocument } from '../utils/workflowFiles.js';
import { INDENT_STATUS } from '../utils/workflowService.js';
import { convertToINR } from '../utils/currency.js';
import NotificationsPanel from '../components/NotificationsPanel.jsx';

const getEmployeeCount = () => {
  try {
    const raw = localStorage.getItem('employees');
    if (!raw) return 0;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((e) => e.active !== false).length : 0;
  } catch {
    return 0;
  }
};

const DashboardPage = () => {
  const navigate = useNavigate();
  const [showActiveQuotations, setShowActiveQuotations] = useState(false);

  const [quotations, setQuotations] = useState([]);
  const [customerPOs, setCustomerPOs] = useState([]);
  const [salesOrders, setSalesOrders] = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [supplierPOs, setSupplierPOs] = useState([]);
  const [supplierInvoices, setSupplierInvoices] = useState([]);
  const [deliveryChallans, setDeliveryChallans] = useState([]);
  const [customerInvoices, setCustomerInvoices] = useState([]);
  const [materialRequests, setMaterialRequests] = useState([]);
  const [storeIssues, setStoreIssues] = useState([]);
  const [materialReturns, setMaterialReturns] = useState([]);
  const [stockTransactions, setStockTransactions] = useState([]);
  const [purchaseIndents, setPurchaseIndents] = useState([]);

  // Load all module data from localStorage
  useEffect(() => {
    try {
      const q = localStorage.getItem('quotationHistory');
      if (q) setQuotations(JSON.parse(q));

      const cpo = localStorage.getItem('customerPOHistory');
      if (cpo) setCustomerPOs(JSON.parse(cpo));

      const so = localStorage.getItem('salesOrderHistory');
      if (so) setSalesOrders(JSON.parse(so));

      const inv = localStorage.getItem('inventoryItems');
      if (inv) setInventoryItems(JSON.parse(inv));

      const spo = localStorage.getItem('supplierPOHistory');
      if (spo) setSupplierPOs(JSON.parse(spo));

      const sinv = localStorage.getItem('supplierInvoiceHistory');
      if (sinv) setSupplierInvoices(JSON.parse(sinv));

      const dc = localStorage.getItem('deliveryChallanHistory');
      if (dc) setDeliveryChallans(JSON.parse(dc));

      const cinv = localStorage.getItem('customerInvoiceHistory');
      if (cinv) setCustomerInvoices(JSON.parse(cinv));

      const mrs = localStorage.getItem('materialRequests');
      if (mrs) setMaterialRequests(JSON.parse(mrs));

      const sis = localStorage.getItem('storeIssueHistory');
      if (sis) setStoreIssues(JSON.parse(sis));

      const mrsRet = localStorage.getItem('materialReturnHistory');
      if (mrsRet) setMaterialReturns(JSON.parse(mrsRet));

      const stx = localStorage.getItem('stockTransactions');
      if (stx) setStockTransactions(JSON.parse(stx));

      const pins = localStorage.getItem('purchaseIndents');
      if (pins) setPurchaseIndents(JSON.parse(pins));
    } catch (err) {
      console.warn('Error loading dashboard stats', err);
    }
  }, []);

  // Aggregated Financial & Operational KPIs
  const kpis = useMemo(() => {
    // Convert a document payload total to INR so foreign currency rows never inflate the KPIs
    const payloadINR = (payload) => {
      const grandTotal = Number(payload?.totals?.grandTotal) || 0;
      const stored = Number(payload?.amountINR);
      if (Number.isFinite(stored) && stored > 0) return stored;
      const currency =
        payload?.invoiceDetails?.currency ||
        payload?.quotationDetails?.currency ||
        payload?.soDetails?.currency ||
        payload?.poDetails?.currency ||
        'INR';
      if (currency === 'INR') return grandTotal;
      const rate =
        payload?.invoiceDetails?.exchangeRate ??
        payload?.quotationDetails?.exchangeRate ??
        payload?.soDetails?.exchangeRate ??
        payload?.poDetails?.exchangeRate;
      return convertToINR(grandTotal, currency, rate);
    };

    // 1. Sales & Invoicing
    let totalInvoicedRevenue = 0;
    let customerPendingDues = 0;
    customerInvoices.forEach((inv) => {
      const total = payloadINR(inv.payload);
      totalInvoicedRevenue += total;
      if (inv.status !== 'Paid') {
        customerPendingDues += total;
      }
    });

    // 2. Active Quotations Value
    let activeQuotationValue = 0;
    quotations.forEach((q) => {
      activeQuotationValue += payloadINR(q.payload);
    });

    // 3. Sales Orders in Progress
    const inProgressOrders = salesOrders.filter((s) => s.status !== 'Closed').length;

    // 4. Inventory Assets & Reorder alerts
    let totalInventoryValue = 0;
    let lowStockCount = 0;
    inventoryItems.forEach((it) => {
      const cur = Number(it.currentQty) || 0;
      const cost = Number(it.unitCost) || 0;
      const minLvl = Number(it.minReorderLevel) || 0;
      totalInventoryValue += cur * cost;
      if (cur <= minLvl) lowStockCount++;
    });

    // 5. Procurement & Accounts Payable
    let totalPurchases = 0;
    let accountsPayable = 0;
    supplierInvoices.forEach((sinv) => {
      const total = Number(sinv.payload?.totals?.grandTotal) || 0;
      const paid = Number(sinv.payload?.invoiceDetails?.amountPaid) || (sinv.status === 'Paid' ? total : 0);
      totalPurchases += total;
      if (sinv.status !== 'Paid') {
        accountsPayable += Math.max(0, total - paid);
      }
    });

    return {
      totalInvoicedRevenue,
      customerPendingDues,
      activeQuotationValue,
      totalQuotations: quotations.length,
      inProgressOrders,
      totalSalesOrders: salesOrders.length,
      totalInventoryValue,
      lowStockCount,
      totalPurchases,
      accountsPayable,
      totalDispatches: deliveryChallans.length
    };
  }, [quotations, customerInvoices, salesOrders, inventoryItems, supplierInvoices, deliveryChallans]);

  // Store & Materials Control KPIs (Material Requests / Issues / Returns)
  const storeKPIs = useMemo(() => {
    const pending = materialRequests.filter((m) => m.status === 'Pending Store' || m.status === 'Submitted').length;
    const partial = materialRequests.filter((m) => m.status === 'Partially Issued').length;
    const today = new Date().toISOString().slice(0, 10);
    const issuesToday = storeIssues.filter((i) => i.issueDate === today).length;
    const returnsToday = materialReturns.filter((r) => r.returnDate === today).length;
    const totalIssuedTodayUnits = stockTransactions
      .filter((t) => t.type === 'OUT' && t.transactionNumber && t.date === today)
      .reduce((a, t) => a + (Number(t.quantity) || 0), 0);
    return { pending, partial, issuesToday, returnsToday, totalIssuedTodayUnits };
  }, [materialRequests, storeIssues, materialReturns, stockTransactions]);

  // Critical Low Stock Watchlist
  const lowStockItems = useMemo(() => {
    return inventoryItems
      .filter((it) => (Number(it.currentQty) || 0) <= (Number(it.minReorderLevel) || 0))
      .slice(0, 5);
  }, [inventoryItems]);

  // Recent Activity Pipeline (Latest 5 quotations / orders)
  const recentOrders = useMemo(() => {
    const list = [];
    salesOrders.forEach((so) => {
      list.push({
        type: 'Sales Order',
        reference: so.reference,
        party: so.company,
        date: so.date,
        amount: so.total,
        status: so.status,
        path: '/sales-order'
      });
    });
    quotations.forEach((q) => {
      list.push({
        type: 'Quotation',
        reference: q.reference,
        party: q.company,
        date: q.date,
        amount: q.total,
        status: q.balanceStatus || 'Active',
        path: '/quotation'
      });
    });
    return list.slice(0, 6);
  }, [salesOrders, quotations]);

  /* ============================ STORE DASHBOARD ============================ */

  const storeViewUser = getCurrentUserInfo();
  const isStoreUser = storeViewUser.employee?.department === 'Store Department';

  const storeToday = new Date().toISOString().slice(0, 10);

  const storeMrStats = useMemo(() => {
    return {
      new: materialRequests.filter((m) => m.status === 'Submitted').length,
      pending: materialRequests.filter((m) => m.status === 'Pending Store').length,
      partial: materialRequests.filter((m) => m.status === 'Partially Issued').length,
      full: materialRequests.filter((m) => m.status === 'Fully Issued').length
    };
  }, [materialRequests]);

  const STORE_MR_STATUSES = ['Submitted', 'Pending Store', 'Partially Issued', 'Fully Issued'];
  const storeMrList = useMemo(() => {
    const rank = { 'Submitted': 0, 'Pending Store': 1, 'Partially Issued': 2, 'Fully Issued': 3 };
    return materialRequests
      .filter((m) => STORE_MR_STATUSES.includes(m.status))
      .sort(
        (a, b) =>
          (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
          String(b.requestDate || '').localeCompare(String(a.requestDate || ''))
      )
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialRequests]);

  const storeInventoryStats = useMemo(() => {
    const totalQty = inventoryItems.reduce((a, it) => a + (Number(it.currentQty) || 0), 0);
    const reserved = inventoryItems.reduce((a, it) => a + (Number(it.reservedQty) || 0), 0);
    const lowStock = inventoryItems.filter(
      (it) => (Number(it.currentQty) || 0) <= (Number(it.minReorderLevel) || 0) && (Number(it.currentQty) || 0) > 0
    );
    const outOfStock = inventoryItems.filter((it) => (Number(it.currentQty) || 0) <= 0);
    const incomingPOs = supplierPOs.filter((po) => po.status === 'Issued' || po.status === 'In Transit');
    const dayPrefix = storeToday;
    const todayTx = stockTransactions.filter((t) => String(t.date || t.dateTime || '').slice(0, 10) === dayPrefix);
    const stockInToday = todayTx
      .filter((t) => t.type === 'IN')
      .reduce((a, t) => a + (Number(t.quantity) || 0), 0);
    const stockOutToday = todayTx
      .filter((t) => t.type === 'OUT')
      .reduce((a, t) => a + (Number(t.quantity) || 0), 0);
    return {
      totalMaterials: inventoryItems.length,
      availableQty: Math.max(0, totalQty - reserved),
      availableText: totalQty - reserved,
      lowStock,
      outOfStockCount: outOfStock.length,
      issuesToday: storeIssues.filter((i) => i.issueDate === storeToday).length,
      returnsToday: materialReturns.filter((r) => r.returnDate === storeToday).length,
      incomingPOs,
      stockInToday,
      stockOutToday,
      recentStock: [...inventoryItems].sort((a, b) => (Number(b.currentQty) || 0) - (Number(a.currentQty) || 0)).slice(0, 5)
    };
  }, [inventoryItems, storeIssues, materialReturns, supplierPOs, stockTransactions, storeToday]);

  const storeRecentTx = useMemo(() => {
    return stockTransactions
      .filter((t) => t.transactionNumber && t.itemName)
      .sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || '')))
      .slice(0, 6);
  }, [stockTransactions]);

  const [storeSeen, setStoreSeen] = useState(() => {
    try {
      const raw = localStorage.getItem('storeDashboardSeen');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  /* Notifications published for the Store Department (for example the Purchase
     Order PDF the Purchase Department just sent) — these are shown at the top
     of the Store dashboard's notification block. */
  const storePushedNotifications = useMemo(() => {
    try {
      return getNotifications()
        .filter((n) => n.docId || normalizeDepartment(n.targetDept || '') === 'Store Department')
        .slice(0, 5);
    } catch {
      return [];
    }
  }, []);

  const storeNotifications = useMemo(() => {
    const list = [];
    materialRequests
      .filter((m) => m.status === 'Submitted' || m.status === 'Pending Store')
      .slice(0, 3)
      .forEach((m) => {
        list.push({
          key: `mr:${m.mrNumber}`,
          type: 'mr',
          title: 'New Material Request',
          text: `${m.mrNumber} — ${m.partName || 'Material'} | Requested by ${m.requestedBy || '-'} (${m.requestedByEmpId || '-'})`,
          reference: m.mrNumber
        });
      });
    supplierPOs
      .filter((po) => !['Received', 'Fully Received', 'Closed', 'Cancelled'].includes(po.status))
      .slice(0, 4)
      .forEach((po) => {
        const line = po.payload?.items?.[0] || {};
        const incoming = po.status === 'In Transit' || po.status === 'Partially Received';
        list.push({
          key: `po:${po.reference}`,
          type: 'po',
          title: incoming
            ? 'Incoming Material – record the delivery'
            : 'New Purchase Order – Store must record the delivery',
          text: `${po.reference} | ${po.vendor || '-'} | ${line.itemName || 'Materials'} | Qty ${line.quantity || 0} ${line.unit || ''} | ${po.status}`,
          reference: po.reference
        });
      });
    inventoryItems
      .filter((it) => (Number(it.currentQty) || 0) <= (Number(it.minReorderLevel) || 0))
      .slice(0, 3)
      .forEach((it) => {
        list.push({
          key: `low:${it.itemCode}`,
          type: 'lowstock',
          title: 'Low Stock Alert',
          text: `${it.itemName} — current ${it.currentQty} ${it.unit || 'Nos'}, min ${it.minReorderLevel}`,
          reference: it.itemCode
        });
      });
    [...materialReturns]
      .sort((a, b) => String(b.returnDate || '').localeCompare(String(a.returnDate || '')))
      .slice(0, 3)
      .forEach((r) => {
        list.push({
          key: `return:${r.returnNumber}`,
          type: 'return',
          title: 'Material Return',
          text: `${r.returnNumber} — ${r.partName || 'Material'} returned by ${r.returnedBy || '-'}`,
          reference: r.returnNumber
        });
      });
    purchaseIndents
      .filter(
        (i) =>
          i.status === INDENT_STATUS.SUBMITTED && !i.adminApprovedAt
      )
      .slice(0, 3)
      .forEach((i) => {
        list.push({
          key: `indent:${i.indentNumber}`,
          type: 'indent',
          title: 'Purchase Indent shared with Admin',
          text: `${i.indentNumber} — ${i.projectId || i.soNumber || '-'} | Shared by ${i.createdBy || 'Store'} | Awaiting Admin approval`,
          reference: i.indentNumber
        });
      });
    const pushed = storePushedNotifications.map((n) => ({
      key: `notif:${n.id}`,
      type: n.docId ? 'document' : 'push',
      title: n.title,
      text: n.message,
      reference: n.reference,
      link: n.link,
      docId: n.docId,
      docName: n.docName
    }));
    return [...pushed, ...list].slice(0, 8 + pushed.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialRequests, supplierPOs, inventoryItems, materialReturns, purchaseIndents, storePushedNotifications]);

  const storeUnreadCount = storeNotifications.filter((n) => !storeSeen.includes(n.key)).length;

  const markNotificationSeen = (key) => {
    const next = [...new Set([...storeSeen, key])];
    setStoreSeen(next);
    localStorage.setItem('storeDashboardSeen', JSON.stringify(next));
  };

  const markAllStoreSeen = () => {
    const next = [...new Set([...storeSeen, ...storeNotifications.map((n) => n.key)])];
    setStoreSeen(next);
    localStorage.setItem('storeDashboardSeen', JSON.stringify(next));
  };

  const openStoreNotification = (n) => {
    markNotificationSeen(n.key);
    /* a notification that carries a document (the PO PDF sent by Purchase)
       opens that file; nothing else leaves the dashboard unexplained */
    if (n.docId) {
      openWorkflowDocument({ id: n.docId, name: n.docName, kind: 'Purchase Order' });
      return;
    }
    if (n.type === 'push' && n.link) {
      navigate(n.link);
      return;
    }
    if (n.type === 'po') {
      navigate(`/material-receipts?po=${encodeURIComponent(n.reference)}`);
    } else if (n.type === 'mr') {
      navigate('/store/material-requests');
    } else if (n.type === 'indent') {
      navigate('/purchase-indents', { state: { openIndent: n.reference } });
    } else if (n.type === 'return') {
      navigate('/store/returns');
    } else {
      navigate('/inventory');
    }
  };

  const storeQuickActions = [
    { label: 'Stock Overview', path: '/store/inventory' },
    { label: 'Inventory Transactions', path: '/store/transactions' },
    { label: 'Material Requests', path: '/store/material-requests' },
    { label: 'Store Issues', path: '/store/issues' },
    { label: 'Material Returns', path: '/store/returns' }
  ];

  // Purchase Indents shared by Store that still need the Admin's approval.
  const canApproveIndent = hasPermission('indent.admin_approve');
  const indentsAwaitingApproval = useMemo(() => {
    const list = Array.isArray(purchaseIndents) ? purchaseIndents : [];
    return list.filter(
      (i) =>
        !i.adminApprovedAt &&
        [
          INDENT_STATUS.SUBMITTED,
          INDENT_STATUS.UNDER_REVIEW,
          INDENT_STATUS.AWAITING_PRODUCTION,
          INDENT_STATUS.PENDING_PURCHASE_ENQUIRY
        ].includes(i.status)
    );
  }, [purchaseIndents]);

  // Materials that need re-ordering: available (net of reserved) at or below the reorder/min level
  const requiredToOrder = useMemo(() => {
    return inventoryItems
      .map((it) => {
        const qty = Number(it.currentQty) || 0;
        const res = Number(it.reservedQty) || 0;
        const effMin = Number(it.reorderLevel || it.minReorderLevel) || 0;
        const avail = Math.max(0, qty - res);
        return { ...it, effMin, available: avail };
      })
      .filter((it) => it.available <= it.effMin)
      .sort((a, b) => (a.available - a.effMin) - (b.available - b.effMin));
  }, [inventoryItems]);

  if (isStoreUser) {
    const storeUserName = storeViewUser.employee?.name || getStoredAuth()?.username || 'Store User';

    return (
      <div className="page-section">
        <div className="page-header">
          <div>
            <p className="eyebrow">Stores & Materials Control</p>
            <h1>Store Dashboard</h1>
            <p className="page-description">Welcome, {storeUserName}. Live store operations, inventory, and material movement at a glance.</p>
          </div>
          <div className="header-actions no-print">
            <NotificationsPanel />
            <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          </div>
        </div>

        {/* ---------- Notification Area ---------- */}
        <div className="content-block" style={{ marginBottom: '24px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">
              <span aria-hidden="true" style={{ marginRight: '6px' }}>🔔</span> Notifications
              <span
                style={{
                  display: storeUnreadCount > 0 ? 'inline-flex' : 'none',
                  marginLeft: '10px',
                  minWidth: '22px',
                  height: '22px',
                  padding: '0 7px',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '999px',
                  background: '#dc2626',
                  color: '#ffffff',
                  fontSize: '12px',
                  fontWeight: '700'
                }}
              >
                {storeUnreadCount}
              </span>
              {storeUnreadCount > 0 && (
                <span style={{ marginLeft: '10px', fontSize: '12.5px', color: '#64748b' }}>unread</span>
              )}
            </h3>
            {storeNotifications.length > 0 && (
              <button className="button-small" onClick={markAllStoreSeen} disabled={storeUnreadCount === 0}>
                Mark all as read
              </button>
            )}
          </div>

          {storeNotifications.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 12px' }}>
              <h3>No current store alerts</h3>
              <p>New material requests, purchase orders, and low stock alerts will appear here.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {storeNotifications.map((n) => {
                const unread = !storeSeen.includes(n.key);
                return (
                  <button
                    key={n.key}
                    type="button"
                    onClick={() => openStoreNotification(n)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      textAlign: 'left',
                      border: '1px solid ' + (unread ? '#bfdbfe' : '#e5e7eb'),
                      background: unread ? '#eff6ff' : '#f8fafc',
                      borderRadius: '10px',
                      padding: '10px 14px',
                      cursor: 'pointer',
                      width: '100%'
                    }}
                  >
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: unread ? '#2563eb' : 'transparent',
                        flexShrink: 0
                      }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <span style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>
                        {n.docId && <span aria-hidden="true" style={{ marginRight: '5px' }}>&#128196;</span>}
                        {n.title}
                      </span>
                      <span style={{ fontSize: '12.5px', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {n.text}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ---------- Store Operations KPIs ---------- */}
        <div className="kpi-grid" style={{ marginBottom: '24px' }}>
          <div className="kpi-card">
            <span className="kpi-title">New Material Requests</span>
            <div className="kpi-value" style={{ color: storeMrStats.new > 0 ? '#b45309' : '#166534' }}>
              {storeMrStats.new} Requests
            </div>
            <span className="kpi-delta negative">Submitted to Store</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Pending Requests</span>
            <div className="kpi-value" style={{ color: storeMrStats.pending > 0 ? '#b45309' : '#166534' }}>
              {storeMrStats.pending} Requests
            </div>
            <span className="kpi-delta neutral">Awaiting store action</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Partially Issued</span>
            <div className="kpi-value">{storeMrStats.partial} Requests</div>
            <span className="kpi-delta neutral">Some material lines pending</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-title">Fully Issued</span>
            <div className="kpi-value" style={{ color: '#166534' }}>{storeMrStats.full} Requests</div>
            <span className="kpi-delta positive">All material delivered</span>
          </div>
        </div>

        {/* ---------- Store Operations Quick Access ---------- */}
        <div className="content-block" style={{ marginBottom: '22px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">Store Operations</h3>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
            {storeQuickActions.map((a) => (
              <button
                key={a.label}
                className="button-secondary"
                style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
                onClick={() => navigate(a.path)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* ---------- Inventory Section ---------- */}
        <div className="content-block" style={{ marginBottom: '22px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">Inventory</h3>
            <span className="muted-text" style={{ marginRight: '10px' }}>Store-controlled stock from the existing inventory master</span>
            {hasPermission('inventory.adjust') ? (
              <button className="button-small" onClick={() => navigate('/store/inventory')}>Manage Stock</button>
            ) : (
              <button className="button-small" onClick={() => navigate('/store/transactions')}>View Transactions</button>
            )}
          </div>
          <div className="kpi-grid" style={{ marginBottom: '16px' }}>
            <div className="kpi-card">
              <span className="kpi-title">Total Materials</span>
              <div className="kpi-value">{storeInventoryStats.totalMaterials} Items</div>
              <span className="kpi-delta positive">{storeInventoryStats.availableQty} units available (net of reserved)</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/inventory')}>
              <span className="kpi-title">Low Stock</span>
              <div className="kpi-value" style={{ color: storeInventoryStats.lowStock.length > 0 ? '#b91c1c' : '#166534' }}>
                {storeInventoryStats.lowStock.length} Items
              </div>
              <span className="kpi-delta negative">Below minimum reorder level</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/inventory')}>
              <span className="kpi-title">Out of Stock</span>
              <div className="kpi-value" style={{ color: storeInventoryStats.outOfStockCount > 0 ? '#b91c1c' : '#166534' }}>
                {storeInventoryStats.outOfStockCount} Items
              </div>
              <span className="kpi-delta negative">Zero balance</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/issues')}>
              <span className="kpi-title">Store Issues Today</span>
              <div className="kpi-value">{storeInventoryStats.issuesToday} Slips</div>
              <span className="kpi-delta neutral">Material issued to production</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/returns')}>
              <span className="kpi-title">Material Returns Today</span>
              <div className="kpi-value">{storeInventoryStats.returnsToday} Returns</div>
              <span className="kpi-delta positive">Returned to stock</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/transactions')}>
              <span className="kpi-title">Stock In Today</span>
              <div className="kpi-value" style={{ color: '#166534' }}>+{storeInventoryStats.stockInToday} Units</div>
              <span className="kpi-delta positive">Inward / receipts / returns</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/transactions')}>
              <span className="kpi-title">Stock Out Today</span>
              <div className="kpi-value" style={{ color: '#b91c1c' }}>-{storeInventoryStats.stockOutToday} Units</div>
              <span className="kpi-delta negative">Issues / consumption</span>
            </div>
            <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/purchase-order')}>
              <span className="kpi-title">Incoming Purchase Orders</span>
              <div className="kpi-value" style={{ color: storeInventoryStats.incomingPOs.length > 0 ? '#b45309' : '#166534' }}>
                {storeInventoryStats.incomingPOs.length} POs
              </div>
              <span className="kpi-delta neutral">Issued / In Transit</span>
            </div>
          </div>

          {storeInventoryStats.recentStock.length > 0 && (
            <div>
              <p style={{ margin: '0 0 10px', fontSize: '13px', fontWeight: '700', color: '#334155' }}>Recent Stock</p>
              <div className="history-table-wrapper">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>SL.No</th>
                      <th>Item</th>
                      <th>In Stock</th>
                      <th>Available</th>
                      <th>Min Level</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storeInventoryStats.recentStock.map((it, idx) => {
                      const qty = Number(it.currentQty) || 0;
                      const res = Number(it.reservedQty) || 0;
                      const avail = Math.max(0, qty - res);
                      const min = Number(it.minReorderLevel) || 0;
                      return (
                        <tr key={it.itemCode || it.id}>
                          <td>{idx + 1}</td>
                          <td><strong>{it.itemName || it.itemCode}</strong></td>
                          <td>{qty} {it.unit || 'Nos'}</td>
                          <td style={{ fontWeight: '700', color: avail > 0 ? '#166534' : '#dc2626' }}>{avail} {it.unit || 'Nos'}</td>
                          <td>{min}</td>
                          <td>
                            <span className={qty <= min ? 'status-badge st-partially-issued' : 'status-badge st-fully-issued'}>
                              {qty <= 0 ? 'Out of Stock' : qty <= min ? 'Low Stock' : 'In Stock'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ---------- Low Stock / Required to Order ---------- */}
        <div className="content-block" style={{ marginBottom: '22px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">Required to Order / Low Stock</h3>
            <span className="count-badge">{requiredToOrder.length} need ordering</span>
          </div>
          {requiredToOrder.length === 0 ? (
            <p className="muted-text" style={{ margin: 0 }}>All materials are above their Minimum Stock / Reorder levels.</p>
          ) : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Item</th>
                    <th>In Stock</th>
                    <th>Available</th>
                    <th>Min / Reorder</th>
                    <th>Required to Order</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {requiredToOrder.slice(0, 10).map((it, idx) => {
                    const qty = Number(it.currentQty) || 0;
                    const effMin = it.effMin;
                    const available = it.available;
                    return (
                      <tr key={it.itemCode || it.id}>
                        <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                        <td><strong>{it.itemName || it.itemCode}</strong></td>
                        <td>{qty} {it.unit || 'Nos'}</td>
                        <td style={{ fontWeight: '700', color: available > 0 ? '#b45309' : '#dc2626' }}>
                          {available} {it.unit || 'Nos'}
                        </td>
                        <td>{effMin} {it.unit || 'Nos'}</td>
                        <td style={{ color: '#b91c1c', fontWeight: '700' }}>
                          {Math.max(0, effMin - available)} {it.unit || 'Nos'}
                        </td>
                        <td>
                          {hasPermission('inventory.adjust') ? (
                            <button className="button-small" onClick={() => navigate('/store/inventory')}>Manage Stock</button>
                          ) : (
                            <button className="button-small" onClick={() => navigate('/store/material-requests')}>Raise MR</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------- Recent Material Requests ---------- */}
        <div className="content-block" style={{ marginBottom: '22px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">Recent Material Requests</h3>
            <span className="count-badge">New: {storeMrStats.new}</span>
            <span className="count-badge" style={{ marginLeft: '6px' }}>Approved-Awaiting Issue: {storeMrStats.pending}</span>
            <span className="count-badge" style={{ marginLeft: '6px' }}>Completed: {storeMrStats.full}</span>
            <button className="button-small" onClick={() => navigate('/store/material-requests')} style={{ marginRight: '10px' }}>Open MR Queue</button>
          </div>
          {storeMrList.length === 0 ? (
            <p className="muted-text" style={{ margin: 0 }}>No material requests currently waiting at the store. Requests submitted by Production will appear here.</p>
          ) : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>MR Number</th>
                    <th>Project ID</th>
                    <th>Job Card</th>
                    <th>Requested By</th>
                    <th>Employee ID</th>
                    <th>Request Date</th>
                    <th>Status</th>
                    <th>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {storeMrList.map((mr) => (
                    <tr key={mr.mrNumber} style={{ cursor: 'pointer' }} onClick={() => navigate('/store/material-requests')}>
                      <td><strong>{mr.mrNumber}</strong></td>
                      <td>
                        {mr.projectId ? (
                          <span style={{ color: '#3730a3', fontWeight: '700' }}>{mr.projectId}</span>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>-</span>
                        )}
                      </td>
                      <td>{mr.jobCardNumber || '-'}</td>
                      <td>{mr.requestedBy || '-'}</td>
                      <td>{mr.requestedByEmpId || '-'}</td>
                      <td>{mr.requestDate || '-'}</td>
                      <td>
                        <span className={`status-badge st-${(mr.status || '').toLowerCase().replace(/\s+/g, '-')}`}>
                          {mr.status}
                        </span>
                      </td>
                      <td>
                        {mr.priority === 'Urgent' ? (
                          <span style={{ color: '#b91c1c', fontWeight: '700' }}>Urgent</span>
                        ) : mr.priority ? (
                          mr.priority
                        ) : (
                          <span style={{ color: '#94a3b8' }}>-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------- Incoming Purchase Orders ---------- */}
        <div className="content-block" style={{ marginBottom: '22px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">Incoming Purchase Orders</h3>
            <span className="count-badge">{storeInventoryStats.incomingPOs.length} open PO(s)</span>
          </div>
          {storeInventoryStats.incomingPOs.length === 0 ? (
            <p className="muted-text" style={{ margin: 0 }}>No purchase orders are currently expected. Issued and in-transit POs will appear here.</p>
          ) : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>PO Number</th>
                    <th>Supplier</th>
                    <th>Material</th>
                    <th>Quantity</th>
                    <th>Due Date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {storeInventoryStats.incomingPOs.slice(0, 8).map((po) => {
                    const items = (po.payload && po.payload.items) || [];
                    return items.length > 0 ? (
                      items.map((it, i) => (
                        <tr key={`${po.reference}-${it.itemCode || it.itemName || i}`}>
                          <td><strong>{po.reference}</strong></td>
                          <td>{po.vendor || '-'}</td>
                          <td>{it.itemName || '-'}</td>
                          <td>{it.quantity || 0} {it.unit || 'Nos'}</td>
                          <td>{po.dueDate || '-'}</td>
                          <td><span className="status-badge st-issued">{po.status}</span></td>
                        </tr>
                      ))
                    ) : (
                      <tr key={po.reference}>
                        <td><strong>{po.reference}</strong></td>
                        <td>{po.vendor || '-'}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>{po.dueDate || '-'}</td>
                        <td><span className="status-badge st-issued">{po.status}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---------- Recent Inventory Transactions ---------- */}
        <div className="content-block">
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h3 className="block-title">Recent Stock In / Stock Out</h3>
            <button className="button-small" onClick={() => navigate('/store/transactions')}>View All</button>
          </div>
          {storeRecentTx.length === 0 ? (
            <p className="muted-text" style={{ margin: 0 }}>No store transactions recorded yet.</p>
          ) : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Type</th>
                    <th>Material</th>
                    <th>Movement</th>
                    <th>Project</th>
                  </tr>
                </thead>
                <tbody>
                  {storeRecentTx.map((t, i) => {
                    const ref = t.transactionNumber || t.reference || '-';
                    const isImport = t.type === 'IN';
                    const isReturn = String(t.reason || '').toLowerCase().includes('return') || /^SR-/.test(ref);
                    const itemName = t.itemName || t.itemCode || '-';
                    return (
                      <tr key={`tx-${t.id || i}`} style={{ cursor: 'pointer' }} onClick={() => navigate('/store/transactions')}>
                        <td><strong>{ref}</strong></td>
                        <td>
                          <span className={`status-badge ${isReturn ? 'st-submitted' : isImport ? 'st-fully-issued' : 'st-cancelled'}`}>
                            {isReturn ? 'Material Return' : isImport ? 'Material Issue' : t.reason || 'Stock Move'}
                          </span>
                        </td>
                        <td>{itemName}</td>
                        <td style={{ color: isImport ? '#166534' : '#b91c1c', fontWeight: '700' }}>
                          {isImport ? `+${t.quantity}` : `-${t.quantity}`} {t.unit || 'Nos'}
                        </td>
                        <td>{t.projectId || <span style={{ color: '#94a3b8' }}>-</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">Enterprise Overview & Control Center</p>
          <h1>Executive Dashboard</h1>
          <p className="page-description">
            Real-time business performance, manufacturing pipeline, inventory valuation, and cash flow summary.
          </p>
        </div>
        <div className="header-actions no-print">
          <NotificationsPanel />
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
        </div>
      </div>

      {/* Purchase Indents shared by Store — awaiting the Admin's approval */}
      {canApproveIndent && (
        <div className="content-block" style={{ marginBottom: '24px' }}>
          <div className="block-header" style={{ marginBottom: '12px' }}>
            <h2>Purchase Indents awaiting your approval</h2>
            <span className="count-badge">{indentsAwaitingApproval.length} Pending</span>
          </div>
          {indentsAwaitingApproval.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '13px' }}>
              No Purchase Indents are waiting for your approval.
            </p>
          ) : (
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Indent No</th>
                    <th>Date</th>
                    <th>Sales Order</th>
                    <th>Project ID</th>
                    <th>Customer</th>
                    <th>Materials</th>
                    <th>Shared By</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {indentsAwaitingApproval.map((i) => (
                    <tr key={i.indentNumber}>
                      <td><strong>{i.indentNumber}</strong></td>
                      <td>{i.indentDate}</td>
                      <td>{i.soNumber || '—'}</td>
                      <td>{i.projectId || '—'}</td>
                      <td>{i.customer || '—'}</td>
                      <td>{(i.items || []).length}</td>
                      <td>{i.createdBy || '—'}{i.createdByDept ? ` (${i.createdByDept})` : ''}</td>
                      <td>
                        <button
                          className="button-primary button-small"
                          onClick={() => navigate('/purchase-indents', { state: { openIndent: i.indentNumber } })}
                        >
                          Open &amp; Approve
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Main KPI Grid */}
      <div className="kpi-grid" style={{ marginBottom: '24px' }}>
        <div className="kpi-card">
          <span className="kpi-title">Total Invoiced Sales</span>
          <div className="kpi-value" style={{ color: '#166534' }}>
            ₹ {kpis.totalInvoicedRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
          <span className="kpi-delta positive">{customerInvoices.length} Tax Invoices Billed</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">Accounts Receivable (Pending)</span>
          <div className="kpi-value" style={{ color: kpis.customerPendingDues > 0 ? '#b91c1c' : '#166534' }}>
            ₹ {kpis.customerPendingDues.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
          <span className="kpi-delta neutral">Unsettled customer payments</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">Active Orders in Progress</span>
          <div className="kpi-value" style={{ color: '#2563eb' }}>
            {kpis.inProgressOrders} Orders
          </div>
          <span className="kpi-delta positive">{kpis.totalSalesOrders} Total Confirmed Orders</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">Inventory Valuation</span>
          <div className="kpi-value">
            ₹ {kpis.totalInventoryValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
          <span className="kpi-delta positive">{inventoryItems.length} Materials & Assemblies</span>
        </div>
      </div>

      {/* Secondary Financial & Operational Overview */}
      <div className="kpi-grid" style={{ marginBottom: '28px' }}>
        <div className="kpi-card" style={{ cursor: 'pointer', border: showActiveQuotations ? '2px solid #2563eb' : 'none', background: showActiveQuotations ? '#eff6ff' : '#fff' }} onClick={() => setShowActiveQuotations(!showActiveQuotations)}>
            <span className="kpi-title">Quotations Pipeline Value</span>
          <div className="kpi-value">
            ₹ {kpis.activeQuotationValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
          <span className="kpi-delta neutral">{kpis.totalQuotations} Active Quotations</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">Accounts Payable (Vendor Dues)</span>
          <div className="kpi-value" style={{ color: kpis.accountsPayable > 0 ? '#b91c1c' : '#166534' }}>
            ₹ {kpis.accountsPayable.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
          <span className="kpi-delta negative">Due to material suppliers</span>
        </div>

        <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/inventory')}>
            <span className="kpi-title">Low Stock Alerts</span>
          <div className="kpi-value" style={{ color: kpis.lowStockCount > 0 ? '#b91c1c' : '#166534' }}>
            {kpis.lowStockCount} Items
          </div>
          <span className="kpi-delta negative">Below safety reorder level</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-title">Completed Dispatches</span>
          <div className="kpi-value">{kpis.totalDispatches} Shipments</div>
          <span className="kpi-delta positive">Delivery Challans issued</span>
        </div>
      </div>

      {/* Store & Materials Control KPI Grid */}
      <div className="kpi-grid" style={{ marginBottom: '28px' }}>
        <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/material-requests')}>
          <span className="kpi-title">Material Requests Pending</span>
          <div className="kpi-value" style={{ color: storeKPIs.pending > 0 ? '#b45309' : '#166534' }}>
            {storeKPIs.pending} Requests
          </div>
          <span className="kpi-delta negative">{storeKPIs.partial} Partially issued</span>
        </div>

        <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/issues')}>
          <span className="kpi-title">Store Issues Today</span>
          <div className="kpi-value" style={{ color: '#2563eb' }}>
            {storeKPIs.issuesToday} Slips
          </div>
          <span className="kpi-delta positive">{storeKPIs.totalIssuedTodayUnits} units issued today</span>
        </div>

        <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/store/returns')}>
          <span className="kpi-title">Material Returns Today</span>
          <div className="kpi-value">
            {storeKPIs.returnsToday} Returns
          </div>
          <span className="kpi-delta neutral">Auto re-added to stock</span>
        </div>

        <div className="kpi-card" style={{ cursor: 'pointer' }} onClick={() => navigate('/employees')}>
          <span className="kpi-title">Employees On Roll</span>
          <div className="kpi-value">{getEmployeeCount()} People</div>
          <span className="kpi-delta neutral">Verified issue recipients</span>
        </div>
      </div>

      {/* Quick Actions Launchpad */}
      <div className="content-block" style={{ marginBottom: '28px' }}>
        <div className="block-header" style={{ marginBottom: '14px' }}>
          <h2>Quick Actions Launchpad</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' }}>
          <button
            className="button-primary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/quotation')}
          >
            + New Quotation
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/customer-purchase-order')}
          >
            + Record Customer PO
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/sales-order')}
          >
            + Create Sales Order
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/inventory')}
          >
            ± Adjust Inventory
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/purchase-order')}
          >
            + Issue Purchase Order
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/delivery-challan')}
          >
            + Dispatch Challan
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/customer-invoice')}
          >
            + Create Tax Invoice
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/production/material-requests')}
          >
            + New Material Request
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/store/material-requests')}
          >
            Process MR Queue
          </button>
          <button
            className="button-secondary"
            style={{ padding: '12px 14px', fontSize: '13px', textAlign: 'center' }}
            onClick={() => navigate('/store/returns')}
          >
            + Record Material Return
          </button>
        </div>
      </div>

      
        {/* Conditional Active Quotations List */}
        {showActiveQuotations && (
          <div className="content-block" style={{ marginTop: '24px' }}>
            <div className="block-header">
              <h2>Active Quotations</h2>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Reference</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.filter(o => o.type === 'Quotation' && o.status === 'Pending').length > 0 ? (
                    recentOrders.filter(o => o.type === 'Quotation' && o.status === 'Pending').map((ord, idx) => (
                      <tr key={idx} style={{ cursor: 'pointer' }} onClick={() => navigate(ord.path)}>
                        <td>
                          <span style={{ fontSize: '11px', fontWeight: '700', padding: '2px 6px', borderRadius: '6px', background: '#f1f5f9', color: '#475569' }}>
                            {ord.type}
                          </span>
                        </td>
                        <td><strong>{ord.reference}</strong></td>
                        <td>{ord.party}</td>
                        <td>{ord.amount}</td>
                        <td>
                          <span style={{ fontSize: '11.5px', fontWeight: '600', color: '#92400e' }}>
                            {ord.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', padding: '20px' }}>No active quotations found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
</div>
  );
};

export default DashboardPage;
