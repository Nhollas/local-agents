import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	createPromptSpyAgent,
	createTestWorkflow,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator shell expansion", () => {
	it("passes expanded shell output to the agent", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		const { spyAgent, getCaptured } = createPromptSpyAgent();

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[
					REPO,
					createTestWorkflow({
						phases: [
							{
								name: "prompt",
								prompt: "Fix issue {{ issue.number }}\n!`printf from-shell`",
								resume_previous: false,
							},
						],
					}),
				],
			]),
			runAgent: spyAgent,
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const { prompt } = getCaptured();
		expect(prompt).toBe("Fix issue 1\nfrom-shell");
	});

	it("records a failed run when shell expansion exits non-zero", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		let agentCalled = false;

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[
					REPO,
					createTestWorkflow({
						phases: [
							{
								name: "prompt",
								prompt: "!`printf expansion-failed >&2; exit 7`",
								resume_previous: false,
							},
						],
					}),
				],
			]),
			// biome-ignore lint/correctness/useYield: test asserts this generator is not called
			runAgent: async function* shellFailureAgent() {
				agentCalled = true;
			},
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(agentCalled).toBe(false);

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "failed",
				error: expect.stringMatching(
					/exited with code 7[\s\S]*stderr: expansion-failed/,
				),
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
				phaseIndex: 0,
			},
		]);
	});
});
