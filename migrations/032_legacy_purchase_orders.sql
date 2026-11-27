-- Explicit Admin imports of legacy Purchase Orders (spreadsheet import and the
-- preserved supplierPOHistory migration preview) predate the Vendor Quotation
-- workflow, so they carry no quotation reference. Quoted Purchase Orders keep
-- their NOT NULL + UNIQUE quotation linkage; only explicitly imported legacy
-- rows store a NULL quotation number, which PostgreSQL allows repeatedly.
ALTER TABLE purchase_orders ALTER COLUMN quotation_number DROP NOT NULL;

-- Imported legacy rows are measured by the same reconciliation path as rows
-- created from an accepted Vendor Quotation.
CREATE INDEX IF NOT EXISTS purchase_orders_progress_idx
  ON purchase_orders ((payload->'progress'->>'status')) WHERE deleted_at IS NULL;
