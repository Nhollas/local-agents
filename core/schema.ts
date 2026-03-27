import { sqliteTable, text, real } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  status: text("status").notNull().$type<RunStatus>(),
  error: text("error"),
  issueKey: text("issue_key"),
  issueTitle: text("issue_title"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  durationMs: real("duration_ms"),
});

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  type: text("type").notNull().$type<RunEventType>(),
  data: text("data", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

type RunStatus = "running" | "completed" | "failed";
export type RunEventType = "run:started" | "run:output" | "run:tool_use" | "run:completed" | "run:failed";
