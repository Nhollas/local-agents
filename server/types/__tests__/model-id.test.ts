import { describe, expect, it } from "vitest";
import { modelIdSchema } from "../model-id.ts";

describe("modelIdSchema", () => {
	it.each([
		"claude-opus-4-7",
		"claude-sonnet-4-6",
		"claude-haiku-4-5-20251001",
	])("accepts %s", (id) => {
		expect(modelIdSchema.parse(id)).toBe(id);
	});

	it.each([
		"gpt-4",
		"banana",
		"claud-opus-4-7",
		"claude-opus",
		"claude-opus-4",
		"",
	])("rejects %s", (id) => {
		expect(() => modelIdSchema.parse(id)).toThrow();
	});
});
