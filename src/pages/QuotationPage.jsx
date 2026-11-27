import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterQuotationHistory } from '../utils/historySearch.js';
import QuotationForm from '../components/QuotationForm.jsx';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { isAdmin } from '../utils/auth.js';
import { deleteQuotation, getQuotationMigrationPreview, importMissingQuotations, listQuotations } from '../services/quotationApi.js';

const QuotationPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState(null);
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [migrationPreview, setMigrationPreview] = useState(null);
  const [selectedMigration, setSelectedMigration] = useState(new Set());
  const [migrationBusy, setMigrationBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const loadHistory = async () => {
      setLoading(true);
      try {
        const records = await listQuotations();
        if (!active) return;
        setHistory(records);
        setLoadError('');
      } catch (error) {
        if (!active) return;
        setLoadError(`Could not load current quotations from PostgreSQL: ${error.message}`);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadHistory();
    window.addEventListener('focus', loadHistory);
    return () => {
      active = false;
      window.removeEventListener('focus', loadHistory);
    };
  }, []);

  const filteredHistory = useMemo(() => {
    return filterQuotationHistory(history, search);
  }, [history, search]);

  useEffect(() => {
    if (location.state?.edit) {
      setCreating(true);
      setEditingQuotation(location.state?.quotation || null);
    } else if (location.state?.fromProjectRequest) {
      setCreating(true);
      const prj = location.state.projectDetails || {};
      setEditingQuotation({
        customerDetails: {
          customerName: prj.customerName || '',
          companyName: prj.companyName || '',
          address: prj.address || '',
          email: prj.email || '',
          phone: prj.phone || '',
          gstin: prj.gstin || ''
        },
        quotationDetails: {
          projectId: prj.projectId || '',
          quotationNumber: '',
          quotationDate: new Date().toISOString().slice(0, 10),
          validity: '30 Days'
        },
        items: location.state.items || []
      });
    }
  }, [location.state]);

  const handleCreateNew = () => {
    setEditingQuotation(null);
    setCreating(true);
  };

  const handleBackToHistory = () => {
    setCreating(false);
    setEditingQuotation(null);
  };

  const handleActionChange = async (transaction, action) => {
    if (!action) return;
    if (action === 'viewPreview' && transaction.payload) {
      navigate(`/quotation/preview?quotationNumber=${encodeURIComponent(transaction.reference)}`, { state: { quotation: transaction.payload } });
    } else if (action === 'editQuotation' && transaction.payload) {
      setEditingQuotation(transaction.payload);
      setCreating(true);
    } else if (action === 'convertToSalesOrder' && transaction.payload) {
      const now = new Date();
      const year = now.getFullYear().toString().slice(-2);
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const serial = Math.floor(100 + Math.random() * 900);
      const soNum = `SO-${year}${month}${day}-${serial}`;

      navigate('/sales-order', {
        state: {
          fromQuotation: true,
          quotation: transaction.payload,
          soNumber: soNum
        }
      });
    } else if (action === 'convertSaleOrder' && transaction.payload) {
      navigate('/customer-invoice', {
        state: {
          fromQuotation: true,
          quotation: transaction.payload
        }
      });
    } else if (action === 'convertToCustomerPO' && transaction.payload) {
      navigate('/customer-purchase-order', {
        state: {
          fromQuotation: true,
          quotation: transaction.payload
        }
      });
    } else if (action === 'deleteQuotation') {
      if (window.confirm(`Delete quotation ${transaction.reference}?`)) {
        try {
          await deleteQuotation(transaction.reference, transaction.version, 'Deleted by Admin from Quotation History');
          setHistory((current) => current.filter((h) => h.reference !== transaction.reference));
          setLoadError('');
        } catch (error) {
          setLoadError(`Could not delete quotation from PostgreSQL: ${error.message}`);
        }
      }
    }
  };

  const handleClearAllQuotations = async () => {
    if (window.confirm('Delete all quotation records?')) {
      try {
        for (const record of history) await deleteQuotation(record.reference, record.version, 'Admin cleared quotation history');
        setHistory([]);
        setLoadError('');
      } catch (error) {
        setLoadError(`Quotation clear stopped after a server error: ${error.message}`);
        try { setHistory(await listQuotations()); } catch { /* retain the last confirmed display */ }
      }
    }
  };

  const previewLegacyQuotations = async () => {
    setMigrationBusy(true);
    try {
      const preview = await getQuotationMigrationPreview();
      setMigrationPreview(preview);
      setSelectedMigration(new Set());
      setLoadError('');
    } catch (error) {
      setLoadError(`Could not preview legacy quotation records: ${error.message}`);
    } finally { setMigrationBusy(false); }
  };

  const confirmLegacyImport = async () => {
    const selected = migrationPreview?.eligible?.filter((record) => selectedMigration.has(record.quotationNumber)) || [];
    if (!selected.length || !window.confirm(`Import ${selected.length} reviewed quotation(s) into PostgreSQL? Existing, conflicting, and deleted records will not be overwritten.`)) return;
    setMigrationBusy(true);
    try {
      const result = await importMissingQuotations(selected.map((record) => record.payload));
      const preview = await getQuotationMigrationPreview();
      setMigrationPreview(preview);
      setSelectedMigration(new Set());
      setHistory(await listQuotations());
      setLoadError(`Imported ${result.imported.length} quotation(s); ${result.conflicts.length} were skipped because they already exist or are protected.`);
    } catch (error) {
      setLoadError(`Legacy quotation import was not confirmed: ${error.message}`);
    } finally { setMigrationBusy(false); }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>{creating ? (editingQuotation ? 'Edit Quotation' : 'Create Quotation') : 'Quotations'}</h1>
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          {creating ? (
            <button className="button-secondary" onClick={handleBackToHistory}>
              Back to Quotations
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '8px' }}>
              {isAdmin() && history.length > 0 && (
                <button
                  className="button-secondary"
                  style={{ color: '#dc2626', borderColor: '#fecaca' }}
                  onClick={handleClearAllQuotations}
                >
                  Clear History
                </button>
              )}
              {isAdmin() && <button className="button-secondary" onClick={previewLegacyQuotations} disabled={migrationBusy}>Review Legacy Data</button>}
              <button className="button-primary" onClick={handleCreateNew}>
                Create Quotation
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="content-block">
        {loadError && <div role="alert" className="error-message">{loadError}</div>}
        {migrationPreview && isAdmin() && (
          <section className="content-block" aria-label="Legacy quotation migration preview">
            <h2>Legacy Quotation Migration Preview</h2>
            <p>New eligible: {migrationPreview.counts.eligible}; already existing: {migrationPreview.counts.existing}; conflicting: {migrationPreview.counts.conflicts}; previously deleted and blocked: {migrationPreview.counts.deleted}.</p>
            {migrationPreview.eligible.map((record) => (
              <label key={record.quotationNumber} style={{ display: 'block', padding: '4px 0' }}>
                <input type="checkbox" checked={selectedMigration.has(record.quotationNumber)} onChange={(event) => setSelectedMigration((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(record.quotationNumber); else next.delete(record.quotationNumber);
                  return next;
                })} />{' '}
                {record.quotationNumber} · {record.payload?.customerDetails?.companyName || record.payload?.customerDetails?.customerName || 'Customer not named'}
              </label>
            ))}
            {[...migrationPreview.conflicts, ...migrationPreview.deleted].map((record, index) => <p key={`${record.quotationNumber}-${index}`}>{record.quotationNumber}: {record.reason || 'Import blocked.'}</p>)}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="button-primary" disabled={migrationBusy || selectedMigration.size === 0} onClick={confirmLegacyImport}>Import Selected</button>
              <button className="button-secondary" onClick={() => setMigrationPreview(null)}>Close Preview</button>
            </div>
          </section>
        )}
        {creating ? (
          <QuotationForm initialData={editingQuotation} onCancel={handleBackToHistory} />
        ) : (
          <>
            <div className="block-header">
              <h2>Quotation History</h2>
            </div>
            <RecordSearchBar
              value={search}
              onChange={setSearch}
              placeholder="Search quotation reference, project, company, customer or date..."
              label="Search quotations"
            />
            <div className="history-table-wrapper">
              <table className="history-table quotation-history-table">
                <colgroup>
                  <col className="quotation-history-date" />
                  <col className="quotation-history-reference" />
                  <col className="quotation-history-project" />
                  <col className="quotation-history-company" />
                  <col className="quotation-history-total" />
                  <col className="quotation-history-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference No</th>
                    <th>Project ID</th>
                    <th>Company Name</th>
                    <th>Total Amount</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan="6" className="no-history-row">Loading quotations from PostgreSQL…</td></tr>
                  ) : history.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="no-history-row">
                        No quotations yet. Click Create Quotation to add a new entry.
                      </td>
                    </tr>
                  ) : filteredHistory.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="no-history-row">
                        No quotations match your search. Try another term or clear the search.
                      </td>
                    </tr>
                  ) : (
                    filteredHistory.map((transaction, index) => (
                      <tr key={index}>
                        <td>{transaction.date}</td>
                        <td>{transaction.reference}</td>
                        <td>
                          {transaction.projectId ||
                            transaction.payload?.quotationDetails?.projectId ||
                            '—'}
                        </td>
                        <td>{transaction.company}</td>
                        <td>{transaction.total}</td>
                        <td>
                          <select
                            className="action-select"
                            defaultValue=""
                            onChange={(e) => {
                              handleActionChange(transaction, e.target.value);
                              e.target.value = '';
                            }}
                          >
                            <option value="" disabled>
                              Action
                            </option>
                            <option value="viewPreview">View / Print Preview</option>
                            {isAdmin() && <option value="editQuotation">Edit Quotation</option>}
                            <option value="convertToCustomerPO">Record Customer PO</option>
                            <option value="convertToSalesOrder">Convert to Sales Order</option>
                            <option value="convertSaleOrder">Generate Tax Invoice</option>
                            {isAdmin() && <option value="deleteQuotation" style={{ color: '#dc2626' }}>Delete Quotation</option>}
                          </select>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default QuotationPage;
