DROP TABLE `run_events`;--> statement-breakpoint
CREATE TABLE `run_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`step_name` text,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_id_unique` ON `run_events` (`id`);--> statement-breakpoint
CREATE INDEX `idx_run_events_run_id` ON `run_events` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_run_events_seq` ON `run_events` (`seq`);
