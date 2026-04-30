import { describe, expect, it } from "vitest";
import { assertNever } from "../exhaustive.ts";

describe("assertNever", () => {
	it("throws when reached", () => {
		expect(() => assertNever("unreachable" as never)).toThrow(
			"Unexpected value: unreachable",
		);
	});
});
