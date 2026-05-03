import type { IssueKey, IssueNumber, RepoSlug } from "../types/brands.ts";
import type { Result } from "../types/result.ts";

export type Issue = {
	key: IssueKey;
	number: IssueNumber;
	repo: RepoSlug;
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

export type ActiveIssuesPage = {
	issues: Issue[];
	scopesReached: ReadonlySet<RepoSlug>;
};

export type TrackerAdapter = {
	fetchIssue(repo: RepoSlug, issueNumber: IssueNumber): Promise<Issue>;
	fetchActiveIssues(state: TrackerState): Promise<ActiveIssuesPage>;
	transitionState(
		repo: RepoSlug,
		issueNumber: IssueNumber,
		from: TrackerState,
		to: TrackerState,
	): Promise<void>;
	parseIssueKey(
		key: string,
	): Result<{ number: IssueNumber }, ParseIssueKeyError>;
};
