import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ModelIdSchema } from "./model-id.ts";

const decode = Schema.decodeUnknownSync(ModelIdSchema);

describe("ModelIdSchema", () => {
	it.each([
		"claude-opus-4-7",
		"claude-sonnet-4-6",
		"claude-haiku-4-5-20251001",
	])("accepts %s", (id) => {
		expect(decode(id)).toBe(id);
	});

	it.each([
		"gpt-4",
		"banana",
		"claud-opus-4-7",
		"claude-opus",
		"claude-opus-4",
		"",
	])("rejects %s", (id) => {
		expect(() => decode(id)).toThrow();
	});
});
