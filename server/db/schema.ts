import {
	index,
	integer,
	// biome-ignore lint/suspicious/noDeprecatedImports: only the variadic overload is deprecated; we use primaryKey({ columns }) below.
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import type { RunEventData, RunEventKind } from "../event-schema.ts";
import type { IssueKey, RepoSlug, RunId } from "../types/brands.ts";

export const runs = sqliteTable("runs", {
	id: text("id").primaryKey().$type<RunId>(),
	status: text("status").notNull().$type<RunStatus>(),
	error: text("error"),
	repo: text("repo").notNull().$type<RepoSlug>(),
	repoUrl: text("repo_url"),
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
	finalizeFailurePhase: text(
		"finalize_failure_phase",
	).$type<FinalizeFailurePhase>(),
	finalizeFailureError: text("finalize_failure_error"),
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
		seq: integer("seq").primaryKey({ autoIncrement: true }),
		id: text("id").notNull().unique(),
		runId: text("run_id").notNull().$type<RunId>(),
		kind: text("kind").notNull().$type<RunEventKind>(),
		stepName: text("step_name"),
		data: text("data", { mode: "json" }).notNull().$type<RunEventData>(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_run_events_run_id").on(table.runId),
		index("idx_run_events_seq").on(table.seq),
	],
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
export type FinalizeFailurePhase =
	| "push"
	| "change_request"
	| "tracker_transition";
