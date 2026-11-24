import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import LoginPage, { getStoredAuth } from './pages/LoginPage.jsx';
import { hasAnyPermission } from './utils/permissions.js';
import { authHeaders, setStoredAuth } from './utils/auth.js';
import { homePathFor } from './utils/roleNavigation.js';
import DashboardPage from './pages/DashboardPage.jsx';
import SalesDashboardPage from './pages/SalesDashboardPage.jsx';
import QuotationPage from './pages/QuotationPage.jsx';
import QuotationPreviewPage from './pages/QuotationPreviewPage.jsx';
import ProjectRequestPage from './pages/ProjectRequestPage.jsx';
import AddProjectRequestPage from './pages/AddProjectRequestPage.jsx';
import SalesOrderPage from './pages/SalesOrderPage.jsx';
import ProductionPage from './pages/ProductionPage.jsx';
import CustomerInvoicePage from './pages/CustomerInvoicePage.jsx';
import ExportInvoicePage from './pages/ExportInvoicePage.jsx';
import CustomerPurchaseOrderPage from './pages/CustomerPurchaseOrderPage.jsx';
import InventoryPage from './pages/InventoryPage.jsx';
import StoreInventoryPage from './pages/StoreInventoryPage.jsx';
import EmployeeMasterPage from './pages/EmployeeMasterPage.jsx';
import MachineMasterPage from './pages/MachineMasterPage.jsx';
import ProductionMaterialRequestsPage from './pages/ProductionMaterialRequestsPage.jsx';
import BOMPage from './pages/BOMPage.jsx';
import StoreMaterialRequestsPage from './pages/StoreMaterialRequestsPage.jsx';
import StoreIssuesPage from './pages/StoreIssuesPage.jsx';
import MaterialReturnsPage from './pages/MaterialReturnsPage.jsx';
import InventoryTransactionsPage from './pages/InventoryTransactionsPage.jsx';
import ShelfLifePage from './pages/ShelfLifePage.jsx';
import PurchaseOrderPage from './pages/PurchaseOrderPage.jsx';
import SupplierInvoicePage from './pages/SupplierInvoicePage.jsx';
import DeliveryChallanPage from './pages/DeliveryChallanPage.jsx';
import VendorEnquiryPage from './pages/VendorEnquiryPage.jsx';
import VendorEnquiryPreviewPage from './pages/VendorEnquiryPreviewPage.jsx';
import VendorQuotationPage from './pages/VendorQuotationPage.jsx';
import VendorQuotationPreviewPage from './pages/VendorQuotationPreviewPage.jsx';
import VendorMasterPage from './pages/VendorMasterPage.jsx';
import HTOutsourcePage from './pages/HTOutsourcePage.jsx';
import StoreItemRequirementsPage from './pages/StoreItemRequirementsPage.jsx';
import ProductionItemRequirementsPage from './pages/ProductionItemRequirementsPage.jsx';
import PurchaseIndentsPage from './pages/PurchaseIndentsPage.jsx';
import MaterialReceiptsPage from './pages/MaterialReceiptsPage.jsx';
import VendorSupplierRecordPage from './pages/VendorSupplierRecordPage.jsx';
import QualityCheckPage from './pages/QualityCheckPage.jsx';
import QualityReportPage from './pages/QualityReportPage.jsx';
import QualityModulePage from './pages/quality/QualityPage.jsx';
import DebitNotesPage from './pages/DebitNotesPage.jsx';
import WorkflowDashboardPage from './pages/WorkflowDashboardPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import BackupExportPage from './pages/BackupExportPage.jsx';
import TallyExportPage from './pages/TallyExportPage.jsx';
import ReportsHomePage from './pages/ReportsHomePage.jsx';
import InventoryStockStatusPage from './pages/reports/InventoryStockStatusPage.jsx';
import InventoryValuationPage from './pages/reports/InventoryValuationPage.jsx';
import MaterialIssueRegisterPage from './pages/reports/MaterialIssueRegisterPage.jsx';
import MaterialWithSupplierPage from './pages/reports/MaterialWithSupplierPage.jsx';
import ItemListPage from './pages/reports/ItemListPage.jsx';
import CustomerListPage from './pages/reports/CustomerListPage.jsx';
import SalesRegisterPage from './pages/reports/SalesRegisterPage.jsx';
import SalesOrderAgeingPage from './pages/reports/SalesOrderAgeingPage.jsx';
import SupplierOutstandingPage from './pages/reports/SupplierOutstandingPage.jsx';
import JobCardPlannedActualPage from './pages/reports/JobCardPlannedActualPage.jsx';
import JobCardMaterialPage from './pages/reports/JobCardMaterialPage.jsx';
import ReadyToDespatchPage from './pages/reports/ReadyToDespatchPage.jsx';
import StalePurchaseOrdersPage from './pages/reports/StalePurchaseOrdersPage.jsx';
import PreClosedPurchaseOrdersPage from './pages/reports/PreClosedPurchaseOrdersPage.jsx';
import SupplierWiseItemsPage from './pages/reports/SupplierWiseItemsPage.jsx';
import InventoryLotReportPage from './pages/reports/InventoryLotReportPage.jsx';
import TrackAReportPage from './pages/reports/TrackAReportPage.jsx';
import CustomersPage from './pages/CustomersPage.jsx';
import { OFFICIAL_COMPANY_PROFILE } from './constants/companyProfile.js';
import { checkAndPerformDailyAutoBackup } from './utils/backupManager.js';
import { ensureSeededData, enforceStorageBudget } from './utils/storeService.js';
import { ensureWorkflowSeeded, migrateWorkflowRecords } from './utils/workflowService.js';
import { getVendorMaster } from './utils/vendorMaster.js';
import { resetERPStateSyncBaseline, startERPStateMirror, syncERPState } from './services/erpStateSync.js';
import { pullRecordsFromServer, startRecordsSync } from './services/recordsSync.js';
import SyncStatusBar from './components/SyncStatusBar.jsx';
import { installContactValidation } from './utils/installContactValidation.js';
import './styles/quotation.css';
import './styles/erp-theme.css';
import './styles/ballooning-tailwind.css';
import BallooningDashboardPage from './pages/ballooning/Dashboard.jsx';
import BallooningNewProjectPage from './pages/ballooning/NewProject.jsx';
import BallooningWorkspacePage from './pages/ballooning/DrawingWorkspace.jsx';
import BallooningApprovalPage from './pages/ballooning/Approval.jsx';
import BallooningExportPage from './pages/ballooning/Export.jsx';

const AccessDeniedHome = () => (
  <section className="page-section">
    <div className="page-header">
      <div>
        <h1 className="page-title">Dashboard unavailable</h1>
        <p className="page-description">Your account is not assigned to a department dashboard. Contact an administrator for access.</p>
      </div>
    </div>
  </section>
);

const DebitNotesAccessDenied = () => (
  <section className="page-section" role="alert">
    <div className="page-header">
      <div>
        <h1 className="page-title">Access Denied</h1>
        <p className="page-description">Your department does not have access to Debit Notes. Contact Purchase or an administrator if you need access.</p>
      </div>
    </div>
  </section>
);

const DepartmentSelection = ({ auth, onSelect }) => (
  <div className="department-selection-screen">
    <section className="department-selection-card">
      <span className="header-overline">VYAVASTA ERP</span>
      <h1>Choose a department</h1>
      <p>Welcome, {auth.username || auth.name || auth.email}. Select the department you are working in.</p>
      <div className="department-selection-options">
        {(auth.assignments || []).map((assignment) => (
          <button key={assignment.department} type="button" className="department-selection-option" onClick={() => onSelect(assignment.department)}>
            <strong>{assignment.department}</strong>
            <span>{assignment.role}</span>
          </button>
        ))}
      </div>
    </section>
  </div>
);

const HomeRoute = ({ auth }) => {
  const home = homePathFor(auth);
  if (home === '/') return <DashboardPage />;
  if (home === '/access-denied') return <AccessDeniedHome />;
  return <Navigate to={home} replace />;
};

const Guard = ({ perm, children }) => {
  const allowed = hasAnyPermission(perm);
  if (allowed) return children;
  return <Navigate to={homePathFor(getStoredAuth())} replace />;
};

// Scopes every selector of styles/ballooning-tailwind.css to this wrapper so
// the ballooning pages keep their original look without touching ERP styles.
const BalloonScope = ({ flush = false, children }) => (
  <div className={flush ? 'balloon-scope balloon-scope--flush' : 'balloon-scope'}>
    {children}
  </div>
);

function App() {
  const [auth, setAuth] = useState(() => getStoredAuth());
  const [erpReady, setErpReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => installContactValidation(), []);

  useEffect(() => {
    let disposed = false;
    let stopMirror = () => {};
    let permissionRefreshTimer = null;

    const initializeERP = async () => {
      // localStorage is a single ~5 MB quota shared by every module; reclaim
      // space from old derived data before anything else writes to it.
      enforceStorageBudget();

      try {
        // A saved record is authoritative. Never rewrite it with defaults on
        // refresh — the shared branding service fills any missing fields.
        if (!localStorage.getItem('companySettings')) {
          localStorage.setItem('companySettings', JSON.stringify(OFFICIAL_COMPANY_PROFILE));
        }
      } catch (e) {
        console.error('Failed to initialise company settings', e);
      }

      // Auto-run daily backup check & audit logging
      checkAndPerformDailyAutoBackup();

      // Seed employee master + warehouse module data if missing
      ensureSeededData();
      getVendorMaster();
      ensureWorkflowSeeded();
      // Backfill Project ID / document-chain traceability and reconcile PO physical status
      // for records created before this workflow release. Existing data is preserved.
      migrateWorkflowRecords();

      if (disposed) return;
      setErpReady(true);
      const saved = getStoredAuth();
      if (saved?.token) {
        try {
          const base = window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api';
          const check = await fetch(`${base}/auth/me`, { headers: authHeaders() });
          if (!check.ok) throw new Error('Session expired');
          const session = await check.json();
          const verified = { ...session.user, token: saved.token, expiresAt: saved.expiresAt };
          localStorage.setItem('erp_auth', JSON.stringify(verified));
          setAuth(verified);
          await syncERPState();
          await pullRecordsFromServer();
          stopMirror = startERPStateMirror();
          startRecordsSync();
        } catch {
          localStorage.removeItem('erp_auth');
          setAuth(null);
        }
      } else setAuth(null);
    };

    initializeERP();
    const refreshLatestPermissions = async () => {
      const saved = getStoredAuth();
      if (!saved?.token) return;
      const base = window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api';
      try {
        const response = await fetch(`${base}/auth/me`, { headers: authHeaders() });
        if (!response.ok || disposed) return;
        const payload = await response.json();
        const current = getStoredAuth();
        if (!current?.token || current.token !== saved.token) return;
        const verified = { ...current, ...payload.user, token: saved.token, expiresAt: saved.expiresAt };
        const oldPermissionView = JSON.stringify((current.assignments || []).map((item) => [item.departmentId, item.roleId, item.permissions || []]));
        const newPermissionView = JSON.stringify((verified.assignments || []).map((item) => [item.departmentId, item.roleId, item.permissions || []]));
        localStorage.setItem('erp_auth', JSON.stringify(verified));
        setAuth(verified);
        if (oldPermissionView !== newPermissionView) window.dispatchEvent(new CustomEvent('erp-auth-permissions-updated'));
      } catch { /* A transient refresh failure must not replace an existing session. */ }
    };
    permissionRefreshTimer = window.setInterval(refreshLatestPermissions, 20000);
    return () => {
      disposed = true;
      window.clearInterval(permissionRefreshTimer);
      stopMirror();
    };
  }, []);

  const handleLoginSuccess = async (authData) => {
    const nextAuth = { ...authData, activeDepartment: authData.assignments?.length === 1 ? authData.assignments[0].department : '' };
    setStoredAuth(nextAuth);
    setAuth(nextAuth);
    if (nextAuth.assignments?.length > 1) return;
    await syncERPState();
    await pullRecordsFromServer();
    startERPStateMirror();
    startRecordsSync();
  };

  const handleDepartmentChange = async (department) => {
    const saved = getStoredAuth();
    if (!saved?.token) return;
    const base = window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api';
    try {
      const response = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${saved.token}`, 'X-ERP-Department': department } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'This department assignment is no longer available.');
      const nextAuth = { ...saved, ...payload.user, token: saved.token, expiresAt: saved.expiresAt, activeDepartment: payload.user.department, department: payload.user.department, role: payload.user.role, roleKey: payload.user.roleKey };
      setStoredAuth(nextAuth);
      setAuth(nextAuth);
      window.dispatchEvent(new CustomEvent('erp-department-changed', { detail: { department: nextAuth.activeDepartment } }));
      resetERPStateSyncBaseline();
      await syncERPState();
      await pullRecordsFromServer();
    } catch (error) {
      window.alert(error.message || 'Unable to switch department.');
    }
  };

  const handleDepartmentSelect = async (department) => {
    await handleDepartmentChange(department);
    const selected = getStoredAuth();
    if (selected?.activeDepartment) {
      startERPStateMirror();
      startRecordsSync();
    }
  };

  const handleLogout = () => {
    const saved = getStoredAuth();
    const base = window.location.port === '5173' ? `http://${window.location.hostname || 'localhost'}:3001/api` : '/api';
    if (saved?.token) fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${saved.token}` } }).catch(() => {});
    localStorage.removeItem('erp_auth');
    setAuth(null);
  };

  if (!erpReady) {
    return <div className="app-loading" aria-busy="true">Loading ERP</div>;
  }

  // If not authenticated, show Admin Login Portal
  if (!auth || !auth.isLoggedIn) {
    return (
      <>
        <LoginPage onLoginSuccess={handleLoginSuccess} />
        <SyncStatusBar />
      </>
    );
  }

  if (auth.roleKey !== 'admin' && Array.isArray(auth.assignments) && auth.assignments.length > 1 && !auth.activeDepartment) {
    return <DepartmentSelection auth={auth} onSelect={handleDepartmentSelect} />;
  }

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="app-shell">
        <Sidebar onLogout={handleLogout} mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
        {mobileNavOpen && <button type="button" className="mobile-sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
        <div className="page-area">
          <Header auth={auth} onDepartmentChange={handleDepartmentChange} onLogout={handleLogout} onMenuToggle={() => setMobileNavOpen((open) => !open)} />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<HomeRoute auth={auth} />} />
              <Route path="/dashboard" element={<HomeRoute auth={auth} />} />
              <Route path="/access-denied" element={<AccessDeniedHome />} />
              <Route path="/sales-dashboard" element={<Guard perm={['sales.enquiry', 'sales.quotation', 'sales.customer_order', 'sales_order.view']}><SalesDashboardPage /></Guard>} />
              <Route path="/quotation" element={<Guard perm="sales.quotation"><QuotationPage /></Guard>} />
              <Route path="/quotation/preview" element={<Guard perm="sales.quotation"><QuotationPreviewPage /></Guard>} />
              <Route path="/customer-purchase-order" element={<Guard perm="sales.customer_order"><CustomerPurchaseOrderPage /></Guard>} />
              <Route path="/sales-order" element={<Guard perm="sales_order.view"><SalesOrderPage /></Guard>} />
              <Route path="/production" element={<Guard perm="production.view"><ProductionPage /></Guard>} />
              <Route path="/inventory" element={<Guard perm="inventory.view"><InventoryPage /></Guard>} />
              <Route path="/store" element={<Navigate to="/inventory" replace />} />
              <Route path="/store/inventory" element={<Guard perm="inventory.view"><StoreInventoryPage view="dashboard" /></Guard>} />
              <Route path="/store/inventory/:view" element={<Guard perm="inventory.view"><StoreInventoryPage /></Guard>} />
              <Route path="/store/material-requests" element={<Guard perm="store.module"><StoreMaterialRequestsPage /></Guard>} />
              <Route path="/store/issues" element={<Guard perm="material_issue.view"><StoreIssuesPage /></Guard>} />
              <Route path="/store/returns" element={<Guard perm="material_return.view"><MaterialReturnsPage /></Guard>} />
              <Route path="/store/transactions" element={<Guard perm="inventory.transaction.view"><InventoryTransactionsPage /></Guard>} />
              <Route path="/store/expiry" element={<Guard perm="inventory.adjust"><ShelfLifePage /></Guard>} />
              {/* Store: Items to Review (new workflow). Legacy /store/sales-orders kept as an alias. */}
              <Route path="/store/item-requirements" element={<Guard perm="store.module"><StoreItemRequirementsPage /></Guard>} />
              <Route path="/store/sales-orders" element={<Guard perm="store.module"><StoreItemRequirementsPage /></Guard>} />
              <Route path="/production/item-requirements" element={<Guard perm="production.requirement.manage"><ProductionItemRequirementsPage /></Guard>} />
              <Route
                path="/purchase-indents"
                element={<Guard perm={['indent.view', 'indent.create', 'indent.review', 'indent.additional']}><PurchaseIndentsPage /></Guard>}
              />
              <Route
                path="/material-receipts"
                element={<Guard perm={['receipt.view', 'receipt.create']}><MaterialReceiptsPage /></Guard>}
              />
              <Route
                path="/vendor-supplier-record"
                element={<Guard perm={['receipt.view', 'receipt.create']}><VendorSupplierRecordPage /></Guard>}
              />
              <Route
                path="/quality-checks"
                element={<Guard perm={['production.qc.view', 'production.qc.manage', 'receipt.create']}><QualityCheckPage /></Guard>}
              />
              <Route
                path="/quality-report"
                element={<Guard perm={['production.qc.view', 'production.qc.manage', 'reports.view']}><QualityReportPage /></Guard>}
              />
              <Route
                path="/quality-module"
                element={<Guard perm={['production.qc.view', 'production.qc.manage']}><QualityModulePage /></Guard>}
              />
              <Route
                path="/debit-notes"
                element={hasAnyPermission('debitnote.view') ? <DebitNotesPage /> : <DebitNotesAccessDenied />}
              />
              <Route
                path="/workflow"
                element={<Guard perm={['store.module', 'purchase.order', 'production.view', 'sales_order.view', 'indent.view']}><WorkflowDashboardPage /></Guard>}
              />
              <Route path="/production/material-requests" element={<Guard perm="material_request.view"><ProductionMaterialRequestsPage /></Guard>} />
              <Route path="/production/bom" element={<Guard perm="production.view"><BOMPage /></Guard>} />
              <Route path="/ht-outsource" element={<Guard perm={['ht_outsource.view', 'material_request.create', 'purchase.order', 'store.module']}><HTOutsourcePage /></Guard>} />
              <Route path="/employees" element={<Guard perm="employee.view"><EmployeeMasterPage /></Guard>} />
        <Route path="/machines" element={<Guard perm="settings.view"><MachineMasterPage /></Guard>} />
              <Route path="/purchase-order" element={<Guard perm="purchase.order"><PurchaseOrderPage /></Guard>} />
              <Route path="/supplier-invoice" element={<Guard perm="purchase.supplier_invoice"><SupplierInvoicePage /></Guard>} />
              <Route path="/vendor-enquiry" element={<Guard perm="purchase_request.view"><VendorEnquiryPage /></Guard>} />
              <Route path="/vendor-enquiry/preview" element={<Guard perm="purchase_request.view"><VendorEnquiryPreviewPage /></Guard>} />
              <Route path="/vendor-quotations" element={<Guard perm="purchase_request.view"><VendorQuotationPage /></Guard>} />
              <Route path="/vendor-quotations/preview" element={<Guard perm="purchase_request.view"><VendorQuotationPreviewPage /></Guard>} />
              <Route path="/vendor-master" element={<Guard perm="purchase.order"><VendorMasterPage /></Guard>} />
              <Route path="/delivery-challan" element={<Guard perm="delivery.view"><DeliveryChallanPage /></Guard>} />
              <Route path="/customer-invoice" element={<Guard perm="invoice.view"><CustomerInvoicePage /></Guard>} />
              <Route path="/export-invoice" element={<Guard perm="invoice.view"><ExportInvoicePage /></Guard>} />
              <Route path="/settings" element={<Guard perm="settings.view"><SettingsPage /></Guard>} />
              <Route path="/backup-export" element={<Guard perm="backup.view"><BackupExportPage /></Guard>} />
              <Route path="/tally-export" element={<Guard perm="tally.export"><TallyExportPage /></Guard>} />
              <Route path="/project-request" element={<Guard perm={['sales.enquiry', 'job_card.view']}><ProjectRequestPage /></Guard>} />
              <Route path="/project-request/new" element={<Guard perm={['sales.enquiry', 'job_card.view']}><AddProjectRequestPage /></Guard>} />
              <Route path="/project-request/edit" element={<Guard perm={['sales.enquiry', 'job_card.view']}><AddProjectRequestPage /></Guard>} />
              <Route path="/add-project-request" element={<Guard perm={['sales.enquiry', 'job_card.view']}><AddProjectRequestPage /></Guard>} />
              <Route path="/project-request/:projectId" element={<Guard perm={['sales.enquiry', 'job_card.view']}><ProjectRequestPage /></Guard>} />
              <Route path="/ballooning" element={<Guard perm="ballooning.view"><BalloonScope><BallooningDashboardPage /></BalloonScope></Guard>} />
              <Route path="/ballooning/new" element={<Guard perm="ballooning.manage"><BalloonScope><BallooningNewProjectPage /></BalloonScope></Guard>} />
              <Route path="/ballooning/project/:id" element={<Guard perm="ballooning.view"><BalloonScope flush><BallooningWorkspacePage /></BalloonScope></Guard>} />
              <Route path="/ballooning/project/:id/approval" element={<Guard perm={['ballooning.approve', 'ballooning.manage']}><BalloonScope><BallooningApprovalPage /></BalloonScope></Guard>} />
              <Route path="/ballooning/project/:id/export" element={<Guard perm="ballooning.view"><BalloonScope><BallooningExportPage /></BalloonScope></Guard>} />
              <Route path="/reports" element={<Guard perm={['reports.view', 'purchase.reports.view']}><ReportsHomePage /></Guard>} />
              <Route path="/reports/inventory/stock-status" element={<Guard perm="reports.view"><InventoryStockStatusPage /></Guard>} />
              <Route path="/reports/inventory/location-lot-ledger" element={<Guard perm="reports.view"><InventoryLotReportPage reportType="locationLedger" /></Guard>} />
              <Route path="/reports/inventory/lot-stock-statement" element={<Guard perm="reports.view"><InventoryLotReportPage reportType="stockStatement" /></Guard>} />
              <Route path="/reports/inventory/expired-lots" element={<Guard perm="reports.view"><InventoryLotReportPage reportType="expiredLots" /></Guard>} />
              <Route path="/reports/inventory/lot-availability" element={<Guard perm="reports.view"><InventoryLotReportPage reportType="availability" /></Guard>} />
              <Route path="/reports/inventory/lot-stock-dimensions" element={<Guard perm="reports.view"><InventoryLotReportPage reportType="dimensions" /></Guard>} />
              <Route path="/reports/inventory/valuation" element={<Guard perm="reports.view"><InventoryValuationPage /></Guard>} />
              <Route path="/reports/inventory/material-issues" element={<Guard perm="reports.view"><MaterialIssueRegisterPage /></Guard>} />
              <Route path="/reports/inventory/available-issued" element={<Guard perm="reports.view"><TrackAReportPage reportType="stock" /></Guard>} />
              <Route path="/reports/inventory/mrn-detail" element={<Guard perm="reports.view"><TrackAReportPage reportType="mrnDetail" /></Guard>} />
              <Route path="/reports/purchase/inward" element={<Guard perm={['reports.view', 'purchase.reports.view']}><TrackAReportPage reportType="inward" /></Guard>} />
              <Route path="/reports/purchase/grn-po-pr" element={<Guard perm={['reports.view', 'purchase.reports.view']}><TrackAReportPage reportType="grnPoPr" /></Guard>} />
              <Route path="/reports/purchase/advance-shipment" element={<Guard perm={['reports.view', 'purchase.reports.view']}><TrackAReportPage reportType="advanceShipment" /></Guard>} />
              <Route path="/reports/sales/customer-material-status" element={<Guard perm="reports.view"><TrackAReportPage reportType="customerMaterialStatus" /></Guard>} />
              <Route path="/reports/masters/suppliers" element={<Guard perm="reports.view"><TrackAReportPage reportType="suppliers" /></Guard>} />
              <Route path="/reports/outsource/material-with-supplier" element={<Guard perm="reports.view"><MaterialWithSupplierPage /></Guard>} />
              <Route path="/reports/masters/items" element={<Guard perm="reports.view"><ItemListPage /></Guard>} />
              <Route path="/reports/masters/customers" element={<Guard perm="reports.view"><CustomerListPage /></Guard>} />
              <Route path="/reports/sales-register" element={<Guard perm="reports.view"><SalesRegisterPage /></Guard>} />
              <Route path="/reports/sales-orders" element={<Guard perm="reports.view"><SalesOrderAgeingPage /></Guard>} />
              <Route path="/reports/purchase/creditors" element={<Guard perm={['reports.view', 'purchase.reports.view']}><SupplierOutstandingPage /></Guard>} />
              <Route path="/reports/purchase/stale-orders" element={<Guard perm={['reports.view', 'purchase.reports.view']}><StalePurchaseOrdersPage /></Guard>} />
              <Route path="/reports/purchase/pre-closed-orders" element={<Guard perm={['reports.view', 'purchase.reports.view']}><PreClosedPurchaseOrdersPage /></Guard>} />
              <Route path="/reports/purchase/supplier-items" element={<Guard perm={['reports.view', 'purchase.reports.view']}><SupplierWiseItemsPage /></Guard>} />
              <Route path="/reports/production/planned-actual" element={<Guard perm="reports.view"><JobCardPlannedActualPage /></Guard>} />
              <Route path="/reports/production/jc-material" element={<Guard perm="reports.view"><JobCardMaterialPage /></Guard>} />
              <Route path="/reports/production/ready-despatch" element={<Guard perm="reports.view"><ReadyToDespatchPage /></Guard>} />
              <Route path="/customers" element={<Guard perm="sales_order.view"><CustomersPage /></Guard>} />
              <Route path="*" element={<Navigate to={homePathFor(auth)} replace />} />
            </Routes>
          </main>
        </div>
        <SyncStatusBar />
      </div>
    </BrowserRouter>
  );
}

export default App;
