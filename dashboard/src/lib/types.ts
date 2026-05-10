export type RunStatus = "running" | "completed" | "failed";

export type RunStepState = "pending" | "running" | "completed" | "failed";

export type PrKind = "opened" | "commented";

export type RunPr = {
	repo: string;
	number: number;
	url: string;
	kind: PrKind;
};

export type Run = {
	id: string;
	status: RunStatus;
	repo: string;
	branch: string | null;
	workspaceDir: string | null;
	issueKey: string | null;
	issueTitle: string | null;
	issueUrl: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	costUsd: number | null;
	tokensInput: number | null;
	tokensOutput: number | null;
	pr: RunPr | null;
	error: string | null;
};

export type Step = {
	index: number;
	name: string;
	state: RunStepState;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	error: string | null;
};

export type RunDetail = {
	run: Run;
	steps: Step[];
};
