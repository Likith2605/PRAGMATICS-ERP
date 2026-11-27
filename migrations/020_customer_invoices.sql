CREATE TABLE IF NOT EXISTS customer_invoices (
  invoice_number text PRIMARY KEY,
  invoice_date date NOT NULL,
  due_date date,
  customer_name text NOT NULL,
  quotation_ref text NOT NULL DEFAULT '',
  sales_order_ref text NOT NULL DEFAULT '',
  delivery_challan_ref text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  payment_status text NOT NULL DEFAULT 'Pending',
  currency text NOT NULL DEFAULT 'INR',
  grand_total numeric(18,4) NOT NULL DEFAULT 0,
  amount_received numeric(18,4) NOT NULL DEFAULT 0,
  balance_due numeric(18,4) NOT NULL DEFAULT 0,
  amount_inr numeric(18,4) NOT NULL DEFAULT 0,
  received_inr numeric(18,4) NOT NULL DEFAULT 0,
  balance_inr numeric(18,4) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  create_token text UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS customer_invoices_date_idx ON customer_invoices(invoice_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_invoices_customer_idx ON customer_invoices(lower(customer_name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_invoices_receivables_idx ON customer_invoices(due_date,payment_status) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS customer_invoice_items (
  invoice_number text NOT NULL REFERENCES customer_invoices(invoice_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK(line_number > 0),
  item_name text NOT NULL DEFAULT '',
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  unit_price numeric(18,4) NOT NULL DEFAULT 0,
  line_amount numeric(18,4) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  PRIMARY KEY(invoice_number,line_number)
);
CREATE INDEX IF NOT EXISTS customer_invoice_items_name_idx ON customer_invoice_items(item_name);
CREATE TABLE IF NOT EXISTS customer_invoice_audit (
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
