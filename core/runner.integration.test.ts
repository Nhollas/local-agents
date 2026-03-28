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
		expect(run?.status).toBe("running");
		expect(run?.agentName).toBe("test-job");
		expect(run?.issueKey).toBe("owner/repo#1");

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
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		}

		const run = getRun(db, runId);
		expect(run?.status).toBe("completed");
		expect(run?.completedAt).toBeTruthy();
		expect(run?.durationMs).toBeGreaterThanOrEqual(0);
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
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error).toBe("Something went wrong");
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		}

		const run = getRun(db, runId);
		expect(run?.status).toBe("failed");
		expect(run?.error).toBe("Something went wrong");
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
		expect(result.status).toBe("failed");
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
		const types = events.map((e) => e.type);

		expect(types).toEqual(["run:started", "run:completed"]);
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
		const types = events.map((e) => e.type);

		expect(types).toEqual(["run:started", "run:failed"]);
		expect(events[1].data).toEqual(expect.objectContaining({ error: "boom" }));
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

		const { runId, done } = runner.enqueue({
			name: "killable-job",
			issueKey: "owner/repo#7",
			issueTitle: "Killable issue",
			handler: () => new Promise(() => {}), // never resolves naturally
		});

		await Promise.resolve();
		expect(runner.kill(runId)).toBe(true);

		const result = await done;
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error).toContain("killed");
		}

		const run = getRun(db, runId);
		expect(run?.status).toBe("failed");
		expect(run?.error).toContain("killed");
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
		expect(run?.attempt).toBe(2);
		expect(run?.parentRunId).toBe("prev-id");
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
		expect(run?.sessionId).toBe("sess-123");
	});
});
