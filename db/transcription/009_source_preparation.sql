BEGIN;
CREATE TABLE source_preparation_jobs (
  shiur_id text NOT NULL REFERENCES transcription_shiurim(id) ON DELETE CASCADE,
  version text NOT NULL,
  transcript_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt integer NOT NULL DEFAULT 0,
  owner uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  error text,
  PRIMARY KEY (shiur_id,version)
);
CREATE INDEX source_preparation_pending ON source_preparation_jobs(available_at) WHERE completed_at IS NULL;
COMMIT;
