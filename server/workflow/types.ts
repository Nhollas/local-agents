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

export type PromptIssue = {
	key: string;
	number: number;
	title: string;
	description: string;
	labels: readonly string[];
	url: string;
	createdAt: string;
};

export type PromptScope = {
	issue: PromptIssue;
	baseBranch: string;
};

export type ModelUsage = {
	inputTokens: number;
	outputTokens: number;
	costUSD: number;
};

export type StepUsage = {
	costUsd: number;
	tokensInput: number;
	tokensOutput: number;
	modelUsage: Record<string, ModelUsage>;
};

export const emptyStepUsage = (): StepUsage => ({
	costUsd: 0,
	tokensInput: 0,
	tokensOutput: 0,
	modelUsage: {},
});
