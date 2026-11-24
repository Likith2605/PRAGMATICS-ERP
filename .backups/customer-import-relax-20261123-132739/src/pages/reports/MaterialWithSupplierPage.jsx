import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getHTOutsourceRequests } from '../../utils/storeService.js';

/**
 * Material with Supplier Report (Phase 2).
 *
 * Aggregates HT outsourcing requests per vendor. The "At Vendor" quantity
 * reuses the exact formula from HTOutsourcePage.jsx (line 200):
 *   atVendor = max(0, issuedQty - receivedQty)
 * so this report always agrees with the HT Outsource page.
 */

// Same accessor formula as the HT Outsource page (keep in sync).
const atVendor = (r) => Math.max(0, (Number(r.issuedQty) || 0) - (Number(r.receivedQty) || 0));
const vendorSummaryRows = (rows) => Object.values(rows.reduce((map, row) => {
  const key = `${row.vendorName}::${row.unit || 'Unit not recorded'}`;
  map[key] = map[key] || { key, vendor: row.vendorName, unit: row.unit || 'Unit not recorded', issued: 0, received: 0, atVendor: 0 };
  map[key].issued += row.issuedQty; map[key].received += row.receivedQty; map[key].atVendor += row.atVendor; return map;
}, {})).filter((row) => row.atVendor > 0).sort((a, b) => b.atVendor - a.atVendor);

const MaterialWithSupplierPage = () => {
  const { rows, vendors } = useMemo(() => {
    const list = getHTOutsourceRequests().map((r) => ({
      reference: r.htrNumber || '',
      outwardChallan: r.outwardChallan || '',
      inwardChallan: r.inwardChallan || '',
      vendorName: r.vendorName || 'Pending',
      jobCardNumber: r.jobCardNumber || '-',
      partName: r.partName || '-',
      projectId: r.projectId || '-',
      unit: r.unit || 'Unit not recorded',
      issuedQty: Number(r.issuedQty) || 0,
      receivedQty: Number(r.receivedQty) || 0,
      atVendor: atVendor(r),
      issuedDate: r.issuedDate || '',
      receivedDate: r.receivedDate || '-',
      status: r.status || '-'
    }));
    const ven = [...new Set(list.map((r) => r.vendorName))].sort();
    return { rows: list, vendors: ven };
  }, []);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: 14, color: '#475569', fontSize: 13 }}>
        Current source coverage is HTR / Heat Treatment only. The ERP has no shared delivery-note records for other outsourced processes, so they are not inferred into this register.
      </div>
      <ReportRegister
        title="OS Material with Supplier – Delivery Note-wise"
        subTitle="HTR outward challan-wise issue and receipt quantities"
        filename={`Material-with-Supplier-${new Date().toISOString().slice(0, 10)}`}
        dateField="issuedDate"
        landscape
        enableCSV
        columns={[
          { key: 'issuedDate', label: 'Issued Date', width: 17 },
          { key: 'reference', label: 'HTR No', width: 18 },
          { key: 'outwardChallan', label: 'Outward Delivery Note', width: 25 },
          { key: 'inwardChallan', label: 'Inward Delivery Note', width: 25 },
          { key: 'vendorName', label: 'Vendor', width: 30 },
          { key: 'jobCardNumber', label: 'Job Card', width: 22 },
          { key: 'partName', label: 'Part', width: 25 },
          { key: 'projectId', label: 'Project', width: 20 },
          { key: 'unit', label: 'Unit', width: 14 },
          { key: 'issuedQty', label: 'Issued Qty', width: 16, align: 'right' },
          { key: 'receivedQty', label: 'Received Back', width: 20, align: 'right' },
          {
            key: 'atVendor',
            label: 'At Vendor',
            width: 18,
            align: 'right',
            render: (r) => <span style={{ color: r.atVendor > 0 ? '#c2410c' : '#166534', fontWeight: 700 }}>{r.atVendor}</span>,
            renderText: (r) => r.atVendor
          },
          { key: 'status', label: 'Status', width: 27 }
        ]}
        rows={rows}
        filters={[{ key: 'vendorName', placeholder: 'All Vendors', options: vendors.map((v) => ({ value: v, label: v })) }]}
        summaryContent={(filteredRows) => {
          const summary = vendorSummaryRows(filteredRows);
          if (!summary.length) return null;
          return <div className="content-block" style={{ marginBottom: 14 }}><div className="block-header"><h3 className="block-title">Material Lying with Vendors</h3><span className="muted-text">filtered rows, split by unit</span></div><div className="history-table-wrapper"><table className="history-table report-table"><thead><tr><th>Vendor</th><th>Unit</th><th>Issued</th><th>Received Back</th><th>At Vendor</th></tr></thead><tbody>{summary.map((row) => <tr key={row.key}><td>{row.vendor}</td><td>{row.unit}</td><td>{row.issued}</td><td>{row.received}</td><td>{row.atVendor}</td></tr>)}</tbody></table></div></div>;
        }}
        summaryTables={(filteredRows) => [{ title: 'Material Lying with Vendors', columns: [{ key: 'vendor', label: 'Vendor' }, { key: 'unit', label: 'Unit' }, { key: 'issued', label: 'Issued' }, { key: 'received', label: 'Received Back' }, { key: 'atVendor', label: 'At Vendor' }], rows: vendorSummaryRows(filteredRows) }]}
        totals={[
          { colKey: 'issuedQty', render: (rs) => [...new Set(rs.map((row) => row.unit))].map((unit) => `${rs.filter((row) => row.unit === unit).reduce((sum, row) => sum + row.issuedQty, 0)} ${unit}`).join(' | ') },
          { colKey: 'receivedQty', render: (rs) => [...new Set(rs.map((row) => row.unit))].map((unit) => `${rs.filter((row) => row.unit === unit).reduce((sum, row) => sum + row.receivedQty, 0)} ${unit}`).join(' | ') },
          { colKey: 'atVendor', render: (rs) => [...new Set(rs.map((row) => row.unit))].map((unit) => `${rs.filter((row) => row.unit === unit).reduce((sum, row) => sum + row.atVendor, 0)} ${unit}`).join(' | ') }
        ]}
      />
    </div>
  );
};

export default MaterialWithSupplierPage;
