BEGIN;
ALTER TABLE transcription_operator_settings
  ADD COLUMN quota_resume_at timestamptz;
ALTER TABLE transcription_operator_settings
  ADD CONSTRAINT quota_resume_requires_enabled_worker
  CHECK (worker_enabled OR quota_resume_at IS NULL);
COMMIT;
