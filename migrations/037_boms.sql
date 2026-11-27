-- Bill of Materials (BOM) schema: headers, line items, versioning and audit.

CREATE TABLE IF NOT EXISTS bom_headers (
  bom_number text PRIMARY KEY,
  part_code text NOT NULL,
  part_name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'Active',
  remarks text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS bom_headers_part_idx
  ON bom_headers (lower(part_code), version DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bom_headers_status_idx
  ON bom_headers (status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS bom_items (
  id bigserial PRIMARY KEY,
  bom_number text NOT NULL REFERENCES bom_headers(bom_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  item_code text NOT NULL,
  material_name text NOT NULL,
  quantity_per_unit numeric(14, 4) NOT NULL,
  unit text NOT NULL DEFAULT 'Nos',
  scrap_percentage numeric(5, 2) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS bom_items_bom_idx
  ON bom_items (bom_number, line_number);

CREATE TABLE IF NOT EXISTS bom_audit (
  id bigserial PRIMARY KEY,
  bom_number text NOT NULL,
  action text NOT NULL,
  actor_id text,
  actor_email text,
  actor_role text,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bom_audit_idx
  ON bom_audit (bom_number, created_at DESC);
