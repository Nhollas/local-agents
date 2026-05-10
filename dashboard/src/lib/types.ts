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
	failedStep: RunFailedStep | null;
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

type RunEventBase = {
	id: string;
	seq: number;
	runId: string;
	stepName: string | null;
	createdAt: string;
};

export type ToolBashState = "running" | "exited" | "aborted";

export type RunEvent =
	| (RunEventBase & {
			kind: "run:started";
			data: { issueKey: string | null; issueTitle: string | null };
	  })
	| (RunEventBase & {
			kind: "run:completed";
			data: {
				durationMs: number;
				costUsd: number;
				tokens: { in: number; out: number };
			};
	  })
	| (RunEventBase & {
			kind: "run:failed";
			data: { error: string; durationMs: number };
	  })
	| (RunEventBase & {
			kind: "step:started";
			data: { name: string; index: number; total: number };
	  })
	| (RunEventBase & {
			kind: "step:completed";
			data: { name: string; index: number; durationMs: number };
	  })
	| (RunEventBase & {
			kind: "step:failed";
			data: {
				name: string;
				index: number;
				error: string;
				durationMs: number;
			};
	  })
	| (RunEventBase & { kind: "agent:say"; data: { text: string } })
	| (RunEventBase & {
			kind: "tool:read";
			data: { path: string; lines: number };
	  })
	| (RunEventBase & {
			kind: "tool:edit";
			data: {
				path: string;
				added: number;
				removed: number;
				summary: string;
			};
	  })
	| (RunEventBase & {
			kind: "tool:grep";
			data: { pattern: string; path: string; matches: number };
	  })
	| (RunEventBase & {
			kind: "tool:bash";
			data: {
				command: string;
				cwd: string | null;
				state: ToolBashState;
				exitCode: number | null;
			};
	  })
	| (RunEventBase & {
			kind: "tool:other";
			data: { tool: string; summary: string };
	  })
	| (RunEventBase & {
			kind: "system";
			data: {
				message: string;
				command: string | null;
				path: string | null;
				exitCode: number | null;
			};
	  });

export type RunEventKind = RunEvent["kind"];
