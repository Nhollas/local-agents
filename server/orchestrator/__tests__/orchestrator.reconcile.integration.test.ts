import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	GITHUB_API,
	hangingAgent,
	noopAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { issueKey, repoSlug, runId as rid } from "../../types/brands.ts";

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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		// First tick: dispatches the agent
		await orchestrator.tick();

		const runsBefore = db.select().from(runs).all();
		expect(runsBefore).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "running",
				error: null,
				repo: REPO,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
			},
		]);

		// Second tick: label was removed → reconcile kills it
		pendingIssues = [];
		runningIssues = [];

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter).toEqual([
			{
				id: runsBefore[0]?.id,
				agentName: "issue-1",
				status: "failed",
				error: "Run killed by user",
				repo: REPO,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: runsBefore[0]?.startedAt,
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
			},
		]);
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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#2`);

		// Dispatch
		await orchestrator.tick();

		// Second tick: label still present → no kill
		pendingIssues = [];
		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-2",
				status: "running",
				error: null,
				repo: REPO,
				issueKey: `${REPO}#2`,
				issueTitle: "Issue 2",
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
			},
		]);
	});

	it("fetches running issues even with no running DB records to detect orphans", async () => {
		let pendingFetches = 0;
		let runningFetches = 0;

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
				const q = new URL(request.url).searchParams.get("q") ?? "";
				const positive = q.split(/\s+/).filter((t) => t.startsWith("label:"));
				if (positive.includes("label:agent:running")) {
					runningFetches++;
				} else {
					pendingFetches++;
				}
				return HttpResponse.json({ total_count: 0, items: [] });
			}),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
		});
		const { orchestrator } = ctx;

		await orchestrator.tick();

		expect(pendingFetches).toBe(1);
		expect(runningFetches).toBe(1);
	});

	it("handles fetch failure gracefully during reconciliation", async () => {
		let pendingIssues = [createGitHubIssue(1, ["agent"])];
		let failRunningFetch = false;

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
				const q = new URL(request.url).searchParams.get("q") ?? "";
				const positive = q.split(/\s+/).filter((t) => t.startsWith("label:"));
				if (positive.includes("label:agent:running")) {
					if (failRunningFetch) {
						return new HttpResponse(null, { status: 500 });
					}
					return HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(1, ["agent", "agent:running"])],
					});
				}
				return HttpResponse.json({
					total_count: pendingIssues.length,
					items: pendingIssues,
				});
			}),
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 204 }),
			),
			http.post(`${GITHUB_API}/repos/${REPO}/issues/:number/labels`, () =>
				HttpResponse.json([]),
			),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		// First tick: dispatches the agent
		await orchestrator.tick();
		const runsBefore = db.select().from(runs).all();
		expect(runsBefore).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "running",
				error: null,
				repo: REPO,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
			},
		]);

		// Second tick: running-label fetch fails — agent should NOT be killed
		pendingIssues = [];
		failRunningFetch = true;

		await orchestrator.tick();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter).toEqual(runsBefore);
	});

	it("does not orphan-reconcile a run with pending post-run work", async () => {
		let pendingIssues = [createGitHubIssue(1, ["agent"])];
		let runningIssues: ReturnType<typeof createGitHubIssue>[] = [];
		let releasePrCreate = () => {};
		const prCreateBarrier = new Promise<void>(
			(resolve) => (releasePrCreate = resolve),
		);

		// Strict one-shot handlers in dispatch order:
		// 1. DELETE labels/agent       (initial swap pending → running)
		// 2. POST labels [agent:running]
		// 3. DELETE labels/agent:running (post-success swap → awaiting-review)
		// 4. POST labels [agent:awaiting-review]
		// We assert finalSwap*.isUsed to confirm the ONLY swap that ran was the
		// post-success one — no orphan-reconcile kill happened mid-flight.
		const initialDelete = http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/agent`,
			() => new HttpResponse(null, { status: 204 }),
			{ once: true },
		);
		const initialPost = http.post(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			async ({ request }) => {
				const body = (await request.json()) as { labels: string[] };
				if (body.labels[0] !== "agent:running") {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json([]);
			},
			{ once: true },
		);
		const finalDelete = http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/agent:running`,
			() => new HttpResponse(null, { status: 204 }),
			{ once: true },
		);
		const finalPost = http.post(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			async ({ request }) => {
				const body = (await request.json()) as { labels: string[] };
				if (body.labels[0] !== "agent:awaiting-review") {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json([]);
			},
			{ once: true },
		);

		server.use(
			initialDelete,
			initialPost,
			finalDelete,
			finalPost,
			// Custom PR handler must come first to override the default in githubHandlers
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, async () => {
				await prCreateBarrier;
				return HttpResponse.json({
					number: 1,
					html_url: `https://github.com/${REPO}/pull/1`,
				});
			}),
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent") return pendingIssues;
					if (label === "agent:running") return runningIssues;
					return [];
				},
			}),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			runAgent: noopAgent,
		});
		const { orchestrator, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		// Tick 1: dispatches the agent. Handler completes instantly (noopAgent),
		// but onSettled blocks on PR creation (barrier).
		await orchestrator.tick();

		// Simulate GitHub still showing agent:running (label swap hasn't happened yet)
		pendingIssues = [];
		runningIssues = [createGitHubIssue(1, ["agent:running"])];

		// Tick 2: should NOT orphan-reconcile because the issue is settling.
		// The post-success swap handlers must remain unused after this tick.
		await orchestrator.tick();

		expect(finalDelete.isUsed).toBe(false);
		expect(finalPost.isUsed).toBe(false);

		// Release the barrier and let onSettled finish
		releasePrCreate();
		await orchestrator.settled();

		expect(finalDelete.isUsed).toBe(true);
		expect(finalPost.isUsed).toBe(true);
	});

	it("marks stale DB runs as failed when no process exists to kill", async () => {
		server.use(
			...githubHandlers({
				resolveIssues: () => [],
			}),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
		});
		const { orchestrator, db } = ctx;

		// Seed a "running" record with no actual process (simulates server restart)
		db.insert(runs)
			.values({
				id: rid("stale-run"),
				agentName: "issue-5",
				status: "running",
				repo: repoSlug(REPO),
				issueKey: issueKey(`${REPO}#5`),
				issueTitle: "Stale issue",
				startedAt: "2025-01-01T00:00:00Z",
			})
			.run();

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: "stale-run",
				agentName: "issue-5",
				status: "failed",
				error: "Stale run from previous session",
				repo: REPO,
				issueKey: `${REPO}#5`,
				issueTitle: "Stale issue",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: null,
			},
		]);

		// Second tick should NOT log reconcile_terminal again
		await orchestrator.tick();

		const runsAfterSecondTick = db.select().from(runs).all();
		expect(runsAfterSecondTick).toEqual(allRuns);
	});

	it("rolls back the running state label when GitHub still says agent:running but DB has no running run, leaving the trigger label intact", async () => {
		const recoveryDelete = http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/agent:running`,
			() => new HttpResponse(null, { status: 204 }),
			{ once: true },
		);
		const triggerLabelMutation = http.post(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			() =>
				new HttpResponse("trigger label must not be mutated", {
					status: 500,
				}),
		);

		server.use(
			recoveryDelete,
			triggerLabelMutation,
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent:running")
						return [createGitHubIssue(1, ["agent:running"])];
					return [];
				},
			}),
		);

		await using ctx = await createTestOrchestrator({ runAgent: noopAgent });
		const { orchestrator, db, runner } = ctx;

		db.insert(runs)
			.values({
				id: rid("completed-orphan"),
				agentName: "issue-1",
				status: "completed",
				repo: repoSlug(REPO),
				issueKey: issueKey(`${REPO}#1`),
				issueTitle: "Issue 1",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				durationMs: 1,
			})
			.run();

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(recoveryDelete.isUsed).toBe(true);
		expect(triggerLabelMutation.isUsed).toBe(false);
	});
});
