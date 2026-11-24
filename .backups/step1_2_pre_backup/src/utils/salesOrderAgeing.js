import { normalizeReportDate } from './reportFilters.js';

const text = (value) => String(value ?? '').trim();
const reference = (value) => text(value);
const number = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const codeOf = (line) => text(line?.itemCode || line?.materialCode);
const nameOf = (line) => text(line?.itemName || line?.materialName);
const unitOf = (line) => text(line?.unit);
const lineIdOf = (line) => text(line?.lineId || line?.salesOrderLineId || line?.salesOrderItemId || line?.orderLineId);
const soAliasesOf = (so) => [...new Set([
  so?.reference, so?.payload?.soDetails?.soNumber, so?.soNumber, so?.salesOrderId, so?.id, so?._id
].map(reference).filter(Boolean))];
const soRefOf = (so) => soAliasesOf(so)[0] || '';
const challanRefOf = (dc) => reference(dc?.salesOrderId || dc?.payload?.dcDetails?.salesOrderId || dc?.dcDetails?.salesOrderId || dc?.salesOrderRef || dc?.payload?.dcDetails?.salesOrderRef || dc?.dcDetails?.salesOrderRef);
const challanNumberOf = (dc) => reference(dc?.reference || dc?.payload?.dcDetails?.dcNumber || dc?.dcDetails?.dcNumber);
const challanStatusOf = (dc) => text(dc?.status || dc?.payload?.dcDetails?.challanStatus || dc?.dcDetails?.challanStatus || 'Dispatched');
const challanItemsOf = (dc) => Array.isArray(dc?.payload?.items) ? dc.payload.items : Array.isArray(dc?.items) ? dc.items : [];

const identityMatches = (orderLine, deliveryLine) => {
  const orderCode = codeOf(orderLine);
  const deliveryCode = codeOf(deliveryLine);
  if (orderCode && deliveryCode) return orderCode === deliveryCode;
  const orderName = nameOf(orderLine);
  const deliveryName = nameOf(deliveryLine);
  return Boolean(orderName && deliveryName && orderName === deliveryName);
};

const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
const itemLabel = (line) => codeOf(line) || nameOf(line) || 'Item not identified';

/**
 * Reconciles outbound challan lines to saved sales order lines without project
 * fallbacks, UOM conversion, or quantity clamping. It is a read-only projection.
 */
export const calculateSalesOrderAgeing = (salesOrders = [], challans = []) => {
  const exceptions = [];
  const ordersByRef = new Map();
  salesOrders.forEach((so) => {
    soAliasesOf(so).forEach((ref) => {
      const matches = ordersByRef.get(ref) || [];
      matches.push(so);
      ordersByRef.set(ref, matches);
    });
  });

  const rowsByRef = new Map();
  const rowsByAlias = new Map();
  const rows = salesOrders.map((so, index) => {
    const soNumber = soRefOf(so) || `Unnumbered order ${index + 1}`;
    const orderLines = Array.isArray(so?.payload?.items) ? so.payload.items : Array.isArray(so?.items) ? so.items : [];
    const orderedByUnit = new Map();
    const deliveredByUnit = new Map();
    const orderGroups = new Map();
    const uncertainUnits = new Set();
    const rowExceptions = [];

    orderLines.forEach((line) => {
      const qty = number(line?.quantity);
      const unit = unitOf(line);
      if (qty === null) {
        rowExceptions.push({ challan: '', item: itemLabel(line), unit: unit || 'Unit not recorded', quantity: text(line?.quantity), reason: 'Sales Order line has an invalid quantity.' });
        return;
      }
      if (!unit) {
        rowExceptions.push({ challan: '', item: itemLabel(line), unit: 'Unit not recorded', quantity: qty, reason: 'Sales Order line has no recorded UOM; quantity is not included in totals.' });
        return;
      }
      add(orderedByUnit, unit, qty);
      const identity = codeOf(line) ? `code:${codeOf(line)}` : nameOf(line) ? `name:${nameOf(line)}` : '';
      if (!identity) {
        rowExceptions.push({ challan: '', item: itemLabel(line), unit, quantity: qty, reason: 'Sales Order line has no reliable item identity.' });
        return;
      }
      const key = `${identity}\u0000${unit}`;
      const group = orderGroups.get(key) || { identity, unit, quantity: 0, lines: [] };
      group.quantity += qty;
      group.lines.push(line);
      orderGroups.set(key, group);
    });

    const rawAmountINR = so?.amountINR ?? so?.payload?.amountINR;
    const amountINR = Number(rawAmountINR);
    const hasINRValue = rawAmountINR !== null && rawAmountINR !== undefined && rawAmountINR !== '' && Number.isFinite(amountINR);
    const orderValue = hasINRValue ? amountINR : Number(so?.payload?.totals?.grandTotal) || 0;
    const row = {
      soNumber,
      customerName: so?.company || so?.payload?.customerDetails?.companyName || so?.payload?.customerDetails?.customerName || '-',
      projectId: so?.payload?.soDetails?.projectId || '-',
      orderDate: so?.date || so?.payload?.soDetails?.soDate || '',
      salesOrderAliases: soAliasesOf(so),
      orderValue,
      orderValueCurrency: hasINRValue ? 'INR' : text(so?.payload?.soDetails?.currency || so?.currency) || 'INR',
      orderedByUnit,
      deliveredByUnit,
      pendingByUnit: new Map(),
      overDeliveredByUnit: new Map(),
      uncertainUnits,
      exceptions: rowExceptions,
      allocationStatus: '',
      orderStatus: so?.status || so?.payload?.soDetails?.orderStatus || 'Confirmed',
      ageDays: 0,
      ageingBucket: ''
    };
    rowExceptions.forEach((exception) => exceptions.push({ ...exception, challan: '', salesOrderRef: soNumber }));
    const rowEntry = { row, orderGroups, source: so };
    if (!rowsByRef.has(soNumber)) rowsByRef.set(soNumber, []);
    rowsByRef.get(soNumber).push(rowEntry);
    soAliasesOf(so).forEach((alias) => {
      const aliases = rowsByAlias.get(alias) || [];
      aliases.push(rowEntry);
      rowsByAlias.set(alias, aliases);
    });
    return row;
  });

  const challanGroups = new Map();
  challans.forEach((dc, index) => {
    const key = challanNumberOf(dc);
    if (!key) {
      const salesOrderRef = challanRefOf(dc);
      const targets = salesOrderRef ? rowsByAlias.get(salesOrderRef) || [] : [];
      const lines = challanItemsOf(dc);
      const reason = 'Delivery Challan has no recorded unique reference; it was not allocated.';
      const exceptionRows = lines.length ? lines : [null];
      exceptionRows.forEach((line) => {
        exceptions.push({ challan: `Challan row ${index + 1}`, salesOrderRef, item: line ? itemLabel(line) : '', unit: line ? unitOf(line) || 'Unit not recorded' : '', quantity: line ? number(line.quantity) ?? text(line.quantity) : '', reason });
        if (targets.length === 1) {
          const { row, orderGroups } = targets[0];
          const matching = line ? [...orderGroups.values()].filter((entry) => identityMatches(entry.lines[0], line)) : [];
          if (matching.length) matching.forEach((entry) => row.uncertainUnits.add(entry.unit));
          else if (!line || (!codeOf(line) && !nameOf(line))) orderGroups.forEach(({ unit }) => row.uncertainUnits.add(unit));
        } else if (targets.length > 1) {
          targets.forEach(({ row, orderGroups }) => orderGroups.forEach(({ unit }) => row.uncertainUnits.add(unit)));
        } else if (!salesOrderRef && line) {
          rows.forEach((row) => {
            const matching = rowsByRef.get(row.soNumber)?.flatMap(({ orderGroups }) => [...orderGroups.values()].filter((entry) => identityMatches(entry.lines[0], line)));
            if (matching?.length) matching.forEach((entry) => row.uncertainUnits.add(entry.unit));
            else if (!codeOf(line) && !nameOf(line)) row.orderedByUnit.forEach((_, unit) => row.uncertainUnits.add(unit));
          });
        } else if (!salesOrderRef) {
          rows.forEach((row) => row.orderedByUnit.forEach((_, unit) => row.uncertainUnits.add(unit)));
        }
      });
      return;
    }
    const group = challanGroups.get(key) || [];
    group.push(dc);
    challanGroups.set(key, group);
  });
  challanGroups.forEach((group, challanNumber) => {
    if (group.length > 1) {
      const candidateRefs = [...new Set(group.map(challanRefOf).filter(Boolean))];
      const salesOrderRef = candidateRefs.length === 1 ? candidateRefs[0] : '';
      const exception = { challan: challanNumber, salesOrderRef, item: '', unit: '', quantity: '', reason: 'Duplicate challan reference; all copies were excluded to prevent double counting.' };
      exceptions.push(exception);
      candidateRefs.forEach((candidateRef) => {
        if (!rowsByAlias.has(candidateRef)) return;
        rowsByAlias.get(candidateRef).forEach(({ row, orderGroups }) => {
          orderGroups.forEach(({ unit }) => row.uncertainUnits.add(unit));
          row.exceptions.push(exception);
        });
      });
      return;
    }

    const dc = group[0];
    const salesOrderRef = challanRefOf(dc);
    if (!salesOrderRef) {
      const lines = challanItemsOf(dc);
      if (!lines.length) exceptions.push({ challan: challanNumber, salesOrderRef: '', item: '', unit: '', quantity: '', reason: 'Missing Sales Order reference and no identifiable challan lines.' });
      lines.forEach((line) => {
        const exception = { challan: challanNumber, salesOrderRef: '', item: itemLabel(line), unit: unitOf(line) || 'Unit not recorded', quantity: number(line?.quantity) ?? text(line?.quantity), reason: 'Missing Sales Order reference; delivery was not allocated.' };
        exceptions.push(exception);
        rows.forEach((row) => {
          const matchingUnits = row.soNumber ? rowsByRef.get(row.soNumber)?.flatMap(({ orderGroups }) => [...orderGroups.values()].filter((entry) => identityMatches(entry.lines[0], line)).map((entry) => entry.unit)) || [] : [];
          if (matchingUnits.length) matchingUnits.forEach((unit) => row.uncertainUnits.add(unit));
          else if (!codeOf(line) && !nameOf(line)) row.orderedByUnit.forEach((_, unit) => row.uncertainUnits.add(unit));
        });
      });
      return;
    }

    const orderMatches = ordersByRef.get(salesOrderRef) || [];
    if (orderMatches.length !== 1) {
      const exception = { challan: challanNumber, salesOrderRef, item: '', unit: '', quantity: '', reason: orderMatches.length ? 'Sales Order reference is duplicated; allocation is ambiguous.' : 'Sales Order reference does not match a recorded Sales Order.' };
      exceptions.push(exception);
      if (orderMatches.length > 1) rowsByAlias.get(salesOrderRef)?.forEach(({ row, orderGroups }) => {
        orderGroups.forEach(({ unit }) => row.uncertainUnits.add(unit));
        row.exceptions.push(exception);
      });
      return;
    }

    const row = rowsByAlias.get(salesOrderRef)?.[0]?.row;
    const orderGroups = rowsByAlias.get(salesOrderRef)?.[0]?.orderGroups;
    const status = challanStatusOf(dc).toLowerCase();
    if (status === 'returned') {
      const exception = { challan: challanNumber, salesOrderRef, item: '', unit: '', quantity: '', reason: 'Challan is marked Returned; no reversal quantity/link is recorded, so it was not counted as delivered.' };
      exceptions.push(exception);
      row?.exceptions.push(exception);
      orderGroups?.forEach(({ unit }) => row?.uncertainUnits.add(unit));
      return;
    }
    if (!['dispatched', 'in transit', 'delivered'].includes(status)) {
      const exception = { challan: challanNumber, salesOrderRef, item: '', unit: '', quantity: '', reason: `Unsupported challan status "${challanStatusOf(dc)}"; it was not allocated.` };
      exceptions.push(exception);
      row?.exceptions.push(exception);
      return;
    }

    const lines = challanItemsOf(dc);
    if (!lines.length) {
      const exception = { challan: challanNumber, salesOrderRef, item: '', unit: '', quantity: '', reason: 'Challan contains no item lines.' };
      exceptions.push(exception);
      row?.exceptions.push(exception);
      orderGroups?.forEach(({ unit }) => row?.uncertainUnits.add(unit));
      return;
    }
    lines.forEach((line) => {
      const qty = number(line?.quantity);
      const unit = unitOf(line);
      const itemMatches = [...orderGroups.entries()].filter(([, entry]) => identityMatches(entry.lines[0], line));
      const explicitLineId = lineIdOf(line);
      let exactGroups = itemMatches.filter(([, entry]) => entry.unit === unit);
      let reason = '';
      if (explicitLineId) {
        exactGroups = exactGroups.filter(([, entry]) => entry.lines.some((orderLine) => lineIdOf(orderLine) === explicitLineId));
        if (!exactGroups.length) reason = 'Explicit challan line reference does not resolve to a matching Sales Order line.';
      } else if (!unit) {
        reason = 'Challan line has no recorded UOM.';
      } else if (!itemMatches.length) {
        reason = 'Challan item identity does not match a line on the referenced Sales Order.';
      } else if (!exactGroups.length) {
        reason = 'Challan UOM does not match the referenced Sales Order item UOM.';
      }
      if (qty === null) reason = 'Challan line has an invalid or negative quantity.';
      if (exactGroups.length > 1) reason = 'Challan line matches multiple Sales Order line groups; allocation is ambiguous.';
      if (reason) {
        const exception = { challan: challanNumber, salesOrderRef, item: itemLabel(line), unit: unit || 'Unit not recorded', quantity: qty ?? text(line?.quantity), reason };
        exceptions.push(exception);
        row?.exceptions.push(exception);
        if (itemMatches.length) itemMatches.forEach(([, entry]) => row?.uncertainUnits.add(entry.unit));
        else if (!codeOf(line) && !nameOf(line)) orderGroups?.forEach(({ unit: orderUnit }) => row?.uncertainUnits.add(orderUnit));
        return;
      }
      add(row.deliveredByUnit, unit, qty);
    });
  });

  rows.forEach((row) => {
    row.orderedByUnit.forEach((ordered, unit) => {
      const delivered = row.deliveredByUnit.get(unit) || 0;
      if (delivered > ordered) row.overDeliveredByUnit.set(unit, delivered - ordered);
      if (!row.uncertainUnits.has(unit)) row.pendingByUnit.set(unit, Math.max(0, ordered - delivered));
    });
    row.ageDays = getAgeDays(row.orderDate);
    row.ageingBucket = getAgeingBucket(row.ageDays);
    const statuses = [];
    if (row.exceptions.length) statuses.push('Allocation exceptions');
    if (row.overDeliveredByUnit.size) statuses.push('Over-delivered');
    if (row.uncertainUnits.size) statuses.push('Pending unavailable for affected UOM');
    if (!statuses.length) {
      const delivered = [...row.deliveredByUnit.values()].some((value) => value > 0);
      const hasPending = [...row.pendingByUnit.values()].some((value) => value > 0);
      row.orderStatus = !hasPending && row.orderedByUnit.size ? 'Delivered' : delivered ? 'Partially Delivered' : row.orderStatus;
    }
    row.allocationStatus = statuses.join('; ') || 'Fully allocated by exact Sales Order, item and UOM';
    row.orderedQty = formatQuantityMap(row.orderedByUnit);
    row.deliveredQty = formatQuantityMap(row.deliveredByUnit);
    row.pendingQty = formatQuantityMap(row.pendingByUnit, '0');
    row.overDeliveredQty = formatQuantityMap(row.overDeliveredByUnit);
    if (row.uncertainUnits.size) {
      const unavailable = [...row.uncertainUnits].sort().map((unit) => `Unavailable (${unit})`).join(' | ');
      row.pendingQty = [row.pendingQty === '0' ? '' : row.pendingQty, unavailable].filter(Boolean).join(' | ');
    }
    row.exceptionsText = row.exceptions.map((exception) => `${exception.challan || 'Source'}: ${exception.reason}`).join(' | ');
  });

  return { rows, exceptions };
};

export const formatQuantityMap = (map, emptyValue = '0') => {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map || {});
  const rendered = entries.filter(([, quantity]) => Number.isFinite(Number(quantity)) && Number(quantity) !== 0)
    .map(([unit, quantity]) => `${Number(quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`);
  return rendered.join(' | ') || emptyValue;
};

export const sumQuantityMaps = (rows, field) => rows.reduce((total, row) => {
  const map = row?.[field];
  if (map instanceof Map) map.forEach((quantity, unit) => add(total, unit, Number(quantity) || 0));
  return total;
}, new Map());

export const formatMoneyByCurrency = (rows, amountField = 'orderValue', currencyField = 'orderValueCurrency') => {
  const totals = new Map();
  rows.forEach((row) => add(totals, text(row?.[currencyField]) || 'Currency not recorded', Number(row?.[amountField]) || 0));
  return [...totals.entries()].map(([currency, amount]) => `${currency} ${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`).join(' | ') || '0';
};

const getAgeDays = (dateValue) => {
  const normalized = normalizeReportDate(dateValue);
  if (!normalized) return 0;
  const date = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
};

const getAgeingBucket = (days) => {
  if (days <= 30) return '0–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return '90+ days';
};
