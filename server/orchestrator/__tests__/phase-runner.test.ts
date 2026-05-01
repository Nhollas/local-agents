import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber, runId } from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import type { RunAgent } from "../phase-runner.ts";
import { runWorkflowPhases } from "../phase-runner.ts";

const issue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	title: "Anything",
	description: "",
	labels: [],
	url: "https://example.com/1",
	createdAt: "2026-01-01T00:00:00Z",
};

const workflow: RepoWorkflow = {
	branch: "agent/x",
	base_branch: "main",
	phases: [
		{ name: "plan", prompt: "plan", resume_previous: false },
		{ name: "implement", prompt: "implement", resume_previous: false },
	],
};

const noopAgent: RunAgent = async function* noopAgent() {
	yield* [];
};

const ctx = {
	runId: runId("test-run"),
	emitToolUse: () => {},
	emitPhaseEvent: () => {},
	setSessionId: () => {},
	setPhaseIndex: () => {},
	signal: new AbortController().signal,
};

describe("runWorkflowPhases", () => {
	it("throws when startPhaseIndex is past the last phase", async () => {
		await expect(
			runWorkflowPhases({
				ctx,
				runAgent: noopAgent,
				workflow,
				issue,
				attempt: 1,
				cwd: "/tmp",
				model: "test-model",
				startPhaseIndex: 5,
			}),
		).rejects.toThrow(/startPhaseIndex 5 is out of range for 2 phases/);
	});

	it("throws when startPhaseIndex is negative", async () => {
		await expect(
			runWorkflowPhases({
				ctx,
				runAgent: noopAgent,
				workflow,
				issue,
				attempt: 1,
				cwd: "/tmp",
				model: "test-model",
				startPhaseIndex: -1,
			}),
		).rejects.toThrow(/startPhaseIndex -1 is out of range for 2 phases/);
	});
});
