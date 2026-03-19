import { eq, and } from "drizzle-orm";
import { getDb } from "../../core/db.ts";
import { reviewJobs } from "../../core/schema.ts";
import type { ReviewJob } from "./types.ts";

export function saveJob(job: ReviewJob): void {
  const db = getDb();
  db.insert(reviewJobs)
    .values({
      id: job.id,
      repo: job.repo,
      prNumber: job.prNumber,
      headBranch: job.headBranch,
      baseBranch: job.baseBranch,
      commentId: job.commentId,
      findings: job.findings,
      status: job.status,
      error: job.error ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })
    .onConflictDoUpdate({
      target: reviewJobs.id,
      set: {
        findings: job.findings,
        status: job.status,
        error: job.error ?? null,
        updatedAt: job.updatedAt,
      },
    })
    .run();
}

export function loadJob(repo: string, prNumber: number): ReviewJob | null {
  const db = getDb();
  const row = db
    .select()
    .from(reviewJobs)
    .where(and(eq(reviewJobs.repo, repo), eq(reviewJobs.prNumber, prNumber)))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.prNumber,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    commentId: row.commentId,
    findings: row.findings,
    status: row.status,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
