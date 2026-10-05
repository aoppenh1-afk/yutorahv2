-- Optional: enable TRANSCRIPT_ARCHIVE_ONLY_SEARCH=true on the worker first.
-- This removes rebuildable PostgreSQL search data; raw text/timing stays intact.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM transcription_shiurim h LEFT JOIN transcript_publications p ON p.shiur_id=h.id
   WHERE h.active_transcript_id IS NOT NULL AND (p.shiur_id IS NULL OR p.generation<>p.published_generation OR p.content_changed))
 THEN RAISE EXCEPTION 'Publish every active transcript before removing PostgreSQL search indexes'; END IF;
END $$;
DROP TRIGGER IF EXISTS transcript_search_words_insert ON transcript_segments;
DROP INDEX IF EXISTS transcript_segments_literal;
DROP INDEX IF EXISTS transcript_segments_tokens;
DROP INDEX IF EXISTS transcript_segments_window_tokens;
DROP INDEX IF EXISTS transcript_search_words_trigrams;
ALTER TABLE transcript_segments DROP COLUMN IF EXISTS search_tokens;
ALTER TABLE transcript_segments DROP COLUMN IF EXISTS search_window_tokens;
COMMIT;
