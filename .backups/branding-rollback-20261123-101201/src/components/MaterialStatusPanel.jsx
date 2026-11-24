import { useNavigate } from 'react-router-dom';
import { getJobCardMaterialProfile, getMaterialShortages } from '../utils/storeService.js';
import {
  ACK_STATUS,
  computeAckLines,
  getAcknowledgement,
  findIndentForMR
} from '../utils/materialAckService.js';

const StatusChip = ({ status }) => {
  const cls = (status || '').toLowerCase().replace(/\s+/g, '-');
  return <span className={`status-badge st-${cls}`}>{status}</span>;
};

/**
 * What Stores confirmed for one Material Request — rendered on the Job Card
 * material panel so Production sees availability (and shortage) *before*
 * releasing work, exactly as the acknowledgement screen left it.
 */
const StoreAckStrip = ({ mr }) => {
  const ack = getAcknowledgement(mr);
  const live = computeAckLines(mr);
  const indentNumber = ack.purchaseIndentNumber || findIndentForMR(mr.mrNumber)?.indentNumber || '';
  const pending = ack.status === ACK_STATUS.PENDING;

  const rows = live.map((l) => {
    const stored = (ack.lines || {})[l.materialId];
    return {
      id: l.materialId,
      name: l.materialName,
      unit: l.unit,
      required: l.requiredQty,
      confirmed: stored ? Number(stored.acknowledgedQty) || 0 : null,
      shortage: stored ? Number(stored.shortageQty) || 0 : l.shortageQty,
      status: stored ? stored.status : ACK_STATUS.PENDING
    };
  });

  const totalShortage = rows.reduce((a, r) => a + r.shortage, 0);
  const tone = pending
    ? { bg: '#f8fafc', border: '#e2e8f0', color: '#475569' }
    : ack.status === ACK_STATUS.FULL
      ? { bg: '#ecfdf5', border: '#a7f3d0', color: '#047857' }
      : ack.status === ACK_STATUS.NONE
        ? { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c' }
        : { bg: '#fffbeb', border: '#fde68a', color: '#92400e' };

  const headline = pending
    ? 'Material confirmation is pending — Stores has not acknowledged this request.'
    : ack.status === ACK_STATUS.FULL
      ? 'Stores confirmed the full requirement is available.'
      : ack.status === ACK_STATUS.NONE
        ? `Stores reported no material available — ${totalShortage} unit(s) short.`
        : `Stores confirmed a partial supply — ${totalShortage} unit(s) short. Do not treat the full requirement as available.`;

  return (
    <div
      className="store-ack-strip"
      data-testid={`store-ack-${mr.mrNumber}`}
      style={{ margin: '10px 0 12px', padding: '9px 12px', borderRadius: '6px', background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color, fontSize: '12.5px' }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' }}>
        <strong style={{ fontSize: '12.5px' }}>Store Acknowledgement:</strong>
        <span className={`status-badge st-${ack.status.toLowerCase().replace(/\s+/g, '-')}`}>{ack.status}</span>
        {!pending && ack.acknowledgedAt && (
          <span className="muted-text">by {ack.acknowledgedBy} on {ack.acknowledgedAt}</span>
        )}
        {indentNumber && <span className="muted-text">· Purchase Indent {indentNumber}</span>}
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: pending ? '0' : '6px' }}>
        {rows.map((r) => (
          <span
            key={r.id}
            className={`status-badge st-${r.status.toLowerCase().replace(/\s+/g, '-')}`}
            title={`${r.name}: required ${r.required} ${r.unit}, confirmed ${r.confirmed ?? '—'} ${r.unit}, shortage ${r.shortage} ${r.unit}`}
          >
            {r.name}: {r.confirmed ?? '–'}/{r.required} {r.unit}{r.shortage > 0 ? ` (${r.shortage} short)` : ''}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        {ack.remarks && <span>Remarks: {ack.remarks}</span>}
        <button
          type="button"
          className="link-btn"
          onClick={() => navigate(`/production/material-requests?mr=${encodeURIComponent(mr.mrNumber)}`)}
        >
          Open full acknowledgement
        </button>
      </div>
    </div>
  );
};

const MaterialStatusPanel = ({ jobCardNumber }) => {
  const navigate = useNavigate();
  const profile = getJobCardMaterialProfile(jobCardNumber);

  if (profile.length === 0) {
    return (
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Raw Material Status</h3>
        </div>
        <div className="empty-state">
          <p>No material requests have been raised for this job card yet.</p>
          <button type="button" className="button-primary button-small" onClick={() => navigate('/production/material-requests', { state: { createForJobCard: jobCardNumber } })}>
            Raise Material Request
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="content-block">
      <div className="block-header">
        <h3 className="block-title">Raw Material Status</h3>
        <span className="muted-text">Linked Material Requests &amp; Store Issues</span>
      </div>

      {profile.map(({ mr, status, issues }) => {
        const shortages = getMaterialShortages(mr);
        return (
          <div key={mr.mrNumber} className="material-status-block">
            <div className="material-status-head">
              <div>
                <strong>{mr.mrNumber}</strong>
                <StatusChip status={status} />
                {mr.projectId && (
                  <span style={{ marginLeft: '10px', color: '#3730a3', fontWeight: '700', fontSize: '12px' }}>
                    Project: {mr.projectId}{mr.projectName ? ` — ${mr.projectName}` : ''}
                  </span>
                )}
                <span className="muted-text">Requested: {mr.requestDate} · Priority: {mr.priority || 'Normal'}</span>
              </div>
              <div className="header-actions">
                <button type="button" className="button-secondary button-small" onClick={() => navigate(`/production/material-requests`, { state: { viewMrNumber: mr.mrNumber } })}>
                  View MR
                </button>
              </div>
            </div>

            <StoreAckStrip mr={mr} />

            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>SL.No</th>
                    <th>Material</th>
                    <th>Spec / Size</th>
                    <th>Required</th>
                    <th>Issued</th>
                    <th>Balance</th>
                    <th>Available</th>
                    <th>Line Status</th>
                  </tr>
                </thead>
                <tbody>
                  {mr.items.map((it, idx) => {
                    const short = shortages.find((s) => s.materialId === it.materialId);
                    return (
                      <tr key={it.materialId}>
                        <td>{idx + 1}</td>
                        <td>{it.materialName}</td>
                        <td>{(it.spec || it.sizeDimensions || it.grade || '—')}</td>
                        <td>{it.requiredQty} {it.unit}</td>
                        <td>{it.issuedQty} {it.unit}</td>
                        <td>{it.balanceQty} {it.unit}</td>
                        <td>{short ? short.available : '—'}</td>
                        <td><StatusChip status={it.lineStatus} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {issues.length > 0 && (
              <div className="si-links-row">
                <span className="muted-text">Store Issues: </span>
                {issues.map((si) => (
                  <button
                    key={si.issueNumber}
                    type="button"
                    className="link-btn"
                    onClick={() => navigate('/store/issues', { state: { viewIssue: si.issueNumber } })}
                  >
                    {si.issueNumber}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default MaterialStatusPanel;