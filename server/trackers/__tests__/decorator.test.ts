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

	it("re-throws when an inner tracker call fails", async () => {
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
