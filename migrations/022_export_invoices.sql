CREATE TABLE IF NOT EXISTS export_invoices (
  invoice_number text PRIMARY KEY,
  invoice_date date NOT NULL,
  buyer_name text NOT NULL,
  source_sales_order text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Draft',
  amount_usd numeric(18,2) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  create_token text UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS export_invoices_date_idx ON export_invoices(invoice_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS export_invoices_buyer_idx ON export_invoices(lower(buyer_name)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS export_invoice_items (
  invoice_number text NOT NULL REFERENCES export_invoices(invoice_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK(line_number>0),
  description text NOT NULL DEFAULT '',
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  rate numeric(18,4) NOT NULL DEFAULT 0,
  amount_usd numeric(18,2) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  PRIMARY KEY(invoice_number,line_number)
);
CREATE TABLE IF NOT EXISTS export_invoice_audit (
  id bigserial PRIMARY KEY,
  invoice_number text NOT NULL,
  user_id text,
  email text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS export_invoice_sequences (
  financial_year text PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0 CHECK(last_number>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
