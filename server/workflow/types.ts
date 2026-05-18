import type { IssueKey, IssueNumber } from "../types/brands.ts";
import type {
	BranchSchema,
	ChangeRequestSchema,
	RepoWorkflowSchema,
	WorkflowStepSchema,
} from "./schemas.ts";

export type RepoWorkflow = typeof RepoWorkflowSchema.Type;
export type WorkflowStep = typeof WorkflowStepSchema.Type;
export type WorkflowBranch = typeof BranchSchema.Type;
export type ChangeRequestTemplate = typeof ChangeRequestSchema.Type;

/** @lintignore consumed in slices 5/6 (engine entrypoints) */
export type PromptIssue = {
	key: IssueKey;
	number: IssueNumber;
	title: string;
	description: string;
	labels: readonly string[];
	url: string;
	createdAt: string;
};

/** @lintignore consumed in slices 5/6 (engine entrypoints) */
export type PromptScope = {
	issue: PromptIssue;
	baseBranch: string;
};

/** @lintignore carried on BranchResolved / StepResult events; wired in slices 5/6 */
export type ModelUsage = {
	inputTokens: number;
	outputTokens: number;
	costUSD: number;
};

/** @lintignore carried on BranchResolved / StepResult events; wired in slices 5/6 */
export type StepUsage = {
	costUsd: number;
	tokensInput: number;
	tokensOutput: number;
	modelUsage: Record<string, ModelUsage>;
};
