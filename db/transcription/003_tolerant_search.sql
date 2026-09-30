BEGIN;
-- A compact, corpus-derived spelling vocabulary. No transcript scan at query time.
CREATE TABLE transcript_search_words (
  word text PRIMARY KEY CHECK (length(word) BETWEEN 3 AND 64)
);
CREATE INDEX transcript_search_words_trigrams ON transcript_search_words USING gin (word gin_trgm_ops);

INSERT INTO transcript_search_words(word)
SELECT DISTINCT word FROM transcript_segments,
LATERAL unnest(tsvector_to_array(search_tokens)) AS token(word)
WHERE length(word) BETWEEN 3 AND 64
ON CONFLICT DO NOTHING;

CREATE FUNCTION remember_transcript_search_words() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO transcript_search_words(word)
  SELECT word FROM unnest(tsvector_to_array(NEW.search_tokens)) AS token(word)
  WHERE length(word) BETWEEN 3 AND 64
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transcript_search_words_insert AFTER INSERT OR UPDATE OF search_text
ON transcript_segments FOR EACH ROW EXECUTE FUNCTION remember_transcript_search_words();

-- Windows allow a match to straddle adjacent segments. Search still anchors the
-- timestamp in a segment that actually contains one of the requested words.
ALTER TABLE transcript_segments ADD COLUMN search_window_tokens tsvector
GENERATED ALWAYS AS (to_tsvector('simple', search_window)) STORED;
CREATE INDEX transcript_segments_window_tokens ON transcript_segments USING gin (search_window_tokens);

-- Preserve access for the read-only role used by existing deployments. New
-- installations create the role after migration and grant SELECT during setup.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yutorah-search') THEN
    GRANT SELECT ON transcript_search_words TO "yutorah-search";
  END IF;
END $$;
COMMIT;
