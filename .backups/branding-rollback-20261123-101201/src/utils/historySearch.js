const normalise = (value) => String(value ?? '').toLocaleLowerCase();

export const filterProjectRequests = (projects = [], query = '') => {
  const needle = normalise(query).trim();
  if (!needle) return projects;
  return projects.filter((project) => {
    const fields = [
      project.projectId, project.enquiryNumber, project.customerName, project.contactPerson,
      project.contactName, project.customerContact, project.attention, project.contact,
      project.customerDetails?.contactPerson, project.companyName,
      project.phone, project.phoneNumber, project.mobile, project.email, project.emailAddress,
      project.projectName, project.name, project.title,
      ...(project.items || []).map((item) => item.drawingNo)
    ];
    return fields.filter(Boolean).map(normalise).join(' ').includes(needle);
  });
};

export const filterQuotationHistory = (history = [], query = '') => {
  const needle = normalise(query).trim();
  if (!needle) return history;
  return history.filter((transaction) => {
    const payload = transaction.payload || {};
    const fields = [
      transaction.reference,
      transaction.projectId || payload.quotationDetails?.projectId,
      transaction.company || payload.customerDetails?.companyName,
      transaction.customerName || payload.customerDetails?.customerName,
      transaction.date || payload.quotationDetails?.quotationDate || payload.quotationDetails?.date
    ];
    return fields.filter(Boolean).map(normalise).join(' ').includes(needle);
  });
};

export const filterSalesOrderHistory = (history = [], query = '') => {
  const needle = normalise(query).trim();
  if (!needle) return history;
  return history.filter((order) => {
    const payload = order.payload || {};
    const fields = [
      order.reference || payload.soDetails?.soNumber,
      order.quotationRef || payload.soDetails?.quotationRef,
      payload.customerDetails?.customerName,
      order.company || payload.customerDetails?.companyName,
      payload.soDetails?.projectId,
      order.date || payload.soDetails?.soDate
    ];
    return fields.filter(Boolean).map(normalise).join(' ').includes(needle);
  });
};

export const filterVendorPurchaseOrders = (rows = [], query = '') => {
  const needle = normalise(query).trim();
  if (!needle) return rows;
  return rows.filter(({ po = {}, progress = {} }) => {
    const payload = po.payload || {};
    const fields = [
      po.reference,
      po.vendor || payload.vendorDetails?.companyName || payload.vendorDetails?.vendorName,
      payload.poDetails?.salesOrderRef || payload.poDetails?.soNumber,
      ...(progress.lines || []).map((line) => line.materialName),
      po.date || payload.poDetails?.poDate,
      progress.computedStatus || po.status
    ];
    return fields.filter(Boolean).map(normalise).join(' ').includes(needle);
  });
};

export const filterBallooningProjects = (projects = [], query = '') => {
  const needle = normalise(query).trim();
  if (!needle) return projects;
  return projects.filter((project) => [
    project.projectNumber, project.projectId, project.customerName,
    project.partNumber, project.partName, project.drawingNumber,
    project.revision, project.status, project.createdBy
  ].filter(Boolean).map(normalise).join(' ').includes(needle));
};

export const filterMaterialRecords = (records = [], query = '', fields = []) => {
  const needle = normalise(query).trim();
  if (!needle) return records;
  return records.filter((record) => fields.flatMap((field) => {
    const value = typeof field === 'function' ? field(record) : record?.[field];
    return Array.isArray(value) ? value : [value];
  }).filter((value) => value != null).map(normalise).join(' ').includes(needle));
};

export const filterDebitCandidates = (records = [], query = '') => filterMaterialRecords(records, query, [
  (r) => r.rejection?.rejectionNumber, (r) => r.rejection?.rejectionDate,
  (r) => r.rejection?.poNumber, (r) => r.rejection?.qcNumber,
  (r) => r.receipt?.receiptNumber, (r) => r.vendor, (r) => r.status
]);
