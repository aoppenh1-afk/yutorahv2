ALTER TABLE search_runs ADD COLUMN scanned integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE search_hits ADD COLUMN document_key text;
--> statement-breakpoint
ALTER TABLE search_hits ADD COLUMN views real NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE search_runs SET scanned=(SELECT COUNT(*) FROM search_hits WHERE run=search_runs.id) WHERE scanned=0 AND next>1;
--> statement-breakpoint
UPDATE search_hits SET views=COALESCE(json_extract(payload,'$.views'),0) WHERE document_key IS NULL AND views=0;
--> statement-breakpoint
CREATE TABLE search_documents (key text PRIMARY KEY,payload text NOT NULL,created integer NOT NULL);
--> statement-breakpoint
CREATE TABLE search_creation_leases (fingerprint text PRIMARY KEY,owner text NOT NULL,expires integer NOT NULL);
--> statement-breakpoint
CREATE INDEX search_hits_document ON search_hits(document_key);
--> statement-breakpoint
CREATE INDEX search_hits_position ON search_hits(run,position,id);
--> statement-breakpoint
CREATE INDEX search_hits_popular ON search_hits(run,views DESC,rank DESC,id DESC);

--> statement-breakpoint
CREATE TABLE search_cache_usage (name text PRIMARY KEY,bytes integer NOT NULL DEFAULT 0);
--> statement-breakpoint
INSERT INTO search_cache_usage(name,bytes) VALUES('documents',0);
--> statement-breakpoint
CREATE TRIGGER search_document_added AFTER INSERT ON search_documents BEGIN
 UPDATE search_cache_usage SET bytes=bytes+length(CAST(new.payload AS BLOB)) WHERE name='documents';
 SELECT CASE WHEN (SELECT bytes FROM search_cache_usage WHERE name='documents')>67108864 THEN RAISE(ABORT,'Search cache capacity reached') END;
END;
--> statement-breakpoint
CREATE TRIGGER search_document_removed AFTER DELETE ON search_documents BEGIN
 UPDATE search_cache_usage SET bytes=bytes-length(CAST(old.payload AS BLOB)) WHERE name='documents';
END;
