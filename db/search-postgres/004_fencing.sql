ALTER TABLE yutorah_search.search_runs ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS yutorah_search.search_pass_guards (
  run text NOT NULL, owner text NOT NULL,
  valid integer NOT NULL CONSTRAINT search_pass_owned CHECK (valid = 1),
  PRIMARY KEY (run, owner)
);
DO $$ DECLARE permission record; BEGIN
 FOR permission IN SELECT DISTINCT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='yutorah_search' AND table_name='search_runs' AND grantee<>'PUBLIC'
     AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
 LOOP EXECUTE format('GRANT %s ON yutorah_search.search_pass_guards TO %I',permission.privilege_type,permission.grantee);
 END LOOP;
END $$;
