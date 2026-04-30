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
		transitionState: async () => {},
		parseIssueKey: () => ({ repo: "owner/repo", number: 1 }),
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

	describe("transitionState", () => {
		it("delegates to inner tracker on success", async () => {
			const calls: {
				repo: string;
				issueNumber: number;
				from: string;
				to: string;
			}[] = [];

			const decorated = decorateTracker(
				createFakeTracker({
					transitionState: async (repo, issueNumber, from, to) => {
						calls.push({ repo, issueNumber, from, to });
					},
				}),
			);

			await decorated.transitionState("owner/repo", 42, "pending", "running");
			expect(calls).toEqual([
				{
					repo: "owner/repo",
					issueNumber: 42,
					from: "pending",
					to: "running",
				},
			]);
		});

		it("re-throws when inner transitionState fails", async () => {
			const decorated = decorateTracker(
				createFakeTracker({
					transitionState: async () => {
						throw new Error("GitHub API 500");
					},
				}),
			);

			await expect(
				decorated.transitionState("owner/repo", 1, "pending", "running"),
			).rejects.toThrow("GitHub API 500");
		});
	});

	describe("parseIssueKey", () => {
		it("delegates to inner tracker", () => {
			const decorated = decorateTracker(
				createFakeTracker({
					parseIssueKey: () => ({ repo: "owner/repo", number: 42 }),
				}),
			);

			expect(decorated.parseIssueKey("owner/repo#42")).toEqual({
				repo: "owner/repo",
				number: 42,
			});
		});
	});
});
