import type { IssueKey, IssueNumber, RepoSlug } from "../types/brands.ts";
import type { Result } from "../types/result.ts";

export type Issue = {
	key: IssueKey;
	number: IssueNumber;
	title: string;
	description: string;
	labels: string[];
	url: string;
	createdAt: string;
};

export type TrackerState = "pending" | "running" | "awaiting_review";

export type ParseIssueKeyError = {
	kind: "invalid_format";
	input: string;
	message: string;
};

export type TrackerAdapter = {
	fetchIssue(repo: RepoSlug, issueNumber: IssueNumber): Promise<Issue>;
	fetchActiveIssues(repo: RepoSlug, state: TrackerState): Promise<Issue[]>;
	transitionState(
		repo: RepoSlug,
		issueNumber: IssueNumber,
		from: TrackerState,
		to: TrackerState,
	): Promise<void>;
	parseIssueKey(
		key: string,
	): Result<{ repo: RepoSlug; number: IssueNumber }, ParseIssueKeyError>;
};
