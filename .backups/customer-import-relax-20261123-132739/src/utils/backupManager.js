// Automated real-time & daily backup engine (company name comes from Company Settings)

import { getCompanyProfile } from './companyBranding.js';

// Restore customer masters without duplicating or overwriting existing records.
const mergeCustomerDirectory = (existing = [], incoming = []) => {
  const identity = (record) => {
    const gstin = String(record?.gstin || record?.gstNumber || '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (gstin && gstin !== 'URP') return `gstin:${gstin}`;
    const name = String(record?.companyName || record?.customerName || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const code = String(record?.customerCode || '').trim().toUpperCase();
    return name ? `name:${name}${code ? `|${code}` : ''}` : '';
  };
  const merged = Array.isArray(existing) ? [...existing] : [];
  const keys = new Set(merged.map(identity).filter(Boolean));
  (Array.isArray(incoming) ? incoming : []).forEach((record) => {
    const key = identity(record);
    if (key && keys.has(key)) return;
    if (key) keys.add(key);
    merged.push(record);
  });
  return merged;
};

export const ERP_BACKUP_STORAGE_KEYS = [
  'companySettings',
  'customerDirectory',
  'projectRequests',
  'projectRequestSequence',
  'quotationHistory',
  'quotationSequence',
  'customerPOHistory',
  'salesOrderHistory',
  'productionJobCards',
  'inventoryItems',
  'stockTransactions',
  'supplierPOHistory',
  'supplierInvoiceHistory',
  'deliveryChallanHistory',
  'customerInvoiceHistory',
  'customInventoryCategories',
  'customQuotationTemplates',
  'customUnits',
  'employees',
  'materialRequests',
  'storeIssueHistory',
  'materialReturnHistory',
  'storeAuditLog',
  'notifications',
  'storePurchaseRequests',
  'materialRequestSequence',
  'storeIssueSequence',
  'materialReturnSequence',
  'storePurchaseRequestSequence',
  'employeeIssueLog',
  'htOutsourceRequests',
  'htOutsourceSequence',
  // Purchase / Sales workflow (Sales Order → Indent → PO → Receipt → QC → Inventory)
  'soMaterialAvailabilityChecks',
  'purchaseIndents',
  'purchaseIndentSequence',
  'materialReceipts',
  'materialReceiptSequence',
  'qualityChecks',
  'qualityCheckSequence',
  'rejectionReports',
  'rejectionReportSequence',
  'debitNotes',
  'debitNoteSequence',
  // Previously missing from the backup list (kept for restore compatibility)
  'storeGRNs',
  'grnSequence',
  'stockTransfers',
  'stockTransferSequence',
  'stockVerifications',
  'stockVerificationSequence',
  'inventoryBatches',
  'bomMasterList',
  'vendorMaster',
  'vendorMasterSequence',
  'vendorEnquiries',
  'vendorEnquirySequence',
  'vendorQuotations',
  'vendorQuotationSequence',
  'salesReturnHistory',
  'purchaseReturnHistory',
  'customerAdvanceHistory',
  'supplierAdvanceHistory',
  'purchaseOrderSequence',
  'customerPOSequence',
  'customerInvoiceSequence'
];

/**
 * Collect all current ERP data across all modules
 */
export const collectAllERPData = () => {
  const dataset = {};
  let totalRecordCount = 0;

  ERP_BACKUP_STORAGE_KEYS.forEach((key) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        dataset[key] = parsed;
        if (Array.isArray(parsed)) {
          totalRecordCount += parsed.length;
        } else if (parsed && typeof parsed === 'object') {
          totalRecordCount += 1;
        }
      } else {
        dataset[key] = null;
      }
    } catch {
      dataset[key] = null;
    }
  });

  return { dataset, totalRecordCount };
};

/**
 * Format Date & Time for display (e.g. "03 Sep 2026, 01:28:45 PM")
 */
export const formatAuditDateTime = (isoDateStr) => {
  try {
    const d = isoDateStr ? new Date(isoDateStr) : new Date();
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  } catch {
    return String(isoDateStr || '-');
  }
};

/**
 * Get all backup audit logs
 */
export const getBackupAuditLogs = () => {
  try {
    const raw = localStorage.getItem('erpBackupAuditLogs');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

/**
 * Save an audit log entry
 */
export const logBackupEvent = (entry) => {
  try {
    const logs = getBackupAuditLogs();
    const updated = [entry, ...logs].slice(0, 50);
    localStorage.setItem('erpBackupAuditLogs', JSON.stringify(updated));
    return updated;
  } catch (e) {
    console.error('Failed to write backup audit log', e);
    return [];
  }
};

/**
 * Automated System Backup:
 * Runs on every application open, refresh, and whenever any data is updated/saved.
 */
export const performAutoSystemBackup = (triggerSource = 'Application Launch') => {
  try {
    const now = new Date();
    const todayDateKey = now.toISOString().slice(0, 10);
    const { dataset, totalRecordCount } = collectAllERPData();
  const companyName = getCompanyProfile().companyName || 'VYAVASTA';
  const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
    const payloadStr = JSON.stringify(dataset);
    const sizeKb = (payloadStr.length / 1024).toFixed(1);

    const backupEntry = {
      id: `auto-${Date.now()}`,
      timestamp: now.toISOString(),
      formattedDateTime: formatAuditDateTime(now.toISOString()),
      date: todayDateKey,
      time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
      type: 'Automated System Backup',
      trigger: triggerSource,
      totalRecords: totalRecordCount,
      sizeKb: `${sizeKb} KB`,
      status: 'Success'
    };

    // Store latest snapshot in local archive. Snapshots are full copies of the
    // whole dataset, so cap both the day count and the total bytes — an
    // unbounded archive is what fills the ~5 MB localStorage quota and breaks
    // routine saves ("Setting the value of ... exceeded the quota").
    const SNAPSHOT_MAX_BYTES = 600 * 1024;
    try {
      const snapshotsRaw = localStorage.getItem('erpDailySnapshots');
      let snapshots = snapshotsRaw ? JSON.parse(snapshotsRaw) : [];
      if (!Array.isArray(snapshots)) snapshots = [];
      snapshots = snapshots.filter((s) => s && s.date !== todayDateKey);
      snapshots.unshift({ ...backupEntry, data: dataset });
      snapshots = snapshots.slice(0, 7);
      while (snapshots.length > 1 && JSON.stringify(snapshots).length > SNAPSHOT_MAX_BYTES) {
        snapshots.pop();
      }
      localStorage.setItem('erpDailySnapshots', JSON.stringify(snapshots));
    } catch (err) {
      /* Quota or parse problem: an empty archive beats blocking the app. */
      try {
        localStorage.setItem('erpDailySnapshots', '[]');
      } catch {
        /* still full — writeLS recovery handles the next business save */
      }
      console.warn('Snapshot storage limit handled', err);
    }

    logBackupEvent(backupEntry);
    localStorage.setItem('lastDailyBackupDate', todayDateKey);
    localStorage.setItem('lastBackupTimestamp', now.toISOString());
    return backupEntry;
  } catch (err) {
    console.error('[Backup Engine] Failed auto system backup', err);
    return null;
  }
};

/**
 * Backwards compatibility alias
 */
export const checkAndPerformDailyAutoBackup = () => {
  return performAutoSystemBackup('Application Launch / Use');
};

/**
 * Trigger an immediate manual full system backup and download .json file
 */
export const triggerFullManualBackupAndDownload = () => {
  const now = new Date();
  const { dataset, totalRecordCount } = collectAllERPData();
  const companyName = getCompanyProfile().companyName || 'VYAVASTA';
  const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';

  const backupData = {
    version: '2.0.0',
    timestamp: now.toISOString(),
    formattedDateTime: formatAuditDateTime(now.toISOString()),
    system: `${companyName} ERP`,
    totalRecords: totalRecordCount,
    data: dataset
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const sizeKb = (jsonStr.length / 1024).toFixed(1);

  // Trigger browser download
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${companySlug}-full-backup-${dateStr}_${timeStr}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  // Record audit log
  const logEntry = {
    id: `manual-${Date.now()}`,
    timestamp: now.toISOString(),
    formattedDateTime: formatAuditDateTime(now.toISOString()),
    date: dateStr,
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
    type: 'Manual Full Backup (.json Download)',
    trigger: 'User Initiated',
    totalRecords: totalRecordCount,
    sizeKb: `${sizeKb} KB`,
    status: 'Success'
  };

  logBackupEvent(logEntry);
  localStorage.setItem('lastBackupTimestamp', now.toISOString());
  return logEntry;
};

/**
 * Restore system from backup JSON object and log the restoration event
 */
export const restoreSystemFromJSON = (jsonObj) => {
  const targetData = jsonObj.data || jsonObj;
  let restoredCount = 0;

  ERP_BACKUP_STORAGE_KEYS.forEach((key) => {
    if (targetData[key] !== undefined && targetData[key] !== null) {
      let value = targetData[key];
      if (key === 'customerDirectory') {
        let existing = [];
        try { existing = JSON.parse(localStorage.getItem(key) || '[]'); } catch { existing = []; }
        value = mergeCustomerDirectory(existing, value);
      }
      localStorage.setItem(key, JSON.stringify(value));
      restoredCount += Array.isArray(value) ? value.length : 1;
    }
  });

  const now = new Date();
  const restoreLog = {
    id: `restore-${Date.now()}`,
    timestamp: now.toISOString(),
    formattedDateTime: formatAuditDateTime(now.toISOString()),
    date: now.toISOString().slice(0, 10),
    time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
    type: 'Data Restoration Applied',
    trigger: 'User File Restore',
    totalRecords: restoredCount,
    sizeKb: `${(JSON.stringify(targetData).length / 1024).toFixed(1)} KB`,
    status: 'Restored'
  };

  logBackupEvent(restoreLog);
  localStorage.setItem('lastBackupTimestamp', now.toISOString());
  return restoreLog;
};
