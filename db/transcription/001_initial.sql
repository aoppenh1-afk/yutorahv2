BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE transcription_versions (
  id text PRIMARY KEY,
  pipeline_version text NOT NULL,
  skill_hash text NOT NULL CHECK (length(skill_hash) = 64),
  skill_text text NOT NULL,
  model text NOT NULL,
  runtime text NOT NULL,
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transcription_shiurim (
  id text PRIMARY KEY CHECK (id ~ '^[0-9]{1,12}$'),
  title text NOT NULL,
  teacher text NOT NULL,
  media_url text,
  latest_job_id uuid,
  active_transcript_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transcription_jobs (
  id uuid PRIMARY KEY,
  shiur_id text NOT NULL REFERENCES transcription_shiurim(id) ON DELETE CASCADE,
  transcription_version text NOT NULL REFERENCES transcription_versions(id),
  source_revision text NOT NULL,
  source_url text,
  skill_hash text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','downloading','preparing','transcribing','merging','completed','failed','cancelled')),
  priority integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  error jsonb,
  audio_hash text,
  fingerprint text,
  manifest jsonb,
  manifest_digest text,
  UNIQUE (shiur_id, transcription_version, source_revision)
);
CREATE INDEX transcription_jobs_queue ON transcription_jobs (priority DESC, available_at, created_at) WHERE status = 'queued';
CREATE INDEX transcription_jobs_expired ON transcription_jobs (lease_until) WHERE status IN ('downloading','preparing','transcribing','merging');
CREATE TABLE transcription_chunks (
  job_id uuid NOT NULL REFERENCES transcription_jobs(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  payload jsonb NOT NULL,
  digest text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, fingerprint, chunk_index)
);
CREATE TABLE transcripts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES transcription_jobs(id) ON DELETE CASCADE,
  shiur_id text NOT NULL REFERENCES transcription_shiurim(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1,
  duration_ms bigint NOT NULL CHECK (duration_ms > 0),
  text text NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transcript_segments (
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  shiur_id text NOT NULL REFERENCES transcription_shiurim(id) ON DELETE CASCADE,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  start_ms bigint NOT NULL CHECK (start_ms >= 0),
  end_ms bigint NOT NULL CHECK (end_ms >= start_ms),
  speaker text,
  language text,
  text text NOT NULL CHECK (length(text) > 0),
  search_text text NOT NULL,
  search_window text NOT NULL,
  search_tokens tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  PRIMARY KEY (transcript_id, segment_index)
);
CREATE INDEX transcript_segments_literal ON transcript_segments USING gin (search_window gin_trgm_ops);
CREATE INDEX transcript_segments_tokens ON transcript_segments USING gin (search_tokens);
ALTER TABLE transcription_shiurim ADD FOREIGN KEY (latest_job_id) REFERENCES transcription_jobs(id) ON DELETE SET NULL;
ALTER TABLE transcription_shiurim ADD FOREIGN KEY (active_transcript_id) REFERENCES transcripts(id) ON DELETE SET NULL;
COMMIT;
