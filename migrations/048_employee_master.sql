CREATE TABLE IF NOT EXISTS employees (
  id text PRIMARY KEY,
  employee_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  password_hash text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  department text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  role_key text NOT NULL DEFAULT '',
  mobile text NOT NULL DEFAULT '',
  designation text NOT NULL DEFAULT '',
  joined_date text NOT NULL DEFAULT '',
  department_assignments jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text,
  source_key text,
  legacy_id text,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text,
  deleted_was_active boolean
);

CREATE UNIQUE INDEX IF NOT EXISTS employees_employee_id_idx
  ON employees (lower(employee_id));
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_active_idx
  ON employees (lower(email)) WHERE email <> '' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employees_create_token_idx
  ON employees (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS employees_legacy_identity_idx
  ON employees (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_active_directory_idx
  ON employees (lower(name), lower(employee_id)) WHERE active = true AND deleted_at IS NULL;
