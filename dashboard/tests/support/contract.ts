import type { RunEvent, RunEventType } from "../../src/types";

type RunFromApi = {
	id: string;
	agentName: string;
	status: string;
	error: string | null;
	issueKey: string | null;
	issueTitle: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
};

type RunDetailFromApi = RunFromApi & {
	events: {
		id: string;
		runId: string;
		type: string;
		data: Record<string, unknown>;
		createdAt: string;
	}[];
};

export function createRunEvent(
	type: RunEventType,
	overrides?: Partial<RunEvent>,
): RunEvent {
	return {
		type,
		runId: "run-1",
		agentName: "test-agent",
		data: {},
		createdAt: "2026-03-20T12:00:00.000Z",
		...overrides,
	};
}

export function createRunFromApi(overrides?: Partial<RunFromApi>): RunFromApi {
	return {
		id: "run-1",
		agentName: "test-agent",
		status: "completed",
		error: null,
		issueKey: null,
		issueTitle: null,
		startedAt: "2026-03-20T12:00:00.000Z",
		completedAt: "2026-03-20T12:00:01.500Z",
		durationMs: 1500,
		...overrides,
	};
}

export function createRunDetailFromApi(
	overrides?: Partial<RunDetailFromApi>,
): RunDetailFromApi {
	return {
		id: "run-1",
		agentName: "test-agent",
		status: "completed",
		error: null,
		issueKey: null,
		issueTitle: null,
		startedAt: "2026-03-20T12:00:00.000Z",
		completedAt: "2026-03-20T12:00:01.500Z",
		durationMs: 1500,
		events: [],
		...overrides,
	};
}
