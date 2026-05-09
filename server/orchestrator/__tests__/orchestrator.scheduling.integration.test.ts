import { describe, expect, it, vi } from "vitest";
import {
	hangingAgent,
	jiraIssueKey,
	REPO,
} from "../../__test-support__/support/fixtures.ts";
import { seedRun } from "../../__test-support__/support/test-db.ts";
import { createTestOrchestrator } from "../../__test-support__/support/test-orchestrator.ts";
import { runs } from "../../db/schema.ts";

describe("Orchestrator scheduling", () => {
	it("transitions pending → running on dispatch", async () => {
		await using ctx = await createTestOrchestrator({
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
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
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 1, from: "pending", to: "running" },
		]);
	});

	it("respects max_concurrent limit", async () => {
		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 1 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace, tracker } = ctx;
		for (const num of [1, 2, 3]) {
			tracker.addIssue("pending", {
				number: num,
				repo: REPO,
				createdAt: `2025-01-0${num}T00:00:00.000+0000`,
			});
			await workspace.preCreateWorkspace(jiraIssueKey(num));
		}

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
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
	});

	it("dispatches oldest issues first", async () => {
		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 2 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace, tracker } = ctx;
		tracker.addIssue("pending", {
			number: 99,
			repo: REPO,
			createdAt: "2025-01-03T00:00:00.000+0000",
		});
		tracker.addIssue("pending", {
			number: 42,
			repo: REPO,
			createdAt: "2025-01-01T00:00:00.000+0000",
		});
		tracker.addIssue("pending", {
			number: 77,
			repo: REPO,
			createdAt: "2025-01-02T00:00:00.000+0000",
		});
		for (const num of [42, 77, 99]) {
			await workspace.preCreateWorkspace(jiraIssueKey(num));
		}

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns.map((r) => r.issueKey)).toEqual([
			jiraIssueKey(42),
			jiraIssueKey(77),
		]);
	});

	it("skips issues that already have a running agent", async () => {
		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		await orchestrator.tick();
		const before = db.select().from(runs).all();
		await orchestrator.tick();
		const after = db.select().from(runs).all();

		expect(after).toHaveLength(1);
		expect(after).toEqual(before);
	});

	it("rolls back tracker (running → pending) when lifecycle.dispatch throws (workspace clone fails)", async () => {
		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, tracker, codeHost } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		// No preCreateWorkspace + bad cloneUrl ⇒ ensureWorkspace's `git clone` fails.
		codeHost.setCloneUrl(REPO, "/nonexistent/repo.git");

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(db.select().from(runs).all()).toHaveLength(0);
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 1, from: "pending", to: "running" },
			{ repo: REPO, number: 1, from: "running", to: "pending" },
		]);
	});

	it("start() polls on the configured interval and stop() halts it", async () => {
		vi.useFakeTimers();

		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 1000 },
		});
		const { orchestrator, tracker } = ctx;

		orchestrator.start();
		await vi.advanceTimersByTimeAsync(0);
		// startup recover (running) + first tick (pending)
		expect(tracker.fetchCalls).toEqual(["running", "pending"]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(tracker.fetchCalls).toEqual(["running", "pending", "pending"]);

		orchestrator.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(tracker.fetchCalls).toEqual(["running", "pending", "pending"]);

		vi.useRealTimers();
	});

	it("start() runs recovery before the first tick dispatches pending issues", async () => {
		// Real timers because dispatch awaits real fs I/O in ensureWorkspace; fake
		// timers don't drain the libuv thread pool. Polling interval is set very
		// long so the first-tick assertion observes only the startup sequence.
		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 60_000 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace, tracker } = ctx;

		seedRun(db, {
			id: "stale-run",
			agentName: "issue-99",
			status: "running",
			issueKey: jiraIssueKey(99),
			issueTitle: "Stale issue",
			startedAt: "2025-01-01T00:00:00Z",
		});
		tracker.addIssue("pending", { number: 1, repo: REPO });
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		orchestrator.start();
		await vi.waitFor(() => {
			expect(db.select().from(runs).all()).toHaveLength(2);
		});

		// Recovery happened first: stale run failed and tracker fetched "running".
		// Then first tick dispatched the pending issue.
		expect(tracker.fetchCalls).toEqual(["running", "pending"]);
		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: "stale-run",
				agentName: "issue-99",
				status: "failed",
				error: "Stale run from previous session",
				repo: REPO,
				issueKey: jiraIssueKey(99),
				issueTitle: "Stale issue",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: null,
			},
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

		orchestrator.stop();
	});

	it("keeps polling when a tick throws on a transition failure", async () => {
		vi.useFakeTimers();

		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 1000 },
		});
		const { orchestrator, db, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		tracker.failNextTransition();

		orchestrator.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);

		// Recovery + at least two ticks fired despite the dispatch-time throw.
		expect(
			tracker.fetchCalls.filter((s) => s === "pending").length,
		).toBeGreaterThanOrEqual(2);
		expect(db.select().from(runs).all()).toHaveLength(0);

		orchestrator.stop();
		vi.useRealTimers();
	});
});
