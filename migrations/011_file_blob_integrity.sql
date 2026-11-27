-- Add integrity and uploader metadata without rewriting or removing files.
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS checksum_sha256 text;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS uploaded_by text;

CREATE INDEX IF NOT EXISTS file_blobs_checksum_idx ON file_blobs (checksum_sha256);
