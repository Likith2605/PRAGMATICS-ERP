import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import QuotationForm from '../components/QuotationForm.jsx';
import logoUrl from '../assets/logo.png';
import { getNextQuotationNumber } from '../utils/sequenceGenerator.js';
import { isAdmin } from '../utils/auth.js';

const QuotationPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('quotationHistory');
      setHistory(stored ? JSON.parse(stored) : []);
    } catch (error) {
      console.error('Unable to load quotation history', error);
      setHistory([]);
    }
  }, []);

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

      // Update quotation status in history
      try {
        const stored = localStorage.getItem('quotationHistory');
        let currentHistory = stored ? JSON.parse(stored) : [];
        const index = currentHistory.findIndex((h) => h.reference === transaction.reference);
        if (index !== -1) {
          currentHistory[index].balanceStatus = `Converted (${soNum})`;
          localStorage.setItem('quotationHistory', JSON.stringify(currentHistory));
          setHistory(currentHistory);
        }
      } catch (err) {
        console.error('Failed to update quotation status', err);
      }

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
          <p className="eyebrow">{creating ? (editingQuotation ? 'Edit Quotation' : 'Create Quotation') : 'Quotation Dashboard'}</p>
          <h1>{creating ? (editingQuotation ? 'Edit Quotation' : 'Create Quotation') : 'Quotations'}</h1>
          {!creating && (
            <p className="page-description">Create new quotations or review past quotation history below.</p>
          )}
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
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
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference No</th>
                    <th>Project ID</th>
                    <th>Company Name</th>
                    <th>Total Amount</th>
                    <th>Balance Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length > 0 ? (
                    history.map((transaction, index) => (
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
                        <td>{transaction.balanceStatus}</td>
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
                            {isAdmin() && <option value="deleteQuotation" style={{ color: '#dc2626' }}>🗑️ Delete Quotation</option>}
                          </select>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="7" className="no-history-row">
                        No quotations yet. Click Create Quotation to add a new entry.
                      </td>
                    </tr>
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
