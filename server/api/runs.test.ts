import { describe, expect, it } from "vitest";
import { createTestApi } from "../tests/support/test-api.ts";
import { seedEvent, seedRun } from "../tests/support/test-db.ts";

describe("GET /runs", () => {
	it("returns empty array when no runs exist", async () => {
		const { app } = createTestApi();

		const res = await app.request("/runs");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("returns runs ordered by startedAt descending", async () => {
		const { app, db } = createTestApi();
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
		const { app, db } = createTestApi();
		seedRun(db, { id: "a", agentName: "agent-alpha" });
		seedRun(db, { id: "b", agentName: "agent-beta" });

		const res = await app.request("/runs?agent=agent-alpha");
		const body = await res.json();

		expect(body).toHaveLength(1);
		expect(body[0].id).toBe("a");
	});

	it("filters by status", async () => {
		const { app, db } = createTestApi();
		seedRun(db, { id: "running-1", status: "running" });
		seedRun(db, { id: "done-1", status: "completed" });
		seedRun(db, { id: "fail-1", status: "failed" });

		const res = await app.request("/runs?status=running");
		const body = await res.json();

		expect(body).toHaveLength(1);
		expect(body[0].id).toBe("running-1");
	});

	it("respects limit parameter", async () => {
		const { app, db } = createTestApi();
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
	it("returns run with its events ordered by createdAt", async () => {
		const { app, db } = createTestApi();
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
		const { app } = createTestApi();

		const res = await app.request("/runs/nonexistent");

		expect(res.status).toBe(404);
	});
});

describe("POST /runs/:id/kill", () => {
	it("kills a running job and returns success", async () => {
		const { app, runner } = createTestApi();
		const { runId } = runner.enqueue({
			name: "long-job",
			issueKey: "test/repo#1",
			issueTitle: "Long running job",
			handler: () => new Promise(() => {}),
		});

		const res = await app.request(`/runs/${runId}/kill`, { method: "POST" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ killed: true });
	});

	it("returns 404 for unknown run", async () => {
		const { app } = createTestApi();

		const res = await app.request("/runs/nonexistent/kill", {
			method: "POST",
		});

		expect(res.status).toBe(404);
	});
});

describe("POST /runs/:id/retry", () => {
	it("returns 201 with new runId on successful retry", async () => {
		const { app, db } = createTestApi(async () => ({ runId: "new-run-1" }));
		seedRun(db, { id: "failed-1", status: "failed" });

		const res = await app.request("/runs/failed-1/retry", { method: "POST" });

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ runId: "new-run-1" });
	});

	it("returns 400 when retryRun returns an error", async () => {
		const { app, db } = createTestApi(async () => ({
			error: "Run is not failed",
		}));
		seedRun(db, { id: "completed-1", status: "completed" });

		const res = await app.request("/runs/completed-1/retry", {
			method: "POST",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Run is not failed" });
	});

	it("returns 400 when run not found", async () => {
		const { app } = createTestApi(async () => ({ error: "Run not found" }));

		const res = await app.request("/runs/nonexistent/retry", {
			method: "POST",
		});

		expect(res.status).toBe(400);
	});
});
