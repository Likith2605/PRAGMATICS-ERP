import { useEffect, useMemo, useState } from 'react';
import { hasPermission } from '../utils/permissions.js';
import {
  returnMaterial,
  getMaterialReturns,
  getStoreIssues
} from '../utils/storeService.js';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import StoreAuditLogView from '../components/StoreAuditLogView.jsx';
import EmployeeSearchSelect from '../components/EmployeeSearchSelect.jsx';
import ReportRegister from '../components/ReportRegister.jsx';
import VendorMasterAutocomplete from '../components/VendorMasterAutocomplete.jsx';

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

const load = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
};
const save = (key, list) => localStorage.setItem(key, JSON.stringify(list));

const nextSegmentNumber = (prefix, list, field) => {
  let maxSeq = 0;
  list.forEach((r) => {
    const m = String(r[field] || '').match(/(\d+)$/);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  });
  const fy = new Date().getFullYear().toString().slice(-2);
  return `${prefix}-${fy}${String(maxSeq + 1).padStart(4, '0')}`;
};

const SalesReturnForm = ({ invoices, onDone, onCancel }) => {
  const [invRef, setInvRef] = useState('');
  const [items, setItems] = useState([]);
  const [returnedBy, setReturnedBy] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');

  const selectedInv = invoices.find((i) => i.reference === invRef);

  const pickInvoice = (ref) => {
    setInvRef(ref);
    const inv = invoices.find((i) => i.reference === ref);
    if (inv && inv.payload?.items) {
      setItems(
        inv.payload.items.map((it) => ({
          itemCode: it.itemCode || '',
          itemName: it.itemName || '',
          drawingNo: it.drawingNo || '',
          unit: it.unit || 'Nos',
          invoicedQty: Number(it.quantity) || 0,
          unitPrice: Number(it.unitPrice) || 0,
          returnQty: 0,
          reason: ''
        }))
      );
    } else {
      setItems([]);
    }
  };

  const handleConfirm = () => {
    setError('');
    if (!invRef) return setError('Select a Customer Invoice to return against.');
    if (!returnedBy.trim()) return setError('Enter who is returning the goods.');
    const lines = items
      .filter((it) => Number(it.returnQty) > 0)
      .map((it) => ({
        ...it,
        returnQty: Number(it.returnQty) || 0,
        amount: ((Number(it.returnQty) || 0) * Number(it.unitPrice) || 0)
      }));
    if (lines.length === 0) return setError('Enter a return quantity for at least one item.');
    const existing = load('salesReturnHistory');
    const rec = {
      returnNumber: nextSegmentNumber('SRTN', existing, 'returnNumber'),
      date: new Date().toISOString().slice(0, 10),
      invRef,
      customer: selectedInv?.company || selectedInv?.payload?.customerDetails?.companyName || '-',
      items: lines,
      totalValue: lines.reduce((a, l) => a + l.amount, 0),
      returnedBy,
      remarks
    };
    save('salesReturnHistory', [rec, ...existing]);
    onDone(rec);
  };

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">New Sales Return (against Customer Invoice)</h3>
        <span className="muted-text">Auto-numbered SRTN-xxxxxx on confirm</span>
      </div>

      <div className="form-field">
        <label>Customer Invoice *</label>
        <select className="action-select" value={invRef} onChange={(e) => pickInvoice(e.target.value)}>
          <option value="">— Select Invoice —</option>
          {invoices.map((i) => (
            <option key={i.reference} value={i.reference}>
              {i.reference} · {i.company} · {i.date}
            </option>
          ))}
        </select>
      </div>

      {selectedInv && (
        <div className="detail-grid">
          <div><strong>Invoice No:</strong> {selectedInv.reference}</div>
          <div><strong>Customer:</strong> {selectedInv.company}</div>
          <div><strong>Invoice Date:</strong> {selectedInv.date}</div>
          <div><strong>Invoice Total:</strong> {selectedInv.total}</div>
        </div>
      )}

      {items.length > 0 && (
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Item</th>
                <th>Invoiced Qty</th>
                <th>Return Qty</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td>{idx + 1}</td>
                  <td>{it.itemName} <span className="muted-text">({it.drawingNo || '—'})</span></td>
                  <td>{it.invoicedQty} {it.unit}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max={it.invoicedQty}
                      step="any"
                      className="issue-qty-input"
                      value={it.returnQty}
                      onChange={(e) => {
                        const next = [...items];
                        next[idx] = { ...next[idx], returnQty: e.target.value };
                        setItems(next);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="issue-qty-input wide"
                      placeholder="e.g. Defective / Excess / Damaged in transit"
                      value={it.reason}
                      onChange={(e) => {
                        const next = [...items];
                        next[idx] = { ...next[idx], reason: e.target.value };
                        setItems(next);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="form-grid">
        <div className="form-field">
          <label>Returned By *</label>
          <input type="text" className="action-select form-input" value={returnedBy} onChange={(e) => setReturnedBy(e.target.value)} placeholder="e.g. Vasudev" />
        </div>
        <div className="form-field">
          <label>Remarks / Credit Note Note</label>
          <input type="text" className="action-select form-input" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Credit note to be issued" />
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="template-modal-actions start-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="button-primary" onClick={handleConfirm}>Confirm Sales Return</button>
      </div>
    </div>
  );
};

const PurchaseReturnForm = ({ bills, onDone, onCancel }) => {
  const [billRef, setBillRef] = useState('');
  const [items, setItems] = useState([]);
  const [returnedTo, setReturnedTo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');

  const selectedBill = bills.find((b) => b.reference === billRef);

  const pickBill = (ref) => {
    setBillRef(ref);
    const bill = bills.find((b) => b.reference === ref);
    if (bill && bill.payload?.items) {
      setItems(
        bill.payload.items.map((it) => ({
          itemCode: it.itemCode || '',
          itemName: it.itemName || '',
          drawingNo: it.drawingNo || '',
          unit: it.unit || 'Nos',
          billedQty: Number(it.quantity) || 0,
          unitPrice: Number(it.unitPrice) || 0,
          returnQty: 0,
          reason: ''
        }))
      );
    } else {
      setItems([]);
    }
  };

  const handleConfirm = () => {
    setError('');
    if (!billRef) return setError('Select a Supplier Bill to return against.');
    if (!returnedTo.trim()) return setError('Enter the supplier returning goods to.');
    const lines = items
      .filter((it) => Number(it.returnQty) > 0)
      .map((it) => ({
        ...it,
        returnQty: Number(it.returnQty) || 0,
        amount: ((Number(it.returnQty) || 0) * Number(it.unitPrice) || 0)
      }));
    if (lines.length === 0) return setError('Enter a return quantity for at least one item.');
    const existing = load('purchaseReturnHistory');
    const rec = {
      returnNumber: nextSegmentNumber('PRTN', existing, 'returnNumber'),
      date: new Date().toISOString().slice(0, 10),
      billRef,
      supplier: selectedBill?.vendor || selectedBill?.payload?.vendorDetails?.companyName || '-',
      items: lines,
      totalValue: lines.reduce((a, l) => a + l.amount, 0),
      returnedTo,
      remarks
    };
    save('purchaseReturnHistory', [rec, ...existing]);
    onDone(rec);
  };

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">New Purchase Return (against Supplier Bill)</h3>
        <span className="muted-text">Auto-numbered PRTN-xxxxxx on confirm</span>
      </div>

      <div className="form-field">
        <label>Supplier Bill *</label>
        <select className="action-select" value={billRef} onChange={(e) => pickBill(e.target.value)}>
          <option value="">— Select Supplier Bill —</option>
          {bills.map((b) => (
            <option key={b.reference} value={b.reference}>
              {b.reference} · {b.vendor} · {b.date}
            </option>
          ))}
        </select>
      </div>

      {selectedBill && (
        <div className="detail-grid">
          <div><strong>Bill No:</strong> {selectedBill.reference}</div>
          <div><strong>Supplier:</strong> {selectedBill.vendor}</div>
          <div><strong>Bill Date:</strong> {selectedBill.date}</div>
          <div><strong>Bill Total:</strong> {selectedBill.total}</div>
        </div>
      )}

      {items.length > 0 && (
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Item</th>
                <th>Billed Qty</th>
                <th>Return Qty</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td>{idx + 1}</td>
                  <td>{it.itemName} <span className="muted-text">({it.drawingNo || '—'})</span></td>
                  <td>{it.billedQty} {it.unit}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max={it.billedQty}
                      step="any"
                      className="issue-qty-input"
                      value={it.returnQty}
                      onChange={(e) => {
                        const next = [...items];
                        next[idx] = { ...next[idx], returnQty: e.target.value };
                        setItems(next);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="issue-qty-input wide"
                      placeholder="e.g. Defective / Wrong spec / Short supply"
                      value={it.reason}
                      onChange={(e) => {
                        const next = [...items];
                        next[idx] = { ...next[idx], reason: e.target.value };
                        setItems(next);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="form-grid">
        <div className="form-field">
          <label>Returning To Supplier *</label>
          <VendorMasterAutocomplete
            className="action-select form-input"
            value={returnedTo}
            onChange={setReturnedTo}
            placeholder="Supplier name"
          />
        </div>
        <div className="form-field">
          <label>Remarks / Debit Note Note</label>
          <input type="text" className="action-select form-input" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. Debit note to be issued" />
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="template-modal-actions start-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="button-primary" onClick={handleConfirm}>Confirm Purchase Return</button>
      </div>
    </div>
  );
};

const MaterialReturnsPage = () => {
  const [tab, setTab] = useState('returns');
  const [mode, setMode] = useState('list'); // list | create | view
  const [viewNumber, setViewNumber] = useState(null);
  const [search, setSearch] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const canCreate = hasPermission('material_return.create');

  const returns = getMaterialReturns();
  const issues = getStoreIssues();

  const salesReturns = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('salesReturnHistory') || '[]');
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick, mode]);

  const purchaseReturns = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('purchaseReturnHistory') || '[]');
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick, mode]);

  const invoices = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('customerInvoiceHistory') || '[]');
    } catch {
      return [];
    }
  }, [refreshTick, mode]);

  const bills = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('supplierInvoiceHistory') || '[]');
    } catch {
      return [];
    }
  }, [refreshTick, mode]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return returns
      .filter((r) =>
        !q
          ? true
          : [r.returnNumber, r.issueNumber, r.mrNumber, r.jobCardNumber, r.projectId, r.partName, r.returnedBy]
              .join(' ')
              .toLowerCase()
              .includes(q)
      )
      .sort((a, b) => b.returnNumber.localeCompare(a.returnNumber));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returns, search, refreshTick]);

  const refresh = () => { setRefreshTick((t) => t + 1); setMode('list'); setViewNumber(null); }; 

  const selected = viewNumber ? returns.find((r) => r.returnNumber === viewNumber) : null;
  const selectedSalesReturn = viewNumber ? salesReturns.find((r) => r.returnNumber === viewNumber) : null;
  const selectedPurchaseReturn = viewNumber ? purchaseReturns.find((r) => r.returnNumber === viewNumber) : null;

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Store / Warehouse</div>
          <h1 className="page-title">Material Returns</h1>
          <p className="page-description">
            Record returned material against a Store Issue, plus Sales Returns (against customer invoices) and
            Purchase Returns (against supplier bills).
          </p>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
          {canCreate && mode !== 'create' && (
            <button type="button" className="button-primary" onClick={() => { setMode('create'); setViewNumber(null); }}>
              + New Return
            </button>
          )}
        </div>
      </div>

      <div className="tab-nav">
        <button type="button" className={`tab-link ${tab === 'returns' ? 'active' : ''}`} onClick={() => { setTab('returns'); setMode('list'); setViewNumber(null); }}>Store Returns</button>
        <button type="button" className={`tab-link ${tab === 'sales' ? 'active' : ''}`} onClick={() => { setTab('sales'); setMode('list'); setViewNumber(null); }}>Sales Returns</button>
        <button type="button" className={`tab-link ${tab === 'purchase' ? 'active' : ''}`} onClick={() => { setTab('purchase'); setMode('list'); setViewNumber(null); }}>Purchase Returns</button>
        <button type="button" className={`tab-link ${tab === 'audit' ? 'active' : ''}`} onClick={() => { setTab('audit'); setMode('list'); setViewNumber(null); }}>Audit Trail</button>
      </div>

      {tab === 'audit' ? (
        <StoreAuditLogView />
      ) : tab === 'sales' ? (
        mode === 'create' ? (
          <SalesReturnForm
            invoices={invoices}
            onDone={(rec) => { setViewNumber(rec.returnNumber); setMode('view'); }}
            onCancel={() => setMode('list')}
          />
        ) : selectedSalesReturn ? (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Sales Return {selectedSalesReturn.returnNumber}</h3>
              <span className="status-badge st-filled">Recorded</span>
            </div>
            <div className="detail-grid">
              <div><strong>Invoice:</strong> {selectedSalesReturn.invRef}</div>
              <div><strong>Customer:</strong> {selectedSalesReturn.customer || '—'}</div>
              <div><strong>Date:</strong> {selectedSalesReturn.date}</div>
              <div><strong>Return Value:</strong> ₹ {parseINR(selectedSalesReturn.totalValue).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Item</th>
                    <th>Return Qty</th>
                    <th>Unit Rate</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedSalesReturn.items.map((it, idx) => (
                    <tr key={idx}>
                      <td>{idx + 1}</td>
                      <td>{it.itemName}</td>
                      <td>{it.returnQty} {it.unit}</td>
                      <td>₹ {parseINR(it.unitPrice).toFixed(2)}</td>
                      <td>{it.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="template-modal-actions start-actions">
              <button type="button" className="button-secondary" onClick={() => window.print()}>Print</button>
              <button type="button" className="button-primary" onClick={() => { setViewNumber(null); setMode('list'); setRefreshTick((t) => t + 1); }}>&larr; Back to Sales Returns</button>
            </div>
          </div>
        ) : (
          <ReportRegister
            title="Sales Return Report"
            subTitle="Goods returned by customers (against invoices / credit notes)"
            filename={`Sales-Return-${new Date().toISOString().slice(0, 10)}`}
            dateField="date"
            columns={[
              { key: 'returnNumber', label: 'Return No' },
              { key: 'date', label: 'Date' },
              { key: 'invRef', label: 'Invoice No' },
              { key: 'customer', label: 'Customer' },
              { key: 'returnedBy', label: 'Returned By', render: (r) => r.returnedBy || '-' },
              { key: 'items', label: 'Items', render: (r) => r.items.length + ' lines' },
              { key: 'value', label: 'Return Value (₹)', align: 'right', render: (r) => parseINR(r.totalValue).toLocaleString('en-IN', { maximumFractionDigits: 2 }) }
            ]}
            rows={salesReturns}
            totals={[
              { colKey: 'value', render: (rs) => rs.reduce((a, r) => a + parseINR(r.totalValue), 0) }
            ]}
          />
        )
      ) : tab === 'purchase' ? (
        mode === 'create' ? (
          <PurchaseReturnForm
            bills={bills}
            onDone={(rec) => { setViewNumber(rec.returnNumber); setMode('view'); }}
            onCancel={() => setMode('list')}
          />
        ) : selectedPurchaseReturn ? (
          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Purchase Return {selectedPurchaseReturn.returnNumber}</h3>
              <span className="status-badge st-filled">Recorded</span>
            </div>
            <div className="detail-grid">
              <div><strong>Supplier Bill:</strong> {selectedPurchaseReturn.billRef}</div>
              <div><strong>Supplier:</strong> {selectedPurchaseReturn.supplier || '—'}</div>
              <div><strong>Date:</strong> {selectedPurchaseReturn.date}</div>
              <div><strong>Return Value:</strong> ₹ {parseINR(selectedPurchaseReturn.totalValue).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            </div>
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Item</th>
                    <th>Return Qty</th>
                    <th>Unit Rate</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPurchaseReturn.items.map((it, idx) => (
                    <tr key={idx}>
                      <td>{idx + 1}</td>
                      <td>{it.itemName}</td>
                      <td>{it.returnQty} {it.unit}</td>
                      <td>₹ {parseINR(it.unitPrice).toFixed(2)}</td>
                      <td>{it.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="template-modal-actions start-actions">
              <button type="button" className="button-secondary" onClick={() => window.print()}>Print</button>
              <button type="button" className="button-primary" onClick={() => { setViewNumber(null); setMode('list'); setRefreshTick((t) => t + 1); }}>&larr; Back to Purchase Returns</button>
            </div>
          </div>
        ) : (
          <ReportRegister
            title="Purchase Return Report"
            subTitle="Goods returned to suppliers (against bills / debit notes)"
            filename={`Purchase-Return-${new Date().toISOString().slice(0, 10)}`}
            dateField="date"
            columns={[
              { key: 'returnNumber', label: 'Return No' },
              { key: 'date', label: 'Date' },
              { key: 'billRef', label: 'Supplier Bill No' },
              { key: 'supplier', label: 'Supplier' },
              { key: 'returnedTo', label: 'Returned To', render: (r) => r.returnedTo || '-' },
              { key: 'items', label: 'Items', render: (r) => r.items.length + ' lines' },
              { key: 'value', label: 'Return Value (₹)', align: 'right', render: (r) => parseINR(r.totalValue).toLocaleString('en-IN', { maximumFractionDigits: 2 }) }
            ]}
            rows={purchaseReturns}
            totals={[
              { colKey: 'value', render: (rs) => rs.reduce((a, r) => a + parseINR(r.totalValue), 0) }
            ]}
          />
        )
      ) : mode === 'create' ? (
        <CreateReturn
          issues={issues}
          onDone={(rec) => { setViewNumber(rec.returnNumber); setMode('view'); }}
          onCancel={() => setMode('list')}
        />
      ) : selected ? (
        <ReturnDetailView ret={selected} onBack={() => { setViewNumber(null); setRefreshTick((t) => t + 1); }} />
      ) : (
        <ReportRegister
          title="Store Return Register"
          subTitle="Material returns filtered by the recorded return date."
          filename={`Store-Returns-${new Date().toISOString().slice(0, 10)}`}
          dateField="returnDate" rows={returns} enableCSV
          columns={[
            { key: 'returnNumber', label: 'Return No' }, { key: 'returnDate', label: 'Return Date' }, { key: 'issueNumber', label: 'Issue No' },
            { key: 'mrNumber', label: 'MR No' }, { key: 'jobCardNumber', label: 'Job Card' }, { key: 'projectId', label: 'Project ID' },
            { key: 'returnedBy', label: 'Returned By', renderText: (row) => `${row.returnedBy || ''}${row.returnedById ? ` (${row.returnedById})` : ''}` },
            { key: 'receivedBy', label: 'Received By' }, { key: 'items', label: 'Items', renderText: (row) => String(Array.isArray(row.items) ? row.items.length : 0) },
            { key: 'action', label: 'Action', render: (row) => <button type="button" className="button-secondary button-small" onClick={() => setViewNumber(row.returnNumber)}>View</button>, renderText: () => '' }
          ]}
          filters={[
            { key: 'returnedBy', placeholder: 'All Returners', options: [...new Set(returns.map((row) => row.returnedBy).filter(Boolean))].sort().map((value) => ({ value, label: value })) },
            { key: 'receivedBy', placeholder: 'All Receivers', options: [...new Set(returns.map((row) => row.receivedBy).filter(Boolean))].sort().map((value) => ({ value, label: value })) },
            { key: 'jobCardNumber', placeholder: 'All Job Cards', options: [...new Set(returns.map((row) => row.jobCardNumber).filter(Boolean))].sort().map((value) => ({ value, label: value })) },
            { key: 'projectId', placeholder: 'All Projects', options: [...new Set(returns.map((row) => row.projectId).filter(Boolean))].sort().map((value) => ({ value, label: value })) }
          ]}
        />
      )}
    </section>
  );
};

const CreateReturn = ({ issues, onDone, onCancel }) => {
  const [issueNumber, setIssueNumber] = useState('');
  const [returnQty, setReturnQty] = useState({});
  const [reasons, setReasons] = useState({});
  const [receiver, setReceiver] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const issuesForReturn = issues.filter((i) => (i.items || []).length > 0);

  const selectedSi = issues.find((i) => i.issueNumber === issueNumber);

  useEffect(() => {
    if (!selectedSi) { setReturnQty({}); setReasons({}); return; }
    const prefill = {};
    selectedSi.items.forEach((it) => {
      prefill[it.materialId] = 0;
    });
    setReturnQty(prefill);
    setReasons({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueNumber]);

  const handleConfirm = () => {
    setError('');
    if (!issueNumber) return setError('Select a Store Issue to return material against.');
    if (!receiver) return setError('Select the employee returning the material.');
    if (!acknowledged) return setError('Return acknowledgement checkbox is required.');
    const items = selectedSi.items
      .map((it) => ({
        materialId: it.materialId,
        materialName: it.materialName,
        materialDesc: it.materialDesc || '',
        unit: it.unit,
        quantityReturned: Number(returnQty[it.materialId]) || 0,
        reason: reasons[it.materialId] || 'Unused / excess material'
      }))
      .filter((it) => it.quantityReturned > 0);
    try {
      setBusy(true);
      const rec = returnMaterial({
        issueNumber,
        receiver: { ...receiver, acknowledged },
        items,
        remarks
      });
      setBusy(false);
      onDone(rec);
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  };

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">New Material Return</h3>
        <span className="muted-text">Auto-numbered as SR-xxxxxx on confirm</span>
      </div>

      <div className="form-field">
        <label>Against Store Issue *</label>
        <select className="action-select" value={issueNumber} onChange={(e) => setIssueNumber(e.target.value)}>
          <option value="">— Select Store Issue —</option>
          {issuesForReturn.map((i) => (
            <option key={i.issueNumber} value={i.issueNumber}>
              {i.issueNumber} · {i.projectId ? `Project ${i.projectId} · ` : ''}{i.jobCardNumber ? `JC ${i.jobCardNumber} · ` : ''}{i.partName || '—'} · Received by {i.receivedBy}
            </option>
          ))}
        </select>
      </div>

      {selectedSi && (
        <div className="detail-grid">
          <div><strong>MR No:</strong> {selectedSi.mrNumber || '—'}</div>
          <div><strong>Job Card:</strong> {selectedSi.jobCardNumber || '—'}</div>
          <div><strong>Project ID:</strong> <span style={{ color: '#3730a3', fontWeight: '700' }}>{selectedSi.projectId || '—'}</span></div>
          <div><strong>Part Name:</strong> {selectedSi.partName || '—'}</div>
          <div><strong>Issued To:</strong> {selectedSi.receivedBy} ({selectedSi.receivedByEmpId || '—'})</div>
        </div>
      )}

      {selectedSi && (
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material</th>
                <th>Issued Qty</th>
                <th>Return Qty</th>
                <th>Return Reason</th>
              </tr>
            </thead>
            <tbody>
              {selectedSi.items.map((it, idx) => (
                <tr key={it.materialId}>
                  <td>{idx + 1}</td>
                  <td>{it.materialName} <span className="muted-text">({it.spec || '—'})</span></td>
                  <td>{it.currentIssueQty} {it.unit}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max={it.currentIssueQty}
                      step="any"
                      className="issue-qty-input"
                      value={returnQty[it.materialId] ?? 0}
                      onChange={(e) => setReturnQty((prev) => ({ ...prev, [it.materialId]: e.target.value }))}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="issue-qty-input wide"
                      placeholder="e.g. Unused / excess / defective"
                      value={reasons[it.materialId] || ''}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [it.materialId]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="block-header">
        <h3 className="block-title">Returned By</h3>
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label>Returning Employee *</label>
          <EmployeeSearchSelect value={receiver} onChange={setReceiver} />
        </div>
      </div>

      <label className="acknowledgement-box">
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>I confirm that the above material is being returned{receiver ? ` — ${receiver.name} (${receiver.employeeId})` : ''}.</span>
      </label>

      <div className="form-field">
        <label>Remarks / Notes</label>
        <textarea className="action-select form-input" rows="2" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="template-modal-actions start-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="button-primary" disabled={busy} onClick={handleConfirm}>
          {busy ? 'Recording...' : 'Confirm Return'}
        </button>
      </div>
    </div>
  );
};

const ReturnDetailView = ({ ret, onBack }) => (
  <div className="content-block">
    <div className="block-header">
      <h3 className="block-title">Material Return {ret.returnNumber}</h3>
      <span className="status-badge st-filled">Acknowledged</span>
    </div>

    <div className="si-document">
      <div className="si-doc-head">
        <h2>MATERIAL RETURN SLIP</h2>
        <div className="si-doc-ref">
          <div><strong>SR No:</strong> {ret.returnNumber}</div>
          <div><strong>Date:</strong> {ret.returnDate} · {ret.returnTime}</div>
        </div>
      </div>

      <div className="si-parties">
        <div className="si-party">
          <div className="si-party-title">RETURNED BY</div>
          <div className="si-party-name">{ret.returnedBy}</div>
          <div>{ret.returnedById}{ret.returnedByDept ? ` · ${ret.returnedByDept}` : ''}{ret.returnedByDesignation ? ` · ${ret.returnedByDesignation}` : ''}</div>
        </div>
        <div className="si-party">
          <div className="si-party-title">RECEIVED BY (STORE)</div>
          <div className="si-party-name">{ret.receivedBy}</div>
          <div>{ret.receivedById || ''} · {ret.receivedByDept || 'Stores'}</div>
        </div>
      </div>

      <div className="si-meta">
        <div><strong>Against SI:</strong> {ret.issueNumber || '—'}</div>
        <div><strong>MR No:</strong> {ret.mrNumber || '—'}</div>
        <div><strong>Job Card:</strong> {ret.jobCardNumber || '—'}</div>
        <div><strong>Project ID:</strong> <span style={{ color: '#3730a3', fontWeight: '700' }}>{ret.projectId || '—'}</span></div>
        <div><strong>Customer:</strong> {ret.customer || '—'}</div>
        <div><strong>Part Name:</strong> {ret.partName || '—'}</div>
      </div>

      <table className="history-table">
        <thead>
          <tr>
            <th>SL.No</th>
            <th>Material</th>
            <th>Issued Qty</th>
            <th>Returned Qty</th>
            <th>Reason</th>
            <th>Batch</th>
            <th>Lot No</th>
            <th>Heat No</th>
          </tr>
        </thead>
        <tbody>
          {ret.items.map((it, idx) => (
            <tr key={`${ret.returnNumber}-${it.materialId}`}>
              <td>{idx + 1}</td>
              <td>{it.materialName}</td>
              <td>{it.quantityIssued} {it.unit}</td>
              <td><strong>{it.quantityReturned} {it.unit}</strong></td>
              <td>{it.returnReason || '—'}</td>
              <td>{it.batchNo || '—'}</td>
              <td>{it.lotNumber || '—'}</td>
              <td>{it.heatNumber || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ret.remarks && <div className="si-remarks"><strong>Remarks:</strong> {ret.remarks}</div>}
      <div className="si-footer">Acknowledged at {ret.acknowledgedAt} · Received by {ret.receivedBy}</div>
    </div>

    <div className="template-modal-actions">
      <button type="button" className="button-secondary" onClick={() => window.print()}>Print</button>
      <button type="button" className="button-primary" onClick={onBack}>&larr; Back to Returns</button>
    </div>
  </div>
);

export default MaterialReturnsPage;
