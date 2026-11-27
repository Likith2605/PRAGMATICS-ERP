import React, { useEffect, useMemo, useState } from 'react';
import { isAdmin } from '../utils/auth.js';
import { createMaster, deleteMaster, listMasters, newMasterToken, updateMaster } from '../services/masterApi.js';

const EMPTY_FORM = {
  machineId: '',
  name: '',
  type: 'CNC',
  workCenter: '',
  department: 'Production Department',
  location: '',
  capacity: '',
  status: 'Active',
  remarks: ''
};

const MachineMasterPage = () => {
  const [machines, setMachines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState('');
  const [editVersion, setEditVersion] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const admin = isAdmin();

  const refresh = async () => {
    const records = await listMasters('machines');
    setMachines(records);
    setLoadError('');
    return records;
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    refresh()
      .catch((err) => { if (active) setLoadError(err.message || 'Machines could not be loaded from PostgreSQL.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const openAdd = () => {
    setEditId('');
    setEditVersion(0);
    setForm({ ...EMPTY_FORM, machineId: newMasterToken('MC').slice(0, 28).toUpperCase(), status: 'Active' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (m) => {
    setEditId(m.id || m.machineId);
    setEditVersion(Number(m.version) || 1);
    setForm({ ...EMPTY_FORM, ...m, machineId: m.machineId || m.id, status: m.status || 'Active' });
    setError('');
    setShowModal(true);
  };

  const handleSave = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setError('');
    const machineId = String(form.machineId || '').trim().toUpperCase();
    const name = String(form.name || '').trim();
    if (!name) return setError('Machine name is required.');
    if (!machineId) return setError('Machine ID is required.');
    const payload = {
      machineId,
      name,
      type: form.type || '',
      workCenter: form.workCenter || '',
      department: form.department || '',
      location: form.location || '',
      capacity: form.capacity || '',
      status: form.status || 'Active',
      remarks: form.remarks || ''
    };
    setBusy(true);
    try {
      if (editId) await updateMaster('machines', editId, payload, editVersion);
      else await createMaster('machines', payload);
      await refresh();
      setShowModal(false);
    } catch (err) {
      setError(err.message || 'Machine could not be saved. Please try again.');
      if (err.status === 409) refresh().catch(() => {});
    } finally { setBusy(false); }
  };

  const toggleStatus = async (m) => {
    setBusy(true);
    try {
      const active = m.status === 'Active';
      await updateMaster('machines', m.id, { ...m, status: active ? 'Inactive' : 'Active', active: !active }, Number(m.version) || 1);
      await refresh();
    } catch (err) {
      setLoadError(err.message || 'Machine status could not be updated.');
      if (err.status === 409) refresh().catch(() => {});
    } finally { setBusy(false); }
  };

  const handleDelete = async (m) => {
    if (!window.confirm(`Delete machine ${m.machineId}? This keeps its PostgreSQL delete history.`)) return;
    const reason = window.prompt('Reason for deleting this machine:')?.trim();
    if (!reason) return;
    setBusy(true);
    try {
      await deleteMaster('machines', m.id, Number(m.version) || 1, reason);
      await refresh();
    } catch (err) {
      setLoadError(err.message || 'Machine could not be deleted.');
      if (err.status === 409) refresh().catch(() => {});
    } finally { setBusy(false); }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return machines;
    return machines.filter((m) => [m.machineId, m.name, m.type, m.workCenter, m.department, m.location, m.status].join(' ').toLowerCase().includes(q));
  }, [machines, search]);

  return (
    <section className="page-section">
      {loadError && (
        <div role="alert" className="form-error" style={{ marginBottom: 12 }}>
          {loadError}{' '}
          <button type="button" className="button-secondary button-small" onClick={() => refresh().catch((err) => setLoadError(err.message))}>Retry</button>
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Machine Master</h1>
        </div>
        <div className="header-actions">
          {admin && <button type="button" className="button-primary" onClick={openAdd} disabled={loading || busy}>+ Add Machine</button>}
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Machines</h3>
          <span className="muted-text">{filtered.length} shown / {machines.length} total</span>
        </div>

        <input
          type="text"
          className="action-select form-input search-input"
          placeholder="Search by ID, name, type, work center..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Machine ID</th>
                <th>Machine Name</th>
                <th>Type</th>
                <th>Work Center</th>
                <th>Department</th>
                <th>Location</th>
                <th>Capacity</th>
                <th>Status</th>
                {admin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={admin ? 9 : 8} className="no-history-row">Loading machines from PostgreSQL…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={admin ? 9 : 8} className="no-history-row">{machines.length === 0 ? 'No machines on record. Add the first machine.' : 'No machines match the search.'}</td></tr>
              ) : (
                filtered.map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.machineId}</strong></td>
                    <td>{m.name}</td>
                    <td>{m.type}</td>
                    <td>{m.workCenter}</td>
                    <td>{m.department}</td>
                    <td>{m.location}</td>
                    <td>{m.capacity || '–'}</td>
                    <td>
                      <span className={`status-badge ${m.status === 'Inactive' ? 'st-cancelled' : 'active'}`}>{m.status || 'Active'}</span>
                    </td>
                    {admin && (
                      <td>
                        <div className="table-actions">
                          <button type="button" className="button-secondary button-small" onClick={() => openEdit(m)} disabled={busy}>Edit</button>
                          <button type="button" className="button-secondary button-small" onClick={() => toggleStatus(m)} disabled={busy}>
                            {m.status === 'Inactive' ? 'Activate' : 'Deactivate'}
                          </button>
                          <button type="button" className="button-secondary button-small danger" onClick={() => handleDelete(m)} disabled={busy}>Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="template-modal-backdrop" onClick={() => setShowModal(false)}>
          <form className="template-modal" onSubmit={handleSave} onClick={(e) => e.stopPropagation()}>
            <div className="template-modal-header">
              <h3>{editId ? `Edit ${form.machineId}` : 'Add Machine'}</h3>
              <button type="button" className="template-modal-close" onClick={() => setShowModal(false)} aria-label="Close">&times;</button>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label>Machine ID</label>
                <input type="text" className="action-select form-input" value={form.machineId} readOnly={Boolean(editId)} onChange={(e) => setForm({ ...form, machineId: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Machine Name *</label>
                <input type="text" className="action-select form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Machine Type</label>
                <input type="text" className="action-select form-input" placeholder="e.g. CNC, VMC, Grinder" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Work Center</label>
                <input type="text" className="action-select form-input" placeholder="e.g. Turning, Milling, Grinding" value={form.workCenter} onChange={(e) => setForm({ ...form, workCenter: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Department</label>
                <input type="text" className="action-select form-input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Location</label>
                <input type="text" className="action-select form-input" placeholder="e.g. Shop Floor 1" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Capacity</label>
                <input type="text" className="action-select form-input" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
              </div>
              <div className="form-field">
                <label>Status</label>
                <select className="action-select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label>Remarks</label>
                <input type="text" className="action-select form-input" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
              </div>
            </div>

            {error && <div className="form-error" role="alert">{error}</div>}

            <div className="template-modal-actions">
              <button type="button" className="button-secondary" onClick={() => setShowModal(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save Machine'}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
};

export default MachineMasterPage;
