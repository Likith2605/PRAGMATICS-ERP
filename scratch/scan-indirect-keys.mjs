import fs from 'node:fs';

const storeService = fs.readFileSync('src/utils/storeService.js', 'utf8');
const workflowService = fs.readFileSync('src/utils/workflowService.js', 'utf8');
const vendorMaster = fs.readFileSync('src/utils/vendorMaster.js', 'utf8');
const exportInvoice = fs.readFileSync('src/utils/exportInvoiceService.js', 'utf8');

console.log('--- Checking keys in storeService.js LS and constants ---');
const lsMatch = storeService.match(/const LS = \{([^}]+)\}/);
if (lsMatch) {
  console.log('LS object:', lsMatch[1].split('\n').map(l => l.trim()).filter(Boolean));
}

const wfMatch = workflowService.match(/const WF = \{([^}]+)\}/);
if (wfMatch) {
  console.log('WF object:', wfMatch[1].split('\n').map(l => l.trim()).filter(Boolean));
}

const vmMatches = vendorMaster.match(/_KEY\s*=\s*['"`]([^'"`]+)['"`]/g);
console.log('vendorMaster keys:', vmMatches);

const eiMatches = exportInvoice.match(/KEY\s*=\s*['"`]([^'"`]+)['"`]/g);
console.log('exportInvoice keys:', eiMatches);
