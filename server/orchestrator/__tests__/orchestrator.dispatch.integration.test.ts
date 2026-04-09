import { describe, expect, it } from "vitest";
import { githubCodeHostAdapter } from "../../code-hosts/github.ts";
import { runs } from "../../db/schema.ts";
import { createGitHubClient } from "../../github-client.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import {
	createGitHubIssue,
	createTestWorkflow,
	hangingAgent,
	noopAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestConfig } from "../../testing/support/test-config.ts";
import { createTestDb } from "../../testing/support/test-db.ts";
import { createTestWorkspaceRoot } from "../../testing/support/test-workspace.ts";
import { githubTrackerAdapter } from "../../trackers/github.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import { createOrchestrator } from "../orchestrator.ts";

describe("Orchestrator dispatch", () => {
	it("dispatches agent for a pending issue, swaps label, and creates DB record", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const repo = createRunRepository(db);
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

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(labelOps).toContainEqual({ method: "delete", label: "agent" });
		expect(labelOps).toContainEqual({ method: "add", label: "agent:running" });

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
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
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("creates PR and swaps to awaiting-review on successful completion", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(5, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#5`);

		const db = createTestDb();
		const repo = createRunRepository(db);
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

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(labelOps).toContainEqual({
			method: "delete",
			label: "agent:running",
		});
		expect(labelOps).toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
	});

	it("respects max_concurrent limit", async () => {
		server.use(
			...githubHandlers({
				issues: [
					createGitHubIssue(1, ["agent"], "2025-01-01T00:00:00Z"),
					createGitHubIssue(2, ["agent"], "2025-01-02T00:00:00Z"),
					createGitHubIssue(3, ["agent"], "2025-01-03T00:00:00Z"),
				],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		for (const num of [1, 2, 3]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		const db = createTestDb();
		const repo = createRunRepository(db);
		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 1,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "running",
				error: null,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("dispatches oldest issues first", async () => {
		server.use(
			...githubHandlers({
				issues: [
					createGitHubIssue(99, ["agent"], "2025-01-03T00:00:00Z"),
					createGitHubIssue(42, ["agent"], "2025-01-01T00:00:00Z"),
					createGitHubIssue(77, ["agent"], "2025-01-02T00:00:00Z"),
				],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		for (const num of [42, 77, 99]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		const db = createTestDb();
		const repo = createRunRepository(db);
		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 2,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-42",
				status: "completed",
				error: null,
				issueKey: `${REPO}#42`,
				issueTitle: "Issue 42",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
			{
				id: expect.any(String),
				agentName: "issue-77",
				status: "completed",
				error: null,
				issueKey: `${REPO}#77`,
				issueTitle: "Issue 77",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("skips issues that already have a running agent", async () => {
		const pendingIssues = [createGitHubIssue(1, ["agent"])];

		server.use(
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent") return pendingIssues;
					if (label === "agent:running")
						return [createGitHubIssue(1, ["agent:running"])];
					return [];
				},
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const repo = createRunRepository(db);
		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		// First tick: dispatches the agent
		await orchestrator.tick();

		const runsBefore = db.select().from(runs).all();
		expect(runsBefore).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "running",
				error: null,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);

		// Second tick: same issue still has `agent` label — should not dispatch again
		await orchestrator.tick();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter).toEqual(runsBefore);
	});

	it("rolls back label (running → pending) when workspace creation fails", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);

		// DON'T pre-create workspace — let ensureWorkspace try git clone against
		// MSW's fake URL, which will fail because it's not a real git remote
		await using workspace = await createTestWorkspaceRoot();

		const db = createTestDb();
		const repo = createRunRepository(db);
		const github = createGitHubClient("test-token");
		const runner = createRunner({ repo, maxConcurrency: 2 });

		const codeHost = githubCodeHostAdapter(github);
		const orchestrator = createOrchestrator({
			runRepo: repo,
			tracker: githubTrackerAdapter(github),
			// Override cloneUrl to a non-existent local path so git clone fails
			// instantly instead of waiting for a network timeout
			codeHost: { ...codeHost, cloneUrl: () => "/nonexistent/repo.git" },
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(labelOps).toContainEqual({ method: "add", label: "agent:running" });
		expect(labelOps).toContainEqual({
			method: "delete",
			label: "agent:running",
		});
		expect(labelOps).toContainEqual({ method: "add", label: "agent" });

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(0);
	});
});
