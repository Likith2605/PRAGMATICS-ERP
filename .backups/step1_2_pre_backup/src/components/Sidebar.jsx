import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import logoUrl from '../assets/logo.png';

import { getStoredAuth, isAdmin } from '../utils/auth.js';
import { hasPermission, hasAnyPermission, getCurrentUserInfo } from '../utils/permissions.js';

const STORE_TOP_LINKS = [
  { label: 'Dashboard', path: '/', perm: null, end: false },
  { label: 'Workflow Dashboard', path: '/workflow', perm: 'store.module' },
  { label: 'Items to Review', path: '/store/item-requirements', perm: 'store.module' },
  { label: 'Purchase Indents', path: '/purchase-indents', perm: 'indent.view' },
  { label: 'Material Receipts', path: '/material-receipts', perm: 'receipt.view' },
  { label: 'Vendor Supplier Record', path: '/vendor-supplier-record', perm: 'receipt.view' },
  { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
  { label: 'Purchase Orders / Receipts', path: '/store', perm: 'inventory.adjust', end: true },
  { label: 'Store Issues', path: '/store/issues', perm: 'material_issue.view' },
  { label: 'HT Outsource', path: '/ht-outsource', perm: 'ht_outsource.view' },
  { label: 'Material Returns', path: '/store/returns', perm: 'material_return.view' },
  { label: 'Inventory Transactions', path: '/store/transactions', perm: 'inventory.transaction.view' },
  { label: 'Shelf Life / Expiry', path: '/store/expiry', perm: 'inventory.adjust' }
];

const GROUPS = [
  {
    label: 'Store',
    basePath: '/store',
    items: [
      { label: 'Store Home', path: '/store', perm: 'inventory.adjust', end: true },
      { label: 'Items to Review', path: '/store/item-requirements', perm: 'store.module' },
      { label: 'Purchase Indents', path: '/purchase-indents', perm: 'indent.view' },
      { label: 'Material Receipts', path: '/material-receipts', perm: 'receipt.view' },
      { label: 'Vendor Supplier Record', path: '/vendor-supplier-record', perm: 'receipt.view' },
      { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
      { label: 'Store Issues', path: '/store/issues', perm: 'material_issue.view' },
      { label: 'HT Outsource', path: '/ht-outsource', perm: 'ht_outsource.view' },
      { label: 'Material Returns', path: '/store/returns', perm: 'material_return.view' },
      { label: 'Inventory Transactions', path: '/store/transactions', perm: 'inventory.transaction.view' },
      { label: 'Shelf Life / Expiry', path: '/store/expiry', perm: 'inventory.adjust' },
      { label: 'Workflow Dashboard', path: '/workflow', perm: 'store.module' },
    ]
  },
  {
    label: 'Production & QC',
    basePath: '/production',
    items: [
      { label: 'Ballooning Dashboard', path: '/ballooning', perm: 'ballooning.view', end: true },
      { label: 'New Inspection Project', path: '/ballooning/new', perm: 'ballooning.manage' },
      { label: 'Production Home', path: '/production', perm: 'production.view', end: true },
      { label: 'Item Requirements', path: '/production/item-requirements', perm: 'production.requirement.manage' },
      { label: 'Quality Checks', path: '/quality-checks', perm: 'production.qc.view' },
      { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
      { label: 'Material Requests', path: '/production/material-requests', perm: 'material_request.create' },
      { label: 'HT Outsource Requests', path: '/ht-outsource', perm: 'ht_outsource.view' },
    ]
  },
  {
    label: 'Quality',
    basePath: '/quality-report',
    items: [
      { label: 'Quality Module', path: '/quality-module', perm: 'production.qc.view' },
      { label: 'Quality Report', path: '/quality-report', perm: 'production.qc.view', end: true }
    ]
  },
  {
    label: 'Purchase',
    basePath: '/purchase-order',
    items: [
      { label: 'Purchase Order', path: '/purchase-order', perm: 'purchase.order' },
      { label: 'Vendor Enquiry', path: '/vendor-enquiry', perm: 'purchase_request.view' },
      { label: 'Vendor Quotation', path: '/vendor-quotations', perm: 'purchase_request.view' },
      { label: 'Supplier Invoice', path: '/supplier-invoice', perm: 'purchase.supplier_invoice' },
      { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
      { label: 'Vendor Master', path: '/vendor-master', perm: 'purchase.order' },
    ]
  },
  {
    label: 'Customer Invoice',
    basePath: '/customer-invoice',
    items: [
      { label: 'Customer Invoice (GST)', path: '/customer-invoice', perm: 'invoice.view', end: true },
      { label: 'Export Invoice', path: '/export-invoice', perm: 'invoice.view' },
    ]
  },
  {
    label: 'Reports',
    basePath: '/reports',
    items: [
      { label: 'Reports Home', path: '/reports', perm: ['reports.view', 'purchase.reports.view'], end: true },
    ]
  }
];

const MenuItem = ({ label, path, end, sub }) => (
  <NavLink
    to={path}
    end={end}
    className={({ isActive }) => (isActive ? (sub ? 'nav-sub-link active' : 'nav-link active') : sub ? 'nav-sub-link' : 'nav-link')}
  >
    {label}
  </NavLink>
);

const CollapsibleGroup = ({ group, isOpen, onToggle }) => {
  const location = useLocation();
  const visibleItems = group.items.filter((item) => !item.perm || hasAnyPermission(item.perm));
  const isActive = visibleItems.some((item) => location.pathname === item.path || location.pathname.startsWith(item.path + '/'));

  return (
    <div className="nav-group">
      <div
        className={`nav-link nav-group-header ${isActive ? 'active' : ''}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
        onClick={onToggle}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {group.label}
        </span>
        <span
          style={{
            fontSize: '10px',
            transition: 'transform 0.2s ease',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            display: 'inline-block'
          }}
        >
          ▼
        </span>
      </div>
      {isOpen && (
        <div className="nav-group-items" style={{ paddingLeft: '12px' }}>
          {visibleItems.map((item) => (
            <MenuItem key={item.path} label={item.label} path={item.path} end={item.end} sub />
          ))}
        </div>
      )}
    </div>
  );
};

const Sidebar = ({ onLogout }) => {
  const userAdmin = isAdmin();
  const auth = getStoredAuth();
  const info = getCurrentUserInfo();
  const location = useLocation();
  const displayName = userAdmin ? 'Admin' : (auth?.username || 'Staff Employee');
  const roleLabel = userAdmin
    ? 'Administrator (Full Access)'
    : `${info.employee?.department || ''} · ${info.employee?.role || 'Team Member'}`.trim();
  const avatarLetter = userAdmin ? 'A' : ((auth?.username || 'E').charAt(0).toUpperCase());
  const avatarBg = userAdmin ? '#2563eb' : '#0f766e';

  const [openGroups, setOpenGroups] = useState(() => {
    const initial = {};
    GROUPS.forEach((g) => {
      initial[g.label] =
        location.pathname === g.basePath ||
        location.pathname.startsWith(g.basePath + '/') ||
        g.items.some((i) => location.pathname === i.path);
    });
    return initial;
  });

  const toggleGroup = (label) => {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  const allMenuItems = [
    { label: 'Dashboard', path: '/', perm: null },
    { label: 'Enquiry', path: '/project-request', perm: 'sales.enquiry' },
    { label: 'Quotation', path: '/quotation', perm: 'sales.quotation' },
    { label: 'Customer Purchase Order', path: '/customer-purchase-order', perm: 'sales.customer_order' },
    { label: 'Sales Order', path: '/sales-order', perm: 'sales_order.view' },
    { label: 'Customers', path: '/customers', perm: 'sales_order.view' },
    { label: 'Inventory', path: '/inventory', perm: 'inventory.view' },
    { label: 'Employees', path: '/employees', perm: 'employee.view' },
        { label: 'Machine Master', path: '/machines', perm: 'settings.view' },
    { label: 'Delivery Challan', path: '/delivery-challan', perm: 'delivery.view' },
    { label: 'Company Settings', path: '/settings', perm: 'settings.view' },
    { label: 'Backup & Export', path: '/backup-export', perm: 'backup.view' },
    { label: 'Export to Tally', path: '/tally-export', perm: 'backup.view' }
  ];

  const isStoreDept = info.employee?.department === 'Store Department';
  const isProdDept = info.employee?.department === 'Production Department';

  const filteredMenuItems = allMenuItems.filter((item) => {
    if (item.label === 'Employees' && (info.employee?.department === 'Store Department' || info.employee?.department === 'Production Department')) return false;
    if (item.label === 'Inventory' && (isStoreDept || isProdDept)) return false;
    if (item.label === 'Dashboard' && isProdDept) return false;
    return !item.perm || hasAnyPermission(item.perm);
  });

  const filteredGroups = GROUPS.filter((group) => {
    if (isProdDept) return group.label === 'Production & QC' || group.label === 'Quality';
    return group.items.some((item) => !item.perm || hasAnyPermission(item.perm));
  });

  return (
    <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div className="brand-block" style={{ flexShrink: 0 }}>
        <img className="brand-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
        <div>
          <h1>Pragmatic</h1>
          <p>Pragmatics ERP</p>
        </div>
      </div>

      <nav className="sidebar-nav" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {isStoreDept ? (
          <>
            {STORE_TOP_LINKS.filter((l) => l.label !== 'Purchase Orders / Receipts' && (!l.perm || hasPermission(l.perm))).map((l) => (
              <MenuItem key={l.path} label={l.label} path={l.path} end={l.end} />
            ))}
          </>
        ) : (
          <>
            {filteredMenuItems.slice(0, 5).map((item) => (
              <MenuItem key={item.path} label={item.label} path={item.path} />
            ))}

            {filteredGroups.map((group) => (
              <CollapsibleGroup
                key={group.label}
                group={group}
                isOpen={!!openGroups[group.label]}
                onToggle={() => toggleGroup(group.label)}
              />
            ))}

            {filteredMenuItems.slice(5).map((item) => (
              <MenuItem key={item.path} label={item.label} path={item.path} />
            ))}
          </>
        )}
      </nav>

      <div
        style={{
          padding: '14px 16px',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          background: 'transparent',
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          <div
            style={{
              width: '34px',
              height: '34px',
              borderRadius: '50%',
              background: avatarBg,
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: '700',
              fontSize: '15px',
              flexShrink: 0
            }}
          >
            {avatarLetter}
          </div>
          <div style={{ overflow: 'hidden' }}>
            <div style={{ fontSize: '13px', fontWeight: '700', color: '#f8fafc', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
              {displayName}
            </div>
            <div style={{ fontSize: '10.5px', color: userAdmin ? '#93c5fd' : '#99f6e4', fontWeight: '600' }}>
              {roleLabel}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          style={{
            width: '100%',
            padding: '7px 10px',
            background: 'rgba(239, 68, 68, 0.12)',
            color: '#fca5a5',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: '600',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px'
          }}
        >
          Logout
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
