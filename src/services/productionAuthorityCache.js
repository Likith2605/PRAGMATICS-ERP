let jobCardCache = [];
let bomCache = [];
let requirementCache = [];

export const cacheJobCards = (records) => {
  jobCardCache = Array.isArray(records) ? records : [];
  return jobCardCache;
};

export const getCachedJobCards = () => jobCardCache;

export const cacheBoms = (records) => {
  bomCache = Array.isArray(records) ? records : [];
  return bomCache;
};

export const getCachedBoms = () => bomCache;

export const clearProductionAuthorityCaches = () => {
  jobCardCache = [];
  bomCache = [];
  requirementCache = [];
};

export const cacheRequirements = (records) => {
  requirementCache = Array.isArray(records) ? records : [];
  return requirementCache;
};

export const getCachedRequirements = () => requirementCache;
