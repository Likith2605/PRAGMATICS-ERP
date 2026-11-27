-- Quotation persistence with versioned records, explicit soft deletion and
-- normalized searchable header/item columns. JSONB payloads preserve the full
-- existing UI document shape during the staged conversion.
CREATE TABLE IF NOT EXISTS quotations (
  quotation_number text PRIMARY KEY,
  project_id text NOT NULL DEFAULT '',
  customer_name text NOT NULL,
  company_name text NOT NULL DEFAULT '',
  quotation_date date NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  grand_total numeric(18,4) NOT NULL DEFAULT 0,
  balance_status text NOT NULL DEFAULT 'Pending',
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS quotations_create_token_idx
  ON quotations (create_token) WHERE create_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotations_customer_date_idx
  ON quotations (customer_name, quotation_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS quotations_project_idx
  ON quotations (project_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS quotation_items (
  quotation_number text NOT NULL REFERENCES quotations(quotation_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  item_name text NOT NULL DEFAULT '',
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  unit_price numeric(18,4) NOT NULL DEFAULT 0,
  line_amount numeric(18,4) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  PRIMARY KEY (quotation_number, line_number)
);
CREATE INDEX IF NOT EXISTS quotation_items_name_idx ON quotation_items (item_name);

CREATE TABLE IF NOT EXISTS quotation_sequences (
  sequence_year integer PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
