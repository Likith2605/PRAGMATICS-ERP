CREATE TABLE IF NOT EXISTS commercial_returns (
  return_number text PRIMARY KEY,
  return_type text NOT NULL CHECK (return_type IN ('sales', 'purchase')),
  source_invoice_number text NOT NULL,
  customer_invoice_number text REFERENCES customer_invoices(invoice_number) ON DELETE RESTRICT,
  supplier_invoice_number text REFERENCES supplier_invoices(invoice_number) ON DELETE RESTRICT,
  return_date date NOT NULL,
  party_name text NOT NULL,
  counterparty_contact text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  total_value numeric(18,4) NOT NULL CHECK (total_value >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT '',
  CHECK (
    (return_type = 'sales' AND customer_invoice_number = source_invoice_number AND supplier_invoice_number IS NULL)
    OR
    (return_type = 'purchase' AND supplier_invoice_number = source_invoice_number AND customer_invoice_number IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS commercial_returns_type_date_idx
  ON commercial_returns(return_type, return_date DESC, return_number DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS commercial_returns_source_idx
  ON commercial_returns(return_type, source_invoice_number)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS commercial_return_items (
  return_number text NOT NULL REFERENCES commercial_returns(return_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  source_line_number integer NOT NULL CHECK (source_line_number > 0),
  item_code text NOT NULL DEFAULT '',
  item_name text NOT NULL DEFAULT '',
  drawing_no text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  source_quantity numeric(18,4) NOT NULL CHECK (source_quantity > 0),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  line_amount numeric(18,4) NOT NULL CHECK (line_amount >= 0),
  reason text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (return_number, line_number),
  UNIQUE (return_number, source_line_number)
);

CREATE INDEX IF NOT EXISTS commercial_return_items_source_line_idx
  ON commercial_return_items(source_line_number, return_number);
