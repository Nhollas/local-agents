import { describe, expect, it, vi } from "vitest";
import { runs } from "../db/schema.ts";
import { hangingAgent, jiraIssueKey, REPO } from "../test-support/fixtures.ts";
import { seedRun } from "../test-support/test-db.ts";
import { createTestOrchestrator } from "../test-support/test-orchestrator.ts";

const baseRunRow = {
	branch: null,
	workspaceDir: null,
	issueUrl: null,
	repoUrl: null,
	costUsd: null,
	tokensInput: null,
	tokensOutput: null,
	prUrl: null,
	prNumber: null,
	prRepo: null,
	prKind: null,
	finalizeFailurePhase: null,
	finalizeFailureError: null,
};

function dispatchedRunRow(issueNum: number) {
	return {
		...baseRunRow,
		issueUrl: `https://tracker.example.test/browse/${jiraIssueKey(issueNum)}`,
		repoUrl: `https://code-host.example.test/${REPO}`,
	};
}

describe("Orchestrator scheduling", () => {
	it("transitions pending → running on dispatch", async () => {
		await using ctx = await createTestOrchestrator({
			runAgent: hangingAgent,
		});
		const { orchestrator, db, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				...dispatchedRunRow(1),
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
		const { orchestrator, db, tracker } = ctx;
		for (const num of [1, 2, 3]) {
			tracker.addIssue("pending", {
				number: num,
				repo: REPO,
				createdAt: `2025-01-0${num}T00:00:00.000+0000`,
			});
		}

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				...dispatchedRunRow(1),
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
		const { orchestrator, db, tracker } = ctx;
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
		const { orchestrator, db, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });

		await orchestrator.tick();
		const before = db.select().from(runs).all();
		await orchestrator.tick();
		const after = db.select().from(runs).all();

		expect(after).toHaveLength(1);
		expect(after).toEqual(before);
	});

	it("records a failed run and marks the issue failed when clone fails inside the lifecycle", async () => {
		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, tracker, codeHost, repo: runRepo } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		codeHost.setCloneUrl(REPO, "/nonexistent/repo.git");

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		const [run] = runRepo.getRuns({ limit: 1 });
		if (run?.status !== "failed") throw new Error("expected failed run");
		expect(run.error).toMatch(/git clone|does not appear to be a git/);
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 1, from: "pending", to: "running" },
		]);
		expect(tracker.markedFailed).toEqual([{ repo: REPO, number: 1 }]);
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
		// Real timers because dispatch awaits real fs I/O in createWorkspace; fake
		// timers don't drain the libuv thread pool. Polling interval is set very
		// long so the first-tick assertion observes only the startup sequence.
		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 60_000 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, tracker } = ctx;

		seedRun(db, {
			id: "stale-run",
			...baseRunRow,
			status: "running",
			issueKey: jiraIssueKey(99),
			issueTitle: "Stale issue",
			startedAt: "2025-01-01T00:00:00Z",
		});
		tracker.addIssue("pending", { number: 1, repo: REPO });

		orchestrator.start();
		await vi.waitFor(() => {
			const rows = db.select().from(runs).all();
			expect(rows).toHaveLength(2);
			const dispatched = rows.find((r) => r.id !== "stale-run");
			expect(dispatched?.workspaceDir).toEqual(expect.any(String));
			expect(dispatched?.branch).toEqual(expect.any(String));
		});

		// Recovery happened first: stale run failed and tracker fetched "running".
		// Then first tick dispatched the pending issue.
		expect(tracker.fetchCalls).toEqual(["running", "pending"]);
		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: "stale-run",
				...baseRunRow,
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
				...dispatchedRunRow(1),
				workspaceDir: expect.any(String),
				branch: `agent/issue-1`,
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
		const { orchestrator, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		tracker.failNextTransition();

		orchestrator.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);

		// First tick's pending→running transition is rejected; the loop keeps
		// polling so a subsequent tick retries.
		expect(
			tracker.fetchCalls.filter((s) => s === "pending").length,
		).toBeGreaterThanOrEqual(2);

		orchestrator.stop();
		vi.useRealTimers();
	});
});
