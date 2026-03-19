export type { Finding, ReviewJobStatus } from "../../core/schema.ts";
import type { Finding, ReviewJobStatus } from "../../core/schema.ts";

export type ReviewJob = {
  id: string;
  repo: string;
  prNumber: number;
  headBranch: string;
  baseBranch: string;
  commentId: number;
  findings: Finding[];
  status: ReviewJobStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
};
