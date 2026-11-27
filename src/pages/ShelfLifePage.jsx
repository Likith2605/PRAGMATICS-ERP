import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getExpiryStatus, EXPIRY_NEAR_DAYS } from '../utils/storeService.js';
import { listInventoryItems, listInventoryLots, postInventoryAdjustment } from '../services/inventoryApi.js';
import { hasPermission } from '../utils/permissions.js';

/**
 * Shelf Life / Expiry Register (Store module).
 *
 * Best-practice model shared by SAP, Odoo and ERPNext:
 *  - FEFO (First Expiry, First Out) ordering: soonest expiry first.
 *  - Three states: Expired (hard-blocked at issue), Near Expiry (<= 30 days),
 *    Valid.
 *  - Expired stock leaves inventory ONLY through the audited write-off below.
 *  - A gap panel lists shelf-life-managed items that have no batch/expiry on
 *    record yet, so capture gaps are visible instead of silent.
 */

const STATUS_META = {
  EXPIRED: { label: 'Expired', color: '#b91c1c', bg: '#fee2e2' },
  NEAR: { label: `Near Expiry (≤${EXPIRY_NEAR_DAYS}d)`, color: '#b45309', bg: '#fef3c7' },
  VALID: { label: 'Valid', color: '#15803d', bg: '#dcfce7' },
  UNKNOWN: { label: 'No Expiry', color: '#64748b', bg: '#f1f5f9' }
};

const ShelfLifePage = () => {
  const canAdjust = hasPermission('inventory.adjust');
  const [inventory, setInventory] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [writeOff, setWriteOff] = useState(null); // batch being written off
  const [writeOffToken, setWriteOffToken] = useState('');
  const [woQty, setWoQty] = useState('');
  const [woReason, setWoReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [itemRows, lotRows] = await Promise.all([listInventoryItems(), listInventoryLots()]);
      const items = (Array.isArray(itemRows) ? itemRows : []).map((row) => ({
        ...(row.payload || {}),
        itemCode: row.item_code || row.payload?.itemCode || '',
        itemName: row.material_name || row.payload?.itemName || row.item_code || '',
        shelfLifeManaged: Boolean(row.shelf_life_managed),
        shelfLifeMonths: Number(row.payload?.shelfLifeMonths) || 0
      }));
      const itemFor = new Map(items.map((item) => [String(item.itemCode).toLowerCase(), item]));
      const watchList = (Array.isArray(lotRows) ? lotRows : []).map((row) => {
        const payload = row.payload || {};
        const item = itemFor.get(String(row.item_code || '').toLowerCase());
        const expiryDate = String(row.expiry_date || payload.expiryDate || '').slice(0, 10);
        const { status, daysLeft } = getExpiryStatus(expiryDate);
        return {
          ...payload,
          id: row.id,
          itemCode: row.item_code || '',
          itemName: payload.itemName || item?.itemName || row.item_code || '',
          batchNumber: row.batch_number || payload.batchNumber || '',
          lotNumber: row.lot_number || payload.lotNumber || '',
          availableQty: Number(row.available_qty) || 0,
          unit: row.unit || item?.unit || 'Nos',
          supplier: payload.supplier || '',
          grnNumber: payload.grnNumber || payload.receiptNumber || '',
          mfgDate: String(row.mfg_date || payload.mfgDate || '').slice(0, 10),
          expiryDate,
          shelfLifeManaged: Boolean(item?.shelfLifeManaged),
          status,
          daysLeft
        };
      }).filter((batch) => batch.availableQty > 0 && (batch.expiryDate || batch.shelfLifeManaged))
        .sort((a, b) => (a.expiryDate || '9999-12-31').localeCompare(b.expiryDate || '9999-12-31'));
      setInventory(items);
      setBatches(watchList);
    } catch (loadError) {
      setInventory([]);
      setBatches([]);
      setError(`Shelf-life records could not be loaded from PostgreSQL: ${loadError.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Shelf-life-managed items that have NO open batch with an expiry date yet.
  const gaps = useMemo(() => {
    const tracked = new Set(batches.filter((b) => b.expiryDate).map((b) => String(b.itemCode || '').toLowerCase()));
    return inventory.filter(
      (i) => i.shelfLifeManaged && !tracked.has(String(i.itemCode || '').toLowerCase())
    );
  }, [batches, inventory]);

  useEffect(() => { loadData(); }, [loadData]);

  const counts = batches.reduce(
    (a, b) => {
      a[b.status] = (a[b.status] || 0) + 1;
      if (b.status === 'EXPIRED') a.expiredQty += Number(b.availableQty) || 0;
      if (b.status === 'NEAR') a.nearQty += Number(b.availableQty) || 0;
      return a;
    },
    { EXPIRED: 0, NEAR: 0, VALID: 0, UNKNOWN: 0, expiredQty: 0, nearQty: 0 }
  );

  const openWriteOff = (batch) => {
    setWriteOff(batch);
    setWriteOffToken(globalThis.crypto?.randomUUID?.() || `expiry-writeoff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setWoQty(String(batch.availableQty || ''));
    setWoReason('');
    setError('');
  };

  const confirmWriteOff = async () => {
    if (!writeOff) return;
    setSaving(true);
    setError('');
    try {
      const quantity = Number(woQty);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Enter a positive write-off quantity.');
      await postInventoryAdjustment({
        idempotencyKey: writeOffToken,
        itemCode: writeOff.itemCode,
        batchId: writeOff.id,
        quantity: -quantity,
        unit: writeOff.unit,
        batchNo: writeOff.batchNumber,
        lotNumber: writeOff.lotNumber,
        entryDate: new Date().toISOString().slice(0, 10),
        reason: woReason.trim() || 'Expired stock write-off'
      });
      setWriteOff(null);
      await loadData();
    } catch (err) {
      setError(`Expiry write-off failed: ${err.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h2 className="page-title">Shelf Life / Expiry Register</h2>
        <button type="button" className="button-secondary button-small" onClick={loadData} disabled={loading}>
          ↻ Refresh
        </button>
      </div>
      <div className="muted-text" style={{ margin: '4px 0 14px' }}>
        Batches are listed FEFO — <strong>First Expiry, First Out</strong>. Expired batches are blocked at
        issue and may only leave stock through the audited write-off below.
      </div>

      {error && !writeOff && <div role="alert" className="form-error">{error}</div>}
      {loading && <div role="status" aria-busy="true">Loading shelf-life records from PostgreSQL…</div>}

      {/* Summary tiles */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <Tile label="Expired" value={`${counts.EXPIRED} batch(es)`} sub={`${inr(counts.expiredQty)} unit(s) blocked`} color="#b91c1c" />
        <Tile
          label={`Near Expiry (≤${EXPIRY_NEAR_DAYS} days)`}
          value={`${counts.NEAR} batch(es)`}
          sub={`${inr(counts.nearQty)} unit(s) — use first`}
          color="#b45309"
        />
        <Tile label="Valid" value={`${counts.VALID} batch(es)`} sub="Within shelf life" color="#15803d" />
        <Tile label="No Expiry Date" value={`${counts.UNKNOWN} batch(es)`} sub="Received without expiry capture" color="#64748b" />
      </div>

      {/* Batch watchlist */}
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Batch Watchlist (FEFO order)</h3>
          <span className="muted-text">{batches.length} open batch(es)</span>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table report-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Batch / Lot</th>
                <th>Supplier</th>
                <th>GRN / Receipt</th>
                <th>Mfg Date</th>
                <th>Expiry Date</th>
                <th style={{ textAlign: 'right' }}>Days Left</th>
                <th style={{ textAlign: 'right' }}>Available</th>
                <th>Status</th>
                {canAdjust && <th style={{ textAlign: 'right' }}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={canAdjust ? 10 : 9} className="no-history-row">
                    {loading ? 'Loading batches…' : 'No batches with expiry on record. Receive shelf-life material with a Batch / Lot number and Expiry Date to populate this register.'}
                  </td>
                </tr>
              ) : (
                batches.map((b) => {
                  const meta = STATUS_META[b.status] || STATUS_META.UNKNOWN;
                  return (
                    <tr key={b.id} style={b.status === 'EXPIRED' ? { background: '#fff5f5' } : undefined}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{b.itemName || b.itemCode || '—'}</div>
                        <div className="muted-text" style={{ fontSize: '11px' }}>{b.itemCode || ''}</div>
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        {b.batchNumber || b.lotNumber || '—'}
                        {b.batchNumber && b.lotNumber ? (
                          <div className="muted-text" style={{ fontSize: '11px', fontWeight: 600 }}>Lot {b.lotNumber}</div>
                        ) : null}
                      </td>
                      <td>{b.supplier || '—'}</td>
                      <td>{b.grnNumber || '—'}</td>
                      <td>{b.mfgDate || '—'}</td>
                      <td style={{ fontWeight: 700 }}>{b.expiryDate || '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: meta.color }}>
                        {b.daysLeft === null ? '—' : b.daysLeft}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {inr(b.availableQty)} {b.unit}
                      </td>
                      <td>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '11px',
                            color: meta.color,
                            background: meta.bg,
                            borderRadius: '999px',
                            padding: '2px 9px',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {meta.label}
                        </span>
                      </td>
                      {canAdjust && (
                        <td style={{ textAlign: 'right' }}>
                          {b.status === 'EXPIRED' ? (
                            <button
                              type="button"
                              className="button-secondary button-small"
                              onClick={() => openWriteOff(b)}
                              style={{ color: '#b91c1c', borderColor: '#fca5a5' }}
                            >
                              Write-off
                            </button>
                          ) : (
                            <span className="muted-text">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Capture gaps: shelf-life items without batch/expiry records */}
      {gaps.length > 0 && (
        <div className="content-block" style={{ marginTop: '14px' }}>
          <div className="block-header">
            <h3 className="block-title">Items Flagged Shelf-Life Managed — Awaiting Batch Capture</h3>
            <span className="muted-text">{gaps.length} item(s)</span>
          </div>
          <div style={{ padding: '12px 16px', fontSize: '12.5px', color: '#475569', textAlign: 'left' }}>
            These items are marked <strong>Shelf-life / Expiry managed</strong> in the Item Master but have no
            open batch with an expiry date. Enter the <strong>Batch / Lot, Mfg Date and Expiry Date</strong>{' '}
            when they are next received so FEFO issue and this register can work:
            <ul style={{ margin: '8px 0 0', paddingLeft: '20px' }}>
              {gaps.map((g) => (
                <li key={g.id || g.itemCode}>
                  <strong>{g.itemName || g.itemCode}</strong>
                  {g.shelfLifeMonths ? ` — standard shelf life ${g.shelfLifeMonths} month(s)` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Write-off modal */}
      {writeOff && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: '12px',
              padding: '20px',
              width: '440px',
              maxWidth: '92vw',
              textAlign: 'left',
              boxShadow: '0 20px 50px rgba(15,23,42,0.25)'
            }}
          >
            <h3 style={{ margin: '0 0 4px', fontSize: '16px', color: '#0f172a' }}>Expiry Write-off</h3>
            <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#64748b' }}>
              <strong>{writeOff.itemName || writeOff.itemCode}</strong> · Batch {writeOff.batchNumber}
              {writeOff.lotNumber ? ` · Lot ${writeOff.lotNumber}` : ''} · expired{' '}
              {writeOff.expiryDate} · {inr(writeOff.availableQty)} {writeOff.unit || ''} available. This action is
              recorded in the stock ledger and audit log.
            </p>

            <div className="form-field" style={{ marginBottom: '10px' }}>
              <span>Quantity to write off</span>
              <input
                type="number"
                min="0"
                max={Number(writeOff.availableQty) || 0}
                value={woQty}
                onChange={(e) => setWoQty(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ marginBottom: '12px' }}>
              <span>Reason / disposal note</span>
              <input
                type="text"
                placeholder="e.g. Expired — disposed per EHS procedure, witnessed by QC"
                value={woReason}
                onChange={(e) => setWoReason(e.target.value)}
              />
            </div>

            {error && (
              <div style={{ color: '#b91c1c', fontSize: '12px', marginBottom: '10px', fontWeight: 600 }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" className="button-secondary" onClick={() => setWriteOff(null)} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="button-primary"
                onClick={confirmWriteOff}
                disabled={saving}
                style={{ background: '#b91c1c', borderColor: '#b91c1c' }}
              >
                {saving ? 'Saving…' : 'Confirm Write-off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Tile = ({ label, value, sub, color }) => (
  <div
    style={{
      flex: '1 1 190px',
      minWidth: '190px',
      border: '1px solid #e2e8f0',
      borderRadius: '10px',
      padding: '12px 14px',
      background: '#fafbfc',
      textAlign: 'left'
    }}
  >
    <div style={{ fontSize: '10.5px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {label}
    </div>
    <div style={{ fontSize: '17px', fontWeight: 800, color, marginTop: '3px' }}>{value}</div>
    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '1px' }}>{sub}</div>
  </div>
);

export default ShelfLifePage;
