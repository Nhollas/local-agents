import { describe, expect, it } from "vitest";
import { createTestApi } from "../tests/support/test-api.ts";

describe("GET /health", () => {
	it("returns OK", async () => {
		const { app } = createTestApi();

		const res = await app.request("/health");

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("OK");
	});
});

describe("GET /events", () => {
	it("delivers run lifecycle events over SSE", async () => {
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
				name: "sse-agent",
				issueKey: "test/repo#42",
				issueTitle: "SSE test issue",
				handler: async () => {},
			});

			await runner.queue.waitForIdle();

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
			expect(collected).toContain("sse-agent");
			expect(collected).toContain("test/repo#42");
		} finally {
			reader.cancel();
		}
	});
});
