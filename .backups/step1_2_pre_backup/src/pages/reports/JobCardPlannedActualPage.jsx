import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getJobCards } from '../../utils/storeService.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const JobCardPlannedActualPage = () => {
  const { rows, projects, statuses, summary } = useMemo(() => {
    const list = getJobCards().map((jc) => {
      const jobCardNumber = jc.jobCardNumber || '-';
      const projectId = jc.projectId || '-';
      const productName = jc.partName || jc.projectName || jc.drawingNumber || '-';
      const plannedQty = Number(jc.orderQuantity || jc.lotQty) || 0;
      const producedQty =
        Number(
          jc.qualityControl?.finalQC?.acceptedQty ??
          jc.producedQty ??
          (jc.status === 'Completed' ? jc.orderQuantity : 0)
        ) || 0;
      const pendingQty = Math.max(0, plannedQty - producedQty);
      const startDate = jc.startDate || jc.poDate || '';
      const completionDate =
        jc.completionDate ||
        jc.actualCompletionDate ||
        (jc.status === 'Completed' ? (jc.targetDate || jc.startDate) : '-') ||
        '-';
      const status = jc.status || 'Draft';
      const variance = producedQty - plannedQty;

      return {
        jobCardNumber,
        projectId,
        productName,
        plannedQty,
        producedQty,
        pendingQty,
        variance,
        unit: jc.unit || jc.quantityUnit || 'Unit not recorded',
        startDate,
        completionDate,
        status
      };
    });

    const totalPlanned = list.reduce((a, r) => a + r.plannedQty, 0);
    const totalProduced = list.reduce((a, r) => a + r.producedQty, 0);
    const totalPending = list.reduce((a, r) => a + r.pendingQty, 0);
    const completedCount = list.filter((r) => r.status === 'Completed').length;
    const inProdCount = list.filter((r) => r.status === 'In Production' || r.status === 'QC Inspection').length;

    const projSet = [...new Set(list.map((r) => r.projectId).filter((p) => p && p !== '-'))].sort();
    const statusSet = [...new Set(list.map((r) => r.status).filter(Boolean))].sort();

    return {
      rows: list,
      projects: projSet,
      statuses: statusSet,
      summary: {
        totalCards: list.length,
        totalPlanned,
        totalProduced,
        totalPending,
        completedCount,
        inProdCount
      }
    };
  }, []);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="Job Card Planned vs Actual"
        subTitle="Production batch analysis comparing planned quantity against accepted produced output and variances"
        filename={`JobCard-Planned-Actual-${new Date().toISOString().slice(0, 10)}`}
        dateField="startDate"
        dateFilters={true}
        enableCSV={true}
        summaryCards={(rs) => [
          { label: 'Total Job Cards', value: rs.length, color: '#0369a1', bg: '#f0f9ff' },
          { label: 'Planned Quantity', value: formatQuantityByUnit(rs, 'plannedQty'), color: '#475569', bg: '#f8fafc' },
          { label: 'Produced Quantity', value: formatQuantityByUnit(rs, 'producedQty'), color: '#166534', bg: '#f0fdf4' },
          { label: 'Pending Quantity', value: formatQuantityByUnit(rs, 'pendingQty'), color: '#b45309', bg: '#fffbeb' },
          { label: 'Completed Cards', value: rs.filter((row) => row.status === 'Completed').length, color: '#166534', bg: '#f0fdf4' },
          { label: 'In Progress / QC', value: rs.filter((row) => row.status === 'In Production' || row.status === 'QC Inspection').length, color: '#2563eb', bg: '#eff6ff' }
        ]}
        columns={[
          { key: 'jobCardNumber', label: 'Job Card No.' },
          { key: 'projectId', label: 'Project ID' },
          { key: 'productName', label: 'Product Name' },
          { key: 'unit', label: 'Unit' },
          { key: 'plannedQty', label: 'Planned Qty', align: 'right' },
          { key: 'producedQty', label: 'Produced Qty', align: 'right' },
          { key: 'pendingQty', label: 'Pending Qty', align: 'right' },
          {
            key: 'variance',
            label: 'Variance',
            align: 'right',
            render: (r) => (
              <span style={{ color: r.variance < 0 ? '#b91c1c' : r.variance > 0 ? '#166534' : '#475569' }}>
                {r.variance > 0 ? `+${r.variance}` : r.variance}
              </span>
            ),
            renderText: (r) => String(r.variance)
          },
          { key: 'startDate', label: 'Start Date' },
          { key: 'completionDate', label: 'Completion Date' },
          {
            key: 'status',
            label: 'Production Status',
            render: (r) => (
              <span
                style={{
                  fontWeight: 700,
                  color:
                    r.status === 'Completed'
                      ? '#166534'
                      : r.status === 'QC Inspection'
                      ? '#7c3aed'
                      : r.status === 'In Production'
                      ? '#0284c7'
                      : '#64748b'
                }}
              >
                {r.status}
              </span>
            ),
            renderText: (r) => r.status
          }
        ]}
        rows={rows}
        filters={[
          { key: 'projectId', placeholder: 'All Projects', options: projects.map((p) => ({ value: p, label: p })) },
          { key: 'status', placeholder: 'All Statuses', options: statuses.map((s) => ({ value: s, label: s })) }
        ]}
        totals={[
          { colKey: 'plannedQty', render: (rs) => formatQuantityByUnit(rs, 'plannedQty') },
          { colKey: 'producedQty', render: (rs) => formatQuantityByUnit(rs, 'producedQty') },
          { colKey: 'pendingQty', render: (rs) => formatQuantityByUnit(rs, 'pendingQty') }
        ]}
      />
    </div>
  );
};

export default JobCardPlannedActualPage;
