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
import type { TrackerAdapter, TrackerState } from "../../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../../types/brands.ts";
import { ok } from "../../types/result.ts";

describe("Orchestrator dispatch", () => {
	it("calls tracker transitions with logical states", async () => {
		const transitions: { from: TrackerState; to: TrackerState }[] = [];
		const issue = {
			key: issueKey(`${REPO}#1`),
			number: issueNumber(1),
			title: "Issue 1",
			description: "Description for issue 1",
			labels: ["agent"],
			url: `https://github.com/${REPO}/issues/1`,
			createdAt: "2025-01-01T00:00:00Z",
		};

		const tracker: TrackerAdapter = {
			fetchIssue: async () => issue,
			fetchActiveIssues: async (_repo, state) =>
				state === "pending" ? [issue] : [],
			transitionState: async (_repo, _issueNumber, from, to) => {
				transitions.push({ from, to });
			},
			parseIssueKey: (key) => {
				const hashIndex = key.lastIndexOf("#");
				return ok({
					repo: repoSlug(key.slice(0, hashIndex)),
					number: issueNumber(Number.parseInt(key.slice(hashIndex + 1), 10)),
				});
			},
		};

		await using ctx = await createTestOrchestrator({
			runAgent: hangingAgent,
			tracker: () => tracker,
		});
		const { orchestrator, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();

		expect(transitions).toEqual([{ from: "pending", to: "running" }]);
	});

	it("dispatches agent for a pending issue, swaps label, and creates DB record", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

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
				phaseIndex: 0,
			},
		]);
	});

	it("creates PR and swaps to awaiting-review on successful completion", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(5, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#5`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const [run] = db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "completed",
			issueKey: `${REPO}#5`,
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
				phaseIndex: 0,
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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 2 },
		});
		const { orchestrator, db, runner, workspace } = ctx;
		for (const num of [42, 77, 99]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

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
				phaseIndex: 0,
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
				phaseIndex: 0,
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

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
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
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: null,
				durationMs: null,
				sessionId: null,
				attempt: 1,
				parentRunId: null,
				phaseIndex: 0,
			},
		]);

		// Second tick: same issue still has `agent` label — should not dispatch again
		await orchestrator.tick();

		const runsAfter = db.select().from(runs).all();
		expect(runsAfter).toEqual(runsBefore);
	});

	it("rolls back label (running → pending) when workspace creation fails", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		// DON'T pre-create workspace — let ensureWorkspace try git clone against
		// MSW's fake URL, which will fail because it's not a real git remote
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

		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 1000 },
		});
		const { orchestrator } = ctx;

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

		await using ctx = await createTestOrchestrator({
			configOverrides: { polling_interval_ms: 1000 },
		});
		const { orchestrator, db } = ctx;

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
