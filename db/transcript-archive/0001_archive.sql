CREATE TABLE IF NOT EXISTS archive_items (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  version TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  title TEXT NOT NULL,
  teacher TEXT NOT NULL,
  media_url TEXT,
  object_key TEXT NOT NULL,
  notes_status TEXT,
  segment_count INTEGER NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_segments (
  rowid INTEGER PRIMARY KEY,
  shiur_id TEXT NOT NULL,
  version TEXT NOT NULL,
  generation INTEGER NOT NULL,
  segment_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  search_window TEXT NOT NULL,
  UNIQUE(shiur_id,version,segment_index)
);
CREATE INDEX IF NOT EXISTS archive_segments_version ON archive_segments(shiur_id,version);
CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
  search_window, content='archive_segments', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0', prefix='3 4 5'
);
CREATE TRIGGER IF NOT EXISTS archive_segments_insert AFTER INSERT ON archive_segments BEGIN
  INSERT INTO archive_fts(rowid,search_window) VALUES(new.rowid,new.search_window);
END;
CREATE TRIGGER IF NOT EXISTS archive_segments_delete AFTER DELETE ON archive_segments BEGIN
  INSERT INTO archive_fts(archive_fts,rowid,search_window) VALUES('delete',old.rowid,old.search_window);
END;
CREATE TABLE IF NOT EXISTS archive_words (word TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS archive_spelling_keys (
  key TEXT NOT NULL, word TEXT NOT NULL, PRIMARY KEY(key,word)
) WITHOUT ROWID;
