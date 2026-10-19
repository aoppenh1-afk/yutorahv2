CREATE TABLE IF NOT EXISTS yutorah_search.database_transfer_daily (
  day date NOT NULL,
  database text NOT NULL CHECK(database IN ('library','notes')),
  feature text NOT NULL,
  queries bigint NOT NULL CHECK(queries >= 0),
  rows bigint NOT NULL CHECK(rows >= 0),
  column_bytes bigint NOT NULL CHECK(column_bytes >= 0),
  errors bigint NOT NULL CHECK(errors >= 0),
  PRIMARY KEY(day,database,feature)
);
DO $$ DECLARE permission record; BEGIN
 FOR permission IN SELECT DISTINCT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='yutorah_search' AND table_name='search_runs' AND grantee<>'PUBLIC'
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
 LOOP EXECUTE format('GRANT %s ON yutorah_search.database_transfer_daily TO %I',permission.privilege_type,permission.grantee); END LOOP;
END $$;
