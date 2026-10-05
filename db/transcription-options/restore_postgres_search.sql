-- Rebuild derived search data before disabling TRANSCRIPT_ARCHIVE_ONLY_SEARCH.
BEGIN;
ALTER TABLE transcript_segments ADD COLUMN search_tokens tsvector GENERATED ALWAYS AS (to_tsvector('simple',search_text)) STORED;
ALTER TABLE transcript_segments ADD COLUMN search_window_tokens tsvector GENERATED ALWAYS AS (to_tsvector('simple',search_window)) STORED;
CREATE INDEX transcript_segments_literal ON transcript_segments USING gin(search_window gin_trgm_ops);
CREATE INDEX transcript_segments_tokens ON transcript_segments USING gin(search_tokens);
CREATE INDEX transcript_segments_window_tokens ON transcript_segments USING gin(search_window_tokens);
CREATE INDEX transcript_search_words_trigrams ON transcript_search_words USING gin(word gin_trgm_ops);
INSERT INTO transcript_search_words(word) SELECT DISTINCT word FROM transcript_segments,LATERAL unnest(tsvector_to_array(search_tokens)) AS token(word) WHERE length(word) BETWEEN 3 AND 64 ON CONFLICT DO NOTHING;
CREATE TRIGGER transcript_search_words_insert AFTER INSERT OR UPDATE OF search_text ON transcript_segments FOR EACH ROW EXECUTE FUNCTION remember_transcript_search_words();
COMMIT;
