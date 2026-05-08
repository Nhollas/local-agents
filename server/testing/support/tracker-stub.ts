import type {
	Issue,
	TrackerAdapter,
	TrackerState,
} from "../../trackers/types.ts";
import {
	type IssueNumber,
	type RepoSlug,
	issueKey as toIssueKey,
	issueNumber as toIssueNumber,
} from "../../types/brands.ts";
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
	readonly transitions: readonly TransitionRecord[];
	readonly markedFailed: readonly FailedRecord[];
	readonly fetchCalls: readonly TrackerState[];
	failNextFetchActiveIssues(error?: Error): void;
	failNextTransition(error?: Error): void;
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
	let nextFetchError: Error | null = null;
	let nextTransitionError: Error | null = null;

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

		get transitions() {
			return transitions;
		},
		get markedFailed() {
			return markedFailed;
		},
		get fetchCalls() {
			return fetchCalls;
		},

		failNextFetchActiveIssues(error = new Error("tracker fetch failed")) {
			nextFetchError = error;
		},

		failNextTransition(error = new Error("tracker transition failed")) {
			nextTransitionError = error;
		},

		async fetchActiveIssues(state) {
			fetchCalls.push(state);
			if (nextFetchError) {
				const e = nextFetchError;
				nextFetchError = null;
				throw e;
			}
			return {
				issues: [...active[state]].sort((a, b) =>
					a.createdAt.localeCompare(b.createdAt),
				),
			};
		},

		async transitionState(repo, number, from, to) {
			if (nextTransitionError) {
				const e = nextTransitionError;
				nextTransitionError = null;
				throw e;
			}
			transitions.push({ repo, number, from, to });
		},

		async markFailed(repo, number) {
			markedFailed.push({ repo, number });
		},
	};
}
