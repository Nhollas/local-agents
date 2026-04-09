import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/db.ts";
import {
	createTestDb,
	getEvents,
	getRun,
} from "../../testing/support/test-db.ts";
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

	beforeEach(() => {
		db = createTestDb();
	});

	it("records a running status when a job is enqueued", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let resolveHandler!: (result: RunResult) => void;

		const { runId } = runner.enqueue({
			name: "test-job",
			issueKey: "owner/repo#1",
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
			issueKey: "owner/repo#1",
			issueTitle: "Test issue",
			startedAt: expect.any(String),
			completedAt: null,
			durationMs: null,
			sessionId: null,
			attempt: 1,
			parentRunId: null,
		});

		resolveHandler({ status: "completed", durationMs: 0 });
		await runner.queue.waitForIdle();
	});

	it("marks run as completed with duration on success", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "fast-job",
			issueKey: "owner/repo#2",
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
			issueKey: "owner/repo#2",
			issueTitle: "Fast issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 1,
			parentRunId: null,
		});
	});

	it("marks run as failed with error message on handler failure", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "failing-job",
			issueKey: "owner/repo#3",
			issueTitle: "Failing issue",
			handler: failedHandler("Something went wrong"),
		});

		const result = await done;
		expect(result).toEqual({
			status: "failed",
			error: "Something went wrong",
			durationMs: expect.any(Number),
		});

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "failing-job",
			status: "failed",
			error: "Something went wrong",
			issueKey: "owner/repo#3",
			issueTitle: "Failing issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 1,
			parentRunId: null,
		});
	});

	it("done promise never rejects", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { done } = runner.enqueue({
			name: "crash-job",
			issueKey: "owner/repo#99",
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
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "lifecycle-job",
			issueKey: "owner/repo#4",
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
				data: { issueKey: "owner/repo#4", issueTitle: "Lifecycle issue" },
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
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "fail-event-job",
			issueKey: "owner/repo#5",
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
				data: { issueKey: "owner/repo#5", issueTitle: "Fail event issue" },
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
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "tool-job",
			issueKey: "owner/repo#6",
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
				data: { issueKey: "owner/repo#6", issueTitle: "Tool issue" },
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
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "killable-job",
			issueKey: "owner/repo#7",
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
			issueKey: "owner/repo#7",
			issueTitle: "Killable issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 1,
			parentRunId: null,
		});
	});

	it("kill returns false for unknown runId", () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		expect(runner.kill("nonexistent-id")).toBe(false);
	});

	it("stores attempt and parentRunId on the run record", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "retry-job",
			issueKey: "owner/repo#1",
			issueTitle: "Retry issue",
			handler: completedHandler,
			attempt: 2,
			parentRunId: "prev-id",
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "retry-job",
			status: "completed",
			error: null,
			issueKey: "owner/repo#1",
			issueTitle: "Retry issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 2,
			parentRunId: "prev-id",
		});
	});

	it("only persists the first sessionId when handler calls setSessionId multiple times", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "multi-session-job",
			issueKey: "owner/repo#8",
			issueTitle: "Multi session issue",
			handler: async (ctx) => {
				ctx.setSessionId("first-session");
				ctx.setSessionId("second-session");
				ctx.setSessionId("third-session");
				return { status: "completed", durationMs: 0 };
			},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "multi-session-job",
			status: "completed",
			error: null,
			issueKey: "owner/repo#8",
			issueTitle: "Multi session issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: "first-session",
			attempt: 1,
			parentRunId: null,
		});
	});

	it("uses default maxConcurrency when not specified", async () => {
		const runner = createRunner({ db });

		const { runId, done } = runner.enqueue({
			name: "default-concurrency-job",
			issueKey: "owner/repo#10",
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

	it("captures sessionId via setSessionId callback", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "session-job",
			issueKey: "owner/repo#2",
			issueTitle: "Session issue",
			handler: async (ctx) => {
				ctx.setSessionId("sess-123");
				return { status: "completed", durationMs: 0 };
			},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "session-job",
			status: "completed",
			error: null,
			issueKey: "owner/repo#2",
			issueTitle: "Session issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: "sess-123",
			attempt: 1,
			parentRunId: null,
		});
	});
});
