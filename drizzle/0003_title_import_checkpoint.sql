CREATE TABLE `search_title_imports` (
	`name` text PRIMARY KEY NOT NULL,
	`minimum` integer NOT NULL,
	`maximum` integer NOT NULL,
	`next` integer NOT NULL,
	`total` integer NOT NULL,
	`scanned` integer DEFAULT 0 NOT NULL,
	`started` integer NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL
);
