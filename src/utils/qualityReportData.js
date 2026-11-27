export const buildQualityReportSnapshot = ({ drawings, checks, dispatches, drawingDetails, checkDetails }) => {
  const dimensionById = new Map();
  const measurements = [];

  for (const drawing of drawingDetails) {
    for (const dimension of drawing.dimensions || []) {
      dimensionById.set(String(dimension.id), dimension);
    }
  }

  for (const check of checkDetails) {
    for (const dimension of check.dimensions || []) {
      dimensionById.set(String(dimension.id), dimension);
      if (dimension.measurement) {
        measurements.push({
          ...dimension.measurement,
          check_id: check.id,
          dimension_id: dimension.id
        });
      }
    }
  }

  return {
    drawings: drawingDetails.length ? drawingDetails : drawings,
    checks,
    dispatches: dispatches.map((dispatch) => ({
      ...dispatch,
      dispatcher_name: dispatch.dispatched_by || ''
    })),
    dimensions: [...dimensionById.values()],
    measurements,
    employees: []
  };
};
