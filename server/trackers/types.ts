import type { IssueKey, IssueNumber, RepoSlug } from "../types/brands.ts";

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

export type ActiveIssuesPage = {
	issues: Issue[];
};

export type TrackerAdapter = {
	fetchActiveIssues(state: TrackerState): Promise<ActiveIssuesPage>;
	transitionState(
		repo: RepoSlug,
		issueNumber: IssueNumber,
		from: TrackerState,
		to: TrackerState,
	): Promise<void>;
	markFailed(repo: RepoSlug, issueNumber: IssueNumber): Promise<void>;
};
