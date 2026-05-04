import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createScopedJiraIssue,
	GITLAB_API,
	GITLAB_BASE_URL,
	hangingAgent,
	JIRA_API,
	jiraIssueKey,
	noopAgent,
	REPO,
	STATUSES,
} from "../../testing/support/fixtures.ts";
import { jiraHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { issueKey, repoSlug, runId as rid } from "../../types/brands.ts";

describe("Orchestrator reconciliation", () => {
	it("kills agent when issue is no longer in the running status", async () => {
		let pendingIssues = [createScopedJiraIssue(1)];
		let runningIssues: ReturnType<typeof createScopedJiraIssue>[] = [];

		server.use(
			...jiraHandlers({
				resolveIssues: (status) => {
					if (status === "pending") return pendingIssues;
					if (status === "running") return runningIssues;
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
		await workspace.preCreateWorkspace(jiraIssueKey(1));

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
				issueKey: jiraIssueKey(1),
				issueTitle: `Issue ${jiraIssueKey(1)}`,
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
			},
		]);

		// Second tick: status no longer running → reconcile kills it
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
				issueKey: jiraIssueKey(1),
				issueTitle: `Issue ${jiraIssueKey(1)}`,
				startedAt: runsBefore[0]?.startedAt,
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
			},
		]);
	});

	it("keeps agent running when status is still running", async () => {
		let pendingIssues = [createScopedJiraIssue(2)];

		server.use(
			...jiraHandlers({
				resolveIssues: (status) => {
					if (status === "pending") return pendingIssues;
					if (status === "running")
						return [createScopedJiraIssue(2, STATUSES.running)];
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
		await workspace.preCreateWorkspace(jiraIssueKey(2));

		// Dispatch
		await orchestrator.tick();

		// Second tick: status still running → no kill
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
				issueKey: jiraIssueKey(2),
				issueTitle: `Issue ${jiraIssueKey(2)}`,
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
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as { jql?: string };
				const jql = body.jql ?? "";
				if (jql.includes(`status = "${STATUSES.running}"`)) {
					runningFetches++;
				} else if (jql.includes(`status = "${STATUSES.pending}"`)) {
					pendingFetches++;
				}
				return HttpResponse.json({ issues: [] });
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
		let pendingIssues = [createScopedJiraIssue(1)];
		let failRunningFetch = false;

		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as { jql?: string };
				const jql = body.jql ?? "";
				if (jql.includes(`status = "${STATUSES.running}"`)) {
					if (failRunningFetch) {
						return new HttpResponse(null, { status: 500 });
					}
					return HttpResponse.json({
						issues: [createScopedJiraIssue(1, STATUSES.running)],
					});
				}
				if (jql.includes(`status = "${STATUSES.pending}"`)) {
					return HttpResponse.json({ issues: pendingIssues });
				}
				return HttpResponse.json({ issues: [] });
			}),
			http.get(`${JIRA_API}/issue/:key/transitions`, () =>
				HttpResponse.json({
					transitions: [
						{ id: "11", name: "Start", to: { name: STATUSES.running } },
					],
				}),
			),
			http.post(
				`${JIRA_API}/issue/:key/transitions`,
				() => new HttpResponse(null, { status: 204 }),
			),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(jiraIssueKey(1));

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
				issueKey: jiraIssueKey(1),
				issueTitle: `Issue ${jiraIssueKey(1)}`,
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
			},
		]);

		// Second tick: running fetch fails — agent should NOT be killed
		pendingIssues = [];
		failRunningFetch = true;

		await orchestrator.tick();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter).toEqual(runsBefore);
	});

	it("does not orphan-reconcile a run with pending post-run work", async () => {
		let pendingIssues = [createScopedJiraIssue(1)];
		let runningIssues: ReturnType<typeof createScopedJiraIssue>[] = [];
		let releaseMrCreate = () => {};
		const mrCreateBarrier = new Promise<void>(
			(resolve) => (releaseMrCreate = resolve),
		);

		// Strict one-shot transition handlers in dispatch order:
		// 1. POST transition id="11"  (pending → running on dispatch)
		// 2. POST transition id="21"  (running → awaiting_review on success)
		// We assert reviewTransition.isUsed to confirm the post-success transition
		// did NOT fire mid-flight (no orphan-reconcile kill happened).
		const startTransition = http.post(
			`${JIRA_API}/issue/:key/transitions`,
			async ({ request }) => {
				const body = (await request.json()) as { transition: { id: string } };
				if (body.transition.id !== "11") {
					return new HttpResponse(null, { status: 400 });
				}
				return new HttpResponse(null, { status: 204 });
			},
			{ once: true },
		);
		const reviewTransition = http.post(
			`${JIRA_API}/issue/:key/transitions`,
			async ({ request }) => {
				const body = (await request.json()) as { transition: { id: string } };
				if (body.transition.id !== "21") {
					return new HttpResponse(null, { status: 400 });
				}
				return new HttpResponse(null, { status: 204 });
			},
			{ once: true },
		);

		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as { jql?: string };
				const jql = body.jql ?? "";
				if (jql.includes(`status = "${STATUSES.running}"`)) {
					return HttpResponse.json({ issues: runningIssues });
				}
				if (jql.includes(`status = "${STATUSES.pending}"`)) {
					return HttpResponse.json({ issues: pendingIssues });
				}
				return HttpResponse.json({ issues: [] });
			}),
			http.get(`${JIRA_API}/issue/:key/transitions`, () =>
				HttpResponse.json({
					transitions: [
						{ id: "11", name: "Start", to: { name: STATUSES.running } },
						{
							id: "21",
							name: "Review",
							to: { name: STATUSES.awaiting_review },
						},
					],
				}),
			),
			startTransition,
			reviewTransition,
			http.get(`${GITLAB_API}/projects/:project/merge_requests`, () =>
				HttpResponse.json([]),
			),
			http.post(`${GITLAB_API}/projects/:project/merge_requests`, async () => {
				await mrCreateBarrier;
				return HttpResponse.json({
					iid: 1,
					web_url: `${GITLAB_BASE_URL}/${REPO}/-/merge_requests/1`,
				});
			}),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			runAgent: noopAgent,
		});
		const { orchestrator, workspace } = ctx;
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		// Tick 1: dispatches the agent. noopAgent finishes immediately, but
		// onSettled blocks on the MR creation barrier.
		await orchestrator.tick();

		// Simulate Jira still showing the issue in running (transition hasn't completed).
		pendingIssues = [];
		runningIssues = [createScopedJiraIssue(1, STATUSES.running)];

		// Tick 2: should NOT orphan-reconcile because the issue is settling.
		// reviewTransition must remain unused after this tick.
		await orchestrator.tick();

		expect(reviewTransition.isUsed).toBe(false);

		// Release the barrier and let onSettled finish
		releaseMrCreate();
		await orchestrator.settled();

		expect(startTransition.isUsed).toBe(true);
		expect(reviewTransition.isUsed).toBe(true);
	});

	it("marks stale DB runs as failed when no process exists to kill", async () => {
		server.use(
			...jiraHandlers({
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
				issueKey: issueKey(jiraIssueKey(5)),
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
				issueKey: jiraIssueKey(5),
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
});
