export type RunStatus = "running" | "completed" | "failed";

export type RunStepState = "pending" | "running" | "completed" | "failed";

export type PrKind = "opened" | "commented";

export type RunPr = {
	repo: string;
	number: number;
	url: string;
	kind: PrKind;
};

export type RunFailedStep = { index: number; name: string };

export type FinalizeFailurePhase =
	| "push"
	| "change_request"
	| "tracker_transition";

export type RunFinalizeFailure = {
	phase: FinalizeFailurePhase;
	error: string;
};

export type Run = {
	id: string;
	status: RunStatus;
	repo: string;
	repoUrl: string | null;
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
	failedStep: RunFailedStep | null;
	finalizeFailure: RunFinalizeFailure | null;
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

export type CurrentStep = { name: string; index: number; total: number };

export type ActiveRun = Run & {
	currentStep: CurrentStep | null;
	progressRatio: number;
};

export type QueuedItem = {
	issueKey: string;
	issueTitle: string;
	repo: string;
	pendingSince: string;
};

export type QueueSnapshot = {
	active: ActiveRun[];
	queued: QueuedItem[];
};

export type Stats = {
	asOf: string;
	running: { active: number; max: number };
	queued: { count: number };
	last24h: {
		completed: number;
		completedDelta: number;
		failed: number;
		successRate: number;
		spendUsd: number;
		spendDeltaUsd: number;
		p50DurationMs: number;
		p95DurationMs: number;
		durationSparkline: number[];
	};
};

export {
	LIFECYCLE_EVENT_KINDS,
	RUN_EVENT_KINDS,
	RUN_TERMINAL_EVENT_KINDS,
	type RunEvent,
	runEventSchema,
} from "../../../server/event-schema.ts";
