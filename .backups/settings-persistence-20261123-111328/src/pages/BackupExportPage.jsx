import React, { useState, useEffect } from 'react';
import { Boxes, ClipboardList, Factory, FileText, Settings2, Trash2 } from 'lucide-react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { exportToCSV } from '../utils/csvExporter.js';
import {
  getBackupAuditLogs,
  triggerFullManualBackupAndDownload,
  restoreSystemFromJSON,
  checkAndPerformDailyAutoBackup,
  formatAuditDateTime,
  collectAllERPData
} from '../utils/backupManager.js';

const BackupExportPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const [stats, setStats] = useState({
    enquiries: 0,
    quotations: 0,
    salesOrders: 0,
    customerPOs: 0,
    jobCards: 0,
    inventory: 0,
    supplierPOs: 0,
    supplierInvoices: 0,
    deliveryChallans: 0,
    customerInvoices: 0,
    totalRecords: 0
  });

  const [auditLogs, setAuditLogs] = useState([]);
  const [lastBackupTime, setLastBackupTime] = useState('');
  const [restoreStatus, setRestoreStatus] = useState(null);

  const refreshData = () => {
    try {
      const getCount = (key) => {
        const val = localStorage.getItem(key);
        return val ? JSON.parse(val).length : 0;
      };

      const { totalRecordCount } = collectAllERPData();

      setStats({
        enquiries: getCount('projectRequests'),
        quotations: getCount('quotationHistory'),
        salesOrders: getCount('salesOrderHistory'),
        customerPOs: getCount('customerPOHistory'),
        jobCards: getCount('productionJobCards'),
        inventory: getCount('inventoryItems'),
        supplierPOs: getCount('supplierPOHistory'),
        supplierInvoices: getCount('supplierInvoiceHistory'),
        deliveryChallans: getCount('deliveryChallanHistory'),
        customerInvoices: getCount('customerInvoiceHistory'),
        totalRecords: totalRecordCount
      });

      const logs = getBackupAuditLogs();
      setAuditLogs(logs);

      const lastIso = localStorage.getItem('lastBackupTimestamp') || (logs[0] ? logs[0].timestamp : null);
      if (lastIso) {
        setLastBackupTime(formatAuditDateTime(lastIso));
      } else {
        setLastBackupTime('Today, Automated');
      }
    } catch (err) {
      console.warn('Error refreshing backup page data', err);
    }
  };

  useEffect(() => {
    // Run daily auto backup if not done yet
    checkAndPerformDailyAutoBackup();
    refreshData();
  }, []);

  // Manual Full Backup
  const handleManualBackup = () => {
    const log = triggerFullManualBackupAndDownload();
    setRestoreStatus({
      success: true,
      message: `Full System Backup downloaded successfully at ${log.time} on ${log.date} (${log.totalRecords} total records secured).`
    });
    refreshData();
  };

  // 1. Export Inventory CSV
  const handleExportInventory = () => {
    const raw = localStorage.getItem('inventoryItems');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No inventory items to export.');
      return;
    }

    const rows = items.map((it, idx) => ({ ...it, slNo: idx + 1 }));

    const headers = [
      { key: 'slNo', label: 'SL.No' },
      { key: 'itemName', label: 'Item Description' },
      { key: 'category', label: 'Category' },
      { key: 'hsnSac', label: 'HSN/SAC' },
      { key: 'unit', label: 'Unit' },
      { key: 'currentQty', label: 'Current In Stock' },
      { key: 'reservedQty', label: 'Reserved Qty' },
      { key: 'minReorderLevel', label: 'Min Reorder Level' },
      { key: 'unitCost', label: 'Unit Cost (INR)' },
      { key: 'sellingPrice', label: 'Selling Price (INR)' },
      { key: 'location', label: 'Warehouse Location' }
    ];

    exportToCSV(`vyavasta-inventory-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // 2. Export Quotations CSV
  const handleExportQuotations = () => {
    const raw = localStorage.getItem('quotationHistory');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No quotations to export.');
      return;
    }

    const rows = items.map((q) => ({
      date: q.date,
      quotationNumber: q.reference,
      company: q.company,
      totalAmount: q.total,
      status: q.balanceStatus || 'Active',
      itemsCount: q.payload?.items?.length || 0,
      projectId: q.payload?.quotationDetails?.projectId || '-'
    }));

    const headers = [
      { key: 'date', label: 'Date' },
      { key: 'quotationNumber', label: 'Quotation Number' },
      { key: 'company', label: 'Customer / Company' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'status', label: 'Status' },
      { key: 'itemsCount', label: 'Items Count' },
      { key: 'projectId', label: 'Project ID' }
    ];

    exportToCSV(`vyavasta-quotations-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // 3. Export Sales Orders CSV
  const handleExportSalesOrders = () => {
    const raw = localStorage.getItem('salesOrderHistory');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No sales orders to export.');
      return;
    }

    const rows = items.map((so) => ({
      date: so.date,
      soNumber: so.reference,
      customer: so.customer,
      projectId: so.projectId || '-',
      quotationRef: so.quotationRef || '-',
      deliveryDueDate: so.dueDate || '-',
      totalAmount: so.total,
      status: so.status || 'Active'
    }));

    const headers = [
      { key: 'date', label: 'SO Date' },
      { key: 'soNumber', label: 'Sales Order No' },
      { key: 'customer', label: 'Customer' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'quotationRef', label: 'Quotation Ref' },
      { key: 'deliveryDueDate', label: 'Delivery Due Date' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'status', label: 'Status' }
    ];

    exportToCSV(`vyavasta-sales-orders-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // 4. Export Customer Invoices CSV
  const handleExportInvoices = () => {
    const raw = localStorage.getItem('customerInvoiceHistory');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No customer invoices to export.');
      return;
    }

    const rows = items.map((inv) => ({
      date: inv.date,
      invoiceNumber: inv.reference,
      quotationRef: inv.quotationRef || '-',
      customer: inv.customer,
      totalAmount: inv.total
    }));

    const headers = [
      { key: 'date', label: 'Invoice Date' },
      { key: 'invoiceNumber', label: 'Invoice Number' },
      { key: 'quotationRef', label: 'Quotation Ref' },
      { key: 'customer', label: 'Customer / Company' },
      { key: 'totalAmount', label: 'Total Amount' }
    ];

    exportToCSV(`vyavasta-tax-invoices-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // 5. Export Supplier POs CSV
  const handleExportSupplierPOs = () => {
    const raw = localStorage.getItem('supplierPOHistory');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No supplier purchase orders to export.');
      return;
    }

    const rows = items.map((po) => ({
      date: po.date,
      poNumber: po.reference,
      vendor: po.vendor,
      projectRef: po.projectRef || '-',
      dueDate: po.dueDate || '-',
      totalAmount: po.total,
      status: po.status || 'Issued'
    }));

    const headers = [
      { key: 'date', label: 'PO Date' },
      { key: 'poNumber', label: 'Purchase Order No' },
      { key: 'vendor', label: 'Supplier / Vendor' },
      { key: 'projectRef', label: 'Project Ref' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'status', label: 'Status' }
    ];

    exportToCSV(`vyavasta-purchase-orders-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // 6. Export Production Job Cards CSV
  const handleExportJobCards = () => {
    const raw = localStorage.getItem('productionJobCards');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No job cards to export.');
      return;
    }

    const rows = items.map((jc) => ({
      jobCardNumber: jc.jobCardNumber,
      projectId: jc.projectId || '-',
      projectName: jc.projectName || '-',
      soRef: jc.salesOrderRef || '-',
      customer: jc.customerName || '-',
      partName: jc.partName,
      drawingNo: jc.drawingNumber || '-',
      orderQty: jc.orderQuantity,
      startDate: jc.startDate,
      targetDate: jc.targetDate,
      materialType: jc.rawMaterial?.type || '-',
      status: jc.status,
      qcResult: jc.qualityControl?.finalQC?.disposition || 'Pending'
    }));

    const headers = [
      { key: 'jobCardNumber', label: 'Job Card No' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'projectName', label: 'Project Name' },
      { key: 'soRef', label: 'Sales Order Ref' },
      { key: 'customer', label: 'Customer' },
      { key: 'partName', label: 'Part Name' },
      { key: 'drawingNo', label: 'Drawing No' },
      { key: 'orderQty', label: 'Order Qty' },
      { key: 'startDate', label: 'Start Date' },
      { key: 'targetDate', label: 'Target Date' },
      { key: 'materialType', label: 'Material Form' },
      { key: 'status', label: 'Status' },
      { key: 'qcResult', label: 'QC Result' }
    ];

    exportToCSV(`vyavasta-production-jobcards-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // 7. Export Customer Enquiries CSV
  const handleExportEnquiries = () => {
    const raw = localStorage.getItem('projectRequests');
    const items = raw ? JSON.parse(raw) : [];
    if (items.length === 0) {
      alert('No customer enquiries to export.');
      return;
    }

    const rows = items.map((pr) => ({
      projectId: pr.projectId,
      company: pr.companyName,
      customer: pr.customerName,
      phone: pr.phone || '-',
      email: pr.email || '-',
      requestedDate: pr.requestedDate,
      targetDate: pr.targetDeliveryDate || '-',
      itemCount: pr.items?.length || 0,
      firstItemName: pr.items?.[0]?.itemName || '-',
      firstItemDrawing: pr.items?.[0]?.drawingNo || '-'
    }));

    const headers = [
      { key: 'projectId', label: 'Enquiry / Project ID' },
      { key: 'company', label: 'Company Name' },
      { key: 'customer', label: 'Customer Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'requestedDate', label: 'Enquiry Date' },
      { key: 'targetDate', label: 'Target Date' },
      { key: 'itemCount', label: 'Total Items' },
      { key: 'firstItemName', label: 'Primary Component' },
      { key: 'firstItemDrawing', label: 'Drawing No.' }
    ];

    exportToCSV(`vyavasta-customer-enquiries-${new Date().toISOString().slice(0, 10)}`, headers, rows);
  };

  // Restore JSON file
  const handleRestoreFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (window.confirm('Restore system data from this backup file? Existing records will be updated with backup contents.')) {
          const log = restoreSystemFromJSON(json);
          setRestoreStatus({
            success: true,
            message: `Successfully restored ${log.totalRecords} records from backup file at ${log.time} on ${log.date}!`
          });
          refreshData();
          setTimeout(() => window.location.reload(), 1500);
        }
      } catch (err) {
        setRestoreStatus({ success: false, message: 'Failed to parse backup file: ' + err.message });
      }
    };
    reader.readAsText(file);
  };

  // Clear all test data
  const handleClearAllData = () => {
    if (
      window.confirm(
        'Are you sure you want to delete all test records? This clears Quotations, Sales Orders, Customer POs, Project Requests, Job Cards, Material Requests, Store Issues/Returns, Purchase Requests, Vendor Enquiries & Quotations, HT Outsource requests, Inventory, Invoices, Challans, audit log and notifications — and resets document numbering back to 000001.'
      )
    ) {
      const keysToClear = [
        // Sales
        'projectRequests',
        'quotationHistory',
        'currentQuotation',
        'customerPOHistory',
        'salesOrderHistory',
        // Production
        'productionJobCards',
        // Store / Warehouse
        'materialRequests',
        'storeIssueHistory',
        'materialReturnHistory',
        'storePurchaseRequests',
        'employeeIssueLog',
        // Inventory
        'inventoryItems',
        'stockTransactions',
        'inventoryBatches',
        'storeGRNs',
        'stockTransfers',
        'stockVerifications',
        'purchaseReturnHistory',
        'salesReturnHistory',
        // Purchase
        'supplierPOHistory',
        'supplierInvoiceHistory',
        'vendorEnquiries',
        'vendorQuotations',
        'currentVendorEnquiry',
        'currentVendorQuotation',
        'htOutsourceRequests',
        // Dispatch & Billing
        'deliveryChallanHistory',
        'customerInvoiceHistory',
        // Activity trails (they only reference the test records above)
        'storeAuditLog',
        'notifications'
      ];
      // Document-number counters so MR/SI/VE/VQ/HTR/... restart from 000001.
      // vendorMasterSequence is deliberately NOT reset (vendor master is real data).
      const sequencesToReset = [
        'materialRequestSequence',
        'storeIssueSequence',
        'materialReturnSequence',
        'storePurchaseRequestSequence',
        'vendorEnquirySequence',
        'vendorQuotationSequence',
        'htOutsourceSequence',
        'grnSequence',
        'stockTransferSequence',
        'stockVerificationSequence',
        'projectRequestSequence',
        'quotationSequence',
        'customerPOSequence',
        'purchaseOrderSequence',
        'customerInvoiceSequence'
      ];
      keysToClear.forEach((k) => localStorage.removeItem(k));
      sequencesToReset.forEach((k) => localStorage.removeItem(k));
      setRestoreStatus({ success: true, message: 'All test data has been successfully deleted! System is clean and ready.' });
      setTimeout(() => window.location.reload(), 1200);
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Daily Backup & Data Export</h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          <button
            className="button-secondary"
            style={{ color: '#dc2626', borderColor: '#fecaca' }}
            onClick={handleClearAllData}
          >
            <Trash2 size={15} aria-hidden="true" /> Delete All Test Data
          </button>
          <button className="button-primary" onClick={handleManualBackup}>
            💾 Download Full System Backup (.json)
          </button>
        </div>
      </div>

      {restoreStatus && (
        <div
          style={{
            background: restoreStatus.success ? '#dcfce7' : '#fee2e2',
            color: restoreStatus.success ? '#166534' : '#991b1b',
            padding: '14px 20px',
            borderRadius: '10px',
            marginBottom: '22px',
            fontWeight: '600',
            border: `1px solid ${restoreStatus.success ? '#bbf7d0' : '#fecaca'}`
          }}
        >
          {restoreStatus.message}
        </div>
      )}

      {/* Daily Backup Status & Live KPIs */}
      <div className="kpi-grid" style={{ marginBottom: '24px', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div className="kpi-card" style={{ borderLeft: '4px solid #16a34a' }}>
          <span className="kpi-title">Daily Automated Backup</span>
          <div className="kpi-value" style={{ color: '#166534', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: '#16a34a' }}></span>
            Active (Everyday)
          </div>
          <span className="kpi-delta positive">Runs daily on system use</span>
        </div>
        <div className="kpi-card" style={{ borderLeft: '4px solid #2563eb' }}>
          <span className="kpi-title">Last Backup Recorded</span>
          <div className="kpi-value" style={{ fontSize: '16px', color: '#1e293b' }}>
            {lastBackupTime || 'Today, Active'}
          </div>
          <span className="kpi-delta neutral">Timestamp with date & time</span>
        </div>
      </div>

      {/* 1-Click Spreadsheet Exports */}
      <div className="content-block" style={{ marginBottom: '28px' }}>
        <div className="block-header" style={{ marginBottom: '14px' }}>
          <h2>1-Click Excel / CSV Spreadsheet Exports</h2>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            Download tabular datasets directly compatible with Microsoft Excel, Google Sheets, and accounting software.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
          {/* Enquiries */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '15px', color: '#0f172a' }}><ClipboardList size={16} aria-hidden="true" /> Customer Enquiries</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.enquiries} Enquiries
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export customer RFQs, Project IDs, drawing numbers, and material specifications.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportEnquiries}>
              📥 Export Enquiries (.csv)
            </button>
          </div>

          {/* Quotations */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '15px', color: '#0f172a' }}><FileText size={16} aria-hidden="true" /> Quotations</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.quotations} Quotes
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export quotation reference history, customer names, project IDs, grand totals, and conversion statuses.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportQuotations}>
              📥 Export Quotations (.csv)
            </button>
          </div>

          {/* Sales Orders */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ fontSize: '15px', color: '#0f172a' }}>📑 Sales Orders</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.salesOrders} Orders
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export confirmed customer sales orders, quotation links, order values, and fulfillment statuses.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportSalesOrders}>
              📥 Export Sales Orders (.csv)
            </button>
          </div>

          {/* Customer Invoices */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ fontSize: '15px', color: '#0f172a' }}>💰 Customer Tax Invoices</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.customerInvoices} Invoices
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export billed sales invoices, invoice dates, customer GSTIN, and billed revenue.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportInvoices}>
              📥 Export Invoices (.csv)
            </button>
          </div>

          {/* Inventory */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '15px', color: '#0f172a' }}><Boxes size={16} aria-hidden="true" /> Inventory Catalog</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.inventory} Items
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export parts, raw materials, current stock quantities, valuation, HSN codes, and reorder levels.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportInventory}>
              📥 Export Inventory (.csv)
            </button>
          </div>

          {/* Supplier POs */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '15px', color: '#0f172a' }}><Factory size={16} aria-hidden="true" /> Purchase Orders (Supplier)</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.supplierPOs} POs
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export procurement POs issued to raw material vendors, project references, and delivery dates.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportSupplierPOs}>
              📥 Export Purchase Orders (.csv)
            </button>
          </div>

          {/* Production Job Cards */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '18px', background: '#f8fafc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '15px', color: '#0f172a' }}><Settings2 size={16} aria-hidden="true" /> Production Job Cards</strong>
              <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#2563eb', background: '#dbeafe', padding: '2px 8px', borderRadius: '10px' }}>
                {stats.jobCards} Cards
              </span>
            </div>
            <p style={{ fontSize: '12.5px', color: '#64748b', marginBottom: '14px' }}>
              Export manufacturing route cards, drawing numbers, raw material form types, and QC results.
            </p>
            <button className="button-secondary" style={{ width: '100%' }} onClick={handleExportJobCards}>
              📥 Export Job Cards (.csv)
            </button>
          </div>
        </div>
      </div>

      {/* System Backup, Restore & Data Reset Section */}
      <div className="content-block">
        <div className="block-header">
          <h2>Complete System Backup, Restore & Data Reset</h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginTop: '14px' }}>
          {/* Backup Box */}
          <div style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '20px', background: '#ffffff' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '8px', color: '#0f172a' }}>Create Full System Backup</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5', marginBottom: '16px' }}>
              Generates a single comprehensive JSON archive containing all customer enquiries, quotations, sales orders, customer POs, job cards, inventory stock levels, vendor bills, delivery challans, and company settings.
            </p>
            <button className="button-primary" style={{ width: '100%' }} onClick={handleManualBackup}>
              💾 Download Full ERP Backup (.json)
            </button>
          </div>

          {/* Restore Box */}
          <div style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '20px', background: '#ffffff' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '8px', color: '#0f172a' }}>Restore from Backup Archive</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5', marginBottom: '16px' }}>
              Select a previously downloaded `.json` backup file to restore all ERP database records and settings.
            </p>
            <label
              className="button-secondary"
              style={{
                display: 'block',
                textAlign: 'center',
                cursor: 'pointer',
                padding: '10px',
                width: '100%',
                boxSizing: 'border-box'
              }}
            >
              📂 Select Backup File (.json) to Restore
              <input
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleRestoreFile}
              />
            </label>
          </div>

          {/* Wipe / Clean Box */}
          <div style={{ border: '1px solid #fecaca', borderRadius: '10px', padding: '20px', background: '#fff5f5' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '8px', color: '#991b1b' }}>Clean All Test Data</h3>
            <p style={{ fontSize: '13px', color: '#7f1d1d', lineHeight: '1.5', marginBottom: '16px' }}>
              Deletes all past test quotations, test orders, job cards, invoices, and inventory logs to start completely fresh.
            </p>
            <button
              className="button-secondary"
              style={{ width: '100%', color: '#b91c1c', borderColor: '#fca5a5', fontWeight: 'bold' }}
              onClick={handleClearAllData}
            >
              <Trash2 size={15} aria-hidden="true" /> Wipe All Test Records
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BackupExportPage;
