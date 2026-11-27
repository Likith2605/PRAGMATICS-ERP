CREATE TABLE IF NOT EXISTS department_catalog (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source_key text,
  legacy_id text,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS department_catalog_active_name_idx
  ON department_catalog (lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS department_catalog_legacy_identity_idx
  ON department_catalog (source_key, legacy_id)
  WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS department_catalog_status_idx
  ON department_catalog (active, lower(name));

CREATE TABLE IF NOT EXISTS role_catalog (
  id text PRIMARY KEY,
  department_id text NOT NULL,
  department text NOT NULL,
  name text NOT NULL,
  role_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source_key text,
  legacy_id text,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS role_catalog_active_name_idx
  ON role_catalog (department_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS role_catalog_active_key_idx
  ON role_catalog (department_id, lower(role_key)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS role_catalog_legacy_identity_idx
  ON role_catalog (source_key, legacy_id)
  WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_catalog_department_status_idx
  ON role_catalog (department_id, active, lower(name));

CREATE TABLE IF NOT EXISTS role_permission_catalog (
  department_id text NOT NULL,
  role_id text NOT NULL,
  department text NOT NULL,
  role_key text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  source_key text,
  legacy_id text,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, role_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS role_permission_catalog_legacy_identity_idx
  ON role_permission_catalog (source_key, legacy_id)
  WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_permission_catalog_role_idx
  ON role_permission_catalog (role_id);
