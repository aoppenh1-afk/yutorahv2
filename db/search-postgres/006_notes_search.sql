-- Searchable public notes, separate from the authoritative compressed TiDB rows.
-- A ready snapshot becomes visible only after its complete inventory is indexed.
CREATE TABLE IF NOT EXISTS yutorah_search.search_note_snapshots (
  id text PRIMARY KEY, created bigint NOT NULL, completed bigint NOT NULL DEFAULT 0,
  count integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS yutorah_search.search_note_documents (
  key text PRIMARY KEY, id bigint NOT NULL, notes_hash text NOT NULL,
  payload text NOT NULL, text text NOT NULL, normalized text NOT NULL
);
CREATE INDEX IF NOT EXISTS search_note_documents_id ON yutorah_search.search_note_documents(id);
CREATE INDEX IF NOT EXISTS search_note_fulltext ON yutorah_search.search_note_documents
  USING gin(to_tsvector('simple',normalized));
CREATE TABLE IF NOT EXISTS yutorah_search.search_note_members (
  snapshot text NOT NULL REFERENCES yutorah_search.search_note_snapshots(id) ON DELETE CASCADE,
  id bigint NOT NULL, key text NOT NULL REFERENCES yutorah_search.search_note_documents(key),
  PRIMARY KEY(snapshot,id)
);
CREATE INDEX IF NOT EXISTS search_note_members_key ON yutorah_search.search_note_members(key);
CREATE TABLE IF NOT EXISTS yutorah_search.search_notes_state (
  name text PRIMARY KEY, snapshot text NOT NULL, cursor bigint NOT NULL DEFAULT 0,
  owner text NOT NULL DEFAULT '', lease bigint NOT NULL DEFAULT 0, updated bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS yutorah_search.search_notes_guards (
  owner text PRIMARY KEY, valid integer NOT NULL CONSTRAINT notes_sync_owned CHECK(valid=1)
);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='yutorah_search_app') THEN
    GRANT SELECT ON yutorah_search.search_note_snapshots,yutorah_search.search_note_documents,
      yutorah_search.search_note_members,yutorah_search.search_notes_state TO yutorah_search_app;
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON yutorah_search.search_note_snapshots,
      yutorah_search.search_note_documents,yutorah_search.search_note_members,
      yutorah_search.search_notes_state,yutorah_search.search_notes_guards FROM yutorah_search_app;
  END IF;
END $$;
