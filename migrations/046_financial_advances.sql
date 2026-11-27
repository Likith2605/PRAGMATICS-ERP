ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS advance_adjusted numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_adjusted_inr numeric(18,4) NOT NULL DEFAULT 0;

ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS advance_adjusted numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_adjusted_inr numeric(18,4) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS advance_sequences (
  advance_type text NOT NULL CHECK (advance_type IN ('customer','supplier')),
  year_suffix smallint NOT NULL CHECK (year_suffix BETWEEN 0 AND 99),
  last_number bigint NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (advance_type, year_suffix)
);

CREATE TABLE IF NOT EXISTS customer_advances (
  advance_number text PRIMARY KEY,
  customer_id text REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name text NOT NULL,
  advance_date date NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_inr numeric(18,8) NOT NULL DEFAULT 1 CHECK (exchange_rate_to_inr > 0),
  amount_inr numeric(18,4) NOT NULL CHECK (amount_inr > 0),
  payment_mode text NOT NULL DEFAULT '',
  payment_reference text NOT NULL DEFAULT '',
  against_reference text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  legacy_payload jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS customer_advances_party_date_idx
  ON customer_advances (lower(customer_name), advance_date DESC)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_advances_number_ci_uq
  ON customer_advances (lower(advance_number));

CREATE TABLE IF NOT EXISTS customer_advance_adjustments (
  adjustment_id text PRIMARY KEY,
  advance_number text NOT NULL REFERENCES customer_advances(advance_number) ON DELETE RESTRICT,
  invoice_number text NOT NULL REFERENCES customer_invoices(invoice_number) ON DELETE RESTRICT,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  amount_inr numeric(18,4) NOT NULL CHECK (amount_inr > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by text,
  void_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS customer_advance_adjustments_invoice_idx
  ON customer_advance_adjustments (invoice_number)
  WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_advance_adjustments_advance_idx
  ON customer_advance_adjustments (advance_number)
  WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_advance_audit (
  id bigserial PRIMARY KEY,
  advance_number text NOT NULL,
  user_id text,
  email text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_advance_audit_record_idx
  ON customer_advance_audit (advance_number, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_advances (
  advance_number text PRIMARY KEY,
  vendor_id text REFERENCES vendors(id) ON DELETE RESTRICT,
  vendor_name text NOT NULL,
  advance_date date NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate_to_inr numeric(18,8) NOT NULL DEFAULT 1 CHECK (exchange_rate_to_inr > 0),
  amount_inr numeric(18,4) NOT NULL CHECK (amount_inr > 0),
  payment_mode text NOT NULL DEFAULT '',
  payment_reference text NOT NULL DEFAULT '',
  against_reference text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  legacy_payload jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS supplier_advances_party_date_idx
  ON supplier_advances (lower(vendor_name), advance_date DESC)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_advances_number_ci_uq
  ON supplier_advances (lower(advance_number));

CREATE TABLE IF NOT EXISTS supplier_advance_adjustments (
  adjustment_id text PRIMARY KEY,
  advance_number text NOT NULL REFERENCES supplier_advances(advance_number) ON DELETE RESTRICT,
  invoice_number text NOT NULL REFERENCES supplier_invoices(invoice_number) ON DELETE RESTRICT,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  amount_inr numeric(18,4) NOT NULL CHECK (amount_inr > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by text,
  void_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS supplier_advance_adjustments_invoice_idx
  ON supplier_advance_adjustments (invoice_number)
  WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS supplier_advance_adjustments_advance_idx
  ON supplier_advance_adjustments (advance_number)
  WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS supplier_advance_audit (
  id bigserial PRIMARY KEY,
  advance_number text NOT NULL,
  user_id text,
  email text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_advance_audit_record_idx
  ON supplier_advance_audit (advance_number, created_at DESC);
