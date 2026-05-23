import { describe, expect, it } from "vitest";
import { createTestApi } from "../test-support/test-api.ts";
import type { HealthCheck } from "./api.ts";

describe("GET /health", () => {
	it("returns 200 with healthy status when all checks pass", async () => {
		const { app } = createTestApi();

		const res = await app.request("/health");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "healthy",
			checks: { database: { status: "pass" } },
		});
	});

	it("returns 503 with unhealthy status when a check fails", async () => {
		const unhealthyCheck: HealthCheck = () => ({
			status: "unhealthy",
			checks: {
				database: { status: "fail", message: "connection refused" },
			},
		});
		const { app } = createTestApi({ checkHealth: unhealthyCheck });

		const res = await app.request("/health");

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			status: "unhealthy",
			checks: {
				database: { status: "fail", message: "connection refused" },
			},
		});
	});
});

describe("GET /events", () => {
	it("delivers run lifecycle events over SSE with id/event/data frames", async () => {
		const { app, runner } = createTestApi();

		const res = await app.request("/events");
		const body = res.body;
		if (!body) throw new Error("Expected response body to be a ReadableStream");
		const reader = body.getReader();
		const decoder = new TextDecoder();

		const readWithTimeout = () =>
			Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("SSE read timed out")), 5_000),
				),
			]);

		try {
			// Read the initial heartbeat to confirm the stream is active
			await readWithTimeout();

			runner.enqueue({
				repo: "test/repo",
				issueKey: "test/repo#42",
				issueTitle: "SSE test issue",
				issueUrl: null,
				repoUrl: "https://code-host.example.test/test/repo",
				handler: async () => ({ status: "completed" as const, durationMs: 0 }),
			});

			await runner.waitForIdle();

			let collected = "";
			for (let i = 0; i < 20; i++) {
				const { value, done } = await readWithTimeout();
				if (done) break;
				collected += decoder.decode(value, { stream: true });
				if (
					collected.includes("run:started") &&
					collected.includes("run:completed")
				)
					break;
			}

			expect(collected).toContain("event: run:started");
			expect(collected).toContain("event: run:completed");
			expect(collected).toContain("id: ");
			expect(collected).toContain("test/repo#42");
		} finally {
			reader.cancel();
		}
	});

	it("replays only events with seq > Last-Event-ID's seq on reconnect", async () => {
		const { app, runner } = createTestApi();

		const { runId, result: done } = runner.enqueue({
			repo: "test/repo",
			issueKey: "test/repo#100",
			issueTitle: "Replay test",
			issueUrl: null,
			repoUrl: "https://code-host.example.test/test/repo",
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

		const list = (await (
			await app.request(`/runs/${runId}/events`)
		).json()) as Array<{ id: string; kind: string; data: { text?: string } }>;
		const lastEventId = list[1]?.id;
		expect(lastEventId).toBeTruthy();

		const res = await app.request("/events", {
			headers: { "Last-Event-ID": lastEventId as string },
		});
		const reader = res.body?.getReader();
		if (!reader) throw new Error("expected stream");
		const decoder = new TextDecoder();

		try {
			let collected = "";
			for (let i = 0; i < 20; i++) {
				const { value, done } = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("timeout")), 5_000),
					),
				]);
				if (done) break;
				collected += decoder.decode(value, { stream: true });
				if (collected.includes("run:completed")) break;
			}
			// First "agent:say" was at lastEventId — should NOT be replayed.
			// Only events strictly after it (the second say + run:completed).
			expect(collected).not.toContain('"text":"first"');
			expect(collected).toContain('"text":"second"');
			expect(collected).toContain("event: run:completed");
		} finally {
			await reader.cancel();
		}
	});
});
