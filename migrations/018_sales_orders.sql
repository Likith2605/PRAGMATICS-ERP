-- PostgreSQL-authoritative Sales Orders. The JSONB payload preserves the UI
-- document while searchable header and item rows provide stable keys and links.
CREATE TABLE IF NOT EXISTS sales_orders (
  so_number text PRIMARY KEY,
  so_date date NOT NULL,
  customer_name text NOT NULL,
  project_id text NOT NULL DEFAULT '',
  quotation_ref text NOT NULL DEFAULT '',
  customer_po_number text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Confirmed',
  currency text NOT NULL DEFAULT 'INR',
  grand_total numeric(18,4) NOT NULL DEFAULT 0,
  amount_inr numeric(18,4) NOT NULL DEFAULT 0,
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
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_create_token_idx ON sales_orders(create_token) WHERE create_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_quotation_ref_active_uq ON sales_orders(lower(quotation_ref)) WHERE deleted_at IS NULL AND quotation_ref <> '';
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_customer_po_active_uq ON sales_orders(lower(customer_po_number)) WHERE deleted_at IS NULL AND customer_po_number <> '';
CREATE INDEX IF NOT EXISTS sales_orders_date_idx ON sales_orders(so_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sales_orders_customer_idx ON sales_orders(lower(customer_name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sales_order_items (
  so_number text NOT NULL REFERENCES sales_orders(so_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  item_name text NOT NULL DEFAULT '',
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  unit_price numeric(18,4) NOT NULL DEFAULT 0,
  line_amount numeric(18,4) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  PRIMARY KEY (so_number,line_number)
);
CREATE INDEX IF NOT EXISTS sales_order_items_name_idx ON sales_order_items(item_name);
