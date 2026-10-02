-- Separate ownership and grants keep the public search writer out of the
-- transcription database. Apply with the migration connection, never the reader.
CREATE SCHEMA IF NOT EXISTS yutorah_search;

CREATE TABLE IF NOT EXISTS yutorah_search.search_runs (
  id text PRIMARY KEY, fingerprint text NOT NULL, plan text NOT NULL,
  total integer NOT NULL, next integer NOT NULL DEFAULT 1,
  created bigint NOT NULL, lease bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS search_runs_fingerprint ON yutorah_search.search_runs (fingerprint,created);
CREATE TABLE IF NOT EXISTS yutorah_search.search_hits (
  run text NOT NULL REFERENCES yutorah_search.search_runs(id) ON DELETE CASCADE,
  id integer NOT NULL, payload text NOT NULL, matched integer NOT NULL,
  rank double precision NOT NULL, date double precision NOT NULL,
  duration double precision NOT NULL, title text NOT NULL, position integer NOT NULL,
  search text NOT NULL DEFAULT '', language text NOT NULL DEFAULT '', format text NOT NULL DEFAULT '',
  PRIMARY KEY(run,id)
);
CREATE INDEX IF NOT EXISTS search_hits_rank ON yutorah_search.search_hits (run,rank);
CREATE INDEX IF NOT EXISTS search_hits_date ON yutorah_search.search_hits (run,date);
CREATE INDEX IF NOT EXISTS search_hits_duration ON yutorah_search.search_hits (run,duration);
CREATE INDEX IF NOT EXISTS search_hits_title ON yutorah_search.search_hits (run,title);
CREATE TABLE IF NOT EXISTS yutorah_search.search_title_catalog (
  id integer PRIMARY KEY, title text NOT NULL, terms text NOT NULL
) WITH (toast_tuple_target=128);
ALTER TABLE yutorah_search.search_title_catalog ALTER COLUMN terms SET STORAGE MAIN;
CREATE TABLE IF NOT EXISTS yutorah_search.search_title_terms (
  term text COLLATE "C" PRIMARY KEY, words integer NOT NULL, documents integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS search_title_compact ON yutorah_search.search_title_terms ((replace(term,' ','')));
CREATE TABLE IF NOT EXISTS yutorah_search.search_title_word_keys (
  term text COLLATE "C" PRIMARY KEY REFERENCES yutorah_search.search_title_terms(term),
  prefix text COLLATE "C" NOT NULL, keys text[] NOT NULL
);
CREATE INDEX IF NOT EXISTS search_word_prefix ON yutorah_search.search_title_word_keys (prefix);
CREATE INDEX IF NOT EXISTS search_word_deletions ON yutorah_search.search_title_word_keys USING gin (keys) WITH (fastupdate=off);
CREATE OR REPLACE VIEW yutorah_search.search_title_keys AS
SELECT 'j:'||replace(term,' ','') AS key,term FROM yutorah_search.search_title_terms
UNION ALL SELECT prefix AS key,term FROM yutorah_search.search_title_word_keys
UNION ALL SELECT unnest(keys) AS key,term FROM yutorah_search.search_title_word_keys;

CREATE OR REPLACE FUNCTION yutorah_search.insert_spelling_keys(entries text) RETURNS integer
LANGUAGE plpgsql SET search_path = yutorah_search, pg_catalog AS $$
DECLARE changed integer;
BEGIN
  INSERT INTO search_title_word_keys (term,prefix,keys)
    SELECT term,COALESCE(max(key) FILTER (WHERE key LIKE 'p:%'),'p:'||left(term,3)),
      COALESCE(array_agg(DISTINCT key ORDER BY key) FILTER (WHERE key LIKE 'd:%'),ARRAY[]::text[])
    FROM (SELECT value->>0 AS key,value->>1 AS term FROM jsonb_array_elements(entries::jsonb)) AS incoming
    WHERE key LIKE 'd:%' OR key LIKE 'p:%' GROUP BY term
    ON CONFLICT(term) DO UPDATE SET keys=(
      SELECT array_agg(DISTINCT key ORDER BY key)
      FROM unnest(search_title_word_keys.keys||excluded.keys) AS key
    ) WHERE NOT search_title_word_keys.keys @> excluded.keys;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
CREATE OR REPLACE FUNCTION yutorah_search.insert_title_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = yutorah_search, pg_catalog AS $$
BEGIN
  PERFORM insert_spelling_keys(jsonb_build_array(jsonb_build_array(NEW.key,NEW.term))::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS search_key_insert ON yutorah_search.search_title_keys;
CREATE TRIGGER search_key_insert INSTEAD OF INSERT ON yutorah_search.search_title_keys
FOR EACH ROW EXECUTE FUNCTION yutorah_search.insert_title_key();

-- Match the shared lookup without materializing millions of key rows. Compact
-- phrase and prefix lookups use B-trees; word deletion keys use an inverted index.
CREATE OR REPLACE FUNCTION yutorah_search.spelling_candidates(entries text)
RETURNS TABLE(term text,words integer,documents integer)
LANGUAGE sql STABLE SET search_path = yutorah_search, pg_catalog AS $$
WITH requested AS (
  SELECT DISTINCT value->>'key' AS key,(value->>'slot')::integer AS slot
  FROM jsonb_array_elements(entries::jsonb)
), found AS (
  SELECT r.slot,t.term,t.words,t.documents FROM requested r
  JOIN search_title_terms t ON replace(t.term,' ','')=substring(r.key from 3)
  WHERE left(r.key,2)='j:'
  UNION ALL
  SELECT r.slot,t.term,t.words,t.documents FROM requested r
  JOIN search_title_word_keys k ON k.prefix=r.key
  JOIN search_title_terms t ON t.term=k.term WHERE left(r.key,2)='p:'
  UNION ALL
  SELECT r.slot,t.term,t.words,t.documents FROM requested r
  JOIN search_title_word_keys k ON k.keys @> ARRAY[r.key]
  JOIN search_title_terms t ON t.term=k.term WHERE left(r.key,2)='d:'
), candidates AS (
  SELECT slot,term,words,documents,count(*) AS overlap FROM found
  WHERE documents>0 GROUP BY slot,term,words,documents
), ranked AS (
  SELECT *,row_number() OVER (PARTITION BY slot ORDER BY overlap DESC,documents DESC,term) AS position
  FROM candidates
) SELECT term,words,documents FROM ranked WHERE slot=-1 OR position<=64
$$;
CREATE TABLE IF NOT EXISTS yutorah_search.search_title_cursors (
  name text PRIMARY KEY, next integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS yutorah_search.search_title_imports (
  name text PRIMARY KEY, minimum integer NOT NULL, maximum integer NOT NULL,
  next integer NOT NULL, total integer NOT NULL, scanned integer NOT NULL DEFAULT 0,
  started bigint NOT NULL, completed bigint NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION yutorah_search.title_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = yutorah_search, pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE search_title_terms SET documents=documents-1
      WHERE term IN (SELECT jsonb_array_elements_text(OLD.terms::jsonb));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO search_title_terms (term,words,documents)
      SELECT value,1+length(value)-length(replace(value,' ','')),1
      FROM jsonb_array_elements_text(NEW.terms::jsonb) AS value
      ON CONFLICT(term) DO UPDATE SET documents=search_title_terms.documents+1;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
-- Reapply safely without disturbing catalog data.
DROP TRIGGER IF EXISTS search_title_changes ON yutorah_search.search_title_catalog;
CREATE TRIGGER search_title_changes AFTER INSERT OR UPDATE OR DELETE
ON yutorah_search.search_title_catalog FOR EACH ROW EXECUTE FUNCTION yutorah_search.title_changed();

-- Compatibility functions for the shared module's bounded SQLite SQL vocabulary.
CREATE OR REPLACE FUNCTION yutorah_search.json_each(document text)
RETURNS TABLE(value jsonb) LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_array_elements(document::jsonb)
$$;
CREATE OR REPLACE FUNCTION yutorah_search.json_extract(document jsonb, field text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT document #>> CASE WHEN field ~ '^\$\[[0-9]+\]$'
    THEN ARRAY[substring(field from 3 for length(field)-3)]
    ELSE string_to_array(substring(field from 3),'.') END
$$;
CREATE OR REPLACE FUNCTION yutorah_search.json_extract(document text, field text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT yutorah_search.json_extract(document::jsonb,field)
$$;
CREATE OR REPLACE FUNCTION yutorah_search.instr(haystack text, needle text)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT position(needle in haystack)
$$;
