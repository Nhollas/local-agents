import { describe, expect, it } from "vitest";
import * as canonicalLog from "../canonical-log.ts";

type LogFields = Record<string, unknown>;

function capturingLogger(): {
	logger: { info(obj: LogFields, msg: string): void };
	bag: () => LogFields;
} {
	let captured: LogFields = {};
	return {
		logger: {
			info(obj: LogFields) {
				captured = obj;
			},
		},
		bag: () => captured,
	};
}

describe("canonicalLog", () => {
	describe("outside a scope", () => {
		it("set, append, and increment are no-ops", () => {
			canonicalLog.set({ key: "value" });
			canonicalLog.append("key", "value");
			canonicalLog.increment("key");
		});
	});

	describe("set", () => {
		it("merges fields into the flushed bag", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.set({ user: "alice" });
					canonicalLog.set({ action: "login" });
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					scope: "test",
					user: "alice",
					action: "login",
				}),
			);
		});

		it("overwrites earlier values for the same key", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.set({ status: "pending" });
					canonicalLog.set({ status: "completed" });
				},
				logger,
			);

			expect(bag()).toEqual(expect.objectContaining({ status: "completed" }));
		});
	});

	describe("append", () => {
		it("builds an array field across multiple calls", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.append("warnings", "slow_query");
					canonicalLog.append("warnings", "deprecated_api");
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					warnings: ["slow_query", "deprecated_api"],
				}),
			);
		});

		it("creates a single-element array on first call", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.append("items", "only");
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					items: ["only"],
				}),
			);
		});
	});

	describe("increment", () => {
		it("counts up from zero across multiple calls", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.increment("tool_use_count");
					canonicalLog.increment("tool_use_count");
					canonicalLog.increment("tool_use_count");
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					tool_use_count: 3,
				}),
			);
		});

		it("accepts a custom delta", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.increment("bytes", 512);
					canonicalLog.increment("bytes", 256);
				},
				logger,
			);

			expect(bag()).toEqual(expect.objectContaining({ bytes: 768 }));
		});
	});

	describe("scenarios", () => {
		it("successful agent run with PR creation", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{
					scope: "run",
					run_id: "run_abc123",
					agent: "issue-42",
					issue_key: "owner/repo#42",
					attempt: 1,
				},
				async () => {
					// Agent processes tool calls
					canonicalLog.increment("tool_use_count");
					canonicalLog.increment("tool_use_count");
					canonicalLog.increment("tool_use_count");

					// Tracker fetches the issue
					canonicalLog.set({ tracker_fetch_issue: "owner/repo#42" });

					// Run completes
					canonicalLog.set({ status: "completed" });

					// PR created, label swapped
					canonicalLog.set({ pr_url: "https://github.com/owner/repo/pull/99" });
					canonicalLog.append("label_swaps", {
						from: "agent:running",
						to: "agent:completed",
					});
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					scope: "run",
					run_id: "run_abc123",
					agent: "issue-42",
					issue_key: "owner/repo#42",
					attempt: 1,
					tool_use_count: 3,
					tracker_fetch_issue: "owner/repo#42",
					status: "completed",
					pr_url: "https://github.com/owner/repo/pull/99",
					label_swaps: [{ from: "agent:running", to: "agent:completed" }],
				}),
			);
			expect(bag()["duration_ms"]).toEqual(expect.any(Number));
		});

		it("failed run with cascading post-run failures", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{
					scope: "run",
					run_id: "run_def456",
					agent: "issue-7",
					issue_key: "owner/repo#7",
					attempt: 3,
				},
				async () => {
					canonicalLog.increment("tool_use_count");

					// Agent crashes
					canonicalLog.set({
						status: "failed",
						error: "Claude exited with code 1",
					});

					// PR creation fails
					canonicalLog.append(
						"warnings",
						"on_complete_failed: GitHub API rate limited",
					);

					// Label recovery also fails
					canonicalLog.append(
						"warnings",
						"label_recovery_failed: GitHub API rate limited",
					);
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					scope: "run",
					run_id: "run_def456",
					agent: "issue-7",
					issue_key: "owner/repo#7",
					attempt: 3,
					tool_use_count: 1,
					status: "failed",
					error: "Claude exited with code 1",
					warnings: [
						"on_complete_failed: GitHub API rate limited",
						"label_recovery_failed: GitHub API rate limited",
					],
				}),
			);
			expect(bag()["duration_ms"]).toEqual(expect.any(Number));
		});

		it("http request that hits an error", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{
					scope: "http",
					request_id: "req_abc123",
					method: "POST",
					path: "/api/dispatch",
				},
				async () => {
					// Handler throws, problem-details middleware catches it
					canonicalLog.set({
						error: "Repository not found",
						error_type: "https://local-agents/not-found",
					});

					// Response middleware sets status
					canonicalLog.set({ status: 404 });
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					scope: "http",
					request_id: "req_abc123",
					method: "POST",
					path: "/api/dispatch",
					error: "Repository not found",
					error_type: "https://local-agents/not-found",
					status: 404,
				}),
			);
			expect(bag()["duration_ms"]).toEqual(expect.any(Number));
		});
	});

	describe("run", () => {
		it("includes initial fields and duration_ms in the flushed bag", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "http", method: "GET" },
				async () => {},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					scope: "http",
					method: "GET",
				}),
			);
			expect(bag()["duration_ms"]).toEqual(expect.any(Number));
		});

		it("returns the value from the wrapped function", async () => {
			const { logger } = capturingLogger();
			const result = await canonicalLog.run(
				{ scope: "test" },
				async () => 42,
				logger,
			);
			expect(result).toBe(42);
		});

		it("flushes the bag even when the function throws", async () => {
			const { logger, bag } = capturingLogger();

			await expect(
				canonicalLog.run(
					{ scope: "test" },
					async () => {
						canonicalLog.set({ status: "failed" });
						throw new Error("boom");
					},
					logger,
				),
			).rejects.toThrow("boom");

			expect(bag()).toEqual(
				expect.objectContaining({
					scope: "test",
					status: "failed",
				}),
			);
			expect(bag()["duration_ms"]).toEqual(expect.any(Number));
		});
	});
});
