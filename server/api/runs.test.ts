import { describe, expect, it } from "vitest";
import { createTestApi } from "../test-support/test-api.ts";
import { seedRun, seedStep } from "../test-support/test-db.ts";
import { issueKey, repoSlug } from "../types/brands.ts";

const baseRunWire = {
	branch: null,
	workspaceDir: null,
	issueUrl: null,
	costUsd: null,
	tokensInput: null,
	tokensOutput: null,
	pr: null,
};

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

		expect(res.status).toBe(200);
		expect(body).toEqual([
			{
				id: "newest",
				status: "completed",
				error: null,
				repo: "test-owner/test-repo",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-03T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: 0,
				...baseRunWire,
			},
			{
				id: "middle",
				status: "completed",
				error: null,
				repo: "test-owner/test-repo",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-02T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: 0,
				...baseRunWire,
			},
			{
				id: "oldest",
				status: "completed",
				error: null,
				repo: "test-owner/test-repo",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: 0,
				...baseRunWire,
			},
		]);
	});

	it("filters by repo", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "a",
			repo: "acme/api",
			startedAt: "2025-01-01T00:00:00Z",
		});
		seedRun(db, {
			id: "b",
			repo: "widgets/dashboard",
			startedAt: "2025-01-02T00:00:00Z",
		});

		const res = await app.request("/runs?repo=acme/api");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual([
			{
				id: "a",
				status: "completed",
				error: null,
				repo: "acme/api",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: 0,
				...baseRunWire,
			},
		]);
	});

	it("filters by status", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "running-1",
			status: "running",
			startedAt: "2025-01-01T00:00:00Z",
		});
		seedRun(db, {
			id: "done-1",
			status: "completed",
			startedAt: "2025-01-02T00:00:00Z",
		});
		seedRun(db, {
			id: "fail-1",
			status: "failed",
			startedAt: "2025-01-03T00:00:00Z",
		});

		const res = await app.request("/runs?status=running");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual([
			{
				id: "running-1",
				status: "running",
				error: null,
				repo: "test-owner/test-repo",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: null,
				durationMs: null,
				...baseRunWire,
			},
		]);
	});

	it("returns failed runs with their error and completion fields", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "fail-1",
			status: "failed",
			startedAt: "2025-01-03T00:00:00Z",
			completedAt: "2025-01-03T00:00:02Z",
			durationMs: 1500,
			error: "agent timed out",
		});

		const res = await app.request("/runs?status=failed");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual([
			{
				id: "fail-1",
				status: "failed",
				error: "agent timed out",
				repo: "test-owner/test-repo",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-03T00:00:00Z",
				completedAt: "2025-01-03T00:00:02Z",
				durationMs: 1500,
				...baseRunWire,
			},
		]);
	});

	it("respects limit parameter", async () => {
		const { app, db } = createTestApi();
		seedRun(db, { id: "r1", startedAt: "2025-01-01T00:00:00Z" });
		seedRun(db, { id: "r2", startedAt: "2025-01-02T00:00:00Z" });
		seedRun(db, { id: "r3", startedAt: "2025-01-03T00:00:00Z" });

		const res = await app.request("/runs?limit=1");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual([
			{
				id: "r3",
				status: "completed",
				error: null,
				repo: "test-owner/test-repo",
				issueKey: null,
				issueTitle: null,
				startedAt: "2025-01-03T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: 0,
				...baseRunWire,
			},
		]);
	});
});

describe("GET /runs/:id", () => {
	it("returns the run with its ordered step list", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "run-1",
			status: "running",
			repo: "acme/api",
			issueKey: "acme/api#1284",
			issueTitle: "npm install hangs on linux runners",
			issueUrl: "https://acme.atlassian.net/browse/ACME-1284",
			branch: "fix/ACME-1284-npm-install-hang",
			workspaceDir: "/tmp/lag/9f3b2e1",
			costUsd: 0.034,
			tokensInput: 9800,
			tokensOutput: 2600,
			startedAt: "2026-05-09T14:27:56Z",
		});
		seedStep(db, {
			runId: "run-1",
			index: 1,
			name: "implement",
			state: "running",
			startedAt: "2026-05-09T14:28:19Z",
		});
		seedStep(db, {
			runId: "run-1",
			index: 2,
			name: "review",
			state: "pending",
		});
		seedStep(db, {
			runId: "run-1",
			index: 3,
			name: "summarise",
			state: "pending",
		});

		const res = await app.request("/runs/run-1");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual({
			run: {
				id: "run-1",
				status: "running",
				error: null,
				repo: "acme/api",
				branch: "fix/ACME-1284-npm-install-hang",
				workspaceDir: "/tmp/lag/9f3b2e1",
				issueKey: "acme/api#1284",
				issueTitle: "npm install hangs on linux runners",
				issueUrl: "https://acme.atlassian.net/browse/ACME-1284",
				startedAt: "2026-05-09T14:27:56Z",
				completedAt: null,
				durationMs: null,
				costUsd: 0.034,
				tokensInput: 9800,
				tokensOutput: 2600,
				pr: null,
			},
			steps: [
				{
					index: 1,
					name: "implement",
					state: "running",
					startedAt: "2026-05-09T14:28:19Z",
					completedAt: null,
					durationMs: null,
					error: null,
				},
				{
					index: 2,
					name: "review",
					state: "pending",
					startedAt: null,
					completedAt: null,
					durationMs: null,
					error: null,
				},
				{
					index: 3,
					name: "summarise",
					state: "pending",
					startedAt: null,
					completedAt: null,
					durationMs: null,
					error: null,
				},
			],
		});
	});

	it("returns an empty step list when no steps have been recorded", async () => {
		const { app, db } = createTestApi();
		seedRun(db, { id: "run-empty", status: "running" });

		const res = await app.request("/runs/run-empty");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.steps).toEqual([]);
	});

	it("returns 404 for unknown run", async () => {
		const { app } = createTestApi();

		const res = await app.request("/runs/nonexistent");

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 404,
			title: "Not Found",
			detail: "Not found",
			requestId: expect.any(String),
		});
	});
});

describe("POST /runs/:id/kill", () => {
	it("kills a running job and returns success", async () => {
		const { app, runner } = createTestApi();
		const { runId } = runner.enqueue({
			repo: repoSlug("test/repo"),
			issueKey: issueKey("test/repo#1"),
			issueTitle: "Long running job",
			issueUrl: null,
			handler: () => new Promise(() => {}),
		});

		const res = await app.request(`/runs/${runId}/kill`, { method: "POST" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ killed: true });
	});

	it("returns 404 when the run does not exist", async () => {
		const { app } = createTestApi();

		const res = await app.request("/runs/unknown/kill", { method: "POST" });

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 404,
			title: "Not Found",
			detail: "Not found",
			requestId: expect.any(String),
		});
	});

	it("returns 409 when the run is already completed", async () => {
		const { app, db } = createTestApi();
		seedRun(db, { id: "done", status: "completed" });

		const res = await app.request("/runs/done/kill", { method: "POST" });

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 409,
			title: "Conflict",
			detail: "Run already completed",
			requestId: expect.any(String),
		});
	});

	it("returns 409 when the run is already failed", async () => {
		const { app, db } = createTestApi();
		seedRun(db, { id: "boom", status: "failed", error: "x" });

		const res = await app.request("/runs/boom/kill", { method: "POST" });

		expect(res.status).toBe(409);
	});
});

describe("GET /runs/:id/events", () => {
	it("returns 404 for unknown run", async () => {
		const { app } = createTestApi();
		const res = await app.request("/runs/missing/events");
		expect(res.status).toBe(404);
	});

	it("returns events ordered oldest → newest with monotonic seq", async () => {
		const { app, runner } = createTestApi();
		const { runId, done } = runner.enqueue({
			repo: repoSlug("test/repo"),
			issueKey: issueKey("test/repo#1"),
			issueTitle: "Event ordering",
			issueUrl: null,
			handler: async (ctx) => {
				ctx.emit({
					kind: "agent:say",
					stepName: "implement",
					data: { text: "first" },
				});
				ctx.emit({
					kind: "agent:say",
					stepName: "implement",
					data: { text: "second" },
				});
				return { status: "completed", durationMs: 0 };
			},
		});
		await done;

		const res = await app.request(`/runs/${runId}/events`);
		expect(res.status).toBe(200);
		const events = (await res.json()) as Array<{
			seq: number;
			kind: string;
			data: { text?: string };
		}>;
		expect(events.map((e) => e.kind)).toEqual([
			"run:started",
			"agent:say",
			"agent:say",
			"run:completed",
		]);
		const seqs = events.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("filters events by since cursor (strictly greater seq)", async () => {
		const { app, runner } = createTestApi();
		const { runId, done } = runner.enqueue({
			repo: repoSlug("test/repo"),
			issueKey: issueKey("test/repo#2"),
			issueTitle: "Since cursor",
			issueUrl: null,
			handler: async (ctx) => {
				ctx.emit({
					kind: "agent:say",
					stepName: "implement",
					data: { text: "a" },
				});
				ctx.emit({
					kind: "agent:say",
					stepName: "implement",
					data: { text: "b" },
				});
				return { status: "completed", durationMs: 0 };
			},
		});
		await done;

		const all = (await (
			await app.request(`/runs/${runId}/events`)
		).json()) as Array<{ id: string; kind: string }>;
		const cursor = all[1]?.id;
		const after = (await (
			await app.request(`/runs/${runId}/events?since=${cursor}`)
		).json()) as Array<{ kind: string }>;
		expect(after.map((e) => e.kind)).toEqual(["agent:say", "run:completed"]);
	});

	it("returns 400 for unknown since cursor", async () => {
		const { app, db } = createTestApi();
		seedRun(db, { id: "live", status: "running" });
		const res = await app.request("/runs/live/events?since=does-not-exist");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 400,
			title: "Bad Request",
			detail: "Unknown since cursor",
			requestId: expect.any(String),
		});
	});
});
