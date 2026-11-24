import React, { useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getStoreIssues } from '../../utils/storeService.js';

/**
 * Material Issue Register (Phase 2).
 *
 * Flattens storeIssueHistory into one row per issued item line. Grouping
 * (Employee / Job Card / Item) is presentation-only: each group's quantity is
 * the sum of the same currentIssueQty values shown in the register rows — no
 * separate calculation path exists, so group totals always match the register.
 */

const GROUPS = [
  { value: 'none', label: 'No grouping (chronological)' },
  { value: 'employee', label: 'Group by Employee' },
  { value: 'jobcard', label: 'Group by Job Card' },
  { value: 'item', label: 'Group by Item' }
];

const qtyByUnit = (rs, field) => {
  const sums = new Map();
  rs.forEach((row) => {
    const unit = row.unit || 'Unit not recorded';
    sums.set(unit, (sums.get(unit) || 0) + (Number(row[field]) || 0));
  });
  return [...sums.entries()].map(([unit, qty]) => `${qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`).join(' | ') || '0';
};
const buildIssueGroupRows = (rows, groupBy) => {
  if (groupBy === 'none') return [];
  const keyOf = (row) => `${groupBy === 'employee' ? row.employee : groupBy === 'jobcard' ? row.jobCardNumber : `${row.materialId} ${row.materialName}`} · ${row.unit || 'Unit not recorded'}`;
  return Object.values(rows.reduce((map, row) => {
    const key = keyOf(row); map[key] = map[key] || { key, lines: 0, qty: 0 };
    map[key].lines += 1; map[key].qty += row.qty; return map;
  }, {})).sort((a, b) => b.qty - a.qty);
};

const MaterialIssueRegisterPage = () => {
  const [groupBy, setGroupBy] = useState('none');

  const { rows, employees, jobCards, items } = useMemo(() => {
    const flat = [];
    getStoreIssues().forEach((si) => {
      (si.items || []).forEach((it) => {
        flat.push({
          issueDate: si.issueDate || '',
          issueNumber: si.issueNumber || '',
          mrNumber: si.mrNumber || '',
          jobCardNumber: si.jobCardNumber || '-',
          projectId: si.projectId || '-',
          customer: si.customer || '-',
          partName: si.partName || '-',
          employee: si.receivedBy || '-',
          employeeId: si.receivedByEmpId || '',
          department: si.receivedByDept || '',
          issuedBy: si.issuedBy || '-',
          materialId: it.materialId || '',
          materialName: it.materialName || '',
          unit: it.unit || '',
          qty: Number(it.currentIssueQty) || 0,
          totalIssued: Number(it.totalIssued) || 0,
          batchNo: it.batchNo || '',
          lotNumber: it.lotNumber || ''
        });
      });
    });
    const uniq = (arr) => [...new Set(arr.filter((v) => v && v !== '-'))].sort();
    return {
      rows: flat,
      employees: uniq(flat.map((r) => r.employee)),
      jobCards: uniq(flat.map((r) => r.jobCardNumber)),
      items: uniq(flat.map((r) => r.materialId))
    };
  }, []);

  const sortedRows = useMemo(() => {
    if (groupBy === 'none') return [...rows].sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
    const keyOf = (r) => (groupBy === 'employee' ? r.employee : groupBy === 'jobcard' ? r.jobCardNumber : r.materialId);
    return [...rows].sort((a, b) => {
      const k = keyOf(a).localeCompare(keyOf(b));
      return k !== 0 ? k : (b.issueDate || '').localeCompare(a.issueDate || '');
    });
  }, [rows, groupBy]);

  const groupLabel = groupBy === 'employee' ? 'Employee' : groupBy === 'jobcard' ? 'Job Card' : 'Item';

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: '14px' }}>
        <div className="block-header">
          <h3 className="block-title">Grouping</h3>
          <span className="muted-text">{rows.length} issued line(s)</span>
        </div>
        <select className="action-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ maxWidth: '320px' }}>
          {GROUPS.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
      </div>

      <ReportRegister
        title="Material Issue Register"
        subTitle={groupBy === 'none' ? 'All store issues, newest first' : `Sorted by ${groupLabel}`}
        filename={`Material-Issues-${new Date().toISOString().slice(0, 10)}`}
        dateField="issueDate"
        enableCSV
        columns={[
          { key: 'issueDate', label: 'Date' },
          { key: 'issueNumber', label: 'Issue No' },
          { key: 'mrNumber', label: 'MR No' },
          { key: 'jobCardNumber', label: 'Job Card' },
          { key: 'projectId', label: 'Project' },
          { key: 'customer', label: 'Customer' },
          { key: 'materialId', label: 'Item Code' },
          { key: 'materialName', label: 'Item Name' },
          { key: 'batchNo', label: 'Batch No' },
          { key: 'lotNumber', label: 'Lot No' },
          { key: 'qty', label: 'Issued Qty', align: 'right' },
          { key: 'unit', label: 'Unit' },
          { key: 'employee', label: 'Issued To' },
          { key: 'issuedBy', label: 'Issued By' }
        ]}
        rows={sortedRows}
        filters={[
          { key: 'employee', placeholder: 'All Employees', options: employees.map((e) => ({ value: e, label: e })) },
          { key: 'jobCardNumber', placeholder: 'All Job Cards', options: jobCards.map((j) => ({ value: j, label: j })) },
          { key: 'materialId', placeholder: 'All Items', options: items.map((i) => ({ value: i, label: i })) }
        ]}
        summaryContent={(filteredRows) => {
          if (groupBy === 'none') return null;
          const groups = buildIssueGroupRows(filteredRows, groupBy);
          return groups.length ? <div className="content-block" style={{ marginBottom: 14 }}><div className="block-header"><h3 className="block-title">{groupLabel} Summary</h3><span className="muted-text">filtered quantities, split by unit</span></div><div className="history-table-wrapper"><table className="history-table report-table"><thead><tr><th>{groupLabel}</th><th>Issue Lines</th><th>Total Qty</th></tr></thead><tbody>{groups.map((group) => <tr key={group.key}><td>{group.key}</td><td>{group.lines}</td><td>{group.qty.toLocaleString('en-IN')}</td></tr>)}</tbody></table></div></div> : null;
        }}
        summaryTables={(filteredRows) => groupBy === 'none' ? [] : [{ title: `${groupLabel} Summary`, columns: [{ key: 'key', label: groupLabel }, { key: 'lines', label: 'Issue Lines' }, { key: 'qty', label: 'Total Qty' }], rows: buildIssueGroupRows(filteredRows, groupBy) }]}
        totals={[{ colKey: 'qty', render: (rs) => qtyByUnit(rs, 'qty') }]}
      />
    </div>
  );
};

export default MaterialIssueRegisterPage;
