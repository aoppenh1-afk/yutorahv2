-- Immutable content lives in D1 too. No metered object-storage subscription.
CREATE TABLE archive_content_chunks (
  object_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(object_key,chunk_index)
) WITHOUT ROWID;

-- Anchor a match in its own timed segment, while allowing phrases to cross
-- into the following segment. Otherwise the seek link can point too early.
DROP TRIGGER archive_segments_insert;
DROP TRIGGER archive_segments_delete;
DROP TABLE archive_fts;
CREATE VIRTUAL TABLE archive_fts USING fts5(
  search_text, search_window, content='archive_segments', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 0', prefix='3 4 5'
);
CREATE TRIGGER archive_segments_insert AFTER INSERT ON archive_segments BEGIN
  INSERT INTO archive_fts(rowid,search_text,search_window)
    VALUES(new.rowid,new.search_text,new.search_window);
END;
CREATE TRIGGER archive_segments_delete AFTER DELETE ON archive_segments BEGIN
  INSERT INTO archive_fts(archive_fts,rowid,search_text,search_window)
    VALUES('delete',old.rowid,old.search_text,old.search_window);
END;
INSERT INTO archive_fts(archive_fts) VALUES('rebuild');
