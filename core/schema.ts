import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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
