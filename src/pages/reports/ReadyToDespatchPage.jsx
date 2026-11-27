import React, { useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { listJobCards } from '../../services/productionApi.js';
import { listSalesOrders } from '../../services/salesOrderApi.js';
import { listDeliveryChallans } from '../../services/deliveryChallanApi.js';

const list = (v) => Array.isArray(v) ? v : [];
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const clean = (v) => String(v || '').trim();
const norm = (v) => clean(v).toLocaleLowerCase().replace(/\s+/g, ' ');
// PostgreSQL job-card rows expose acceptedQuantity; legacy browser rows kept
// qualityControl.finalQC.acceptedQty. Both shapes are read, neither is written.
const acceptedQty = (jc) => num(jc?.qualityControl?.finalQC?.acceptedQty ?? jc?.acceptedQuantity);
const ReadyToDespatchPage = () => {
  const [orders, setOrders] = useState([]);
  const [challans, setChallans] = useState([]);
  const [jobCards, setJobCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      listSalesOrders().catch((err) => {
        console.warn('Failed to load sales orders for ready-to-despatch report:', err);
        throw err;
      }),
      listDeliveryChallans().catch((err) => {
        console.warn('Failed to load delivery challans for ready-to-despatch report:', err);
        throw err;
      }),
      listJobCards().catch((err) => {
        console.warn('Failed to load job cards for ready-to-despatch report:', err);
        throw err;
      })
    ]).then(([soList, dcList, jcList]) => {
      if (!active) return;
      setOrders(Array.isArray(soList) ? soList : []);
      setChallans(Array.isArray(dcList) ? dcList : []);
      setJobCards(Array.isArray(jcList) ? jcList : []);
      setError('');
    }).catch((err) => {
      if (active) setError(err.message || 'Unable to load report data from PostgreSQL.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const { rows, projects, customers, statuses } = useMemo(() => {
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
        const totalAcceptedQty = matchingJCs.reduce((sum, jc) => sum + acceptedQty(jc), 0);
        const dispatchedQty = matchingDCItems.reduce((sum, line) => sum + num(line.quantity), 0);
        const linkAvailable = matchingJCs.length > 0;
        const readyQty = linkAvailable ? Math.max(0, totalAcceptedQty - dispatchedQty) : null;
        const overDispatch = linkAvailable ? Math.max(0, dispatchedQty - totalAcceptedQty) : null;
        output.push({
          date: details.soDate || order.date || '', salesOrder: soNumber, customer, projectId,
          jobCards: matchingJCs.map((jc) => jc.jobCardNumber).filter(Boolean).join(', '),
          itemCode, itemName, unit: itemUnit,
          acceptedQty: matchingJCs.length ? totalAcceptedQty : null, dispatchedQty,
          hasExactJobCardLink: linkAvailable && !duplicateOrderLine,
          dispatchStatus: duplicateOrderLine ? 'Repeated order line; allocation ambiguous' : !matchingJCs.length ? 'No exact Job Card link' : overDispatch > 0 ? 'Over-dispatched; review' :
            readyQty > 0 ? (dispatchedQty > 0 ? 'Partially dispatched' : 'Ready to dispatch') : 'No remaining QC-cleared qty',
          lineOrdinal: index + 1
        });
      });
    });

    // Keep unlinked Job Cards visible as exceptions; no order, customer or dispatch is inferred.
    jobCards.filter((jc) => jc.jobCardNumber && !consumedJC.has(jc.jobCardNumber) && acceptedQty(jc) > 0)
      .forEach((jc) => output.push({
        date: jc.startDate || jc.poDate || '', salesOrder: '', customer: jc.customerName || '', projectId: jc.projectId || '',
        jobCards: jc.jobCardNumber, itemCode: jc.itemCode || jc.partCode || '', itemName: jc.partName || '',
        unit: jc.unit || 'Unit not recorded',
        acceptedQty: acceptedQty(jc), dispatchedQty: null,
        hasExactJobCardLink: false,
        dispatchStatus: 'Unlinked Job Card; dispatch not attributed'
      }));

    return {
      rows: output,
      projects: [...new Set(output.map((r) => r.projectId).filter(Boolean))].sort(),
      customers: [...new Set(output.map((r) => r.customer).filter(Boolean))].sort(),
      statuses: [...new Set(output.map((r) => r.dispatchStatus).filter(Boolean))].sort()
    };
  }, [orders, challans, jobCards]);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: 14, color: '#475569', fontSize: 13 }}>
        {loading ? 'Loading sales orders, delivery challans and job cards from PostgreSQL...' : 'Tracks Sales Order items, QC-accepted quantities, dispatches, and Job Card link exceptions.'}
      </div>
      {error && <div role="alert" className="form-error">{error}</div>}
      <ReportRegister
        title="Ready to Dispatch Status"
        subTitle="Sales Order lines - QC and dispatch status"
        filename={`Ready-To-Dispatch-Status-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        rows={rows}
        landscape
        enableCSV
        summaryCards={(rs) => [
          { label: 'Sales Order Lines', value: rs.length, color: '#0369a1', bg: '#f0f9ff' },
          { label: 'Lines Without Exact Job Card Link', value: rs.filter((row) => !row.hasExactJobCardLink).length, color: '#b45309', bg: '#fffbeb' }
        ]}
        columns={[
          { key: 'date', label: 'Order Date', width: 19 },
          { key: 'customer', label: 'Customer', width: 28 },
          { key: 'salesOrder', label: 'Sales Order', width: 30 },
          { key: 'projectId', label: 'Project', width: 23 },
          { key: 'jobCards', label: 'Job Card(s)', width: 27 },
          { key: 'itemCode', label: 'Item Code', width: 39 },
          { key: 'itemName', label: 'Item', width: 22 },
          { key: 'unit', label: 'Unit', width: 14 },
          { key: 'acceptedQty', label: 'QC Accepted', width: 20, align: 'right', renderText: (r) => r.acceptedQty == null ? '' : String(r.acceptedQty) },
          { key: 'dispatchedQty', label: 'Dispatched', width: 21, align: 'right', renderText: (r) => r.dispatchedQty == null ? '' : String(r.dispatchedQty) },
          { key: 'dispatchStatus', label: 'Status', width: 34 }
        ]}
        filters={[
          { key: 'projectId', placeholder: 'All Projects', options: projects.map((v) => ({ value: v, label: v })) },
          { key: 'customer', placeholder: 'All Customers', options: customers.map((v) => ({ value: v, label: v })) },
          { key: 'dispatchStatus', placeholder: 'All Statuses', options: statuses.map((v) => ({ value: v, label: v })) }
        ]}
      />
    </div>
  );
};

export default ReadyToDespatchPage;
