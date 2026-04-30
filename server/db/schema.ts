import {
	index,
	integer,
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
	phaseIndex: integer("phase_index").notNull().default(0),
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

export type RunStatus = "running" | "completed" | "failed";
export type RunEventType =
	| "run:started"
	| "run:output"
	| "run:tool_use"
	| "phase.started"
	| "phase.completed"
	| "phase.failed"
	| "run:completed"
	| "run:failed";

export type RunStartedData = { issueKey: IssueKey; issueTitle: string };
export type RunOutputData = Record<string, unknown>;
export type RunToolUseData = { tool: string; target: string };
export type PhaseStartedData = { name: string; index: number; total: number };
export type PhaseCompletedData = {
	name: string;
	index: number;
	durationMs: number;
};
export type PhaseFailedData = { name: string; index: number; error: string };
export type RunCompletedData = { durationMs: number };
export type RunFailedData = { error: string; durationMs: number };
