import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  status: text("status").notNull().$type<RunStatus>(),
  error: text("error"),
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

export type RunStatus = "running" | "completed" | "failed";
export type RunEventType = "run:started" | "run:output" | "run:completed" | "run:failed";

export const reviewJobs = sqliteTable("review_jobs", {
  id: text("id").primaryKey(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  headBranch: text("head_branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  commentId: integer("comment_id").notNull(),
  findings: text("findings", { mode: "json" }).notNull().$type<Finding[]>(),
  status: text("status").notNull().$type<ReviewJobStatus>(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Finding = {
  id: string;
  title: string;
  description: string;
  violation: { path: string; startLine: number; endLine: number };
  conventionExample: { path: string; startLine: number; endLine: number };
  selected: boolean;
  implemented: boolean;
};

export type ReviewJobStatus =
  | "checking"
  | "awaiting_selection"
  | "implementing"
  | "done"
  | "error";
