import { useState } from 'react';
import { isAdmin } from '../utils/permissions.js';
import { getMachines, saveMachines, generateMachineId } from '../utils/storeService.js';

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
  const [machines, setMachines] = useState(getMachines);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const admin = isAdmin();
  const refresh = () => setMachines(getMachines());

  const openAdd = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM, machineId: generateMachineId().machineId, status: 'Active' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (m) => {
    setEditId(m.id || m.machineId);
    setForm({ ...EMPTY_FORM, ...m, status: m.status || 'Active' });
    setError('');
    setShowModal(true);
  };

  const handleSave = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setError('');

    const machineId = (form.machineId || '').trim();
    const name = (form.name || '').trim();

    if (!name) return setError('Machine name is required.');
    if (!machineId) return setError('Machine ID is required.');

    try {
      const list = getMachines();
      const dup = list.find(
        (m) =>
          m &&
          m.machineId &&
          String(m.machineId).trim().toLowerCase() === machineId.toLowerCase() &&
          String(m.id || m.machineId) !== String(editId)
      );
      if (dup) return setError(`Machine ID "${machineId}" is already in use.`);

      const status = form.status || 'Active';
      const payload = {
        ...form,
        machineId: machineId.toUpperCase(),
        name,
        status,
        active: status === 'Active'
      };

      let next;
      if (editId) {
        next = list.map((m) =>
          String(m.id || m.machineId) === String(editId)
            ? { ...m, ...payload, id: m.id || editId }
            : m
        );
      } else {
        next = [
          {
            id: `mc-${Date.now()}`,
            ...payload,
            active: status === 'Active',
            createdAt: new Date().toISOString()
          },
          ...list
        ];
      }

      saveMachines(next);
      refresh();
      setShowModal(false);
    } catch (err) {
      console.error('Error saving machine:', err);
      setError(err?.message || 'Failed to save machine. Please try again.');
    }
  };

  const toggleStatus = (m) => {
    const isNowActive = m.status === 'Inactive';
    const nextStatus = isNowActive ? 'Active' : 'Inactive';
    const next = getMachines().map((x) =>
      String(x.id || x.machineId) === String(m.id || m.machineId)
        ? { ...x, status: nextStatus, active: isNowActive }
        : x
    );
    saveMachines(next);
    refresh();
  };

  const filtered = machines.filter((m) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return [m.machineId, m.name, m.type, m.workCenter, m.department, m.location, m.status].join(' ').toLowerCase().includes(q);
  });

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h1 className="page-title">Machine Master</h1>
        </div>
        <div className="header-actions">
          {admin && <button type="button" className="button-primary" onClick={openAdd}>+ Add Machine</button>}
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
              {filtered.length === 0 ? (
                <tr><td colSpan={admin ? 9 : 8} className="no-history-row">No machines found.</td></tr>
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
                          <button type="button" className="button-secondary button-small" onClick={() => openEdit(m)}>Edit</button>
                          <button type="button" className="button-secondary button-small" onClick={() => toggleStatus(m)}>
                            {m.status === 'Inactive' ? 'Activate' : 'Deactivate'}
                          </button>
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
                <input type="text" className="action-select form-input" value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })} />
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

            {error && <div className="form-error">{error}</div>}

            <div className="template-modal-actions">
              <button type="button" className="button-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" className="button-primary">Save Machine</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
};

export default MachineMasterPage;
