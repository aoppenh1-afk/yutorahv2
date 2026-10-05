-- Apply once with the search schema's migration owner before deploying.
-- The expression index also covers every title already in the archive.
CREATE INDEX IF NOT EXISTS search_title_autocomplete
ON yutorah_search.search_title_catalog USING gin (to_tsvector('simple', title));
