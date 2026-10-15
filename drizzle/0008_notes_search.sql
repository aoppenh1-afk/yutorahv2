CREATE TABLE search_note_snapshots (
  id text PRIMARY KEY, created integer NOT NULL, completed integer NOT NULL DEFAULT 0,
  count integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE search_note_documents (
  rowid integer PRIMARY KEY AUTOINCREMENT, key text NOT NULL UNIQUE,
  id integer NOT NULL, notes_hash text NOT NULL,
  payload text NOT NULL, text text NOT NULL, normalized text NOT NULL
);
--> statement-breakpoint
CREATE INDEX search_note_documents_id ON search_note_documents(id);
--> statement-breakpoint
CREATE TABLE search_note_members (
  snapshot text NOT NULL REFERENCES search_note_snapshots(id) ON DELETE CASCADE,
  id integer NOT NULL, key text NOT NULL REFERENCES search_note_documents(key),
  PRIMARY KEY(snapshot,id)
);
--> statement-breakpoint
CREATE INDEX search_note_members_key ON search_note_members(key);
--> statement-breakpoint
CREATE TABLE search_notes_state (
  name text PRIMARY KEY, snapshot text NOT NULL, cursor integer NOT NULL DEFAULT 0,
  owner text NOT NULL DEFAULT '', lease integer NOT NULL DEFAULT 0, updated integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE search_notes_guards (
  owner text PRIMARY KEY, valid integer NOT NULL CONSTRAINT notes_sync_owned CHECK(valid=1)
);
--> statement-breakpoint
CREATE VIRTUAL TABLE search_note_fulltext USING fts5(
  normalized, content='search_note_documents', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER search_note_fulltext_insert AFTER INSERT ON search_note_documents BEGIN
  INSERT INTO search_note_fulltext(rowid,normalized) VALUES(NEW.rowid,NEW.normalized);
END;
--> statement-breakpoint
CREATE TRIGGER search_note_fulltext_delete AFTER DELETE ON search_note_documents BEGIN
  INSERT INTO search_note_fulltext(search_note_fulltext,rowid,normalized) VALUES('delete',OLD.rowid,OLD.normalized);
END;
--> statement-breakpoint
INSERT INTO search_note_fulltext(search_note_fulltext) VALUES('rebuild');
