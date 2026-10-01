BEGIN;
CREATE TABLE transcription_targets (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('teacher','series')),
  upstream_id text NOT NULL CHECK (upstream_id ~ '^[0-9]{1,12}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  teacher_filter text CHECK (teacher_filter ~ '^[0-9]{1,12}$'),
  CHECK (kind='series' OR teacher_filter IS NULL),
  enabled boolean NOT NULL DEFAULT true,
  recording_limit integer NOT NULL DEFAULT 10 CHECK (recording_limit BETWEEN 1 AND 10000),
  next_page integer NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  page_offset integer NOT NULL DEFAULT 0 CHECK (page_offset BETWEEN 0 AND 30),
  archive_complete boolean NOT NULL DEFAULT false,
  upstream_total integer,
  last_scan_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,upstream_id)
);
CREATE TABLE transcription_target_jobs (
  target_id uuid NOT NULL REFERENCES transcription_targets(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES transcription_jobs(id) ON DELETE CASCADE,
  PRIMARY KEY(target_id,job_id)
);
CREATE INDEX transcription_target_jobs_job ON transcription_target_jobs(job_id);
CREATE TABLE transcription_operator_settings (
  id integer PRIMARY KEY CHECK (id=1),
  model text NOT NULL,
  notes_enabled boolean NOT NULL DEFAULT true,
  worker_enabled boolean NOT NULL DEFAULT false
);
INSERT INTO transcription_operator_settings(id,model) VALUES(1,'gemini-3.8-flash-high');
CREATE TABLE notes_versions (
  id text PRIMARY KEY,
  model text NOT NULL,
  language text NOT NULL CHECK (language IN ('english','hebrewEnglish')),
  runtime text NOT NULL,
  transcription_skill text NOT NULL,
  notes_skill text NOT NULL
);
CREATE TABLE notes_jobs (
  id uuid PRIMARY KEY,
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  version_id text NOT NULL REFERENCES notes_versions(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','cleaning','generating','completed','failed','cancelled')),
  cleaned_text text,
  attempt integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(transcript_id,version_id)
);
CREATE INDEX notes_jobs_queue ON notes_jobs(created_at) WHERE status='queued';
CREATE TABLE transcript_notes (
  id uuid PRIMARY KEY REFERENCES notes_jobs(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='yutorah-search') THEN
    GRANT SELECT ON transcripts,transcript_notes,notes_jobs TO "yutorah-search";
  END IF;
END $$;
COMMIT;
