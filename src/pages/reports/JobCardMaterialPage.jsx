import React, { useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import ReportLoadState from '../../components/ReportLoadState.jsx';
import { useAuthoritativeData } from '../../hooks/useAuthoritativeData.js';
import { getStoreIssues, getMaterialReturns } from '../../services/storeApi.js';
import { listJobCards } from '../../services/productionApi.js';

const qtyByUnit = (rows, field) => [...new Set(rows.map((row) => row.unit === 'Unit not recorded' ? '' : row.unit || ''))]
  .map((unit) => `${rows.filter((row) => (row.unit === 'Unit not recorded' ? '' : row.unit || '') === unit).reduce((sum, row) => sum + (Number(row[field]) || 0), 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`).join(' | ') || '0';
const groupedMovementRows = (rows, groupBy) => {
  const field = groupBy === 'jobcard' ? 'jobCardNumber' : groupBy === 'project' ? 'projectId' : 'materialName';
  return Object.values(rows.reduce((map, row) => {
    const key = `${row[field]}::${row.unit}`;
    map[key] = map[key] || { key, group: row[field], unit: row.unit, issues: 0, returns: 0, net: 0 };
    map[key].issues += row.issuedQty; map[key].returns += row.returnedQty; map[key].net += row.netConsumed; return map;
  }, {}));
};

const loadJobCardMaterialData = async () => {
  const [issues, returns, jobCards] = await Promise.all([getStoreIssues(), getMaterialReturns(), listJobCards()]);
  return { issues, returns, jobCards };
};

const JobCardMaterialPage = () => {
  const [groupBy, setGroupBy] = useState('none');
  const { data, loading, error } = useAuthoritativeData(loadJobCardMaterialData, '', { issues: [], returns: [], jobCards: [] });
  const rows = useMemo(() => {
    const output = [];
    const issuedMaterials = new Set();
    data.issues.forEach((issue) => (issue.items || []).forEach((item, index) => {
      const materialId = item.materialId || item.materialName || '';
      issuedMaterials.add(`${String(issue.jobCardNumber || '').toUpperCase()}::${String(materialId).toLowerCase()}`);
      const issuedQty = Number(item.currentIssueQty ?? item.totalIssued ?? item.quantity) || 0;
      output.push({ jobCardNumber: issue.jobCardNumber || '-', projectId: issue.projectId || '-', materialName: item.materialName || materialId || '-', materialId, unit: item.unit || 'Unit not recorded', eventType: 'Issue', issueDate: issue.issueDate || '', date: issue.issueDate || '', issueNumber: issue.issueNumber || '', returnNumber: '', issuedQty, returnedQty: 0, netConsumed: issuedQty, sourceOrdinal: index + 1 });
    }));
    data.returns.forEach((ret) => (ret.items || []).forEach((item, index) => {
      const returnedQty = Number(item.quantityReturned ?? item.returnQty ?? item.quantity) || 0;
      const date = ret.returnDate || ret.acknowledgedAt?.slice(0, 10) || '';
      const materialId = item.materialId || item.materialName || '';
      output.push({ jobCardNumber: ret.jobCardNumber || '-', projectId: ret.projectId || '-', materialName: item.materialName || materialId || '-', materialId, unit: item.unit || 'Unit not recorded', eventType: 'Return', issueDate: '', date, issueNumber: ret.issueNumber || '', returnNumber: ret.returnNumber || '', issuedQty: 0, returnedQty, netConsumed: -returnedQty, sourceOrdinal: index + 1 });
    }));
    // Retain the legacy Job Card raw-material fallback only when no matching issue line exists.
    data.jobCards.forEach((jobCard) => {
      const material = jobCard.rawMaterial;
      if (!material || !(material.grade || material.dimensions || material.type)) return;
      const materialName = [material.type, material.grade, material.dimensions].filter(Boolean).join(' - ') || 'Raw Material';
      const key = `${String(jobCard.jobCardNumber || '').toUpperCase()}::${materialName.toLowerCase()}`;
      if (issuedMaterials.has(key)) return;
      const quantityMatch = String(material.issuedQty || '').match(/^(\d+(?:\.\d+)?)/);
      const issuedQty = quantityMatch ? Number(quantityMatch[1]) : Number(jobCard.orderQuantity) || 1;
      output.push({ jobCardNumber: jobCard.jobCardNumber || '-', projectId: jobCard.projectId || '-', materialName, materialId: '', unit: 'Unit not recorded', eventType: 'Issue', issueDate: jobCard.startDate || jobCard.poDate || '', date: jobCard.startDate || jobCard.poDate || '', issueNumber: '', returnNumber: '', issuedQty, returnedQty: 0, netConsumed: issuedQty, sourceOrdinal: 1, linkStatus: 'Legacy Job Card source; no issue slip' });
    });
    return output;
  }, [data]);
  if (loading || error) return <div className="page-container" style={{ padding: '20px 24px' }}><ReportLoadState loading={loading} error={error} /></div>;
  const jobCards = [...new Set(rows.map((row) => row.jobCardNumber).filter((value) => value && value !== '-'))].sort();
  const projects = [...new Set(rows.map((row) => row.projectId).filter((value) => value && value !== '-'))].sort();
  const materials = [...new Set(rows.map((row) => row.materialName).filter((value) => value && value !== '-'))].sort();
  const sortedRows = useMemo(() => {
    const field = groupBy === 'jobcard' ? 'jobCardNumber' : groupBy === 'project' ? 'projectId' : groupBy === 'item' ? 'materialName' : null;
    return [...rows].sort((a, b) => field ? String(a[field]).localeCompare(String(b[field])) || String(b.date).localeCompare(String(a.date)) : String(b.date).localeCompare(String(a.date)));
  }, [rows, groupBy]);

  return <div className="page-container" style={{ padding: '20px 24px' }}>
    <div className="content-block" style={{ marginBottom: 14 }}>
      <div className="block-header"><h3 className="block-title">Grouping</h3><span className="muted-text">Issue and return events are dated separately</span></div>
      <select className="action-select" value={groupBy} onChange={(event) => setGroupBy(event.target.value)} style={{ maxWidth: 320 }}>
        <option value="none">No grouping (chronological)</option><option value="jobcard">Group by Job Card</option><option value="project">Group by Project</option><option value="item">Group by Item</option>
      </select>
    </div>
    <ReportRegister
      title="Job Card Material Issue & Return"
      subTitle="Material movements by their actual issue or return date; return events are separate rows."
      filename={`JobCard-Material-${new Date().toISOString().slice(0, 10)}`}
      dateField="date" rows={sortedRows} enableCSV landscape
      columns={[
        { key: 'date', label: 'Event Date', width: 22 },
        { key: 'jobCardNumber', label: 'Job Card No.', width: 30 },
        { key: 'projectId', label: 'Project ID', width: 26 },
        { key: 'materialName', label: 'Material / Item', width: 75 },
        { key: 'issuedQty', label: 'Issued Qty', width: 28, align: 'right' },
        { key: 'returnedQty', label: 'Returned Qty', width: 30, align: 'right' },
        { key: 'netConsumed', label: 'Net Consumption', width: 38, align: 'right' },
        { key: 'unit', label: 'Unit', width: 28 }
      ]}
      filters={[
        { key: 'jobCardNumber', placeholder: 'All Job Cards', options: jobCards.map((value) => ({ value, label: value })) },
        { key: 'projectId', placeholder: 'All Projects', options: projects.map((value) => ({ value, label: value })) },
        { key: 'materialName', placeholder: 'All Materials', options: materials.map((value) => ({ value, label: value })) },
        { key: 'eventType', placeholder: 'All Movements', options: [{ value: 'Issue', label: 'Issue' }, { value: 'Return', label: 'Return' }] }
      ]}
      summaryCards={(filtered) => [
        { label: 'Issue Events', value: filtered.filter((row) => row.eventType === 'Issue').length },
        { label: 'Return Events', value: filtered.filter((row) => row.eventType === 'Return').length },
        { label: 'Issued Qty', value: qtyByUnit(filtered, 'issuedQty') },
        { label: 'Returned Qty', value: qtyByUnit(filtered, 'returnedQty') },
        { label: 'Net Consumption', value: qtyByUnit(filtered, 'netConsumed') }
      ]}
      totals={[
        { colKey: 'issuedQty', render: (filtered) => qtyByUnit(filtered, 'issuedQty') },
        { colKey: 'returnedQty', render: (filtered) => qtyByUnit(filtered, 'returnedQty') },
        { colKey: 'netConsumed', render: (filtered) => qtyByUnit(filtered, 'netConsumed') }
      ]}
      summaryContent={(filtered) => {
        if (groupBy === 'none') return null;
        const groups = groupedMovementRows(filtered, groupBy);
        return <div className="content-block"><h3 className="block-title">Filtered {groupBy} summary by UOM</h3><div className="history-table-wrapper"><table className="history-table report-table"><thead><tr><th>Group</th><th>Unit</th><th>Issued</th><th>Returned</th><th>Net</th></tr></thead><tbody>{groups.map((group) => <tr key={group.key}><td>{group.group}</td><td>{group.unit}</td><td>{group.issues}</td><td>{group.returns}</td><td>{group.net}</td></tr>)}</tbody></table></div></div>;
      }}
      summaryTables={(filtered) => groupBy === 'none' ? [] : [{ title: `Filtered ${groupBy} summary by UOM`, columns: [{ key: 'group', label: 'Group' }, { key: 'unit', label: 'Unit' }, { key: 'issues', label: 'Issued' }, { key: 'returns', label: 'Returned' }, { key: 'net', label: 'Net' }], rows: groupedMovementRows(filtered, groupBy) }]}
    />
  </div>;
};

export default JobCardMaterialPage;
