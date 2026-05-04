import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createScopedJiraIssue,
	hangingAgent,
	JIRA_API,
	jiraIssueKey,
	STATUSES,
} from "../../testing/support/fixtures.ts";
import { jiraHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator scheduling", () => {
	it("transitions pending → running on dispatch", async () => {
		server.use(
			...jiraHandlers({
				issues: [createScopedJiraIssue(1)],
			}),
		);

		await using ctx = await createTestOrchestrator({
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		await orchestrator.tick();

		const [run] = db.select().from(runs).all();
		expect(run).toMatchObject({ status: "running", issueKey: jiraIssueKey(1) });
	});

	it("respects max_concurrent limit", async () => {
		server.use(
			...jiraHandlers({
				issues: [
					createScopedJiraIssue(
						1,
						STATUSES.pending,
						"2025-01-01T00:00:00.000+0000",
					),
					createScopedJiraIssue(
						2,
						STATUSES.pending,
						"2025-01-02T00:00:00.000+0000",
					),
					createScopedJiraIssue(
						3,
						STATUSES.pending,
						"2025-01-03T00:00:00.000+0000",
					),
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
			await workspace.preCreateWorkspace(jiraIssueKey(num));
		}

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0]).toMatchObject({ issueKey: jiraIssueKey(1) });
	});

	it("dispatches oldest issues first", async () => {
		server.use(
			...jiraHandlers({
				issues: [
					createScopedJiraIssue(
						99,
						STATUSES.pending,
						"2025-01-03T00:00:00.000+0000",
					),
					createScopedJiraIssue(
						42,
						STATUSES.pending,
						"2025-01-01T00:00:00.000+0000",
					),
					createScopedJiraIssue(
						77,
						STATUSES.pending,
						"2025-01-02T00:00:00.000+0000",
					),
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
		const pending = [createScopedJiraIssue(1)];
		const running = [createScopedJiraIssue(1, STATUSES.running)];

		server.use(
			...jiraHandlers({
				resolveIssues: (status) => {
					if (status === "pending") return pending;
					if (status === "running") return running;
					return [];
				},
			}),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			runAgent: hangingAgent,
		});
		const { orchestrator, db, workspace } = ctx;
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		await orchestrator.tick();
		const before = db.select().from(runs).all();
		await orchestrator.tick();
		const after = db.select().from(runs).all();

		expect(after).toHaveLength(1);
		expect(after).toEqual(before);
	});

	it("rolls back tracker (running → pending) when lifecycle.dispatch throws (workspace clone fails)", async () => {
		server.use(
			...jiraHandlers({
				issues: [createScopedJiraIssue(1)],
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

		expect(db.select().from(runs).all()).toHaveLength(0);
	});

	it("start() polls on the configured interval and stop() halts it", async () => {
		vi.useFakeTimers();

		let tickCount = 0;
		server.use(
			...jiraHandlers({
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

	it("keeps polling when a tick throws on a transition failure", async () => {
		vi.useFakeTimers();

		let tickCount = 0;
		server.use(
			...jiraHandlers({
				resolveIssues: (status) => {
					tickCount++;
					if (status === "pending") return [createScopedJiraIssue(1)];
					return [];
				},
			}),
		);
		server.use(
			http.post(
				`${JIRA_API}/issue/:key/transitions`,
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
