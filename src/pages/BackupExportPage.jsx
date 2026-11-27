import React, { useState, useEffect } from 'react';
import { Boxes, ClipboardList, Factory, FileText, Settings2, Trash2 } from 'lucide-react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { downloadBackupWorkbook, buildFullBackupWorkbookSheets } from '../utils/backupWorkbook.js';
import {
  triggerFullManualBackupAndDownload,
  restoreSystemFromJSON,
  collectAllERPData
} from '../utils/backupManager.js';
import { listJobCards } from '../services/productionApi.js';
import { listInventoryItems } from '../services/inventoryApi.js';
import { listQuotations } from '../services/quotationApi.js';
import { listSalesOrders } from '../services/salesOrderApi.js';
import { listCustomerInvoices } from '../services/customerInvoiceApi.js';
import { listEnquiries } from '../services/enquiryApi.js';
import { getCustomerPurchaseOrders } from '../services/customerPurchaseOrderApi.js';
import { listDeliveryChallans } from '../services/deliveryChallanApi.js';
import { listPurchaseOrders, listSupplierInvoicesFromPostgres } from '../services/procurementIntakeApi.js';
import {
  createDatabaseBackup,
  downloadDatabaseBackup,
  getDatabaseBackupStatus,
  listDatabaseBackups,
  restoreDatabaseBackup,
  verifyDatabaseBackup
} from '../services/databaseBackupApi.js';
import { isAdmin } from '../utils/auth.js';

const exportTable = (baseName, sheetName, headers, rows) => {
  const dateKeys = headers.filter(({ key, label }) => /date|timestamp/i.test(`${key} ${label}`)).map(({ key }) => key);
  const numberKeys = headers.filter(({ key, label }) => /amount|qty|quantity|count|stock|cost|price|level|slno/i.test(`${key} ${label}`)).map(({ key }) => key);
  downloadBackupWorkbook(`${baseName}-${new Date().toISOString().slice(0, 10)}.xlsx`, `VYAVASTA ERP ${sheetName}`, [{ name: sheetName, columns: headers, rows, dateKeys, numberKeys }]);
};

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

  const [restoreStatus, setRestoreStatus] = useState(null);
  const [databaseBackupStatus, setDatabaseBackupStatus] = useState(null);
  const [databaseBackups, setDatabaseBackups] = useState([]);
  const [backupBusy, setBackupBusy] = useState('');
  const [backupError, setBackupError] = useState('');
  const [exportDataError, setExportDataError] = useState('');

  const refreshData = async () => {
    setExportDataError('');
    try {
      const [
        enquiries, quotations, salesOrders, customerPOs, jobCards,
        inventory, supplierPOs, supplierInvoices, deliveryChallans, customerInvoices
      ] = await Promise.all([
        listEnquiries(),
        listQuotations(),
        listSalesOrders(),
        getCustomerPurchaseOrders(),
        listJobCards(),
        listInventoryItems(),
        listPurchaseOrders(),
        listSupplierInvoicesFromPostgres(),
        listDeliveryChallans(),
        listCustomerInvoices()
      ]);
      setStats({
        enquiries: enquiries.length,
        quotations: quotations.length,
        salesOrders: salesOrders.length,
        customerPOs: customerPOs.length,
        jobCards: jobCards.length,
        inventory: inventory.length,
        supplierPOs: supplierPOs.length,
        supplierInvoices: supplierInvoices.length,
        deliveryChallans: deliveryChallans.length,
        customerInvoices: customerInvoices.length,
        totalRecords: enquiries.length + quotations.length + salesOrders.length + customerPOs.length
          + jobCards.length + inventory.length + supplierPOs.length + supplierInvoices.length
          + deliveryChallans.length + customerInvoices.length
      });
    } catch (err) {
      setExportDataError(`PostgreSQL export data counts could not be loaded: ${err.message}`);
    }
  };

  const exportFromPostgres = async ({ label, loader, emptyMessage, baseName, sheetName, headers, mapRows }) => {
    setExportDataError('');
    try {
      const items = await loader();
      if (!Array.isArray(items)) throw new Error('The API returned an invalid records list.');
      if (items.length === 0) {
        setExportDataError(emptyMessage);
        return;
      }
      exportTable(baseName, sheetName, headers, mapRows(items));
    } catch (error) {
      setExportDataError(`${label} could not be loaded from PostgreSQL: ${error.message}`);
    }
  };

  const refreshPostgresBackups = async () => {
    setBackupError('');
    try {
      const status = await getDatabaseBackupStatus();
      setDatabaseBackupStatus(status);
      setDatabaseBackups(await listDatabaseBackups());
    } catch (err) {
      setBackupError(err.message || 'PostgreSQL backup history could not be loaded.');
    }
  };

  useEffect(() => {
    refreshData();
    refreshPostgresBackups();
  }, []);

  const handleManualBackup = () => {
    const { dataset } = collectAllERPData();
    const log = triggerFullManualBackupAndDownload();
    const sheets = buildFullBackupWorkbookSheets(dataset);
    if (sheets.length) downloadBackupWorkbook(`VYAVASTA-full-backup-data-${new Date().toISOString().slice(0, 10)}.xlsx`, 'VYAVASTA ERP Full Backup Data', sheets);
    setRestoreStatus({
      success: true,
      message: `Legacy browser-only archive downloaded at ${log.time} on ${log.date} (${log.totalRecords} browser records). It is not a PostgreSQL backup.`
    });
    refreshData();
  };

  const handleCreatePostgresBackup = async () => {
    setBackupBusy('create');
    setBackupError('');
    try {
      await createDatabaseBackup();
      await refreshPostgresBackups();
    } catch (err) {
      setBackupError(err.message || 'PostgreSQL backup could not be created.');
    } finally { setBackupBusy(''); }
  };

  const handleVerifyPostgresBackup = async (id) => {
    setBackupBusy(id);
    setBackupError('');
    try {
      await verifyDatabaseBackup(id);
      await refreshPostgresBackups();
    } catch (err) {
      setBackupError(err.message || 'PostgreSQL backup integrity check failed.');
    } finally { setBackupBusy(''); }
  };

  const handleDownloadPostgresBackup = async (id) => {
    setBackupBusy(id);
    setBackupError('');
    try { await downloadDatabaseBackup(id); }
    catch (err) { setBackupError(err.message || 'PostgreSQL backup could not be downloaded.'); }
    finally { setBackupBusy(''); }
  };

  const handleRestorePostgresBackup = async (backup) => {
    if (!databaseBackupStatus?.restoreEnabled) return;
    const confirmationPhrase = `RESTORE ${backup.id}`;
    const confirmation = window.prompt(
      `This replaces database contents. Current database identity fingerprint: ${databaseBackupStatus.identityFingerprint}\nType "${confirmationPhrase}" to continue.`
    );
    if (confirmation !== confirmationPhrase) return;
    const reason = window.prompt('Enter the recovery reason (required):');
    if (!reason?.trim()) return;
    setBackupBusy(backup.id);
    setBackupError('');
    try {
      const result = await restoreDatabaseBackup(backup.id, {
        confirmation,
        identityFingerprint: databaseBackupStatus.identityFingerprint,
        reason: reason.trim()
      });
      setRestoreStatus({
        success: true,
        message: `PostgreSQL restore completed. Safety backup ${result.safetyBackupId} was created first.`
      });
      await refreshPostgresBackups();
    } catch (err) {
      setBackupError(err.message || 'PostgreSQL restore did not complete.');
    } finally { setBackupBusy(''); }
  };

  // 1. Export Inventory XLSX
  const handleExportInventory = () => exportFromPostgres({
    label: 'Inventory',
    loader: listInventoryItems,
    emptyMessage: 'No inventory items are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-inventory',
    sheetName: 'Inventory Catalog',
    mapRows: (items) => items.map((item, index) => ({
      ...item.payload,
      slNo: index + 1,
      itemName: item.material_name || item.itemName || item.payload?.itemName || '',
      category: item.category || item.payload?.category || '',
      hsnSac: item.hsn_code || item.hsnSac || item.payload?.hsnSac || '',
      unit: item.unit || item.payload?.unit || '',
      currentQty: item.current_qty ?? item.currentQty ?? item.payload?.currentQty ?? 0,
      reservedQty: item.reserved_qty ?? item.reservedQty ?? item.payload?.reservedQty ?? 0,
      minReorderLevel: item.reorder_level ?? item.minReorderLevel ?? item.payload?.minReorderLevel ?? 0,
      unitCost: item.unit_price ?? item.unitCost ?? item.payload?.unitCost ?? 0,
      sellingPrice: item.selling_price ?? item.sellingPrice ?? item.payload?.sellingPrice ?? 0,
      location: item.location || item.payload?.location || ''
    })),
    headers: [
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
    ]
  });

  // 2. Export Quotations XLSX
  const handleExportQuotations = () => exportFromPostgres({
    label: 'Quotations',
    loader: listQuotations,
    emptyMessage: 'No quotations are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-quotations',
    sheetName: 'Quotations',
    mapRows: (items) => items.map((q) => ({
      date: q.date || q.payload?.quotationDetails?.quotationDate,
      quotationNumber: q.reference || q.quotationNumber,
      company: q.company || q.payload?.customerDetails?.companyName || q.payload?.customerDetails?.customerName,
      totalAmount: q.total || q.payload?.totals?.grandTotal,
      status: q.balanceStatus || q.status || 'Active',
      itemsCount: q.payload?.items?.length || 0,
      projectId: q.payload?.quotationDetails?.projectId || '-'
    })),
    headers: [
      { key: 'date', label: 'Date' },
      { key: 'quotationNumber', label: 'Quotation Number' },
      { key: 'company', label: 'Customer / Company' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'status', label: 'Status' },
      { key: 'itemsCount', label: 'Items Count' },
      { key: 'projectId', label: 'Project ID' }
    ]
  });

  // 3. Export Sales Orders XLSX
  const handleExportSalesOrders = () => exportFromPostgres({
    label: 'Sales Orders',
    loader: listSalesOrders,
    emptyMessage: 'No sales orders are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-sales-orders',
    sheetName: 'Sales Orders',
    mapRows: (items) => items.map((so) => ({
      date: so.date || so.payload?.soDetails?.soDate,
      soNumber: so.reference || so.soNumber,
      customer: so.customer || so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName,
      projectId: so.projectId || so.payload?.soDetails?.projectId || '-',
      quotationRef: so.quotationRef || so.payload?.soDetails?.quotationRef || '-',
      deliveryDueDate: so.dueDate || so.payload?.soDetails?.deliveryDate || '-',
      totalAmount: so.total || so.payload?.totals?.grandTotal,
      status: so.status || 'Active'
    })),
    headers: [
      { key: 'date', label: 'SO Date' },
      { key: 'soNumber', label: 'Sales Order No' },
      { key: 'customer', label: 'Customer' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'quotationRef', label: 'Quotation Ref' },
      { key: 'deliveryDueDate', label: 'Delivery Due Date' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'status', label: 'Status' }
    ]
  });

  // 4. Export Customer Invoices XLSX
  const handleExportInvoices = () => exportFromPostgres({
    label: 'Customer Invoices',
    loader: listCustomerInvoices,
    emptyMessage: 'No customer invoices are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-tax-invoices',
    sheetName: 'Customer Tax Invoices',
    mapRows: (items) => items.map((invoice) => ({
      date: invoice.date || invoice.payload?.invoiceDetails?.invoiceDate,
      invoiceNumber: invoice.reference || invoice.payload?.invoiceDetails?.invoiceNumber,
      quotationRef: invoice.quotationRef || invoice.payload?.invoiceDetails?.quotationRef || '-',
      customer: invoice.company || invoice.payload?.billTo?.name || invoice.payload?.customerDetails?.companyName || invoice.payload?.customerDetails?.customerName,
      totalAmount: invoice.total || invoice.payload?.totals?.grandTotal
    })),
    headers: [
      { key: 'date', label: 'Invoice Date' },
      { key: 'invoiceNumber', label: 'Invoice Number' },
      { key: 'quotationRef', label: 'Quotation Ref' },
      { key: 'customer', label: 'Customer / Company' },
      { key: 'totalAmount', label: 'Total Amount' }
    ]
  });

  // 5. Export Supplier POs XLSX
  const handleExportSupplierPOs = () => exportFromPostgres({
    label: 'Supplier Purchase Orders',
    loader: listPurchaseOrders,
    emptyMessage: 'No supplier purchase orders are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-purchase-orders',
    sheetName: 'Supplier Purchase Orders',
    mapRows: (items) => items.map((po) => ({
      date: po.date || po.payload?.poDetails?.poDate,
      poNumber: po.reference || po.poNumber,
      vendor: po.vendor || po.vendorName || po.payload?.vendorDetails?.vendorName,
      projectRef: po.projectRef || po.payload?.poDetails?.projectRef || '-',
      dueDate: po.dueDate || po.payload?.poDetails?.deliveryDate || '-',
      totalAmount: po.total || po.payload?.totals?.grandTotal,
      status: po.status || 'Issued'
    })),
    headers: [
      { key: 'date', label: 'PO Date' },
      { key: 'poNumber', label: 'Purchase Order No' },
      { key: 'vendor', label: 'Supplier / Vendor' },
      { key: 'projectRef', label: 'Project Ref' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'status', label: 'Status' }
    ]
  });

  // 6. Export Production Job Cards XLSX
  const handleExportJobCards = () => exportFromPostgres({
    label: 'Job Cards',
    loader: listJobCards,
    emptyMessage: 'No job cards are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-production-jobcards',
    sheetName: 'Production Job Cards',
    mapRows: (items) => items.map((jc) => ({
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
    })),
    headers: [
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
    ]
  });

  // 7. Export Customer Enquiries XLSX
  const handleExportEnquiries = () => exportFromPostgres({
    label: 'Customer Enquiries',
    loader: listEnquiries,
    emptyMessage: 'No customer enquiries are available in PostgreSQL to export.',
    baseName: 'VYAVASTA-customer-enquiries',
    sheetName: 'Customer Enquiries',
    mapRows: (items) => items.map((pr) => ({
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
    })),
    headers: [
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
    ]
  });

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
            message: `Restored ${log.totalRecords} records from a legacy browser archive at ${log.time} on ${log.date}. PostgreSQL was not changed.`
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
          <h1>PostgreSQL Backup & Data Export</h1>
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
          <button className="button-secondary" onClick={handleManualBackup}>
            Download legacy browser archive
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

      <div className="content-block" style={{ marginBottom: '28px' }}>
        <div className="block-header">
          <h2>PostgreSQL Backup History</h2>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            Server-generated full database backups with SHA-256 integrity verification. Browser archives below are legacy exports and are not database recovery files.
          </p>
        </div>
        {backupError && <p role="alert" style={{ color: '#b91c1c' }}>{backupError}</p>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
          <button className="button-primary" disabled={!isAdmin() || backupBusy === 'create'} onClick={handleCreatePostgresBackup}>
            {backupBusy === 'create' ? 'Creating PostgreSQL backup...' : 'Create PostgreSQL backup'}
          </button>
          <span style={{ fontSize: 12, color: '#64748b', overflowWrap: 'anywhere' }}>
            Database identity: {databaseBackupStatus?.identityFingerprint || 'Loading...'}
          </span>
          {databaseBackupStatus && !databaseBackupStatus.backupDirectoryConfigured && (
            <span style={{ fontSize: 12, color: '#b91c1c' }}>Server backup storage is not configured.</span>
          )}
          {databaseBackupStatus && !databaseBackupStatus.restoreEnabled && (
            <span style={{ fontSize: 12, color: '#92400e' }}>Controlled restore is disabled in this environment.</span>
          )}
        </div>
        {databaseBackups.length === 0 ? <p>No PostgreSQL backups have been recorded.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Created</th><th>Created by</th><th>Size</th><th>Integrity</th><th>Actions</th></tr></thead>
              <tbody>
                {databaseBackups.map((backup) => (
                  <tr key={backup.id}>
                    <td>{new Date(backup.createdAt).toLocaleString()}</td>
                    <td>{backup.createdBy}</td>
                    <td>{Number(backup.byteSize).toLocaleString()} bytes</td>
                    <td>{backup.integrityStatus}{backup.verifiedAt ? ` — ${new Date(backup.verifiedAt).toLocaleString()}` : ''}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {isAdmin() && <>
                          <button className="button-secondary" disabled={Boolean(backupBusy)} onClick={() => handleVerifyPostgresBackup(backup.id)}>Verify</button>
                          <button className="button-secondary" disabled={Boolean(backupBusy)} onClick={() => handleDownloadPostgresBackup(backup.id)}>Download</button>
                          {databaseBackupStatus?.restoreEnabled && (
                            <button className="button-secondary" disabled={Boolean(backupBusy)} onClick={() => handleRestorePostgresBackup(backup)}>Restore</button>
                          )}
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 1-Click Spreadsheet Exports */}
      <div className="content-block" style={{ marginBottom: '28px' }}>
        <div className="block-header" style={{ marginBottom: '14px' }}>
          <h2>1-Click Excel Spreadsheet Exports</h2>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            Download tabular datasets directly compatible with Microsoft Excel, Google Sheets, and accounting software.
          </p>
        </div>
        {exportDataError && <p role="alert" style={{ color: '#b91c1c' }}>{exportDataError}</p>}

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
              📥 Export Enquiries (.xlsx)
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
              📥 Export Quotations (.xlsx)
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
              📥 Export Sales Orders (.xlsx)
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
              📥 Export Invoices (.xlsx)
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
              📥 Export Inventory (.xlsx)
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
              📥 Export Purchase Orders (.xlsx)
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
              📥 Export Job Cards (.xlsx)
            </button>
          </div>
        </div>
      </div>

      {/* System Backup, Restore & Data Reset Section */}
      <div className="content-block">
        <div className="block-header">
          <h2>Legacy Browser Archive and Data Export</h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginTop: '14px' }}>
          {/* Backup Box */}
          <div style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '20px', background: '#ffffff' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '8px', color: '#0f172a' }}>Download Browser Archive</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5', marginBottom: '16px' }}>
              Downloads the browser's legacy JSON data archive and workbook. It does not contain PostgreSQL records or server-side uploaded files.
            </p>
            <button className="button-primary" style={{ width: '100%' }} onClick={handleManualBackup}>
              Download Legacy Browser Archive (.json + .xlsx)
            </button>
          </div>

          {/* Restore Box */}
          <div style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '20px', background: '#ffffff' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '8px', color: '#0f172a' }}>Restore Browser Archive Only</h3>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.5', marginBottom: '16px' }}>
              Select a legacy `.json` archive to restore browser storage only. This never restores PostgreSQL records.
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
              Select Browser Archive (.json)
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
