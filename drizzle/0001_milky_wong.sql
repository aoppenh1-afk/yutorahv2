ALTER TABLE `search_hits` ADD `search` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `search_hits` ADD `language` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `search_hits` ADD `format` text DEFAULT '' NOT NULL;