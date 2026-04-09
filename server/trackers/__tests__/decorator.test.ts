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

	describe("fetchActiveIssues", () => {
		it("re-throws when inner fetchActiveIssues fails", async () => {
			const decorated = decorateTracker(
				createFakeTracker({
					fetchActiveIssues: async () => {
						throw new Error("network timeout");
					},
				}),
			);

			await expect(
				decorated.fetchActiveIssues("owner/repo", "agent"),
			).rejects.toThrow("network timeout");
		});
	});
});
