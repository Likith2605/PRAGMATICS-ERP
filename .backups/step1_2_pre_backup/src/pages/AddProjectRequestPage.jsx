import React, { useMemo, useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { viewDrawingFile, getBlobUrlFromDataUrl } from '../utils/fileViewer';
import { formatFYProjectId } from '../utils/financialYear';
import legacyCustomers from '../constants/legacyCustomers.json';
import masterCustomers from '../constants/masterCustomers.json';
import { enrichCustomerDetails } from '../utils/customerMaster.js';
import { isAdmin } from '../utils/auth.js';
import { saveAllDrawings, getDrawing, deleteAllDrawings } from '../utils/drawingStorage.js';
import CustomerSearchSelect from '../components/CustomerSearchSelect.jsx';

const getNextSequenceNumber = () => {
  let maxSeq = Number(localStorage.getItem('projectRequestSequence') || 0);
  try {
    const stored = JSON.parse(localStorage.getItem('projectRequests') || '[]');
    if (Array.isArray(stored)) {
      stored.forEach((p) => {
        const match = String(p.projectId || '').match(/(\d+)$/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > maxSeq) maxSeq = n;
        }
      });
    }
  } catch {}
  return maxSeq + 1;
};

const formatProjectId = (seq) => {
  return formatFYProjectId(seq);
};

const DEFAULT_UNITS = [
  'Nos', 'Set', 'Pair', 'Kit', 'Assembly', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Bundle'
];

const createEmptyItem = () => ({
  itemName: '',
  drawingNo: '',
  drawingFileName: '',
  drawingDataUrl: '',
  materialSpec: '',
  quantity: 1,
  unit: 'Nos',
  notes: ''
});

const AddProjectRequestPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isEdit = Boolean(location.state?.edit && location.state?.project);
  const editProject = location.state?.project || null;

  const projectId = useMemo(() => {
    if (isEdit && editProject?.projectId) {
      return editProject.projectId;
    }
    return formatProjectId(getNextSequenceNumber());
  }, [isEdit, editProject]);

  const [form, setForm] = useState(() => {
    if (isEdit && editProject) {
      return {
        customerName: editProject.customerName || '',
        companyName: editProject.companyName || '',
        phone: editProject.phone || '',
        email: editProject.email || '',
        gstin: editProject.gstin || '',
        requestedDate: editProject.requestedDate || new Date().toISOString().slice(0, 10),
        targetDeliveryDate: editProject.targetDeliveryDate || '',
        address: editProject.address || '',
        engineeringNotes: editProject.engineeringNotes || '',
        items: editProject.items && editProject.items.length > 0 ? editProject.items : [createEmptyItem()]
      };
    }
    return {
      customerName: '',
      companyName: '',
      phone: '',
      email: '',
      gstin: '',
      requestedDate: new Date().toISOString().slice(0, 10),
      targetDeliveryDate: '',
      address: '',
      engineeringNotes: '',
      items: [createEmptyItem()]
    };
  });
  const [error, setError] = useState('');
  const [previewDrawing, setPreviewDrawing] = useState(null);

  const handlePreviewDrawing = (dataUrl, fileName) => {
    if (!dataUrl) return;
    const blobUrl = getBlobUrlFromDataUrl(dataUrl);
    setPreviewDrawing({ fileName: fileName || 'drawing.pdf', dataUrl, blobUrl });
  };

  const [existingCustomers, setExistingCustomers] = useState([]);
  const [selectedCustomerKey, setSelectedCustomerKey] = useState('');
  const [customerSelectedMode, setCustomerSelectedMode] = useState(
    isEdit || form.customerName || form.companyName ? 'existing' : ''
  );
  const [lockedCustomerFields, setLockedCustomerFields] = useState({});

  // Load existing customers from master catalog + storage + legacy list
  useEffect(() => {
    try {
      const customersMap = new Map();

      // 1. From master customer profiles
      if (Array.isArray(masterCustomers)) {
        masterCustomers.forEach((mc) => {
          if (mc.companyName || mc.customerName) {
            const key = (mc.companyName || mc.customerName).trim().toLowerCase();
            customersMap.set(key, {
              key,
              customerName: mc.contactPerson || mc.customerName || '',
              companyName: mc.companyName || mc.customerName || '',
              phone: mc.phone || mc.contactNumber || mc.telNo || '',
              email: mc.email || '',
              gstin: mc.gstin || mc.gstNumber || '',
              address: mc.address || '',
              vendorCode: mc.vendorCode || ''
            });
          }
        });
      }

      // 2. From project requests
      const projects = JSON.parse(localStorage.getItem('projectRequests') || '[]');
      projects.forEach((p) => {
        if (p.companyName || p.customerName) {
          const key = (p.companyName || p.customerName).trim().toLowerCase();
          if (!customersMap.has(key)) {
            const enriched = enrichCustomerDetails(p.companyName || p.customerName, p);
            customersMap.set(key, {
              key,
              customerName: enriched.customerName || p.customerName || '',
              companyName: enriched.companyName || p.companyName || p.customerName || '',
              phone: enriched.phone || p.phone || '',
              email: enriched.email || p.email || '',
              gstin: enriched.gstin || p.gstin || '',
              address: enriched.address || p.address || ''
            });
          }
        }
      });

      // 3. From quotations
      const quotations = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
      quotations.forEach((q) => {
        const c = q.payload?.customerDetails;
        if (c && (c.companyName || c.customerName)) {
          const key = (c.companyName || c.customerName).trim().toLowerCase();
          if (!customersMap.has(key)) {
            const enriched = enrichCustomerDetails(c.companyName || c.customerName, c);
            customersMap.set(key, {
              key,
              customerName: enriched.customerName || c.customerName || '',
              companyName: enriched.companyName || c.companyName || c.customerName || '',
              phone: enriched.phone || c.contactNumber || c.phone || '',
              email: enriched.email || c.email || '',
              gstin: enriched.gstin || c.gstNumber || c.gstin || '',
              address: enriched.address || c.address || ''
            });
          }
        }
      });

      // 4. From legacy historical customer archives
      if (Array.isArray(legacyCustomers)) {
        legacyCustomers.forEach((custName) => {
          if (custName && custName.trim()) {
            const key = custName.trim().toLowerCase();
            if (!customersMap.has(key)) {
              const enriched = enrichCustomerDetails(custName);
              customersMap.set(key, {
                key,
                customerName: enriched.customerName || custName.trim(),
                companyName: enriched.companyName || custName.trim(),
                phone: enriched.phone || '',
                email: enriched.email || '',
                gstin: enriched.gstin || '',
                address: enriched.address || ''
              });
            }
          }
        });
      }

      // Sort alphabetically by company/customer name
      const sortedCustomers = Array.from(customersMap.values()).sort((a, b) =>
        (a.companyName || a.customerName || '').localeCompare(b.companyName || b.customerName || '')
      );

      setExistingCustomers(sortedCustomers);
    } catch (err) {
      console.error('Failed to load existing customers', err);
    }
  }, []);

  useEffect(() => {
    if (!isEdit || !editProject?.items) return;
    (async () => {
      try {
        const itemsWithDrawings = await Promise.all(
          editProject.items.map(async (item) => {
            if (item.drawingDataUrl) return item;
            if (!item.drawingNo) return item;
            const dataUrl = await getDrawing(editProject.projectId, item.drawingNo);
            return dataUrl ? { ...item, drawingDataUrl: dataUrl } : item;
          })
        );
        setForm((prev) => ({ ...prev, items: itemsWithDrawings }));
      } catch (err) {
        console.error('Failed to load drawings from IndexedDB', err);
      }
    })();
  }, [isEdit, editProject]);

  const handleSelectCustomer = (key) => {
    setSelectedCustomerKey(key);
    if (!key) {
      setCustomerSelectedMode('');
      setLockedCustomerFields({});
      return;
    }
    setCustomerSelectedMode('existing');
    const match = existingCustomers.find((c) => c.key === key);
    if (match) {
      setForm((prev) => ({
        ...prev,
        customerName: match.customerName || '',
        companyName: match.companyName || '',
        phone: match.phone || '',
        email: match.email || '',
        gstin: match.gstin || '',
        address: match.address || ''
      }));
      setLockedCustomerFields({
        customerName: Boolean(match.customerName?.trim()),
        companyName: Boolean(match.companyName?.trim()),
        phone: Boolean(match.phone?.trim()),
        email: Boolean(match.email?.trim()),
        gstin: Boolean(match.gstin?.trim()),
        address: Boolean(match.address?.trim())
      });
    }
  };

  const handleAddNewCustomer = () => {
    setSelectedCustomerKey('');
    setCustomerSelectedMode('new');
    setLockedCustomerFields({});
    setForm((prev) => ({
      ...prev,
      customerName: '',
      companyName: '',
      phone: '',
      email: '',
      gstin: '',
      address: ''
    }));
  };

  const [customUnits, setCustomUnits] = useState(() => {
    try {
      const stored = localStorage.getItem('customUnits');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [showAddUnit, setShowAddUnit] = useState(false);
  const [newUnitName, setNewUnitName] = useState('');
  const [newUnitSymbol, setNewUnitSymbol] = useState('');
  const [activeItemIndexForUnit, setActiveItemIndexForUnit] = useState(null);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const updateItem = (index, field, value) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      )
    }));
  };

  const extractDrawingNumber = (filename) => {
    let base = filename.replace(/\.[^/.]+$/, '').trim();

    // Pattern 1: DWG-XXXX, DRG-XXXX, PART-XXXX
    const prefixMatch = base.match(/(?:DWG|DRG|PART|DOC|PRT)[_\s\-]*[A-Z0-9_\-]+/i);
    if (prefixMatch) {
      return prefixMatch[0].replace(/[_\s]+/g, '-').toUpperCase();
    }

    // Pattern 2: Common engineering code like APEX-FLG-401 or 54201-REV-B
    const codeMatch = base.match(/[A-Z0-9]{2,}[_\-][A-Z0-9_\-]+/i);
    if (codeMatch) {
      return codeMatch[0].replace(/[_\s]+/g, '-').toUpperCase();
    }

    // Fallback: clean filename
    return base.replace(/[_\s]+/g, '-');
  };

  const handleDrawingUpload = (index, event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const autoDwgNo = extractDrawingNumber(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      setForm((current) => ({
        ...current,
        items: current.items.map((item, itemIndex) => {
          if (itemIndex !== index) return item;
          return {
            ...item,
            drawingNo: autoDwgNo, // Auto-fetches extracted drawing number (remains fully editable)
            drawingFileName: file.name,
            drawingDataUrl: reader.result
          };
        })
      }));
    };
    reader.readAsDataURL(file);

    event.target.value = '';
  };

  const handleUnitChange = (index, value) => {
    if (value === 'ADD_NEW') {
      setActiveItemIndexForUnit(index);
      setNewUnitName('');
      setNewUnitSymbol('');
      setShowAddUnit(true);
    } else {
      updateItem(index, 'unit', value);
    }
  };

  const handleSaveUnit = () => {
    const symbol = newUnitSymbol.trim();
    if (!symbol) return;

    if (!DEFAULT_UNITS.includes(symbol) && !customUnits.includes(symbol)) {
      const updated = [...customUnits, symbol];
      setCustomUnits(updated);
      localStorage.setItem('customUnits', JSON.stringify(updated));
    }

    if (activeItemIndexForUnit !== null) {
      updateItem(activeItemIndexForUnit, 'unit', symbol);
    }

    setShowAddUnit(false);
  };

  const addItem = () => {
    setForm((current) => ({ ...current, items: [...current.items, createEmptyItem()] }));
  };

  const removeItem = (index) => {
    setForm((current) => ({
      ...current,
      items: current.items.length === 1 ? current.items : current.items.filter((_, itemIndex) => itemIndex !== index)
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.customerName.trim() || !form.companyName.trim() || !form.requestedDate || !form.address.trim()) {
      setError('Please enter all customer and project details.');
      return;
    }

    const validItems = form.items.filter((item) => item.itemName.trim() && Number(item.quantity) > 0);
    if (validItems.length === 0) {
      setError('Please add at least one item with a valid quantity.');
      return;
    }

    const sanitizedItems = validItems.map((item) => ({
      itemName: item.itemName.trim(),
      drawingNo: item.drawingNo.trim(),
      drawingFileName: item.drawingFileName || '',
      materialSpec: item.materialSpec.trim(),
      quantity: Number(item.quantity),
      unit: item.unit || 'Nos',
      notes: item.notes.trim()
    }));

    const project = {
      projectId,
      customerName: form.customerName.trim(),
      companyName: form.companyName.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      gstin: form.gstin.trim(),
      requestedDate: form.requestedDate,
      targetDeliveryDate: form.targetDeliveryDate,
      address: form.address.trim(),
      engineeringNotes: form.engineeringNotes.trim(),
      items: sanitizedItems,
      createdAt: new Date().toISOString()
    };

    try {
      const drawItems = validItems.map((item, i) => ({
        ...sanitizedItems[i],
        drawingDataUrl: item.drawingDataUrl || ''
      }));
      await saveAllDrawings(projectId, drawItems);

      const stored = JSON.parse(localStorage.getItem('projectRequests') || '[]');

      if (isEdit) {
        const oldItems = editProject?.items || [];
        const removedItems = oldItems.filter(
          (old) => !sanitizedItems.some((s) => s.drawingNo === old.drawingNo)
        );
        if (removedItems.length > 0) {
          await deleteAllDrawings(projectId, removedItems);
        }
        const updated = stored.map((p) =>
          p.projectId === projectId
            ? { ...project, projectId, createdAt: editProject?.createdAt || project.createdAt }
            : p
        );
        localStorage.setItem('projectRequests', JSON.stringify(updated));
      } else {
        const finalSeq = getNextSequenceNumber();
        const finalProjectId = formatProjectId(finalSeq);
        localStorage.setItem('projectRequestSequence', String(finalSeq));

        await saveAllDrawings(finalProjectId, drawItems);
        const finalProject = { ...project, projectId: finalProjectId };
        localStorage.setItem('projectRequests', JSON.stringify([finalProject, ...stored]));
      }

      navigate('/project-request');
    } catch (storageError) {
      console.error('Unable to save project request', storageError);
      setError('Unable to save the project request. Please try again.');
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">Enquiry Management</p>
          <h1>{isEdit ? `Edit Customer Enquiry (${projectId})` : 'Add New Enquiry'}</h1>
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          <button className="button-secondary" type="button" onClick={() => navigate('/project-request')}>
            Back to Enquiries
          </button>
        </div>
      </div>

      <form className="content-block project-form" onSubmit={handleSubmit}>
        <div className="project-id-card">
          <div>
            <span className="field-label">Enquiry ID</span>
            <strong className="project-id-value">{projectId}</strong>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <section className="form-section">
          <div className="block-header compact">
            <div>
              <h2>1. Customer & Company Information</h2>
            </div>
          </div>

          {/* Quick Select Customer Toolbar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              marginBottom: '16px',
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              padding: '12px 16px',
              borderRadius: '10px',
              flexWrap: 'wrap'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1', minWidth: '280px' }}>
              <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b', whiteSpace: 'nowrap' }}>
                👤 Select Customer:
              </span>
              <CustomerSearchSelect
                customers={existingCustomers}
                value={selectedCustomerKey}
                selectedLabel={
                  customerSelectedMode === 'existing'
                    ? form.companyName || form.customerName || ''
                    : ''
                }
                onChange={handleSelectCustomer}
                placeholder="Type customer name, contact or phone..."
              />
            </div>

            <button
              type="button"
              className="button-primary"
              onClick={handleAddNewCustomer}
              style={{
                height: '38px',
                padding: '0 16px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontWeight: 'bold',
                fontSize: '12.5px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: '#2563eb',
                color: '#ffffff',
                borderRadius: '6px',
                border: 'none'
              }}
            >
              ＋ Add New Customer
            </button>
          </div>

          {customerSelectedMode && (
            <div className="form-grid" style={{ marginTop: '16px' }}>


              <label className="form-field">
                <span>Customer Contact Person <b>*</b></span>
                <input
                  value={form.customerName}
                  onChange={(e) => updateField('customerName', e.target.value)}
                  readOnly={!isAdmin() && lockedCustomerFields.customerName}
                  style={{
                    background: !isAdmin() && lockedCustomerFields.customerName ? '#f1f5f9' : '#ffffff',
                    cursor: !isAdmin() && lockedCustomerFields.customerName ? 'not-allowed' : 'text'
                  }}
                  required
                />
              </label>
              <label className="form-field">
                <span>Company / Client Name <b>*</b></span>
                <input
                  value={form.companyName}
                  onChange={(e) => updateField('companyName', e.target.value)}
                  readOnly={!isAdmin() && lockedCustomerFields.companyName}
                  style={{
                    background: !isAdmin() && lockedCustomerFields.companyName ? '#f1f5f9' : '#ffffff',
                    cursor: !isAdmin() && lockedCustomerFields.companyName ? 'not-allowed' : 'text'
                  }}
                  required
                />
              </label>
              <label className="form-field">
                <span>Customer GSTIN</span>
                <input
                  value={form.gstin}
                  onChange={(e) => updateField('gstin', e.target.value.toUpperCase())}
                  readOnly={!isAdmin() && lockedCustomerFields.gstin}
                  style={{
                    background: !isAdmin() && lockedCustomerFields.gstin ? '#f1f5f9' : '#ffffff',
                    cursor: !isAdmin() && lockedCustomerFields.gstin ? 'not-allowed' : 'text'
                  }}
                />
              </label>
              <label className="form-field">
                <span>Phone / Mobile</span>
                <input
                  value={form.phone}
                  onChange={(e) => updateField('phone', e.target.value)}
                  readOnly={!isAdmin() && lockedCustomerFields.phone}
                  style={{
                    background: !isAdmin() && lockedCustomerFields.phone ? '#f1f5f9' : '#ffffff',
                    cursor: !isAdmin() && lockedCustomerFields.phone ? 'not-allowed' : 'text'
                  }}
                />
              </label>
              <label className="form-field">
                <span>Email Address</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  readOnly={!isAdmin() && lockedCustomerFields.email}
                  style={{
                    background: !isAdmin() && lockedCustomerFields.email ? '#f1f5f9' : '#ffffff',
                    cursor: !isAdmin() && lockedCustomerFields.email ? 'not-allowed' : 'text'
                  }}
                />
              </label>
              <label className="form-field">
                <span>Inquiry / Request Date <b>*</b></span>
                <input
                  type="date"
                  value={form.requestedDate}
                  onChange={(e) => updateField('requestedDate', e.target.value)}
                  required
                />
              </label>
              <label className="form-field">
                <span>Target Delivery Date</span>
                <input
                  type="date"
                  value={form.targetDeliveryDate}
                  onChange={(e) => updateField('targetDeliveryDate', e.target.value)}
                />
              </label>
              <label className="form-field full-width">
                <span>Plant / Delivery Address <b>*</b></span>
                <textarea
                  rows="3"
                  style={{
                    minHeight: '78px',
                    lineHeight: '1.45',
                    fontSize: '13.5px',
                    padding: '9px 12px',
                    resize: 'vertical',
                    background: !isAdmin() && lockedCustomerFields.address ? '#f1f5f9' : '#ffffff',
                    cursor: !isAdmin() && lockedCustomerFields.address ? 'not-allowed' : 'text'
                  }}
                  value={form.address}
                  onChange={(e) => updateField('address', e.target.value)}
                  readOnly={!isAdmin() && lockedCustomerFields.address}
                  required
                />
              </label>
            </div>
          )}
        </section>

        <section className="form-section">
          <div className="block-header compact">
            <div>
              <h2>2. Component Items, Drawing Numbers & Material Specs</h2>
            </div>
            <button className="button-secondary" type="button" onClick={addItem}>
              + Add Item
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
            {form.items.map((item, index) => (
              <div
                key={index}
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '10px',
                  padding: '14px 16px',
                  display: 'grid',
                  gridTemplateColumns: '1.8fr 2.5fr 1.6fr 0.8fr 100px auto',
                  gap: '12px',
                  alignItems: 'flex-start'
                }}
              >
                <label className="form-field" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#334155' }}>Drawing No.</span>
                    <label
                      style={{
                        fontSize: '11px',
                        color: '#2563eb',
                        cursor: 'pointer',
                        fontWeight: '600',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '2px'
                      }}
                      title="Attach Drawing PDF to auto-fill Drawing No."
                    >
                      <span>📎 Attach PDF</span>
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.dwg,.dxf"
                        style={{ display: 'none' }}
                        onChange={(e) => handleDrawingUpload(index, e)}
                      />
                    </label>
                  </div>
                  <div style={{ position: 'relative' }}>
                    <input
                      value={item.drawingNo}
                      onChange={(e) => updateItem(index, 'drawingNo', e.target.value)}
                      style={{
                        paddingRight: item.drawingFileName ? '55px' : '10px'
                      }}
                    />
                    {item.drawingFileName && (
                      <div
                        style={{
                          position: 'absolute',
                          right: '6px',
                          top: '50%',
                          transform: 'translateY(-50%)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '3px'
                        }}
                      >
                        {item.drawingDataUrl && (
                          <button
                            type="button"
                            onClick={() => handlePreviewDrawing(item.drawingDataUrl, item.drawingFileName)}
                            title={`Preview ${item.drawingFileName}`}
                            style={{
                              fontSize: '11px',
                              background: '#eff6ff',
                              color: '#2563eb',
                              padding: '2px 5px',
                              borderRadius: '4px',
                              fontWeight: 'bold',
                              border: '1px solid #bfdbfe',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center'
                            }}
                          >
                            👁️
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            updateItem(index, 'drawingFileName', '');
                            updateItem(index, 'drawingDataUrl', '');
                          }}
                          title="Remove attached drawing"
                          style={{
                            fontSize: '11px',
                            background: '#fee2e2',
                            color: '#dc2626',
                            border: 'none',
                            borderRadius: '4px',
                            padding: '2px 4px',
                            cursor: 'pointer',
                            fontWeight: 'bold'
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                  {item.drawingFileName && (
                    <div style={{ fontSize: '10.5px', color: '#16a34a', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ✓ {item.drawingFileName}
                    </div>
                  )}
                </label>

                <label className="form-field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#334155' }}>Item Description *</span>
                  <input
                    value={item.itemName}
                    onChange={(e) => updateItem(index, 'itemName', e.target.value)}
                    required
                  />
                </label>

                <label className="form-field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#334155' }}>Material Specification</span>
                  <input
                    value={item.materialSpec}
                    onChange={(e) => updateItem(index, 'materialSpec', e.target.value)}
                  />
                </label>

                <label className="form-field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#334155' }}>Qty *</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={item.quantity}
                    onChange={(e) => updateItem(index, 'quantity', e.target.value)}
                    required
                  />
                </label>

                <label className="form-field" style={{ margin: 0 }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#334155' }}>Unit</span>
                  <select
                    value={item.unit || 'Nos'}
                    onChange={(e) => handleUnitChange(index, e.target.value)}
                    style={{
                      height: '38px',
                      padding: '4px 6px',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      background: '#ffffff',
                      fontSize: '13px',
                      color: '#0f172a',
                      cursor: 'pointer'
                    }}
                  >
                    {[...DEFAULT_UNITS, ...customUnits].map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                    <option value="ADD_NEW">+ Add Unit</option>
                  </select>
                </label>

                <div style={{ display: 'flex', alignItems: 'center', height: '100%', paddingTop: '22px' }}>
                  {form.items.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      title="Remove item"
                      style={{
                        background: '#fee2e2',
                        color: '#991b1b',
                        border: '1px solid #fca5a5',
                        borderRadius: '6px',
                        width: '32px',
                        height: '36px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '16px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                      }}
                    >
                      ×
                    </button>
                  ) : (
                    <div style={{ width: '32px' }}></div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="form-section">
          <div className="block-header compact">
            <div>
              <h2>3. Engineering Feasibility & Discussion Notes</h2>
            </div>
          </div>
          <div className="form-grid">
            <label className="form-field full-width">
              <span>Internal Feasibility Notes / Special Process Requirements</span>
              <textarea
                rows="2"
                value={form.engineeringNotes}
                onChange={(e) => updateField('engineeringNotes', e.target.value)}
              />
            </label>
          </div>
        </section>

        <div className="form-actions" style={{ marginTop: '24px' }}>
          <button className="button-secondary" type="button" onClick={() => navigate('/project-request')}>
            Cancel
          </button>
          <button className="button-primary" type="submit">
            {isEdit ? 'Update Enquiry' : 'Save Enquiry'}
          </button>
        </div>
      </form>

      {showAddUnit && (
        <div className="template-modal-backdrop no-print" onMouseDown={() => setShowAddUnit(false)}>
          <div className="template-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="template-modal-header">
              <div>
                <h3>Add New Unit</h3>
                <p>Create a custom unit for your items.</p>
              </div>
              <button type="button" className="template-modal-close" onClick={() => setShowAddUnit(false)} aria-label="Close">×</button>
            </div>
            <div className="form-grid">
              <label className="form-field full-width">
                <span>Unit Name</span>
                <input type="text" value={newUnitName} onChange={(e) => setNewUnitName(e.target.value)} placeholder="e.g. Kilograms" />
              </label>
              <label className="form-field full-width">
                <span>Unit Symbol <b>*</b></span>
                <input type="text" value={newUnitSymbol} onChange={(e) => setNewUnitSymbol(e.target.value)} placeholder="e.g. Kg" />
              </label>
            </div>
            <div className="template-modal-actions">
              <button type="button" className="button-secondary" onClick={() => setShowAddUnit(false)}>Cancel</button>
              <button type="button" className="button-primary" onClick={handleSaveUnit}>Save Unit</button>
            </div>
          </div>
        </div>
      )}

      {/* Drawing PDF / CAD Preview Modal */}
      {previewDrawing && (
        <div className="template-modal-backdrop no-print" onMouseDown={() => setPreviewDrawing(null)}>
          <div className="template-modal" style={{ maxWidth: '960px', width: '92vw' }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>📐</span>
                  <span>Drawing: {previewDrawing.fileName}</span>
                </h3>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => viewDrawingFile(previewDrawing.dataUrl, previewDrawing.fileName)}
                  style={{ fontSize: '12px', padding: '6px 14px', borderRadius: '6px' }}
                >
                  ↗️ Open in New Tab
                </button>
                <button
                  type="button"
                  className="template-modal-close"
                  onClick={() => setPreviewDrawing(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ padding: '12px 0 6px', minHeight: '560px' }}>
              {previewDrawing.fileName?.toLowerCase().endsWith('.png') ||
              previewDrawing.fileName?.toLowerCase().endsWith('.jpg') ||
              previewDrawing.fileName?.toLowerCase().endsWith('.jpeg') ? (
                <img
                  src={previewDrawing.dataUrl}
                  alt={previewDrawing.fileName}
                  style={{ maxWidth: '100%', maxHeight: '75vh', margin: '0 auto', display: 'block', objectFit: 'contain' }}
                />
              ) : (
                <iframe
                  src={previewDrawing.blobUrl}
                  title={previewDrawing.fileName}
                  style={{ width: '100%', height: '75vh', border: '1px solid #cbd5e1', borderRadius: '8px' }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AddProjectRequestPage;
