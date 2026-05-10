CREATE TABLE `run_steps` (
	`run_id` text NOT NULL,
	`index` integer NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`duration_ms` real,
	`error` text,
	PRIMARY KEY(`run_id`, `index`)
);
--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `agent_name`;--> statement-breakpoint
ALTER TABLE `runs` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `workspace_dir` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `issue_url` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `tokens_input` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `tokens_output` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_url` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_number` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_repo` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pr_kind` text;
