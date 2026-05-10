import type {
	ActiveRun,
	QueuedItem,
	QueueSnapshot,
	Run,
	RunDetail,
	RunEvent,
	Stats,
	Step,
} from "../lib/types.ts";

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

export function createActiveRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
	return {
		...createRun(overrides),
		currentStep: overrides.currentStep ?? null,
		progressRatio: overrides.progressRatio ?? 0,
	};
}

export function createQueuedItem(
	overrides: Partial<QueuedItem> = {},
): QueuedItem {
	return {
		issueKey: "ACME-1285",
		issueTitle: "queued issue",
		repo: "acme/api",
		pendingSince: "2026-05-09T14:31:42Z",
		...overrides,
	};
}

export function createQueueSnapshot(
	overrides: Partial<QueueSnapshot> = {},
): QueueSnapshot {
	return {
		active: overrides.active ?? [],
		queued: overrides.queued ?? [],
	};
}

export function createStats(overrides: Partial<Stats> = {}): Stats {
	return {
		asOf: "2026-05-09T14:32:08.000Z",
		running: { active: 0, max: 0 },
		queued: { count: 0 },
		last24h: {
			completed: 0,
			completedDelta: 0,
			failed: 0,
			successRate: 1,
			spendUsd: 0,
			spendDeltaUsd: 0,
			p50DurationMs: 0,
			p95DurationMs: 0,
			durationSparkline: [],
		},
		...overrides,
	};
}

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
