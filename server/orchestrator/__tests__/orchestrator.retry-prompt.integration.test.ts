import { describe, expect, it } from "vitest";
import {
	createGitHubIssue,
	createPromptSpyAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";

const failedRunDefaults = {
	agentName: "issue-1",
	status: "failed" as const,
	issueKey: `${REPO}#1`,
	issueTitle: "Fix the login bug",
	completedAt: new Date().toISOString(),
	error: "agent exploded",
	sessionId: "sess-abc",
	attempt: 1,
};

describe("Orchestrator retry prompt fidelity", () => {
	it("renders the retry prompt with the original issue description", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		const { spyAgent, getCaptured } = createPromptSpyAgent();

		const workflow: RepoWorkflow = {
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
			prompt:
				"Fix issue #{{ issue.number }}: {{ issue.title }}\n\nDescription: {{ issue.description }}",
		};

		await using ctx = await createTestOrchestrator({
			workflows: new Map([[REPO, workflow]]),
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, { ...failedRunDefaults, id: "failed-prompt" });

		await orchestrator.retryRun("failed-prompt");
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const { prompt } = getCaptured();
		expect(prompt).toBe(
			"Fix issue #1: Issue 1\n\nDescription: Description for issue 1",
		);
	});

	it("includes issue labels in the retry prompt", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		const { spyAgent, getCaptured } = createPromptSpyAgent();

		const workflow: RepoWorkflow = {
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
			prompt:
				"Fix issue #{{ issue.number }} [{{ issue.labels }}]: {{ issue.title }}",
		};

		await using ctx = await createTestOrchestrator({
			workflows: new Map([[REPO, workflow]]),
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, { ...failedRunDefaults, id: "failed-meta" });

		await orchestrator.retryRun("failed-meta");
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const { prompt } = getCaptured();
		expect(prompt).toBe("Fix issue #1 [agent:running]: Issue 1");
	});
});
