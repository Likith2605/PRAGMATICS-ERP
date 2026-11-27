CREATE UNIQUE INDEX IF NOT EXISTS purchase_indents_active_material_request_uq
  ON purchase_indents ((payload->>'requirementNumber'))
  WHERE deleted_at IS NULL AND payload->>'sourceType'='materialRequest' AND COALESCE(payload->>'requirementNumber','')<>'';

CREATE UNIQUE INDEX IF NOT EXISTS purchase_indents_active_repurchase_uq
  ON purchase_indents ((payload->>'repurchaseFor'))
  WHERE deleted_at IS NULL AND COALESCE(payload->>'repurchaseFor','')<>'';
