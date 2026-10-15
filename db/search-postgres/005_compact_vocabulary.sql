-- Equality lookups retain every term. PostgreSQL rechecks hash collisions.
CREATE INDEX IF NOT EXISTS search_title_compact_hash
ON yutorah_search.search_title_terms USING hash ((replace(term,' ','')));
DROP INDEX IF EXISTS yutorah_search.search_title_compact;

-- Regenerate the common term list. The JavaScript-supplied list remains the
-- authority: any Unicode/locale difference is stored as an exception, never lost.
CREATE OR REPLACE FUNCTION yutorah_search.title_terms(title text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $$
DECLARE normalized text; tokens text[]; terms text[] := ARRAY[]::text[];
        term text; i integer; width integer; units integer;
BEGIN
  normalized := normalize(title,NFKD);
  normalized := regexp_replace(normalized,U&'[\0300-\036f\0591-\05c7\200e\200f\202a-\202e\2066-\2069]','','g');
  normalized := lower(normalized);
  normalized := regexp_replace(normalized,'[''’"״׳]','','g');
  normalized := btrim(regexp_replace(normalized,'[^[:alnum:]]+',' ','g'));
  IF normalized='' THEN RETURN '[]'; END IF;
  tokens := (string_to_array(normalized,' '))[1:80];
  FOR i IN 1..cardinality(tokens) LOOP
    FOR width IN 1..LEAST(3,cardinality(tokens)-i+1) LOOP
      IF EXISTS (SELECT 1 FROM unnest(tokens[i:i+width-1]) word WHERE word !~ '^[[:alpha:]]+$') THEN CONTINUE; END IF;
      term := array_to_string(tokens[i:i+width-1],' ');
      -- JavaScript length counts UTF-16 units, including two for astral letters.
      units := length(term)+regexp_count(term,U&'[\+010000-\+10ffff]');
      IF units>=(CASE WHEN width=1 THEN 3 ELSE 5 END) AND units<=64 AND NOT term=ANY(terms) THEN
        terms := array_append(terms,term);
      END IF;
    END LOOP;
  END LOOP;
  RETURN array_to_json(terms)::text;
END $$;

ALTER TABLE yutorah_search.search_title_catalog ALTER COLUMN terms DROP NOT NULL;
CREATE OR REPLACE FUNCTION yutorah_search.compact_title_terms() RETURNS trigger
LANGUAGE plpgsql SET search_path=yutorah_search,pg_catalog AS $$
BEGIN
  IF NEW.terms IS NOT NULL AND NEW.terms::jsonb=title_terms(NEW.title)::jsonb THEN NEW.terms:=NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS search_compact_title ON yutorah_search.search_title_catalog;
CREATE TRIGGER search_compact_title BEFORE INSERT OR UPDATE ON yutorah_search.search_title_catalog
FOR EACH ROW EXECUTE FUNCTION yutorah_search.compact_title_terms();

CREATE OR REPLACE FUNCTION yutorah_search.title_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path=yutorah_search,pg_catalog AS $$
DECLARE previous_terms text; next_terms text;
BEGIN
  IF TG_OP<>'INSERT' THEN previous_terms:=COALESCE(OLD.terms,title_terms(OLD.title)); END IF;
  IF TG_OP<>'DELETE' THEN next_terms:=COALESCE(NEW.terms,title_terms(NEW.title)); END IF;
  -- Compaction alone must not rewrite millions of unchanged dictionary counts.
  IF TG_OP='UPDATE' AND previous_terms::jsonb=next_terms::jsonb THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN
    UPDATE search_title_terms SET documents=documents-1
    WHERE term IN (SELECT jsonb_array_elements_text(previous_terms::jsonb));
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO search_title_terms(term,words,documents)
    SELECT value,1+length(value)-length(replace(value,' ','')),1
    FROM jsonb_array_elements_text(next_terms::jsonb) value
    ON CONFLICT(term) DO UPDATE SET documents=search_title_terms.documents+1;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

-- An extra transliteration key shares the existing inverted index. No table
-- of word/recording combinations and no extra per-title key copies are needed.
CREATE OR REPLACE FUNCTION yutorah_search.insert_spelling_keys(entries text) RETURNS integer
LANGUAGE plpgsql SET search_path=yutorah_search,pg_catalog AS $$
DECLARE changed integer;
BEGIN
  INSERT INTO search_title_word_keys(term,prefix,keys)
  SELECT term,COALESCE(max(key) FILTER (WHERE key LIKE 'p:%'),'p:'||left(term,3)),
    COALESCE(array_agg(DISTINCT key ORDER BY key) FILTER (WHERE left(key,2) IN ('d:','v:')),ARRAY[]::text[])
  FROM (SELECT value->>0 AS key,value->>1 AS term FROM jsonb_array_elements(entries::jsonb)) incoming
  WHERE left(key,2) IN ('d:','p:','v:') GROUP BY term
  ON CONFLICT(term) DO UPDATE SET keys=(
    SELECT array_agg(DISTINCT key ORDER BY key) FROM unnest(search_title_word_keys.keys||excluded.keys) key
  ) WHERE NOT search_title_word_keys.keys @> excluded.keys;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;

CREATE OR REPLACE FUNCTION yutorah_search.spelling_candidates(entries text)
RETURNS TABLE(term text,words integer,documents integer)
LANGUAGE sql STABLE SET search_path=yutorah_search,pg_catalog AS $$
WITH requested AS (
  SELECT DISTINCT value->>'key' AS key,(value->>'slot')::integer AS slot FROM jsonb_array_elements(entries::jsonb)
), found AS (
  SELECT r.slot,t.term,t.words,t.documents FROM requested r
  JOIN search_title_terms t ON replace(t.term,' ','')=substring(r.key from 3) WHERE left(r.key,2)='j:'
  UNION ALL
  SELECT r.slot,t.term,t.words,t.documents FROM requested r
  JOIN search_title_word_keys k ON k.prefix=r.key JOIN search_title_terms t ON t.term=k.term WHERE left(r.key,2)='p:'
  UNION ALL
  SELECT r.slot,t.term,t.words,t.documents FROM requested r
  JOIN search_title_word_keys k ON k.keys @> ARRAY[r.key] JOIN search_title_terms t ON t.term=k.term WHERE left(r.key,2) IN ('d:','v:')
), candidates AS (
  SELECT slot,term,words,documents,count(*) AS overlap FROM found WHERE documents>0 GROUP BY slot,term,words,documents
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY slot ORDER BY overlap DESC,documents DESC,term) AS position FROM candidates
) SELECT term,words,documents FROM ranked WHERE slot=-1 OR position<=64
$$;
ANALYZE yutorah_search.search_title_terms;
-- Existing rows are compacted separately in bounded, restartable owner batches.
