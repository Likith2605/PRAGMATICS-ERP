CREATE TABLE IF NOT EXISTS material_receipt_items (
  receipt_number text NOT NULL REFERENCES material_receipts(receipt_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  material_code text NOT NULL DEFAULT '',
  material_name text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'Nos',
  ordered_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (ordered_qty >= 0),
  received_qty numeric(18,4) NOT NULL CHECK (received_qty > 0),
  accepted_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  batch_number text NOT NULL DEFAULT '',
  internal_batch_id text NOT NULL DEFAULT '',
  lot_number text NOT NULL DEFAULT '',
  mfg_date text NOT NULL DEFAULT '',
  expiry_date text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (receipt_number,line_number),
  CHECK (accepted_qty + rejected_qty <= received_qty)
);
CREATE INDEX IF NOT EXISTS material_receipt_items_material_idx
  ON material_receipt_items(material_code,material_name,receipt_number);

-- Additive backfill from the preserved JSON document; no source rows or bytes are removed.
INSERT INTO material_receipt_items(
  receipt_number,line_number,material_code,material_name,unit,ordered_qty,received_qty,
  accepted_qty,rejected_qty,batch_number,internal_batch_id,lot_number,mfg_date,expiry_date,payload
)
SELECT r.receipt_number, line.ordinality::integer,
       COALESCE(line.value->>'materialCode',line.value->>'itemCode',''),
       COALESCE(line.value->>'materialName',line.value->>'itemName',''),
       COALESCE(NULLIF(line.value->>'unit',''),'Nos'),
       CASE WHEN COALESCE(line.value->>'orderedQty','') ~ '^[0-9]+([.][0-9]+)?$' THEN (line.value->>'orderedQty')::numeric ELSE 0 END,
       CASE WHEN COALESCE(line.value->>'receivedQty','') ~ '^[0-9]+([.][0-9]+)?$' THEN (line.value->>'receivedQty')::numeric ELSE 0 END,
       CASE WHEN COALESCE(line.value->>'acceptedQty','0') ~ '^[0-9]+([.][0-9]+)?$' THEN (COALESCE(line.value->>'acceptedQty','0'))::numeric ELSE 0 END,
       CASE WHEN COALESCE(line.value->>'rejectedQty','0') ~ '^[0-9]+([.][0-9]+)?$' THEN (COALESCE(line.value->>'rejectedQty','0'))::numeric ELSE 0 END,
       COALESCE(line.value->>'batchNumber',''),COALESCE(line.value->>'internalBatchId',''),
       COALESCE(line.value->>'lotNumber',''),COALESCE(line.value->>'mfgDate',''),
       COALESCE(line.value->>'expiryDate',''),line.value
FROM material_receipts r
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload->'items')='array' THEN r.payload->'items' ELSE '[]'::jsonb END) WITH ORDINALITY AS line(value,ordinality)
WHERE COALESCE(line.value->>'receivedQty','') ~ '^[0-9]+([.][0-9]+)?$'
  AND (line.value->>'receivedQty')::numeric > 0
  AND COALESCE(line.value->>'acceptedQty','0') ~ '^[0-9]+([.][0-9]+)?$'
  AND COALESCE(line.value->>'rejectedQty','0') ~ '^[0-9]+([.][0-9]+)?$'
  AND (COALESCE(line.value->>'acceptedQty','0'))::numeric + (COALESCE(line.value->>'rejectedQty','0'))::numeric <= (line.value->>'receivedQty')::numeric
ON CONFLICT (receipt_number,line_number) DO NOTHING;
