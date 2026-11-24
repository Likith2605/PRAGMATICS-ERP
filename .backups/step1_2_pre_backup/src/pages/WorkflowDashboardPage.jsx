import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import { getCurrentUserInfo } from '../utils/permissions.js';
import {
  getWorkflowDashboard,
  getSalesOrdersWithMaterialStatus,
  getIndents,
  getReceipts,
  getRejectionReports,
  getQualityChecks,
  getPOProgress
} from '../utils/workflowService.js';
import {
  getRequirementsAwaitingStoreReview,
  getRequirementSummary
} from '../utils/productionRequirementService.js';

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

const StatCard = ({ label, value, tone = 'neutral', onClick }) => (
  <div
    onClick={onClick}
    style={{
      background: '#fff',
      border: '1px solid #e2e8f0',
      borderRadius: '10px',
      padding: '14px 16px',
      cursor: onClick ? 'pointer' : 'default',
      minWidth: '160px'
    }}
  >
    <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, marginBottom: '6px' }}>{label}</div>
    <div
      style={{
        fontSize: '26px',
        fontWeight: 800,
        color: tone === 'danger' ? '#b91c1c' : tone === 'success' ? '#166534' : tone === 'warn' ? '#b45309' : '#1e293b'
      }}
    >
      {value}
    </div>
  </div>
);

const Section = ({ title, children }) => (
  <div className="content-block">
    <div className="block-header">
      <h3 className="block-title">{title}</h3>
    </div>
    {children}
  </div>
);

const QueueTable = ({ columns, rows, empty, navigate, actionRoute, stateKey }) => (
  <div className="history-table-wrapper">
    <table className="history-table">
      <thead>
        <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length} className="no-history-row">{empty}</td></tr>
        ) : (
          rows.map((r) => (
            <tr key={r.key}>
              {columns.map((c) => (
                <td key={c}>{r.cells[c]}</td>
              ))}
              <td>
                <button
                  className="button-small button-secondary"
                  onClick={() =>
                    navigate(actionRoute, stateKey && r[stateKey] ? { state: { [stateKey]: r[stateKey] } } : undefined)
                  }
                >
                  {r.action || 'Open'}
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

/** Generic projection helper: turns a dashboard row object into table cells. */
const toRows = (list, keyName, fieldMap, nav) =>
  (list || []).map((r, idx) => {
    const cells = {};
    Object.entries(fieldMap).forEach(([header, value]) => {
      const v = typeof value === 'function' ? value(r) : r[value];
      cells[header] = v == null || v === '' ? '—' : v;
    });
    return { key: r[keyName] || `${keyName}-${idx}`, [keyName]: r[keyName], cells, action: r.action };
  });

const WorkflowDashboardPage = () => {
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);
  const info = getCurrentUserInfo();
  const dept = info.employee?.department || '';

  const dash = useMemo(() => getWorkflowDashboard(), [tick]);
  const reqSummary = useMemo(() => getRequirementSummary(), [tick]);
  const awaitingReqs = useMemo(() => getRequirementsAwaitingStoreReview(), [tick]);
  const soStatus = useMemo(() => getSalesOrdersWithMaterialStatus(), [tick]);
  const indents = useMemo(() => getIndents(), [tick]);
  const receipts = useMemo(() => getReceipts(), [tick]);
  const rejections = useMemo(() => getRejectionReports(), [tick]);
  const qcs = useMemo(() => getQualityChecks(), [tick]);

  /**
   * Joins every workflow record into one readable chain per PO / receipt so the
   * full SO → Indent → Enquiry → Quotation → PO → Receipt → QC lineage is visible.
   */
  const buildDocumentChains = () => {
    const read = (key) => {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const enquiries = read('vendorEnquiries');
    const quotations = read('vendorQuotations');
    const chains = new Map();

    const upsert = (poNumber, patch) => {
      if (!poNumber) return;
      const key = String(poNumber);
      if (!chains.has(key)) chains.set(key, { key, poNumber });
      Object.assign(chains.get(key), patch);
    };

    indents.forEach((i) => {
      chains.set(`indent:${i.indentNumber}`, {
        key: `indent:${i.indentNumber}`,
        projectId: i.projectId,
        soNumber: i.soNumber,
        indentNumber: i.indentNumber,
        poNumber: i.poNumber
      });
    });

    enquiries.forEach((e) => {
      const link = chains.get(`indent:${e.indentNumber}`);
      if (link) {
        link.enquiryNumber = link.enquiryNumber ? `${link.enquiryNumber}, ${e.enquiryNumber}` : e.enquiryNumber;
        link.projectId = link.projectId || e.projectId;
        link.soNumber = link.soNumber || e.soNumber;
      }
    });

    quotations.forEach((q) => {
      const enq = enquiries.find((e) => String(e.enquiryNumber) === String(q.enquiryNumber));
      const link = enq ? chains.get(`indent:${enq.indentNumber}`) : null;
      if (link) {
        link.quotationNumber = link.quotationNumber ? `${link.quotationNumber}, ${q.quotationNumber}` : q.quotationNumber;
        link.projectId = link.projectId || q.projectId;
        link.soNumber = link.soNumber || q.soNumber;
      }
    });

    receipts.forEach((r) => upsert(r.poNumber, { projectId: r.projectId || undefined, soNumber: r.soNumber || undefined, receiptNumber: r.receiptNumber }));
    qcs.forEach((q) => upsert(q.poNumber, { projectId: q.projectId || undefined, receiptNumber: q.receiptNumber || undefined, qcNumber: q.qcNumber }));
    [...chains.values()].forEach((c) => {
      if (!c.poNumber) return;
      upsert(c.poNumber, {
        projectId: c.projectId,
        soNumber: c.soNumber,
        indentNumber: c.indentNumber,
        enquiryNumber: c.enquiryNumber,
        quotationNumber: c.quotationNumber
      });
    });

    return [...chains.values()]
      .filter((c) => c.projectId || c.indentNumber || c.receiptNumber)
      .map((c) => {
        const progress = c.poNumber ? getPOProgressSafe(c.poNumber) : null;
        let status = 'In Progress';
        if (c.receiptNumber && !c.qcNumber) status = 'Awaiting Quality Check';
        else if (c.qcNumber) status = 'Quality Checked';
        if (progress && progress.ordered > 0 && progress.pending === 0) status = 'Fully Received / Closed';
        return { ...c, status };
      })
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  };

  const getPOProgressSafe = (poNumber) => {
    try {
      return getPOProgress(poNumber);
    } catch {
      return null;
    }
  };

  const chains = useMemo(() => buildDocumentChains(), [tick]);

  const isStore = dept === 'Store Department';  const isPurchase = dept === 'Purchase Department';
  const isProduction = dept === 'Production Department';
  const isAdmin = !isStore && !isPurchase && !isProduction;

  const title = isStore ? 'Store Dashboard' : isPurchase ? 'Purchase Dashboard' : isProduction ? 'Production Dashboard' : 'Workflow Dashboard';

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Sales Order → Production Requirement → Store Review → Purchase → Quality → Inventory → Production</div>
          <h1 className="page-title">{title}</h1>
          <p className="page-description">
            Live status of the procurement workflow for {dept || 'all departments'}.
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          <button className="button-secondary" onClick={() => setTick((t) => t + 1)}>Refresh</button>
        </div>
      </div>

      {(isStore || isAdmin) && (
        <>
          <Section title="Store — Item Requirements, Indents, Receipts, Quality">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <StatCard label="Item Requirements awaiting Store review" value={reqSummary.awaitingReview} tone="warn" onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Requirements with shortage" value={reqSummary.shortage} tone="danger" onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Material available (requirements)" value={reqSummary.materialAvailable} tone="success" onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Requirements completed" value={reqSummary.completed} onClick={() => navigate('/store/item-requirements')} />
              <StatCard label="Indents (Draft)" value={dash.store.indentsDraft} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Indents submitted" value={dash.store.indentsSubmitted} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Material receipts" value={dash.store.receipts} onClick={() => navigate('/material-receipts')} />
              <StatCard label="POs pending receipt" value={dash.store.pendingReceipts} tone="warn" onClick={() => navigate('/material-receipts')} />
              <StatCard label="POs partially received" value={dash.store.poPartial} onClick={() => navigate('/material-receipts')} />
              <StatCard label="POs fully received & closed" value={dash.store.poClosed} tone="success" onClick={() => navigate('/material-receipts')} />
              <StatCard label="Materials pending quality check" value={dash.store.pendingQC} tone="warn" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Accepted material awaiting inventory posting" value={dash.store.acceptedAwaitingPosting} tone="warn" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Rejected materials" value={dash.store.rejectedMaterials} tone="danger" onClick={() => navigate('/material-receipts')} />
              <StatCard label="Replacement pending" value={dash.store.replacementAwaitingReceipt} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Rejections to forward to Purchase" value={dash.store.rejectionsToForward} tone="danger" onClick={() => navigate('/material-receipts')} />
            </div>
          </Section>

          <Section title="Item Requirements awaiting Store review">
            <QueueTable
              navigate={navigate}
              actionRoute="/store/item-requirements"
              stateKey="requirementNumber"
              columns={['Requirement', 'Project ID', 'Production Job', 'Customer', 'Date', 'Items', 'Status']}
              rows={toRows(awaitingReqs, 'requirementNumber', {
                Requirement: 'requirementNumber',
                'Project ID': 'projectId',
                'Production Job': 'productionJob',
                Customer: 'customer',
                Date: 'requirementDate',
                Items: (r) => (r.items?.length || 0),
                Status: 'status'
              })}
              empty="No Item Requirement is awaiting Store review."
            />
          </Section>

          <Section title="Purchase Orders awaiting material receipt">
            <QueueTable
              navigate={navigate}
              actionRoute="/material-receipts"
              stateKey="poNumber"
              columns={['PO Number', 'Project ID', 'SO', 'Indent', 'Vendor', 'Ordered | Received | Pending', 'Status']}
              rows={toRows(dash.store.sections.poAwaitingDelivery, 'poNumber', {
                'PO Number': 'poNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                Indent: 'indentNumber',
                Vendor: 'vendor',
                'Ordered | Received | Pending': (r) => `${r.ordered} | ${r.received} | ${r.pending}`,
                Status: 'status'
              })}
              empty="No Purchase Order is awaiting delivery."
            />
          </Section>

          <Section title="Material receipts awaiting quality check">
            <QueueTable
              navigate={navigate}
              actionRoute="/quality-checks"
              stateKey="receiptNumber"
              columns={['Receipt', 'PO', 'Project ID', 'Vendor', 'Received Qty', 'Date Received', 'Status']}
              rows={toRows(dash.store.sections.receiptsAwaitingQC, 'receiptNumber', {
                Receipt: 'receiptNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                Vendor: 'vendor',
                'Received Qty': 'receivedQty',
                'Date Received': 'dateReceived',
                Status: 'status'
              })}
              empty="No material is waiting for a quality check."
            />
          </Section>

          <Section title="Accepted material awaiting inventory posting">
            <QueueTable
              navigate={navigate}
              actionRoute="/quality-checks"
              stateKey="qcNumber"
              columns={['QC No', 'PO', 'Project ID', 'Accepted Qty', 'Status']}
              rows={toRows(dash.store.sections.acceptedAwaitingPosting, 'qcNumber', {
                'QC No': 'qcNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                'Accepted Qty': 'acceptedQty',
                Status: 'status'
              })}
              empty="All approved material has been posted to Inventory."
            />
          </Section>

          <Section title="Rejected material processing">
            <QueueTable
              navigate={navigate}
              actionRoute="/material-receipts"
              stateKey="rejectionNumber"
              columns={['Rejection Report', 'PO', 'Project ID', 'Vendor', 'Rejected Qty', 'Status']}
              rows={toRows(dash.store.sections.rejectedMaterials, 'rejectionNumber', {
                'Rejection Report': 'rejectionNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                Vendor: 'vendor',
                'Rejected Qty': 'rejectedQty',
                Status: 'status'
              })}
              empty="No rejected material is pending action."
            />
          </Section>

          <Section title="Sales Order material status">
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Sales Order</th><th>Customer</th><th>Materials</th><th>Pending Materials</th><th>Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {soStatus.length === 0 ? (
                    <tr><td colSpan="6" className="no-history-row">No sales orders.</td></tr>
                  ) : (
                    soStatus.map((so) => {
                      const pending = (so.material?.lines || []).filter((l) => l.pending > 0);
                      return (
                        <tr key={so.reference}>
                          <td><strong>{so.reference}</strong></td>
                          <td>{so.company}</td>
                          <td>{so.material?.lines?.length || 0}</td>
                          <td>{pending.length}</td>
                          <td><span className={badgeClass(so.material?.overallStatus)}>{so.material?.overallStatus}</span></td>
                          <td>
                            <button className="button-small button-secondary" onClick={() => navigate('/store/item-requirements')}>
                              View in Store
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      {(isPurchase || isAdmin) && (
        <Section title="Purchase — Indents, POs, Receipts, Rejections">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            <StatCard label="New Purchase Indents" value={dash.purchase.newIndents} tone="warn" onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Indents awaiting Production" value={dash.purchase.awaitingProduction} onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Indents ready to convert" value={dash.purchase.readyToConvert} tone="warn" onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Indents converted to PO" value={dash.purchase.converted} tone="success" onClick={() => navigate('/purchase-indents')} />
            <StatCard label="Purchase Orders" value={dash.purchase.posTotal} onClick={() => navigate('/purchase-order')} />
            <StatCard label="POs partially received" value={dash.purchase.posPartial} tone="warn" onClick={() => navigate('/material-receipts')} />
            <StatCard label="POs fully received" value={dash.purchase.posFull} tone="success" onClick={() => navigate('/material-receipts')} />
            <StatCard label="Tax invoices / receipts" value={dash.purchase.receipts} onClick={() => navigate('/material-receipts')} />
            <StatCard label="Vendor enquiries" value={dash.purchase.enquiries} onClick={() => navigate('/vendor-enquiry')} />
            <StatCard label="Vendor quotations" value={dash.purchase.quotations} onClick={() => navigate('/vendor-quotations')} />
            <StatCard label="Rejections awaiting replacement" value={dash.purchase.replacementsPending} tone="danger" onClick={() => navigate('/material-receipts')} />
            <StatCard label="Rejections to send to vendor" value={dash.purchase.rejectionsForVendor} tone="danger" onClick={() => navigate('/material-receipts')} />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Purchase Indents awaiting procurement</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/purchase-indents"
              stateKey="indentNumber"
              columns={['Indent', 'Date', 'SO', 'Project ID', 'Customer', 'Materials', 'Purchase Qty', 'Required Date', 'Status']}
              rows={toRows(dash.purchase.sections.indentsAwaitingProcurement, 'indentNumber', {
                Indent: 'indentNumber',
                Date: 'indentDate',
                SO: 'soNumber',
                'Project ID': 'projectId',
                Customer: 'customer',
                Materials: 'materialCount',
                'Purchase Qty': 'purchaseQty',
                'Required Date': 'requiredDate',
                Status: 'status'
              })}
              empty="No purchase indent is waiting for procurement action."
            />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Purchase Order status</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/purchase-order"
              stateKey="poNumber"
              columns={[
                'PO',
                'Project ID',
                'SO',
                'Indent',
                'Vendor',
                'Ordered',
                'Received',
                'QC Pending',
                'Accepted',
                'Rejected',
                'Replacement Pending',
                'Replacement Received',
                'Balance',
                'Status',
                'Fulfillment'
              ]}
              rows={toRows(dash.purchase.sections.purchaseOrders, 'poNumber', {
                PO: 'poNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                Indent: 'indentNumber',
                Vendor: 'vendor',
                Ordered: 'ordered',
                Received: 'received',
                'QC Pending': 'qcPending',
                Accepted: 'accepted',
                Rejected: 'rejected',
                'Replacement Pending': 'pendingReplacement',
                'Replacement Received': 'replacementArrived',
                Balance: 'pending',
                Status: 'status',
                Fulfillment: 'fulfillmentStatus'
              })}
              empty="No purchase orders raised yet."
            />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Rejections awaiting replacement purchase</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/material-receipts"
              stateKey="rejectionNumber"
              columns={['Rejection Report', 'PO', 'Project ID', 'Vendor', 'Rejected Qty', 'Status']}
              rows={toRows(dash.purchase.sections.rejectionsAwaitingReplacement, 'rejectionNumber', {
                'Rejection Report': 'rejectionNumber',
                PO: 'poNumber',
                'Project ID': 'projectId',
                Vendor: 'vendor',
                'Rejected Qty': 'rejectedQty',
                Status: 'status'
              })}
              empty="Every rejection has a replacement order in progress."
            />
          </div>

          <div style={{ marginTop: '18px' }}>
            <h4 className="block-title" style={{ marginBottom: '8px' }}>Replacement orders</h4>
            <QueueTable
              navigate={navigate}
              actionRoute="/purchase-indents"
              stateKey="indentNumber"
              columns={['Replacement Indent', 'Project ID', 'SO', 'Replacement PO', 'Purchase Qty', 'Status']}
              rows={toRows(dash.purchase.sections.replacementOrders, 'indentNumber', {
                'Replacement Indent': 'indentNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                'Replacement PO': 'poNumber',
                'Purchase Qty': 'purchaseQty',
                Status: 'status'
              })}
              empty="No replacement order has been raised yet."
            />
          </div>

          <div className="history-table-wrapper" style={{ marginTop: '18px' }}>
            <table className="history-table">
              <thead>
                <tr><th>Indent</th><th>Project ID</th><th>SO</th><th>Customer</th><th>Materials</th><th>Status</th><th>PO</th></tr>
              </thead>
              <tbody>
                {indents.length === 0 ? (
                  <tr><td colSpan="7" className="no-history-row">No purchase indents yet.</td></tr>
                ) : (
                  indents.map((i) => (
                    <tr key={i.indentNumber}>
                      <td><strong>{i.indentNumber}</strong></td>
                      <td>{i.projectId || '—'}</td>
                      <td>{i.soNumber}</td>
                      <td>{i.customer || '—'}</td>
                      <td>{i.items?.length || 0}</td>
                      <td><span className={badgeClass(i.status)}>{i.status}</span></td>
                      <td>{i.poNumber || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(isProduction || isAdmin) && (
        <>
          <Section title="Production — Additional requirements, Quality inspections, Material readiness">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <StatCard label="Sales Orders open" value={dash.production.salesOrders} onClick={() => navigate('/sales-order')} />
              <StatCard label="Additional material requests" value={dash.production.additionalRequests} onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Indents awaiting clarification" value={dash.production.pendingClarifications} tone="warn" onClick={() => navigate('/purchase-indents')} />
              <StatCard label="Materials awaiting quality check" value={dash.production.awaitingQC} tone="warn" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Inspections in progress" value={dash.production.underInspection} onClick={() => navigate('/quality-checks')} />
              <StatCard label="Rejected materials" value={dash.production.rejectedMaterials} tone="danger" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Approved materials" value={dash.production.approvedMaterials} tone="success" onClick={() => navigate('/quality-checks')} />
              <StatCard label="Materials available for production" value={dash.production.materialsAvailable} tone="success" />
            </div>
          </Section>

          <Section title="Quality inspection queue (awaiting check)">
            <QueueTable
              navigate={navigate}
              actionRoute="/quality-checks"
              stateKey="reference"
              columns={['Source', 'Reference', 'PO', 'Project ID', 'SO', 'Indent', 'Vendor', 'Quantity', 'Status']}
              rows={toRows(dash.quality.awaitingCheck, 'reference', {
                Source: 'source',
                Reference: 'reference',
                PO: 'poNumber',
                'Project ID': 'projectId',
                SO: 'soNumber',
                Indent: 'indentNumber',
                Vendor: 'vendor',
                Quantity: 'quantity',
                Status: 'status'
              })}
              empty="No material is awaiting inspection."
            />
          </Section>

          <Section title="Quality inspection results">
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr><th>QC No</th><th>Date</th><th>Project ID</th><th>Receipt / Indent</th><th>PO</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {qcs.length === 0 ? (
                    <tr><td colSpan="6" className="no-history-row">No quality inspections recorded yet.</td></tr>
                  ) : (
                    qcs.map((q) => (
                      <tr key={q.qcNumber}>
                        <td><strong>{q.qcNumber}</strong></td>
                        <td>{q.inspectionDate}</td>
                        <td>{q.projectId || '—'}</td>
                        <td>{q.receiptNumber || q.indentNumber || '—'}</td>
                        <td>{q.poNumber || '—'}</td>
                        <td><span className={badgeClass(q.status)}>{q.status}</span></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Sales Orders ready / pending for production">
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr><th>Sales Order</th><th>Customer</th><th>Material List</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {soStatus.length === 0 ? (
                    <tr><td colSpan="4" className="no-history-row">No sales orders.</td></tr>
                  ) : (
                    soStatus.map((so) => (
                      <tr key={so.reference}>
                        <td><strong>{so.reference}</strong></td>
                        <td>{so.company}</td>
                        <td>
                          {(so.material?.lines || []).map((l, idx) => (
                            <div key={idx} style={{ fontSize: '12px' }}>
                              {l.materialName}: required {l.required} · available {l.available} · received {l.received} · pending {l.pending}
                            </div>
                          ))}
                        </td>
                        <td><span className={badgeClass(so.material?.overallStatus)}>{so.material?.overallStatus}</span></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      <Section title="Document chain traceability (Project → SO → Indent → Enquiry → Quotation → PO → Receipt → QC)">
        <p style={{ margin: '0 0 12px', color: '#4b5563', fontSize: '13px' }}>
          Project ID is inherited automatically through every document. Rejected material re-enters procurement as a
          new indent/enquiry/quotation/PO so the original Purchase Order is never reopened.
        </p>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Project ID</th><th>SO</th><th>Indent</th><th>Enquiry</th><th>Quotation</th>
                <th>PO</th><th>Receipt</th><th>QC</th><th>Chain Status</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                if (chains.length === 0) {
                  return <tr><td colSpan="9" className="no-history-row">No document chain data yet.</td></tr>;
                }
                return chains.map((c) => (
                  <tr key={c.key}>
                    <td><strong>{c.projectId || '—'}</strong></td>
                    <td>{c.soNumber || '—'}</td>
                    <td>{c.indentNumber || '—'}</td>
                    <td>{c.enquiryNumber || '—'}</td>
                    <td>{c.quotationNumber || '—'}</td>
                    <td>{c.poNumber || '—'}</td>
                    <td>{c.receiptNumber || '—'}</td>
                    <td>{c.qcNumber || '—'}</td>
                    <td><span className={badgeClass(c.status)}>{c.status}</span></td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Recent workflow activity">
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr><th>Document</th><th>Reference</th><th>Status</th></tr>
            </thead>
            <tbody>
              {[
                ...receipts.slice(0, 5).map((r) => ({ type: 'Material Receipt', ref: r.receiptNumber, status: r.qcStatus || 'Pending Quality Check' })),
                ...qcs.slice(0, 5).map((q) => ({ type: 'Quality Check', ref: q.qcNumber, status: q.status })),
                ...rejections.slice(0, 5).map((r) => ({ type: 'Rejection Report', ref: r.rejectionNumber, status: r.status })),
                ...indents.slice(0, 5).map((i) => ({ type: 'Purchase Indent', ref: i.indentNumber, status: i.status }))
              ]
                .slice(0, 12)
                .map((row, idx) => (
                  <tr key={`${row.ref}-${idx}`}>
                    <td>{row.type}</td>
                    <td><strong>{row.ref}</strong></td>
                    <td><span className={badgeClass(row.status)}>{row.status}</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Section>
    </section>
  );
};

export default WorkflowDashboardPage;
