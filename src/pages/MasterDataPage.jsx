import React, { useEffect, useState } from 'react';
import { createMaster, deleteMaster, listMasters, updateMaster } from '../services/masterApi.js';

const UOM_EMPTY = { code: '', name: '', symbol: '', description: '' };
const MATERIAL_EMPTY = { itemCode: '', itemName: '', category: 'Standard Part', unitCode: '', hsnSac: '', description: '' };

/**
 * PostgreSQL-backed material and UOM master screens. No localStorage is read;
 * list/create/update/delete all go through /api/masters.
 */
const MasterDataPage = () => {
  const [tab, setTab] = useState('materials');
  const [uoms, setUoms] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(MATERIAL_EMPTY);
  const [editId, setEditId] = useState('');
  const [editVersion, setEditVersion] = useState(0);
  const [formError, setFormError] = useState('');

  const refresh = async () => {
    const [unitRows, materialRows] = await Promise.all([listMasters('uoms'), listMasters('materials')]);
    setUoms(unitRows);
    setMaterials(materialRows);
    setError('');
    return { unitRows, materialRows };
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    refresh()
      .catch((err) => { if (active) setError(err.message || 'Master data could not be loaded from PostgreSQL.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const switchTab = (next) => {
    setTab(next);
    setEditId('');
    setEditVersion(0);
    setForm(next === 'uoms' ? UOM_EMPTY : MATERIAL_EMPTY);
    setFormError('');
  };

  const openEdit = (record) => {
    setEditId(record.id);
    setEditVersion(Number(record.version) || 1);
    setForm(tab === 'uoms'
      ? { code: record.code || '', name: record.name || '', symbol: record.symbol || '', description: record.description || '' }
      : {
          itemCode: record.itemCode || '', itemName: record.itemName || record.name || '',
          category: record.category || '', unitCode: record.unitCode || record.unit || '',
          hsnSac: record.hsnSac || '', description: record.description || ''
        });
    setFormError('');
  };

  const save = async (e) => {
    e.preventDefault();
    setFormError('');
    setBusy(true);
    try {
      if (tab === 'uoms') {
        if (!form.code.trim()) throw new Error('UOM code is required.');
        const payload = { ...form, code: form.code.trim().toUpperCase(), name: form.name.trim() || form.code.trim().toUpperCase() };
        if (editId) await updateMaster('uoms', editId, payload, editVersion);
        else await createMaster('uoms', payload);
      } else {
        if (!form.itemCode.trim() || !form.itemName.trim()) throw new Error('Item code and item name are required.');
        const payload = { ...form, itemCode: form.itemCode.trim().toUpperCase(), itemName: form.itemName.trim() };
        if (editId) await updateMaster('materials', editId, payload, editVersion);
        else await createMaster('materials', payload);
      }
      await refresh();
      setEditId('');
      setEditVersion(0);
      setForm(tab === 'uoms' ? UOM_EMPTY : MATERIAL_EMPTY);
    } catch (err) {
      setFormError(err.message || 'Master record could not be saved.');
      if (err.status === 409) refresh().catch(() => {});
    } finally { setBusy(false); }
  };

  const remove = async (record) => {
    if (!window.confirm(`Delete ${record.code || record.itemCode}? Its PostgreSQL delete history is retained.`)) return;
    const reason = window.prompt('Reason for deletion:')?.trim();
    if (!reason) return;
    setBusy(true);
    try {
      await deleteMaster(tab, record.id, Number(record.version) || 1, reason);
      await refresh();
    } catch (err) {
      setError(err.message || 'Master record could not be deleted.');
      if (err.status === 409) refresh().catch(() => {});
    } finally { setBusy(false); }
  };

  const rows = tab === 'uoms' ? uoms : materials;

  return (
    <section className="page-section">
      {error && <div role="alert" className="form-error" style={{ marginBottom: 12 }}>{error} <button type="button" className="button-secondary button-small" onClick={() => refresh().catch((err) => setError(err.message))}>Retry</button></div>}
      <div className="page-header">
        <div><h1 className="page-title">Material &amp; UOM Master</h1></div>
      </div>

      <div className="content-block">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button type="button" className={tab === 'materials' ? 'button-primary' : 'button-secondary'} onClick={() => switchTab('materials')}>Material Master</button>
          <button type="button" className={tab === 'uoms' ? 'button-primary' : 'button-secondary'} onClick={() => switchTab('uoms')}>Units of Measure</button>
        </div>

        <form className="form-grid" onSubmit={save} style={{ marginBottom: 18 }}>
          {tab === 'uoms' ? (
            <>
              <label className="form-field"><span>Code *</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
              <label className="form-field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="form-field"><span>Symbol</span><input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} /></label>
              <label className="form-field full-width"><span>Description</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            </>
          ) : (
            <>
              <label className="form-field"><span>Item Code *</span><input value={form.itemCode} onChange={(e) => setForm({ ...form, itemCode: e.target.value })} /></label>
              <label className="form-field"><span>Item Name *</span><input value={form.itemName} onChange={(e) => setForm({ ...form, itemName: e.target.value })} /></label>
              <label className="form-field"><span>Category</span><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
              <label className="form-field"><span>Unit</span><input value={form.unitCode} onChange={(e) => setForm({ ...form, unitCode: e.target.value })} /></label>
              <label className="form-field"><span>HSN / SAC</span><input value={form.hsnSac} onChange={(e) => setForm({ ...form, hsnSac: e.target.value })} /></label>
              <label className="form-field full-width"><span>Description</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            </>
          )}
          {formError && <div role="alert" className="form-error" style={{ gridColumn: '1 / -1' }}>{formError}</div>}
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
            <button type="submit" className="button-primary" disabled={busy || loading}>{busy ? 'Saving…' : editId ? 'Save Changes' : 'Add Record'}</button>
            {editId && <button type="button" className="button-secondary" onClick={() => switchTab(tab)} disabled={busy}>Cancel Edit</button>}
          </div>
        </form>

        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>{tab === 'uoms' ? 'Symbol' : 'Unit / Category'}</th><th>Status</th><th>Version</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="no-history-row">Loading master data from PostgreSQL…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="no-history-row">No records on record. Add the first one.</td></tr>
              ) : rows.map((record) => (
                <tr key={record.id}>
                  <td>{record.code || record.itemCode}</td>
                  <td>{record.name || record.itemName}</td>
                  <td>{tab === 'uoms' ? record.symbol || '-' : `${record.unit || '-'} / ${record.category || '-'}`}</td>
                  <td>{record.status || 'Active'}</td>
                  <td>{record.version}</td>
                  <td>
                    <button type="button" className="button-secondary button-small" onClick={() => openEdit(record)} disabled={busy}>Edit</button>{' '}
                    <button type="button" className="button-secondary button-small danger" onClick={() => remove(record)} disabled={busy}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

export default MasterDataPage;
