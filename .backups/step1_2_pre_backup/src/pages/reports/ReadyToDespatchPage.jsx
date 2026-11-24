import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getJobCards } from '../../utils/storeService.js';
import { readLocalStorageList } from '../../utils/reportData.js';

const list = (v) => Array.isArray(v) ? v : [];
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const clean = (v) => String(v || '').trim();
const norm = (v) => clean(v).toLocaleLowerCase().replace(/\s+/g, ' ');
const currency = (v) => clean(v) || 'INR';
const groupedTotal = (rows, field, groupField) => {
  const values = new Map();
  rows.forEach((row) => {
    if (row[field] == null) return;
    const group = clean(row[groupField]) || 'Unknown';
    values.set(group, (values.get(group) || 0) + num(row[field]));
  });
  return [...values.entries()].map(([unit, value]) => `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${unit}`).join(' | ') || '—';
};

const ReadyToDespatchPage = () => {
  const { rows, projects, customers, statuses } = useMemo(() => {
    const orders = readLocalStorageList('salesOrderHistory');
    const challans = readLocalStorageList('deliveryChallanHistory');
    const jobCards = getJobCards();
    const output = [];
    const consumedJC = new Set();

    orders.forEach((order) => {
      const so = order.payload || {};
      const details = so.soDetails || {};
      const soNumber = order.reference || details.soNumber || '';
      if (!soNumber) return;
      const customer = so.customerDetails?.companyName || so.customerDetails?.customerName || order.company || order.customer || '';
      const projectId = details.projectId || '';
      const linkedChallans = challans.filter((dc) =>
        String(dc.salesOrderRef || dc.payload?.dcDetails?.salesOrderRef || '') === String(soNumber));

      list(so.items).forEach((item, index) => {
        const itemCode = clean(item.itemCode || item.materialCode);
        const itemName = clean(item.itemName || item.materialName);
        const itemUnit = clean(item.unit) || 'Unit not recorded';
        const identicalOrderLines = list(so.items).filter((candidate) => {
          const candidateCode = clean(candidate.itemCode || candidate.materialCode);
          return itemCode && candidateCode ? candidateCode === itemCode : itemName && norm(candidate.itemName || candidate.materialName) === norm(itemName);
        });
        const duplicateOrderLine = identicalOrderLines.length > 1;
        const matchingJCs = duplicateOrderLine ? [] : jobCards.filter((jc) => {
          if (String(jc.salesOrderRef || '') !== String(soNumber)) return false;
          const jcCode = clean(jc.itemCode || jc.partCode || jc.productCode);
          if (itemCode && jcCode) return jcCode === itemCode;
          return itemName && norm(jc.partName || jc.productName) === norm(itemName);
        });
        matchingJCs.forEach((jc) => consumedJC.add(jc.jobCardNumber));
        const matchingDCItems = duplicateOrderLine ? [] : linkedChallans.flatMap((dc) => list(dc.payload?.items || dc.items)
          .filter((line) => {
            const dcCode = clean(line.itemCode || line.materialCode);
            if (itemCode && dcCode) return dcCode === itemCode;
            return itemName && norm(line.itemName || line.materialName) === norm(itemName);
          }));
        const acceptedQty = matchingJCs.reduce((sum, jc) => sum + num(jc.qualityControl?.finalQC?.acceptedQty), 0);
        const producedQty = matchingJCs.reduce((sum, jc) => sum + num(jc.producedQty), 0);
        const dispatchedQty = matchingDCItems.reduce((sum, line) => sum + num(line.quantity), 0);
        const linkAvailable = matchingJCs.length > 0;
        const readyQty = linkAvailable ? Math.max(0, acceptedQty - dispatchedQty) : null;
        const rateValue = item.unitPrice ?? item.rate ?? item.price;
        const rate = rateValue === '' || rateValue == null || !Number.isFinite(Number(rateValue)) ? null : Number(rateValue);
        const overDispatch = linkAvailable ? Math.max(0, dispatchedQty - acceptedQty) : null;
        output.push({
          date: details.soDate || order.date || '', salesOrder: soNumber, customer, projectId,
          jobCards: matchingJCs.map((jc) => jc.jobCardNumber).filter(Boolean).join(', '),
          itemCode, itemName, unit: itemUnit, orderedQty: num(item.quantity), producedQty,
          acceptedQty: matchingJCs.length ? acceptedQty : null, dispatchedQty,
          readyQty, unitRate: rate, currency: currency(details.currency || so.currency),
          readyValue: readyQty != null && rate != null ? readyQty * rate : null,
          valueBasis: rate != null ? 'Sales Order line rate; excludes tax' : 'Sales Order rate not recorded',
          dispatchStatus: duplicateOrderLine ? 'Repeated order line; allocation ambiguous' : !matchingJCs.length ? 'No exact Job Card link' : overDispatch > 0 ? 'Over-dispatched; review' :
            readyQty > 0 ? (dispatchedQty > 0 ? 'Partially dispatched' : 'Ready to dispatch') : 'No remaining QC-cleared qty',
          lineOrdinal: index + 1
        });
      });
    });

    // Keep unlinked Job Cards visible as exceptions; no order, customer or dispatch is inferred.
    jobCards.filter((jc) => jc.jobCardNumber && !consumedJC.has(jc.jobCardNumber) && num(jc.qualityControl?.finalQC?.acceptedQty) > 0)
      .forEach((jc) => output.push({
        date: jc.startDate || jc.poDate || '', salesOrder: '', customer: jc.customerName || '', projectId: jc.projectId || '',
        jobCards: jc.jobCardNumber, itemCode: jc.itemCode || jc.partCode || '', itemName: jc.partName || '',
        unit: jc.unit || 'Unit not recorded', orderedQty: null, producedQty: num(jc.producedQty),
        acceptedQty: num(jc.qualityControl?.finalQC?.acceptedQty), dispatchedQty: null, readyQty: null,
        unitRate: null, currency: '', readyValue: null, valueBasis: 'No exact Sales Order line',
        dispatchStatus: 'Unlinked Job Card; dispatch not attributed'
      }));

    return {
      rows: output,
      projects: [...new Set(output.map((r) => r.projectId).filter(Boolean))].sort(),
      customers: [...new Set(output.map((r) => r.customer).filter(Boolean))].sort(),
      statuses: [...new Set(output.map((r) => r.dispatchStatus).filter(Boolean))].sort()
    };
  }, []);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: 14, color: '#475569', fontSize: 13 }}>
        Ready quantity uses recorded final QC accepted quantity and challans linked by exact Sales Order and item. Value uses the matching Sales Order line rate, excluding tax. Missing links or rates remain unvalued; planned quantity is never treated as production.
      </div>
      <ReportRegister
        title="Ready to Dispatch with Value"
        subTitle="Sales Order line view · QC-cleared balance · line-rate value excluding tax"
        filename={`Ready-To-Dispatch-Value-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        rows={rows}
        enableCSV
        summaryCards={(rs) => [
          { label: 'Sales Order Lines', value: rs.length, color: '#0369a1', bg: '#f0f9ff' },
          { label: 'Lines Without Exact Job Card Link', value: rs.filter((row) => row.readyQty == null).length, color: '#b45309', bg: '#fffbeb' },
          { label: 'Lines Without Sales Rate', value: rs.filter((row) => row.readyQty != null && row.unitRate == null).length, color: '#475569', bg: '#f8fafc' }
        ]}
        columns={[
          { key: 'date', label: 'Order Date' }, { key: 'customer', label: 'Customer' }, { key: 'salesOrder', label: 'Sales Order' },
          { key: 'projectId', label: 'Project' }, { key: 'jobCards', label: 'Job Card(s)' }, { key: 'itemCode', label: 'Item Code' },
          { key: 'itemName', label: 'Item' }, { key: 'unit', label: 'Unit' },
          { key: 'orderedQty', label: 'Ordered', align: 'right', renderText: (r) => r.orderedQty == null ? '' : String(r.orderedQty) },
          { key: 'producedQty', label: 'Recorded Output', align: 'right' },
          { key: 'acceptedQty', label: 'QC Accepted', align: 'right', renderText: (r) => r.acceptedQty == null ? '' : String(r.acceptedQty) },
          { key: 'dispatchedQty', label: 'Dispatched', align: 'right', renderText: (r) => r.dispatchedQty == null ? '' : String(r.dispatchedQty) },
          { key: 'readyQty', label: 'Ready', align: 'right', renderText: (r) => r.readyQty == null ? '' : String(r.readyQty) },
          { key: 'unitRate', label: 'SO Unit Rate', align: 'right', renderText: (r) => r.unitRate == null ? '' : `${r.currency} ${r.unitRate}` },
          { key: 'readyValue', label: 'Ready Value (excl. tax)', align: 'right', renderText: (r) => r.readyValue == null ? '' : `${r.currency} ${r.readyValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` },
          { key: 'valueBasis', label: 'Value Basis' }, { key: 'dispatchStatus', label: 'Status' }
        ]}
        filters={[
          { key: 'projectId', placeholder: 'All Projects', options: projects.map((v) => ({ value: v, label: v })) },
          { key: 'customer', placeholder: 'All Customers', options: customers.map((v) => ({ value: v, label: v })) },
          { key: 'dispatchStatus', placeholder: 'All Statuses', options: statuses.map((v) => ({ value: v, label: v })) }
        ]}
        totals={[
          { colKey: 'readyQty', render: (rs) => groupedTotal(rs, 'readyQty', 'unit') },
          { colKey: 'readyValue', render: (rs) => groupedTotal(rs, 'readyValue', 'currency') }
        ]}
      />
    </div>
  );
};

export default ReadyToDespatchPage;
