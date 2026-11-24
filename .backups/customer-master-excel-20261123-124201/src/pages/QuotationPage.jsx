import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterQuotationHistory } from '../utils/historySearch.js';
import QuotationForm from '../components/QuotationForm.jsx';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { getNextQuotationNumber } from '../utils/sequenceGenerator.js';
import { isAdmin } from '../utils/auth.js';

const QuotationPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState(null);
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const loadHistory = () => {
      try {
        const stored = localStorage.getItem('quotationHistory');
        setHistory(stored ? JSON.parse(stored) : []);
      } catch (error) {
        console.error('Unable to load quotation history', error);
        setHistory([]);
      }
    };
    const onERPStateChange = (event) => {
      if (!event.detail?.key || event.detail.key === 'quotationHistory') loadHistory();
    };
    const onStorage = (event) => {
      if (event.key === 'quotationHistory') loadHistory();
    };
    loadHistory();
    window.addEventListener('erp-state-hydrated', loadHistory);
    window.addEventListener('erp-state-change', onERPStateChange);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', loadHistory);
    return () => {
      window.removeEventListener('erp-state-hydrated', loadHistory);
      window.removeEventListener('erp-state-change', onERPStateChange);
      window.removeEventListener('storage', onStorage);
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
          quotationNumber: getNextQuotationNumber(),
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

  const handleActionChange = (transaction, action) => {
    if (!action) return;
    if (action === 'viewPreview' && transaction.payload) {
      localStorage.setItem('currentQuotation', JSON.stringify(transaction.payload));
      navigate('/quotation/preview', { state: { quotation: transaction.payload } });
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
      const now = new Date();
      const year = now.getFullYear().toString().slice(-2);
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const serial = Math.floor(100 + Math.random() * 900);
      const invNum = `INV-${year}${month}${day}-${serial}`;

      // Update quotation status in history
      try {
        const stored = localStorage.getItem('quotationHistory');
        let currentHistory = stored ? JSON.parse(stored) : [];
        const index = currentHistory.findIndex((h) => h.reference === transaction.reference);
        if (index !== -1) {
          currentHistory[index].balanceStatus = `Invoiced (${invNum})`;
          localStorage.setItem('quotationHistory', JSON.stringify(currentHistory));
          setHistory(currentHistory);
        }
      } catch (err) {
        console.error('Failed to update quotation status', err);
      }

      navigate('/customer-invoice', {
        state: {
          fromQuotation: true,
          quotation: transaction.payload,
          invoiceNumber: invNum
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
        const updated = history.filter((h) => h.reference !== transaction.reference);
        setHistory(updated);
        localStorage.setItem('quotationHistory', JSON.stringify(updated));
      }
    }
  };

  const handleClearAllQuotations = () => {
    if (window.confirm('Delete all quotation records?')) {
      setHistory([]);
      localStorage.removeItem('quotationHistory');
      localStorage.removeItem('currentQuotation');
    }
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
              {history.length > 0 && (
                <button
                  className="button-secondary"
                  style={{ color: '#dc2626', borderColor: '#fecaca' }}
                  onClick={handleClearAllQuotations}
                >
                  Clear History
                </button>
              )}
              <button className="button-primary" onClick={handleCreateNew}>
                Create Quotation
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="content-block">
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
                  {history.length === 0 ? (
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
