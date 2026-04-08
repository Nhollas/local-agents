import { describe, expect, it } from "vitest";
import * as canonicalLog from "./canonical-log.ts";

type LogFields = Record<string, unknown>;

function capturingFlush(): {
	flush: (bag: LogFields) => void;
	bag: () => LogFields;
} {
	let captured: LogFields = {};
	return {
		flush: (bag: LogFields) => {
			captured = bag;
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
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.set({ user: "alice" });
					canonicalLog.set({ action: "login" });
				},
				flush,
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
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.set({ status: "pending" });
					canonicalLog.set({ status: "completed" });
				},
				flush,
			);

			expect(bag()).toEqual(expect.objectContaining({ status: "completed" }));
		});
	});

	describe("append", () => {
		it("builds an array field across multiple calls", async () => {
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.append("warnings", "slow_query");
					canonicalLog.append("warnings", "deprecated_api");
				},
				flush,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					warnings: ["slow_query", "deprecated_api"],
				}),
			);
		});

		it("creates a single-element array on first call", async () => {
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.append("items", "only");
				},
				flush,
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
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.increment("tool_use_count");
					canonicalLog.increment("tool_use_count");
					canonicalLog.increment("tool_use_count");
				},
				flush,
			);

			expect(bag()).toEqual(
				expect.objectContaining({
					tool_use_count: 3,
				}),
			);
		});

		it("accepts a custom delta", async () => {
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "test" },
				async () => {
					canonicalLog.increment("bytes", 512);
					canonicalLog.increment("bytes", 256);
				},
				flush,
			);

			expect(bag()).toEqual(expect.objectContaining({ bytes: 768 }));
		});
	});

	describe("run", () => {
		it("includes initial fields and duration_ms in the flushed bag", async () => {
			const { flush, bag } = capturingFlush();

			await canonicalLog.run(
				{ scope: "http", method: "GET" },
				async () => {},
				flush,
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
			const result = await canonicalLog.run({ scope: "test" }, async () => 42);
			expect(result).toBe(42);
		});

		it("flushes the bag even when the function throws", async () => {
			const { flush, bag } = capturingFlush();

			await expect(
				canonicalLog.run(
					{ scope: "test" },
					async () => {
						canonicalLog.set({ status: "failed" });
						throw new Error("boom");
					},
					flush,
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
