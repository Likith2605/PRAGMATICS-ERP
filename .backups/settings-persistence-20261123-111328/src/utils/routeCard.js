export const ROUTE_CARD_DEFAULTS = {
  docNo: 'F/PROD/02',
  revNo: '00'
};

export const STANDARD_PROCESSES = [
  'Turning / Facing (CNC / Lathe)',
  'Milling (VMC)',
  'Surface Grinding',
  'Cylindrical Grinding',
  'Drilling / Reaming / Tapping',
  'Wire Cutting / Sparking (EDM)',
  'Deburring / Chamfering',
  'Heat Treatment',
  'Surface Treatment / Coating / Plating',
  'In-Process Inspection',
  'Final Inspection & Packing'
];

export const PROCESS_HEADERS = [
  'Process',
  'Machine Name',
  'Input QTY',
  'Output QTY',
  'Rework QTY',
  'Reject QTY',
  'Start Date & Time',
  'End Date & Time',
  'Operator / Inspector',
  'Status'
];

let processSeq = 0;

export const emptyProcess = () => {
  processSeq += 1;
  return {
    id: `rc-p-${Date.now()}-${processSeq}`,
    process: '',
    machineId: '',
    machineNo: '',
    inputQty: '',
    outputQty: '',
    reworkQty: '-',
    rejectQty: '-',
    startTime: '',
    endTime: '',
    operator: '',
    status: 'Pending'
  };
};

export const defaultProcesses = () => [emptyProcess()];

const mk = (v, fallback = '') => (v === undefined || v === null ? fallback : v);

export const normalizeRouteCard = (jc = {}) => {
  const rm = jc.rawMaterial || {};
  const processes = Array.isArray(jc.processes)
    ? jc.processes.map((p, idx) => ({
        ...emptyProcess(),
        ...p,
        status: p.status || 'Pending',
        id: p.id || `rc-legacy-${idx}-${Date.now()}`
      }))
    : defaultProcesses();

  const lotQty = mk(jc.lotQty, mk(jc.orderQuantity, ''));

  return {
    ...jc,
    poNo: mk(jc.poNo, ''),
    partName: mk(jc.partName, ''),
    drawingRev: mk(jc.drawingRev, ''),
    customer: mk(jc.customerName || jc.customer, ''),
    invNo: mk(jc.invNo, ''),
    partNumber: mk(jc.partNumber, ''),
    lotQty,
    material: mk(jc.material || rm.grade || '', ''),
    materialCertNo: mk(jc.materialCertNo, ''),
    docNo: mk(jc.docNo, ROUTE_CARD_DEFAULTS.docNo),
    revNo: mk(jc.revNo, ROUTE_CARD_DEFAULTS.revNo),
    docDate: mk(jc.docDate, mk(jc.startDate, new Date().toISOString().slice(0, 10))),
    processes
  };
};

export const formatDateDMY = (iso) => {
  if (!iso) return '';
  const str = String(iso);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};

export const toDateTimeLocalValue = (val) => {
  if (!val) return '';
  const str = String(val).trim();
  if (!str) return '';
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) {
    return `${m[1]}T${m[2]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return `${str}T00:00`;
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  }
  return '';
};

export const formatDateTimeDMY = (val) => {
  if (!val) return '-';
  const str = String(val).trim();
  if (!str) return '-';
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/);
  if (m) {
    const [, yyyy, mm, dd, time] = m;
    return `${dd}-${mm}-${yyyy} ${time}`;
  }
  const dMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    return `${dMatch[3]}-${dMatch[2]}-${dMatch[1]}`;
  }
  return str;
};

export const routeCardBlank = (partial = {}) => ({
  poNo: '',
  invNo: '',
  partNumber: '',
  drawingRev: '',
  lotQty: '',
  material: '',
  materialCertNo: '',
  docNo: ROUTE_CARD_DEFAULTS.docNo,
  revNo: ROUTE_CARD_DEFAULTS.revNo,
  docDate: new Date().toISOString().slice(0, 10),
  processes: defaultProcesses(),
  ...partial
});