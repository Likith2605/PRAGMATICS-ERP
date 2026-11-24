import assert from 'node:assert/strict';
import { getIndentReferenceDetails } from '../src/utils/indentReferenceDetails.js';

const project = getIndentReferenceDetails({
  indentNumber: 'IND-PROJECT-TEST', sourceType: 'salesOrder', soNumber: 'SO-100',
  projectId: 'PROJECT-100', createdBy: 'Project Requester', indentDate: '2026-10-02',
  requiredDate: 'must not display', partName: 'must not display'
});
assert.deepEqual(project, {
  prNumber: 'IND-PROJECT-TEST', origin: 'Sales Order',
  requestedBy: 'Project Requester', indentDate: '2026-10-02'
});

console.log('Vendor Enquiry PR reference fields OK for project-based indents.');
