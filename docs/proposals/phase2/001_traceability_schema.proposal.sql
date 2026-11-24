-- REVIEW PROPOSAL ONLY. DO NOT EXECUTE.
-- Intentionally stored outside migrations/: server/database.js auto-runs numbered
-- SQL files placed in migrations/. This file contains DDL only; no backfill DML.
-- Design assumes PostgreSQL 15+ and application-level transactional validation.

CREATE TABLE trace_items (
  item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id text NOT NULL UNIQUE,
  item_code text NOT NULL UNIQUE,
  item_name_snapshot text NOT NULL,
  unit text NOT NULL,
  source_snapshot jsonb NOT NULL,
  CHECK (length(trim(item_code)) > 0), CHECK (length(trim(unit)) > 0)
);

CREATE TABLE trace_suppliers (
  supplier_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_key text UNIQUE,
  supplier_name text NOT NULL,
  tax_id text,
  contact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(supplier_name)) > 0)
);

CREATE TABLE trace_purchase_orders (
  po_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text NOT NULL UNIQUE,
  po_number text NOT NULL UNIQUE,
  supplier_id uuid REFERENCES trace_suppliers(supplier_id),
  supplier_name_snapshot text NOT NULL,
  -- Preserve source status exactly. NULL means the historical source omitted it;
  -- never backfill a guessed status such as Open/Closed.
  source_status text,
  source_status_present boolean NOT NULL DEFAULT false,
  source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trace_purchase_order_lines (
  po_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES trace_purchase_orders(po_id),
  source_line_id text NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal > 0),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  description text,
  ordered_qty numeric(18,6) NOT NULL CHECK (ordered_qty >= 0),
  unit text NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (po_id, source_line_id), UNIQUE (po_id, source_ordinal)
);
CREATE TABLE trace_po_close_events (
  close_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_line_id uuid NOT NULL REFERENCES trace_purchase_order_lines(po_line_id),
  closed_qty numeric(18,6) NOT NULL CHECK (closed_qty > 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  approved_by text NOT NULL,
  closed_by text NOT NULL,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE
);

CREATE TABLE trace_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text NOT NULL UNIQUE,
  receipt_number text NOT NULL,
  po_id uuid REFERENCES trace_purchase_orders(po_id),
  received_at timestamptz,
  source_snapshot jsonb NOT NULL
);
CREATE TABLE trace_receipt_lines (
  receipt_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES trace_receipts(receipt_id),
  po_line_id uuid REFERENCES trace_purchase_order_lines(po_line_id),
  source_line_id text NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal > 0),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  quantity numeric(18,6) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (receipt_id, source_line_id), UNIQUE (receipt_id, source_ordinal)
);
CREATE TABLE trace_receipt_qc_events (
  qc_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES trace_receipt_lines(receipt_line_id),
  source_qc_document_id text,
  inspected_qty numeric(18,6) NOT NULL CHECK (inspected_qty >= 0),
  accepted_qty numeric(18,6) NOT NULL CHECK (accepted_qty >= 0),
  rejected_qty numeric(18,6) NOT NULL CHECK (rejected_qty >= 0),
  disposition text NOT NULL,
  inspected_at timestamptz,
  inspector text,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (accepted_qty + rejected_qty <= inspected_qty)
);

CREATE TABLE trace_inventory_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_line_id uuid NOT NULL REFERENCES trace_receipt_lines(receipt_line_id),
  split_ordinal integer NOT NULL DEFAULT 1 CHECK (split_ordinal > 0),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  supplier_id uuid REFERENCES trace_suppliers(supplier_id),
  supplier_batch_no text,
  internal_batch_no text UNIQUE,
  quantity_received numeric(18,6) NOT NULL CHECK (quantity_received >= 0),
  quantity_accepted numeric(18,6) NOT NULL CHECK (quantity_accepted >= 0),
  quantity_rejected numeric(18,6) NOT NULL CHECK (quantity_rejected >= 0),
  unit text NOT NULL,
  qc_status text NOT NULL CHECK (qc_status IN ('PENDING','ACCEPTED','PARTIAL','REJECTED','HOLD')),
  location text,
  expiry_date date,
  UNIQUE (receipt_line_id, split_ordinal),
  CHECK (quantity_accepted + quantity_rejected <= quantity_received)
);
-- quantity_received/accepted/rejected are receipt and QC facts only. They are
-- NOT on-hand balance fields. All batch/WIP/FG on-hand values are derived solely
-- from signed movement effects in trace_stock_movements (see ledger contract at
-- file end); never add batch quantity columns to movement-derived balances.
CREATE INDEX trace_batches_item_status_idx ON trace_inventory_batches(item_code, qc_status);
CREATE INDEX trace_batches_supplier_batch_idx ON trace_inventory_batches(supplier_id, supplier_batch_no);

-- QC-to-batch link is explicit and quantity-bearing. An event can inspect more
-- than one batch; a batch can have appended reinspection events. The service
-- verifies each batch.receipt_line_id equals its QC event.receipt_line_id.
CREATE TABLE trace_qc_batch_allocations (
  qc_batch_allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qc_event_id uuid NOT NULL REFERENCES trace_receipt_qc_events(qc_event_id),
  batch_id uuid NOT NULL REFERENCES trace_inventory_batches(batch_id),
  inspected_qty numeric(18,6) NOT NULL CHECK (inspected_qty >= 0),
  accepted_qty numeric(18,6) NOT NULL CHECK (accepted_qty >= 0),
  rejected_qty numeric(18,6) NOT NULL CHECK (rejected_qty >= 0),
  idempotency_key text NOT NULL UNIQUE,
  CHECK (accepted_qty + rejected_qty <= inspected_qty)
);
CREATE INDEX trace_qc_batch_idx ON trace_qc_batch_allocations(batch_id, qc_event_id);

CREATE TABLE trace_material_issues (
  issue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text NOT NULL UNIQUE,
  issue_number text NOT NULL,
  mr_number text,
  job_card_number text,
  issued_at timestamptz,
  issued_by text,
  source_snapshot jsonb NOT NULL
);
CREATE TABLE trace_material_issue_lines (
  issue_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES trace_material_issues(issue_id),
  source_line_id text NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal > 0),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  requested_qty numeric(18,6) NOT NULL CHECK (requested_qty >= 0),
  unit text NOT NULL,
  UNIQUE (issue_id, source_line_id), UNIQUE (issue_id, source_ordinal)
);
CREATE TABLE trace_issue_allocations (
  allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_line_id uuid NOT NULL REFERENCES trace_material_issue_lines(issue_line_id),
  batch_id uuid NOT NULL REFERENCES trace_inventory_batches(batch_id),
  allocated_qty numeric(18,6) NOT NULL CHECK (allocated_qty > 0),
  allocated_at timestamptz NOT NULL,
  allocated_by text NOT NULL,
  UNIQUE (issue_line_id, batch_id, allocated_at)
);
CREATE INDEX trace_issue_alloc_batch_idx ON trace_issue_allocations(batch_id);
CREATE TABLE trace_material_returns (
  return_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text NOT NULL UNIQUE,
  returned_at timestamptz NOT NULL,
  returned_by text NOT NULL,
  source_snapshot jsonb NOT NULL
);
CREATE TABLE trace_return_allocations (
  return_allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES trace_material_returns(return_id),
  issue_allocation_id uuid NOT NULL REFERENCES trace_issue_allocations(allocation_id),
  returned_qty numeric(18,6) NOT NULL CHECK (returned_qty > 0),
  batch_id uuid NOT NULL REFERENCES trace_inventory_batches(batch_id),
  -- Multiple partial returns of one issue allocation are valid. Retry safety is
  -- provided per return event, not by forbidding a second return document.
  idempotency_key text NOT NULL UNIQUE
);

-- Customer/Sales Order projections provide enforceable dispatch relationships.
-- Historical records link only where stable source identifiers are present.
CREATE TABLE trace_customers (
  customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text UNIQUE,
  customer_name text NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (length(trim(customer_name)) > 0)
);
CREATE TABLE trace_sales_orders (
  sales_order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text NOT NULL UNIQUE,
  order_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES trace_customers(customer_id),
  customer_name_snapshot text NOT NULL,
  project_id text,
  source_snapshot jsonb NOT NULL
);
CREATE TABLE trace_sales_order_lines (
  sales_order_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES trace_sales_orders(sales_order_id),
  source_line_id text NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal > 0),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  ordered_qty numeric(18,6) NOT NULL CHECK (ordered_qty >= 0),
  unit text NOT NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (sales_order_id, source_line_id), UNIQUE (sales_order_id, source_ordinal)
);

-- WIP lots are explicit production-stage inventory, distinct from raw receipt
-- batches and finished goods. They may be outsourced and returned partially.
CREATE TABLE trace_wip_lots (
  wip_lot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number text NOT NULL UNIQUE,
  job_card_number text NOT NULL,
  project_id text,
  sales_order_id uuid REFERENCES trace_sales_orders(sales_order_id),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  produced_qty numeric(18,6) NOT NULL CHECK (produced_qty > 0),
  unit text NOT NULL,
  process_step text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE trace_job_cards (
  job_card_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text NOT NULL UNIQUE,
  job_card_number text NOT NULL UNIQUE,
  project_id text NOT NULL,
  sales_order_id uuid REFERENCES trace_sales_orders(sales_order_id),
  sales_order_line_id uuid REFERENCES trace_sales_order_lines(sales_order_line_id),
  customer_id uuid REFERENCES trace_customers(customer_id),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  source_snapshot jsonb NOT NULL,
  CHECK ((sales_order_id IS NULL) = (sales_order_line_id IS NULL))
);

CREATE TABLE trace_production_outputs (
  output_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_key text NOT NULL UNIQUE,
  job_card_number text NOT NULL,
  job_card_id uuid NOT NULL REFERENCES trace_job_cards(job_card_id),
  sales_order_id uuid NOT NULL REFERENCES trace_sales_orders(sales_order_id),
  sales_order_line_id uuid NOT NULL REFERENCES trace_sales_order_lines(sales_order_line_id),
  project_id text NOT NULL,
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  output_qty numeric(18,6) NOT NULL CHECK (output_qty > 0),
  unit text NOT NULL,
  recorded_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  source_snapshot jsonb NOT NULL
);
CREATE TABLE trace_finished_goods_lots (
  fg_lot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number text NOT NULL UNIQUE,
  output_id uuid NOT NULL UNIQUE REFERENCES trace_production_outputs(output_id),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  produced_qty numeric(18,6) NOT NULL CHECK (produced_qty > 0),
  unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trace_material_consumptions (
  consumption_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fg_lot_id uuid NOT NULL REFERENCES trace_finished_goods_lots(fg_lot_id),
  issue_allocation_id uuid NOT NULL REFERENCES trace_issue_allocations(allocation_id),
  batch_id uuid NOT NULL REFERENCES trace_inventory_batches(batch_id),
  consumed_qty numeric(18,6) NOT NULL CHECK (consumed_qty > 0),
  consumed_at timestamptz NOT NULL,
  consumed_by text NOT NULL,
  -- Supports multiple actual-consumption events against the same allocation.
  source_event_key text NOT NULL UNIQUE
);
CREATE INDEX trace_consumptions_batch_idx ON trace_material_consumptions(batch_id);
CREATE TABLE trace_finished_goods_qc_events (
  fg_qc_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fg_lot_id uuid NOT NULL REFERENCES trace_finished_goods_lots(fg_lot_id),
  supersedes_event_id uuid REFERENCES trace_finished_goods_qc_events(fg_qc_event_id),
  inspected_qty numeric(18,6) NOT NULL CHECK (inspected_qty >= 0),
  accepted_qty numeric(18,6) NOT NULL CHECK (accepted_qty >= 0),
  rejected_qty numeric(18,6) NOT NULL CHECK (rejected_qty >= 0),
  rework_qty numeric(18,6) NOT NULL DEFAULT 0 CHECK (rework_qty >= 0),
  status text NOT NULL,
  inspected_at timestamptz NOT NULL,
  inspector text NOT NULL,
  remarks text,
  CHECK (accepted_qty + rejected_qty + rework_qty <= inspected_qty)
);
CREATE INDEX trace_fg_qc_lot_time_idx ON trace_finished_goods_qc_events(fg_lot_id, inspected_at);
CREATE TABLE trace_finished_goods_dispatch_allocations (
  dispatch_allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challan_document_id text NOT NULL,
  challan_number text NOT NULL,
  sales_order_id uuid NOT NULL REFERENCES trace_sales_orders(sales_order_id),
  sales_order_line_id uuid NOT NULL REFERENCES trace_sales_order_lines(sales_order_line_id),
  customer_id uuid NOT NULL REFERENCES trace_customers(customer_id),
  item_code text NOT NULL,
  item_id uuid NOT NULL REFERENCES trace_items(item_id),
  source_line_id text NOT NULL,
  fg_lot_id uuid NOT NULL REFERENCES trace_finished_goods_lots(fg_lot_id),
  dispatched_qty numeric(18,6) NOT NULL CHECK (dispatched_qty > 0),
  dispatched_at timestamptz NOT NULL,
  dispatched_by text NOT NULL,
  UNIQUE (challan_document_id, source_line_id, fg_lot_id)
);
CREATE INDEX trace_dispatch_lot_time_idx ON trace_finished_goods_dispatch_allocations(fg_lot_id, dispatched_at);

CREATE TABLE trace_outsourcing_orders (
  outsource_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id text UNIQUE,
  process_type text NOT NULL,
  supplier_id uuid REFERENCES trace_suppliers(supplier_id),
  job_card_number text,
  status text NOT NULL,
  process_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trace_outsourcing_shipments (
  shipment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outsource_id uuid NOT NULL REFERENCES trace_outsourcing_orders(outsource_id),
  shipped_at timestamptz NOT NULL,
  document_number text NOT NULL,
  UNIQUE (outsource_id, document_number)
);
CREATE TABLE trace_outsourcing_shipment_lines (
  shipment_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES trace_outsourcing_shipments(shipment_id),
  batch_id uuid REFERENCES trace_inventory_batches(batch_id),
  wip_lot_id uuid REFERENCES trace_wip_lots(wip_lot_id),
  fg_lot_id uuid REFERENCES trace_finished_goods_lots(fg_lot_id),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  CHECK (num_nonnulls(batch_id, wip_lot_id, fg_lot_id) = 1)
);
CREATE TABLE trace_outsourcing_receipts (
  outsource_receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_line_id uuid NOT NULL REFERENCES trace_outsourcing_shipment_lines(shipment_line_id),
  received_qty numeric(18,6) NOT NULL CHECK (received_qty >= 0),
  accepted_qty numeric(18,6) NOT NULL CHECK (accepted_qty >= 0),
  rejected_qty numeric(18,6) NOT NULL CHECK (rejected_qty >= 0),
  received_at timestamptz NOT NULL,
  qc_status text NOT NULL,
  source_event_key text NOT NULL UNIQUE,
  CHECK (accepted_qty + rejected_qty <= received_qty)
);

CREATE TABLE trace_stock_movements (
  movement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES trace_inventory_batches(batch_id),
  wip_lot_id uuid REFERENCES trace_wip_lots(wip_lot_id),
  fg_lot_id uuid REFERENCES trace_finished_goods_lots(fg_lot_id),
  movement_type text NOT NULL CHECK (movement_type IN ('RECEIPT','ISSUE','RETURN','OUTSOURCE_OUT','OUTSOURCE_IN','TRANSFER_IN','TRANSFER_OUT','PRODUCTION_OUTPUT','WIP_OUTPUT','DISPATCH','ADJUSTMENT')),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  source_document_id text NOT NULL,
  source_line_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  source_event_id text NOT NULL,
  CHECK (num_nonnulls(batch_id, wip_lot_id, fg_lot_id) = 1),
  UNIQUE (movement_type, source_event_id)
);
CREATE INDEX trace_movements_batch_time_idx ON trace_stock_movements(batch_id, occurred_at);
CREATE INDEX trace_movements_wip_time_idx ON trace_stock_movements(wip_lot_id, occurred_at);
CREATE INDEX trace_movements_fg_time_idx ON trace_stock_movements(fg_lot_id, occurred_at);
CREATE INDEX trace_movements_source_idx ON trace_stock_movements(source_document_id, source_line_id);

-- Tie operational allocation facts to their one inventory posting. Consumption
-- is genealogy only: inventory was already reduced on ISSUE; do not post it again.
ALTER TABLE trace_inventory_batches ADD COLUMN receipt_movement_id uuid UNIQUE REFERENCES trace_stock_movements(movement_id);
ALTER TABLE trace_issue_allocations ADD COLUMN movement_id uuid UNIQUE REFERENCES trace_stock_movements(movement_id);
ALTER TABLE trace_return_allocations ADD COLUMN movement_id uuid UNIQUE REFERENCES trace_stock_movements(movement_id);
ALTER TABLE trace_outsourcing_shipment_lines ADD COLUMN movement_id uuid UNIQUE REFERENCES trace_stock_movements(movement_id);
ALTER TABLE trace_outsourcing_receipts ADD COLUMN movement_id uuid UNIQUE REFERENCES trace_stock_movements(movement_id);
ALTER TABLE trace_finished_goods_dispatch_allocations ADD COLUMN movement_id uuid UNIQUE REFERENCES trace_stock_movements(movement_id);

-- Server identity, authorization audit, request idempotency, and append-only audit.
-- role_key references the existing role/permission configuration by stable key;
-- no new roles or grants are created by this schema proposal.
CREATE TABLE trace_auth_identities (
  employee_key text PRIMARY KEY,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trace_auth_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_key text NOT NULL REFERENCES trace_auth_identities(employee_key),
  token_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE TABLE trace_idempotency_keys (
  idempotency_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_key text NOT NULL REFERENCES trace_auth_identities(employee_key),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_key, operation, idempotency_key)
);
CREATE TABLE trace_event_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  employee_key text NOT NULL,
  role_key text NOT NULL,
  permission_key text NOT NULL,
  operation text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_snapshot jsonb,
  after_snapshot jsonb,
  request_id text,
  CHECK (before_snapshot IS NOT NULL OR after_snapshot IS NOT NULL)
);
CREATE INDEX trace_audit_entity_time_idx ON trace_event_audit(entity_type, entity_id, occurred_at);

-- Cross-table quantity bounds (allocation <= issue, returns <= outstanding issue,
-- consumption <= net issue, dispatch <= accepted FG balance, received <= shipped)
-- require serialized service transactions with SELECT ... FOR UPDATE and deferred
-- constraint triggers. CHECK constraints cannot safely enforce aggregate sums.
-- Legacy document foreign keys remain source_document_id text references validated
-- by the service because current source documents are JSON/state structures.
--
-- Authoritative balance contract: trace_stock_movements is the sole on-hand
-- ledger for batch_id, wip_lot_id, or fg_lot_id. Its quantity is positive and
-- movement_type maps to a signed effect in one centralized SQL view/function:
-- RECEIPT/RETURN/OUTSOURCE_IN/TRANSFER_IN/PRODUCTION_OUTPUT/WIP_OUTPUT => +;
-- ISSUE/OUTSOURCE_OUT/TRANSFER_OUT/DISPATCH => -; ADJUSTMENT requires an audited
-- reason and explicit approval. Receipt/QC,
-- issue allocations, returns, outsourcing receipts, and dispatch records are
-- business facts linked to exactly one posting; none is independently added to
-- the on-hand sum. QC_ACCEPT does not itself post a second receipt. Production
-- consumption records are genealogy only because stock left on ISSUE. Posting
-- APIs must create the event and its movement in the same DB transaction and
-- reject retries through trace_idempotency_keys/source_event_id uniqueness.
-- Serialize balance-changing writes by locking the affected inventory entity
-- row (or a stable per-item/location lock) before checking its ledger balance.
--
-- Job Card/project/SO validation: every production output FK-targets a projected
-- Job Card and Sales Order line. Service must confirm source Job Card project_id,
-- sales_order_id, sales_order_line_id, item_code, project_id and customer match
-- the exact Sales Order/header line; ambiguous or missing links block output.
-- Dispatch service must confirm challan's customer equals both the Sales Order
-- customer and Job Card/FG provenance, and line item_code and unit equal the
-- Sales Order line and FG lot. Required constraints across rows need a deferred
-- trigger or transaction validation; don't accept a caller-supplied customer.
--
-- Returns and consumption: repeated partial return allocations and repeated
-- consumption events are allowed using unique event/idempotency keys. Under row
-- locks, cumulative returns must be <= allocated issue quantity minus already
-- consumed quantity; cumulative consumption must be <= issue quantity minus all
-- accepted returns. Allocation batch_id must equal referenced issue batch_id.
--
-- Identity/authorization: login validates a password hash server-side, resolves
-- the employee and current role using trusted server data, and checks the existing
-- role permission token for each operation. The database identity/session tables
-- store hashes only; no new role grant is inserted here. Append-only audit rows
-- record actor, resolved role, permission token, event, entity and before/after
-- snapshots. Application DB role should deny UPDATE/DELETE on audit rows.
--
-- Rollback: never DROP a trace table that has operational rows. Disable the
-- feature/API first, preserve its tables and audit ledger, and use a reviewed
-- forward correction or recovery restore after reconciling all writes since the
-- checkpoint. Do not reverse by deleting business history.
