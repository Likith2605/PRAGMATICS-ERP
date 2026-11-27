-- Immutable evidence for an explicit trusted-original checksum verification.
CREATE TABLE IF NOT EXISTS file_checksum_verifications (
  id bigserial PRIMARY KEY,
  file_id text NOT NULL,
  content_checksum_sha256 text NOT NULL,
  verified_by text NOT NULL,
  verified_by_email text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verification_method text NOT NULL,
  verification_reference text NOT NULL
);

CREATE INDEX IF NOT EXISTS file_checksum_verifications_file_idx
  ON file_checksum_verifications (file_id, verified_at DESC);
