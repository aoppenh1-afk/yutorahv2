CREATE TABLE `sources_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`lease` integer DEFAULT 0 NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sources_runs_expires` ON `sources_runs` (`expires`);