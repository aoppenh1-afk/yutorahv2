BEGIN;
CREATE TABLE transcription_catalog_cursors (
  name text PRIMARY KEY,
  next_page integer NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  last_complete_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO transcription_catalog_cursors(name) VALUES ('recent'), ('backfill');
COMMIT;
