BEGIN;
ALTER TABLE notes_jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX notes_jobs_available ON notes_jobs(available_at,created_at) WHERE status='queued';
COMMIT;
