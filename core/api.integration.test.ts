import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../tests/support/test-db.ts";
import { createApi, type RetryFn } from "./api.ts";
import type { Db } from "./db.ts";
import type { Runner } from "./runner.ts";
import { createRunner } from "./runner.ts";
import { runEvents, runs } from "./schema.ts";

function seedRun(
	db: Db,
	overrides: Partial<typeof runs.$inferInsert> & { id: string },
) {
	db.insert(runs)
		.values({
			agentName: "test-agent",
			status: "completed",
			startedAt: new Date().toISOString(),
			...overrides,
		})
		.run();
}

function seedEvent(
	db: Db,
	overrides: Partial<typeof runEvents.$inferInsert> & {
		id: string;
		runId: string;
	},
) {
	db.insert(runEvents)
		.values({
			type: "run:started",
			data: {},
			createdAt: new Date().toISOString(),
			...overrides,
		})
		.run();
}

const noopRetry: RetryFn = async () => ({ error: "not implemented" });

describe("API integration", () => {
	let db: Db;
	let app: Hono;
	let runner: Runner;

	beforeEach(() => {
		db = createTestDb();
		runner = createRunner({ db, maxConcurrency: 2 });
		app = createApi({ runner, db, retryRun: noopRetry });
	});

	describe("GET /health", () => {
		it("returns OK", async () => {
			const res = await app.request("/health");

			expect(res.status).toBe(200);
			expect(await res.text()).toBe("OK");
		});
	});

	describe("GET /runs", () => {
		it("returns empty array when no runs exist", async () => {
			const res = await app.request("/runs");

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual([]);
		});

		it("returns runs ordered by startedAt descending", async () => {
			seedRun(db, { id: "oldest", startedAt: "2025-01-01T00:00:00Z" });
			seedRun(db, { id: "newest", startedAt: "2025-01-03T00:00:00Z" });
			seedRun(db, { id: "middle", startedAt: "2025-01-02T00:00:00Z" });

			const res = await app.request("/runs");
			const body = await res.json();

			expect(body.map((r: { id: string }) => r.id)).toEqual([
				"newest",
				"middle",
				"oldest",
			]);
		});

		it("filters by agent name", async () => {
			seedRun(db, { id: "a", agentName: "agent-alpha" });
			seedRun(db, { id: "b", agentName: "agent-beta" });

			const res = await app.request("/runs?agent=agent-alpha");
			const body = await res.json();

			expect(body).toHaveLength(1);
			expect(body[0].id).toBe("a");
		});

		it("filters by status", async () => {
			seedRun(db, { id: "running-1", status: "running" });
			seedRun(db, { id: "done-1", status: "completed" });
			seedRun(db, { id: "fail-1", status: "failed" });

			const res = await app.request("/runs?status=running");
			const body = await res.json();

			expect(body).toHaveLength(1);
			expect(body[0].id).toBe("running-1");
		});

		it("respects limit parameter", async () => {
			seedRun(db, { id: "r1", startedAt: "2025-01-01T00:00:00Z" });
			seedRun(db, { id: "r2", startedAt: "2025-01-02T00:00:00Z" });
			seedRun(db, { id: "r3", startedAt: "2025-01-03T00:00:00Z" });

			const res = await app.request("/runs?limit=1");
			const body = await res.json();

			expect(body).toHaveLength(1);
			expect(body[0].id).toBe("r3");
		});
	});

	describe("GET /runs/:id", () => {
		it("returns run with its events", async () => {
			seedRun(db, { id: "run-1", agentName: "my-agent", status: "completed" });
			seedEvent(db, {
				id: "evt-1",
				runId: "run-1",
				type: "run:started",
				createdAt: "2025-01-01T00:00:00Z",
				data: { issueKey: "test/repo#1" },
			});
			seedEvent(db, {
				id: "evt-2",
				runId: "run-1",
				type: "run:completed",
				createdAt: "2025-01-01T00:01:00Z",
				data: { durationMs: 5000 },
			});

			const res = await app.request("/runs/run-1");
			const body = await res.json();

			expect(res.status).toBe(200);
			expect(body.id).toBe("run-1");
			expect(body.agentName).toBe("my-agent");
			expect(body.events).toHaveLength(2);
			expect(body.events[0].type).toBe("run:started");
			expect(body.events[1].type).toBe("run:completed");
		});

		it("returns 404 for unknown run", async () => {
			const res = await app.request("/runs/nonexistent");

			expect(res.status).toBe(404);
		});
	});

	describe("GET /events", () => {
		it("SSE stream delivers run events", async () => {
			const res = await app.request("/events");
			const body = res.body;
			if (!body)
				throw new Error("Expected response body to be a ReadableStream");
			const reader = body.getReader();
			const decoder = new TextDecoder();

			// Read the initial heartbeat to confirm the stream is active
			await reader.read();

			runner.enqueue({
				name: "sse-agent",
				issueKey: "test/repo#42",
				issueTitle: "SSE test issue",
				handler: async () => {},
			});

			await runner.queue.waitForIdle();

			let collected = "";
			for (let i = 0; i < 20; i++) {
				const { value, done } = await reader.read();
				if (done) break;
				collected += decoder.decode(value, { stream: true });
				if (
					collected.includes("run:started") &&
					collected.includes("run:completed")
				)
					break;
			}

			reader.cancel();

			expect(collected).toContain("event: run:started");
			expect(collected).toContain("event: run:completed");
			expect(collected).toContain("sse-agent");
			expect(collected).toContain("test/repo#42");
		});
	});

	describe("POST /runs/:id/kill", () => {
		it("kills a running job and returns success", async () => {
			const runId = runner.enqueue({
				name: "long-job",
				issueKey: "test/repo#1",
				issueTitle: "Long running job",
				handler: () => new Promise(() => {}), // never resolves
			});

			const res = await app.request(`/runs/${runId}/kill`, {
				method: "POST",
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ killed: true });
		});

		it("returns 404 for unknown run", async () => {
			const res = await app.request("/runs/nonexistent/kill", {
				method: "POST",
			});

			expect(res.status).toBe(404);
		});
	});

	describe("POST /runs/:id/retry", () => {
		it("returns 201 with new runId on successful retry", async () => {
			const retryFn: RetryFn = async () => ({ runId: "new-run-1" });
			const retryApp = createApi({ runner, db, retryRun: retryFn });

			seedRun(db, { id: "failed-1", status: "failed" });

			const res = await retryApp.request("/runs/failed-1/retry", {
				method: "POST",
			});

			expect(res.status).toBe(201);
			expect(await res.json()).toEqual({ runId: "new-run-1" });
		});

		it("returns 400 when retryRun returns an error", async () => {
			const retryFn: RetryFn = async () => ({
				error: "Run is not failed",
			});
			const retryApp = createApi({ runner, db, retryRun: retryFn });

			seedRun(db, { id: "completed-1", status: "completed" });

			const res = await retryApp.request("/runs/completed-1/retry", {
				method: "POST",
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Run is not failed" });
		});

		it("returns 400 when run not found", async () => {
			const retryFn: RetryFn = async () => ({ error: "Run not found" });
			const retryApp = createApi({ runner, db, retryRun: retryFn });

			const res = await retryApp.request("/runs/nonexistent/retry", {
				method: "POST",
			});

			expect(res.status).toBe(400);
		});
	});
});
