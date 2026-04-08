import { access } from "node:fs/promises";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { githubCodeHostAdapter } from "../code-hosts/github.ts";
import { runs } from "../db/schema.ts";
import { createGitHubClient } from "../github-client.ts";
import { createRunner } from "../runner/runner.ts";
import {
	createGitHubIssue,
	createSessionAgent,
	createTestWorkflow,
	failingAgent,
	GITHUB_API,
	hangingAgent,
	noopAgent,
	REPO,
} from "../tests/support/fixtures.ts";
import { githubHandlers, server } from "../tests/support/msw.ts";
import { createTestConfig } from "../tests/support/test-config.ts";
import { createTestDb } from "../tests/support/test-db.ts";
import { createTestWorkspaceRoot } from "../tests/support/test-workspace.ts";
import { githubTrackerAdapter } from "../trackers/github.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { createOrchestrator } from "./orchestrator.ts";

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
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
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
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
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
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
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
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const codeHost = githubCodeHostAdapter(github);
		const orchestrator = createOrchestrator({
			db,
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

	it("before_run hook executes before agent starts", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		// Custom agent that checks marker file exists during execution
		let markerExistedDuringRun = false;
		// biome-ignore lint/correctness/useYield: agent only needs side effects, no messages to yield
		async function* checkMarkerAgent() {
			const wsDir = join(workspace.root, "test-owner_test-repo_1");
			try {
				await access(join(wsDir, "marker"));
				markerExistedDuringRun = true;
			} catch {
				markerExistedDuringRun = false;
			}
		}

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([
				[REPO, createTestWorkflow({ hooks: { before_run: "touch marker" } })],
			]),
			runner,
			runAgent: checkMarkerAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(markerExistedDuringRun).toBe(true);
	});

	it("after_run hook executes after agent handler completes", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		// The after_run hook writes a marker file outside the workspace root
		// so it survives workspace cleanup by onFinally
		const sentinelPath = join(workspace.root, "after_marker_sentinel");

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([
				[
					REPO,
					createTestWorkflow({
						hooks: { after_run: `touch ${sentinelPath}` },
					}),
				],
			]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		await expect(access(sentinelPath)).resolves.toBeUndefined();
	});

	it("before_run failure prevents dispatch", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([
				[
					REPO,
					createTestWorkflow({
						hooks: { before_run: "exit 1" },
					}),
				],
			]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(0);
	});

	it("transitions label to awaiting-review even when PR creation fails", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);
		// PR 500 handler registered AFTER githubHandlers so MSW checks it FIRST (LIFO)
		server.use(
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
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

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

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

		// PR creation failed, but label should still transition to awaiting-review
		expect(labelOps).toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
	});

	it("after_run hook failure does not prevent completion", async () => {
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
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([
				[
					REPO,
					createTestWorkflow({
						hooks: { after_run: "exit 1" },
					}),
				],
			]),
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

		expect(labelOps).toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
	});

	it("does not crash when both PR creation and label recovery fail", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);
		// PR creation fails
		server.use(
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
		);
		// Label delete succeeds for "agent" (dispatch) but fails for "agent:running" (recovery)
		server.use(
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				({ params }) => {
					const label = decodeURIComponent(params["label"] as string);
					if (label === "agent:running") {
						return new HttpResponse(null, { status: 500 });
					}
					return new HttpResponse(null, { status: 204 });
				},
			),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
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

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

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

	it("onFinally triggers workspace cleanup", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		const wsDir = await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
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

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		// Workspace should have been cleaned up by onFinally → removeWorkspace
		await expect(access(wsDir)).rejects.toThrow();
	});

	it("ticking guard prevents concurrent ticks", async () => {
		let issuesFetchCount = 0;

		server.use(
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent") {
						issuesFetchCount++;
						return [createGitHubIssue(1, ["agent"])];
					}
					return [];
				},
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		await Promise.all([orchestrator.tick(), orchestrator.tick()]);

		// Only one tick should have fetched issues — the second bailed at the guard
		expect(issuesFetchCount).toBe(1);
	});

	it("fetch failure for one repo does not block other repos", async () => {
		const REPO2 = "test-owner/second-repo";

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			// First repo: issues endpoint returns 500
			http.get(`${GITHUB_API}/repos/${REPO}/issues`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
			// Second repo: returns a valid issue
			http.get(`${GITHUB_API}/repos/${REPO2}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") {
					return HttpResponse.json([createGitHubIssue(10, ["agent"])]);
				}
				return HttpResponse.json([]);
			}),
			http.delete(
				`${GITHUB_API}/repos/${REPO2}/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 204 }),
			),
			http.post(`${GITHUB_API}/repos/${REPO2}/issues/:number/labels`, () =>
				HttpResponse.json([]),
			),
			http.post(`${GITHUB_API}/repos/${REPO2}/pulls`, () =>
				HttpResponse.json({
					number: 1,
					html_url: `https://github.com/${REPO2}/pull/1`,
				}),
			),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO2}#10`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([
				[REPO, createTestWorkflow()],
				[REPO2, createTestWorkflow()],
			]),
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
				agentName: "issue-10",
				status: "completed",
				error: null,
				issueKey: `${REPO2}#10`,
				issueTitle: "Issue 10",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("dispatches issues across multiple repos", async () => {
		const REPO2 = "test-owner/second-repo";

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") {
					return HttpResponse.json([
						createGitHubIssue(1, ["agent"], "2025-01-01T00:00:00Z"),
					]);
				}
				return HttpResponse.json([]);
			}),
			http.get(`${GITHUB_API}/repos/${REPO2}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") {
					return HttpResponse.json([
						createGitHubIssue(2, ["agent"], "2025-01-02T00:00:00Z"),
					]);
				}
				return HttpResponse.json([]);
			}),
			http.delete(
				`${GITHUB_API}/repos/:owner/:repo/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 204 }),
			),
			http.post(`${GITHUB_API}/repos/:owner/:repo/issues/:number/labels`, () =>
				HttpResponse.json([]),
			),
			http.post(`${GITHUB_API}/repos/:owner/:repo/pulls`, () =>
				HttpResponse.json({
					number: 1,
					html_url: "https://github.com/test/pull/1",
				}),
			),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);
		await workspace.preCreateWorkspace(`${REPO2}#2`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 5,
			}),
			workflows: new Map<string, RepoWorkflow>([
				[REPO, createTestWorkflow()],
				[REPO2, createTestWorkflow()],
			]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual(
			expect.arrayContaining([
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
				{
					id: expect.any(String),
					agentName: "issue-2",
					status: "completed",
					error: null,
					issueKey: `${REPO2}#2`,
					issueTitle: "Issue 2",
					startedAt: expect.any(String),
					completedAt: expect.any(String),
					durationMs: expect.any(Number),
					sessionId: null,
					attempt: 1,
					parentRunId: null,
				},
			]),
		);
		expect(allRuns).toHaveLength(2);
	});

	it("stores sessionId when agent emits assistant messages", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: createSessionAgent("test-sess-abc", [
				{ type: "text", text: "Working on it" },
			]),
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

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
				sessionId: "test-sess-abc",
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("completes run when agent emits non-assistant messages", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		// biome-ignore lint/suspicious/noExplicitAny: decouple test fixture from SDK's message shape
		async function* mixedMessageAgent(): AsyncGenerator<any> {
			yield { type: "system" };
			yield {
				type: "assistant",
				session_id: "sess-mixed",
				message: { content: [] },
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000099",
			};
		}

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: mixedMessageAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

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
				sessionId: "sess-mixed",
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("preserves workspace on agent failure when retries remain", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		const wsDir = await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_retries: 3,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: failingAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "failed",
				error: "agent exploded",
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

		// Workspace should still exist (not cleaned up)
		await expect(access(wsDir)).resolves.toBeUndefined();
	});

	it("cleans up workspace on agent failure when retries exhausted", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		const wsDir = await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_retries: 0,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: failingAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		// Workspace should be cleaned up
		await expect(access(wsDir)).rejects.toThrow();
	});

	it("swaps label back to pending when retries exhausted", async () => {
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
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_retries: 0,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: failingAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		// Should have swapped agent:running → agent (back to pending)
		expect(labelOps).toContainEqual({
			method: "delete",
			label: "agent:running",
		});
		expect(labelOps).toContainEqual({ method: "add", label: "agent" });
	});

	it("does not crash when label rollback fails after retries exhausted", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);
		// First delete (dispatch: remove "agent") succeeds, second (rollback: remove "agent:running") fails
		server.use(
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				function* () {
					yield new HttpResponse(null, { status: 204 });
					return new HttpResponse(null, { status: 500 });
				},
			),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_retries: 0,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: failingAgent,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "failed",
				error: "agent exploded",
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

	it("continues processing when dispatch rollback label swap fails", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);
		// Override: label delete succeeds for "agent" (initial swap) but fails
		// for "agent:running" (the rollback after dispatch failure)
		server.use(
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				({ params }) => {
					const label = decodeURIComponent(params["label"] as string);
					if (label === "agent:running") {
						return new HttpResponse(null, { status: 500 });
					}
					return new HttpResponse(null, { status: 204 });
				},
			),
		);

		await using workspace = await createTestWorkspaceRoot();
		// Don't pre-create workspace so git clone fails → dispatch fails → rollback fires

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const codeHost = githubCodeHostAdapter(github);
		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: { ...codeHost, cloneUrl: () => "/nonexistent/repo.git" },
			config: createTestConfig({
				workspace_root: workspace.root,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(0);
	});

	it("start() triggers polling and stop() halts it", async () => {
		vi.useFakeTimers();

		let tickCount = 0;

		server.use(
			...githubHandlers({
				resolveIssues: () => {
					tickCount++;
					return [];
				},
			}),
		);

		await using workspace = await createTestWorkspaceRoot();

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				polling_interval_ms: 1000,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		orchestrator.start();

		await vi.advanceTimersByTimeAsync(0);
		expect(tickCount).toBe(2);

		await vi.advanceTimersByTimeAsync(1000);
		expect(tickCount).toBe(4);

		orchestrator.stop();

		await vi.advanceTimersByTimeAsync(5000);
		expect(tickCount).toBe(4);

		vi.useRealTimers();
	});

	it("start() keeps polling when tick() throws on a label swap failure", async () => {
		vi.useFakeTimers();

		let tickCount = 0;

		server.use(
			...githubHandlers({
				resolveIssues: () => {
					tickCount++;
					return [createGitHubIssue(1, ["agent"])];
				},
			}),
		);
		// Label delete always fails, so the initial swap (pending → running) throws
		server.use(
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 500 }),
			),
		);

		await using workspace = await createTestWorkspaceRoot();

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				polling_interval_ms: 1000,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		orchestrator.start();

		await vi.advanceTimersByTimeAsync(0);
		expect(tickCount).toBe(2);

		await vi.advanceTimersByTimeAsync(1000);
		expect(tickCount).toBe(4);

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(0);

		orchestrator.stop();
		vi.useRealTimers();
	});
});
