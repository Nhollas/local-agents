import { describe, expect, it, vi } from "vitest";
import * as canonicalLog from "./canonical-log.ts";

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

	describe("incrementMap", () => {
		it("counts up nested keys across multiple calls", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.incrementMap("tool_use_by_name", "Read");
					canonicalLog.incrementMap("tool_use_by_name", "Read");
					canonicalLog.incrementMap("tool_use_by_name", "Edit");
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					tool_use_by_name: { Read: 2, Edit: 1 },
				}),
			);
		});

		it("accepts a custom delta", async () => {
			const { logger, bag } = capturingLogger();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.incrementMap("bytes_by_kind", "json", 512);
					canonicalLog.incrementMap("bytes_by_kind", "json", 256);
				},
				logger,
			);

			expect(bag()).toEqual(
				expect.objectContaining({ bytes_by_kind: { json: 768 } }),
			);
		});

		it("warns and overwrites when the key already holds a non-map value", async () => {
			const { logger, bag } = capturingLogger();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.set({ tool_use_by_name: "Read" });
					canonicalLog.incrementMap("tool_use_by_name", "Read");
				},
				logger,
			);

			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					'overwriting non-map value at key "tool_use_by_name"',
				),
			);
			expect(bag()).toEqual(
				expect.objectContaining({ tool_use_by_name: { Read: 1 } }),
			);
			warn.mockRestore();
		});
	});

	describe("scenarios", () => {
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
