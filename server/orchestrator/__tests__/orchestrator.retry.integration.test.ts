import { describe, expect, it } from "vitest";
import { githubCodeHostAdapter } from "../../code-hosts/github.ts";
import { runs } from "../../db/schema.ts";
import { createGitHubClient } from "../../github-client.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import {
	createGitHubIssue,
	createPromptSpyAgent,
	createTestWorkflow,
	noopAgent,
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
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "failed-1" });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("failed-1");
		expect(result).toEqual({ runId: expect.any(String) });

		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		const retryRun = allRuns.find((r) => r.id !== "failed-1");
		expect(retryRun).toEqual({
			id: expect.any(String),
			agentName: "issue-1",
			status: "completed",
			error: null,
			issueKey: `${REPO}#1`,
			issueTitle: "Issue 1",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 2,
			parentRunId: "failed-1",
		});
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
		const repo = createRunRepository(db);
		seedRun(db, {
			...failedRunDefaults,
			id: "failed-2",
			sessionId: "sess-resume-me",
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const { spyAgent, getCaptured } = createPromptSpyAgent();

		const orchestrator = createOrchestrator({
			runRepo: repo,
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

		expect(getCaptured().options).toEqual({
			cwd: expect.stringContaining("test-owner_test-repo_1"),
			model: "claude-sonnet-4-6",
			allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
			permissionMode: "dontAsk",
			resume: "sess-resume-me",
		});
	});

	it("rejects retry when run does not exist", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		const repo = createRunRepository(db);
		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig(),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("nonexistent-id");
		expect(result).toEqual({ error: "Run not found" });
	});

	it("uses fetched issue title even when failed run has no stored issueTitle", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const repo = createRunRepository(db);
		seedRun(db, {
			...failedRunDefaults,
			id: "no-title",
			issueTitle: null,
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		const result = await orchestrator.retryRun("no-title");
		expect(result).toEqual({ runId: expect.any(String) });

		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		const retryRun = allRuns.find((r) => r.id !== "no-title");
		expect(retryRun).toEqual({
			id: expect.any(String),
			agentName: "issue-1",
			status: "completed",
			error: null,
			issueKey: `${REPO}#1`,
			issueTitle: "Issue 1",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 2,
			parentRunId: "no-title",
		});
	});

	it("rejects retry when run is not failed", async () => {
		server.use(...githubHandlers());

		const db = createTestDb();
		const repo = createRunRepository(db);
		seedRun(db, {
			...failedRunDefaults,
			id: "completed-1",
			status: "completed",
			error: undefined,
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
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
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "no-sess", sessionId: null });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
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
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "maxed-out", attempt: 4 });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
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
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "no-issue", issueKey: null });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
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
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "no-workflow" });

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
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
		const repo = createRunRepository(db);
		seedRun(db, { ...failedRunDefaults, id: "failed-dup" });
		seedRun(db, {
			id: "running-1",
			agentName: "issue-1",
			status: "running",
			issueKey: `${REPO}#1`,
		});

		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
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
