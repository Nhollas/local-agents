import type { HttpClient } from "@effect/platform";
import { Effect, Metric } from "effect";
import { HttpServiceError } from "../http/errors.ts";
import { issueKey, issueNumber, type RepoSlug } from "../types/brands.ts";
import { makeJiraClient } from "./jira-client.ts";
import type { JiraIssue } from "./schemas.ts";
import { resolveRepo } from "./scope-resolver.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type JiraStatuses = Record<TrackerState, string>;

export type JiraTrackerOptions = {
	readonly project: string;
	readonly scopes: readonly RepoSlug[];
	readonly baseUrl: string;
	readonly statuses: JiraStatuses;
	readonly triggerLabel: string;
	readonly email: string;
	readonly apiToken: string;
};

export const createJiraTracker = (
	options: JiraTrackerOptions,
): Effect.Effect<TrackerAdapter, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const jira = yield* makeJiraClient(options);
		const failedLabel = `${options.triggerLabel}-failed`;

		function buildIssue(issue: JiraIssue, repo: RepoSlug): Issue {
			return {
				key: issueKey(issue.key.raw),
				number: issueNumber(issue.key.number),
				repo,
				title: issue.fields.summary,
				description: issue.fields.description ?? "",
				labels: [...issue.fields.labels],
				url: `${options.baseUrl}/browse/${issue.key.raw}`,
				createdAt: issue.fields.created,
			};
		}

		const resolveScopedIssue = (
			issue: JiraIssue,
		): Effect.Effect<Issue | null> =>
			Effect.gen(function* () {
				const repoLabels = issue.fields.labels.filter((l) =>
					l.startsWith(REPO_LABEL_PREFIX),
				);
				const [first, second] = repoLabels;
				if (!first) {
					yield* recordDroppedIssue(issue.key.raw, "no_repo_label");
					return null;
				}
				if (second) {
					yield* recordDroppedIssue(issue.key.raw, "multiple_repo_labels");
					return null;
				}
				const path = first.slice(REPO_LABEL_PREFIX.length);
				const resolved = resolveRepo(path, options.scopes);
				if (!resolved) {
					yield* recordDroppedIssue(issue.key.raw, "unresolved_repo_label");
					return null;
				}
				return buildIssue(issue, resolved);
			});

		return {
			fetchActiveIssues: (state) =>
				jira
					.searchIssues({ jql: buildJql(options, state), maxResults: 100 })
					.pipe(
						Effect.flatMap((raw) =>
							Effect.gen(function* () {
								const issues: Issue[] = [];
								for (const r of raw) {
									const mapped = yield* resolveScopedIssue(r);
									if (mapped) issues.push(mapped);
								}
								yield* Metric.update(
									issuesFetched.pipe(Metric.tagged("state", state)),
									issues.length,
								);
								return { issues };
							}),
						),
						Effect.annotateLogs({ "tracker.state": state }),
					),

			markFailed: (_repo, issueNum) => {
				const key = jiraIssueKey(options.project, issueNum);
				return jira
					.updateLabels(key, {
						add: [failedLabel],
						remove: [options.triggerLabel],
					})
					.pipe(Effect.annotateLogs({ "jira.issue.key": key }));
			},

			transitionState: (_repo, issueNum, from, to) => {
				const key = jiraIssueKey(options.project, issueNum);
				const targetStatus = options.statuses[to].toLowerCase();
				return Effect.gen(function* () {
					const [, transitions] = yield* Effect.all(
						[
							to === "running"
								? Effect.gen(function* () {
										const me = yield* jira.getMyself();
										yield* jira.assignIssue(key, me.accountId);
									})
								: Effect.void,
							jira.listTransitions(key),
						],
						{ concurrency: "unbounded" },
					);
					const transition = transitions.find(
						(t) => t.to.name.toLowerCase() === targetStatus,
					);
					if (!transition) {
						return yield* Effect.fail(
							new HttpServiceError({
								service: "jira",
								message: `No Jira transition for ${key} to status ${options.statuses[to]}`,
								method: "POST",
								url: `${options.baseUrl}/rest/api/2/issue/${key}/transitions`,
							}),
						);
					}
					yield* jira.transitionIssue(key, transition.id);
				}).pipe(
					Effect.annotateLogs({
						"jira.issue.key": key,
						"tracker.state.from": from,
						"tracker.state.to": to,
					}),
				);
			},
		};
	});

const issuesFetched = Metric.counter("tracker.jira.issues_fetched_total", {
	description: "Issues returned by fetchActiveIssues, after scope filtering.",
	incremental: true,
});

const issuesDropped = Metric.counter("tracker.jira.issues_dropped_total", {
	description: "Issues filtered out during fetchActiveIssues, by reason.",
	incremental: true,
});

const REPO_LABEL_PREFIX = "repo:";

type DropReason =
	| "no_repo_label"
	| "multiple_repo_labels"
	| "unresolved_repo_label";

function recordDroppedIssue(
	issueKeyValue: string,
	reason: DropReason,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		yield* Effect.logWarning("tracker.issue.dropped").pipe(
			Effect.annotateLogs({
				"jira.issue.key": issueKeyValue,
				"tracker.drop_reason": reason,
			}),
		);
		yield* Metric.update(
			issuesDropped.pipe(Metric.tagged("reason", reason)),
			1,
		);
	});
}

function buildJql(options: JiraTrackerOptions, state: TrackerState): string {
	const clauses = [
		`project = ${quoteJqlString(options.project)}`,
		`status = ${quoteJqlString(options.statuses[state])}`,
		`labels = ${quoteJqlString(options.triggerLabel)}`,
		"reporter = currentUser()",
	];
	return `${clauses.join(" AND ")} ORDER BY created ASC`;
}

function jiraIssueKey(project: string, num: number): string {
	return `${project}-${num}`;
}

function quoteJqlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
