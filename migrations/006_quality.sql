-- Quality module tables (embedded QualityApp)
-- Mirrors the QualityApp server schema but lives in the ERP database.

CREATE TABLE IF NOT EXISTS quality_drawings (
  id text PRIMARY KEY,
  drawing_no text NOT NULL DEFAULT '',
  part_name text NOT NULL DEFAULT '',
  customer text NOT NULL DEFAULT '',
  revision text NOT NULL DEFAULT '',
  material text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'mm',
  notes text NOT NULL DEFAULT '',
  po_no text NOT NULL DEFAULT '',
  qty integer NOT NULL DEFAULT 0,
  treatment text NOT NULL DEFAULT '',
  hardness text NOT NULL DEFAULT '',
  image_uri text NOT NULL DEFAULT '',
  deleted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(drawing_no)
);

CREATE TABLE IF NOT EXISTS quality_dimensions (
  id text PRIMARY KEY,
  drawing_id text NOT NULL REFERENCES quality_drawings(id) ON DELETE CASCADE,
  dim_no integer NOT NULL,
  description text NOT NULL DEFAULT '',
  nominal double precision NOT NULL DEFAULT 0,
  nominal_text text NOT NULL DEFAULT '',
  tol_upper double precision NOT NULL DEFAULT 0,
  tol_lower double precision NOT NULL DEFAULT 0,
  deleted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(drawing_id, dim_no)
);
CREATE INDEX IF NOT EXISTS quality_dimensions_drawing_idx
  ON quality_dimensions (drawing_id, dim_no);

CREATE TABLE IF NOT EXISTS quality_checks (
  id text PRIMARY KEY,
  drawing_id text NOT NULL REFERENCES quality_drawings(id) ON DELETE CASCADE,
  checked_by text NOT NULL DEFAULT '',
  inspector_name text NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL DEFAULT 'Pending',
  instrument text NOT NULL DEFAULT '',
  inspector_notes text NOT NULL DEFAULT '',
  deleted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quality_checks_drawing_idx
  ON quality_checks (drawing_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS quality_measurements (
  id text PRIMARY KEY,
  check_id text NOT NULL REFERENCES quality_checks(id) ON DELETE CASCADE,
  dimension_id text NOT NULL REFERENCES quality_dimensions(id) ON DELETE CASCADE,
  sample1 double precision,
  sample2 double precision,
  sample3 double precision,
  sample4 double precision,
  sample5 double precision,
  sample6 double precision,
  sample7 double precision,
  sample8 double precision,
  sample9 double precision,
  sample10 double precision,
  remarks text NOT NULL DEFAULT '',
  pass integer, -- 1 = pass, 0 = fail, NULL = not measured
  instrument text NOT NULL DEFAULT '',
  sample_status text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(check_id, dimension_id)
);
CREATE INDEX IF NOT EXISTS quality_measurements_check_idx
  ON quality_measurements (check_id, dimension_id);

CREATE TABLE IF NOT EXISTS quality_dispatches (
  id text PRIMARY KEY,
  dispatch_no text NOT NULL DEFAULT '',
  drawing_id text NOT NULL REFERENCES quality_drawings(id) ON DELETE CASCADE,
  drawing_no text NOT NULL DEFAULT '',
  part_name text NOT NULL DEFAULT '',
  po_no text NOT NULL DEFAULT '',
  invoice_no text NOT NULL DEFAULT '',
  qty integer NOT NULL DEFAULT 0,
  dispatched_by text NOT NULL DEFAULT '',
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  notes text NOT NULL DEFAULT '',
  deleted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quality_dispatches_drawing_idx
  ON quality_dispatches (drawing_id, dispatched_at DESC);

CREATE TABLE IF NOT EXISTS quality_instruments (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  deleted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
