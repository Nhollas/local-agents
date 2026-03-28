import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../tests/support/test-db.ts";
import type { Db } from "./db.ts";
import { createRunner } from "./runner.ts";
import { runEvents, runs } from "./schema.ts";

function getRun(db: Db, runId: string) {
	return db.select().from(runs).where(eq(runs.id, runId)).get();
}

function getEvents(db: Db, runId: string) {
	return db.select().from(runEvents).where(eq(runEvents.runId, runId)).all();
}

describe("Runner integration", () => {
	let db: Db;

	beforeEach(() => {
		db = createTestDb();
	});

	it("records a running status when a job is enqueued", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let resolveHandler!: () => void;

		const runId = runner.enqueue({
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
		expect(run?.status).toBe("running");
		expect(run?.agentName).toBe("test-job");
		expect(run?.issueKey).toBe("owner/repo#1");

		resolveHandler();
		await runner.queue.waitForIdle();
	});

	it("marks run as completed with duration on success", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "fast-job",
			issueKey: "owner/repo#2",
			issueTitle: "Fast issue",
			handler: async () => {},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.status).toBe("completed");
		expect(run?.completedAt).toBeTruthy();
		expect(run?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("marks run as failed with error message on handler failure", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "failing-job",
			issueKey: "owner/repo#3",
			issueTitle: "Failing issue",
			handler: async () => {
				throw new Error("Something went wrong");
			},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.status).toBe("failed");
		expect(run?.error).toBe("Something went wrong");
		expect(run?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("persists lifecycle events in order", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "lifecycle-job",
			issueKey: "owner/repo#4",
			issueTitle: "Lifecycle issue",
			handler: async () => {},
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["run:started", "run:completed"]);
	});

	it("persists failure events", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "fail-event-job",
			issueKey: "owner/repo#5",
			issueTitle: "Fail event issue",
			handler: async () => {
				throw new Error("boom");
			},
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		const types = events.map((e) => e.type);

		expect(types).toEqual(["run:started", "run:failed"]);
		expect(events[1].data).toEqual(expect.objectContaining({ error: "boom" }));
	});

	it("records tool_use events when emitToolUse is called", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
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
		const toolEvents = events.filter((e) => e.type === "run:tool_use");

		expect(toolEvents).toHaveLength(2);
		expect(toolEvents[0].data).toEqual({
			tool: "Read",
			target: "/src/index.ts",
		});
		expect(toolEvents[1].data).toEqual({
			tool: "Edit",
			target: "/src/index.ts",
		});
	});

	it("aborts a running job when killed", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "killable-job",
			issueKey: "owner/repo#7",
			issueTitle: "Killable issue",
			handler: () => new Promise(() => {}), // never resolves naturally
		});

		await Promise.resolve();
		expect(runner.kill(runId)).toBe(true);

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.status).toBe("failed");
		expect(run?.error).toContain("killed");
	});

	it("invokes onComplete callback after successful run", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onCompleteCalled = false;

		runner.enqueue({
			name: "complete-callback-job",
			issueKey: "owner/repo#8",
			issueTitle: "Callback issue",
			handler: async () => {},
			onComplete: async () => {
				onCompleteCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onCompleteCalled).toBe(true);
	});

	it("invokes onFinally callback after failure", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onFinallyCalled = false;

		runner.enqueue({
			name: "finally-callback-job",
			issueKey: "owner/repo#9",
			issueTitle: "Finally issue",
			handler: async () => {
				throw new Error("fail");
			},
			onFinally: async () => {
				onFinallyCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onFinallyCalled).toBe(true);
	});

	it("does not invoke onComplete after failure", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onCompleteCalled = false;

		runner.enqueue({
			name: "no-complete-on-fail",
			issueKey: "owner/repo#10",
			issueTitle: "No complete on fail",
			handler: async () => {
				throw new Error("fail");
			},
			onComplete: async () => {
				onCompleteCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onCompleteCalled).toBe(false);
	});

	it("onComplete failure doesn't corrupt run status", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "oncomplete-throws",
			issueKey: "owner/repo#11",
			issueTitle: "onComplete throws",
			handler: async () => {},
			onComplete: async () => {
				throw new Error("onComplete exploded");
			},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.status).toBe("completed");
		expect(run?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("onFinally failure doesn't corrupt run status", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "onfinally-throws",
			issueKey: "owner/repo#12",
			issueTitle: "onFinally throws",
			handler: async () => {},
			onFinally: async () => {
				throw new Error("onFinally exploded");
			},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.status).toBe("completed");
		expect(run?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("kill returns false for unknown runId", () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		expect(runner.kill("nonexistent-id")).toBe(false);
	});

	it("stores attempt and parentRunId on the run record", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "retry-job",
			issueKey: "owner/repo#1",
			issueTitle: "Retry issue",
			handler: async () => {},
			attempt: 2,
			parentRunId: "prev-id",
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.attempt).toBe(2);
		expect(run?.parentRunId).toBe("prev-id");
	});

	it("captures sessionId via setSessionId callback", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });

		const runId = runner.enqueue({
			name: "session-job",
			issueKey: "owner/repo#2",
			issueTitle: "Session issue",
			handler: async (_emitToolUse, setSessionId) => {
				setSessionId("sess-123");
			},
		});

		await runner.queue.waitForIdle();

		const run = getRun(db, runId);
		expect(run?.sessionId).toBe("sess-123");
	});

	it("calls onFailed (not onFinally) when handler fails and retries remain", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onFailedCalled = false;
		let onFinallyCalled = false;

		runner.enqueue({
			name: "fail-retry-job",
			issueKey: "owner/repo#3",
			issueTitle: "Fail retry issue",
			handler: async () => {
				throw new Error("boom");
			},
			maxRetries: 3,
			attempt: 1,
			onFailed: async () => {
				onFailedCalled = true;
			},
			onFinally: async () => {
				onFinallyCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onFailedCalled).toBe(true);
		expect(onFinallyCalled).toBe(false);
	});

	it("calls onFinally (not onFailed) when handler fails and retries exhausted", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onFailedCalled = false;
		let onFinallyCalled = false;

		runner.enqueue({
			name: "fail-exhausted-job",
			issueKey: "owner/repo#4",
			issueTitle: "Fail exhausted issue",
			handler: async () => {
				throw new Error("boom");
			},
			maxRetries: 1,
			attempt: 2,
			onFailed: async () => {
				onFailedCalled = true;
			},
			onFinally: async () => {
				onFinallyCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onFailedCalled).toBe(false);
		expect(onFinallyCalled).toBe(true);
	});

	it("calls onFinally on success regardless of maxRetries", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onFailedCalled = false;
		let onFinallyCalled = false;

		runner.enqueue({
			name: "success-retry-job",
			issueKey: "owner/repo#5",
			issueTitle: "Success retry issue",
			handler: async () => {},
			maxRetries: 3,
			attempt: 1,
			onFailed: async () => {
				onFailedCalled = true;
			},
			onFinally: async () => {
				onFinallyCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onFailedCalled).toBe(false);
		expect(onFinallyCalled).toBe(true);
	});

	it("existing onFinally-on-failure behavior preserved when no retry fields set", async () => {
		const runner = createRunner({ db, maxConcurrency: 1 });
		let onFinallyCalled = false;

		runner.enqueue({
			name: "compat-job",
			issueKey: "owner/repo#6",
			issueTitle: "Compat issue",
			handler: async () => {
				throw new Error("boom");
			},
			onFinally: async () => {
				onFinallyCalled = true;
			},
		});

		await runner.queue.waitForIdle();

		expect(onFinallyCalled).toBe(true);
	});
});
