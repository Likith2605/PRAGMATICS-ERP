-- Authoritative soft-delete metadata for Inventory items.
-- Material Requests already carry deleted_at / deleted_by / delete_reason from 033.

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS delete_reason text NOT NULL DEFAULT '';
