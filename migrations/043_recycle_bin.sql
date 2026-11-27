-- Central Recycle Bin support.
--
-- Every authoritative module keeps its own tombstone (deleted_at/deleted_by/
-- delete_reason). The Recycle Bin API reads those existing tombstones directly;
-- no duplicate registry table is needed. These partial indexes keep the
-- "deleted records only" scans cheap without affecting live-record queries.
CREATE INDEX IF NOT EXISTS quotations_recycle_bin_idx
  ON quotations (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_purchase_orders_recycle_bin_idx
  ON customer_purchase_orders (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_orders_recycle_bin_idx
  ON sales_orders (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_challans_recycle_bin_idx
  ON delivery_challans (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_invoices_recycle_bin_idx
  ON customer_invoices (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS export_invoices_recycle_bin_idx
  ON export_invoices (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_indents_recycle_bin_idx
  ON purchase_indents (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendor_enquiries_recycle_bin_idx
  ON vendor_enquiries (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendor_quotations_recycle_bin_idx
  ON vendor_quotations (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_orders_recycle_bin_idx
  ON purchase_orders (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_invoices_recycle_bin_idx
  ON supplier_invoices (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS material_receipts_recycle_bin_idx
  ON material_receipts (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS material_requests_recycle_bin_idx
  ON material_requests (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_issues_recycle_bin_idx
  ON store_issues (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_returns_recycle_bin_idx
  ON store_returns (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_items_recycle_bin_idx
  ON inventory_items (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS debit_notes_recycle_bin_idx
  ON debit_notes (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_requirements_recycle_bin_idx
  ON production_requirements (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_cards_recycle_bin_idx
  ON job_cards (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bom_headers_recycle_bin_idx
  ON bom_headers (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ht_outsource_requests_recycle_bin_idx
  ON ht_outsource_requests (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_recycle_bin_idx
  ON customers (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendors_recycle_bin_idx
  ON vendors (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS machines_recycle_bin_idx
  ON machines (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS uom_master_recycle_bin_idx
  ON uom_master (deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS material_master_recycle_bin_idx
  ON material_master (deleted_at DESC) WHERE deleted_at IS NOT NULL;
