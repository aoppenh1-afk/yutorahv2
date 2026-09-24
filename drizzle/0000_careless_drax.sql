CREATE TABLE `search_hits` (
	`run` text NOT NULL,
	`id` integer NOT NULL,
	`payload` text NOT NULL,
	`matched` integer NOT NULL,
	`rank` real NOT NULL,
	`date` real NOT NULL,
	`duration` real NOT NULL,
	`title` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`run`, `id`),
	FOREIGN KEY (`run`) REFERENCES `search_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_hits_rank` ON `search_hits` (`run`,`rank`);--> statement-breakpoint
CREATE INDEX `search_hits_date` ON `search_hits` (`run`,`date`);--> statement-breakpoint
CREATE INDEX `search_hits_duration` ON `search_hits` (`run`,`duration`);--> statement-breakpoint
CREATE INDEX `search_hits_title` ON `search_hits` (`run`,`title`);--> statement-breakpoint
CREATE TABLE `search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`plan` text NOT NULL,
	`total` integer NOT NULL,
	`next` integer DEFAULT 1 NOT NULL,
	`created` integer NOT NULL,
	`lease` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `search_runs_fingerprint` ON `search_runs` (`fingerprint`,`created`);