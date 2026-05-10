import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/db.ts";
import { createRunRepository, type RunRepository } from "../run-repository.ts";
import { createTestDb, getEvents, getRun } from "../test-support/test-db.ts";
import {
	issueKey as ik,
	runId as rid,
	repoSlug as rs,
} from "../types/brands.ts";
import { ABORT_ERROR, createRunner, type RunResult } from "./runner.ts";

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

const baseRunRow = {
	branch: null,
	workspaceDir: null,
	issueUrl: null,
	repoUrl: "https://code-host.example.test/acme/widgets",
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
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#1"),
			issueTitle: "Test issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: () =>
				new Promise((r) => {
					resolveHandler = r;
				}),
		});

		// DB insert is synchronous — status is already "running"
		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			status: "running",
			error: null,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#1"),
			issueTitle: "Test issue",
			startedAt: expect.any(String),
			completedAt: null,
			durationMs: null,
			...baseRunRow,
		});

		resolveHandler({ status: "completed", durationMs: 0 });
		await runner.queue.waitForIdle();
	});

	it("records a running status even when the queue is at capacity", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });
		let resolveBlocker!: (result: RunResult) => void;

		// Fill the single slot with a blocking job
		runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#1"),
			issueTitle: "Blocker",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: () =>
				new Promise((r) => {
					resolveBlocker = r;
				}),
		});

		// Second job sits in the pending queue — not yet executing
		const { runId } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Queued issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: async () => ({ status: "completed" as const, durationMs: 0 }),
		});

		expect(runner.queue.pendingCount).toBe(1);

		// DB record must exist even though the job hasn't started executing
		const run = getRun(db, runId);
		expect(run).toEqual({
			id: runId,
			status: "running",
			error: null,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Queued issue",
			startedAt: expect.any(String),
			completedAt: null,
			durationMs: null,
			...baseRunRow,
		});

		resolveBlocker({ status: "completed", durationMs: 0 });
		await runner.queue.waitForIdle();
	});

	it("marks run as completed with duration on success", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Fast issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
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
			status: "completed",
			error: null,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#2"),
			issueTitle: "Fast issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			...baseRunRow,
		});
	});

	it("done promise never rejects", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { done } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#99"),
			issueTitle: "Crash issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
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
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#4"),
			issueTitle: "Lifecycle issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: completedHandler,
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		expect(events).toEqual([
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "run:started",
				stepName: null,
				data: { issueKey: ik("acme/widgets#4"), issueTitle: "Lifecycle issue" },
				createdAt: expect.any(String),
			},
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "run:completed",
				stepName: null,
				data: {
					durationMs: expect.any(Number),
					costUsd: 0,
					tokens: { in: 0, out: 0 },
				},
				createdAt: expect.any(String),
			},
		]);
	});

	it("persists failure events", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#5"),
			issueTitle: "Fail event issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: failedHandler("boom"),
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		expect(events).toEqual([
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "run:started",
				stepName: null,
				data: {
					issueKey: ik("acme/widgets#5"),
					issueTitle: "Fail event issue",
				},
				createdAt: expect.any(String),
			},
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "run:failed",
				stepName: null,
				data: { error: "boom", durationMs: expect.any(Number) },
				createdAt: expect.any(String),
			},
		]);
	});

	it("records typed tool events when ctx.emit is called", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#6"),
			issueTitle: "Tool issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: async (ctx) => {
				ctx.emit({
					kind: "tool:read",
					stepName: "implement",
					data: { path: "src/index.ts", lines: 0 },
				});
				ctx.emit({
					kind: "tool:edit",
					stepName: "implement",
					data: {
						path: "src/index.ts",
						added: 0,
						removed: 0,
						summary: "",
					},
				});
				return { status: "completed", durationMs: 0 };
			},
		});

		await runner.queue.waitForIdle();

		const events = getEvents(db, runId);
		expect(events).toEqual([
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "run:started",
				stepName: null,
				data: { issueKey: ik("acme/widgets#6"), issueTitle: "Tool issue" },
				createdAt: expect.any(String),
			},
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "tool:read",
				stepName: "implement",
				data: { path: "src/index.ts", lines: 0 },
				createdAt: expect.any(String),
			},
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "tool:edit",
				stepName: "implement",
				data: { path: "src/index.ts", added: 0, removed: 0, summary: "" },
				createdAt: expect.any(String),
			},
			{
				seq: expect.any(Number),
				id: expect.any(String),
				runId,
				kind: "run:completed",
				stepName: null,
				data: {
					durationMs: expect.any(Number),
					costUsd: 0,
					tokens: { in: 0, out: 0 },
				},
				createdAt: expect.any(String),
			},
		]);
	});

	it("flips in-flight tool:bash events to aborted on kill", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#8"),
			issueTitle: "Killed mid-bash",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: async (ctx) => {
				ctx.emit({
					kind: "tool:bash",
					stepName: "implement",
					data: {
						command: "sleep 60",
						cwd: "/work",
						state: "running",
						exitCode: null,
					},
				});
				return new Promise<RunResult>(() => {});
			},
		});

		await Promise.resolve();
		// Give the handler a tick to emit the tool:bash event.
		await new Promise((r) => setTimeout(r, 5));
		runner.kill(runId);
		await done;

		const events = getEvents(db, runId).filter((e) => e.kind === "tool:bash");
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toEqual({
			command: "sleep 60",
			cwd: "/work",
			state: "aborted",
			exitCode: null,
		});
	});

	it("flips in-flight tool:bash events to exited on normal completion", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#9"),
			issueTitle: "Bash exits normally",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
			handler: async (ctx) => {
				ctx.emit({
					kind: "tool:bash",
					stepName: "implement",
					data: {
						command: "ls",
						cwd: "/work",
						state: "running",
						exitCode: null,
					},
				});
				return { status: "completed", durationMs: 0 };
			},
		});

		await done;

		const events = getEvents(db, runId).filter((e) => e.kind === "tool:bash");
		expect(events).toHaveLength(1);
		expect((events[0]?.data as { state: string }).state).toBe("exited");
	});

	it("aborts a running job when killed", async () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		const { runId, done } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#7"),
			issueTitle: "Killable issue",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
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
			status: "failed",
			error: ABORT_ERROR,
			repo: "acme/widgets",
			issueKey: ik("acme/widgets#7"),
			issueTitle: "Killable issue",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			...baseRunRow,
		});
	});

	it("kill returns false for unknown runId", () => {
		const runner = createRunner({ repo, maxConcurrency: 1 });

		expect(runner.kill(rid("nonexistent-id"))).toBe(false);
	});

	it("uses default maxConcurrency when not specified", async () => {
		const runner = createRunner({ repo });

		const { runId, done } = runner.enqueue({
			repo: rs("acme/widgets"),
			issueKey: ik("acme/widgets#10"),
			issueTitle: "Default concurrency",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/acme/widgets",
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
