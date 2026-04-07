import type { RunDetailFromApi, RunFromApi } from "../lib/api";
import type { RunEvent, RunEventType } from "../lib/types";

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
		sessionId: null,
		attempt: 1,
		parentRunId: null,
		...overrides,
	};
}

export function createRunDetailFromApi(
	overrides?: Partial<RunDetailFromApi>,
): RunDetailFromApi {
	const { events, ...rest } = overrides ?? {};
	return {
		...createRunFromApi(rest),
		events: events ?? [],
	};
}
