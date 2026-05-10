import type { Run, RunDetail, Step } from "../lib/types.ts";

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
