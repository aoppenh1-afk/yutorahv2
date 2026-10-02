-- Apply with the search schema owner. The transcript connection remains read-only.
CREATE TABLE IF NOT EXISTS yutorah_search.sources_runs (
  id text PRIMARY KEY, payload text NOT NULL, lease bigint NOT NULL DEFAULT 0,
  expires bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_runs_expires ON yutorah_search.sources_runs (expires);

-- Owner-created tables need an explicit grant for the installed website role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yutorah_search_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON yutorah_search.sources_runs TO yutorah_search_app;
  END IF;
END $$;
