import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { calculateGSTAmount, calculateLineAmount, calculateTotals } from '../utils/calculations.js';
import { CURRENCIES, amountInWords as wordsFor, convertToINR, getCurrency, isForeignCurrency, money } from '../utils/currency.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import QuotationPreview from './QuotationPreview.jsx';
import { getQuotationTemplates, getTemplateColumns } from '../utils/quotationTemplates.js';
import { getCompanyLegalName, getCompanyProfile } from '../utils/companyBranding.js';
import { getNextSequentialNumber, getNextQuotationNumber, saveDocSequence } from '../utils/sequenceGenerator.js';
import { getAllProjectsSummary, getFullProjectData } from '../utils/projectTracker.js';
import ProjectIdAutocomplete from './ProjectIdAutocomplete.jsx';
import { isAdmin } from '../utils/auth.js';
import { getBOMs, getInventoryItems } from '../utils/storeService.js';
import AddableSelect from './AddableSelect.jsx';
import { addCustomUnit, DEFAULT_UNITS, getCustomUnits } from '../utils/addableMasters.js';

const emptyItem = {
  itemName: '',
  hsnSac: '',
  quantity: '',
  unit: 'Nos',
  unitPrice: '',
  gst: '18'
};

const growTextarea = (el) => {
  if (!el || typeof el.scrollHeight !== 'number') return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

const DEFAULT_TERMS_TEMPLATES = [
  {
    id: 'template-1',
    number: 1,
    name: 'Template 1',
    content:
      'Payment terms: 50% advance along with purchase order, balance against delivery.\n' +
      'Prices are ex-works Bangalore and exclusive of GST.\n' +
      'Delivery timeline: 2-3 weeks from receipt of technically and commercially clear PO.\n' +
      'Quotation validity: 30 days from the date of issue.'
  },
  {
    id: 'template-2',
    number: 2,
    name: 'Template 2',
    content:
      'Payment: 100% against proforma invoice prior to dispatch.\n' +
      'Taxes: GST extra as applicable at the time of invoicing.\n' +
      'Freight & insurance: Borne by customer on actual basis.\n' +
      'Warranty: 12 months standard manufacturing warranty from dispatch date.'
  },
  {
    id: 'template-3',
    number: 3,
    name: 'Template 3',
    content:
      'Payment terms: Net 30 days from invoice date.\n' +
      'Transit insurance: To be arranged by buyer.\n' +
      'Delivery: Ex-factory basis.\n' +
      'Dispute resolution subject to Bangalore jurisdiction only.'
  }
];

const TERMS_TEMPLATES_KEY = 'termsAndConditionsTemplates';

const loadTermsTemplates = () => {
  try {
    const stored = localStorage.getItem(TERMS_TEMPLATES_KEY);
    if (!stored) {
      localStorage.setItem(TERMS_TEMPLATES_KEY, JSON.stringify(DEFAULT_TERMS_TEMPLATES));
      return DEFAULT_TERMS_TEMPLATES;
    }
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_TERMS_TEMPLATES;
  } catch {
    return DEFAULT_TERMS_TEMPLATES;
  }
};

const generateQuotationNumber = () => {
  return getNextQuotationNumber();
};

const QuotationForm = ({ initialData = null, onCancel = null }) => {
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [hoveredTemplateId, setHoveredTemplateId] = useState('');
  const [isAddTemplateOpen, setIsAddTemplateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateContent, setNewTemplateContent] = useState('');
  const [companyDetails, setCompanyDetails] = useState(() => {
    try {
      const stored = localStorage.getItem('companySettings');
      if (stored) {
        const parsed = JSON.parse(stored);
        return {
          companyName: parsed.companyName || getCompanyLegalName(),
          phone: parsed.phone || '',
          email: parsed.email || '',
          gstin: parsed.gstin || '',
          state: parsed.state || 'Karnataka',
          address: parsed.address || '',
          bankName: parsed.bankName || '',
          accountNumber: parsed.accountNumber || '',
          ifscCode: parsed.ifscCode || '',
          branch: parsed.branch || ''
        };
      }
    } catch {}
    return initialData?.companyDetails || {
      companyName: getCompanyLegalName(),
      phone: '',
      email: '',
      gstin: '',
      state: 'Karnataka'
    };
  });

  const [customerDetails, setCustomerDetails] = useState(() => initialData?.customerDetails || {
    customerName: '',
    companyName: '',
    address: '',
    contactNumber: '',
    email: '',
    gstNumber: '',
    state: ''
  });

  const [quotationDetails, setQuotationDetails] = useState(() => ({
    quotationTemplate: initialData?.quotationDetails?.quotationTemplate || '',
    quotationNumber: initialData?.quotationDetails?.quotationNumber || generateQuotationNumber(),
    quotationDate: initialData?.quotationDetails?.quotationDate || initialData?.quotationDetails?.date || new Date().toISOString().slice(0, 10),
    projectId: initialData?.quotationDetails?.projectId || '',
    bomId: initialData?.quotationDetails?.bomId || '',
    placeOfSupply: initialData?.quotationDetails?.placeOfSupply || '',
    termsAndConditions: initialData?.quotationDetails?.termsAndConditions || '',
    discount: initialData?.quotationDetails?.discount || '',
    currency: initialData?.quotationDetails?.currency || 'INR',
    exchangeRate: initialData?.quotationDetails?.exchangeRate ?? '',
    rateDate: initialData?.quotationDetails?.rateDate || '',
    taxMode: initialData?.quotationDetails?.taxMode || 'intra',
    notes: initialData?.quotationDetails?.notes || ''
  }));
  const [lockedCustomerFields, setLockedCustomerFields] = useState({});
  const [isTemplateConfirmed, setIsTemplateConfirmed] = useState(
    Boolean(initialData?.quotationDetails?.quotationTemplate)
  );
  const [templateConfirmModal, setTemplateConfirmModal] = useState(null);

  const handleSelectTemplate = (template) => {
    setTemplateConfirmModal(template);
  };

  const handleConfirmTemplate = (template) => {
    setQuotationDetails((prev) => ({
      ...prev,
      quotationTemplate: template.id
    }));
    setIsTemplateConfirmed(true);
    setTemplateConfirmModal(null);
  };

  const [quotationTemplates, setQuotationTemplates] = useState(getQuotationTemplates());
  const [showAddQuotationTemplate, setShowAddQuotationTemplate] = useState(false);
  const [newQuotationTemplateName, setNewQuotationTemplateName] = useState('');
  const [newQuotationTemplateFields, setNewQuotationTemplateFields] = useState([{ label: '', type: 'text' }]);

  const [items, setItems] = useState(() => (initialData?.items && initialData.items.length > 0 ? initialData.items : [{ ...emptyItem }]));

  useEffect(() => {
    if (initialData) {
      if (initialData.companyDetails) setCompanyDetails(initialData.companyDetails);
      if (initialData.customerDetails) setCustomerDetails(initialData.customerDetails);
      if (initialData.quotationDetails) {
        setQuotationDetails({
          ...initialData.quotationDetails,
          quotationNumber: initialData.quotationDetails.quotationNumber || generateQuotationNumber(),
          quotationDate: initialData.quotationDetails.quotationDate || initialData.quotationDetails.date || new Date().toISOString().slice(0, 10),
          currency: initialData.quotationDetails.currency || 'INR',
          exchangeRate: initialData.quotationDetails.exchangeRate ?? '',
          rateDate: initialData.quotationDetails.rateDate || '',
          taxMode: initialData.quotationDetails.taxMode || 'intra'
        });
        const bomId = initialData.quotationDetails.bomId || '';
        if (bomId) {
          setSelectedBomId(bomId);
          const allBOMs = getBOMs();
          const projId = initialData.quotationDetails.projectId || '';
          if (projId) {
            setAvailableBOMs(allBOMs.filter((b) => b.projectId === projId));
          }
        }
      }
      if (initialData.items && initialData.items.length > 0) setItems(initialData.items);
    }
  }, [initialData]);

  const [projectSummaryList, setProjectSummaryList] = useState([]);
  const [projectAutoLinkMsg, setProjectAutoLinkMsg] = useState('');
  const [selectedBomId, setSelectedBomId] = useState(initialData?.quotationDetails?.bomId || '');
  const [availableBOMs, setAvailableBOMs] = useState([]);

  useEffect(() => {
    setProjectSummaryList(getAllProjectsSummary());
  }, []);

  const handleProjectLookup = (pid, directData) => {
    setQuotationDetails((prev) => ({ ...prev, projectId: pid }));
    setSelectedBomId('');
    if (!pid || !pid.trim()) {
      setProjectAutoLinkMsg('');
      setLockedCustomerFields({});
      setAvailableBOMs([]);
      return;
    }

    const data = directData || getFullProjectData(pid);
    const allBOMs = getBOMs();
    const projectBOMs = allBOMs.filter((b) => b.projectId === pid);
    setAvailableBOMs(projectBOMs);

    if (data && (data.customerDetails?.customerName || data.customerDetails?.companyName || (data.items && data.items.length > 0))) {
      if (data.customerDetails) {
        setCustomerDetails((prev) => ({
          ...prev,
          customerName: data.customerDetails.customerName || prev.customerName,
          companyName: data.customerDetails.companyName || prev.companyName,
          address: data.customerDetails.address || prev.address,
          contactNumber: data.customerDetails.contactNumber || prev.contactNumber,
          email: data.customerDetails.email || prev.email,
          gstNumber: data.customerDetails.gstNumber || prev.gstNumber,
          state: data.customerDetails.state || prev.state
        }));
        setLockedCustomerFields({
          customerName: Boolean(data.customerDetails.customerName?.trim()),
          companyName: Boolean(data.customerDetails.companyName?.trim()),
          address: Boolean(data.customerDetails.address?.trim()),
          contactNumber: Boolean(data.customerDetails.contactNumber?.trim()),
          email: Boolean(data.customerDetails.email?.trim()),
          gstNumber: Boolean(data.customerDetails.gstNumber?.trim()),
          state: Boolean(data.customerDetails.state?.trim())
        });
      }

      if (data.items && data.items.length > 0) {
        const isBlank = items.length === 1 && !items[0].itemName.trim();
        if (isBlank) {
          const allInv = getInventoryItems();
          const mappedItems = data.items.map((projItem) => {
            const qItem = {
              itemCode: projItem.itemCode || '',
              itemName: projItem.itemName || '',
              hsnSac: '',
              materialSpec: projItem.materialSpec || '',
              quantity: projItem.quantity || '',
              unit: projItem.unit || 'Nos',
              unitPrice: 0,
              gst: '18',
              notes: projItem.notes || ''
            };
            if (projItem.drawingNo) qItem.drawingNo = projItem.drawingNo;
            return qItem;
          });
          setItems(mappedItems);
        }
      }

      const bomMsg = projectBOMs.length > 0
        ? `✓ Linked to Project: ${pid} (${data.customerDetails?.companyName || data.customerDetails?.customerName || 'Matched'}) — ${projectBOMs.length} item list(s) available`
        : `✓ Linked to Project: ${pid} (${data.customerDetails?.companyName || data.customerDetails?.customerName || 'Matched'}) — No item list available`;
      setProjectAutoLinkMsg(bomMsg);
    } else {
      setProjectAutoLinkMsg('');
    }
  };
  
  const [customUnits, setCustomUnits] = useState(getCustomUnits);

  const handleBOMSelect = (bomId) => {
    if (!bomId) {
      setSelectedBomId('');
      return;
    }
    const bom = availableBOMs.find((b) => b.id === bomId);
    if (!bom) return;
    setSelectedBomId(bomId);
    if (bom.remarks && bom.remarks.trim()) {
      setQuotationDetails((prev) => ({ ...prev, notes: bom.remarks }));
    }
    const allInv = getInventoryItems();
    const bomItems = bom.items.map((bomItem) => {
      const inv = allInv.find((i) => i.itemCode === bomItem.materialId);
      return {
        itemName: bomItem.materialName || bomItem.materialId || '',
        hsnSac: inv?.hsnSac || '',
        quantity: bomItem.requiredQty || '',
        unit: bomItem.unit || 'Nos',
        unitPrice: inv?.unitCost || '',
        gst: '18',
        drawingNo: bom.drawingNumber || '',
        bomMaterialId: bomItem.materialId || '',
        bomGrade: bomItem.grade || '',
        bomSpec: bomItem.spec || '',
        bomSize: bomItem.sizeDimensions || ''
      };
    });
    if (bomItems.length > 0) {
      setItems(bomItems);
    }
  };


  const [termsTemplates, setTermsTemplates] = useState(loadTermsTemplates);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [termsMessage, setTermsMessage] = useState('');
  const [errors, setErrors] = useState({
    customerName: '',
    projectId: '',
    itemsError: '',
    exchangeRate: '',
    items: []
  });

  const handleCompanyChange = (event) => {
    const { name, value } = event.target;
    setCompanyDetails((prev) => ({
      ...prev,
      [name]: value
    }));
  };

  const handleCustomerChange = (event) => {
    const { name, value } = event.target;
    setCustomerDetails((prev) => ({
      ...prev,
      [name]: value
    }));
  };

  const normalizeTermsLines = (text) => {
    return String(text)
      .split(/\r?\n/)
      .map((line, index) => {
        const content = line.replace(/^\s*\d+\.\s*/, '');
        return `${index + 1}. ${content}`;
      })
      .join('\n');
  };

  const handleQuotationChange = (event) => {
    const { name, value } = event.target;
    if ((name === 'exchangeRate' || name === 'currency') && errors.exchangeRate) {
      setErrors((prev) => ({ ...prev, exchangeRate: '' }));
    }
    setQuotationDetails((prev) => ({
      ...prev,
      [name]: name === 'termsAndConditions' ? normalizeTermsLines(value) : value
    }));
  };

  const handleTermsKeyDown = (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    const textarea = event.target;
    const { selectionStart, selectionEnd, value } = textarea;
    const before = value.slice(0, selectionStart);
    const after = value.slice(selectionEnd);
    const lineNumber = before.split(/\r?\n/).length + 1;
    const newValue = `${before}\n${lineNumber}. ${after}`;

    setQuotationDetails((prev) => ({
      ...prev,
      termsAndConditions: newValue
    }));

    window.requestAnimationFrame(() => {
      const cursorPos = selectionStart + String(`\n${lineNumber}. `).length;
      textarea.setSelectionRange(cursorPos, cursorPos);
    });
  };

  const applyTermsTemplate = (template) => {
    if (!template) return;

    setSelectedTemplateId(template.id);
    setQuotationDetails((prev) => ({
      ...prev,
      termsAndConditions: normalizeTermsLines(template.content)
    }));
    setTermsMessage(`${template.name || `Template ${template.number}`} applied.`);
    setIsTemplateMenuOpen(false);
    setHoveredTemplateId('');
  };

  const getNextTemplateNumber = (templates) => {
    if (!templates || templates.length === 0) return 1;
    const numbers = templates.map((t) => {
      const match = (t.name || '').match(/Template\s*(\d+)/i);
      return match ? parseInt(match[1], 10) : (t.number || 0);
    });
    return Math.max(...numbers, 0) + 1;
  };

  const saveTermsTemplate = () => {
    const content = String(quotationDetails.termsAndConditions || '').trim();
    if (!content) {
      setTermsMessage('Enter conditions first, then save them as a template.');
      return;
    }

    const nextNumber = getNextTemplateNumber(termsTemplates);
    const newTemplate = {
      id: `template-${Date.now()}`,
      number: nextNumber,
      name: `Template ${nextNumber}`,
      content
    };

    const updated = [...termsTemplates, newTemplate];
    setTermsTemplates(updated);
    setSelectedTemplateId(newTemplate.id);
    localStorage.setItem(TERMS_TEMPLATES_KEY, JSON.stringify(updated));
    setTermsMessage(`${newTemplate.name} saved.`);
  };

  const handleAddQuotationTemplateField = () => {
    setNewQuotationTemplateFields([...newQuotationTemplateFields, { label: '', type: 'text' }]);
  };

  const handleQuotationTemplateFieldChange = (index, key, value) => {
    const newFields = [...newQuotationTemplateFields];
    newFields[index][key] = value;
    setNewQuotationTemplateFields(newFields);
  };

  const handleRemoveQuotationTemplateField = (index) => {
    setNewQuotationTemplateFields(newQuotationTemplateFields.filter((_, i) => i !== index));
  };

  const handleSaveQuotationTemplate = () => {
    if (!newQuotationTemplateName.trim()) return alert("Template name is required");
    
    const validFields = newQuotationTemplateFields.filter(f => f.label.trim());
    const id = newQuotationTemplateName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    
    const columns = [
      { id: 'itemName', label: 'Item Name', type: 'text', main: true },
      ...validFields.map(f => ({
        id: f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: f.label.trim(),
        type: f.type,
        secondary: true
      }))
    ];

    const newTemplate = { id, label: newQuotationTemplateName.trim(), columns };
    
    const existingCustom = JSON.parse(localStorage.getItem('customQuotationTemplates')) || [];
    existingCustom.push(newTemplate);
    localStorage.setItem('customQuotationTemplates', JSON.stringify(existingCustom));
    
    const updated = getQuotationTemplates();
    setQuotationTemplates(updated);
    setQuotationDetails(prev => ({ ...prev, quotationTemplate: id }));
    setShowAddQuotationTemplate(false);
    setNewQuotationTemplateName('');
    setNewQuotationTemplateFields([{ label: '', type: 'text' }]);
  };

  const handleAddTemplate = (event) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const nextNumber = getNextTemplateNumber(termsTemplates);
    const name = (newTemplateName || `Template ${nextNumber}`).trim();
    const content = newTemplateContent.trim();

    if (!content) {
      alert('Please enter Terms & Conditions content.');
      return;
    }

    const newTemplate = {
      id: `template-${Date.now()}`,
      number: nextNumber,
      name,
      content: normalizeTermsLines(content)
    };
    const updated = [...termsTemplates, newTemplate];

    setTermsTemplates(updated);
    setSelectedTemplateId(newTemplate.id);
    setQuotationDetails((prev) => ({
      ...prev,
      termsAndConditions: normalizeTermsLines(content)
    }));
    localStorage.setItem(TERMS_TEMPLATES_KEY, JSON.stringify(updated));
    setNewTemplateName('');
    setNewTemplateContent('');
    setIsAddTemplateOpen(false);
    setIsTemplateMenuOpen(false);
    setTermsMessage(`${name} added and applied.`);
  };

  const deleteTermsTemplate = (id) => {
    const template = termsTemplates.find((item) => item.id === id);
    if (!template || !window.confirm(`Delete ${template.name || `Template ${template.number}`}?`)) {
      return;
    }

    const updated = termsTemplates.filter((item) => item.id !== id);
    setTermsTemplates(updated);
    if (selectedTemplateId === id) {
      setSelectedTemplateId('');
    }
    localStorage.setItem(TERMS_TEMPLATES_KEY, JSON.stringify(updated));
    setTermsMessage(`${template.name || `Template ${template.number}`} deleted.`);
  };

  const handleItemChange = (index, event) => {
    const { name, value } = event.target;
    setItems((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [name]: value
      };
      return next;
    });
  };

  const handleItemFieldChange = (index, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        [field]: value
      };
      return next;
    });
  };

  const handleUnitChange = (index, value) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], unit: value };
      return next;
    });
  };

  const handleCreateUnit = ({ name, symbol }) => {
    const created = addCustomUnit({ name, symbol });
    setCustomUnits(getCustomUnits());
    return created;
  };

  const addItem = () => {
    setItems((prev) => [...prev, { ...emptyItem }]);
  };

  const deleteItem = (index) => setItems((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
  const removeItem = deleteItem;

  const addSubPart = (itemIndex) => {
    setItems((prev) => {
      const next = [...prev];
      const current = next[itemIndex] || {};
      const subParts = Array.isArray(current.subParts) ? current.subParts : [];
      next[itemIndex] = {
        ...current,
        subParts: [...subParts, { description: '', quantity: 1 }]
      };
      return next;
    });
  };

  const updateSubPart = (itemIndex, subIndex, field, value) => {
    setItems((prev) => {
      const next = [...prev];
      const current = next[itemIndex] || {};
      const subParts = Array.isArray(current.subParts) ? [...current.subParts] : [];
      subParts[subIndex] = { ...subParts[subIndex], [field]: value };
      next[itemIndex] = { ...current, subParts };
      return next;
    });
  };

  const deleteSubPart = (itemIndex, subIndex) => {
    setItems((prev) => {
      const next = [...prev];
      const current = next[itemIndex] || {};
      const subParts = (Array.isArray(current.subParts) ? current.subParts : []).filter((_, i) => i !== subIndex);
      next[itemIndex] = { ...current, subParts };
      return next;
    });
  };

  const editSubPart = (itemIndex, subIndex) => {
    const input = document.getElementById(`subpart-desc-${itemIndex}-${subIndex}`);
    if (input) {
      input.focus();
      if (typeof input.select === 'function') input.select();
    }
  };

  const computedItems = useMemo(
    () =>
      items.map((item) => {
        const quantity = Number(item.quantity) || 0;
        const unitPrice = Number(item.unitPrice) || 0;
        const gstPercent = Number(item.gst) || 0;
        const amount = calculateLineAmount(quantity, unitPrice);
        const gstAmount = calculateGSTAmount(amount, gstPercent);

        return {
          ...item,
          unit: item.unit || 'Nos',
          amount,
          gstAmount
        };
      }),
    [items]
  );

  const currencyCode = quotationDetails.currency || 'INR';
  const activeCurrency = getCurrency(currencyCode);
  const taxMode = quotationDetails.taxMode || 'intra';

  const totals = useMemo(
    () => calculateTotals(computedItems, quotationDetails.discount, taxMode),
    [computedItems, quotationDetails.discount, taxMode]
  );
  const amountInWords = useMemo(() => wordsFor(totals.grandTotal, currencyCode), [totals.grandTotal, currencyCode]);
  const grandTotalINR = useMemo(
    () => convertToINR(totals.grandTotal, currencyCode, quotationDetails.exchangeRate),
    [totals.grandTotal, currencyCode, quotationDetails.exchangeRate]
  );

  const validate = () => {
    const nextErrors = {
      customerName: '',
      projectId: '',
      itemsError: '',
      exchangeRate: '',
      items: []
    };

    if (isForeignCurrency(currencyCode) && !(Number(quotationDetails.exchangeRate) > 0)) {
      nextErrors.exchangeRate = `Exchange rate (1 ${currencyCode} to INR) is required for non-INR quotations.`;
    }

    if (!customerDetails.customerName.trim()) {
      nextErrors.customerName = 'Customer Name is required.';
    }

    if (!quotationDetails.projectId.trim()) {
      nextErrors.projectId = 'Project ID is required.';
    }

    if (!quotationDetails.quotationTemplate || !isTemplateConfirmed) {
      nextErrors.quotationTemplate = 'Please select and confirm a Quotation Template.';
    }

    if (!items.length) {
      nextErrors.itemsError = 'At least one item is required.';
    }

    const itemNameLabel =
      getTemplateColumns(quotationDetails.quotationTemplate).find((col) => col.id === 'itemName')?.label || 'Item Name';

    const rowErrors = items.map((item) => {
      const row = {};
      if (!item.itemName.trim()) {
        row.itemName = `${itemNameLabel} is required.`;
      }
      if (!(Number(item.quantity) > 0)) {
        row.quantity = 'Quantity must be greater than zero.';
      }
      if (!(Number(item.unitPrice) > 0)) {
        row.unitPrice = 'Unit Price must be greater than zero.';
      }
      return row;
    });

    if (rowErrors.some((row) => Object.keys(row).length > 0)) {
      nextErrors.items = rowErrors;
      nextErrors.itemsError = nextErrors.itemsError || 'Please fix the highlighted item errors.';
    }

    setErrors(nextErrors);

    return !nextErrors.customerName && !nextErrors.projectId && !nextErrors.quotationTemplate && !nextErrors.itemsError && !nextErrors.exchangeRate;
  };

  const navigate = useNavigate();
  const [statusMessage, setStatusMessage] = useState('');
  const [pdfMessage, setPdfMessage] = useState('');

  const getQuotationPayload = () => ({
    companyDetails: {
      ...companyDetails
    },
    customerDetails,
    quotationDetails: {
      ...quotationDetails,
      bomId: selectedBomId
    },
    termsAndConditions: quotationDetails.termsAndConditions,
    items: computedItems,
    totals,
    amountInWords
  });

  const saveQuotation = () => {
    const payload = getQuotationPayload();
    localStorage.setItem('currentQuotation', JSON.stringify(payload));
    setStatusMessage('Quotation saved to Local Storage.');
  };

  const resetForm = () => {
    const confirmed = window.confirm('Clear all form fields and reset the quotation?');
    if (!confirmed) {
      return;
    }

    const profile = getCompanyProfile();
    setCompanyDetails({
      companyName: profile.companyName || getCompanyLegalName(),
      phone: profile.phone || '',
      email: profile.email || '',
      address: profile.address || '',
      gstin: profile.gstin || '',
      state: profile.state || ''
    });
    setCustomerDetails({
      customerName: '',
      companyName: '',
      address: '',
      contactNumber: '',
      email: '',
      gstNumber: '',
      state: ''
    });
    setQuotationDetails({
      quotationNumber: generateQuotationNumber(),
      quotationDate: new Date().toISOString().slice(0, 10),
      projectId: '',
      placeOfSupply: '',
      currency: 'INR',
      exchangeRate: '',
      rateDate: '',
      taxMode: 'intra',
      termsAndConditions: ''
    });
    setItems([{ ...emptyItem }]);
    setErrors({
      customerName: '',
      projectId: '',
      itemsError: '',
      exchangeRate: '',
      items: []
    });
    setStatusMessage('Form reset completed.');
    setPdfMessage('');
  };

  const handlePrint = async () => {
    setPdfMessage('');
    const payload = getQuotationPayload();
    try {
      await generateQuotationPDF(payload, { print: true });
      setPdfMessage('Print dialog opened.');
    } catch (error) {
      console.error('PDF generation error:', error);
      setPdfMessage('Unable to open print preview. Please try again.');
    }
  };

  const handleDownloadPDF = async () => {
    setPdfMessage('');
    const payload = getQuotationPayload();
    try {
      await generateQuotationPDF(payload);
      setPdfMessage('PDF download started.');
    } catch (error) {
      console.error('PDF generation error:', error);
      setPdfMessage('Unable to generate PDF. Please try again.');
    }
  };

  const handlePreviewNavigation = () => {
    if (!validate()) {
      return;
    }

    const payload = getQuotationPayload();
    localStorage.setItem('currentQuotation', JSON.stringify(payload));
    navigate('/quotation/preview', { state: { quotation: payload } });
  };

  const appendQuotationToHistory = (quotation) => {
    try {
      const stored = localStorage.getItem('quotationHistory');
      let history = stored ? JSON.parse(stored) : [];
      const entry = {
        date: quotation.quotationDetails.quotationDate,
        reference: quotation.quotationDetails.quotationNumber,
        projectId: quotation.quotationDetails.projectId || '',
        company: quotation.customerDetails.companyName || quotation.customerDetails.customerName || '-',
        total: money(Number(quotation.totals?.grandTotal || 0), quotation.quotationDetails?.currency || 'INR'),
        currency: quotation.quotationDetails?.currency || 'INR',
        amountINR: convertToINR(
          Number(quotation.totals?.grandTotal || 0),
          quotation.quotationDetails?.currency || 'INR',
          quotation.quotationDetails?.exchangeRate
        ),
        balanceStatus: 'Pending',
        payload: quotation
      };

      const existingIndex = history.findIndex((h) => h.reference === entry.reference);
      if (existingIndex !== -1) {
        history[existingIndex] = entry;
      } else {
        history.unshift(entry);
      }
      localStorage.setItem('quotationHistory', JSON.stringify(history));
    } catch (error) {
      console.error('Unable to save quotation history', error);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }

    const payload = getQuotationPayload();
    saveDocSequence('quotationSequence', payload.quotationDetails.quotationNumber);
    localStorage.setItem('currentQuotation', JSON.stringify(payload));
    appendQuotationToHistory(payload);
    navigate('/quotation/preview', { state: { quotation: payload } });
  };

  return (
    <section className="quotation-form-card">
      <div className="form-header">
        <div>
          <h2>{initialData ? 'Edit Quotation' : 'Quotation Entry Form'}</h2>
          
        </div>
      </div>

      <form className="quotation-form" onSubmit={handleSubmit}>
        <div className="form-section">
          <div className="section-heading">
            <h3>Customer Details</h3>
          </div>

          <div className="section-grid">
            <div className="field-group">
              <label htmlFor="customerName">
                Customer Name <b>*</b>
              </label>
              <input
                id="customerName"
                name="customerName"
                type="text"
                value={customerDetails.customerName}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.customerName}
                style={{
                  background: !isAdmin() && lockedCustomerFields.customerName ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.customerName ? 'not-allowed' : 'text'
                }}
              />
              {errors.customerName && <div className="field-hint error">{errors.customerName}</div>}
            </div>
            <div className="field-group">
              <label htmlFor="customerCompanyName">Company Name</label>
              <input
                id="customerCompanyName"
                name="companyName"
                type="text"
                value={customerDetails.companyName}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.companyName}
                style={{
                  background: !isAdmin() && lockedCustomerFields.companyName ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.companyName ? 'not-allowed' : 'text'
                }}
              />
            </div>
            <div className="field-group">
              <label htmlFor="projectId">
                Project ID <b>*</b>
              </label>
              <ProjectIdAutocomplete
                value={quotationDetails.projectId}
                onChange={(val) => setQuotationDetails((prev) => ({ ...prev, projectId: val }))}
                onSelectProject={(pid, fullData) => handleProjectLookup(pid, fullData)}
                placeholder="Search or select Project ID..."
                autoLinkMsg={projectAutoLinkMsg}
              />
              {errors.projectId && <div className="field-hint error">{errors.projectId}</div>}
            </div>
            <div className="field-group full-width">
              <label htmlFor="address">Address</label>
              <textarea
                id="address"
                name="address"
                rows="3"
                style={{
                  minHeight: '72px',
                  lineHeight: '1.45',
                  fontSize: '13.5px',
                  padding: '8px 12px',
                  resize: 'vertical',
                  width: '100%',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontFamily: 'inherit',
                  background: !isAdmin() && lockedCustomerFields.address ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.address ? 'not-allowed' : 'text'
                }}
                value={customerDetails.address}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.address}
                placeholder="Complete company / plant delivery address"
              />
            </div>
            <div className="field-group">
              <label htmlFor="contactNumber">Contact Number</label>
              <input
                id="contactNumber"
                name="contactNumber"
                type="text"
                value={customerDetails.contactNumber}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.contactNumber}
                style={{
                  background: !isAdmin() && lockedCustomerFields.contactNumber ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.contactNumber ? 'not-allowed' : 'text'
                }}
              />
            </div>
            <div className="field-group">
              <label htmlFor="customerEmail">Email</label>
              <input
                id="customerEmail"
                name="email"
                type="email"
                value={customerDetails.email}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.email}
                style={{
                  background: !isAdmin() && lockedCustomerFields.email ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.email ? 'not-allowed' : 'text'
                }}
              />
            </div>
            <div className="field-group">
              <label htmlFor="gstNumber">GST Number</label>
              <input
                id="gstNumber"
                name="gstNumber"
                type="text"
                value={customerDetails.gstNumber}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.gstNumber}
                style={{
                  background: !isAdmin() && lockedCustomerFields.gstNumber ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.gstNumber ? 'not-allowed' : 'text'
                }}
              />
            </div>
            <div className="field-group">
              <label htmlFor="customerState">State</label>
              <input
                id="customerState"
                name="state"
                type="text"
                value={customerDetails.state}
                onChange={handleCustomerChange}
                readOnly={!isAdmin() && lockedCustomerFields.state}
                style={{
                  background: !isAdmin() && lockedCustomerFields.state ? '#f1f5f9' : '#ffffff',
                  cursor: !isAdmin() && lockedCustomerFields.state ? 'not-allowed' : 'text'
                }}
              />
            </div>
          </div>
        </div>

        <div className="form-section">
          <div className="section-heading">
            <h3>Quotation Details</h3>
          </div>

          {/* Quotation Template Radio Button Selection */}
          <div
            style={{
              marginBottom: '20px',
              padding: '16px 20px',
              background: !isTemplateConfirmed ? '#fffbeb' : '#f8fafc',
              border: !isTemplateConfirmed ? '2px dashed #f59e0b' : '1px solid #e2e8f0',
              borderRadius: '10px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <label style={{ fontSize: '13.5px', fontWeight: 'bold', color: '#0f172a', margin: 0 }}>
                Quotation Template <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <button
                type="button"
                onClick={() => setShowAddQuotationTemplate(true)}
                style={{
                  fontSize: '12px',
                  color: '#2563eb',
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                + Add New Template
              </button>
            </div>

            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
              {quotationTemplates.map((t) => {
                const isSelected = quotationDetails.quotationTemplate === t.id && isTemplateConfirmed;
                return (
                  <label
                    key={t.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '9px',
                      padding: '9px 18px',
                      borderRadius: '8px',
                      border: isSelected ? '2px solid #2563eb' : '1px solid #cbd5e1',
                      background: isSelected ? '#eff6ff' : '#ffffff',
                      cursor: 'pointer',
                      fontWeight: isSelected ? 'bold' : 'normal',
                      color: isSelected ? '#1d4ed8' : '#334155',
                      boxShadow: isSelected ? '0 2px 4px rgba(37,99,235,0.12)' : 'none',
                      userSelect: 'none'
                    }}
                  >
                    <input
                      type="radio"
                      name="quotationTemplateOption"
                      value={t.id}
                      checked={quotationDetails.quotationTemplate === t.id && isTemplateConfirmed}
                      onChange={() => handleSelectTemplate(t)}
                      style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: '#2563eb' }}
                    />
                    <span style={{ fontSize: '14px' }}>{t.label}</span>
                  </label>
                );
              })}
            </div>

            {isTemplateConfirmed && (
              <div style={{ marginTop: '8px', fontSize: '12.5px', color: '#16a34a', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span>✓ Active Template:</span>
                <span>{quotationTemplates.find(t => t.id === quotationDetails.quotationTemplate)?.label || 'Standard Part'}</span>
              </div>
            )}
            {errors.quotationTemplate && (
              <div style={{ color: '#dc2626', fontSize: '12px', marginTop: '6px', fontWeight: 'bold' }}>
                {errors.quotationTemplate}
              </div>
            )}
          </div>

          <div className="section-grid">
            <div className="field-group">
              <label htmlFor="quotationNumber">Quotation Number</label>
              <input
                id="quotationNumber"
                name="quotationNumber"
                type="text"
                value={quotationDetails.quotationNumber}
                onChange={handleQuotationChange}
              />
            </div>
            <div className="field-group">
              <label htmlFor="quotationDate">Date</label>
              <input
                id="quotationDate"
                name="quotationDate"
                type="date"
                value={quotationDetails.quotationDate}
                onChange={handleQuotationChange}
              />
            </div>
            <div className="field-group">
              <label htmlFor="placeOfSupply">Place of Supply</label>
              <input
                id="placeOfSupply"
                name="placeOfSupply"
                type="text"
                value={quotationDetails.placeOfSupply}
                onChange={handleQuotationChange}
              />
            </div>
            <div className="field-group">
              <label htmlFor="quotationCurrency">Currency</label>
              <select
                id="quotationCurrency"
                name="currency"
                value={currencyCode}
                onChange={handleQuotationChange}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="taxMode">Tax Treatment</label>
              <select
                id="taxMode"
                name="taxMode"
                value={taxMode}
                onChange={handleQuotationChange}
              >
                <option value="intra">CGST + SGST (within state)</option>
                <option value="inter">IGST (inter-state)</option>
                <option value="export">Export / LUT - zero rated</option>
              </select>
            </div>
            {isForeignCurrency(currencyCode) && (
              <div className="field-group">
                <label htmlFor="exchangeRate">Exchange Rate (1 {currencyCode} to INR) *</label>
                <input
                  id="exchangeRate"
                  name="exchangeRate"
                  type="number"
                  min="0"
                  step="0.0001"
                  value={quotationDetails.exchangeRate}
                  onChange={handleQuotationChange}
                  placeholder="e.g. 83.4500"
                />
                {errors.exchangeRate ? (
                  <div className="field-hint error">{errors.exchangeRate}</div>
                ) : (
                  <div className="field-hint">
                    1 {currencyCode} = {quotationDetails.exchangeRate} INR · Grand Total ≈{' '}
                    {money(grandTotalINR, 'INR')}
                  </div>
                )}
              </div>
            )}
            {isForeignCurrency(currencyCode) && (
              <div className="field-group">
                <label htmlFor="rateDate">Rate Date</label>
                <input
                  id="rateDate"
                  name="rateDate"
                  type="date"
                  value={quotationDetails.rateDate}
                  onChange={handleQuotationChange}
                />
              </div>
            )}
          </div>
        </div>

        <div className="form-section">
          <div className="section-heading">
            <h3>Item Details</h3>
          </div>

          {!isTemplateConfirmed && (
            <div style={{ background: '#fffbeb', border: '1px solid #fef08a', color: '#92400e', padding: '12px 16px', borderRadius: '8px', marginBottom: '14px', fontWeight: '500' }}>
              ⚠️ Please select and confirm a Quotation Template above to start adding items.
            </div>
          )}

          {errors.itemsError && <div className="form-error">{errors.itemsError}</div>}

          <div
            className="item-table-wrapper"
            style={{
              opacity: isTemplateConfirmed ? 1 : 0.4,
              pointerEvents: isTemplateConfirmed ? 'auto' : 'none',
              filter: isTemplateConfirmed ? 'none' : 'grayscale(30%)',
              transition: 'opacity 0.2s ease'
            }}
          >
            <table className="item-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>SL.No</th>
                  {getTemplateColumns(quotationDetails.quotationTemplate).map(col => (
                    <th key={col.id} style={{ width: col.width || 'auto' }}>
                      {col.label} {col.id === 'itemName' && <b>*</b>}
                    </th>
                  ))}
                  <th className="action-column">Action</th>
                </tr>
              </thead>
              <tbody>
                {computedItems.map((item, index) => {
                  const itemErrors = errors.items[index] || {};
                  return (
                    <React.Fragment key={index}>
                    <tr className="item-row">
                      <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{index + 1}</td>
                      {getTemplateColumns(quotationDetails.quotationTemplate).map((col) => {
                        if (col.id === 'amount') {
                          return (
                            <td key={col.id}>
                              <input
                                type="text"
                                readOnly
                                value={item.amount ? item.amount.toFixed(2) : '0.00'}
                                style={{ background: '#e5e7eb', cursor: 'not-allowed' }}
                              />
                            </td>
                          );
                        }
                        if (col.id === 'unit') {
                          return (
                            <td key={col.id}>
                              <AddableSelect
                                value={item.unit || 'Nos'}
                                onChange={(event) => handleUnitChange(index, event.target.value)}
                                options={[...DEFAULT_UNITS, ...customUnits]}
                                onCreate={handleCreateUnit}
                                masterType="unit"
                                title="Add Unit of Measurement"
                                addLabel="+ Add New Unit"
                                addNewInOptions
                                selectStyle={{ width: '100%', padding: '12px 8px', borderRadius: '10px', background: '#f9fafb' }}
                              />
                            </td>
                          );
                        }
                        if (col.type === 'textarea') {
                          return (
                            <td key={col.id}>
                              <textarea
                                rows="2"
                                ref={growTextarea}
                                value={item[col.id] || ''}
                                onChange={(event) => {
                                  handleItemFieldChange(index, col.id, event.target.value);
                                  growTextarea(event.currentTarget);
                                }}
                                placeholder={col.label}
                                style={{
                                  width: '100%',
                                  padding: '8px 10px',
                                  border: '1px solid #d1d5db',
                                  borderRadius: '8px',
                                  boxSizing: 'border-box',
                                  minHeight: '44px',
                                  lineHeight: 1.5,
                                  resize: 'none',
                                  overflow: 'hidden',
                                  whiteSpace: 'pre-wrap',
                                  overflowWrap: 'break-word',
                                  wordBreak: 'break-word'
                                }}
                              />
                            </td>
                          );
                        }
                        
                        return (
                          <td key={col.id}>
                            <input
                              type={col.type || 'text'}
                              value={item[col.id] || ''}
                              onChange={(event) => handleItemFieldChange(index, col.id, event.target.value)}
                              placeholder={col.label}
                            />
                            {col.id === 'itemName' && itemErrors.itemName && (
                              <div className="field-hint error">{itemErrors.itemName}</div>
                            )}
                            {col.id === 'quantity' && itemErrors.quantity && (
                              <div className="field-hint error">{itemErrors.quantity}</div>
                            )}
                            {col.id === 'unitPrice' && itemErrors.unitPrice && (
                              <div className="field-hint error">{itemErrors.unitPrice}</div>
                            )}
                            {col.id === 'unitPrice' && item.bomRef && (
                              <div style={{ fontSize: '10.5px', color: '#0f766e', fontWeight: 600, marginTop: '2px' }}>
                                List: {item.bomRef}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="action-column">
                        <button
                          type="button"
                          className="button-secondary button-small button-delete"
                          onClick={() => removeItem(index)}
                          disabled={items.length === 1}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                    {quotationDetails.quotationTemplate === 'machine_equipment' && (
                      <tr className="sub-parts-row">
                        <td className="sub-parts-cell" colSpan={getTemplateColumns(quotationDetails.quotationTemplate).length + 2}>
                          <div className="sub-parts-section">
                            <div className="sub-parts-header">
                              <span className="sub-parts-title">Sub Parts</span>
                              <button
                                type="button"
                                className="button-secondary button-small"
                                onClick={() => addSubPart(index)}
                              >
                                + Add Sub Part
                              </button>
                            </div>
                            {(item.subParts || []).length > 0 ? (
                              <table className="sub-parts-table">
                                <thead>
                                  <tr>
                                    <th className="sp-sl">SL.No</th>
                                    <th className="sp-desc">Sub Part Description</th>
                                    <th className="sp-qty">Quantity</th>
                                    <th className="sp-act">Action</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.subParts.map((subPart, subIndex) => (
                                    <tr key={subIndex}>
                                      <td className="sp-sl">{subIndex + 1}</td>
                                      <td className="sp-desc">
                                        <input
                                          id={`subpart-desc-${index}-${subIndex}`}
                                          type="text"
                                          value={subPart.description || ''}
                                          onChange={(event) => updateSubPart(index, subIndex, 'description', event.target.value)}
                                          placeholder="Sub Part Description"
                                        />
                                      </td>
                                      <td className="sp-qty">
                                        <input
                                          type="number"
                                          min="1"
                                          value={subPart.quantity ?? ''}
                                          onChange={(event) => updateSubPart(index, subIndex, 'quantity', event.target.value)}
                                          placeholder="Quantity"
                                        />
                                      </td>
                                      <td className="sp-act">
                                        <button
                                          type="button"
                                          className="button-secondary button-small"
                                          onClick={() => editSubPart(index, subIndex)}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          className="button-secondary button-small button-delete"
                                          onClick={() => deleteSubPart(index, subIndex)}
                                        >
                                          Delete
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <div className="field-hint">No sub parts added yet. Click "Add Sub Part" to add one.</div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={getTemplateColumns(quotationDetails.quotationTemplate).length + 2}>
                    <button type="button" className="button-secondary button-small" onClick={addItem}>
                      + Add Item
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="tax-summary">
            <div className="tax-summary-row">
              <span>Subtotal ({currencyCode})</span>
              <strong>{money(totals.subtotal, currencyCode)}</strong>
            </div>
            <div className="tax-summary-row">
              <span>Discount</span>
              <div>
                {activeCurrency.symbol}{' '}
                <input
                  type="number"
                  name="discount"
                  value={quotationDetails.discount}
                  onChange={handleQuotationChange}
                  placeholder="0.00"
                  min="0"
                  className="discount-input"
                />
              </div>
            </div>
            <div className="tax-summary-row">
              <span>Taxable Amount</span>
              <strong>{money(totals.taxableAmount, currencyCode)}</strong>
            </div>
            {taxMode === 'inter' && (
              <div className="tax-summary-row">
                <span>IGST</span>
                <strong>{money(totals.igst, currencyCode)}</strong>
              </div>
            )}
            {taxMode === 'intra' && (
              <>
                <div className="tax-summary-row">
                  <span>CGST</span>
                  <strong>{money(totals.cgst, currencyCode)}</strong>
                </div>
                <div className="tax-summary-row">
                  <span>SGST</span>
                  <strong>{money(totals.sgst, currencyCode)}</strong>
                </div>
              </>
            )}
            <div className="tax-summary-row">
              <span>{taxMode === 'export' ? 'GST (zero rated)' : 'Total GST'}</span>
              <strong>{money(totals.totalGST, currencyCode)}</strong>
            </div>
            <div className="tax-summary-row total">
              <span>Grand Total</span>
              <strong>{money(totals.grandTotal, currencyCode)}</strong>
            </div>
            {isForeignCurrency(currencyCode) && (
              <div className="tax-summary-row">
                <span>≈ Value in INR</span>
                <strong>{money(grandTotalINR, 'INR')}</strong>
              </div>
            )}
            <div className="amount-in-words">
              <span>Total Amount in Words</span>
              <p>{amountInWords}</p>
            </div>
          </div>
        </div>

        <div className="form-section">
          <div className="section-heading">
            <h3>Terms and Conditions</h3>
          </div>
          <div className="field-group full-width">
            <div className="template-toolbar" style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
              <div className="template-picker" style={{ position: 'relative' }}>
                <button
                  type="button"
                  id="termsTemplateSelect"
                  className="template-select template-select-button"
                  aria-haspopup="listbox"
                  aria-expanded={isTemplateMenuOpen}
                  onClick={() => setIsTemplateMenuOpen((open) => !open)}
                  style={{ minWidth: '220px', height: '40px', padding: '8px 14px' }}
                >
                  <span>{termsTemplates.find((item) => item.id === selectedTemplateId)?.name || 'Select a template...'}</span>
                  <span className="template-chevron">▾</span>
                </button>

                {isTemplateMenuOpen && (
                  <>
                    <div
                      className="template-menu"
                      role="listbox"
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        marginTop: '6px',
                        width: '230px',
                        background: '#ffffff',
                        border: '1px solid #cbd5e1',
                        borderRadius: '10px',
                        boxShadow: '0 10px 25px rgba(0,0,0,0.12)',
                        zIndex: 999,
                        overflow: 'hidden'
                      }}
                    >
                      {[...termsTemplates].sort((a, b) => a.number - b.number).map((template) => (
                        <div
                          key={template.id}
                          className={`template-option ${selectedTemplateId === template.id ? 'selected' : ''}`}
                          onMouseEnter={() => setHoveredTemplateId(template.id)}
                          onMouseLeave={() => setHoveredTemplateId('')}
                          onClick={() => {
                            applyTermsTemplate(template);
                            setHoveredTemplateId('');
                          }}
                          role="option"
                          aria-selected={selectedTemplateId === template.id}
                          style={{
                            padding: '10px 14px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #f1f5f9',
                            background: selectedTemplateId === template.id ? '#eff6ff' : hoveredTemplateId === template.id ? '#f8fafc' : '#ffffff'
                          }}
                        >
                          <div className="template-option-main">
                            <div style={{ fontWeight: '600', color: '#1e293b', fontSize: '13px' }}>
                              {template.name || `Template ${template.number}`}
                            </div>
                            <span style={{ fontSize: '11px', color: '#64748b' }}>Hover to preview</span>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="template-add-option"
                        onClick={() => {
                          const nextNum = getNextTemplateNumber(termsTemplates);
                          setNewTemplateName(`Template ${nextNum}`);
                          setNewTemplateContent('');
                          setIsAddTemplateOpen(true);
                          setIsTemplateMenuOpen(false);
                          setHoveredTemplateId('');
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 14px',
                          textAlign: 'left',
                          background: '#f8fafc',
                          border: 'none',
                          borderTop: '1px solid #e2e8f0',
                          color: '#2563eb',
                          fontWeight: '600',
                          cursor: 'pointer',
                          fontSize: '13px'
                        }}
                      >
                        <span className="restored-emoji-icon">＋</span> Add Template
                      </button>
                    </div>

                    {/* Side-by-Side Floating Template Preview Box */}
                    {hoveredTemplateId && (() => {
                      const activeTpl = termsTemplates.find((t) => t.id === hoveredTemplateId);
                      if (!activeTpl) return null;
                      return (
                        <div
                          style={{
                            position: 'absolute',
                            left: '240px',
                            top: '100%',
                            marginTop: '6px',
                            width: '380px',
                            background: '#ffffff',
                            border: '1px solid #cbd5e1',
                            borderRadius: '10px',
                            boxShadow: '0 12px 30px rgba(15, 23, 42, 0.2)',
                            padding: '16px',
                            zIndex: 1000,
                            pointerEvents: 'none'
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 'bold',
                              fontSize: '13.5px',
                              color: '#0f172a',
                              borderBottom: '1px solid #e2e8f0',
                              paddingBottom: '8px',
                              marginBottom: '10px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between'
                            }}
                          >
                            <span><FileText size={14} aria-hidden="true" /> {activeTpl.name || `Template ${activeTpl.number}`}</span>
                            <span style={{ fontSize: '11px', color: '#2563eb', background: '#eff6ff', padding: '2px 8px', borderRadius: '10px', fontWeight: 'bold' }}>
                              Content Preview
                            </span>
                          </div>
                          <div style={{ fontSize: '12.5px', color: '#334155', lineHeight: '1.6', whiteSpace: 'pre-line' }}>
                            {activeTpl.content}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>

              <button
                type="button"
                className="button-secondary button-small"
                onClick={saveTermsTemplate}
                style={{ height: '40px', padding: '8px 16px', display: 'inline-flex', alignItems: 'center' }}
              >
                Save as Template
              </button>

              <button
                type="button"
                className="button-secondary button-small button-delete"
                onClick={() => deleteTermsTemplate(selectedTemplateId)}
                disabled={!selectedTemplateId}
                style={{ height: '40px', padding: '8px 16px', display: 'inline-flex', alignItems: 'center' }}
              >
                Delete Template
              </button>
            </div>
            <textarea
              id="termsAndConditions"
              name="termsAndConditions"
              rows="4"
              placeholder="Enter each term on a new line"
              value={quotationDetails.termsAndConditions}
              onChange={handleQuotationChange}
              onKeyDown={handleTermsKeyDown}
            />
            {termsMessage && <div className="field-success no-print">{termsMessage}</div>}
          </div>
          <div className="field-group full-width" style={{ marginTop: '20px' }}>
            <label htmlFor="notes" className="template-label">Notes</label>
            <textarea
              id="notes"
              name="notes"
              rows="3"
              placeholder="Any additional notes..."
              value={quotationDetails.notes}
              onChange={handleQuotationChange}
            />
          </div>
        </div>

        {isAddTemplateOpen && (
          <div className="template-modal-backdrop no-print" onMouseDown={() => setIsAddTemplateOpen(false)}>
            <div className="template-modal" onMouseDown={(event) => event.stopPropagation()}>
              <div className="template-modal-header">
                <div>
                  <h3>Add Terms &amp; Conditions Template</h3>
                  <p>Create a reusable template for future quotations.</p>
                </div>
                <button type="button" className="template-modal-close" onClick={() => setIsAddTemplateOpen(false)} aria-label="Close">×</button>
              </div>
              <div className="template-modal-form">
                <div className="field-group full-width">
                  <label htmlFor="newTemplateName">Template Name</label>
                  <input
                    id="newTemplateName"
                    value={newTemplateName}
                    onChange={(event) => setNewTemplateName(event.target.value)}
                    placeholder="e.g. Standard Payment Terms"
                    autoFocus
                  />
                </div>
                <div className="field-group full-width">
                  <label htmlFor="newTemplateContent">Terms &amp; Conditions</label>
                  <textarea
                    id="newTemplateContent"
                    rows="8"
                    value={newTemplateContent}
                    onChange={(event) => setNewTemplateContent(event.target.value)}
                    placeholder="Enter each condition on a new line"
                  />
                </div>
                <div className="template-modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setIsAddTemplateOpen(false)}
                    style={{
                      background: '#f1f5f9',
                      color: '#334155',
                      border: '1px solid #cbd5e1',
                      padding: '10px 18px',
                      borderRadius: '8px',
                      fontWeight: '600',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={handleAddTemplate}
                    style={{
                      background: '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      padding: '10px 22px',
                      borderRadius: '8px',
                      fontWeight: 'bold',
                      cursor: 'pointer',
                      boxShadow: '0 2px 6px rgba(37, 99, 235, 0.3)'
                    }}
                  >
                    Save Template
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="form-actions quotation-actions no-print">
          <button type="submit" className="button-primary">Save</button>
        </div>
        {statusMessage && <div className="field-success no-print">{statusMessage}</div>}
        {pdfMessage && <div className="field-success no-print">{pdfMessage}</div>}
      </form>


      {showAddQuotationTemplate && (
        <div className="template-modal-backdrop no-print" onMouseDown={() => setShowAddQuotationTemplate(false)}>
          <div className="template-modal" style={{ maxWidth: '600px' }} onMouseDown={(event) => event.stopPropagation()}>
            <div className="template-modal-header">
              <div>
                <h3>Add New Template</h3>
                <p>Define a custom quotation template and its fields.</p>
              </div>
              <button type="button" className="template-modal-close" onClick={() => setShowAddQuotationTemplate(false)} aria-label="Close">×</button>
            </div>
            <div className="field-group full-width">
              <label>Template Name <b>*</b></label>
              <input type="text" value={newQuotationTemplateName} onChange={e => setNewQuotationTemplateName(e.target.value)} placeholder="e.g. Custom Services" />
            </div>
            <div className="field-group full-width" style={{ marginTop: '15px' }}>
              <label>Additional Fields (Item Name, Qty, Unit, Price, GST, Amount are included by default)</label>
              {newQuotationTemplateFields.map((field, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                  <input type="text" style={{ flex: 1 }} value={field.label} onChange={e => handleQuotationTemplateFieldChange(idx, 'label', e.target.value)} placeholder="Field Label (e.g. Material)" />
                  <select style={{ width: '120px' }} value={field.type} onChange={e => handleQuotationTemplateFieldChange(idx, 'type', e.target.value)}>
                    <option value="text">Short Text</option>
                    <option value="textarea">Long Text</option>
                  </select>
                  <button type="button" className="button-secondary button-small" onClick={() => handleRemoveQuotationTemplateField(idx)}>Remove</button>
                </div>
              ))}
              <button type="button" className="button-secondary button-small" onClick={handleAddQuotationTemplateField}>+ Add Field</button>
            </div>
            <div className="template-modal-actions" style={{ marginTop: '20px' }}>
              <button type="button" className="button-secondary" onClick={() => setShowAddQuotationTemplate(false)}>Cancel</button>
              <button type="button" className="button-primary" onClick={handleSaveQuotationTemplate}>Save Template</button>
            </div>
          </div>
        </div>
      )}

      {/* Template Confirmation Popup Modal */}
      {templateConfirmModal && (
        <div className="template-modal-backdrop" style={{ zIndex: 99999 }}>
          <div
            className="template-modal"
            style={{
              maxWidth: '420px',
              padding: '28px 24px',
              textAlign: 'center',
              borderRadius: '12px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.25)',
              background: '#ffffff'
            }}
          >
            <div className="restored-emoji-icon" style={{ fontSize: '42px', marginBottom: '12px' }}>📋</div>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', color: '#0f172a', fontWeight: 'bold' }}>
              Template Selected
            </h3>
            <p style={{ margin: '0 0 24px 0', fontSize: '15px', color: '#334155', lineHeight: '1.5' }}>
              You have chosen <strong>"{templateConfirmModal.label}"</strong> template.
            </p>
            <button
              type="button"
              className="button-primary"
              style={{
                width: '100%',
                padding: '11px 0',
                fontSize: '15px',
                fontWeight: 'bold',
                borderRadius: '8px',
                background: '#2563eb',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer'
              }}
              onClick={() => handleConfirmTemplate(templateConfirmModal)}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default QuotationForm;

