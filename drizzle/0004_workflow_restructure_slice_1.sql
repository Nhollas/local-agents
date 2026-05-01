ALTER TABLE `runs` RENAME COLUMN `phase_index` TO `step_index`;--> statement-breakpoint
CREATE TABLE `run_step_outputs` (
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`output_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `step_name`)
);
