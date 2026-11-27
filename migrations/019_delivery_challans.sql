CREATE TABLE IF NOT EXISTS delivery_challans (
  dc_number text PRIMARY KEY,
  dc_date date NOT NULL,
  sales_order_ref text NOT NULL DEFAULT '',
  customer_name text NOT NULL,
  status text NOT NULL DEFAULT 'Dispatched',
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS delivery_challans_date_idx ON delivery_challans(dc_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS delivery_challans_so_idx ON delivery_challans(sales_order_ref) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_challans_dispatch_request_uq ON delivery_challans((payload->>'dispatchRequestId')) WHERE deleted_at IS NULL AND payload ? 'dispatchRequestId';
CREATE TABLE IF NOT EXISTS delivery_challan_items (
  dc_number text NOT NULL REFERENCES delivery_challans(dc_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK(line_number > 0),
  item_name text NOT NULL DEFAULT '',
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  PRIMARY KEY(dc_number,line_number)
);
CREATE TABLE IF NOT EXISTS delivery_challan_audit (
  id bigserial PRIMARY KEY,
  dc_number text NOT NULL,
  user_id text,
  email text NOT NULL,
  role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
