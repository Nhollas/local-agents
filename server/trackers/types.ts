import type { Effect } from "effect";
import type { IssueKey, IssueNumber, RepoSlug } from "../types/brands.ts";
import type { TrackerError } from "./errors.ts";

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
	fetchActiveIssues(
		state: TrackerState,
	): Effect.Effect<ActiveIssuesPage, TrackerError>;
	transitionState(
		repo: RepoSlug,
		issueNumber: IssueNumber,
		from: TrackerState,
		to: TrackerState,
	): Effect.Effect<void, TrackerError>;
	markFailed(
		repo: RepoSlug,
		issueNumber: IssueNumber,
	): Effect.Effect<void, TrackerError>;
};
