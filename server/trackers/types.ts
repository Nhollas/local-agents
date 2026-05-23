import type { Effect } from "effect";
import type { TrackerError } from "./errors.ts";

export type Issue = {
	key: string;
	number: number;
	repo: string;
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
		repo: string,
		issueNumber: number,
		from: TrackerState,
		to: TrackerState,
	): Effect.Effect<void, TrackerError>;
	markFailed(
		repo: string,
		issueNumber: number,
	): Effect.Effect<void, TrackerError>;
};
