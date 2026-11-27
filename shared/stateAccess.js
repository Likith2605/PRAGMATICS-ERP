const RULES = [
  [/^employees$/i, { adminOnly: true }],
  [/^(companySettings|customerDirectory|customerMaster|vendorMaster|vendorMasterSequence|supplierMaster|machines)$/i, { adminOnly: true }],
  [/^rolePermissions$/i, { adminOnly: true }],
  [/^(erpSession|erpUsers|event_tracker_.*|qc_server_settings|erp_record_delete_reasons|erp_state_action_reasons)$/i, { adminOnly: true }],
  [/^(customerAdvanceHistory|supplierAdvanceHistory|soMaterialAvailabilityChecks)$/i, { adminOnly: true }],
  [/^(companySettings|companyProfile)$/i, { read: ['project.view'], write: ['settings.view'] }],
  [/^(notifications|notificationsSeq)$/i, { read: ['project.view'], write: ['project.view'] }],
  [/^customQuotationTemplates$/i, { read: ['sales.quotation'], write: ['sales.quotation'] }],
  [/^(salesOrders|salesOrderHistory|customerPOHistory)$/i, { read: ['sales_order.view','store.module'], write: ['sales_order.view'] }],
  [/^(soMaterialAvailabilityChecks)$/i, { read: ['sales_order.view','store.module'], write: ['store.module'] }],
  [/^(purchaseOrders|supplierPOHistory|poTermsTemplates|termsAndConditionsTemplates|termsTemplates)$/i, { read: ['purchase.order','receipt.view'], write: ['purchase.order'] }],
  [/^(materialReceipts|materialReceiptSequence|materialArrivals|replacementReceiptSequence|internalReceiptBatchSequence)$/i, { read: ['receipt.view'], write: ['receipt.create','arrival.create'] }],
  [/^(vendorMaster|vendorMasterSequence)$/i, { read: ['purchase.order','purchase_request.view','store.module'], write: ['purchase.order','purchase_request.create'] }],
  [/^(vendorEnquiries|vendorQuotations|vendorEnquiryTermsTemplates)$/i, { read: ['purchase_request.view'], write: ['purchase_request.create','purchase.order'] }],
  [/^(productionRequirements|productionRequirementSequence|productionRequirementsSequence|boms)$/i, { read: ['production.requirement.manage','production.view','store.module'], write: ['production.requirement.manage','store.module'] }],
  [/^(qualityChecks|qualityCheckSequence)$/i, { read: ['production.qc.view','receipt.view'], write: ['production.qc.manage'] }],
  [/^(customInventoryCategories|customUnits|deletedDefaultUnits|inventorySeedVersion|storeDashboardSeen|employeeIssueSequence)$/i, { read: ['store.module','inventory.view'], write: ['inventory.adjust','store.module'] }],
  [/^(exportCompanyProfile|exportInvoiceHistory|customerInvoiceHistory)$/i, { read: ['invoice.view'], write: ['invoice.view'] }],
  [/^(deliveryChallanHistory)$/i, { read: ['delivery.view'], write: ['delivery.create'] }],
  [/^(storeAuditLog|storeIssueHistory|materialReturnHistory|storePurchaseRequests)$/i, { read: ['store.audit.view','material_issue.view','material_return.view','purchase_request.view'], write: ['store.module','material_issue.create','material_return.create','purchase_request.create'] }],
  [/^(projectRequests|projectRequest)/i, { read: ['sales.enquiry','job_card.view'], write: ['sales.enquiry','job_card.create'] }],
  [/^(salesOrderHistory|salesOrders|quotations|quotationHistory|quotationSequence|customerPurchaseOrders|customerInvoices|exportInvoices|deliveryChallans|customerDirectory|customerMaster|customers|enquiries|vendorEnquiries|vendorQuotations)/i, { read: ['sales.enquiry','sales.quotation','sales_order.view','invoice.view','delivery.view'], write: ['sales.enquiry','sales.quotation','sales.customer_order','delivery.create'] }],
  [/^(purchaseOrders|purchaseIndents|purchaseIndent|purchaseRequests|storePurchaseRequests|vendorMaster|vendorSupplier|supplierInvoice|supplierInvoices|supplierPOHistory|purchaseRequest)/i, { read: ['purchase.order','purchase_request.view','indent.view','receipt.view'], write: ['purchase.order','purchase_request.create','purchase_request.approve','indent.create','indent.edit','indent.submit','indent.review','indent.convert'] }],
  [/^(materialReceipts|materialReceipt|materialArrivals|arrival|replacementReceipt|rejectionReports|debitNotes|htOutsource)/i, { read: ['receipt.view','rejection.view','debitnote.view','ht_outsource.view'], write: ['receipt.create','arrival.create','rejection.forward','debitnote.create','ht_outsource.create','ht_outsource.purchase_action','ht_outsource.store_action'] }],
  [/^(production|productionJobCards|productionRequirements|productionDispatchRequests|jobCards|jobCard|quality|qualityChecks|qualityReport|ballooning|machines|bom)/i, { read: ['production.view','production.requirement.manage','job_card.view','production.qc.view','ballooning.view'], write: ['production.entry.create','production.requirement.manage','job_card.create','job_card.update_progress','job_card.dispatch_request','production.qc.manage','ballooning.manage','settings.view'] }],
  [/^(inventory|stock|store|materialRequests|materialRequest|materialReturn|storeIssue|storeReturn|employeeIssue|storeGRN|stockTransfer|stockVerification|inventoryBatches)/i, { read: ['store.module','inventory.view','inventory.transaction.view','material_issue.view','material_return.view'], write: ['inventory.adjust','material_request.create','material_request.edit','material_issue.create','material_issue.confirm','material_return.create','purchase_request.create','receipt.create'] }],
  [/^(vendor|supplier)/i, { read: ['purchase.order','purchase_request.view'], write: ['purchase.order','purchase_request.approve'] }],
  [/^(customer|sales|quotation|delivery|project)/i, { read: ['sales.enquiry','sales.quotation','sales_order.view','project.view'], write: ['sales.enquiry','sales.quotation','sales.customer_order','delivery.create'] }],
  [/^(purchase|indent|receipt|arrival|debitNote|rejection)/i, { read: ['purchase.order','indent.view','receipt.view','debitnote.view','rejection.view'], write: ['purchase.order','indent.create','indent.edit','indent.submit','indent.review','indent.convert','receipt.create','arrival.create','debitnote.create','rejection.forward'] }],
  [/^(qc|quality|balloon)/i, { read: ['production.qc.view','ballooning.view'], write: ['production.qc.manage','ballooning.manage'] }]
];

export const statePermissionsForKey = (rawKey) => {
  const key = String(rawKey || '').replace(/Sequence$/i, '');
  return RULES.find(([pattern]) => pattern.test(key))?.[1] || null;
};

export const canAccessStateKey = (rawKey, hasPermission, mode = 'read') => {
  const rule = statePermissionsForKey(rawKey);
  if (!rule || rule.adminOnly) return false;
  const required = mode === 'write' ? rule.write : rule.read;
  return Boolean(required?.some(hasPermission));
};
