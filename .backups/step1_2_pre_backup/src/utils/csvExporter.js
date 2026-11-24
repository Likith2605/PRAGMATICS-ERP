// Utility to convert array of objects to CSV and trigger browser download

export const exportToCSV = (filename, headers, rows) => {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headerLine = headers.map((h) => escapeCell(h.label || h)).join(',');
  const rowLines = rows.map((row) => {
    return headers.map((h) => {
      const key = h.key || h;
      return escapeCell(row[key]);
    }).join(',');
  });

  const csvContent = '\uFEFF' + [headerLine, ...rowLines].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const exportFullJSONBackup = () => {
  const backupData = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    system: 'PRAGMATIC ENGINEERS ERP',
    data: {}
  };

  const storageKeys = [
    'companySettings',
    'quotationHistory',
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
    'employees',
    'materialRequests',
    'storeIssueHistory',
    'materialReturnHistory',
    'storeAuditLog',
    'notifications',
    'storePurchaseRequests',
    'employeeIssueLog',
    'htOutsourceRequests',
    'htOutsourceSequence'
  ];

  storageKeys.forEach((key) => {
    try {
      const item = localStorage.getItem(key);
      if (item) {
        backupData.data[key] = JSON.parse(item);
      }
    } catch {
      backupData.data[key] = null;
    }
  });

  const jsonStr = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const dateStr = new Date().toISOString().slice(0, 10);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `pragmatics-erp-backup-${dateStr}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
