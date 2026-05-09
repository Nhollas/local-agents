import { beforeEach, describe, expect, it } from "vitest";
import {
	createTestDb,
	getEvents,
	getRun,
} from "../../__test-support__/support/test-db.ts";
import type { Db } from "../../db/db.ts";
import {
	createRunRepository,
	type RunRepository,
} from "../../run-repository.ts";
import {
	issueKey as ik,
	runId as rid,
	repoSlug as rs,
} from "../../types/brands.ts";
import { ABORT_ERROR, createRunner, type RunResult } from "../runner.ts";

/** Helper: a handler that completes immediately. */
const completedHandler = async (): Promise<RunResult> => ({
	status: "completed",
	durationMs: 0,
});

/** Helper: a handler that fails with the given message. */
const failedHandler = (error: string) => async (): Promise<RunResult> => ({
	status: "failed",
	error,
	durationMs: 0,
});

describe("Runner integration", () => {
	let db: Db;
	let repo: RunRepository;

	beforeEach(() => {
		db = createTestDb();
		repo = createRunRepository(db);
	});

	it("records a running status when a job is enqueued", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });
		let resolveHandler!: (result: RunResult) => void;

		const { runId } = runner.enqueue({
			name: "test-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#1"),
			issueTitle: "Test issue",
			handler: () =>
				new Promise((r) => {
					resolveHandler = r;
				}),
		});

		// DB insert is synchronous — status is already "running"
		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "test-job",
			status: "running",
			error: null,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#1"),
			issueTitle: "Test issue",
			startedAt: expect.any(String),
			completedAt: null,
			durationMs: null,
		});

		resolveHandler({ status: "completed", durationMs: 0 });
		await runner.queue.waitForIdle();
	});

	it("records a running status even when the queue is at capacity", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });
		let resolveBlocker!: (result: RunResult) => void;

		// Fill the single slot with a blocking job
		runner.enqueue({
			name: "blocker",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#1"),
			issueTitle: "Blocker",
			handler: () =>
				new Promise((r) => {
					resolveBlocker = r;
				}),
		});

		// Second job sits in the pending queue — not yet executing
		const { runId } = runner.enqueue({
			name: "queued-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Queued issue",
			handler: async () => ({ status: "completed" as const, durationMs: 0 }),
		});

		expect(runner.queue.pendingCount).toBe(1);

		// DB record must exist even though the job hasn't started executing
		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "queued-job",
			status: "running",
			error: null,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Queued issue",
			startedAt: expect.any(String),
			completedAt: null,
			durationMs: null,
		});

		resolveBlocker({ status: "completed", durationMs: 0 });
		await runner.queue.waitForIdle();
	});

	it("marks run as completed with duration on success", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "fast-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Fast issue",
			handler: completedHandler,
		});

		const result = await done;
		expect(result).toEqual({
			status: "completed",
			durationMs: expect.any(Number),
		});

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "fast-job",
			status: "completed",
			error: null,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Fast issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
		});
	});

	it("done promise never rejects", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { done } = runner.enqueue({
			name: "crash-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#99"),
			issueTitle: "Crash issue",
			handler: failedHandler("catastrophic failure"),
		});

		// Should resolve (not reject) with a failed result
		const result = await done;
		expect(result).toEqual({
			status: "failed",
			error: "catastrophic failure",
			durationMs: expect.any(Number),
		});
	});

	it("persists lifecycle events in order", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "lifecycle-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#4"),
			issueTitle: "Lifecycle issue",
			handler: completedHandler,
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		expect(events).toEqual([
			{
				id: expect.any(String),
				runId,
				type: "run:started",
				data: { issueKey: ik("acme/widgets#4"), issueTitle: "Lifecycle issue" },
				createdAt: expect.any(String),
			},
			{
				id: expect.any(String),
				runId,
				type: "run:completed",
				data: { durationMs: expect.any(Number) },
				createdAt: expect.any(String),
			},
		]);
	});

	it("persists failure events", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "fail-event-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#5"),
			issueTitle: "Fail event issue",
			handler: failedHandler("boom"),
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		expect(events).toEqual([
			{
				id: expect.any(String),
				runId,
				type: "run:started",
				data: {
					issueKey: ik("acme/widgets#5"),
					issueTitle: "Fail event issue",
				},
				createdAt: expect.any(String),
			},
			{
				id: expect.any(String),
				runId,
				type: "run:failed",
				data: { error: "boom", durationMs: expect.any(Number) },
				createdAt: expect.any(String),
			},
		]);
	});

	it("records tool_use events when emitToolUse is called", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "tool-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#6"),
			issueTitle: "Tool issue",
			handler: async (ctx) => {
				ctx.emitToolUse("Read", "/src/index.ts");
				ctx.emitToolUse("Edit", "/src/index.ts");
				return { status: "completed", durationMs: 0 };
			},
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		expect(events).toEqual([
			{
				id: expect.any(String),
				runId,
				type: "run:started",
				data: { issueKey: ik("acme/widgets#6"), issueTitle: "Tool issue" },
				createdAt: expect.any(String),
			},
			{
				id: expect.any(String),
				runId,
				type: "run:tool_use",
				data: { tool: "Read", target: "/src/index.ts" },
				createdAt: expect.any(String),
			},
			{
				id: expect.any(String),
				runId,
				type: "run:tool_use",
				data: { tool: "Edit", target: "/src/index.ts" },
				createdAt: expect.any(String),
			},
			{
				id: expect.any(String),
				runId,
				type: "run:completed",
				data: { durationMs: expect.any(Number) },
				createdAt: expect.any(String),
			},
		]);
	});

	it("aborts a running job when killed", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "killable-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#7"),
			issueTitle: "Killable issue",
			handler: () => new Promise(() => {}), // never resolves naturally
		});

		await Promise.resolve();
		expect(runner.kill(runId)).toBe(true);

		const result = await done;
		expect(result).toEqual({
			status: "failed",
			error: ABORT_ERROR,
			durationMs: expect.any(Number),
		});

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "killable-job",
			status: "failed",
			error: ABORT_ERROR,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#7"),
			issueTitle: "Killable issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
		});
	});

	it("kill returns false for unknown runId", () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		expect(runner.kill(rid("nonexistent-id"))).toBe(false);
	});

	it("uses default maxConcurrency when not specified", async () => {
		const runner = createRunner({ repo });

		const { runId, done } = runner.enqueue({
			name: "default-concurrency-job",
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#10"),
			issueTitle: "Default concurrency",
			handler: completedHandler,
		});

		const result = await done;
		expect(result).toEqual({
			status: "completed",
			durationMs: expect.any(Number),
		});

		const run = getRun(db, runId);
		expect(run).toBeDefined();
		expect(run?.status).toBe("completed");
	});
});
