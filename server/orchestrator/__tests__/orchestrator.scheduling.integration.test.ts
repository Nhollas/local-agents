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
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

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
			http.post(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
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
