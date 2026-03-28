import { access } from "node:fs/promises";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
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
import { githubCodeHostAdapter } from "./code-hosts/github.ts";
import { createGitHubClient } from "./gh.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createRunner } from "./runner.ts";
import { runs } from "./schema.ts";
import { githubTrackerAdapter } from "./trackers/github.ts";
import type { RepoWorkflow } from "./types.ts";

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

		expect(labelOps).toContainEqual({ method: "delete", label: "agent" });
		expect(labelOps).toContainEqual({ method: "add", label: "agent:running" });

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].agentName).toBe("issue-1");
		expect(allRuns[0].issueKey).toBe(`${REPO}#1`);
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
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].agentName).toBe("issue-1");
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
		const dispatched = allRuns.map((r) => r.agentName);
		expect(dispatched).toEqual(["issue-42", "issue-77"]);
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
		expect(runsBefore).toHaveLength(1);

		// Second tick: same issue still has `agent` label — should not dispatch again
		await orchestrator.tick();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter).toHaveLength(1);
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

		await expect(access(sentinelPath)).resolves.toBeUndefined();
	});

	it("before_run failure does not prevent dispatch", async () => {
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

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].status).toBe("completed");
	});

	it("onComplete failure (PR creation 500) leaves run completed but label stays running", async () => {
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

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].status).toBe("completed");

		// PR creation failed, so swapLabel to awaiting-review never happened
		expect(labelOps).not.toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
		// Label should still be agent:running (set during dispatch, never swapped)
		expect(labelOps).toContainEqual({ method: "add", label: "agent:running" });
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

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].agentName).toBe("issue-10");
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

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(2);

		const names = allRuns.map((r) => r.agentName).sort();
		expect(names).toEqual(["issue-1", "issue-2"]);
	});

	it("stores sessionId when agent emits messages with session_id", async () => {
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
			runAgent: createSessionAgent("test-sess-abc"),
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].sessionId).toBe("test-sess-abc");
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

		const allRuns = db.select().from(runs).all();
		expect(allRuns[0].status).toBe("failed");

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

		// Should have swapped agent:running → agent (back to pending)
		expect(labelOps).toContainEqual({
			method: "delete",
			label: "agent:running",
		});
		expect(labelOps).toContainEqual({ method: "add", label: "agent" });
	});
});
