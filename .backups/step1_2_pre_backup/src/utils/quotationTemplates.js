export const DEFAULT_QUOTATION_TEMPLATES = [
  {
    id: 'standard_part',
    label: 'Standard Part',
    columns: [
      { id: 'drawingNo', label: 'Drawing No.', type: 'text', width: '130px' },
      { id: 'itemName', label: 'Item Description', type: 'text', main: true, width: '260px' }
    ]
  },
  {
    id: 'machine_equipment',
    label: 'Machine / Equipment',
    columns: [
      { id: 'itemName', label: 'Drawing Number', type: 'text', main: true, width: '200px' },
      { id: 'description', label: 'Description', type: 'textarea', secondary: true, width: '340px' },
      { id: 'techSpecs', label: 'Tech Specs', type: 'textarea', secondary: true, width: '200px' },
      { id: 'scope', label: 'Scope of Supply', type: 'textarea', secondary: true, width: '180px' },
    ]
  }
];

export const COMMON_COLUMNS = [
  { id: 'hsnSac', label: 'HSN/SAC', type: 'text', width: '110px' },
  { id: 'quantity', label: 'Qty', type: 'number', width: '90px' },
  { id: 'unit', label: 'Unit', type: 'select', width: '110px' },
  { id: 'unitPrice', label: 'Price', type: 'number', width: '125px' },
  { id: 'gst', label: 'GST%', type: 'number', width: '85px' },
  { id: 'amount', label: 'Amount', type: 'readonly', width: '140px' }
];

export const getQuotationTemplates = () => {
  try {
    const custom = JSON.parse(localStorage.getItem('customQuotationTemplates')) || [];
    return [...DEFAULT_QUOTATION_TEMPLATES, ...custom];
  } catch (e) {
    return DEFAULT_QUOTATION_TEMPLATES;
  }
};

export const getTemplateColumns = (templateId) => {
  const templates = getQuotationTemplates();
  const template = templates.find(t => t.id === templateId) || templates[0];
  return [...template.columns, ...COMMON_COLUMNS];
};
