import { hasPermission } from './permissions.js';
import { isAdmin } from './auth.js';
import { getInventoryItems, readLS, writeLS } from './storeService.js';

export const DEFAULT_UNITS = [
  'Nos', 'Set', 'Pair', 'Kit', 'Assembly', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Bundle'
];

export const DEFAULT_INVENTORY_CATEGORIES = [
  'Raw Material', 'Standard Part', 'Machined Component', 'Fastener', 'Consumable'
];

const UNIT_KEY = 'customUnits';
const CATEGORY_KEY = 'customInventoryCategories';
const DELETED_UNIT_DEFAULTS_KEY = 'deletedDefaultUnits';
const DELETED_CATEGORY_DEFAULTS_KEY = 'deletedDefaultInventoryCategories';
const normalize = (value) => String(value || '').trim().toLocaleLowerCase();

const readList = (key) => {
  const stored = readLS(key, []);
  return Array.isArray(stored) ? stored.filter((value) => typeof value === 'string') : [];
};

export const getCustomUnits = () => readList(UNIT_KEY);
export const getAvailableUnits = () => {
  const deletedDefaults = new Set(readList(DELETED_UNIT_DEFAULTS_KEY).map(normalize));
  return [...DEFAULT_UNITS.filter((unit) => !deletedDefaults.has(normalize(unit))), ...getCustomUnits()];
};
export const getInventoryCategories = () => {
  const deletedDefaults = new Set(readList(DELETED_CATEGORY_DEFAULTS_KEY).map(normalize));
  return [...new Set([
    ...DEFAULT_INVENTORY_CATEGORIES.filter((category) => !deletedDefaults.has(normalize(category))),
    ...readList(CATEGORY_KEY)
  ])];
};

export const addCustomUnit = ({ symbol }) => {
  // The existing customUnits format stores only the unit symbol.
  const cleanSymbol = String(symbol || '').trim();
  if (!cleanSymbol) throw new Error('Unit symbol is required.');
  if (getAvailableUnits().some((unit) => normalize(unit) === normalize(cleanSymbol))) {
    throw new Error(`Unit symbol “${cleanSymbol}” already exists.`);
  }
  const next = [...getCustomUnits(), cleanSymbol];
  writeLS(UNIT_KEY, next);
  return cleanSymbol;
};

export const addInventoryCategory = (name) => {
  if (!hasPermission('inventory.adjust')) throw new Error('Permission denied: inventory.adjust.');
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Category name is required.');
  if (getInventoryCategories().some((category) => normalize(category) === normalize(cleanName))) {
    throw new Error(`Category “${cleanName}” already exists.`);
  }
  const next = [...readList(CATEGORY_KEY), cleanName];
  writeLS(CATEGORY_KEY, next);
  return cleanName;
};

const removeMasterValue = ({ name, key, deletedDefaultsKey, defaults, recordField, label }) => {
  if (!isAdmin()) throw new Error(`Permission denied: only an Admin can delete an inventory ${label.toLowerCase()}.`);
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error(`${label} is required.`);
  const defaultValue = defaults.find((value) => normalize(value) === normalize(cleanName));
  const existing = readList(key);
  const storedValue = existing.find((value) => normalize(value) === normalize(cleanName));
  if (!storedValue && !defaultValue) throw new Error(`${label} was not found.`);
  const valueToDelete = storedValue || defaultValue;
  if (getInventoryItems().some((item) => normalize(item?.[recordField]) === normalize(valueToDelete))) {
    throw new Error(`Cannot delete this ${label.toLowerCase()} because it is already in use by an inventory record.`);
  }
  if (storedValue) writeLS(key, existing.filter((value) => normalize(value) !== normalize(storedValue)));
  if (defaultValue) {
    const deletedDefaults = readList(deletedDefaultsKey);
    if (!deletedDefaults.some((value) => normalize(value) === normalize(defaultValue))) {
      writeLS(deletedDefaultsKey, [...deletedDefaults, defaultValue]);
    }
  }
  return valueToDelete;
};

export const removeInventoryCategory = (name) => {
  if (!hasPermission('inventory.adjust')) throw new Error('Permission denied: inventory.adjust.');
  return removeMasterValue({ name, key: CATEGORY_KEY, deletedDefaultsKey: DELETED_CATEGORY_DEFAULTS_KEY, defaults: DEFAULT_INVENTORY_CATEGORIES, recordField: 'category', label: 'Category' });
};

export const removeCustomUnit = (symbol) => removeMasterValue({
  name: symbol,
  key: UNIT_KEY,
  deletedDefaultsKey: DELETED_UNIT_DEFAULTS_KEY,
  defaults: DEFAULT_UNITS,
  recordField: 'unit',
  label: 'Unit'
});
