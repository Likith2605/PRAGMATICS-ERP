import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const autoTableModule = require('jspdf-autotable');
const autoTable = autoTableModule.default || autoTableModule;

export default (...args) => autoTable(...args);
