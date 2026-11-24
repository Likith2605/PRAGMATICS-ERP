CREATE TABLE IF NOT EXISTS customer_purchase_orders (
  id bigserial PRIMARY KEY,
  po_number text NOT NULL,
  po_date date NOT NULL,
  customer_name text NOT NULL,
  record_type text NOT NULL DEFAULT 'Live',
  status text NOT NULL DEFAULT 'Received',
  data_source text NOT NULL DEFAULT 'ERP',
  fy_label text NOT NULL,
  fy_code text NOT NULL,
  header_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_purchase_orders_po_number_uq
  ON customer_purchase_orders (lower(po_number));
CREATE INDEX IF NOT EXISTS customer_purchase_orders_date_idx
  ON customer_purchase_orders (po_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS customer_purchase_order_items (
  id bigserial PRIMARY KEY,
  customer_po_id bigint NOT NULL REFERENCES customer_purchase_orders(id) ON DELETE CASCADE,
  line_number integer NOT NULL CHECK (line_number > 0),
  item_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  serial_number text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  quantity numeric(20,4),
  delivered_quantity numeric(20,4),
  balance_quantity numeric(20,4),
  unit_price numeric(20,4),
  amount numeric(20,4),
  po_balance_quantity_price numeric(20,4),
  UNIQUE (customer_po_id, line_number)
);

CREATE INDEX IF NOT EXISTS customer_purchase_order_items_po_idx
  ON customer_purchase_order_items (customer_po_id, line_number);

-- Preserve centrally mirrored Customer PO records created before this module
-- had dedicated relational storage. This is an additive copy; erp_state is
-- intentionally left untouched.
WITH source_records AS (
  SELECT DISTINCT ON (lower(trim(entry->>'reference')))
    entry,
    trim(entry->>'reference') AS po_number,
    COALESCE(entry->'payload', '{}'::jsonb) AS payload,
    CASE
      WHEN COALESCE(entry->'payload'->'poDetails'->>'customerPoDate', entry->>'date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       AND to_char(to_date(COALESCE(entry->'payload'->'poDetails'->>'customerPoDate', entry->>'date'), 'YYYY-MM-DD'), 'YYYY-MM-DD') = COALESCE(entry->'payload'->'poDetails'->>'customerPoDate', entry->>'date')
      THEN COALESCE(entry->'payload'->'poDetails'->>'customerPoDate', entry->>'date')::date
      ELSE current_date
    END AS po_date
  FROM erp_state state
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(state.data) = 'array' THEN state.data ELSE '[]'::jsonb END
  ) entry
  WHERE state.storage_key = 'customerPOHistory'
    AND trim(COALESCE(entry->>'reference', '')) <> ''
  ORDER BY lower(trim(entry->>'reference')), entry->>'date' DESC
), inserted_headers AS (
  INSERT INTO customer_purchase_orders
    (po_number, po_date, customer_name, record_type, status, data_source, fy_label, fy_code, header_data, created_by)
  SELECT
    source.po_number,
    source.po_date,
    COALESCE(source.payload->'customerDetails'->>'customerName', source.entry->>'company', 'Unknown Customer'),
    'Live',
    COALESCE(source.payload->'poDetails'->>'poStatus', source.entry->>'status', 'Received'),
    'ERP Migration',
    COALESCE(source.payload->>'fyLabel', 'FY ' || (EXTRACT(YEAR FROM source.po_date)::integer - CASE WHEN EXTRACT(MONTH FROM source.po_date) < 4 THEN 1 ELSE 0 END)::text || '-' || right(((EXTRACT(YEAR FROM source.po_date)::integer - CASE WHEN EXTRACT(MONTH FROM source.po_date) < 4 THEN 1 ELSE 0 END) + 1)::text, 2)),
    COALESCE(source.payload->>'fyCode', (EXTRACT(YEAR FROM source.po_date)::integer - CASE WHEN EXTRACT(MONTH FROM source.po_date) < 4 THEN 1 ELSE 0 END)::text || '-' || right(((EXTRACT(YEAR FROM source.po_date)::integer - CASE WHEN EXTRACT(MONTH FROM source.po_date) < 4 THEN 1 ELSE 0 END) + 1)::text, 2)),
    source.payload,
    'migration-010'
  FROM source_records source
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO customer_purchase_order_items
  (customer_po_id, line_number, item_data, serial_number, description, quantity, delivered_quantity, balance_quantity, unit_price, amount, po_balance_quantity_price)
SELECT
  header.id,
  item.ordinality::integer,
  item.value,
  COALESCE(item.value->>'serialNumber', item.value->>'serialNo', ''),
  COALESCE(item.value->>'itemName', item.value->>'itemDescription', ''),
  CASE WHEN item.value->>'quantity' ~ '^[+-]?[0-9]+(\.[0-9]+)?$' THEN (item.value->>'quantity')::numeric END,
  CASE WHEN item.value->>'deliveredQty' ~ '^[+-]?[0-9]+(\.[0-9]+)?$' THEN (item.value->>'deliveredQty')::numeric END,
  CASE WHEN item.value->>'balanceQty' ~ '^[+-]?[0-9]+(\.[0-9]+)?$' THEN (item.value->>'balanceQty')::numeric END,
  CASE WHEN item.value->>'unitPrice' ~ '^[+-]?[0-9]+(\.[0-9]+)?$' THEN (item.value->>'unitPrice')::numeric END,
  CASE WHEN item.value->>'amount' ~ '^[+-]?[0-9]+(\.[0-9]+)?$' THEN (item.value->>'amount')::numeric END,
  CASE WHEN item.value->>'poBalanceQuantityPrice' ~ '^[+-]?[0-9]+(\.[0-9]+)?$' THEN (item.value->>'poBalanceQuantityPrice')::numeric END
FROM source_records source
JOIN customer_purchase_orders header ON lower(header.po_number) = lower(source.po_number)
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(source.payload->'items') = 'array' THEN source.payload->'items' ELSE '[]'::jsonb END
) WITH ORDINALITY item(value, ordinality)
ON CONFLICT (customer_po_id, line_number) DO NOTHING;
