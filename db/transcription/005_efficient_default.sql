BEGIN;
-- Initialize new, unused operators at medium. Preserve an existing account's
-- saved preference; changing it in the operator updates compatible untouched jobs.
UPDATE transcription_operator_settings
SET model='gemini-3.8-flash-medium'
WHERE model='gemini-3.8-flash-high'
  AND NOT worker_enabled
  AND NOT EXISTS (SELECT 1 FROM transcription_jobs);
COMMIT;
