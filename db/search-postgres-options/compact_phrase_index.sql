-- Equality-only phrase lookup can use a smaller hash index. Measure relation
-- sizes before/after on the actual archive; hash collisions are checked by PG.
CREATE INDEX IF NOT EXISTS search_title_compact_hash ON yutorah_search.search_title_terms USING hash((replace(term,' ','')));
DROP INDEX IF EXISTS yutorah_search.search_title_compact;
ANALYZE yutorah_search.search_title_terms;
