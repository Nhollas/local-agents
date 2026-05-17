import { Effect } from "effect";
import { HttpServiceError } from "../http/errors.ts";
import type { TrackerError } from "../trackers/errors.ts";
import type { Issue, TrackerAdapter, TrackerState } from "../trackers/types.ts";
import {
	type IssueNumber,
	type RepoSlug,
	issueKey as toIssueKey,
	issueNumber as toIssueNumber,
} from "../types/brands.ts";
import { JIRA_PROJECT } from "./fixtures.ts";

type AddIssueInput = {
	number: number;
	repo: RepoSlug;
	title?: string;
	description?: string;
	labels?: string[];
	createdAt?: string;
};

type TransitionRecord = {
	repo: RepoSlug;
	number: IssueNumber;
	from: TrackerState;
	to: TrackerState;
};

type FailedRecord = {
	repo: RepoSlug;
	number: IssueNumber;
};

type TrackerStub = TrackerAdapter & {
	addIssue(state: TrackerState, input: AddIssueInput): Issue;
	removeIssue(state: TrackerState, number: number): void;
	readonly transitions: readonly TransitionRecord[];
	readonly markedFailed: readonly FailedRecord[];
	readonly fetchCalls: readonly TrackerState[];
	failNextFetchActiveIssues(error?: TrackerError): void;
	failNextTransition(error?: TrackerError): void;
};

export function createTrackerStub(
	options: { project?: string } = {},
): TrackerStub {
	const project = options.project ?? JIRA_PROJECT;
	const active: Record<TrackerState, Issue[]> = {
		pending: [],
		running: [],
		awaiting_review: [],
	};
	const transitions: TransitionRecord[] = [];
	const markedFailed: FailedRecord[] = [];
	const fetchCalls: TrackerState[] = [];
	let nextFetchError: TrackerError | null = null;
	let nextTransitionError: TrackerError | null = null;

	function buildIssue(input: AddIssueInput): Issue {
		const key = toIssueKey(`${project}-${input.number}`);
		return {
			key,
			number: toIssueNumber(input.number),
			repo: input.repo,
			title: input.title ?? `Issue ${key}`,
			description: input.description ?? `Description for ${key}`,
			labels: input.labels ?? [],
			url: `https://tracker.example.test/browse/${key}`,
			createdAt: input.createdAt ?? "2025-01-01T00:00:00.000+0000",
		};
	}

	return {
		addIssue(state, input) {
			const issue = buildIssue(input);
			active[state].push(issue);
			return issue;
		},

		removeIssue(state, number) {
			active[state] = active[state].filter((i) => i.number !== number);
		},

		get transitions() {
			return transitions;
		},
		get markedFailed() {
			return markedFailed;
		},
		get fetchCalls() {
			return fetchCalls;
		},

		failNextFetchActiveIssues(
			error = new HttpServiceError({
				message: "tracker fetch failed",
				method: "POST",
				url: "stub://fetch",
			}),
		) {
			nextFetchError = error;
		},

		failNextTransition(
			error = new HttpServiceError({
				message: "tracker transition failed",
				method: "POST",
				url: "stub://transition",
			}),
		) {
			nextTransitionError = error;
		},

		fetchActiveIssues: (state) =>
			Effect.suspend(() => {
				fetchCalls.push(state);
				if (nextFetchError) {
					const e = nextFetchError;
					nextFetchError = null;
					return Effect.fail(e);
				}
				return Effect.succeed({
					issues: [...active[state]].sort((a, b) =>
						a.createdAt.localeCompare(b.createdAt),
					),
				});
			}),

		transitionState: (repo, number, from, to) =>
			Effect.suspend(() => {
				if (nextTransitionError) {
					const e = nextTransitionError;
					nextTransitionError = null;
					return Effect.fail(e);
				}
				transitions.push({ repo, number, from, to });
				return Effect.void;
			}),

		markFailed: (repo, number) =>
			Effect.sync(() => {
				markedFailed.push({ repo, number });
			}),
	};
}
