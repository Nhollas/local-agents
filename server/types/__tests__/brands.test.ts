import { describe, expect, it } from "vitest";
import type { Brand } from "../brands.ts";
import { err, ok, type Result } from "../result.ts";

type SampleId = Brand<string, "SampleId">;

function parseSampleId(value: string): Result<SampleId, "invalid"> {
	if (value.length === 0) return err("invalid");
	return ok(value as SampleId);
}

describe("Brand validating constructor pattern", () => {
	it("returns Ok with a branded value for valid input", () => {
		expect(parseSampleId("abc")).toEqual({
			ok: true,
			value: "abc",
		});
	});

	it("returns Err for invalid input", () => {
		expect(parseSampleId("")).toEqual({
			ok: false,
			error: "invalid",
		});
	});
});
