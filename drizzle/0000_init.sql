CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`issue_key` text,
	`issue_title` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` real
);
