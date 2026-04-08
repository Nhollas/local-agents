import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { createTestDb, getEvents, getRun } from "../tests/support/test-db.ts";
import { createRunner } from "./runner.ts";

describe("Runner integration", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
	});

	it("records a running status when a job is enqueued", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let resolveHandler!: () => void;

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

		resolveHandler();
		await runner.queue.waitForIdle();
	});

	it("marks run as completed with duration on success", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "fast-job",
			issueKey: "owner/repo#2",
			issueTitle: "Fast issue",
			handler: async () => {},
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
			handler: async () => {
				throw new Error("Something went wrong");
			},
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
			handler: async () => {
				throw new Error("catastrophic failure");
			},
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
			handler: async () => {},
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
			handler: async () => {
				throw new Error("boom");
			},
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
			handler: async (emitToolUse) => {
				emitToolUse("Read", "/src/index.ts");
				emitToolUse("Edit", "/src/index.ts");
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
			error: "Run killed by user",
			durationMs: expect.any(Number),
		});

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "killable-job",
			status: "failed",
			error: "Run killed by user",
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
			handler: async () => {},
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
			handler: async (_emitToolUse, setSessionId) => {
				setSessionId("first-session");
				setSessionId("second-session");
				setSessionId("third-session");
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
			handler: async () => {},
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

	it("captures non-Error throwables as string", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			name: "string-throw-job",
			issueKey: "owner/repo#11",
			issueTitle: "String throw",
			handler: async () => {
				throw "raw string error";
			},
		});

		const result = await done;
		expect(result).toEqual({
			status: "failed",
			error: "raw string error",
			durationMs: expect.any(Number),
		});

		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			agentName: "string-throw-job",
			status: "failed",
			error: "raw string error",
			issueKey: "owner/repo#11",
			issueTitle: "String throw",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: null,
			attempt: 1,
			parentRunId: null,
		});
	});

	it("captures sessionId via setSessionId callback", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			name: "session-job",
			issueKey: "owner/repo#2",
			issueTitle: "Session issue",
			handler: async (_emitToolUse, setSessionId) => {
				setSessionId("sess-123");
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
