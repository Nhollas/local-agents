import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
	createGitHubIssue,
	createTestWorkflow,
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

describe("Orchestrator reconciliation", () => {
	it("kills agent when issue no longer has the running label", async () => {
		let pendingIssues = [createGitHubIssue(1, ["agent"])];
		let runningIssues: ReturnType<typeof createGitHubIssue>[] = [];

		server.use(
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent") return pendingIssues;
					if (label === "agent:running") return runningIssues;
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
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 5,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		// First tick: dispatches the agent
		await orchestrator.tick();

		const runsBefore = db.select().from(runs).all();
		expect(runsBefore).toHaveLength(1);
		expect(runsBefore[0].status).toBe("running");

		// Second tick: label was removed → reconcile kills it
		pendingIssues = [];
		runningIssues = [];

		await orchestrator.tick();
		await runner.queue.waitForIdle();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter[0].status).toBe("failed");
		expect(runsAfter[0].error).toContain("killed");
	});

	it("keeps agent running when label is still present", async () => {
		let pendingIssues = [createGitHubIssue(2, ["agent"])];

		server.use(
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent") return pendingIssues;
					if (label === "agent:running")
						return [createGitHubIssue(2, ["agent:running"])];
					return [];
				},
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#2`);

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
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		// Dispatch
		await orchestrator.tick();

		// Second tick: label still present → no kill
		pendingIssues = [];
		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns[0].status).toBe("running");
	});

	it("skips repos with no running agents (avoids unnecessary API call)", async () => {
		let fetchCallCount = 0;

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				fetchCallCount++;
				if (label === "agent") return HttpResponse.json([]);
				// If this is called with agent:running and there are no running agents,
				// that means we made an unnecessary fetch
				if (label === "agent:running") return HttpResponse.json([]);
				return HttpResponse.json([]);
			}),
		);

		await using workspace = await createTestWorkspaceRoot();

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
			runAgent: noopAgent,
		});

		// No running agents — tick should only fetch pending issues, not running ones
		await orchestrator.tick();

		// Should have fetched pending issues (1 call) but NOT running issues
		expect(fetchCallCount).toBe(1);
	});

	it("handles fetch failure gracefully during reconciliation", async () => {
		let pendingIssues = [createGitHubIssue(1, ["agent"])];
		let failRunningFetch = false;

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") return HttpResponse.json(pendingIssues);
				if (label === "agent:running") {
					if (failRunningFetch) {
						return new HttpResponse(null, { status: 500 });
					}
					return HttpResponse.json([createGitHubIssue(1, ["agent:running"])]);
				}
				return HttpResponse.json([]);
			}),
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 204 }),
			),
			http.post(`${GITHUB_API}/repos/${REPO}/issues/:number/labels`, () =>
				HttpResponse.json([]),
			),
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
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 5,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		// First tick: dispatches the agent
		await orchestrator.tick();
		expect(db.select().from(runs).all()).toHaveLength(1);

		// Second tick: running-label fetch fails — agent should NOT be killed
		pendingIssues = [];
		failRunningFetch = true;

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns[0].status).toBe("running");
	});
});
