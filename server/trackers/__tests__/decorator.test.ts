import { describe, expect, it } from "vitest";
import { decorateTracker } from "../decorator.ts";
import type { TrackerAdapter } from "../types.ts";

function createFakeTracker(
	overrides: Partial<TrackerAdapter> = {},
): TrackerAdapter {
	return {
		fetchIssue: async () => {
			throw new Error("not implemented");
		},
		fetchActiveIssues: async () => [],
		swapLabel: async () => {},
		...overrides,
	};
}

describe("decorateTracker", () => {
	describe("fetchIssue", () => {
		it("re-throws when inner fetchIssue fails", async () => {
			const decorated = decorateTracker(
				createFakeTracker({
					fetchIssue: async () => {
						throw new Error("not found");
					},
				}),
			);

			await expect(decorated.fetchIssue("owner/repo", 42)).rejects.toThrow(
				"not found",
			);
		});
	});

	describe("swapLabel", () => {
		it("delegates to inner tracker on success", async () => {
			const calls: { repo: string; issueNumber: number }[] = [];

			const decorated = decorateTracker(
				createFakeTracker({
					swapLabel: async (repo, issueNumber) => {
						calls.push({ repo, issueNumber });
					},
				}),
			);

			await decorated.swapLabel("owner/repo", 42, "old", "new");
			expect(calls).toEqual([{ repo: "owner/repo", issueNumber: 42 }]);
		});

		it("re-throws when inner swapLabel fails", async () => {
			const decorated = decorateTracker(
				createFakeTracker({
					swapLabel: async () => {
						throw new Error("GitHub API 500");
					},
				}),
			);

			await expect(
				decorated.swapLabel("owner/repo", 1, "old", "new"),
			).rejects.toThrow("GitHub API 500");
		});
	});
});
