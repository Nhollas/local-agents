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
