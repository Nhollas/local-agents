import { describe, expect, it } from "vitest";
import { err, map, mapErr, ok, unwrap } from "../result.ts";

describe("Result", () => {
	describe("ok", () => {
		it("wraps a value", () => {
			expect(ok(42)).toEqual({ ok: true, value: 42 });
		});
	});

	describe("err", () => {
		it("wraps an error", () => {
			expect(err("boom")).toEqual({ ok: false, error: "boom" });
		});
	});

	describe("map", () => {
		it("transforms the value of an Ok", () => {
			expect(map(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });
		});

		it("passes an Err through unchanged", () => {
			expect(map(err("bad"), (n: number) => n * 3)).toEqual({
				ok: false,
				error: "bad",
			});
		});
	});

	describe("mapErr", () => {
		it("transforms the error of an Err", () => {
			expect(mapErr(err("bad"), (e) => `wrapped: ${e}`)).toEqual({
				ok: false,
				error: "wrapped: bad",
			});
		});

		it("passes an Ok through unchanged", () => {
			expect(mapErr(ok(42), (e: string) => `wrapped: ${e}`)).toEqual({
				ok: true,
				value: 42,
			});
		});
	});

	describe("unwrap", () => {
		it("returns the value of an Ok", () => {
			expect(unwrap(ok(42))).toBe(42);
		});

		it("throws when called on an Err", () => {
			expect(() => unwrap(err("bad"))).toThrow("unwrap on Err: bad");
		});
	});
});
