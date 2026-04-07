import { describe, expect, it } from "vitest";
import { githubCodeHostAdapter } from "../code-hosts/github.ts";
import { runs } from "../db/schema.ts";
import { createGitHubClient } from "../github-client.ts";
import { createRunner } from "../runner/runner.ts";
import {
	createGitHubIssue,
	createTestWorkflow,
	noopAgent,
	REPO,
} from "../tests/support/fixtures.ts";
import { githubHandlers, server } from "../tests/support/msw.ts";
import { createTestConfig } from "../tests/support/test-config.ts";
import { createTestDb, seedRun } from "../tests/support/test-db.ts";
import { createTestWorkspaceRoot } from "../tests/support/test-workspace.ts";
import { githubTrackerAdapter } from "../trackers/github.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { createOrchestrator } from "./orchestrator.ts";

const failedRunDefaults = {
	agentName: "issue-1",
	status: "failed" as const,
	issueKey: `${REPO}#1`,
	issueTitle: "Test issue",
	completedAt: new Date().toISOString(),
	error: "agent exploded",
	sessionId: "sess-abc",
	attempt: 1,
};

describe("Orchestrator retryRun", () => {
	it("retries a failed run and creates a new run record", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		seedRun(db, { ...failedRunDefaults, id: "failed-1" });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("failed-1");
		expect(result).toHaveProperty("runId");
		expect(result).not.toHaveProperty("error");

		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		const retryRun = allRuns.find((r) => r.id !== "failed-1");
		expect(retryRun).toBeDefined();
		expect(retryRun?.attempt).toBe(2);
		expect(retryRun?.parentRunId).toBe("failed-1");
		expect(retryRun?.status).toBe("completed");
	});

	it("passes resume option to runAgent with the previous sessionId", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		seedRun(db, {
			...failedRunDefaults,
			id: "failed-2",
			sessionId: "sess-resume-me",
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		let capturedOptions: Record<string, unknown> | undefined;
		// biome-ignore lint/correctness/useYield: spy agent only captures params
		async function* spyAgent(params: { options?: Record<string, unknown> }) {
			capturedOptions = params.options;
		}

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: spyAgent,
		});

		await orchestrator.retryRun("failed-2");
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(capturedOptions?.resume).toBe("sess-resume-me");
	});

	it("rejects retry when run is not failed", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		seedRun(db, {
			...failedRunDefaults,
			id: "completed-1",
			status: "completed",
			error: undefined,
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig(),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("completed-1");
		expect(result).toEqual({ error: "Run is not failed" });
	});

	it("rejects retry when run has no sessionId", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		seedRun(db, { ...failedRunDefaults, id: "no-sess", sessionId: null });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig(),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("no-sess");
		expect(result).toEqual({ error: "No session to resume" });
	});

	it("rejects retry when max retries exceeded", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		seedRun(db, { ...failedRunDefaults, id: "maxed-out", attempt: 4 });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ max_retries: 3 }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("maxed-out");
		expect(result).toEqual({ error: "Max retries exceeded" });
	});

	it("rejects retry when run has no issue key", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		seedRun(db, { ...failedRunDefaults, id: "no-issue", issueKey: null });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig(),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("no-issue");
		expect(result).toEqual({ error: "No issue key" });
	});

	it("rejects retry when no workflow exists for the repo", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		seedRun(db, { ...failedRunDefaults, id: "no-workflow" });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig(),
			// Empty workflows map — no workflow for the repo
			workflows: new Map<string, RepoWorkflow>(),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("no-workflow");
		expect(result).toEqual({ error: "No workflow for repo" });
	});

	it("rejects retry when issue already has a running agent", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		seedRun(db, { ...failedRunDefaults, id: "failed-dup" });
		seedRun(db, {
			id: "running-1",
			agentName: "issue-1",
			status: "running",
			issueKey: `${REPO}#1`,
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig(),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("failed-dup");
		expect(result).toEqual({ error: "Issue already has a running agent" });
	});
});
