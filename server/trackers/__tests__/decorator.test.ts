import { describe, expect, it } from "vitest";
import {
	type IssueNumber,
	issueNumber,
	type RepoSlug,
	repoSlug,
} from "../../types/brands.ts";
import { ok } from "../../types/result.ts";
import { decorateTracker } from "../decorator.ts";
import type { TrackerAdapter } from "../types.ts";

function createFakeTracker(
	overrides: Partial<TrackerAdapter> = {},
): TrackerAdapter {
	return {
		fetchIssue: async () => {
			throw new Error("not implemented");
		},
		fetchActiveIssues: async () => ({ issues: [], scopesReached: new Set() }),
		transitionState: async () => {},
		markFailed: async () => {},
		parseIssueKey: () => ok({ number: issueNumber(1) }),
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

			await expect(
				decorated.fetchIssue(repoSlug("owner/repo"), issueNumber(42)),
			).rejects.toThrow("not found");
		});
	});

	describe("fetchActiveIssues", () => {
		it("re-throws when inner fetchActiveIssues fails", async () => {
			const decorated = decorateTracker(
				createFakeTracker({
					fetchActiveIssues: async () => {
						throw new Error("upstream down");
					},
				}),
			);

			await expect(decorated.fetchActiveIssues("pending")).rejects.toThrow(
				"upstream down",
			);
		});
	});

	describe("transitionState", () => {
		it("delegates to inner tracker on success", async () => {
			const calls: {
				repo: RepoSlug;
				issueNumber: IssueNumber;
				from: string;
				to: string;
			}[] = [];

			const decorated = decorateTracker(
				createFakeTracker({
					transitionState: async (repo, issueNum, from, to) => {
						calls.push({ repo, issueNumber: issueNum, from, to });
					},
				}),
			);

			await decorated.transitionState(
				repoSlug("owner/repo"),
				issueNumber(42),
				"pending",
				"running",
			);
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
						throw new Error("Tracker API 500");
					},
				}),
			);

			await expect(
				decorated.transitionState(
					repoSlug("owner/repo"),
					issueNumber(1),
					"pending",
					"running",
				),
			).rejects.toThrow("Tracker API 500");
		});
	});

	describe("markFailed", () => {
		it("delegates to inner tracker on success", async () => {
			const calls: { repo: RepoSlug; issueNumber: IssueNumber }[] = [];

			const decorated = decorateTracker(
				createFakeTracker({
					markFailed: async (repo, issueNum) => {
						calls.push({ repo, issueNumber: issueNum });
					},
				}),
			);

			await decorated.markFailed(repoSlug("owner/repo"), issueNumber(42));

			expect(calls).toEqual([{ repo: "owner/repo", issueNumber: 42 }]);
		});

		it("re-throws when inner markFailed fails", async () => {
			const decorated = decorateTracker(
				createFakeTracker({
					markFailed: async () => {
						throw new Error("Tracker API 500");
					},
				}),
			);

			await expect(
				decorated.markFailed(repoSlug("owner/repo"), issueNumber(1)),
			).rejects.toThrow("Tracker API 500");
		});
	});

	describe("parseIssueKey", () => {
		it("delegates to inner tracker", () => {
			const decorated = decorateTracker(
				createFakeTracker({
					parseIssueKey: () => ok({ number: issueNumber(42) }),
				}),
			);

			expect(decorated.parseIssueKey("owner/repo#42")).toEqual({
				ok: true,
				value: {
					number: 42,
				},
			});
		});
	});
});
