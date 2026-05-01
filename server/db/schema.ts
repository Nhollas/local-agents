import {
	index,
	integer,
	// biome-ignore lint/suspicious/noDeprecatedImports: only the variadic overload is deprecated; we use primaryKey({ columns }) below.
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import type { IssueKey, RunId } from "../types/brands.ts";

export const runs = sqliteTable("runs", {
	id: text("id").primaryKey().$type<RunId>(),
	agentName: text("agent_name").notNull(),
	status: text("status").notNull().$type<RunStatus>(),
	error: text("error"),
	issueKey: text("issue_key").$type<IssueKey>(),
	issueTitle: text("issue_title"),
	startedAt: text("started_at").notNull(),
	completedAt: text("completed_at"),
	durationMs: real("duration_ms"),
	sessionId: text("session_id"),
	attempt: integer("attempt").notNull().default(1),
	parentRunId: text("parent_run_id").$type<RunId>(),
	stepIndex: integer("step_index").notNull().default(0),
});

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
	/* v8 ignore next -- evaluated at module load, before coverage starts */
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
	/* v8 ignore next -- evaluated at module load, before coverage starts */
	(table) => [primaryKey({ columns: [table.runId, table.stepName] })],
);

export type RunStatus = "running" | "completed" | "failed";
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
