CREATE TABLE IF NOT EXISTS ballooning_projects (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ballooning_drawings (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES ballooning_projects(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  drawing_no text NOT NULL DEFAULT '',
  storage_name text NOT NULL,
  page_count integer NOT NULL DEFAULT 1 CHECK (page_count > 0),
  uploaded_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ballooning_drawings_project_idx
  ON ballooning_drawings (project_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS ballooning_balloons (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES ballooning_projects(id) ON DELETE CASCADE,
  drawing_id text REFERENCES ballooning_drawings(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ballooning_balloons_project_idx
  ON ballooning_balloons (project_id, number);
CREATE INDEX IF NOT EXISTS ballooning_balloons_drawing_idx
  ON ballooning_balloons (drawing_id);

CREATE TABLE IF NOT EXISTS ballooning_characteristics (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES ballooning_projects(id) ON DELETE CASCADE,
  drawing_id text REFERENCES ballooning_drawings(id) ON DELETE CASCADE,
  balloon_id text REFERENCES ballooning_balloons(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ballooning_characteristics_project_idx
  ON ballooning_characteristics (project_id);

CREATE TABLE IF NOT EXISTS ballooning_inspections (
  id text PRIMARY KEY,
  project_id text NOT NULL UNIQUE REFERENCES ballooning_projects(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ballooning_approvals (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES ballooning_projects(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ballooning_approvals_project_idx
  ON ballooning_approvals (project_id, created_at DESC);
