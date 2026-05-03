export type RunEventType =
	| "run:started"
	| "run:output"
	| "run:tool_use"
	| "run:completed"
	| "run:failed";

type RunEventBase = {
	runId: string;
	agentName: string;
	createdAt: string;
};

export type RunEvent =
	| (RunEventBase & {
			type: "run:started";
			data: { issueKey: string; issueTitle: string };
	  })
	| (RunEventBase & { type: "run:output"; data: Record<string, unknown> })
	| (RunEventBase & {
			type: "run:tool_use";
			data: { tool: string; target: string };
	  })
	| (RunEventBase & { type: "run:completed"; data: { durationMs: number } })
	| (RunEventBase & {
			type: "run:failed";
			data: { error: string; durationMs: number };
	  });

export type RunStatus = "running" | "completed" | "failed";

export type Run = {
	id: string;
	agentName: string;
	status: RunStatus;
	error?: string;
	issueKey?: string;
	issueTitle?: string;
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
};
