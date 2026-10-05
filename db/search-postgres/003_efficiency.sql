-- Apply with the schema owner before deploying. Query caches remain resumable.
ALTER TABLE yutorah_search.search_runs ADD COLUMN IF NOT EXISTS scanned integer NOT NULL DEFAULT 0;
ALTER TABLE yutorah_search.search_hits ADD COLUMN IF NOT EXISTS document_key text;
ALTER TABLE yutorah_search.search_hits ADD COLUMN IF NOT EXISTS views double precision NOT NULL DEFAULT 0;
UPDATE yutorah_search.search_runs r SET scanned=(SELECT COUNT(*) FROM yutorah_search.search_hits h WHERE h.run=r.id) WHERE r.scanned=0 AND r.next>1;
UPDATE yutorah_search.search_hits SET views=COALESCE((payload::jsonb->>'views')::double precision,0) WHERE document_key IS NULL AND views=0;
CREATE TABLE IF NOT EXISTS yutorah_search.search_documents (key text PRIMARY KEY,payload text NOT NULL,created bigint NOT NULL);
CREATE TABLE IF NOT EXISTS yutorah_search.search_creation_leases (fingerprint text PRIMARY KEY,owner text NOT NULL,expires bigint NOT NULL);
CREATE INDEX IF NOT EXISTS search_hits_document ON yutorah_search.search_hits(document_key);
CREATE INDEX IF NOT EXISTS search_hits_position ON yutorah_search.search_hits(run,position,id);
CREATE INDEX IF NOT EXISTS search_hits_popular ON yutorah_search.search_hits(run,views DESC,rank DESC,id DESC);
-- Allow PostgreSQL to compress/outsource long derived term arrays. Preserve the
-- JavaScript Unicode tokenizer rather than replacing it with a different one.
ALTER TABLE yutorah_search.search_title_catalog ALTER COLUMN terms SET STORAGE EXTENDED;
ALTER TABLE yutorah_search.search_title_catalog SET (toast_tuple_target=2048);

CREATE TABLE IF NOT EXISTS yutorah_search.search_cache_usage (name text PRIMARY KEY,bytes bigint NOT NULL DEFAULT 0);
INSERT INTO yutorah_search.search_cache_usage(name,bytes) SELECT 'documents',COALESCE(SUM(octet_length(payload)),0) FROM yutorah_search.search_documents ON CONFLICT(name) DO NOTHING;
CREATE OR REPLACE FUNCTION yutorah_search.count_search_documents() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM changed) THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' THEN
   UPDATE yutorah_search.search_cache_usage SET bytes=bytes+(SELECT COALESCE(SUM(octet_length(payload)),0) FROM changed) WHERE name='documents' RETURNING bytes INTO used;
   IF used>67108864 THEN RAISE EXCEPTION 'Search cache capacity reached'; END IF;
 ELSE UPDATE yutorah_search.search_cache_usage SET bytes=bytes-(SELECT COALESCE(SUM(octet_length(payload)),0) FROM changed) WHERE name='documents'; END IF;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS search_document_added ON yutorah_search.search_documents;
CREATE TRIGGER search_document_added AFTER INSERT ON yutorah_search.search_documents REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION yutorah_search.count_search_documents();
DROP TRIGGER IF EXISTS search_document_removed ON yutorah_search.search_documents;
CREATE TRIGGER search_document_removed AFTER DELETE ON yutorah_search.search_documents REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION yutorah_search.count_search_documents();
-- Mirror each existing search-run privilege on the new cache tables. Read-only
-- roles remain read-only; the website writer retains its existing CRUD scope.
DO $$ DECLARE permission record; BEGIN
 FOR permission IN SELECT DISTINCT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='yutorah_search' AND table_name='search_runs' AND grantee<>'PUBLIC'
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
 LOOP EXECUTE format('GRANT %s ON yutorah_search.search_documents,yutorah_search.search_creation_leases,yutorah_search.search_cache_usage TO %I',permission.privilege_type,permission.grantee);
 END LOOP;
END $$;
