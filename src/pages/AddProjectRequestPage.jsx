import React, { useMemo, useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { UserRound, Eye, ExternalLink } from 'lucide-react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { viewDrawingFile, getBlobUrlFromDataUrl } from '../utils/fileViewer';
import { enrichCustomerDetails } from '../utils/customerMaster.js';
import { isAdmin } from '../utils/auth.js';
import AddableSelect from '../components/AddableSelect.jsx';
import { addCustomUnit, DEFAULT_UNITS, getCustomUnits } from '../utils/addableMasters.js';
import { saveAllDrawings, getDrawing, deleteAllDrawings } from '../utils/drawingStorage.js';
import CustomerSearchSelect from '../components/CustomerSearchSelect.jsx';
import CustomerRegistrationModal from '../components/CustomerRegistrationModal.jsx';
import { loadCustomerDirectory } from '../utils/customerDirectory.js';
import { createEnquiry, listEnquiries, updateEnquiry } from '../services/enquiryApi.js';
import { listQuotations } from '../services/quotationApi.js';

const createEmptyItem = () => ({
  itemName: '',
  drawingNo: '',
  drawingFileId: '',
  drawingFileName: '',
  drawingDataUrl: '',
  drawingSource: 'none',
  materialSpec: '',
  quantity: 1,
  unit: 'Nos',
  notes: ''
});

const AddProjectRequestPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const navigate = useNavigate();
  const location = useLocation();
  const isEdit = Boolean(location.state?.edit && location.state?.project);
  const editProject = location.state?.project || null;

  const projectId = isEdit ? editProject?.projectId : '';
  const [createToken, setCreateToken] = useState(() => globalThis.crypto?.randomUUID?.() || `enquiry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [editVersion, setEditVersion] = useState(Number(editProject?.version || 1));

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
        items: editProject.items && editProject.items.length > 0
          ? editProject.items.map((item) => ({ ...item, drawingDataUrl: '', drawingSource: 'server' }))
          : [createEmptyItem()]
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

  const handlePreviewDrawing = async (item) => {
    try {
      const dataUrl = item.drawingSource === 'local-new'
        ? item.drawingDataUrl
        : (isEdit && item.drawingNo ? await getDrawing(projectId, item.drawingNo, item.drawingFileId) : '');
      if (!dataUrl) throw new Error(`No PostgreSQL attachment exists for ${item.drawingNo || 'this drawing'}.`);
      const blobUrl = getBlobUrlFromDataUrl(dataUrl);
      setPreviewDrawing({ fileName: item.drawingFileName || 'drawing.pdf', dataUrl, blobUrl });
    } catch (previewError) {
      setError(`Drawing preview failed: ${previewError.message}`);
    }
  };

  const [existingCustomers, setExistingCustomers] = useState([]);
  const [selectedCustomerKey, setSelectedCustomerKey] = useState('');
  const [customerSelectedMode, setCustomerSelectedMode] = useState(
    isEdit || form.customerName || form.companyName ? 'existing' : ''
  );
  const [lockedCustomerFields, setLockedCustomerFields] = useState({});
  const [showCustomerModal, setShowCustomerModal] = useState(false);

  // Load customer masters and historical customer details from PostgreSQL.
  useEffect(() => {
    (async () => { try {
      const customersMap = new Map();

      const customerRecords = await loadCustomerDirectory();
      customerRecords.forEach((customer) => {
        const key = (customer.companyName || customer.customerName || '').trim().toLowerCase();
        if (key && !customersMap.has(key)) customersMap.set(key, { key, customerName: customer.customerName || '', companyName: customer.companyName || '', phone: customer.phone || '', email: customer.email || '', gstin: customer.gstin || '', address: customer.address || customer.billingAddress || '' });
      });

      const projects = await listEnquiries();
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

      const quotations = await listQuotations();
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

      // Sort alphabetically by company/customer name
      const sortedCustomers = Array.from(customersMap.values()).sort((a, b) =>
        (a.companyName || a.customerName || '').localeCompare(b.companyName || b.customerName || '')
      );

      setExistingCustomers(sortedCustomers);
    } catch (err) {
      setError(`Customer data could not be loaded from PostgreSQL: ${err.message}`);
    } })();
  }, []);

  useEffect(() => {
    if (!isEdit || !editProject?.items) return;
    (async () => {
      try {
        const itemsWithDrawings = await Promise.all(
          editProject.items.map(async (item) => {
            if (!item.drawingNo) return { ...item, drawingDataUrl: '', drawingSource: 'none' };
            const dataUrl = await getDrawing(editProject.projectId, item.drawingNo);
            return dataUrl
              ? { ...item, drawingDataUrl: dataUrl, drawingSource: 'server' }
              : { ...item, drawingDataUrl: '', drawingSource: 'missing' };
          })
        );
        setForm((prev) => ({ ...prev, items: itemsWithDrawings }));
        const missingDrawing = itemsWithDrawings.find((item) => item.drawingSource === 'missing');
        if (missingDrawing) setError(`The saved PostgreSQL attachment for ${missingDrawing.drawingNo} could not be found.`);
      } catch (err) {
        setError(`Failed to load and verify drawing from PostgreSQL: ${err.message}`);
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
    setShowCustomerModal(true);
  };

  const handleCustomerSaved = (customer) => {
    const key = (customer.companyName || customer.customerName).trim().toLowerCase();
    const record = { key, customerName: customer.customerName, companyName: customer.companyName, phone: customer.phone, email: customer.email, gstin: customer.gstin, address: customer.address || customer.billingAddress || '' };
    setExistingCustomers((current) => [record, ...current.filter((entry) => entry.key !== key)]);
    setSelectedCustomerKey(key);
    setCustomerSelectedMode('existing');
    setLockedCustomerFields({});
    setForm((previous) => ({ ...previous, ...record }));
  };

  const [customUnits, setCustomUnits] = useState(getCustomUnits);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const updateItem = (index, field, value) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, [field]: value, ...(field === 'drawingNo' && value !== item.drawingNo ? { drawingFileId: '' } : {}) }
          : item
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
            drawingFileId: '',
            drawingFileName: file.name,
            drawingDataUrl: reader.result,
            drawingSource: 'local-new'
          };
        })
      }));
    };
    reader.readAsDataURL(file);

    event.target.value = '';
  };

  const handleUnitChange = (index, value) => {
    updateItem(index, 'unit', value);
  };

  const handleCreateUnit = ({ name, symbol }) => {
    const created = addCustomUnit({ name, symbol });
    setCustomUnits(getCustomUnits());
    return created;
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
      drawingFileId: item.drawingFileId || '',
      drawingFileName: item.drawingFileName || '',
      materialSpec: item.materialSpec.trim(),
      quantity: Number(item.quantity),
      unit: item.unit || 'Nos',
      notes: item.notes.trim()
    }));

    const project = {
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

    let recordConfirmed = false;
    try {
      const drawItems = validItems.map((item, i) => ({
        ...sanitizedItems[i],
        drawingDataUrl: item.drawingDataUrl || ''
      }));
      let savedProject;
      if (isEdit) {
        const nextProject = { ...project, projectId, createdAt: editProject?.createdAt || project.createdAt };
        const result = await updateEnquiry(projectId, nextProject, editVersion);
        savedProject = result.record;
        setEditVersion(savedProject.version);
        recordConfirmed = true;
      } else {
        const result = await createEnquiry(project, { createToken, sequenceHint: 0 });
        savedProject = result.record;
        recordConfirmed = true;
      }

      // Refresh the cache only from PostgreSQL-confirmed records.
      const verifiedDrawings = await saveAllDrawings(savedProject.projectId, drawItems);
      if (verifiedDrawings.length > 0) {
        const verifiedByDrawing = new Map(verifiedDrawings.map((attachment) => [attachment.drawingNo, attachment]));
        const linkedItems = project.items.map((item) => {
          const attachment = verifiedByDrawing.get(item.drawingNo);
          return attachment ? { ...item, drawingFileId: attachment.id } : item;
        });
        const linked = await updateEnquiry(
          savedProject.projectId,
          { ...project, items: linkedItems },
          savedProject.version
        );
        savedProject = linked.record;
        if (isEdit) setEditVersion(savedProject.version);
      }

      if (isEdit) {
        const oldItems = editProject?.items || [];
        const removedItems = oldItems.filter(
          (old) => !sanitizedItems.some((s) => s.drawingNo === old.drawingNo)
        );
        if (removedItems.length > 0) {
          await deleteAllDrawings(savedProject.projectId, removedItems);
        }
      } else {
        setCreateToken(globalThis.crypto?.randomUUID?.() || `enquiry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      }

      navigate('/project-request');
    } catch (storageError) {
      console.error('Unable to save project request', storageError);
      setError(recordConfirmed
        ? `The enquiry was saved in PostgreSQL, but a drawing operation failed: ${storageError.message}`
        : `Unable to save the enquiry in PostgreSQL: ${storageError.message}`);
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>{isEdit ? `Edit Customer Enquiry (${projectId})` : 'Add New Enquiry'}</h1>
        </div>
        <div className="header-actions">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          <button className="button-secondary" type="button" onClick={() => navigate('/project-request')}>
            Back to Enquiries
          </button>
        </div>
      </div>

      <form className="content-block project-form" onSubmit={handleSubmit}>
        <div className="project-id-card">
          <div>
            <span className="field-label">Enquiry ID</span>
            <strong className="project-id-value">{projectId || 'Assigned when saved'}</strong>
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
                <UserRound size={16} aria-hidden="true" className="text-slate-600" /> Select Customer:
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
              <span className="restored-emoji-icon">＋</span> Add New Customer
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
                      <span><span className="restored-emoji-icon">📎</span> Attach PDF</span>
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
                        {(item.drawingDataUrl || (isEdit && item.drawingSource === 'server' && item.drawingFileName)) && (
                          <button
                            type="button"
                            onClick={() => handlePreviewDrawing(item)}
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
                            <Eye size={14} aria-hidden="true" />
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
                  <AddableSelect
                    value={item.unit || 'Nos'}
                    onChange={(event) => handleUnitChange(index, event.target.value)}
                    options={[...DEFAULT_UNITS, ...customUnits]}
                    onCreate={handleCreateUnit}
                    masterType="unit"
                    title="Add Unit of Measurement"
                    addLabel="+ Add New Unit"
                    addNewInOptions
                    selectStyle={{ width: '100%', minWidth: 0, height: '38px', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px', fontSize: '13px' }}
                  />
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


      {/* Drawing PDF / CAD Preview Modal */}
      {previewDrawing && (
        <div className="template-modal-backdrop no-print" onMouseDown={() => setPreviewDrawing(null)}>
          <div className="template-modal" style={{ maxWidth: '960px', width: '92vw' }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="template-modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="restored-emoji-icon">📐</span>
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
                  <ExternalLink size={14} aria-hidden="true" /> Open in New Tab
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
      {showCustomerModal && <CustomerRegistrationModal onClose={() => setShowCustomerModal(false)} onSaved={handleCustomerSaved} />}
    </div>
  );
};

export default AddProjectRequestPage;
