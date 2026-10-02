-- Index existing title text without duplicating the archive's content.
CREATE VIRTUAL TABLE search_title_autocomplete USING fts5(
  title, content='search_title_catalog', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2', prefix='3 4'
);
--> statement-breakpoint
CREATE TRIGGER search_title_autocomplete_insert AFTER INSERT ON search_title_catalog BEGIN
  INSERT INTO search_title_autocomplete(rowid,title) VALUES(NEW.id,NEW.title);
END;
--> statement-breakpoint
CREATE TRIGGER search_title_autocomplete_update AFTER UPDATE OF title ON search_title_catalog BEGIN
  INSERT INTO search_title_autocomplete(search_title_autocomplete,rowid,title) VALUES('delete',OLD.id,OLD.title);
  INSERT INTO search_title_autocomplete(rowid,title) VALUES(NEW.id,NEW.title);
END;
--> statement-breakpoint
CREATE TRIGGER search_title_autocomplete_delete AFTER DELETE ON search_title_catalog BEGIN
  INSERT INTO search_title_autocomplete(search_title_autocomplete,rowid,title) VALUES('delete',OLD.id,OLD.title);
END;
--> statement-breakpoint
INSERT INTO search_title_autocomplete(search_title_autocomplete) VALUES('rebuild');
--> statement-breakpoint
INSERT OR IGNORE INTO search_title_cursors(name,next) VALUES('title-autocomplete-v1',1);
