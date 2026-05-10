import {
	index,
	integer,
	// biome-ignore lint/suspicious/noDeprecatedImports: only the variadic overload is deprecated; we use primaryKey({ columns }) below.
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import type { IssueKey, RepoSlug, RunId } from "../types/brands.ts";

export const runs = sqliteTable("runs", {
	id: text("id").primaryKey().$type<RunId>(),
	status: text("status").notNull().$type<RunStatus>(),
	error: text("error"),
	repo: text("repo").notNull().$type<RepoSlug>(),
	branch: text("branch"),
	workspaceDir: text("workspace_dir"),
	issueKey: text("issue_key").$type<IssueKey>(),
	issueTitle: text("issue_title"),
	issueUrl: text("issue_url"),
	startedAt: text("started_at").notNull(),
	completedAt: text("completed_at"),
	durationMs: real("duration_ms"),
	costUsd: real("cost_usd"),
	tokensInput: integer("tokens_input"),
	tokensOutput: integer("tokens_output"),
	prUrl: text("pr_url"),
	prNumber: integer("pr_number"),
	prRepo: text("pr_repo"),
	prKind: text("pr_kind").$type<PrKind>(),
});

export const runSteps = sqliteTable(
	"run_steps",
	{
		runId: text("run_id").notNull().$type<RunId>(),
		index: integer("index").notNull(),
		name: text("name").notNull(),
		state: text("state").notNull().$type<RunStepState>(),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		durationMs: real("duration_ms"),
		error: text("error"),
	},
	(table) => [primaryKey({ columns: [table.runId, table.index] })],
);

export const runEvents = sqliteTable(
	"run_events",
	{
		id: text("id").primaryKey(),
		runId: text("run_id").notNull().$type<RunId>(),
		type: text("type").notNull().$type<RunEventType>(),
		data: text("data", { mode: "json" })
			.notNull()
			.$type<Record<string, unknown>>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_run_events_run_id").on(table.runId)],
);

export const runStepOutputs = sqliteTable(
	"run_step_outputs",
	{
		runId: text("run_id").notNull().$type<RunId>(),
		stepName: text("step_name").notNull(),
		outputJson: text("output_json", { mode: "json" })
			.notNull()
			.$type<unknown>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.runId, table.stepName] })],
);

export type RunStatus = "running" | "completed" | "failed";
export type RunStepState = "pending" | "running" | "completed" | "failed";
export type PrKind = "opened" | "commented";

export type RunEventType =
	| "run:started"
	| "run:output"
	| "run:tool_use"
	| "step.started"
	| "step.completed"
	| "step.failed"
	| "run:completed"
	| "run:failed";

export type RunStartedData = { issueKey: IssueKey; issueTitle: string };
export type RunOutputData = Record<string, unknown>;
export type RunToolUseData = { tool: string; target: string };
export type StepStartedData = { name: string; index: number; total: number };
export type StepCompletedData = {
	name: string;
	index: number;
	durationMs: number;
};
export type StepFailedData = { name: string; index: number; error: string };
export type RunCompletedData = { durationMs: number };
export type RunFailedData = { error: string; durationMs: number };
