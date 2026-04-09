import { describe, expect, it } from "vitest";
import { githubCodeHostAdapter } from "../../code-hosts/github.ts";
import { createGitHubClient } from "../../github-client.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import {
	createGitHubIssue,
	createPromptSpyAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestConfig } from "../../testing/support/test-config.ts";
import { createTestDb, seedRun } from "../../testing/support/test-db.ts";
import { createTestWorkspaceRoot } from "../../testing/support/test-workspace.ts";
import { githubTrackerAdapter } from "../../trackers/github.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import { createOrchestrator } from "../orchestrator.ts";

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

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "failed-prompt" });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });
		const { spyAgent, getCaptured } = createPromptSpyAgent();

		const workflow: RepoWorkflow = {
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
			prompt:
				"Fix issue #{{ issue.number }}: {{ issue.title }}\n\nDescription: {{ issue.description }}",
		};

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, workflow]]),
			runner,
			runAgent: spyAgent,
		});

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

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "failed-meta" });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });
		const { spyAgent, getCaptured } = createPromptSpyAgent();

		const workflow: RepoWorkflow = {
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
			prompt:
				"Fix issue #{{ issue.number }} [{{ issue.labels }}]: {{ issue.title }}",
		};

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, workflow]]),
			runner,
			runAgent: spyAgent,
		});

		await orchestrator.retryRun("failed-meta");
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const { prompt } = getCaptured();
		expect(prompt).toBe("Fix issue #1 [agent:running]: Issue 1");
	});
});
