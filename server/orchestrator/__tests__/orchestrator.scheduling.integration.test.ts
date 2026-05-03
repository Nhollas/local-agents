import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	GITHUB_API,
	hangingAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { runId as rid } from "../../types/brands.ts";

describe("Orchestrator scheduling", () => {
	it("transitions pending → running on dispatch", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();

		const [run] = db.select().from(runs).all();
		expect(run).toMatchObject({ status: "running", issueKey: `${REPO}#1` });
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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 1 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		for (const num of [1, 2, 3]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0]).toMatchObject({ issueKey: `${REPO}#1` });
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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 2 },
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		for (const num of [42, 77, 99]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns.map((r) => r.issueKey)).toEqual([
			`${REPO}#42`,
			`${REPO}#77`,
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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		const before = db.select().from(runs).all();
		await orchestrator.tick();
		const after = db.select().from(runs).all();

		expect(after).toHaveLength(1);
		expect(after).toEqual(before);
	});

	it("rolls back tracker (running → pending) when lifecycle.dispatch throws (workspace clone fails)", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			codeHost: (defaults) => ({
				...defaults,
				cloneUrl: () => "/nonexistent/repo.git",
			}),
		});
		const { orchestrator, db, runner } = ctx;

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		// No run was enqueued and label was rolled back via the orchestrator's catch.
		expect(db.select().from(runs).all()).toHaveLength(0);
	});

	it("start() polls on the configured interval and stop() halts it", async () => {
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

		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 1000 },
		});
		const { orchestrator } = ctx;

		orchestrator.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(tickCount).toBe(2); // pending + running fetch

		await vi.advanceTimersByTimeAsync(1000);
		expect(tickCount).toBe(4);

		orchestrator.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(tickCount).toBe(4);

		vi.useRealTimers();
	});

	it("keeps polling when a tick throws on a label swap failure", async () => {
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
		server.use(
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 500 }),
			),
		);

		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 1000 },
		});
		const { orchestrator, db } = ctx;

		orchestrator.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);

		expect(tickCount).toBeGreaterThanOrEqual(4);
		expect(db.select().from(runs).all()).toHaveLength(0);

		orchestrator.stop();
		vi.useRealTimers();
	});
});

describe("Orchestrator retryRun eligibility", () => {
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

	it("rejects when run does not exist", async () => {
		server.use(...githubHandlers());
		await using ctx = await createTestOrchestrator();
		const result = await ctx.orchestrator.retryRun(rid("nonexistent"));
		expect(result).toEqual({ error: "Run not found" });
	});

	it("rejects when run is not failed", async () => {
		server.use(...githubHandlers());
		await using ctx = await createTestOrchestrator();
		seedRun(ctx.db, {
			...failedRunDefaults,
			id: "ok",
			status: "completed",
			error: undefined,
		});
		const result = await ctx.orchestrator.retryRun(rid("ok"));
		expect(result).toEqual({ error: "Run is not failed" });
	});

	it("rejects when run has no issue key", async () => {
		server.use(...githubHandlers());
		await using ctx = await createTestOrchestrator();
		seedRun(ctx.db, { ...failedRunDefaults, id: "no-key", issueKey: null });
		const result = await ctx.orchestrator.retryRun(rid("no-key"));
		expect(result).toEqual({ error: "No issue key" });
	});

	it("rejects when max retries exceeded", async () => {
		server.use(...githubHandlers());
		await using ctx = await createTestOrchestrator({
			configOverrides: { max_retries: 3 },
		});
		seedRun(ctx.db, { ...failedRunDefaults, id: "maxed", attempt: 4 });
		const result = await ctx.orchestrator.retryRun(rid("maxed"));
		expect(result).toEqual({ error: "Max retries exceeded" });
	});

	it("rejects when issue already has a running agent", async () => {
		server.use(...githubHandlers());
		await using ctx = await createTestOrchestrator();
		seedRun(ctx.db, { ...failedRunDefaults, id: "failed-dup" });
		seedRun(ctx.db, {
			id: "running-1",
			agentName: "issue-1",
			status: "running",
			issueKey: `${REPO}#1`,
		});
		const result = await ctx.orchestrator.retryRun(rid("failed-dup"));
		expect(result).toEqual({ error: "Issue already has a running agent" });
	});

	it("dispatches a retry when eligible", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);
		await using ctx = await createTestOrchestrator();
		await ctx.workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(ctx.db, { ...failedRunDefaults, id: "ok" });

		const result = await ctx.orchestrator.retryRun(rid("ok"));
		expect(result).toEqual({ runId: expect.any(String) });

		await ctx.runner.queue.waitForIdle();
		await ctx.orchestrator.settled();

		const retryRow = ctx.db
			.select()
			.from(runs)
			.all()
			.find((r) => r.id !== "ok");
		expect(retryRow).toMatchObject({
			status: "completed",
			attempt: 2,
			parentRunId: "ok",
		});
	});
});
