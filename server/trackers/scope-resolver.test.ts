import { describe, expect, it } from "vitest";
import { repoSlug } from "../types/brands.ts";
import { resolveRepo } from "./scope-resolver.ts";

describe("resolveRepo", () => {
	it("returns the path when it exactly matches a scope", () => {
		expect(resolveRepo("acme/widgets", ["acme/widgets"])).toEqual(
			repoSlug("acme/widgets"),
		);
	});

	it("returns the full path when it descends from a scope", () => {
		expect(
			resolveRepo("acme/widgets/playground/foo", ["acme/widgets"]),
		).toEqual(repoSlug("acme/widgets/playground/foo"));
	});

	it("does not match a sibling that shares a string prefix", () => {
		expect(resolveRepo("acme/widgets-other", ["acme/widgets"])).toEqual(null);
	});

	it("returns null when no scope matches", () => {
		expect(
			resolveRepo("other-org/repo", ["acme/widgets", "acme/services"]),
		).toEqual(null);
	});

	it("returns null for an empty scopes list", () => {
		expect(resolveRepo("acme/widgets", [])).toEqual(null);
	});

	it("resolves overlapping scopes in iteration order, not by specificity", () => {
		expect(resolveRepo("acme/widgets", ["acme", "acme/widgets"])).toEqual(
			repoSlug("acme/widgets"),
		);
	});
});
