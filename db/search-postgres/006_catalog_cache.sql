CREATE TABLE IF NOT EXISTS yutorah_search.catalog_snapshots (
  resource text NOT NULL,
  version text NOT NULL,
  payload text NOT NULL,
  bytes integer NOT NULL CHECK(bytes >= 0),
  updated bigint NOT NULL,
  expires bigint NOT NULL,
  PRIMARY KEY(resource,version)
);
CREATE INDEX IF NOT EXISTS catalog_snapshots_latest ON yutorah_search.catalog_snapshots(resource,updated DESC);
CREATE INDEX IF NOT EXISTS catalog_snapshots_expires ON yutorah_search.catalog_snapshots(expires);
CREATE TABLE IF NOT EXISTS yutorah_search.catalog_refresh_leases (
  resource text PRIMARY KEY,
  owner text NOT NULL,
  expires bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS yutorah_search.catalog_artwork (
  id integer PRIMARY KEY,
  image text NOT NULL,
  updated bigint NOT NULL
);
DO $$ DECLARE permission record; target text; BEGIN
 FOR permission IN SELECT DISTINCT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='yutorah_search' AND table_name='search_runs' AND grantee<>'PUBLIC'
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
 LOOP
   FOREACH target IN ARRAY ARRAY['catalog_snapshots','catalog_refresh_leases','catalog_artwork']
   LOOP EXECUTE format('GRANT %s ON yutorah_search.%I TO %I',permission.privilege_type,target,permission.grantee); END LOOP;
 END LOOP;
END $$;
