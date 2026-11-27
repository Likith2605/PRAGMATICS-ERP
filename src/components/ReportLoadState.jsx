import React from 'react';

const ReportLoadState = ({ loading, error }) => {
  if (loading) return <div role="status" className="content-block">Loading report data from PostgreSQL...</div>;
  if (error) return <div role="alert" className="form-error">Report data could not be loaded from PostgreSQL: {error}</div>;
  return null;
};

export default ReportLoadState;
