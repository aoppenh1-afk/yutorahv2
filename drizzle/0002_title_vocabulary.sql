CREATE TABLE `search_title_catalog` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`terms` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_title_cursors` (
	`name` text PRIMARY KEY NOT NULL,
	`next` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_title_keys` (
	`key` text NOT NULL,
	`term` text NOT NULL,
	PRIMARY KEY(`key`, `term`),
	FOREIGN KEY (`term`) REFERENCES `search_title_terms`(`term`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `search_title_terms` (
	`term` text PRIMARY KEY NOT NULL,
	`words` integer NOT NULL,
	`documents` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER search_title_insert AFTER INSERT ON search_title_catalog BEGIN
  INSERT INTO search_title_terms (term,words,documents)
  SELECT value,1+length(value)-length(replace(value,' ','')),1 FROM json_each(NEW.terms) WHERE true
  ON CONFLICT(term) DO UPDATE SET documents=documents+1;
END;
--> statement-breakpoint
CREATE TRIGGER search_title_update AFTER UPDATE ON search_title_catalog BEGIN
  UPDATE search_title_terms SET documents=documents-1 WHERE term IN (SELECT value FROM json_each(OLD.terms));
  INSERT INTO search_title_terms (term,words,documents)
  SELECT value,1+length(value)-length(replace(value,' ','')),1 FROM json_each(NEW.terms) WHERE true
  ON CONFLICT(term) DO UPDATE SET documents=documents+1;
END;
--> statement-breakpoint
CREATE TRIGGER search_title_delete AFTER DELETE ON search_title_catalog BEGIN
  UPDATE search_title_terms SET documents=documents-1 WHERE term IN (SELECT value FROM json_each(OLD.terms));
END;
