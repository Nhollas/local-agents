import type { RunDetailFromApi, RunFromApi } from "../lib/api";
import type { RunEvent, RunEventType } from "../lib/types";

type RunEventOfType<T extends RunEventType> = Extract<RunEvent, { type: T }>;

const defaultData: { [T in RunEventType]: RunEventOfType<T>["data"] } = {
	"run:started": { issueKey: "test/repo#1", issueTitle: "Test issue" },
	"run:output": {},
	"run:tool_use": { tool: "Bash", target: "echo test" },
	"run:completed": { durationMs: 1000 },
	"run:failed": { error: "test error", durationMs: 1000 },
};

export function createRunEvent<T extends RunEventType>(
	type: T,
	overrides?: Partial<Omit<RunEventOfType<T>, "type">>,
): RunEventOfType<T> {
	return {
		type,
		runId: "run-1",
		agentName: "test-agent",
		data: defaultData[type],
		createdAt: "2026-03-20T12:00:00.000Z",
		...overrides,
	} as RunEventOfType<T>;
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
	const { events, ...rest } = overrides ?? {};
	return {
		...createRunFromApi(rest),
		events: events ?? [],
	};
}
