-- Additional performance indexes for ERP state and ballooning tables.
-- All operations use IF NOT EXISTS so this migration is safe to apply
-- against a database that already has some of these indexes.

-- erp_state: speed up partial-key lookups (e.g. prefix queries for module keys)
CREATE INDEX IF NOT EXISTS erp_state_key_prefix_idx
  ON erp_state (storage_key text_pattern_ops);

-- ballooning_projects: filter by status (Draft / Under Review / Approved)
CREATE INDEX IF NOT EXISTS ballooning_projects_status_idx
  ON ballooning_projects ((data->>'status'));

-- ballooning_projects: filter/sort by drawingNumber for search
CREATE INDEX IF NOT EXISTS ballooning_projects_drawing_no_idx
  ON ballooning_projects ((data->>'drawingNumber'));

-- ballooning_balloons: ordering by drawing + number for fast per-drawing retrieval
CREATE INDEX IF NOT EXISTS ballooning_balloons_drawing_number_idx
  ON ballooning_balloons (drawing_id, number);

-- ballooning_characteristics: fast lookup by balloon
CREATE INDEX IF NOT EXISTS ballooning_characteristics_balloon_idx
  ON ballooning_characteristics (balloon_id);

-- schema_migrations: already has a PK, no extra index needed.
