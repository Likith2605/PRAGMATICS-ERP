-- First database-backed procurement intake records. Full JSON payloads preserve
-- existing UI data while indexed references support safe workflow queries.
CREATE TABLE IF NOT EXISTS purchase_indents (
  indent_number text PRIMARY KEY,
  so_number text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Draft',
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
CREATE UNIQUE INDEX IF NOT EXISTS purchase_indents_create_token_idx
  ON purchase_indents(create_token) WHERE create_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_indents_status_idx
  ON purchase_indents(status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS purchase_indents_so_idx
  ON purchase_indents(so_number) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS vendor_enquiries (
  enquiry_number text PRIMARY KEY,
  indent_number text NOT NULL DEFAULT '',
  pr_number text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Draft',
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT '',
  CONSTRAINT vendor_enquiries_indent_fk FOREIGN KEY (indent_number)
    REFERENCES purchase_indents(indent_number) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_enquiries_create_token_idx
  ON vendor_enquiries(create_token) WHERE create_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vendor_enquiries_active_indent_idx
  ON vendor_enquiries(indent_number) WHERE indent_number <> '' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vendor_enquiries_status_idx
  ON vendor_enquiries(status, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS vendor_quotations (
  quotation_number text PRIMARY KEY,
  enquiry_number text NOT NULL REFERENCES vendor_enquiries(enquiry_number) ON DELETE RESTRICT,
  vendor_id text NOT NULL DEFAULT '',
  vendor_name text NOT NULL,
  status text NOT NULL DEFAULT 'Received',
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
CREATE UNIQUE INDEX IF NOT EXISTS vendor_quotations_create_token_idx
  ON vendor_quotations(create_token) WHERE create_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vendor_quotations_enquiry_vendor_idx
  ON vendor_quotations(enquiry_number, lower(vendor_id))
  WHERE vendor_id <> '' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vendor_quotations_enquiry_idx
  ON vendor_quotations(enquiry_number, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS procurement_sequences (
  sequence_key text PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS procurement_record_audit (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('purchaseIndent','vendorEnquiry','vendorQuotation')),
  record_id text NOT NULL,
  actor_id text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS procurement_record_audit_record_idx
  ON procurement_record_audit(entity_type, record_id, created_at DESC);
