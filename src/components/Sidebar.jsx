import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity, Archive, ArrowLeftRight, Boxes, ClipboardCheck, ClipboardList,
  Factory, FileCheck2, FileClock, FileDown, FilePlus2, FileText, Gauge,
  HardHat, Layers3, LifeBuoy, LogOut, Package, PackageCheck, PackageOpen,
  ReceiptText, Settings2, ShieldCheck, ShoppingCart, TrendingUp, Truck, Users, Wrench,
  ChevronDown
} from 'lucide-react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { getStoredAuth, isAdmin } from '../utils/auth.js';
import { hasPermission, hasAnyPermission, getCurrentUserInfo } from '../utils/permissions.js';
import {
  PURCHASE_DASHBOARD_LINK, PRODUCTION_DASHBOARD_LINK, STORE_DASHBOARD_LINK,
  dashboardNavigationItemFor, filterNavigationItems
} from '../utils/roleNavigation.js';

const ICONS = {
  Dashboard: Gauge, 'Sales Dashboard': Gauge, Enquiry: FilePlus2, Quotation: FileText,
  'Customer Purchase Order': ReceiptText, 'Sales Order': ClipboardCheck,
  Customers: Users, Inventory: Boxes, Employees: Users,
  'Machine Master': Wrench, 'Delivery Challan': Truck,
  'Company Settings': Settings2, 'Backup & Export': Archive,
  'Export to Tally': FileDown, 'Workflow Dashboard': Activity,
  'Items to Review': ClipboardList, 'Purchase Indents': FileClock,
  'Material Receipts': PackageCheck, 'Vendor Supplier Record': FileCheck2,
  'Debit Notes': ReceiptText,
  'Store Issues': PackageOpen, 'HT Outsource': Factory,
  'Material Returns': ArrowLeftRight, 'Inventory Transactions': Layers3,
  'Stock Transfers & Verification': ArrowLeftRight,
  'Shelf Life / Expiry': FileClock, 'Ballooning Dashboard': ClipboardCheck,
  'New Inspection Project': FilePlus2, 'Production Home': HardHat,
  'Item Requirements': ClipboardList, 'Quality Checks': ShieldCheck,
  'Material Requests': PackageOpen, 'HT Outsource Requests': Factory,
  'Quality Module': ShieldCheck, 'Quality Report': FileCheck2,
  'Purchase Dashboard': Gauge, 'Purchase Order': ShoppingCart, 'Vendor Enquiry': FilePlus2,
  'Vendor Quotation': FileText, 'Supplier Invoice': ReceiptText,
  'Vendor Master': Users, 'Customer Invoice (GST)': ReceiptText, 'Customer Invoice': ReceiptText,
  'Export Invoice': FileDown, 'Reports Home': Activity
};

const STORE_TOP_LINKS = [
  STORE_DASHBOARD_LINK,
  { label: 'Inventory', path: '/inventory', perm: 'inventory.view' },
  { label: 'Items to Review', path: '/store/item-requirements', perm: 'store.module' },
  { label: 'Purchase Indents', path: '/purchase-indents', perm: 'indent.view' },
  { label: 'Material Receipts', path: '/material-receipts', perm: 'receipt.view' },
  { label: 'Vendor Supplier Record', path: '/vendor-supplier-record', perm: 'receipt.view' },
  { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
  { label: 'Store Issues', path: '/store/issues', perm: 'material_issue.view' },
  { label: 'HT Outsource', path: '/ht-outsource', perm: 'ht_outsource.view' },
  { label: 'Material Returns', path: '/store/returns', perm: 'material_return.view' },
  { label: 'Inventory Transactions', path: '/store/transactions', perm: 'inventory.transaction.view' },
  { label: 'Stock Transfers & Verification', path: '/store/inventory-workflows', perm: ['inventory.view', 'inventory.transaction.view', 'inventory.adjust', 'store.module'] },
  { label: 'Shelf Life / Expiry', path: '/store/expiry', perm: 'inventory.adjust' }
];

const GROUPS = [
  { label: 'Sales', icon: TrendingUp, basePath: '/project-request', items: [
    { label: 'Enquiry', path: '/project-request', perm: 'sales.enquiry' },
    { label: 'Quotation', path: '/quotation', perm: 'sales.quotation' },
    { label: 'Customer Purchase Order', path: '/customer-purchase-order', perm: 'sales.customer_order' },
    { label: 'Sales Order', path: '/sales-order', perm: 'sales_order.view' },
    { label: 'Delivery Challan', path: '/delivery-challan', perm: 'delivery.view' },
    { label: 'Customer Invoice', path: '/customer-invoice', perm: 'invoice.view', end: true },
    { label: 'Export Invoice', path: '/export-invoice', perm: 'invoice.view' }
  ] },
  { label: 'Store', icon: Package, basePath: '/store', items: [
    { label: 'Inventory', path: '/inventory', perm: 'inventory.view' },
    { label: 'Items to Review', path: '/store/item-requirements', perm: 'store.module' },
    { label: 'Purchase Indents', path: '/purchase-indents', perm: 'indent.view' },
    { label: 'Material Receipts', path: '/material-receipts', perm: 'receipt.view' },
    { label: 'Vendor Supplier Record', path: '/vendor-supplier-record', perm: 'receipt.view' },
    { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
    { label: 'Store Issues', path: '/store/issues', perm: 'material_issue.view' },
    { label: 'HT Outsource', path: '/ht-outsource', perm: 'ht_outsource.view' },
    { label: 'Material Returns', path: '/store/returns', perm: 'material_return.view' },
    { label: 'Inventory Transactions', path: '/store/transactions', perm: 'inventory.transaction.view' },
    { label: 'Stock Transfers & Verification', path: '/store/inventory-workflows', perm: ['inventory.view', 'inventory.transaction.view', 'inventory.adjust', 'store.module'] },
    { label: 'Shelf Life / Expiry', path: '/store/expiry', perm: 'inventory.adjust' },
    { label: 'Workflow Dashboard', path: '/workflow', perm: 'store.module' }
  ] },
  { label: 'Production & QC', icon: Factory, basePath: '/production', items: [
    { label: 'Ballooning Dashboard', path: '/ballooning', perm: 'ballooning.view', end: true },
    { label: 'New Inspection Project', path: '/ballooning/new', perm: 'ballooning.manage' },
    PRODUCTION_DASHBOARD_LINK,
    { label: 'Item Requirements', path: '/production/item-requirements', perm: 'production.requirement.manage' },
    { label: 'Quality Checks', path: '/quality-checks', perm: 'production.qc.view' },
    { label: 'Material Requests', path: '/production/material-requests', perm: 'material_request.create' },
    { label: 'HT Outsource Requests', path: '/ht-outsource', perm: 'ht_outsource.view' }
  ] },
  { label: 'Quality', icon: ShieldCheck, basePath: '/quality-report', items: [
    { label: 'Quality Module', path: '/quality-module', perm: 'production.qc.view' },
    { label: 'Quality Report', path: '/quality-report', perm: 'production.qc.view', end: true }
  ] },
  { label: 'Purchase', icon: ShoppingCart, basePath: '/purchase-order', items: [
    PURCHASE_DASHBOARD_LINK,
    { label: 'Purchase Order', path: '/purchase-order', perm: 'purchase.order' },
    { label: 'Vendor Enquiry', path: '/vendor-enquiry', perm: 'purchase_request.view' },
    { label: 'Vendor Quotation', path: '/vendor-quotations', perm: 'purchase_request.view' },
    { label: 'Supplier Invoice', path: '/supplier-invoice', perm: 'purchase.supplier_invoice' },
    { label: 'Debit Notes', path: '/debit-notes', perm: 'debitnote.view' },
    { label: 'Vendor Master', path: '/vendor-master', perm: 'purchase.order' }
  ] },
  { label: 'Reports', icon: Activity, basePath: '/reports', items: [
    { label: 'Reports Home', path: '/reports', perm: ['reports.view', 'purchase.reports.view'], end: true }
  ] },
  { label: 'Utilities', icon: Settings2, basePath: '/customers', items: [
    { label: 'Customers', path: '/customers', perm: 'sales_order.view' },
    { label: 'Employees', path: '/employees', perm: 'employee.view' },
    { label: 'Machine Master', path: '/machines', perm: 'settings.view' },
    { label: 'Material & UOM Master', path: '/master-data', perm: ['inventory.view', 'settings.view'] },
    { label: 'Company Settings', path: '/settings', perm: 'settings.view' },
    { label: 'Backup & Export', path: '/backup-export', perm: 'backup.view' },
    { label: 'Recycle Bin', path: '/recycle-bin', perm: ['settings.view', 'store.module', 'purchase.order', 'purchase_request.view', 'production.view', 'sales_order.view', 'invoice.view'] }
  ] }
];

const MenuItem = ({ label, path, end, sub }) => {
  const Icon = ICONS[label] || ClipboardList;
  return (
    <NavLink to={path} end={end} className={({ isActive }) => `nav-link${sub ? ' nav-sub-link' : ''}${isActive ? ' active' : ''}`}>
      <Icon className="nav-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">{label}</span>
    </NavLink>
  );
};

const CollapsibleGroup = ({ group, isOpen, onToggle, isProdDept }) => {
  const location = useLocation();
  const groupItems = group.label === 'Utilities' && isProdDept
    ? group.items.filter((item) => item.label !== 'Employees')
    : group.items;
  const visibleItems = filterNavigationItems(groupItems, hasAnyPermission);
  const isActive = visibleItems.some((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  const Icon = group.icon;
  return (
    <div className="nav-group">
      <button type="button" className={`nav-link nav-group-header${isActive ? ' active' : ''}`} onClick={onToggle} aria-expanded={isOpen}>
        <Icon className="nav-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="nav-label">{group.label}</span>
        <ChevronDown className={`nav-chevron${isOpen ? ' is-open' : ''}`} size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {isOpen && <div className="nav-group-items">{visibleItems.map((item) => <MenuItem key={item.path} {...item} sub />)}</div>}
    </div>
  );
};

const Sidebar = ({ onLogout, mobileOpen = false, onMobileClose }) => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const companyNameRef = useRef(null);
  const [companyNameFontSize, setCompanyNameFontSize] = useState(18.6667);

  // Keep the full legal name inside two lines: wrap normally and only shrink
  // the font when the available sidebar width requires it.
  useEffect(() => {
    const element = companyNameRef.current;
    if (!element || !brandName) return undefined;
    const fitCompanyName = () => {
      const maxWidth = element.parentElement?.clientWidth || element.clientWidth;
      if (!maxWidth) return;
      const context = document.createElement('canvas').getContext('2d');
      const family = window.getComputedStyle(element).fontFamily;
      const words = String(brandName).trim().split(/\s+/);
      let size = 18.6667;
      while (size > 12) {
        context.font = `600 ${size}px ${family}`;
        let lines = 1;
        let current = '';
        let fits = true;
        for (const word of words) {
          if (context.measureText(word).width > maxWidth) { fits = false; break; }
          const candidate = current ? `${current} ${word}` : word;
          if (context.measureText(candidate).width <= maxWidth) current = candidate;
          else { lines += 1; current = word; }
        }
        if (fits && lines <= 2) break;
        size -= 0.5;
      }
      setCompanyNameFontSize(size);
    };
    fitCompanyName();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fitCompanyName) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [brandName]);

  const userAdmin = isAdmin();
  const auth = getStoredAuth();
  const info = getCurrentUserInfo();
  const location = useLocation();
  const displayName = userAdmin ? 'Admin' : (auth?.username || 'Staff Employee');
  const roleLabel = userAdmin ? 'Administrator (Full Access)' : `${info.employee?.department || ''} · ${info.employee?.role || 'Team Member'}`.trim();
  const avatarLetter = userAdmin ? 'A' : ((auth?.username || 'E').charAt(0).toUpperCase());
  const [openGroups, setOpenGroups] = useState(() => Object.fromEntries(GROUPS.map((group) => [
    group.label,
    location.pathname === group.basePath || location.pathname.startsWith(`${group.basePath}/`) || group.items.some((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`))
  ])));

  const allMenuItems = [
    { label: 'Dashboard', path: '/', perm: null },
    { label: 'Export to Tally', path: '/tally-export', perm: 'tally.export' }
  ];
  const isStoreDept = info.employee?.department === 'Store Department';
  const isProdDept = info.employee?.department === 'Production Department';
  const isPurchaseDept = info.employee?.department === 'Purchase Department';
  const filteredMenuItems = allMenuItems.filter((item) => {
    if (item.label === 'Employees' && (isStoreDept || isProdDept)) return false;
    if (item.label === 'Inventory' && (isStoreDept || isProdDept)) return false;
    if (item.label === 'Dashboard' && (isProdDept || isPurchaseDept)) return false;
    return !item.perm || hasAnyPermission(item.perm);
  }).map((item) => item.label === 'Dashboard'
    ? { ...item, ...dashboardNavigationItemFor(info.employee?.department) }
    : item);
  const filteredGroups = GROUPS.filter((group) => {
    if (isProdDept && !['Production & QC', 'Quality', 'Utilities'].includes(group.label)) return false;
    const groupItems = group.label === 'Utilities' && isProdDept
      ? group.items.filter((item) => item.label !== 'Employees')
      : group.items;
    return groupItems.some((item) => !item.perm || hasAnyPermission(item.perm));
  });
  const topMenuItems = filteredMenuItems.filter((item) => ['Dashboard'].includes(item.label));
  const bottomMenuItems = filteredMenuItems.filter((item) => !['Dashboard'].includes(item.label));

  return (
    <aside className={`sidebar${mobileOpen ? ' sidebar--mobile-open' : ''}`} onClick={(event) => { if (event.target.closest('a')) onMobileClose?.(); }}>
      <div className="brand-block">
        <img className="brand-logo" src={logoUrl} alt={brandName} />
        <div className="brand-copy">
          <h1 ref={companyNameRef} title={brandName} style={{ fontSize: `${companyNameFontSize}px`, lineHeight: `${Math.max(14, Math.round(companyNameFontSize + 3))}px` }}>{brandName}</h1>
          <p>VYAVASTA</p>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {isStoreDept ? STORE_TOP_LINKS.filter((item) => !item.perm || hasAnyPermission(item.perm)).map((item) => <MenuItem key={item.path} {...item} />) : <>
          {topMenuItems.map((item) => <MenuItem key={item.path} {...item} />)}
          {filteredGroups.map((group) => <CollapsibleGroup key={group.label} group={group} isOpen={!!openGroups[group.label]} isProdDept={isProdDept} onToggle={() => setOpenGroups((prev) => ({ ...prev, [group.label]: !prev[group.label] }))} />)}
          {bottomMenuItems.map((item) => <MenuItem key={item.path} {...item} />)}
        </>}
      </nav>
      <div className="sidebar-account">
        <div className="sidebar-user">
          <div className="sidebar-avatar" aria-hidden="true">{avatarLetter}</div>
          <div className="sidebar-user-copy"><div className="sidebar-user-name">{displayName}</div><div className="sidebar-user-role">{roleLabel}</div></div>
        </div>
        <button type="button" className="sidebar-logout" onClick={onLogout}><LogOut size={16} strokeWidth={1.75} aria-hidden="true" /> Sign out</button>
      </div>
    </aside>
  );
};

export default Sidebar;
