import type { Run, RunDetail, RunEvent, Step } from "../lib/types.ts";

export function createRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run-1",
		status: "running",
		repo: "acme/api",
		branch: null,
		workspaceDir: null,
		issueKey: null,
		issueTitle: null,
		issueUrl: null,
		startedAt: "2026-05-09T14:27:56Z",
		completedAt: null,
		durationMs: null,
		costUsd: null,
		tokensInput: null,
		tokensOutput: null,
		pr: null,
		error: null,
		...overrides,
	};
}

export function createStep(
	overrides: Partial<Step> & { index: number; name: string },
): Step {
	return {
		state: "pending",
		startedAt: null,
		completedAt: null,
		durationMs: null,
		error: null,
		...overrides,
	};
}

export function createRunDetail(overrides: Partial<RunDetail> = {}): RunDetail {
	return {
		run: overrides.run ?? createRun(),
		steps: overrides.steps ?? [],
	};
}

let nextSeq = 1;

type EventInput = {
	[K in RunEvent["kind"]]: Pick<
		Extract<RunEvent, { kind: K }>,
		"kind" | "data"
	> & {
		seq?: number;
		id?: string;
		runId?: string;
		stepName?: string | null;
		createdAt?: string;
	};
}[RunEvent["kind"]];

export function createEvent(event: EventInput): RunEvent {
	const seq = event.seq ?? nextSeq++;
	return {
		seq,
		id: event.id ?? `evt_${String(seq).padStart(4, "0")}`,
		runId: event.runId ?? "run-1",
		stepName: event.stepName ?? null,
		createdAt: event.createdAt ?? "2026-05-09T14:28:00Z",
		kind: event.kind,
		data: event.data,
	} as RunEvent;
}
