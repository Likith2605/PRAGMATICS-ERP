export const getIndentReferenceDetails = (indent = {}) => ({
  prNumber: indent.indentNumber || '',
  origin: indent.sourceLabel || (indent.requirementNumber ? 'Production Requirement' : indent.soNumber ? 'Sales Order' : 'Purchase Indent'),
  requestedBy: indent.requestedBy || indent.createdBy || '',
  indentDate: indent.indentDate || ''
});
