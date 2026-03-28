ALTER TABLE `runs` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_run_id` text;