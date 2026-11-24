import React from 'react';
import { useLocation } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import NotificationsPanel from './NotificationsPanel.jsx';

const LABELS = {
  '/': 'Dashboard', '/dashboard': 'Dashboard', '/sales-dashboard': 'Sales Dashboard', '/project-request': 'Enquiries',
  '/quotation': 'Quotations', '/customer-purchase-order': 'Customer purchase orders',
  '/sales-order': 'Sales orders', '/production': 'Production', '/inventory': 'Inventory',
  '/store': 'Store', '/purchase-order': 'Purchase orders', '/material-receipts': 'Material receipts',
  '/vendor-enquiry': 'Vendor enquiries', '/vendor-quotations': 'Vendor quotations',
  '/customer-invoice': 'Customer invoices', '/export-invoice': 'Export invoices',
  '/delivery-challan': 'Delivery challans', '/quality-checks': 'Quality checks',
  '/quality-report': 'Quality reports', '/quality-module': 'Quality', '/workflow': 'Workflow',
  '/reports': 'Reports', '/customers': 'Customers', '/employees': 'Employees',
  '/machines': 'Machine master', '/settings': 'Company settings',
  '/backup-export': 'Backup & export', '/tally-export': 'Tally export',
  '/ballooning': 'Inspection projects'
};

const formatSegment = (segment) => segment.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

const getPageTitle = (pathname) => {
  if (LABELS[pathname]) return LABELS[pathname];
  if (pathname.startsWith('/reports/')) return `Reports / ${pathname.split('/').filter(Boolean).slice(1).map(formatSegment).join(' / ')}`;
  if (pathname.startsWith('/ballooning/')) return `Inspection projects / ${pathname.split('/').filter(Boolean).slice(1).map(formatSegment).join(' / ')}`;
  const segments = pathname.split('/').filter(Boolean);
  return segments.length ? segments.map(formatSegment).join(' / ') : 'Dashboard';
};

const Header = ({ onLogout, onMenuToggle, auth, onDepartmentChange }) => {
  const { pathname } = useLocation();
  return (
    <header className="app-header">
      <div className="header-context">
        <button type="button" className="header-menu-toggle" onClick={onMenuToggle} aria-label="Open navigation"><Menu size={20} strokeWidth={1.75} /></button>
        <div className="header-title"><span className="header-overline">VYAVASTA ERP</span><h1>{getPageTitle(pathname)}</h1></div>
      </div>
      <div className="header-actions">
        {auth?.roleKey !== 'admin' && (auth?.assignments?.length || 0) > 0 && (
          <label className="header-department-switcher">
            <span className="header-department-label">Active department</span>
            <select aria-label="Switch department" disabled={(auth?.assignments?.length || 0) < 2} value={auth.activeDepartment || auth.department || ''} onChange={(event) => onDepartmentChange?.(event.target.value)}>
              {auth.assignments.map((assignment) => <option key={assignment.department} value={assignment.department}>{assignment.department} · {assignment.role}</option>)}
            </select>
          </label>
        )}
        <NotificationsPanel />
        <button type="button" className="header-signout" onClick={onLogout}><LogOut size={16} strokeWidth={1.75} aria-hidden="true" /><span>Sign out</span></button>
      </div>
    </header>
  );
};

export default Header;
